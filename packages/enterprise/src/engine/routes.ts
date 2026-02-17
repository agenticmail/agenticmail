/**
 * Engine API Routes
 *
 * REST endpoints for the complete enterprise engine.
 * Mounted at /api/engine/* on the enterprise server.
 */

import { Hono } from 'hono';
import { PermissionEngine, BUILTIN_SKILLS, PRESET_PROFILES } from './skills.js';
import { AgentConfigGenerator, type AgentConfig } from './agent-config.js';
import { DeploymentEngine } from './deployer.js';
import { ApprovalEngine } from './approvals.js';
import { AgentLifecycleManager } from './lifecycle.js';
import { KnowledgeBaseEngine } from './knowledge.js';
import { TenantManager } from './tenant.js';
import { ActivityTracker } from './activity.js';

const engine = new Hono();

// ─── Shared Instances ───────────────────────────────────

const permissionEngine = new PermissionEngine();
const configGen = new AgentConfigGenerator();
const deployer = new DeploymentEngine();
const approvals = new ApprovalEngine();
const lifecycle = new AgentLifecycleManager({ permissions: permissionEngine });
const knowledgeBase = new KnowledgeBaseEngine();
const tenants = new TenantManager();
const activity = new ActivityTracker();

// Wire lifecycle events into activity tracker
lifecycle.onEvent((event) => {
  activity.record({
    agentId: event.agentId,
    orgId: event.orgId,
    type: event.type as any,
    data: event.data,
  });
});

// ─── Skills Catalog ─────────────────────────────────────

engine.get('/skills', (c) => {
  return c.json({ skills: BUILTIN_SKILLS, categories: [...new Set(BUILTIN_SKILLS.map(s => s.category))], total: BUILTIN_SKILLS.length });
});

engine.get('/skills/by-category', (c) => {
  const grouped: Record<string, typeof BUILTIN_SKILLS> = {};
  for (const skill of BUILTIN_SKILLS) {
    if (!grouped[skill.category]) grouped[skill.category] = [];
    grouped[skill.category].push(skill);
  }
  return c.json({ categories: grouped });
});

engine.get('/skills/:id', (c) => {
  const skill = BUILTIN_SKILLS.find(s => s.id === c.req.param('id'));
  if (!skill) return c.json({ error: 'Skill not found' }, 404);
  return c.json({ skill });
});

// ─── Permission Profiles ────────────────────────────────

engine.get('/profiles/presets', (c) => c.json({ presets: PRESET_PROFILES }));

engine.get('/profiles/:agentId', (c) => {
  const profile = permissionEngine.getProfile(c.req.param('agentId'));
  if (!profile) return c.json({ error: 'No profile assigned' }, 404);
  return c.json({ profile });
});

engine.put('/profiles/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const profile = await c.req.json();
  profile.id = profile.id || agentId;
  profile.updatedAt = new Date().toISOString();
  if (!profile.createdAt) profile.createdAt = profile.updatedAt;
  permissionEngine.setProfile(agentId, profile);
  return c.json({ success: true, profile });
});

engine.post('/profiles/:agentId/apply-preset', async (c) => {
  const agentId = c.req.param('agentId');
  const { presetName } = await c.req.json();
  const preset = PRESET_PROFILES.find(p => p.name === presetName);
  if (!preset) return c.json({ error: 'Preset not found' }, 404);
  const profile = { ...preset, id: agentId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  permissionEngine.setProfile(agentId, profile as any);
  return c.json({ success: true, profile });
});

engine.post('/permissions/check', async (c) => {
  const { agentId, toolId } = await c.req.json();
  return c.json(permissionEngine.checkPermission(agentId, toolId));
});

engine.get('/permissions/:agentId/tools', (c) => {
  const tools = permissionEngine.getAvailableTools(c.req.param('agentId'));
  return c.json({ tools, total: tools.length });
});

engine.get('/permissions/:agentId/policy', (c) => {
  return c.json(permissionEngine.generateToolPolicy(c.req.param('agentId')));
});

// ─── Agent Lifecycle ────────────────────────────────────

engine.post('/agents', async (c) => {
  const { orgId, config, createdBy } = await c.req.json();
  try {
    const agent = await lifecycle.createAgent(orgId, config, createdBy);
    return c.json({ agent }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.get('/agents', (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  const agents = lifecycle.getAgentsByOrg(orgId);
  return c.json({ agents, total: agents.length });
});

engine.get('/agents/:id', (c) => {
  const agent = lifecycle.getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent });
});

engine.patch('/agents/:id/config', async (c) => {
  const { updates, updatedBy } = await c.req.json();
  try {
    const agent = await lifecycle.updateConfig(c.req.param('id'), updates, updatedBy);
    return c.json({ agent });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.post('/agents/:id/deploy', async (c) => {
  const { deployedBy } = await c.req.json();
  try {
    const agent = await lifecycle.deploy(c.req.param('id'), deployedBy);
    return c.json({ agent });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.post('/agents/:id/stop', async (c) => {
  const { stoppedBy, reason } = await c.req.json();
  try {
    const agent = await lifecycle.stop(c.req.param('id'), stoppedBy, reason);
    return c.json({ agent });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.post('/agents/:id/restart', async (c) => {
  const { restartedBy } = await c.req.json();
  try {
    const agent = await lifecycle.restart(c.req.param('id'), restartedBy);
    return c.json({ agent });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.post('/agents/:id/hot-update', async (c) => {
  const { updates, updatedBy } = await c.req.json();
  try {
    const agent = await lifecycle.hotUpdate(c.req.param('id'), updates, updatedBy);
    return c.json({ agent });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.delete('/agents/:id', async (c) => {
  const { destroyedBy } = await c.req.json().catch(() => ({ destroyedBy: 'unknown' }));
  try {
    await lifecycle.destroy(c.req.param('id'), destroyedBy);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.get('/agents/:id/usage', (c) => {
  const agent = lifecycle.getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ usage: agent.usage, health: agent.health, state: agent.state });
});

engine.get('/usage/:orgId', (c) => {
  return c.json(lifecycle.getOrgUsage(c.req.param('orgId')));
});

// ─── Config Generation ──────────────────────────────────

engine.post('/config/workspace', async (c) => {
  const config: AgentConfig = await c.req.json();
  return c.json({ files: configGen.generateWorkspace(config) });
});

engine.post('/config/gateway', async (c) => {
  const config: AgentConfig = await c.req.json();
  return c.json({ config: configGen.generateGatewayConfig(config) });
});

engine.post('/config/docker-compose', async (c) => {
  const config: AgentConfig = await c.req.json();
  return c.json({ compose: configGen.generateDockerCompose(config) });
});

engine.post('/config/systemd', async (c) => {
  const config: AgentConfig = await c.req.json();
  return c.json({ unit: configGen.generateSystemdUnit(config) });
});

engine.post('/config/deploy-script', async (c) => {
  const config: AgentConfig = await c.req.json();
  return c.json({ script: configGen.generateVPSDeployScript(config) });
});

// ─── Knowledge Base ─────────────────────────────────────

engine.post('/knowledge-bases', async (c) => {
  const { orgId, name, description, agentIds, config } = await c.req.json();
  const kb = knowledgeBase.createKnowledgeBase(orgId, { name, description, agentIds, config });
  return c.json({ knowledgeBase: kb }, 201);
});

engine.get('/knowledge-bases', (c) => {
  const orgId = c.req.query('orgId');
  const agentId = c.req.query('agentId');
  if (agentId) return c.json({ knowledgeBases: knowledgeBase.getKnowledgeBasesForAgent(agentId) });
  if (orgId) return c.json({ knowledgeBases: knowledgeBase.getKnowledgeBasesByOrg(orgId) });
  return c.json({ error: 'orgId or agentId required' }, 400);
});

engine.get('/knowledge-bases/:id', (c) => {
  const kb = knowledgeBase.getKnowledgeBase(c.req.param('id'));
  if (!kb) return c.json({ error: 'Knowledge base not found' }, 404);
  return c.json({ knowledgeBase: kb });
});

engine.post('/knowledge-bases/:id/documents', async (c) => {
  const { name, content, sourceType, sourceUrl, mimeType, metadata } = await c.req.json();
  try {
    const doc = await knowledgeBase.ingestDocument(c.req.param('id'), { name, content, sourceType, sourceUrl, mimeType, metadata });
    return c.json({ document: doc }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.delete('/knowledge-bases/:kbId/documents/:docId', (c) => {
  const ok = knowledgeBase.deleteDocument(c.req.param('kbId'), c.req.param('docId'));
  return ok ? c.json({ success: true }) : c.json({ error: 'Not found' }, 404);
});

engine.post('/knowledge-bases/search', async (c) => {
  const { agentId, query, kbIds, maxResults, minScore } = await c.req.json();
  const results = await knowledgeBase.search(agentId, query, { kbIds, maxResults, minScore });
  return c.json({ results, total: results.length });
});

engine.post('/knowledge-bases/context', async (c) => {
  const { agentId, query, maxTokens } = await c.req.json();
  const context = await knowledgeBase.getContext(agentId, query, maxTokens);
  return c.json({ context });
});

engine.delete('/knowledge-bases/:id', (c) => {
  const ok = knowledgeBase.deleteKnowledgeBase(c.req.param('id'));
  return ok ? c.json({ success: true }) : c.json({ error: 'Not found' }, 404);
});

// ─── Organizations (Tenants) ────────────────────────────

engine.post('/orgs', async (c) => {
  const { name, slug, plan, adminEmail, settings } = await c.req.json();
  try {
    const org = tenants.createOrg({ name, slug, plan: plan || 'free', adminEmail, settings });
    return c.json({ org }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.get('/orgs', (c) => c.json({ orgs: tenants.listOrgs() }));

engine.get('/orgs/:id', (c) => {
  const org = tenants.getOrg(c.req.param('id'));
  if (!org) return c.json({ error: 'Org not found' }, 404);
  return c.json({ org });
});

engine.get('/orgs/slug/:slug', (c) => {
  const org = tenants.getOrgBySlug(c.req.param('slug'));
  if (!org) return c.json({ error: 'Org not found' }, 404);
  return c.json({ org });
});

engine.post('/orgs/:id/check-limit', async (c) => {
  const { resource, currentCount } = await c.req.json();
  try {
    return c.json(tenants.checkLimit(c.req.param('id'), resource, currentCount));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

engine.post('/orgs/:id/check-feature', async (c) => {
  const { feature } = await c.req.json();
  return c.json({ allowed: tenants.hasFeature(c.req.param('id'), feature) });
});

engine.post('/orgs/:id/change-plan', async (c) => {
  const { plan } = await c.req.json();
  try {
    const org = tenants.changePlan(c.req.param('id'), plan);
    return c.json({ org });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ─── Approvals ──────────────────────────────────────────

engine.get('/approvals/pending', (c) => {
  const agentId = c.req.query('agentId');
  const requests = approvals.getPendingRequests(agentId || undefined);
  return c.json({ requests, total: requests.length });
});

engine.get('/approvals/history', (c) => {
  const agentId = c.req.query('agentId');
  const limit = parseInt(c.req.query('limit') || '25');
  const offset = parseInt(c.req.query('offset') || '0');
  return c.json(approvals.getHistory({ agentId: agentId || undefined, limit, offset }));
});

engine.get('/approvals/:id', (c) => {
  const request = approvals.getRequest(c.req.param('id'));
  if (!request) return c.json({ error: 'Not found' }, 404);
  return c.json({ request });
});

engine.post('/approvals/:id/decide', async (c) => {
  const { action, reason, by } = await c.req.json();
  const result = approvals.decide(c.req.param('id'), { action, reason, by });
  if (!result) return c.json({ error: 'Not found or already decided' }, 404);
  return c.json({ request: result });
});

engine.get('/approvals/policies', (c) => c.json({ policies: approvals.getPolicies() }));

engine.post('/approvals/policies', async (c) => {
  const policy = await c.req.json();
  policy.id = policy.id || crypto.randomUUID();
  approvals.addPolicy(policy);
  return c.json({ success: true, policy });
});

engine.delete('/approvals/policies/:id', (c) => {
  approvals.removePolicy(c.req.param('id'));
  return c.json({ success: true });
});

// ─── Activity & Monitoring ──────────────────────────────

engine.get('/activity/events', (c) => {
  const events = activity.getEvents({
    agentId: c.req.query('agentId') || undefined,
    orgId: c.req.query('orgId') || undefined,
    since: c.req.query('since') || undefined,
    limit: parseInt(c.req.query('limit') || '50'),
  });
  return c.json({ events, total: events.length });
});

engine.get('/activity/tool-calls', (c) => {
  const calls = activity.getToolCalls({
    agentId: c.req.query('agentId') || undefined,
    orgId: c.req.query('orgId') || undefined,
    toolId: c.req.query('toolId') || undefined,
    limit: parseInt(c.req.query('limit') || '50'),
  });
  return c.json({ toolCalls: calls, total: calls.length });
});

engine.get('/activity/conversation/:sessionId', (c) => {
  const entries = activity.getConversation(c.req.param('sessionId'));
  return c.json({ entries, total: entries.length });
});

engine.get('/activity/timeline/:agentId/:date', (c) => {
  const timeline = activity.getTimeline(c.req.param('agentId'), c.req.param('date'));
  return c.json({ timeline });
});

engine.get('/activity/stats', (c) => {
  const orgId = c.req.query('orgId');
  return c.json(activity.getStats(orgId || undefined));
});

// SSE endpoint for real-time events
engine.get('/activity/stream', (c) => {
  const orgId = c.req.query('orgId');
  const agentId = c.req.query('agentId');

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); }
        catch { unsubscribe(); }
      };

      // Send heartbeat every 30s
      const heartbeat = setInterval(() => send(JSON.stringify({ type: 'heartbeat' })), 30_000);

      const unsubscribe = activity.subscribe((event) => {
        if (orgId && event.orgId !== orgId) return;
        if (agentId && event.agentId !== agentId) return;
        send(JSON.stringify(event));
      });

      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ─── Engine Stats (Dashboard Overview) ──────────────────

engine.get('/stats/:orgId', (c) => {
  const orgId = c.req.param('orgId');
  const org = tenants.getOrg(orgId);
  const agents = lifecycle.getAgentsByOrg(orgId);
  const orgUsage = lifecycle.getOrgUsage(orgId);
  const realTimeStats = activity.getStats(orgId);

  return c.json({
    org: org ? { name: org.name, plan: org.plan, limits: org.limits, usage: org.usage } : null,
    agents: {
      total: agents.length,
      byState: agents.reduce((acc, a) => { acc[a.state] = (acc[a.state] || 0) + 1; return acc; }, {} as Record<string, number>),
    },
    usage: orgUsage,
    realTime: realTimeStats,
  });
});

// ─── Dynamic Tables ────────────────────────────────────

/**
 * POST /schema/tables — Create a dynamic table at runtime.
 * Body: { name, sql, postgres?, mysql?, indexes? }
 * Tables are prefixed with `ext_` automatically.
 *
 * Requires an EngineDatabase instance wired in via setEngineDb().
 */
let _engineDb: import('./db-adapter.js').EngineDatabase | null = null;

export function setEngineDb(db: import('./db-adapter.js').EngineDatabase) {
  _engineDb = db;
}

engine.post('/schema/tables', async (c) => {
  if (!_engineDb) return c.json({ error: 'Engine database not initialized' }, 503);
  try {
    const def = await c.req.json();
    if (!def.name || !def.sql) return c.json({ error: 'name and sql are required' }, 400);
    await _engineDb.createDynamicTable(def);
    const prefixed = def.name.startsWith('ext_') ? def.name : `ext_${def.name}`;
    return c.json({ ok: true, table: prefixed });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

engine.get('/schema/tables', async (c) => {
  if (!_engineDb) return c.json({ error: 'Engine database not initialized' }, 503);
  const tables = await _engineDb.listDynamicTables();
  return c.json({ tables });
});

engine.post('/schema/query', async (c) => {
  if (!_engineDb) return c.json({ error: 'Engine database not initialized' }, 503);
  try {
    const { sql, params } = await c.req.json();
    if (!sql) return c.json({ error: 'sql is required' }, 400);
    // Only allow SELECT on ext_ tables for safety
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      const rows = await _engineDb.query(sql, params);
      return c.json({ rows });
    } else {
      // INSERT/UPDATE/DELETE — verify it targets ext_ tables
      if (!trimmed.includes('EXT_')) {
        return c.json({ error: 'Mutations only allowed on ext_* tables' }, 403);
      }
      await _engineDb.execute(sql, params);
      return c.json({ ok: true });
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export { engine as engineRoutes };
export { permissionEngine, configGen, deployer, approvals, lifecycle, knowledgeBase, tenants, activity };
