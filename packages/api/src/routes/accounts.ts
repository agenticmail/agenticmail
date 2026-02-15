import { Router } from 'express';
import type Database from 'better-sqlite3';
import { AGENT_ROLES, AgentDeletionService, type AccountManager, type AgentRole, type AgenticMailConfig } from '@agenticmail/core';
import { requireMaster, requireAgent, requireAuth } from '../middleware/auth.js';

/** Strip internal metadata fields (prefixed with _) from agent responses */
function sanitizeAgent(agent: any): any {
  if (!agent) return agent;
  const { metadata, ...rest } = agent;
  if (metadata && typeof metadata === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (!k.startsWith('_')) clean[k] = v;
    }
    return { ...rest, metadata: clean };
  }
  return agent;
}

export function createAccountRoutes(accountManager: AccountManager, db: Database.Database, config: AgenticMailConfig): Router {
  const router = Router();
  const deletionService = new AgentDeletionService(db, accountManager, config);

  // Create account — requires master key
  router.post('/accounts', requireMaster, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'Request body must be JSON' });
        return;
      }
      const { name, domain, password, metadata, role, persistent } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required and must be a string' });
        return;
      }
      if (name.length > 64) {
        res.status(400).json({ error: 'name must be 64 characters or fewer' });
        return;
      }
      if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null)) {
        res.status(400).json({ error: 'metadata must be an object' });
        return;
      }
      if (password !== undefined && typeof password !== 'string') {
        res.status(400).json({ error: 'password must be a string' });
        return;
      }
      if (role !== undefined && !AGENT_ROLES.includes(role as AgentRole)) {
        res.status(400).json({ error: `Invalid role. Must be one of: ${AGENT_ROLES.join(', ')}` });
        return;
      }
      // Strip _-prefixed keys from user-supplied metadata
      const cleanMeta = metadata ? Object.fromEntries(
        Object.entries(metadata).filter(([k]) => !k.startsWith('_'))
      ) : undefined;

      const agent = await accountManager.create({ name, domain, password: password || undefined, metadata: cleanMeta, role: role as AgentRole | undefined });

      // Initialize last_activity_at so it's never NULL
      try { db.prepare("UPDATE agents SET last_activity_at = datetime('now') WHERE id = ?").run(agent.id); } catch { /* ignore */ }

      // Auto-mark as persistent if it's the first agent or if explicitly requested
      const agentCount = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as any)?.cnt ?? 0;
      const shouldPersist = persistent || agentCount <= 1;
      if (shouldPersist) {
        try { db.prepare('UPDATE agents SET persistent = 1 WHERE id = ?').run(agent.id); } catch { /* ignore if column missing */ }
      }
      res.status(201).json(sanitizeAgent(agent));
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') || msg.includes('unique') || msg.includes('already exists') || msg.includes('duplicate')) {
        res.status(409).json({ error: `Agent "${name}" already exists` });
        return;
      }
      next(err);
    }
  });

  // List accounts — requires master key
  router.get('/accounts', requireMaster, async (_req, res, next) => {
    try {
      const agents = await accountManager.list();
      res.json({ agents: agents.map(sanitizeAgent) });
    } catch (err) {
      next(err);
    }
  });

  // Agent directory — accessible with any valid key (agent or master)
  router.get('/accounts/directory', requireAuth, async (_req, res, next) => {
    try {
      const agents = await accountManager.list();
      const directory = agents.map(a => ({ name: a.name, email: a.email, role: a.role }));
      res.json({ agents: directory });
    } catch (err) {
      next(err);
    }
  });

  // Resolve agent by name — accessible with any valid key
  router.get('/accounts/directory/:name', requireAuth, async (req, res, next) => {
    try {
      const agent = await accountManager.getByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ name: agent.name, email: agent.email, role: agent.role });
    } catch (err) {
      next(err);
    }
  });

  // Get current agent info
  router.get('/accounts/me', requireAgent, async (req, res) => {
    if (req.agent) {
      res.json(sanitizeAgent(req.agent));
    } else {
      res.status(404).json({ error: 'Agent not found' });
    }
  });

  // List past deletion reports — requires master key
  // (must be before /accounts/:id to avoid matching "deletions" as an id)
  router.get('/accounts/deletions', requireMaster, async (_req, res, next) => {
    try {
      const reports = deletionService.listReports();
      res.json({ deletions: reports });
    } catch (err) {
      next(err);
    }
  });

  // Get a specific deletion report — requires master key
  router.get('/accounts/deletions/:id', requireMaster, async (req, res, next) => {
    try {
      const report = deletionService.getReport(req.params.id);
      if (!report) {
        res.status(404).json({ error: 'Deletion report not found' });
        return;
      }
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // List inactive agents — requires master key
  // IMPORTANT: Must be before /accounts/:id to avoid "inactive" matching as :id
  router.get('/accounts/inactive', requireMaster, async (_req, res, next) => {
    try {
      const hours = Math.max(parseInt(_req.query.hours as string) || 24, 1);
      // Use COALESCE so agents with NULL last_activity_at fall back to created_at
      // (prevents brand-new agents from being flagged as inactive)
      const rows = db.prepare(
        `SELECT id, name, email, role, last_activity_at, persistent, created_at FROM agents
         WHERE persistent = 0 AND COALESCE(last_activity_at, created_at) < datetime('now', '-${hours} hours')
         ORDER BY COALESCE(last_activity_at, created_at) ASC`
      ).all() as any[];
      res.json({ agents: rows, count: rows.length });
    } catch (err) { next(err); }
  });

  // Cleanup inactive non-persistent agents — requires master key
  router.post('/accounts/cleanup', requireMaster, async (req, res, next) => {
    try {
      const hours = Math.max(parseInt(req.body?.hours as string) || 24, 1);
      const dryRun = req.body?.dryRun === true;
      // Use COALESCE so agents with NULL last_activity_at fall back to created_at
      // (prevents brand-new agents from being swept up in cleanup)
      const rows = db.prepare(
        `SELECT id, name, email FROM agents
         WHERE persistent = 0 AND COALESCE(last_activity_at, created_at) < datetime('now', '-${hours} hours')`
      ).all() as any[];

      if (dryRun) {
        res.json({ wouldDelete: rows, count: rows.length, dryRun: true });
        return;
      }

      const deleted: string[] = [];
      for (const row of rows) {
        try {
          await accountManager.delete(row.id);
          deleted.push(row.name);
        } catch { /* skip failures */ }
      }
      res.json({ deleted, count: deleted.length });
    } catch (err) { next(err); }
  });

  // Get specific account — requires master key
  // IMPORTANT: Must be after all /accounts/<named> routes to avoid :id shadowing them
  router.get('/accounts/:id', requireMaster, async (req, res, next) => {
    try {
      const agent = await accountManager.getById(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(sanitizeAgent(agent));
    } catch (err) {
      next(err);
    }
  });

  // Update agent metadata — requires agent key or master key
  router.patch('/accounts/me', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { metadata } = req.body || {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        res.status(400).json({ error: 'metadata must be an object' });
        return;
      }
      const updated = await accountManager.updateMetadata(agent.id, metadata);
      if (!updated) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(sanitizeAgent(updated));
    } catch (err) {
      next(err);
    }
  });

  // Toggle persistent flag — requires master key
  router.patch('/accounts/:id/persistent', requireMaster, async (req, res, next) => {
    try {
      const persistent = req.body?.persistent === true ? 1 : 0;
      const result = db.prepare('UPDATE agents SET persistent = ? WHERE id = ?').run(persistent, req.params.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
      res.json({ ok: true, persistent: persistent === 1 });
    } catch (err) { next(err); }
  });

  // Delete account — requires master key
  // Query params: archive (default true), reason, deletedBy
  router.delete('/accounts/:id', requireMaster, async (req, res, next) => {
    try {
      // Prevent deleting the last agent
      const allAgents = await accountManager.list();
      if (allAgents.length <= 1) {
        res.status(400).json({ error: 'Cannot delete the last agent. At least one agent must remain.' });
        return;
      }

      const archive = req.query.archive !== 'false';
      const reason = (req.query.reason as string) || undefined;
      const deletedBy = (req.query.deletedBy as string) || 'api';

      if (archive) {
        const report = await deletionService.archiveAndDelete(req.params.id, { deletedBy, reason });
        // Return summary without full email bodies
        const { emails: _emails, ...summary } = report;
        res.json(summary);
      } else {
        const deleted = await accountManager.delete(req.params.id);
        if (!deleted) {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }
        res.status(204).send();
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      next(err);
    }
  });

  return router;
}
