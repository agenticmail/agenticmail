"""
🎀 AgenticMail Enterprise Dashboard — Python/Flask Edition

Setup:
    pip install flask requests
    python app.py

Or with environment variable:
    AGENTICMAIL_URL=https://your-company.agenticmail.cloud python app.py
"""

import os, requests
from flask import Flask, render_template_string, request, session, redirect, url_for, flash
from functools import wraps

app = Flask(__name__)
app.secret_key = os.urandom(32)
API_URL = os.getenv('AGENTICMAIL_URL', 'http://localhost:3000')

# ─── API Client ──────────────────────────────────────────

def api(path, method='GET', json=None):
    headers = {'Content-Type': 'application/json'}
    token = session.get('token')
    if token:
        headers['Authorization'] = f'Bearer {token}'
    try:
        r = requests.request(method, f'{API_URL}{path}', headers=headers, json=json, timeout=10)
        return r.json()
    except Exception as e:
        return {'error': str(e)}

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'token' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

# ─── Routes ──────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        data = api('/auth/login', 'POST', {
            'email': request.form['email'],
            'password': request.form['password'],
        })
        if 'token' in data:
            session['token'] = data['token']
            session['user'] = data['user']
            return redirect(url_for('dashboard'))
        error = data.get('error', 'Login failed')
    return render_template_string(LOGIN_TEMPLATE, error=error, api_url=API_URL)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def dashboard():
    stats = api('/api/stats')
    audit = api('/api/audit?limit=8')
    return render_page('dashboard', stats=stats, audit=audit.get('events', []))

@app.route('/agents')
@login_required
def agents():
    data = api('/api/agents')
    return render_page('agents', agents=data.get('agents', []))

@app.route('/agents/create', methods=['POST'])
@login_required
def create_agent():
    body = {'name': request.form['name'], 'role': request.form.get('role', 'assistant')}
    if request.form.get('email'):
        body['email'] = request.form['email']
    result = api('/api/agents', 'POST', body)
    flash('Agent created!' if 'id' in result else result.get('error', 'Failed'))
    return redirect(url_for('agents'))

@app.route('/agents/<id>/archive', methods=['POST'])
@login_required
def archive_agent(id):
    api(f'/api/agents/{id}/archive', 'POST')
    flash('Agent archived')
    return redirect(url_for('agents'))

@app.route('/users')
@login_required
def users():
    data = api('/api/users')
    return render_page('users', users=data.get('users', []))

@app.route('/users/create', methods=['POST'])
@login_required
def create_user():
    result = api('/api/users', 'POST', {
        'name': request.form['name'], 'email': request.form['email'],
        'role': request.form.get('role', 'member'), 'password': request.form['password'],
    })
    flash('User created!' if 'id' in result else result.get('error', 'Failed'))
    return redirect(url_for('users'))

@app.route('/api-keys')
@login_required
def api_keys():
    data = api('/api/api-keys')
    return render_page('api_keys', keys=data.get('keys', []))

@app.route('/api-keys/create', methods=['POST'])
@login_required
def create_api_key():
    result = api('/api/api-keys', 'POST', {'name': request.form['name']})
    if 'plaintext' in result:
        flash(f"Key created: {result['plaintext']} — SAVE THIS NOW!")
    else:
        flash(result.get('error', 'Failed'))
    return redirect(url_for('api_keys'))

@app.route('/api-keys/<id>/revoke', methods=['POST'])
@login_required
def revoke_api_key(id):
    api(f'/api/api-keys/{id}', 'DELETE')
    flash('Key revoked')
    return redirect(url_for('api_keys'))

@app.route('/audit')
@login_required
def audit():
    page = max(0, int(request.args.get('p', 0)))
    data = api(f'/api/audit?limit=25&offset={page * 25}')
    return render_page('audit', events=data.get('events', []), total=data.get('total', 0), page=page)

@app.route('/settings', methods=['GET', 'POST'])
@login_required
def settings():
    if request.method == 'POST':
        result = api('/api/settings', 'PATCH', {
            'name': request.form.get('name', ''),
            'domain': request.form.get('domain', ''),
            'primaryColor': request.form.get('primaryColor', '#e84393'),
        })
        flash('Settings saved!' if 'error' not in result else result['error'])
    settings_data = api('/api/settings')
    retention = api('/api/retention')
    return render_page('settings', settings=settings_data, retention=retention)

# ─── Template Rendering ──────────────────────────────────

def render_page(page, **kwargs):
    return render_template_string(
        APP_TEMPLATE,
        page=page,
        user=session.get('user', {}),
        flashes=request.args.get('_flash'),
        **kwargs,
    )

# ─── Templates ───────────────────────────────────────────

LOGIN_TEMPLATE = '''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🎀 AgenticMail Enterprise</title>
<style>*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh}.box{width:380px;max-width:90vw}h1{text-align:center;font-size:22px;margin-bottom:4px}h1 em{font-style:normal;color:var(--primary)}.sub{text-align:center;color:var(--dim);font-size:13px;margin-bottom:32px}.err{background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:var(--danger)}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}.input{width:100%;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;outline:none}.input:focus{border-color:var(--primary)}.btn{width:100%;padding:10px;background:var(--primary);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}.btn:hover{background:#f06595}.info{text-align:center;margin-top:16px;font-size:11px;color:var(--muted)}</style></head>
<body><div class="box"><h1>🏢 <em>AgenticMail</em> Enterprise</h1><p class="sub">Sign in · Python Dashboard</p>
{% if error %}<div class="err">{{ error }}</div>{% endif %}
<form method="POST"><div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required autofocus></div>
<div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required></div>
<button class="btn" type="submit">Sign In</button></form>
<p class="info">Connected to: {{ api_url }}</p></div></body></html>'''

APP_TEMPLATE = '''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🎀 AgenticMail Enterprise — Python</title>
<style>*{box-sizing:border-box;margin:0;padding:0}:root{--bg:#f8f9fa;--surface:#ffffff;--border:#dee2e6;--text:#212529;--dim:#868e96;--muted:#adb5bd;--primary:#e84393;--success:#22c55e;--danger:#ef4444;--warning:#f59e0b}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sidebar-h{padding:20px;border-bottom:1px solid var(--border)}.sidebar-h h2{font-size:16px}.sidebar-h h2 em{font-style:normal;color:var(--primary)}.sidebar-h small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.active{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}tr:hover td{background:rgba(255,255,255,0.015)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn:hover{background:rgba(255,255,255,0.05)}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.btn-p:hover{background:#f06595}.btn-d{color:var(--danger);border-color:var(--danger)}.btn-sm{padding:4px 10px;font-size:12px}.input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;outline:none}.input:focus{border-color:var(--primary)}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px;font-weight:500}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600}.b-active{background:rgba(34,197,94,0.12);color:var(--success)}.b-archived{background:rgba(136,136,160,0.1);color:var(--dim)}.b-owner{background:rgba(245,158,11,0.12);color:var(--warning)}.b-admin{background:rgba(232,67,147,0.12);color:var(--primary)}.b-member{background:rgba(136,136,160,0.08);color:var(--dim)}.empty{text-align:center;padding:48px 20px;color:var(--muted)}.empty-i{font-size:36px;margin-bottom:10px}.flash{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;background:rgba(34,197,94,0.1);border:1px solid var(--success);color:var(--success)}</style></head>
<body><div class="layout">
<div class="sidebar"><div class="sidebar-h"><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · Python</small></div>
<div class="nav"><div class="ns">Overview</div>
<a href="/" class="{{ 'active' if page=='dashboard' }}">📊 Dashboard</a>
<div class="ns">Manage</div>
<a href="/agents" class="{{ 'active' if page=='agents' }}">🤖 Agents</a>
<a href="/users" class="{{ 'active' if page=='users' }}">👥 Users</a>
<a href="/api-keys" class="{{ 'active' if page=='api_keys' }}">🔑 API Keys</a>
<div class="ns">System</div>
<a href="/audit" class="{{ 'active' if page=='audit' }}">📋 Audit Log</a>
<a href="/settings" class="{{ 'active' if page=='settings' }}">⚙️ Settings</a></div>
<div class="sf"><div style="color:var(--dim)">{{ user.name }}</div><div style="color:var(--muted);font-size:11px">{{ user.email }}</div><a href="/logout" style="color:var(--muted);font-size:11px;margin-top:6px;display:inline-block">Sign out</a></div></div>
<div class="content">
{% with messages = get_flashed_messages() %}{% if messages %}{% for m in messages %}<div class="flash">{{ m }}</div>{% endfor %}{% endif %}{% endwith %}

{% if page == 'dashboard' %}
<h2 class="t">Dashboard</h2><p class="desc">Overview of your AgenticMail instance</p>
<div class="stats">
<div class="stat"><div class="l">Total Agents</div><div class="v" style="color:var(--primary)">{{ stats.totalAgents|default(0) }}</div></div>
<div class="stat"><div class="l">Active Agents</div><div class="v" style="color:var(--success)">{{ stats.activeAgents|default(0) }}</div></div>
<div class="stat"><div class="l">Users</div><div class="v">{{ stats.totalUsers|default(0) }}</div></div>
<div class="stat"><div class="l">Audit Events</div><div class="v">{{ stats.totalAuditEvents|default(0) }}</div></div></div>
<div class="card"><div class="ct">Recent Activity</div>
{% if audit %}{% for e in audit %}<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--primary);font-weight:500">{{ e.action }}</span> on {{ e.resource }}<div style="font-size:11px;color:var(--muted)">{{ e.timestamp }}{{ ' · ' + e.ip if e.ip else '' }}</div></div>{% endfor %}
{% else %}<div class="empty"><div class="empty-i">📋</div>No activity yet</div>{% endif %}</div>

{% elif page == 'agents' %}
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px"><div><h2 class="t">Agents</h2><p class="desc" style="margin:0">Manage AI agent identities</p></div></div>
<div class="card" style="margin-bottom:16px"><div class="ct">Create Agent</div>
<form method="POST" action="/agents/create" style="display:flex;gap:10px;align-items:end">
<div class="fg" style="flex:1;margin:0"><label class="fl">Name</label><input class="input" name="name" required placeholder="e.g. researcher"></div>
<div class="fg" style="margin:0"><label class="fl">Role</label><select class="input" name="role"><option>assistant</option><option>researcher</option><option>writer</option><option>secretary</option></select></div>
<button class="btn btn-p" type="submit">Create</button></form></div>
<div class="card">{% if agents %}<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
{% for a in agents %}<tr><td style="font-weight:600">{{ a.name }}</td><td style="color:var(--dim)">{{ a.email }}</td><td>{{ a.role }}</td><td><span class="badge b-{{ a.status }}">{{ a.status }}</span></td><td>{% if a.status == 'active' %}<form method="POST" action="/agents/{{ a.id }}/archive" style="display:inline"><button class="btn btn-sm btn-d" type="submit">Archive</button></form>{% endif %}</td></tr>{% endfor %}
</tbody></table>{% else %}<div class="empty"><div class="empty-i">🤖</div>No agents yet</div>{% endif %}</div>

{% elif page == 'users' %}
<h2 class="t">Users</h2><p class="desc">Manage team members</p>
<div class="card" style="margin-bottom:16px"><div class="ct">Create User</div>
<form method="POST" action="/users/create" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
<div class="fg"><label class="fl">Name</label><input class="input" name="name" required></div>
<div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required></div>
<div class="fg"><label class="fl">Role</label><select class="input" name="role"><option>member</option><option>admin</option><option>owner</option></select></div>
<div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required minlength="8"></div>
<div><button class="btn btn-p" type="submit">Create</button></div></form></div>
<div class="card">{% if users %}<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th></tr></thead><tbody>
{% for u in users %}<tr><td style="font-weight:600">{{ u.name }}</td><td style="color:var(--dim)">{{ u.email }}</td><td><span class="badge b-{{ u.role }}">{{ u.role }}</span></td><td style="color:var(--muted);font-size:12px">{{ u.lastLoginAt or 'Never' }}</td></tr>{% endfor %}
</tbody></table>{% else %}<div class="empty"><div class="empty-i">👥</div>No users yet</div>{% endif %}</div>

{% elif page == 'api_keys' %}
<h2 class="t">API Keys</h2><p class="desc">Manage programmatic access</p>
<div class="card" style="margin-bottom:16px"><div class="ct">Create Key</div>
<form method="POST" action="/api-keys/create" style="display:flex;gap:10px;align-items:end">
<div class="fg" style="flex:1;margin:0"><label class="fl">Key Name</label><input class="input" name="name" required placeholder="e.g. CI/CD pipeline"></div>
<button class="btn btn-p" type="submit">Create</button></form></div>
<div class="card">{% if keys %}<table><thead><tr><th>Name</th><th>Key</th><th>Last Used</th><th>Status</th><th></th></tr></thead><tbody>
{% for k in keys %}<tr><td style="font-weight:600">{{ k.name }}</td><td><code style="font-size:12px">{{ k.keyPrefix }}...</code></td><td style="color:var(--muted);font-size:12px">{{ k.lastUsedAt or 'Never' }}</td><td><span class="badge {{ 'b-archived' if k.revoked else 'b-active' }}">{{ 'revoked' if k.revoked else 'active' }}</span></td><td>{% if not k.revoked %}<form method="POST" action="/api-keys/{{ k.id }}/revoke" style="display:inline"><button class="btn btn-sm btn-d" type="submit">Revoke</button></form>{% endif %}</td></tr>{% endfor %}
</tbody></table>{% else %}<div class="empty"><div class="empty-i">🔑</div>No API keys</div>{% endif %}</div>

{% elif page == 'audit' %}
<h2 class="t">Audit Log</h2><p class="desc">{{ total }} total events</p>
<div class="card">{% if events %}<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead><tbody>
{% for e in events %}<tr><td style="font-size:12px;color:var(--muted)">{{ e.timestamp }}</td><td>{{ e.actor }}</td><td style="color:var(--primary);font-weight:500">{{ e.action }}</td><td style="font-size:12px">{{ e.resource }}</td><td style="font-size:12px;color:var(--muted)">{{ e.ip or '-' }}</td></tr>{% endfor %}
</tbody></table>
<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
{% if page_num > 0 %}<a class="btn btn-sm" href="/audit?p={{ page_num - 1 }}">← Prev</a>{% endif %}
<span style="padding:6px 12px;font-size:12px;color:var(--muted)">Page {{ page_num + 1 }}</span>
{% if (page_num + 1) * 25 < total %}<a class="btn btn-sm" href="/audit?p={{ page_num + 1 }}">Next →</a>{% endif %}
</div>{% else %}<div class="empty"><div class="empty-i">📋</div>No audit events yet</div>{% endif %}</div>

{% elif page == 'settings' %}
<h2 class="t">Settings</h2><p class="desc">Configure your organization</p>
<div class="card"><div class="ct">General</div>
<form method="POST" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
<div class="fg"><label class="fl">Organization Name</label><input class="input" name="name" value="{{ settings.name|default('') }}"></div>
<div class="fg"><label class="fl">Domain</label><input class="input" name="domain" value="{{ settings.domain|default('') }}" placeholder="agents.acme.com"></div>
<div class="fg"><label class="fl">Primary Color</label><input class="input" type="color" name="primaryColor" value="{{ settings.primaryColor|default('#e84393') }}" style="height:38px;padding:4px"></div>
<div></div><div><button class="btn btn-p" type="submit">Save Settings</button></div></form></div>
<div class="card"><div class="ct">Plan</div><span class="badge b-active" style="font-size:14px;padding:4px 12px">{{ (settings.plan or 'free')|upper }}</span>
<span style="font-size:13px;color:var(--dim);margin-left:12px">Subdomain: {{ settings.subdomain|default('not set') }}.agenticmail.cloud</span></div>
{% if retention %}<div class="card"><div class="ct">Data Retention</div><div style="font-size:13px">
Status: <span style="color:{{ 'var(--success)' if retention.enabled else 'var(--muted)' }}">{{ 'Enabled' if retention.enabled else 'Disabled' }}</span><br>
<span style="color:var(--dim)">Retain emails for {{ retention.retainDays|default(365) }} days</span></div></div>{% endif %}
{% endif %}

</div></div></body></html>'''

if __name__ == '__main__':
    print(f'\n🏢 🎀 AgenticMail Enterprise Dashboard (Python/Flask)')
    print(f'   API:       {API_URL}')
    print(f'   Dashboard: http://localhost:5000\n')
    app.run(debug=True, port=5000)
