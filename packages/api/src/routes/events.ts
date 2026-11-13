import { Router } from 'express';
import type { Response } from 'express';
import {
  InboxWatcher,
  MailReceiver,
  parseEmail,
  scoreEmail,
  isInternalEmail,
  classifyEmailRoute,
  type AccountManager,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { v4 as uuidv4 } from 'uuid';
import { requireAgent, touchActivity } from '../middleware/auth.js';
import { getAgentPassword } from './mail.js';
import { evaluateRules } from './features.js';
import { pushSystemEvent } from './system-events.js';

const MAX_SSE_PER_AGENT = 5;
const activeWatchers = new Map<string, Set<{ watcher: InboxWatcher; res: Response }>>();

/**
 * Push an event directly to an agent's active SSE connections.
 * Used by the task RPC endpoint to instantly notify the target agent
 * without relying on SMTP email delivery → IMAP IDLE → SSE chain.
 */
export function pushEventToAgent(agentId: string, event: Record<string, unknown>): boolean {
  const watchers = activeWatchers.get(agentId);
  if (!watchers || watchers.size === 0) return false;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const entry of watchers) {
    try { entry.res.write(data); } catch { /* ignore write-after-end */ }
  }
  return true;
}

/**
 * Events for agents with no open SSE stream, held until that agent
 * connects. There is deliberately NO "send to everyone" fallback: an
 * event addressed to one agent (task text, RPC payloads) must never be
 * written to another agent's stream (GHSA-p76v-w436-9wjh). The task
 * itself is also persisted in agent_tasks and announced by email, so a
 * dropped or expired queue entry loses no work.
 */
const PENDING_EVENT_TTL_MS = 10 * 60_000;
const MAX_PENDING_EVENTS_PER_AGENT = 50;
const MAX_PENDING_AGENTS = 1_000;
const pendingEvents = new Map<string, Array<{ event: Record<string, unknown>; expiresAt: number }>>();

function prunePending(agentId: string, now = Date.now()): void {
  const queue = pendingEvents.get(agentId);
  if (!queue) return;
  const live = queue.filter((e) => e.expiresAt > now);
  if (live.length === 0) pendingEvents.delete(agentId);
  else if (live.length !== queue.length) pendingEvents.set(agentId, live);
}

/** Queue an event for ONE agent's next SSE connection (bounded, expiring). */
export function queueEventForAgent(agentId: string, event: Record<string, unknown>): void {
  if (!agentId) return;
  const now = Date.now();
  prunePending(agentId, now);
  if (!pendingEvents.has(agentId) && pendingEvents.size >= MAX_PENDING_AGENTS) {
    // Evict the oldest agent's queue rather than grow without bound.
    const oldest = pendingEvents.keys().next().value;
    if (oldest !== undefined) pendingEvents.delete(oldest);
  }
  const queue = pendingEvents.get(agentId) ?? [];
  queue.push({ event, expiresAt: now + PENDING_EVENT_TTL_MS });
  if (queue.length > MAX_PENDING_EVENTS_PER_AGENT) queue.splice(0, queue.length - MAX_PENDING_EVENTS_PER_AGENT);
  pendingEvents.set(agentId, queue);
}

/** Remove and return the still-live events queued for `agentId`. */
export function takePendingEvents(agentId: string): Record<string, unknown>[] {
  prunePending(agentId);
  const queue = pendingEvents.get(agentId) ?? [];
  pendingEvents.delete(agentId);
  return queue.map((e) => e.event);
}

/**
 * Deliver to the agent's live streams, or queue for that same agent if
 * it has none. Never reaches any other agent.
 */
export function pushOrQueueEventForAgent(agentId: string, event: Record<string, unknown>): boolean {
  if (pushEventToAgent(agentId, event)) return true;
  queueEventForAgent(agentId, event);
  return false;
}

/** Cleanup all active SSE watchers (called on shutdown) */
export async function closeAllWatchers(): Promise<void> {
  for (const [, watchers] of activeWatchers) {
    for (const entry of watchers) {
      try { await entry.watcher.stop(); } catch { /* ignore */ }
      try { entry.res.end(); } catch { /* ignore */ }
    }
  }
  activeWatchers.clear();
  pendingEvents.clear();
}

export function createEventRoutes(accountManager: AccountManager, config: AgenticMailConfig, db?: import('@agenticmail/core').Database): Router {
  const router = Router();

  // SSE endpoint for real-time events
  router.get('/events', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const password = getAgentPassword(agent);

      // Enforce per-agent SSE connection limit
      const agentWatchers = activeWatchers.get(agent.id) ?? new Set();
      if (agentWatchers.size >= MAX_SSE_PER_AGENT) {
        res.status(429).json({ error: `Maximum ${MAX_SSE_PER_AGENT} concurrent SSE connections per agent` });
        return;
      }

      // Create and start watcher BEFORE flushing SSE headers
      // so failures produce a normal JSON error response
      const watcher = new InboxWatcher({
        host: config.imap.host,
        port: config.imap.port,
        email: agent.stalwartPrincipal,
        password,
        autoReconnect: true,
        maxReconnectAttempts: 20,
      });

      try {
        await watcher.start();
      } catch (err) {
        res.status(500).json({ error: 'Failed to start event stream: ' + (err instanceof Error ? err.message : String(err)) });
        return;
      }

      // Now set SSE headers (point of no return for JSON error responses)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let closed = false;
      const entry = { watcher, res };

      // Track this connection
      activeWatchers.set(agent.id, agentWatchers);
      agentWatchers.add(entry);

      const safeWrite = (data: string): void => {
        if (!closed) {
          try { res.write(data); } catch { /* ignore write-after-end */ }
        }
      };

      safeWrite(`data: ${JSON.stringify({ type: 'connected', agentId: agent.id })}\n\n`);

      // Deliver anything addressed to THIS agent while it had no stream.
      for (const pending of takePendingEvents(agent.id)) {
        safeWrite(`data: ${JSON.stringify(pending)}\n\n`);
      }

      // Helper: every new-mail event MUST land in two places —
      //   (a) the per-agent /events SSE (this connection's `safeWrite`),
      //       which the dispatcher daemon listens on; and
      //   (b) the master /system/events bus, which the web UI listens on
      //       since 0.9.9 (one shared SSE replaces N per-agent ones).
      // Multiple code paths below early-return after firing (a) — internal
      // agent-to-agent mail, spam-routed mail, deleted-by-rule mail. Before
      // 0.9.x had this helper, those paths skipped (b) entirely, which
      // silently broke the web UI's chime/notification for the EXACT
      // traffic class users see most: agent-to-agent threads.
      const broadcastNew = (e: Record<string, unknown>) => {
        safeWrite(`data: ${JSON.stringify(e)}\n\n`);
        try {
          pushSystemEvent({
            type: 'new_mail',
            agentId: agent.id,
            agentName: agent.name,
            event: e,
          });
        } catch { /* never fatal — per-agent stream is the primary path */ }
      };

      watcher.on('new', async (event) => {
        // Agent is active — receiving events via SSE
        if (db) touchActivity(db, agent.id);

        // Run spam filter + rules if db is available
        if (db && event.uid) {
          try {
            const receiver = new MailReceiver({
              host: config.imap.host, port: config.imap.port,
              email: agent.stalwartPrincipal, password,
              secure: false,
            });
            await receiver.connect();
            try {
              const raw = await receiver.fetchMessage(event.uid);
              const parsed = await parseEmail(raw);
              // Hardening: only pass the fields the route classifier
              // actually reads. Avoids accidentally leaking the full
              // agent.metadata blob (which can carry founder-set
              // arbitrary keys) into the SSE event payload via any
              // future classifier-side change that echoes its
              // input back.
              const policyMetadata = agent.metadata && typeof agent.metadata === 'object'
                ? {
                    emailRoutePolicy: (agent.metadata as Record<string, unknown>).emailRoutePolicy,
                    routePolicy: (agent.metadata as Record<string, unknown>).routePolicy,
                    mailboxPolicy: (agent.metadata as Record<string, unknown>).mailboxPolicy,
                  }
                : undefined;
              const accountRouteContext = {
                name: agent.name,
                email: agent.email,
                role: agent.role,
                metadata: policyMetadata,
              };

              // --- Spam filter (runs BEFORE rules, skipped for internal emails) ---
              // Relay-delivered emails have X-AgenticMail-Relay header — they are
              // external emails rewritten with @localhost from, so never treat as internal.
              const isRelay = !!parsed.headers.get('x-agenticmail-relay');
              const internal = !isRelay && isInternalEmail(parsed);
              if (internal) {
                (event as any).route = classifyEmailRoute({ email: parsed, account: accountRouteContext });

                // Internal agent-to-agent email — skip spam filter entirely
                const ruleResult = evaluateRules(db, agent.id, parsed);
                if (ruleResult) {
                  const actions = ruleResult.actions;
                  if (actions.mark_read) await receiver.markSeen(event.uid);
                  if (actions.delete) { await receiver.deleteMessage(event.uid); return; }
                  if (actions.move_to) await receiver.moveMessage(event.uid, 'INBOX', actions.move_to);
                  (event as any).ruleApplied = { ruleId: ruleResult.ruleId, actions };
                }
                broadcastNew(event as Record<string, unknown>);
                return;
              }

              const spamResult = scoreEmail(parsed);
              (event as any).route = classifyEmailRoute({ email: parsed, spam: spamResult, account: accountRouteContext });

              // Log to spam_log
              try {
                db.prepare(
                  'INSERT INTO spam_log (id, agent_id, message_uid, score, flags, category, is_spam) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).run(
                  uuidv4(), agent.id, event.uid, spamResult.score,
                  JSON.stringify(spamResult.matches.map(m => m.ruleId)),
                  spamResult.topCategory, spamResult.isSpam ? 1 : 0,
                );
              } catch { /* ignore log errors */ }

              if (spamResult.isSpam) {
                // Resolve the EXISTING junk folder before falling back to
                // creating a new "Spam" folder. Stalwart ships with "Junk
                // Mail" by default; hardcoding "Spam" here meant every
                // spam-classified message landed in a brand-new "Spam"
                // folder while the web UI's Spam tab queried "Junk Mail"
                // (the one the FOLDER_MATCHERS regex resolves to). Net:
                // user-reported spam ✓ visible, but server-classified
                // spam ✗ silently disappearing into a parallel folder.
                let spamFolder = 'Spam';
                try {
                  const folders = await receiver.listFolders();
                  const junkRe = /^junk\b|junk mail|^spam\b|\[gmail\]\/spam/i;
                  const existing =
                    folders.find(f => f.specialUse === '\\Junk')?.path
                    ?? folders.find(f => junkRe.test(f.name) || junkRe.test(f.path))?.path;
                  if (existing) {
                    spamFolder = existing;
                  } else {
                    try { await receiver.createFolder('Spam'); } catch { /* race */ }
                  }
                } catch {
                  // listFolders failed — fall back to creating "Spam" the
                  // way we used to. Better than dropping the message.
                  try { await receiver.createFolder('Spam'); } catch { /* race */ }
                }
                await receiver.moveMessage(event.uid, 'INBOX', spamFolder);
                (event as any).spam = { score: spamResult.score, category: spamResult.topCategory, movedToSpam: true, folder: spamFolder };
                broadcastNew(event as Record<string, unknown>);
                return;
              }
              if (spamResult.isWarning) {
                (event as any).spamWarning = { score: spamResult.score, category: spamResult.topCategory, matches: spamResult.matches.map(m => m.ruleId) };
              }

              // --- Email rules (runs AFTER spam filter) ---
              const ruleResult = evaluateRules(db, agent.id, parsed);
              if (ruleResult) {
                const actions = ruleResult.actions;
                if (actions.mark_read) await receiver.markSeen(event.uid);
                if (actions.delete) { await receiver.deleteMessage(event.uid); return; }
                if (actions.move_to) await receiver.moveMessage(event.uid, 'INBOX', actions.move_to);
                (event as any).ruleApplied = { ruleId: ruleResult.ruleId, actions };
              }
            } finally {
              await receiver.disconnect();
            }
          } catch (err) {
            console.error('[SSE] Spam/rule evaluation error:', (err as Error).message);
          }
        }
        broadcastNew(event as Record<string, unknown>);
      });

      watcher.on('expunge', (event) => {
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      });

      watcher.on('flags', (event) => {
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      });

      watcher.on('error', (err) => {
        safeWrite(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      });

      watcher.on('reconnecting', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnecting', attempt: info.attempt, delayMs: info.delayMs })}\n\n`);
      });

      watcher.on('reconnected', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnected', attempt: info.attempt })}\n\n`);
      });

      watcher.on('reconnect_failed', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnect_failed', attempts: info.attempts })}\n\n`);
      });

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        safeWrite(`: ping\n\n`);
      }, 30000);

      // Cleanup on disconnect
      req.on('close', () => {
        closed = true;
        clearInterval(pingInterval);
        agentWatchers.delete(entry);
        if (agentWatchers.size === 0) activeWatchers.delete(agent.id);
        watcher.removeAllListeners();
        watcher.stop().catch((err) => {
          console.error('[SSE] Watcher cleanup error:', err);
        });
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
