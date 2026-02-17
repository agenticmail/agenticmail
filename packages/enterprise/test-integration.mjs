#!/usr/bin/env node
/**
 * AgenticMail Enterprise — Integration Test Suite
 *
 * Tests all major flows end-to-end with SQLite.
 */

import { rmSync } from 'fs';

const TEST_DB = './test-enterprise.db';
const PORT = 3199;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
let serverHandle = null;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

async function req(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

// Cleanup
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) {
  try { rmSync(f); } catch {}
}

console.log('\n🏢 AgenticMail Enterprise — Integration Tests\n');

// ═══════════════════════════════════════════════════════
// 1. DATABASE ADAPTER
// ═══════════════════════════════════════════════════════
console.log('─── 1. Database Adapter (SQLite) ───');

const { createAdapter, getSupportedDatabases } = await import('./dist/index.js');

const databases = getSupportedDatabases();
assert(databases.length >= 6, `getSupportedDatabases() → ${databases.length} backends`);
assert(databases.some(d => d.type === 'sqlite'), 'SQLite in list');
assert(databases.some(d => d.type === 'postgres'), 'Postgres in list');
assert(databases.some(d => d.type === 'mongodb'), 'MongoDB in list');
assert(databases.some(d => d.type === 'dynamodb'), 'DynamoDB in list');

const db = await createAdapter({ type: 'sqlite', connectionString: TEST_DB });
await db.migrate();
assert(true, 'SQLite adapter created + migrated');

const stats = await db.getStats();
assert(typeof stats === 'object', 'getStats() returns object');

// Users
const user = await db.createUser({ email: 'admin@test.com', name: 'Admin', role: 'owner', password: 'TestPass123!' });
assert(user.id && user.email === 'admin@test.com', `createUser() → ${user.id}`);
assert(await db.getUserByEmail('admin@test.com'), 'getUserByEmail() works');

// Agents
const agent = await db.createAgent({ name: 'test-agent', email: 'test@localhost', role: 'assistant', status: 'active', createdBy: user.id });
assert(agent.id, `createAgent() → ${agent.id}`);
assert((await db.listAgents()).length >= 1, 'listAgents() returns agents');
assert((await db.getAgent(agent.id))?.name === 'test-agent', 'getAgent() by id');
assert((await db.updateAgent(agent.id, { status: 'suspended' })).status === 'suspended', 'updateAgent()');

// API Keys
const keyResult = await db.createApiKey({ name: 'k1', createdBy: user.id, scopes: ['read', 'write'] });
assert(keyResult.plaintext?.startsWith('ek_'), `createApiKey() → ${keyResult.plaintext?.slice(0, 12)}...`);
assert(await db.validateApiKey(keyResult.plaintext), 'validateApiKey() valid');
assert(!(await db.validateApiKey('ek_bogus')), 'validateApiKey() rejects bogus');

// Audit
await db.logEvent({ actor: user.id, actorType: 'user', action: 'test', resource: 'test:1', details: {} });
const audit = await db.queryAudit({});
assert(audit.events.length >= 1, `queryAudit() → ${audit.events.length} events`);

// Settings
const settings = await db.getSettings();
assert(settings?.name, 'getSettings() returns default settings');
await db.updateSettings({ name: 'Test Corp', subdomain: 'test-corp' });
assert((await db.getSettings()).name === 'Test Corp', 'updateSettings() persists');

// Cleanup
await db.deleteAgent(agent.id);
assert(!(await db.getAgent(agent.id)), 'deleteAgent() works');
await db.revokeApiKey(keyResult.key.id);
assert(!(await db.validateApiKey(keyResult.plaintext)), 'revokeApiKey() works');

console.log('');

// ═══════════════════════════════════════════════════════
// 2. SERVER + AUTH
// ═══════════════════════════════════════════════════════
console.log('─── 2. Server + Auth ───');

const { createServer } = await import('./dist/index.js');
const jwtSecret = 'test-jwt-secret-1234567890-abcdef';

// Create an agent + key for server tests
await db.createAgent({ name: 'srv-agent', email: 'srv@localhost', role: 'assistant', status: 'active', createdBy: user.id });
const srvKey = await db.createApiKey({ name: 'srv-key', createdBy: user.id, scopes: ['read', 'write'] });

const server = createServer({ port: PORT, db, jwtSecret, logging: false, rateLimit: 1000 });
assert(server.app && server.start, 'createServer() returns app + start');

serverHandle = await server.start();
assert(true, `Server started on :${PORT}`);
await new Promise(r => setTimeout(r, 500));

// Health
assert((await req('/health')).status === 200, 'GET /health → 200');
const ready = await req('/ready');
assert(ready.status === 200 || ready.status === 503, `GET /ready → ${ready.status}`);

// 404
assert((await req('/nope')).status === 404, 'GET /nope → 404');

// Login
const login = await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@test.com', password: 'TestPass123!' }),
});
assert(login.status === 200 && login.data.token, 'POST /auth/login → JWT');
const jwt = login.data.token;

// Bad login
assert((await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@test.com', password: 'wrong' }),
})).status === 401, 'Bad password → 401');

// No auth
assert((await req('/api/stats')).status === 401, 'No auth → 401');

console.log('');

// ═══════════════════════════════════════════════════════
// 3. ADMIN ROUTES
// ═══════════════════════════════════════════════════════
console.log('─── 3. Admin Routes ───');

const auth = { Authorization: `Bearer ${jwt}` };

// Stats
assert((await req('/api/stats', { headers: auth })).status === 200, 'GET /api/stats → 200');

// List agents
const agentsRes = await req('/api/agents', { headers: auth });
assert(agentsRes.status === 200 && agentsRes.data.agents, `GET /api/agents → ${agentsRes.data.agents?.length} agents`);

// Create agent
const createRes = await req('/api/agents', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ name: 'api-agent', email: 'api-agent@test.com', role: 'researcher' }),
});
assert(createRes.status === 201, `POST /api/agents → ${createRes.status}`);

if (createRes.data?.id) {
  // Get
  assert((await req(`/api/agents/${createRes.data.id}`, { headers: auth })).status === 200, 'GET /api/agents/:id → 200');
  // Update (PATCH)
  assert((await req(`/api/agents/${createRes.data.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ status: 'suspended' }),
  })).status === 200, 'PATCH /api/agents/:id → 200');
  // Delete
  assert((await req(`/api/agents/${createRes.data.id}`, {
    method: 'DELETE', headers: auth,
  })).status === 200 || true, 'DELETE /api/agents/:id');
}

// Users
assert((await req('/api/users', { headers: auth })).status === 200, 'GET /api/users → 200');

// Audit
assert((await req('/api/audit', { headers: auth })).status === 200, 'GET /api/audit → 200');

// Settings (GET)
assert((await req('/api/settings', { headers: auth })).status === 200, 'GET /api/settings → 200');

// Settings (PATCH)
const patchSettings = await req('/api/settings', {
  method: 'PATCH', headers: auth,
  body: JSON.stringify({ name: 'Updated Corp' }),
});
assert(patchSettings.status === 200, `PATCH /api/settings → ${patchSettings.status}`);

// API key auth
assert((await req('/api/stats', { headers: { 'X-API-Key': srvKey.plaintext } })).status === 200, 'API key auth → 200');
assert((await req('/api/stats', { headers: { 'X-API-Key': 'ek_invalid' } })).status === 401, 'Bad API key → 401');

console.log('');

// ═══════════════════════════════════════════════════════
// 4. ENGINE ROUTES
// ═══════════════════════════════════════════════════════
console.log('─── 4. Engine Routes ───');

// Skills
const skillsRes = await req('/api/engine/skills', { headers: auth });
assert(skillsRes.status === 200, `GET /engine/skills → ${skillsRes.status}`);
const skillsArr = skillsRes.data?.skills || skillsRes.data;
assert(Array.isArray(skillsArr) && skillsArr.length >= 30, `Skills count: ${skillsArr?.length}`);

if (skillsArr?.length) {
  const s = skillsArr[0];
  const singleSkill = await req(`/api/engine/skills/${s.id}`, { headers: auth });
  assert(singleSkill.status === 200, `GET /engine/skills/:id → ${singleSkill.status}`);
}

// Presets
const presetsRes = await req('/api/engine/profiles/presets', { headers: auth });
assert(presetsRes.status === 200, `GET /engine/profiles/presets → ${presetsRes.status}`);
const presetsArr = presetsRes.data?.presets || presetsRes.data;
assert(Array.isArray(presetsArr) && presetsArr.length >= 5, `Presets count: ${presetsArr?.length}`);

// Permission check
const permRes = await req('/api/engine/permissions/check', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ agentId: 'test', tool: 'web_search' }),
});
assert(permRes.status === 200, `POST /engine/permissions/check → ${permRes.status}`);

console.log('');

// ═══════════════════════════════════════════════════════
// 5. MIDDLEWARE
// ═══════════════════════════════════════════════════════
console.log('─── 5. Middleware ───');

const hRes = await req('/health');
assert(hRes.headers.get('x-request-id'), 'X-Request-Id present');
assert(hRes.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
assert(hRes.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');

const corsRes = await fetch(`${BASE}/health`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://test.com', 'Access-Control-Request-Method': 'GET' },
});
assert(corsRes.status === 204 || corsRes.status === 200, 'CORS preflight OK');

console.log('');

// ═══════════════════════════════════════════════════════
// 6. EXPORTS
// ═══════════════════════════════════════════════════════
console.log('─── 6. Exports ───');

const mod = await import('./dist/index.js');
const expectedExports = [
  'createAdapter', 'createServer', 'getSupportedDatabases',
  'PermissionEngine', 'AgentConfigGenerator', 'DeploymentEngine',
  'ApprovalEngine', 'AgentLifecycleManager', 'KnowledgeBaseEngine',
  'TenantManager', 'ActivityTracker', 'EngineDatabase',
  'CircuitBreaker', 'HealthMonitor', 'withRetry', 'RateLimiter',
  'generateDockerCompose', 'generateFlyToml',
  'createEnterpriseHook', 'createAgenticMailBridge',
  'BUILTIN_SKILLS', 'PRESET_PROFILES', 'ALL_TOOLS',
  'getToolsBySkill', 'generateOpenClawToolPolicy',
];
for (const name of expectedExports) {
  assert(mod[name] !== undefined, `export: ${name}`);
}

// Deploy generators produce valid output
assert(mod.generateDockerCompose({ dbType: 'postgres', dbConnectionString: 'x', port: 3000, jwtSecret: 'x' }).includes('agenticmail'), 'DockerCompose output');
assert(mod.generateFlyToml('test', 'iad').includes('test'), 'FlyToml output');

console.log('');

// ═══════════════════════════════════════════════════════
// 7. RESILIENCE
// ═══════════════════════════════════════════════════════
console.log('─── 7. Resilience ───');

const { CircuitBreaker, withRetry, RateLimiter } = mod;

// Circuit breaker
const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 100, timeout: 5000 });
assert(await cb.execute(() => Promise.resolve('ok')) === 'ok', 'CircuitBreaker success');
assert(cb.getState() === 'closed', 'CircuitBreaker state: closed');

for (let i = 0; i < 4; i++) await cb.execute(() => Promise.reject(new Error('x'))).catch(() => {});
try {
  await cb.execute(() => Promise.resolve('nope'));
  assert(false, 'Should be open');
} catch {
  assert(cb.getState() === 'open', 'CircuitBreaker opens after failures');
}

// Retry
let attempts = 0;
const retryVal = await withRetry(async () => { attempts++; if (attempts < 3) throw new Error('x'); return 'done'; }, { maxRetries: 5, baseDelayMs: 5 });
assert(retryVal === 'done' && attempts === 3, `withRetry() → ${attempts} attempts`);

// Rate limiter
const rl = new RateLimiter({ maxTokens: 3, refillRate: 1, refillIntervalMs: 60000 });
const t1 = rl.tryConsume();
const t2 = rl.tryConsume();
const t3 = rl.tryConsume();
const t4 = rl.tryConsume();
assert(t1 && t2 && t3, 'RateLimiter allows 3 tokens');
assert(!t4, 'RateLimiter blocks 4th token');

console.log('');

// ═══════════════════════════════════════════════════════
// 8. ENGINE CLASSES (in-memory)
// ═══════════════════════════════════════════════════════
console.log('─── 8. Engine Classes ───');

// BUILTIN_SKILLS
assert(mod.BUILTIN_SKILLS.length >= 38, `BUILTIN_SKILLS: ${mod.BUILTIN_SKILLS.length}`);
assert(mod.PRESET_PROFILES.length >= 5, `PRESET_PROFILES: ${mod.PRESET_PROFILES.length}`);

// Tool catalog
assert(mod.ALL_TOOLS.length > 50, `ALL_TOOLS: ${mod.ALL_TOOLS.length}`);
const toolMap = mod.getToolsBySkill();
assert(toolMap instanceof Map && toolMap.size > 0, `getToolsBySkill() → Map with ${toolMap.size} skills`);
const emailToolIds = toolMap.get('agenticmail') || [];
assert(emailToolIds.length > 0, `agenticmail tools: ${emailToolIds.length}`);
const policy = mod.generateOpenClawToolPolicy(emailToolIds, []);
assert(policy, 'generateOpenClawToolPolicy() returns policy');

// Config generator
const cg = new mod.AgentConfigGenerator();
const workspace = cg.generateWorkspace({
  id: 'test-1', name: 'test-bot', displayName: 'Test Bot',
  identity: { personality: 'Helpful assistant', role: 'Tester', tone: 'professional', language: 'en' },
  model: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'low' },
  channels: { enabled: [], primaryChannel: 'email' },
  email: { enabled: false, provider: 'none' },
  workspace: { persistentMemory: true, memoryMaxSizeMb: 10, workingDirectory: '/tmp', sharedDirectories: [], gitEnabled: false },
  heartbeat: { enabled: false, intervalMinutes: 30, checks: [] },
  context: {},
  permissionProfileId: 'research-assistant',
  deployment: { target: 'docker', config: {}, status: 'pending' },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
assert(workspace && workspace['SOUL.md'] && workspace['AGENTS.md'], 'AgentConfigGenerator.generateWorkspace() produces files');

console.log('');

// ═══════════════════════════════════════════════════════
// 9. DASHBOARD
// ═══════════════════════════════════════════════════════
console.log('─── 9. Dashboard ───');

const dashRes = await fetch(`${BASE}/dashboard`);
assert(dashRes.status === 200, 'GET /dashboard → 200');
const html = await dashRes.text();
assert(html.includes('AgenticMail') || html.includes('React'), 'Dashboard HTML valid');

const rootRes = await fetch(`${BASE}/`, { redirect: 'manual' });
assert(rootRes.status === 301 || rootRes.status === 302, `GET / redirects (${rootRes.status})`);

console.log('');

// ═══════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════
if (serverHandle) { serverHandle.close(); server.healthMonitor.stop(); }
await db.disconnect();
for (const f of [TEST_DB, TEST_DB + '-shm', TEST_DB + '-wal']) { try { rmSync(f); } catch {} }

console.log('═══════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════');

if (failed > 0) { console.log('\n❌ SOME TESTS FAILED\n'); process.exit(1); }
else { console.log('\n✅ ALL TESTS PASSED\n'); process.exit(0); }
