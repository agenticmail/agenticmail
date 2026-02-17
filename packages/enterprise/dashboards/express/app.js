/**
 * 🎀 AgenticMail Enterprise Dashboard — Express.js Edition
 *
 * Setup:
 *   npm install express express-session
 *   node app.js
 *
 * Or: AGENTICMAIL_URL=https://your-company.agenticmail.cloud node app.js
 */

const express = require('express');
const session = require('express-session');
const { randomUUID } = require('crypto');

const app = express();
const API_URL = process.env.AGENTICMAIL_URL || 'http://localhost:3000';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: randomUUID(), resave: false, saveUninitialized: false }));

// ─── API Client ─────────────────────────────────────────

async function api(path, token, method = 'GET', body) {
  const opts = {
    method, headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${API_URL}${path}`, opts);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Auth Middleware ─────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.token) return res.redirect('/login');
  next();
}

// ─── Shared Layout ──────────────────────────────────────

function page(p, user, content, flash) {
  const nav = (href, icon, label, key) =>
    `<a href="${href}" class="${p === key ? 'on' : ''}">${icon} <span>${label}</span></a>`;
  const flashHtml = flash ? `<div style="padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;background:rgba(34,197,94,0.1);border:1px solid #22c55e;color:#22c55e">${flash}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>🎀 AgenticMail Enterprise — Express</title>
<style>*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sh{padding:20px;border-bottom:1px solid var(--border)}.sh h2{font-size:16px}.sh h2 em{font-style:normal;color:var(--primary)}.sh small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.on{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600}.b-a{background:rgba(34,197,94,0.12);color:var(--success)}.b-r{background:rgba(136,136,160,0.1);color:var(--dim)}.empty{text-align:center;padding:48px 20px;color:var(--muted)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}</style></head>
<body><div class="layout">
<div class="sidebar"><div class="sh"><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · Express</small></div>
<div class="nav"><div class="ns">Overview</div>${nav('/', '📊', 'Dashboard', 'dashboard')}
<div class="ns">Manage</div>${nav('/agents', '🤖', 'Agents', 'agents')}${nav('/users', '👥', 'Users', 'users')}${nav('/api-keys', '🔑', 'API Keys', 'keys')}
<div class="ns">System</div>${nav('/audit', '📋', 'Audit Log', 'audit')}${nav('/settings', '⚙️', 'Settings', 'settings')}</div>
<div class="sf"><div style="color:var(--dim)">${esc(user?.name)}</div><div style="color:var(--muted);font-size:11px">${esc(user?.email)}</div><a href="/logout" style="color:var(--muted);font-size:11px;margin-top:6px;display:inline-block">Sign out</a></div></div>
<div class="content">${flashHtml}${content}</div></div></body></html>`;
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function badge(status) {
  const cls = ['active', 'owner', 'admin'].includes(status) ? 'b-a' : 'b-r';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ─── Routes ─────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AgenticMail</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f8f9fa;color:#212529;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{width:380px}h1{text-align:center;font-size:22px;margin-bottom:4px}h1 em{font-style:normal;color:#e84393}.sub{text-align:center;color:#868e96;font-size:13px;margin-bottom:32px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:#868e96;margin-bottom:4px}.input{width:100%;padding:10px 14px;background:#ffffff;border:1px solid #dee2e6;border-radius:8px;color:#212529;font-size:14px;outline:none}.input:focus{border-color:#e84393}.btn{width:100%;padding:10px;background:#e84393;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}</style></head><body><div class="box"><h1>🏢 <em>AgenticMail</em> Enterprise</h1><p class="sub">Sign in · Express Dashboard</p><form method="POST" action="/login"><div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required></div><div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required></div><button class="btn" type="submit">Sign In</button></form></div></body></html>`);
});

app.post('/login', async (req, res) => {
  const data = await api('/auth/login', null, 'POST', { email: req.body.email, password: req.body.password });
  if (data.token) { req.session.token = data.token; req.session.user = data.user; return res.redirect('/'); }
  res.send(`Login failed: ${data.error}`);
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/', requireAuth, async (req, res) => {
  const [stats, audit] = await Promise.all([api('/api/stats', req.session.token), api('/api/audit?limit=8', req.session.token)]);
  const events = (audit.events || []).map(e => `<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--primary);font-weight:500">${esc(e.action)}</span> on ${esc(e.resource)}<div style="font-size:11px;color:var(--muted)">${e.timestamp}</div></div>`).join('');
  res.send(page('dashboard', req.session.user,
    `<h2 class="t">Dashboard</h2><p class="desc">Overview</p>` +
    `<div class="stats"><div class="stat"><div class="l">Total Agents</div><div class="v" style="color:var(--primary)">${stats.totalAgents||0}</div></div><div class="stat"><div class="l">Active Agents</div><div class="v" style="color:var(--success)">${stats.activeAgents||0}</div></div><div class="stat"><div class="l">Users</div><div class="v">${stats.totalUsers||0}</div></div><div class="stat"><div class="l">Audit Events</div><div class="v">${stats.totalAuditEvents||0}</div></div></div>` +
    `<div class="card"><div class="ct">Recent Activity</div>${events || '<div class="empty">No activity yet</div>'}</div>`
  ));
});

app.get('/agents', requireAuth, async (req, res) => {
  const data = await api('/api/agents', req.session.token);
  const agents = data.agents || [];
  const rows = agents.map(a => `<tr><td style="font-weight:600">${esc(a.name)}</td><td style="color:var(--dim)">${esc(a.email)}</td><td>${a.role}</td><td>${badge(a.status)}</td></tr>`).join('');
  res.send(page('agents', req.session.user,
    `<h2 class="t">Agents</h2><p class="desc">Manage AI agent identities</p>` +
    `<div class="card">${agents.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">🤖 No agents yet</div>'}</div>`
  ));
});

app.get('/users', requireAuth, async (req, res) => {
  const data = await api('/api/users', req.session.token);
  const users = data.users || [];
  const rows = users.map(u => `<tr><td style="font-weight:600">${esc(u.name)}</td><td style="color:var(--dim)">${esc(u.email)}</td><td>${badge(u.role)}</td></tr>`).join('');
  res.send(page('users', req.session.user,
    `<h2 class="t">Users</h2><p class="desc">Manage team members</p>` +
    `<div class="card">${users.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">👥 No users yet</div>'}</div>`
  ));
});

app.get('/api-keys', requireAuth, async (req, res) => {
  const data = await api('/api/api-keys', req.session.token);
  const keys = data.keys || [];
  const rows = keys.map(k => `<tr><td style="font-weight:600">${esc(k.name)}</td><td><code style="font-size:12px">${k.keyPrefix}...</code></td><td>${badge(k.revoked ? 'revoked' : 'active')}</td></tr>`).join('');
  res.send(page('keys', req.session.user,
    `<h2 class="t">API Keys</h2><p class="desc">Manage programmatic access</p>` +
    `<div class="card">${keys.length ? `<table><thead><tr><th>Name</th><th>Key</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">🔑 No API keys</div>'}</div>`
  ));
});

app.get('/audit', requireAuth, async (req, res) => {
  const p = Math.max(0, parseInt(req.query.p) || 0);
  const data = await api(`/api/audit?limit=25&offset=${p*25}`, req.session.token);
  const events = data.events || [];
  const rows = events.map(e => `<tr><td style="font-size:12px;color:var(--muted)">${e.timestamp}</td><td>${esc(e.actor)}</td><td style="color:var(--primary);font-weight:500">${esc(e.action)}</td><td style="font-size:12px">${esc(e.resource)}</td></tr>`).join('');
  res.send(page('audit', req.session.user,
    `<h2 class="t">Audit Log</h2><p class="desc">${data.total||0} events</p>` +
    `<div class="card">${events.length ? `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">📋 No events</div>'}</div>`
  ));
});

app.get('/settings', requireAuth, async (req, res) => {
  const s = await api('/api/settings', req.session.token);
  res.send(page('settings', req.session.user,
    `<h2 class="t">Settings</h2><p class="desc">Configure your organization</p>` +
    `<div class="card"><div class="ct">General</div><div style="font-size:13px">Name: ${esc(s.name)}<br>Domain: ${esc(s.domain)}<br>Plan: ${badge((s.plan||'free').toUpperCase())}<br>Subdomain: ${esc(s.subdomain)}.agenticmail.cloud</div></div>`
  ));
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`\n🏢 🎀 AgenticMail Enterprise Dashboard (Express.js)`);
  console.log(`   API:       ${API_URL}`);
  console.log(`   Dashboard: http://localhost:${PORT}\n`);
});
