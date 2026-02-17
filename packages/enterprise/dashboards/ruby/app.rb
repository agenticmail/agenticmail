# 🎀 AgenticMail Enterprise Dashboard — Ruby/Sinatra Edition
#
# Setup:
#   gem install sinatra json
#   ruby app.rb
#
# Or: AGENTICMAIL_URL=https://your-company.agenticmail.cloud ruby app.rb

require 'sinatra'
require 'json'
require 'net/http'
require 'uri'
require 'securerandom'

enable :sessions
set :session_secret, SecureRandom.hex(32)
set :port, 4567

API_URL = ENV['AGENTICMAIL_URL'] || 'http://localhost:3000'

# ─── API Client ──────────────────────────────────────────

def api(path, method: :get, body: nil)
  uri = URI("#{API_URL}#{path}")
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == 'https'
  http.open_timeout = 5
  http.read_timeout = 10

  req = case method
        when :get    then Net::HTTP::Get.new(uri)
        when :post   then Net::HTTP::Post.new(uri)
        when :patch  then Net::HTTP::Patch.new(uri)
        when :delete then Net::HTTP::Delete.new(uri)
        end

  req['Content-Type'] = 'application/json'
  req['Authorization'] = "Bearer #{session[:token]}" if session[:token]
  req.body = body.to_json if body

  resp = http.request(req)
  JSON.parse(resp.body) rescue { 'error' => 'Invalid response' }
rescue => e
  { 'error' => e.message }
end

def badge(status)
  colors = { 'active' => '#22c55e', 'archived' => '#888', 'suspended' => '#ef4444',
             'owner' => '#f59e0b', 'admin' => '#e84393', 'member' => '#888', 'viewer' => '#555' }
  c = colors[status.to_s] || '#888'
  "<span style='display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:#{c}20;color:#{c}'>#{status}</span>"
end

# ─── Shared Layout ───────────────────────────────────────

def layout(page, &block)
  user = session[:user] || {}
  content = yield
  erb_str = <<~HTML
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>🎀 AgenticMail Enterprise — Ruby</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sh{padding:20px;border-bottom:1px solid var(--border)}.sh h2{font-size:16px}.sh h2 em{font-style:normal;color:var(--primary)}.sh small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.on{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}tr:hover td{background:rgba(255,255,255,0.015)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn:hover{background:rgba(255,255,255,0.05)}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.btn-d{color:var(--danger);border-color:var(--danger)}.btn-sm{padding:4px 10px;font-size:12px}.input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}.empty{text-align:center;padding:48px 20px;color:var(--muted)}.flash{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;background:rgba(34,197,94,0.1);border:1px solid var(--success);color:var(--success)}</style></head>
    <body><div class="layout">
    <div class="sidebar"><div class="sh"><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · Ruby</small></div>
    <div class="nav"><div class="ns">Overview</div><a href="/" class="#{page == 'dashboard' ? 'on' : ''}">📊 Dashboard</a>
    <div class="ns">Manage</div><a href="/agents" class="#{page == 'agents' ? 'on' : ''}">🤖 Agents</a>
    <a href="/users" class="#{page == 'users' ? 'on' : ''}">👥 Users</a><a href="/api-keys" class="#{page == 'keys' ? 'on' : ''}">🔑 API Keys</a>
    <div class="ns">System</div><a href="/audit" class="#{page == 'audit' ? 'on' : ''}">📋 Audit Log</a>
    <a href="/settings" class="#{page == 'settings' ? 'on' : ''}">⚙️ Settings</a></div>
    <div class="sf"><div style="color:var(--dim)">#{Rack::Utils.escape_html(user['name'].to_s)}</div><div style="color:var(--muted);font-size:11px">#{Rack::Utils.escape_html(user['email'].to_s)}</div><a href="/logout" style="color:var(--muted);font-size:11px;margin-top:6px;display:inline-block">Sign out</a></div></div>
    <div class="content">#{content}</div></div></body></html>
  HTML
  erb_str
end

# ─── Auth ────────────────────────────────────────────────

before do
  pass if ['/login', '/logout'].include?(request.path_info)
  redirect '/login' unless session[:token]
end

get '/login' do
  <<~HTML
    <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>🎀 AgenticMail Enterprise</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f8f9fa;color:#212529;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{width:380px}h1{text-align:center;font-size:22px;margin-bottom:4px}h1 em{font-style:normal;color:#e84393}.sub{text-align:center;color:#868e96;font-size:13px;margin-bottom:32px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:#868e96;margin-bottom:4px}.input{width:100%;padding:10px 14px;background:#ffffff;border:1px solid #dee2e6;border-radius:8px;color:#212529;font-size:14px;outline:none}.input:focus{border-color:#e84393}.btn{width:100%;padding:10px;background:#e84393;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}</style></head>
    <body><div class="box"><h1>🏢 <em>AgenticMail</em> Enterprise</h1><p class="sub">Sign in · Ruby Dashboard</p>
    <form method="POST" action="/login"><div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required></div>
    <div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required></div>
    <button class="btn" type="submit">Sign In</button></form></div></body></html>
  HTML
end

post '/login' do
  data = api('/auth/login', method: :post, body: { email: params[:email], password: params[:password] })
  if data['token']
    session[:token] = data['token']
    session[:user] = data['user']
    redirect '/'
  else
    "Login failed: #{data['error']}"
  end
end

get '/logout' do
  session.clear
  redirect '/login'
end

# ─── Pages ───────────────────────────────────────────────

get '/' do
  stats = api('/api/stats')
  audit = api('/api/audit?limit=8')
  events = (audit['events'] || []).map { |e|
    "<div style='padding:10px 0;border-bottom:1px solid var(--border);font-size:13px'><span style='color:var(--primary);font-weight:500'>#{Rack::Utils.escape_html(e['action'])}</span> on #{Rack::Utils.escape_html(e['resource'])}<div style='font-size:11px;color:var(--muted)'>#{e['timestamp']}</div></div>"
  }.join

  layout('dashboard') {
    "<h2 class='t'>Dashboard</h2><p class='desc'>Overview</p>" +
    "<div class='stats'><div class='stat'><div class='l'>Total Agents</div><div class='v' style='color:var(--primary)'>#{stats['totalAgents']}</div></div>" +
    "<div class='stat'><div class='l'>Active Agents</div><div class='v' style='color:var(--success)'>#{stats['activeAgents']}</div></div>" +
    "<div class='stat'><div class='l'>Users</div><div class='v'>#{stats['totalUsers']}</div></div>" +
    "<div class='stat'><div class='l'>Audit Events</div><div class='v'>#{stats['totalAuditEvents']}</div></div></div>" +
    "<div class='card'><div class='ct'>Recent Activity</div>#{events.empty? ? "<div class='empty'>No activity yet</div>" : events}</div>"
  }
end

get '/agents' do
  data = api('/api/agents')
  agents = data['agents'] || []
  rows = agents.map { |a|
    "<tr><td style='font-weight:600'>#{Rack::Utils.escape_html(a['name'])}</td><td style='color:var(--dim)'>#{Rack::Utils.escape_html(a['email'])}</td><td>#{a['role']}</td><td>#{badge(a['status'])}</td><td>#{a['status'] == 'active' ? "<a class='btn btn-sm btn-d' href='/agents/#{a['id']}/archive'>Archive</a>" : ''}</td></tr>"
  }.join
  layout('agents') {
    "<h2 class='t'>Agents</h2><p class='desc'>Manage AI agent identities</p>" +
    "<div class='card'>#{agents.empty? ? "<div class='empty'>🤖 No agents yet</div>" : "<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>#{rows}</tbody></table>"}</div>"
  }
end

get '/agents/:id/archive' do
  api("/api/agents/#{params[:id]}/archive", method: :post)
  redirect '/agents'
end

get '/users' do
  data = api('/api/users')
  users = data['users'] || []
  rows = users.map { |u|
    "<tr><td style='font-weight:600'>#{Rack::Utils.escape_html(u['name'])}</td><td style='color:var(--dim)'>#{Rack::Utils.escape_html(u['email'])}</td><td>#{badge(u['role'])}</td><td style='color:var(--muted);font-size:12px'>#{u['lastLoginAt'] || 'Never'}</td></tr>"
  }.join
  layout('users') {
    "<h2 class='t'>Users</h2><p class='desc'>Manage team members</p>" +
    "<div class='card'>#{users.empty? ? "<div class='empty'>👥 No users yet</div>" : "<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th></tr></thead><tbody>#{rows}</tbody></table>"}</div>"
  }
end

get '/api-keys' do
  data = api('/api/api-keys')
  keys = data['keys'] || []
  rows = keys.map { |k|
    "<tr><td style='font-weight:600'>#{Rack::Utils.escape_html(k['name'])}</td><td><code style='font-size:12px'>#{k['keyPrefix']}...</code></td><td style='color:var(--muted);font-size:12px'>#{k['lastUsedAt'] || 'Never'}</td><td>#{badge(k['revoked'] ? 'archived' : 'active')}</td></tr>"
  }.join
  layout('keys') {
    "<h2 class='t'>API Keys</h2><p class='desc'>Manage programmatic access</p>" +
    "<div class='card'>#{keys.empty? ? "<div class='empty'>🔑 No API keys</div>" : "<table><thead><tr><th>Name</th><th>Key</th><th>Last Used</th><th>Status</th></tr></thead><tbody>#{rows}</tbody></table>"}</div>"
  }
end

get '/audit' do
  p = [0, (params[:p] || 0).to_i].max
  data = api("/api/audit?limit=25&offset=#{p * 25}")
  events = data['events'] || []
  total = data['total'] || 0
  rows = events.map { |e|
    "<tr><td style='font-size:12px;color:var(--muted)'>#{e['timestamp']}</td><td>#{Rack::Utils.escape_html(e['actor'])}</td><td style='color:var(--primary);font-weight:500'>#{Rack::Utils.escape_html(e['action'])}</td><td style='font-size:12px'>#{Rack::Utils.escape_html(e['resource'])}</td><td style='font-size:12px;color:var(--muted)'>#{e['ip'] || '-'}</td></tr>"
  }.join
  layout('audit') {
    "<h2 class='t'>Audit Log</h2><p class='desc'>#{total} total events</p>" +
    "<div class='card'>#{events.empty? ? "<div class='empty'>📋 No audit events</div>" : "<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead><tbody>#{rows}</tbody></table>"}</div>"
  }
end

get '/settings' do
  s = api('/api/settings')
  layout('settings') {
    "<h2 class='t'>Settings</h2><p class='desc'>Configure your organization</p>" +
    "<div class='card'><div class='ct'>General</div><div style='font-size:13px'>Name: #{Rack::Utils.escape_html(s['name'].to_s)}<br>Domain: #{Rack::Utils.escape_html(s['domain'].to_s)}<br>Plan: #{badge((s['plan'] || 'free').upcase)}</div></div>"
  }
end

puts "\n🏢 🎀 AgenticMail Enterprise Dashboard (Ruby/Sinatra)"
puts "   API:       #{API_URL}"
puts "   Dashboard: http://localhost:4567\n"
