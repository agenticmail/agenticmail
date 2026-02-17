/**
 * Live end-to-end test — starts server, runs all HTTP tests, shuts down.
 */
import { createAdapter, createServer } from './dist/index.js';
import { randomUUID } from 'crypto';

const PORT = 3201;
const BASE = `http://localhost:${PORT}`;

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.error(`  ❌ ${name}`); } }

// ─── Setup ────────────────────────────────────
const db = await createAdapter({ type: 'sqlite', connectionString: ':memory:' });
await db.migrate();
const user = await db.createUser({ email: 'ope@agenticmail.io', name: 'Ope', role: 'owner', password: 'Test1234!' });
await db.updateSettings({ name: 'AgenticMail', subdomain: 'agenticmail', domain: 'agenticmail.io' });
const apiKey = (await db.createApiKey({ name: 'k', createdBy: user.id, scopes: ['read','write','admin'] })).plaintext;

const jwtSecret = randomUUID() + randomUUID();
const server = createServer({ port: PORT, db, jwtSecret, logging: false, rateLimit: 500 });
const handle = await server.start();

console.log('\n🏢 Live E2E Test — Enterprise Server on :' + PORT + '\n');

// ─── 1. Health ────────────────────────────────
console.log('─── Health & Ready ───');
const health = await req('/health');
ok(health.status === 200 && health.data?.status === 'ok', `GET /health → ${health.data?.status}`);
ok(health.data?.version === '0.3.0', `Version: ${health.data?.version}`);

const ready = await req('/ready');
ok(ready.status === 200, `GET /ready → ${ready.status}`);

// ─── 2. Auth ──────────────────────────────────
console.log('\n─── Auth ───');
const login = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ope@agenticmail.io', password: 'Test1234!' }) });
ok(login.status === 200 && login.data?.token, 'Login → JWT token');
const jwt = login.data?.token;

const badLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ope@agenticmail.io', password: 'wrong' }) });
ok(badLogin.status === 401, 'Bad password → 401');

const noAuth = await req('/api/stats');
ok(noAuth.status === 401, 'No auth → 401');

const keyAuth = await req('/api/stats', { headers: { 'X-API-Key': apiKey } });
ok(keyAuth.status === 200, 'API key auth → 200');

const badKey = await req('/api/stats', { headers: { 'X-API-Key': 'ek_fake' } });
ok(badKey.status === 401, 'Bad API key → 401');

const auth = { Authorization: `Bearer ${jwt}` };

// ─── 3. Admin ─────────────────────────────────
console.log('\n─── Admin API ───');
const stats = await req('/api/stats', { headers: auth });
ok(stats.status === 200 && stats.data, `Stats: ${JSON.stringify(stats.data).slice(0, 80)}`);

// Create agent
const createAgent = await req('/api/agents', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'support-bot', email: 'support@agenticmail.io', role: 'customer-support' }) });
ok(createAgent.status === 201, `Create agent → ${createAgent.status} (${createAgent.data?.name})`);
const agentId = createAgent.data?.id;

// List agents
const agents = await req('/api/agents', { headers: auth });
ok(agents.data?.agents?.length >= 1, `List agents → ${agents.data?.agents?.length}`);

// Get agent
const getAgent = await req(`/api/agents/${agentId}`, { headers: auth });
ok(getAgent.status === 200 && getAgent.data?.name === 'support-bot', 'Get agent by ID');

// Update agent
const updateAgent = await req(`/api/agents/${agentId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ role: 'lead-support' }) });
ok(updateAgent.status === 200 && updateAgent.data?.role === 'lead-support', 'Update agent role');

// Create second agent
const agent2 = await req('/api/agents', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'research-bot', email: 'research@agenticmail.io', role: 'researcher' }) });
ok(agent2.status === 201, `Create second agent: ${agent2.data?.name}`);

// Users
const users = await req('/api/users', { headers: auth });
ok(users.status === 200, `List users → ${users.status}`);

// Audit log
const audit = await req('/api/audit', { headers: auth });
ok(audit.status === 200 && audit.data?.events?.length > 0, `Audit log → ${audit.data?.events?.length} events`);

// Settings
const settings = await req('/api/settings', { headers: auth });
ok(settings.status === 200 && settings.data?.name === 'AgenticMail', `Settings: ${settings.data?.name}`);

const patchSettings = await req('/api/settings', { method: 'PATCH', headers: auth, body: JSON.stringify({ name: 'AgenticMail Inc' }) });
ok(patchSettings.status === 200 && patchSettings.data?.name === 'AgenticMail Inc', 'Patch settings');

// Delete agent
const delAgent = await req(`/api/agents/${agent2.data?.id}`, { method: 'DELETE', headers: auth });
ok(delAgent.status === 200 || delAgent.status === 204, 'Delete agent');

// ─── 4. Engine ────────────────────────────────
console.log('\n─── Engine API ───');
const skills = await req('/api/engine/skills', { headers: auth });
ok(skills.status === 200, `Skills endpoint → ${skills.status}`);
const skillList = skills.data?.skills || skills.data || [];
ok(skillList.length >= 38, `${skillList.length} skills loaded`);

// Single skill
if (skillList.length) {
  const s = await req(`/api/engine/skills/${skillList[0].id}`, { headers: auth });
  ok(s.status === 200, `Get skill: ${s.data?.name || skillList[0].id}`);
}

// Presets
const presets = await req('/api/engine/profiles/presets', { headers: auth });
ok(presets.status === 200, 'Presets endpoint');
const presetList = presets.data?.presets || presets.data || [];
ok(presetList.length >= 5, `${presetList.length} presets`);

// Permission check
const permCheck = await req('/api/engine/permissions/check', { method: 'POST', headers: auth, body: JSON.stringify({ agentId: 'test', tool: 'web_search' }) });
ok(permCheck.status === 200, `Permission check → ${permCheck.status}`);

// Skills by category
const byCategory = await req('/api/engine/skills/by-category', { headers: auth });
ok(byCategory.status === 200, 'Skills by category');

// ─── 5. Dashboard ─────────────────────────────
console.log('\n─── Dashboard ───');
const dash = await fetch(`${BASE}/dashboard`);
ok(dash.status === 200, 'Dashboard serves');
const html = await dash.text();
ok(html.length > 1000 && html.includes('AgenticMail'), `Dashboard HTML: ${html.length} chars`);

const root = await fetch(`${BASE}/`, { redirect: 'manual' });
ok(root.status === 302, 'Root → /dashboard redirect');

// ─── 6. Security ──────────────────────────────
console.log('\n─── Security ───');
const secRes = await req('/health');
ok(secRes.headers.get('x-request-id'), 'X-Request-Id header');
ok(secRes.headers.get('x-content-type-options') === 'nosniff', 'nosniff header');
ok(secRes.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');

// 404 (outside /api so no auth wall)
const notFound = await req('/nonexistent-path');
ok(notFound.status === 404, '404 for unknown path');

// ─── Done ─────────────────────────────────────
handle.close();
server.healthMonitor.stop();
await db.disconnect();

console.log(`\n═══════════════════════════════════════`);
console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total`);
console.log(`═══════════════════════════════════════`);
console.log(fail === 0 ? '\n✅ ALL LIVE TESTS PASSED\n' : '\n❌ SOME TESTS FAILED\n');
process.exit(fail > 0 ? 1 : 0);
