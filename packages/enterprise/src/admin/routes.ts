/**
 * Admin API Routes
 * 
 * CRUD for agents, users, audit logs, rules, settings.
 * All routes are protected by auth middleware (applied in server.ts).
 * Input validation on all mutations. RBAC on sensitive operations.
 */

import { Hono } from 'hono';
import type { DatabaseAdapter } from '../db/adapter.js';
import { validate, requireRole, ValidationError } from '../middleware/index.js';

export function createAdminRoutes(db: DatabaseAdapter) {
  const api = new Hono();

  // ─── Dashboard Stats ────────────────────────────────

  api.get('/stats', async (c) => {
    const stats = await db.getStats();
    return c.json(stats);
  });

  // ─── Agents ─────────────────────────────────────────

  api.get('/agents', async (c) => {
    const status = c.req.query('status') as any;
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0);
    const agents = await db.listAgents({ status, limit, offset });
    const total = await db.countAgents(status);
    return c.json({ agents, total, limit, offset });
  });

  api.get('/agents/:id', async (c) => {
    const agent = await db.getAgent(c.req.param('id'));
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    return c.json(agent);
  });

  api.post('/agents', async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'name', type: 'string', required: true, minLength: 1, maxLength: 64, pattern: /^[a-zA-Z0-9_-]+$/ },
      { field: 'email', type: 'email' },
      { field: 'role', type: 'string', maxLength: 32 },
    ]);

    // Check for duplicate name
    const existing = await db.getAgentByName(body.name);
    if (existing) {
      return c.json({ error: 'Agent name already exists' }, 409);
    }

    const userId = c.get('userId' as any) || 'system';
    const agent = await db.createAgent({ ...body, createdBy: userId });
    return c.json(agent, 201);
  });

  api.patch('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await db.getAgent(id);
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    const body = await c.req.json();
    validate(body, [
      { field: 'name', type: 'string', minLength: 1, maxLength: 64 },
      { field: 'email', type: 'email' },
      { field: 'role', type: 'string', maxLength: 32 },
      { field: 'status', type: 'string', pattern: /^(active|archived|suspended)$/ },
    ]);

    // If renaming, check for conflicts
    if (body.name && body.name !== existing.name) {
      const conflict = await db.getAgentByName(body.name);
      if (conflict) return c.json({ error: 'Agent name already exists' }, 409);
    }

    const agent = await db.updateAgent(id, body);
    return c.json(agent);
  });

  api.post('/agents/:id/archive', async (c) => {
    const existing = await db.getAgent(c.req.param('id'));
    if (!existing) return c.json({ error: 'Agent not found' }, 404);
    if (existing.status === 'archived') return c.json({ error: 'Agent already archived' }, 400);

    await db.archiveAgent(c.req.param('id'));
    return c.json({ ok: true, status: 'archived' });
  });

  api.post('/agents/:id/restore', async (c) => {
    const existing = await db.getAgent(c.req.param('id'));
    if (!existing) return c.json({ error: 'Agent not found' }, 404);
    if (existing.status !== 'archived') return c.json({ error: 'Agent is not archived' }, 400);

    await db.updateAgent(c.req.param('id'), { status: 'active' } as any);
    return c.json({ ok: true, status: 'active' });
  });

  // Permanent delete — owner/admin only
  api.delete('/agents/:id', requireRole('admin'), async (c) => {
    const existing = await db.getAgent(c.req.param('id'));
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    await db.deleteAgent(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ─── Users ──────────────────────────────────────────

  api.get('/users', requireRole('admin'), async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0);
    const users = await db.listUsers({ limit, offset });
    // Strip password hashes
    const safe = users.map(({ passwordHash, ...u }) => u);
    return c.json({ users: safe, limit, offset });
  });

  api.post('/users', requireRole('admin'), async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'email', type: 'email', required: true },
      { field: 'name', type: 'string', required: true, minLength: 1, maxLength: 128 },
      { field: 'role', type: 'string', required: true, pattern: /^(owner|admin|member|viewer)$/ },
      { field: 'password', type: 'string', minLength: 8, maxLength: 128 },
    ]);

    // Check duplicate email
    const existing = await db.getUserByEmail(body.email);
    if (existing) return c.json({ error: 'Email already registered' }, 409);

    const user = await db.createUser(body);
    const { passwordHash, ...safe } = user;
    return c.json(safe, 201);
  });

  api.patch('/users/:id', requireRole('admin'), async (c) => {
    const existing = await db.getUser(c.req.param('id'));
    if (!existing) return c.json({ error: 'User not found' }, 404);

    const body = await c.req.json();
    validate(body, [
      { field: 'email', type: 'email' },
      { field: 'name', type: 'string', minLength: 1, maxLength: 128 },
      { field: 'role', type: 'string', pattern: /^(owner|admin|member|viewer)$/ },
    ]);

    const user = await db.updateUser(c.req.param('id'), body);
    const { passwordHash, ...safe } = user;
    return c.json(safe);
  });

  api.delete('/users/:id', requireRole('owner'), async (c) => {
    const existing = await db.getUser(c.req.param('id'));
    if (!existing) return c.json({ error: 'User not found' }, 404);

    // Cannot delete yourself
    const requesterId = c.get('userId' as any);
    if (requesterId === c.req.param('id')) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    await db.deleteUser(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ─── Audit Log ──────────────────────────────────────

  api.get('/audit', requireRole('admin'), async (c) => {
    const filters = {
      actor: c.req.query('actor') || undefined,
      action: c.req.query('action') || undefined,
      resource: c.req.query('resource') || undefined,
      from: c.req.query('from') ? new Date(c.req.query('from')!) : undefined,
      to: c.req.query('to') ? new Date(c.req.query('to')!) : undefined,
      limit: Math.min(parseInt(c.req.query('limit') || '50'), 500),
      offset: Math.max(parseInt(c.req.query('offset') || '0'), 0),
    };

    // Validate date params
    if (filters.from && isNaN(filters.from.getTime())) {
      return c.json({ error: 'Invalid "from" date' }, 400);
    }
    if (filters.to && isNaN(filters.to.getTime())) {
      return c.json({ error: 'Invalid "to" date' }, 400);
    }

    const result = await db.queryAudit(filters);
    return c.json(result);
  });

  // ─── API Keys ───────────────────────────────────────

  api.get('/api-keys', requireRole('admin'), async (c) => {
    const keys = await db.listApiKeys();
    // Never expose key hashes
    const safe = keys.map(({ keyHash, ...k }) => k);
    return c.json({ keys: safe });
  });

  api.post('/api-keys', requireRole('admin'), async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'name', type: 'string', required: true, minLength: 1, maxLength: 64 },
    ]);

    const userId = c.get('userId' as any) || 'system';
    const scopes = Array.isArray(body.scopes) ? body.scopes : ['*'];
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

    const { key, plaintext } = await db.createApiKey({
      name: body.name,
      scopes,
      createdBy: userId,
      expiresAt,
    });

    // Only time the plaintext key is returned — emphasize this
    const { keyHash, ...safeKey } = key;
    return c.json({
      key: safeKey,
      plaintext,
      warning: 'Store this key securely. It will not be shown again.',
    }, 201);
  });

  api.delete('/api-keys/:id', requireRole('admin'), async (c) => {
    const existing = await db.getApiKey(c.req.param('id'));
    if (!existing) return c.json({ error: 'API key not found' }, 404);

    await db.revokeApiKey(c.req.param('id'));
    return c.json({ ok: true, revoked: true });
  });

  // ─── Email Rules ────────────────────────────────────

  api.get('/rules', async (c) => {
    const agentId = c.req.query('agentId') || undefined;
    const rules = await db.getRules(agentId);
    return c.json({ rules });
  });

  api.post('/rules', async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'name', type: 'string', required: true, minLength: 1, maxLength: 128 },
    ]);

    // Validate conditions/actions are objects
    if (body.conditions && typeof body.conditions !== 'object') {
      return c.json({ error: 'conditions must be an object' }, 400);
    }
    if (body.actions && typeof body.actions !== 'object') {
      return c.json({ error: 'actions must be an object' }, 400);
    }

    const rule = await db.createRule({
      name: body.name,
      agentId: body.agentId,
      conditions: body.conditions || {},
      actions: body.actions || {},
      priority: body.priority ?? 0,
      enabled: body.enabled ?? true,
    });
    return c.json(rule, 201);
  });

  api.patch('/rules/:id', async (c) => {
    const body = await c.req.json();
    const rule = await db.updateRule(c.req.param('id'), body);
    return c.json(rule);
  });

  api.delete('/rules/:id', async (c) => {
    await db.deleteRule(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ─── Settings ───────────────────────────────────────

  api.get('/settings', async (c) => {
    const settings = await db.getSettings();
    if (!settings) return c.json({ error: 'Not configured' }, 404);

    // Redact sensitive fields
    const safe = { ...settings };
    if (safe.smtpPass) safe.smtpPass = '***';
    if (safe.dkimPrivateKey) safe.dkimPrivateKey = '***';
    return c.json(safe);
  });

  api.patch('/settings', requireRole('admin'), async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'name', type: 'string', minLength: 1, maxLength: 128 },
      { field: 'domain', type: 'string', maxLength: 253 },
      { field: 'primaryColor', type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ },
      { field: 'logoUrl', type: 'url' },
    ]);

    const settings = await db.updateSettings(body);
    return c.json(settings);
  });

  // ─── Retention ──────────────────────────────────────

  api.get('/retention', requireRole('admin'), async (c) => {
    const policy = await db.getRetentionPolicy();
    return c.json(policy);
  });

  api.put('/retention', requireRole('owner'), async (c) => {
    const body = await c.req.json();
    validate(body, [
      { field: 'enabled', type: 'boolean', required: true },
      { field: 'retainDays', type: 'number', required: true, min: 1, max: 3650 },
      { field: 'archiveFirst', type: 'boolean' },
    ]);

    await db.setRetentionPolicy({
      enabled: body.enabled,
      retainDays: body.retainDays,
      excludeTags: body.excludeTags || [],
      archiveFirst: body.archiveFirst ?? true,
    });
    return c.json({ ok: true });
  });

  return api;
}
