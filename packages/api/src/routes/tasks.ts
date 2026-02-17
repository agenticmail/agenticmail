import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { MailSender, type AccountManager, type AgenticMailConfig } from '@agenticmail/core';
import { requireAgent, requireAuth, touchActivity } from '../middleware/auth.js';
import { pushEventToAgent, broadcastEvent } from './events.js';
import { getAgentPassword } from './mail.js';

// Promise-based RPC completion notification — resolves the long-poll instantly
// when the target agent submits the task result, instead of relying on polling.
const rpcResolvers = new Map<string, (row: { status: string; result?: string; error?: string }) => void>();

export function createTaskRoutes(db: Database.Database, accountManager: AccountManager, config: AgenticMailConfig): Router {
  const router = Router();

  // Assign a task to another agent
  router.post('/tasks/assign', requireAuth, async (req, res, next) => {
    try {
      const { assignee, taskType, payload, expiresInSeconds } = req.body || {};
      if (!assignee) { res.status(400).json({ error: 'assignee (agent name) is required' }); return; }

      const target = await accountManager.getByName(assignee);
      if (!target) { res.status(404).json({ error: `Agent "${assignee}" not found` }); return; }

      const assignerId = req.agent?.id ?? 'master';
      const id = uuidv4();
      const expiresAt = expiresInSeconds
        ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
        : null;

      db.prepare(
        'INSERT INTO agent_tasks (id, assigner_id, assignee_id, task_type, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, assignerId, target.id, taskType || 'generic', JSON.stringify(payload || {}), expiresAt);

      // Always auto-spawn an agent to process the task.
      // Push an RPC-style task event — this is the same event format that call_agent uses,
      // which OpenClaw hooks pick up to automatically spawn an agent session.
      const taskDescription = payload?.task || payload?.description || JSON.stringify(payload || {});
      const spawnEvent = {
        type: 'task', taskId: id, taskType: 'rpc',
        task: `You have a pending task (ID: ${id}). Check your pending tasks, claim it, process it, and submit the result.\n\nType: ${taskType || 'generic'}\nTask: ${taskDescription}`,
        assignee: target.name, from: req.agent?.name ?? 'system',
      };
      if (!pushEventToAgent(target.id, spawnEvent)) {
        broadcastEvent(spawnEvent);
      }

      // Fire-and-forget email notification as fallback (in case SSE isn't connected).
      if (req.agent) {
        const notifSender = new MailSender({
          host: config.smtp.host,
          port: config.smtp.port,
          email: req.agent.email,
          password: getAgentPassword(req.agent),
          authUser: req.agent.stalwartPrincipal,
        });
        notifSender.send({
          to: target.email,
          subject: `[Task] ${taskType || 'generic'} from ${req.agent.name}`,
          text: `You have a new task assigned to you (ID: ${id}).\n\nType: ${taskType || 'generic'}\n${payload ? `Payload: ${JSON.stringify(payload)}\n` : ''}\nPlease check your pending tasks.`,
        }).catch((err) => {
          console.warn(`[Tasks] Failed to notify ${target.name}:`, (err as Error).message);
        }).finally(() => {
          notifSender.close();
        });
      }

      res.status(201).json({ id, assignee: target.name, assigneeId: target.id, status: 'pending' });
    } catch (err) { next(err); }
  });

  // Get tasks assigned TO current agent (pending)
  // Supports ?assignee=name to check tasks for a different agent (e.g., sub-agent checking parent's tasks)
  router.get('/tasks/pending', requireAgent, async (req, res, next) => {
    try {
      let assigneeId = req.agent!.id;
      const assigneeName = req.query.assignee as string | undefined;
      if (assigneeName) {
        const target = await accountManager.getByName(assigneeName);
        if (target) assigneeId = target.id;
      }
      const rows = db.prepare(
        "SELECT * FROM agent_tasks WHERE assignee_id = ? AND status IN ('pending', 'claimed') ORDER BY created_at ASC"
      ).all(assigneeId) as any[];
      res.json({ tasks: rows.map(parseTask), count: rows.length });
    } catch (err) { next(err); }
  });

  // Get tasks assigned BY current agent
  router.get('/tasks/assigned', requireAuth, async (req, res, next) => {
    try {
      const id = req.agent?.id ?? 'master';
      const rows = db.prepare(
        'SELECT * FROM agent_tasks WHERE assigner_id = ? ORDER BY created_at DESC LIMIT 50'
      ).all(id) as any[];
      res.json({ tasks: rows.map(parseTask), count: rows.length });
    } catch (err) { next(err); }
  });

  // Claim a task (pending → claimed)
  // Capability-based: any authenticated agent that knows the task ID can claim it.
  // This supports OpenClaw sub-agents claiming tasks assigned to their parent.
  router.post('/tasks/:id/claim', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare(
        "UPDATE agent_tasks SET status = 'claimed', claimed_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(req.params.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Task not found or already claimed' }); return; }
      touchActivity(db, req.agent!.id);
      const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(req.params.id) as any;
      res.json(parseTask(task));
    } catch (err) { next(err); }
  });

  // Submit task result (claimed → completed)
  // Capability-based: any authenticated agent that knows the task ID can submit.
  router.post('/tasks/:id/result', requireAgent, async (req, res, next) => {
    try {
      const { result } = req.body || {};
      const resultJson = JSON.stringify(result ?? null);
      const dbResult = db.prepare(
        "UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ? AND status = 'claimed'"
      ).run(resultJson, req.params.id);
      if (dbResult.changes === 0) { res.status(404).json({ error: 'Task not found or not in claimed status' }); return; }
      touchActivity(db, req.agent!.id);

      // Instantly wake the RPC long-poll if the assigner is waiting
      const resolver = rpcResolvers.get(req.params.id);
      if (resolver) {
        rpcResolvers.delete(req.params.id);
        resolver({ status: 'completed', result: resultJson });
      }

      res.json({ ok: true, taskId: req.params.id, status: 'completed' });
    } catch (err) { next(err); }
  });

  // Claim + Submit in one call (pending → completed, skipping claimed state)
  // Designed for light-mode tasks where the agent already knows the answer.
  // Saves a round-trip: no need for separate claim then submit.
  router.post('/tasks/:id/complete', requireAgent, async (req, res, next) => {
    try {
      const { result } = req.body || {};
      const resultJson = JSON.stringify(result ?? null);
      const dbResult = db.prepare(
        "UPDATE agent_tasks SET status = 'completed', result = ?, claimed_at = datetime('now'), completed_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(resultJson, req.params.id);
      if (dbResult.changes === 0) {
        // Maybe already claimed? Try completing from claimed state too
        const retry = db.prepare(
          "UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ? AND status = 'claimed'"
        ).run(resultJson, req.params.id);
        if (retry.changes === 0) {
          res.status(404).json({ error: 'Task not found or already completed' });
          return;
        }
      }
      touchActivity(db, req.agent!.id);

      // Instantly wake the RPC long-poll
      const resolver = rpcResolvers.get(req.params.id);
      if (resolver) {
        rpcResolvers.delete(req.params.id);
        resolver({ status: 'completed', result: resultJson });
      }

      res.json({ ok: true, taskId: req.params.id, status: 'completed' });
    } catch (err) { next(err); }
  });

  // Fail a task (claimed → failed)
  // Capability-based: any authenticated agent that knows the task ID can fail it.
  router.post('/tasks/:id/fail', requireAgent, async (req, res, next) => {
    try {
      const { error } = req.body || {};
      const errorMsg = error || 'Unknown error';
      const dbResult = db.prepare(
        "UPDATE agent_tasks SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ? AND status = 'claimed'"
      ).run(errorMsg, req.params.id);
      if (dbResult.changes === 0) { res.status(404).json({ error: 'Task not found or not in claimed status' }); return; }
      touchActivity(db, req.agent!.id);

      // Instantly wake the RPC long-poll if the assigner is waiting
      const resolver = rpcResolvers.get(req.params.id);
      if (resolver) {
        rpcResolvers.delete(req.params.id);
        resolver({ status: 'failed', error: errorMsg });
      }

      res.json({ ok: true, taskId: req.params.id, status: 'failed' });
    } catch (err) { next(err); }
  });

  // Get task details
  router.get('/tasks/:id', requireAuth, async (req, res, next) => {
    try {
      const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(req.params.id) as any;
      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
      res.json(parseTask(task));
    } catch (err) { next(err); }
  });

  // RPC: assign task + poll for result (synchronous agent-to-agent call)
  router.post('/tasks/rpc', requireAuth, async (req, res, next) => {
    try {
      const { target, task, payload, timeout } = req.body || {};
      if (!target || !task) { res.status(400).json({ error: 'target (agent name) and task are required' }); return; }

      const targetAgent = await accountManager.getByName(target);
      if (!targetAgent) { res.status(404).json({ error: `Agent "${target}" not found` }); return; }

      const assignerId = req.agent?.id ?? 'master';
      const taskId = uuidv4();
      const timeoutMs = Math.min(Math.max((timeout || 180) * 1000, 5000), 300_000);

      // Disable socket timeout — this endpoint holds the connection open for
      // the entire RPC duration (up to 5 minutes). Without this, Node/Express
      // may close the socket before the target agent completes the task.
      req.socket.setTimeout(0);
      res.setHeader('Connection', 'keep-alive');

      db.prepare(
        'INSERT INTO agent_tasks (id, assigner_id, assignee_id, task_type, payload) VALUES (?, ?, ?, ?, ?)'
      ).run(taskId, assignerId, targetAgent.id, 'rpc', JSON.stringify({ task, ...(payload || {}) }));

      // Push task event to target agent's SSE stream. Broadcast if no direct watcher.
      const rpcEvent = {
        type: 'task', taskId, taskType: 'rpc', task,
        assignee: targetAgent.name, from: req.agent?.name ?? 'system',
      };
      if (!pushEventToAgent(targetAgent.id, rpcEvent)) {
        broadcastEvent(rpcEvent);
      }

      // Fire-and-forget email notification as fallback (in case SSE isn't connected).
      // CRITICAL: Do NOT await — SMTP can hang/be slow, which would block the
      // polling loop below and prevent call_agent from ever detecting completion.
      // Send FROM the calling agent's own address — Stalwart requires auth user to match sender.
      if (req.agent) {
        const notifSender = new MailSender({
          host: config.smtp.host,
          port: config.smtp.port,
          email: req.agent.email,
          password: getAgentPassword(req.agent),
          authUser: req.agent.stalwartPrincipal,
        });
        notifSender.send({
          to: targetAgent.email,
          subject: `[RPC] Task from ${req.agent.name}: ${task}`,
          text: `You have a pending RPC task (ID: ${taskId}).\n\nTask: ${task}\n${payload ? `Payload: ${JSON.stringify(payload)}\n` : ''}\nPlease check your pending tasks, claim this task, process it, and submit the result.`,
        }).catch((err) => {
          console.warn(`[RPC] Failed to notify ${targetAgent.name}:`, (err as Error).message);
        }).finally(() => {
          notifSender.close();
        });
      }

      // Wait for completion using promise-based notification + polling fallback.
      // The result/fail endpoints call the resolver instantly, so this avoids
      // the 1s polling delay and also fixes the bug where polling alone could
      // miss the completed status.
      const completionPromise = new Promise<{ status: string; result?: string; error?: string }>((resolve) => {
        // Register resolver so result/fail endpoints can wake us instantly
        rpcResolvers.set(taskId, resolve);

        // Polling fallback every 2s in case the resolver is missed
        const pollStmt = db.prepare('SELECT status, result, error FROM agent_tasks WHERE id = ?');
        let pollCount = 0;
        const pollInterval = setInterval(() => {
          pollCount++;
          if (req.destroyed || res.destroyed) {
            clearInterval(pollInterval);
            rpcResolvers.delete(taskId);
            resolve({ status: 'disconnected' });
            return;
          }
          const row = pollStmt.get(taskId) as any;
          if (row?.status === 'completed' || row?.status === 'failed') {
            clearInterval(pollInterval);
            rpcResolvers.delete(taskId);
            resolve({ status: row.status, result: row.result, error: row.error });
          }
        }, 2000);

        // Timeout
        setTimeout(() => {
          clearInterval(pollInterval);
          rpcResolvers.delete(taskId);
          resolve({ status: 'timeout' });
        }, timeoutMs);
      });

      const outcome = await completionPromise;

      if (outcome.status === 'disconnected') return; // client left

      if (outcome.status === 'completed') {
        let result: any = null;
        try { result = JSON.parse(outcome.result!); } catch { result = outcome.result; }
        res.json({ taskId, status: 'completed', result });
        return;
      }
      if (outcome.status === 'failed') {
        res.json({ taskId, status: 'failed', error: outcome.error });
        return;
      }

      res.json({ taskId, status: 'timeout', message: `Task not completed within ${timeout || 180}s. Check with GET /tasks/${taskId}` });
    } catch (err) { next(err); }
  });

  return router;
}

function parseTask(row: any): any {
  if (!row) return null;
  let payload: any = {};
  let result: any = null;
  try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  try { result = row.result ? JSON.parse(row.result) : null; } catch { result = row.result; }
  return {
    id: row.id,
    assignerId: row.assigner_id,
    assigneeId: row.assignee_id,
    taskType: row.task_type,
    payload,
    status: row.status,
    result,
    error: row.error,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}
