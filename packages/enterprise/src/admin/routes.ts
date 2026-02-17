/**
 * Admin API Routes
 * 
 * CRUD for agents, users, audit logs, rules, settings.
 */

import { Hono } from 'hono';
import type { DatabaseAdapter } from '../db/adapter.js';

export function createAdminRoutes(db: DatabaseAdapter) {
  const api = new Hono();

  // ─── Dashboard Stats ────────────────────────────────────

  api.get('/stats', async (c) => {
    const stats = await db.getStats();
    return c.json(stats);
  });

  // ─── Agents ─────────────────────────────────────────────

  api.get('/agents', async (c) => {
    const status = c.req.query('status') as any;
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const agents = await db.listAgents({ status, limit, offset });
    const total = await db.countAgents(status);
    return c.json({ agents, total });
  });

  api.get('/agents/:id', async (c) => {
    const agent = await db.getAgent(c.req.param('id'));
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    return c.json(agent);
  });

  api.post('/agents', async (c) => {
    const body = await c.req.json();
    const userId = c.get('userId' as any) || 'system';
    const agent = await db.createAgent({ ...body, createdBy: userId });
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'agent.create',
      resource: `agent:${agent.id}`, details: { name: agent.name, role: agent.role },
    });
    return c.json(agent, 201);
  });

  api.patch('/agents/:id', async (c) => {
    const body = await c.req.json();
    const agent = await db.updateAgent(c.req.param('id'), body);
    const userId = c.get('userId' as any) || 'system';
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'agent.update',
      resource: `agent:${agent.id}`, details: body,
    });
    return c.json(agent);
  });

  api.post('/agents/:id/archive', async (c) => {
    await db.archiveAgent(c.req.param('id'));
    const userId = c.get('userId' as any) || 'system';
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'agent.archive',
      resource: `agent:${c.req.param('id')}`,
    });
    return c.json({ ok: true });
  });

  api.delete('/agents/:id', async (c) => {
    await db.deleteAgent(c.req.param('id'));
    const userId = c.get('userId' as any) || 'system';
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'agent.delete',
      resource: `agent:${c.req.param('id')}`,
    });
    return c.json({ ok: true });
  });

  // ─── Users ──────────────────────────────────────────────

  api.get('/users', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const users = await db.listUsers({ limit, offset });
    // Strip password hashes
    const safe = users.map(({ passwordHash, ...u }) => u);
    return c.json({ users: safe });
  });

  api.post('/users', async (c) => {
    const body = await c.req.json();
    const user = await db.createUser(body);
    const { passwordHash, ...safe } = user;
    const userId = c.get('userId' as any) || 'system';
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'user.create',
      resource: `user:${user.id}`, details: { email: user.email, role: user.role },
    });
    return c.json(safe, 201);
  });

  api.patch('/users/:id', async (c) => {
    const body = await c.req.json();
    const user = await db.updateUser(c.req.param('id'), body);
    const { passwordHash, ...safe } = user;
    return c.json(safe);
  });

  api.delete('/users/:id', async (c) => {
    await db.deleteUser(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ─── Audit Log ──────────────────────────────────────────

  api.get('/audit', async (c) => {
    const filters = {
      actor: c.req.query('actor'),
      action: c.req.query('action'),
      resource: c.req.query('resource'),
      from: c.req.query('from') ? new Date(c.req.query('from')!) : undefined,
      to: c.req.query('to') ? new Date(c.req.query('to')!) : undefined,
      limit: parseInt(c.req.query('limit') || '50'),
      offset: parseInt(c.req.query('offset') || '0'),
    };
    const result = await db.queryAudit(filters);
    return c.json(result);
  });

  // ─── API Keys ───────────────────────────────────────────

  api.get('/api-keys', async (c) => {
    const keys = await db.listApiKeys();
    return c.json({ keys });
  });

  api.post('/api-keys', async (c) => {
    const body = await c.req.json();
    const userId = c.get('userId' as any) || 'system';
    const { key, plaintext } = await db.createApiKey({ ...body, createdBy: userId });
    await db.logEvent({
      actor: userId, actorType: 'user', action: 'api_key.create',
      resource: `api_key:${key.id}`, details: { name: key.name },
    });
    // Only time the plaintext is returned
    return c.json({ key, plaintext }, 201);
  });

  api.delete('/api-keys/:id', async (c) => {
    await db.revokeApiKey(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ─── Email Rules ────────────────────────────────────────

  api.get('/rules', async (c) => {
    const agentId = c.req.query('agentId');
    const rules = await db.getRules(agentId);
    return c.json({ rules });
  });

  api.post('/rules', async (c) => {
    const body = await c.req.json();
    const rule = await db.createRule(body);
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

  // ─── Settings ───────────────────────────────────────────

  api.get('/settings', async (c) => {
    const settings = await db.getSettings();
    return c.json(settings);
  });

  api.patch('/settings', async (c) => {
    const body = await c.req.json();
    const settings = await db.updateSettings(body);
    return c.json(settings);
  });

  // ─── Retention ──────────────────────────────────────────

  api.get('/retention', async (c) => {
    const policy = await db.getRetentionPolicy();
    return c.json(policy);
  });

  api.put('/retention', async (c) => {
    const body = await c.req.json();
    await db.setRetentionPolicy(body);
    return c.json({ ok: true });
  });

  return api;
}
