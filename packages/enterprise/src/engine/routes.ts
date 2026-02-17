/**
 * Engine API Routes
 *
 * REST endpoints for the skill/permission/deployment engine.
 * Mounted at /api/engine/* on the enterprise server.
 */

import { Hono } from 'hono';
import { PermissionEngine, BUILTIN_SKILLS, PRESET_PROFILES } from './skills.js';
import { AgentConfigGenerator, type AgentConfig } from './agent-config.js';
import { DeploymentEngine } from './deployer.js';
import { ApprovalEngine } from './approvals.js';

const engine = new Hono();

// Shared instances
const permissionEngine = new PermissionEngine();
const configGen = new AgentConfigGenerator();
const deployer = new DeploymentEngine();
const approvals = new ApprovalEngine();

// ─── Skills Catalog ─────────────────────────────────────

// List all available skills (the marketplace)
engine.get('/skills', (c) => {
  return c.json({
    skills: BUILTIN_SKILLS,
    categories: [...new Set(BUILTIN_SKILLS.map(s => s.category))],
    total: BUILTIN_SKILLS.length,
  });
});

// Get skills grouped by category
engine.get('/skills/by-category', (c) => {
  const grouped: Record<string, typeof BUILTIN_SKILLS> = {};
  for (const skill of BUILTIN_SKILLS) {
    if (!grouped[skill.category]) grouped[skill.category] = [];
    grouped[skill.category].push(skill);
  }
  return c.json({ categories: grouped });
});

// Get a single skill's details
engine.get('/skills/:id', (c) => {
  const skill = BUILTIN_SKILLS.find(s => s.id === c.req.param('id'));
  if (!skill) return c.json({ error: 'Skill not found' }, 404);
  return c.json({ skill });
});

// ─── Permission Profiles ────────────────────────────────

// List preset profiles (templates)
engine.get('/profiles/presets', (c) => {
  return c.json({ presets: PRESET_PROFILES });
});

// Get an agent's current permission profile
engine.get('/profiles/:agentId', (c) => {
  const profile = permissionEngine.getProfile(c.req.param('agentId'));
  if (!profile) return c.json({ error: 'No profile assigned' }, 404);
  return c.json({ profile });
});

// Set/update an agent's permission profile
engine.put('/profiles/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const profile = await c.req.json();
  profile.id = profile.id || agentId;
  profile.updatedAt = new Date().toISOString();
  if (!profile.createdAt) profile.createdAt = profile.updatedAt;
  permissionEngine.setProfile(agentId, profile);
  return c.json({ success: true, profile });
});

// Apply a preset profile to an agent
engine.post('/profiles/:agentId/apply-preset', async (c) => {
  const agentId = c.req.param('agentId');
  const { presetName } = await c.req.json();
  const preset = PRESET_PROFILES.find(p => p.name === presetName);
  if (!preset) return c.json({ error: 'Preset not found' }, 404);

  const profile = {
    ...preset,
    id: agentId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  permissionEngine.setProfile(agentId, profile as any);
  return c.json({ success: true, profile });
});

// Check if a specific tool is allowed for an agent
engine.post('/permissions/check', async (c) => {
  const { agentId, toolId } = await c.req.json();
  const result = permissionEngine.checkPermission(agentId, toolId);
  return c.json(result);
});

// Get all available tools for an agent (resolved from their profile)
engine.get('/permissions/:agentId/tools', (c) => {
  const tools = permissionEngine.getAvailableTools(c.req.param('agentId'));
  return c.json({ tools, total: tools.length });
});

// Generate the OpenClaw tool policy for an agent
engine.get('/permissions/:agentId/policy', (c) => {
  const policy = permissionEngine.generateToolPolicy(c.req.param('agentId'));
  return c.json(policy);
});

// ─── Agent Configuration ────────────────────────────────

// Generate workspace files for an agent config
engine.post('/config/workspace', async (c) => {
  const config: AgentConfig = await c.req.json();
  const files = configGen.generateWorkspace(config);
  return c.json({ files });
});

// Generate gateway config
engine.post('/config/gateway', async (c) => {
  const config: AgentConfig = await c.req.json();
  const gateway = configGen.generateGatewayConfig(config);
  return c.json({ config: gateway });
});

// Generate docker-compose.yml
engine.post('/config/docker-compose', async (c) => {
  const config: AgentConfig = await c.req.json();
  const compose = configGen.generateDockerCompose(config);
  return c.json({ compose });
});

// Generate systemd unit file
engine.post('/config/systemd', async (c) => {
  const config: AgentConfig = await c.req.json();
  const unit = configGen.generateSystemdUnit(config);
  return c.json({ unit });
});

// Generate VPS deploy script
engine.post('/config/deploy-script', async (c) => {
  const config: AgentConfig = await c.req.json();
  const script = configGen.generateVPSDeployScript(config);
  return c.json({ script });
});

// ─── Deployment ─────────────────────────────────────────

// Deploy an agent
engine.post('/deploy', async (c) => {
  const config: AgentConfig = await c.req.json();
  const events: any[] = [];
  const result = await deployer.deploy(config, (event) => events.push(event));
  return c.json({ ...result, events });
});

// Stop a deployed agent
engine.post('/deploy/:agentId/stop', async (c) => {
  const config: AgentConfig = await c.req.json();
  const result = await deployer.stop(config);
  return c.json(result);
});

// Restart a deployed agent
engine.post('/deploy/:agentId/restart', async (c) => {
  const config: AgentConfig = await c.req.json();
  const result = await deployer.restart(config);
  return c.json(result);
});

// Get deployment status
engine.post('/deploy/:agentId/status', async (c) => {
  const config: AgentConfig = await c.req.json();
  const status = await deployer.getStatus(config);
  return c.json(status);
});

// Get deployment logs
engine.post('/deploy/:agentId/logs', async (c) => {
  const config: AgentConfig = await c.req.json();
  const { lines } = await c.req.json().catch(() => ({ lines: 100 }));
  const logs = await deployer.getLogs(config, lines);
  return c.json({ logs });
});

// Hot-update config without full redeployment
engine.post('/deploy/:agentId/update-config', async (c) => {
  const config: AgentConfig = await c.req.json();
  const result = await deployer.updateConfig(config);
  return c.json(result);
});

// ─── Approvals ──────────────────────────────────────────

// Get pending approval requests
engine.get('/approvals/pending', (c) => {
  const agentId = c.req.query('agentId');
  const requests = approvals.getPendingRequests(agentId || undefined);
  return c.json({ requests, total: requests.length });
});

// Get approval history
engine.get('/approvals/history', (c) => {
  const agentId = c.req.query('agentId');
  const limit = parseInt(c.req.query('limit') || '25');
  const offset = parseInt(c.req.query('offset') || '0');
  const history = approvals.getHistory({ agentId: agentId || undefined, limit, offset });
  return c.json(history);
});

// Get a specific approval request
engine.get('/approvals/:id', (c) => {
  const request = approvals.getRequest(c.req.param('id'));
  if (!request) return c.json({ error: 'Request not found' }, 404);
  return c.json({ request });
});

// Approve or deny a request
engine.post('/approvals/:id/decide', async (c) => {
  const { action, reason, by } = await c.req.json();
  const result = approvals.decide(c.req.param('id'), { action, reason, by });
  if (!result) return c.json({ error: 'Request not found or already decided' }, 404);
  return c.json({ request: result });
});

// Manage approval policies
engine.get('/approvals/policies', (c) => {
  return c.json({ policies: approvals.getPolicies() });
});

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

export { engine as engineRoutes };
export { permissionEngine, configGen, deployer, approvals };
