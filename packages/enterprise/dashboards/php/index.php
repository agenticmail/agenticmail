<?php
/**
 * 🎀 AgenticMail Enterprise Dashboard — PHP Edition
 * 
 * ZERO dependencies. No Composer, no Laravel, no framework.
 * Just PHP 7.4+ and a web server.
 *
 * Setup:
 *   1. Edit $API_URL below
 *   2. Drop this file on any PHP web server (Apache, Nginx, XAMPP, MAMP)
 *   3. Open in browser
 *
 * Or run locally:
 *   php -S localhost:8080 index.php
 */

$API_URL = getenv('AGENTICMAIL_URL') ?: 'http://localhost:3000';

// ─── Session & Auth ─────────────────────────────────────
session_start();
$token = $_SESSION['am_token'] ?? null;
$user = $_SESSION['am_user'] ?? null;
$error = '';
$success = '';

// ─── API Helper ─────────────────────────────────────────
function am_api(string $path, string $method = 'GET', ?array $body = null): array {
    global $API_URL, $token;
    $opts = [
        'http' => [
            'method' => $method,
            'header' => "Content-Type: application/json\r\n" .
                        ($token ? "Authorization: Bearer $token\r\n" : ''),
            'timeout' => 10,
            'ignore_errors' => true,
        ],
    ];
    if ($body !== null) {
        $opts['http']['content'] = json_encode($body);
    }
    $ctx = stream_context_create($opts);
    $response = @file_get_contents($API_URL . $path, false, $ctx);
    if ($response === false) return ['error' => 'Could not connect to AgenticMail server'];
    return json_decode($response, true) ?: ['error' => 'Invalid response'];
}

// ─── Handle Actions ─────────────────────────────────────
$action = $_POST['action'] ?? $_GET['action'] ?? '';

if ($action === 'login') {
    $data = am_api('/auth/login', 'POST', [
        'email' => $_POST['email'] ?? '',
        'password' => $_POST['password'] ?? '',
    ]);
    if (isset($data['token'])) {
        $_SESSION['am_token'] = $data['token'];
        $_SESSION['am_user'] = $data['user'];
        $token = $data['token'];
        $user = $data['user'];
    } else {
        $error = $data['error'] ?? 'Login failed';
    }
}

if ($action === 'logout') {
    session_destroy();
    header('Location: ?');
    exit;
}

if ($action === 'create_agent' && $token) {
    $body = ['name' => $_POST['name'] ?? '', 'role' => $_POST['role'] ?? 'assistant'];
    if (!empty($_POST['email'])) $body['email'] = $_POST['email'];
    $result = am_api('/api/agents', 'POST', $body);
    $success = isset($result['id']) ? "Agent '{$body['name']}' created!" : ($result['error'] ?? 'Failed');
}

if ($action === 'archive_agent' && $token) {
    $id = $_GET['id'] ?? '';
    $result = am_api("/api/agents/$id/archive", 'POST');
    $success = ($result['ok'] ?? false) ? 'Agent archived' : ($result['error'] ?? 'Failed');
}

if ($action === 'create_user' && $token) {
    $result = am_api('/api/users', 'POST', [
        'name' => $_POST['name'] ?? '',
        'email' => $_POST['email'] ?? '',
        'role' => $_POST['role'] ?? 'member',
        'password' => $_POST['password'] ?? '',
    ]);
    $success = isset($result['id']) ? "User created!" : ($result['error'] ?? 'Failed');
}

if ($action === 'create_key' && $token) {
    $result = am_api('/api/api-keys', 'POST', ['name' => $_POST['name'] ?? '']);
    if (isset($result['plaintext'])) {
        $success = "Key created: " . $result['plaintext'] . " (SAVE THIS NOW)";
    } else {
        $error = $result['error'] ?? 'Failed';
    }
}

if ($action === 'revoke_key' && $token) {
    $id = $_GET['id'] ?? '';
    am_api("/api/api-keys/$id", 'DELETE');
    $success = 'Key revoked';
}

if ($action === 'save_settings' && $token) {
    $result = am_api('/api/settings', 'PATCH', [
        'name' => $_POST['name'] ?? '',
        'domain' => $_POST['domain'] ?? '',
        'primaryColor' => $_POST['primaryColor'] ?? '#e84393',
    ]);
    $success = isset($result['error']) ? $result['error'] : 'Settings saved!';
}

// ─── Load Data ──────────────────────────────────────────
$page = $_GET['page'] ?? 'dashboard';
$stats = $agents = $users = $keys = $audit = $settings = $retention = null;

if ($token) {
    if ($page === 'dashboard') {
        $stats = am_api('/api/stats');
        $audit = am_api('/api/audit?limit=8');
    } elseif ($page === 'agents') {
        $agents = am_api('/api/agents');
    } elseif ($page === 'users') {
        $users = am_api('/api/users');
    } elseif ($page === 'api-keys') {
        $keys = am_api('/api/api-keys');
    } elseif ($page === 'audit') {
        $p = max(0, (int)($_GET['p'] ?? 0));
        $audit = am_api("/api/audit?limit=25&offset=" . ($p * 25));
    } elseif ($page === 'settings') {
        $settings = am_api('/api/settings');
        $retention = am_api('/api/retention');
    }
}

function e(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
function badge(string $status): string {
    $colors = ['active'=>'#22c55e','archived'=>'#888','suspended'=>'#ef4444','owner'=>'#f59e0b','admin'=>'#e84393','member'=>'#888','viewer'=>'#555'];
    $c = $colors[$status] ?? '#888';
    return "<span style='display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:{$c}20;color:$c'>$status</span>";
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎀 AgenticMail Enterprise — PHP Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root,[data-theme="light"] { --bg:#f8f9fa; --surface:#fff; --border:#dee2e6; --text:#212529; --dim:#495057; --muted:#868e96; --primary:#e84393; --success:#2b8a3e; --danger:#c92a2a; --warning:#e67700; --r:6px; color-scheme:light dark; } [data-theme="dark"] { --bg:#0f1114; --surface:#16181d; --border:#2c3038; --text:#e1e4e8; --dim:#b0b8c4; --muted:#6b7280; --primary:#f06595; --success:#37b24d; --danger:#f03e3e; --warning:#f08c00; } @media(prefers-color-scheme:dark){ :root:not([data-theme="light"]){ --bg:#0f1114; --surface:#16181d; --border:#2c3038; --text:#e1e4e8; --dim:#b0b8c4; --muted:#6b7280; --primary:#f06595; --success:#37b24d; --danger:#f03e3e; --warning:#f08c00; }}
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .layout { display: flex; min-height: 100vh; }
    .sidebar { width: 240px; background: var(--surface); border-right: 1px solid var(--border); position: fixed; top: 0; left: 0; bottom: 0; display: flex; flex-direction: column; }
    .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border); }
    .sidebar-header h2 { font-size: 16px; } .sidebar-header h2 em { font-style:normal; color: var(--primary); }
    .sidebar-header small { font-size: 11px; color: var(--muted); display: block; margin-top: 2px; }
    .nav { flex: 1; padding: 8px 0; }
    .nav-sec { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); padding:12px 20px 4px; }
    .nav a { display:flex; align-items:center; gap:10px; padding:10px 20px; color:var(--dim); text-decoration:none; font-size:13px; }
    .nav a:hover { color:var(--text); background:rgba(255,255,255,0.03); }
    .nav a.active { color:var(--primary); background:rgba(232,67,147,0.12); border-right:2px solid var(--primary); }
    .sidebar-footer { padding:16px 20px; border-top:1px solid var(--border); font-size:12px; }
    .content { flex:1; margin-left:240px; padding:32px; max-width:1100px; }
    h2.title { font-size:22px; font-weight:700; margin-bottom:4px; }
    .desc { font-size:13px; color:var(--dim); margin-bottom:24px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:24px; }
    .stat { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px; }
    .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; }
    .stat .v { font-size:30px; font-weight:700; margin-top:4px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px; margin-bottom:16px; }
    .card-t { font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:0.05em; font-weight:600; margin-bottom:12px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th { text-align:left; padding:10px 12px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border); font-weight:600; }
    td { padding:12px; border-bottom:1px solid var(--border); }
    tr:hover td { background:rgba(255,255,255,0.015); }
    .btn { display:inline-flex; align-items:center; padding:8px 16px; border-radius:var(--r); font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--border); background:var(--surface); color:var(--text); text-decoration:none; }
    .btn:hover { background:rgba(255,255,255,0.05); }
    .btn-p { background:var(--primary); border-color:var(--primary); color:#fff; }
    .btn-p:hover { background:#f06595; }
    .btn-d { color:var(--danger); border-color:var(--danger); }
    .btn-sm { padding:4px 10px; font-size:12px; }
    .input { width:100%; padding:10px 14px; background:var(--bg); border:1px solid var(--border); border-radius:var(--r); color:var(--text); font-size:14px; }
    .input:focus { outline:none; border-color:var(--primary); }
    .fg { margin-bottom:14px; }
    .fl { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; font-weight:500; }
    .alert { padding:12px 16px; border-radius:var(--r); margin-bottom:16px; font-size:13px; }
    .alert-e { background:rgba(239,68,68,0.1); border:1px solid var(--danger); color:var(--danger); }
    .alert-s { background:rgba(34,197,94,0.1); border:1px solid var(--success); color:var(--success); }
    .empty { text-align:center; padding:48px 20px; color:var(--muted); }
    .empty-i { font-size:36px; margin-bottom:10px; }
    .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .login-box { width:380px; max-width:90vw; }
    .login-box h1 { text-align:center; font-size:22px; margin-bottom:4px; }
    .login-box h1 em { font-style:normal; color:var(--primary); }
    .login-box .sub { text-align:center; color:var(--dim); font-size:13px; margin-bottom:32px; }
    select.input { appearance:auto; }
    @media(max-width:768px) { .sidebar{width:56px;} .sidebar-header h2,.sidebar-header small,.nav a span,.nav-sec,.sidebar-footer{display:none;} .nav a{justify-content:center;padding:14px 0;font-size:18px;} .content{margin-left:56px;padding:16px;} }
  </style>
</head>
<body>

<?php if (!$token): ?>
<!-- ═══ Login ═══ -->
<div class="login-wrap">
  <div class="login-box">
    <h1>🏢 <em>AgenticMail</em> Enterprise</h1>
    <p class="sub">Sign in to your dashboard</p>
    <?php if ($error): ?><div class="alert alert-e"><?= e($error) ?></div><?php endif; ?>
    <form method="POST">
      <input type="hidden" name="action" value="login">
      <div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required autofocus></div>
      <div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required></div>
      <button class="btn btn-p" style="width:100%;justify-content:center" type="submit">Sign In</button>
    </form>
    <p style="text-align:center;margin-top:16px;font-size:11px;color:var(--muted)">Connected to: <?= e($API_URL) ?></p>
  </div>
</div>

<?php else: ?>
<!-- ═══ App ═══ -->
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-header">
      <h2>🏢 <em>Agentic</em>Mail</h2>
      <small>Enterprise · PHP</small>
    </div>
    <div class="nav">
      <div class="nav-sec">Overview</div>
      <a href="?page=dashboard" class="<?= $page === 'dashboard' ? 'active' : '' ?>">📊 <span>Dashboard</span></a>
      <div class="nav-sec">Manage</div>
      <a href="?page=agents" class="<?= $page === 'agents' ? 'active' : '' ?>">🤖 <span>Agents</span></a>
      <a href="?page=users" class="<?= $page === 'users' ? 'active' : '' ?>">👥 <span>Users</span></a>
      <a href="?page=api-keys" class="<?= $page === 'api-keys' ? 'active' : '' ?>">🔑 <span>API Keys</span></a>
      <div class="nav-sec">System</div>
      <a href="?page=audit" class="<?= $page === 'audit' ? 'active' : '' ?>">📋 <span>Audit Log</span></a>
      <a href="?page=settings" class="<?= $page === 'settings' ? 'active' : '' ?>">⚙️ <span>Settings</span></a>
    </div>
    <div class="sidebar-footer">
      <div style="color:var(--dim)"><?= e($user['name'] ?? '') ?></div>
      <div style="color:var(--muted);font-size:11px"><?= e($user['email'] ?? '') ?></div>
      <a href="?action=logout" style="color:var(--muted);font-size:11px;margin-top:6px;display:inline-block">Sign out</a>
    </div>
  </div>

  <div class="content">
    <?php if ($error): ?><div class="alert alert-e"><?= e($error) ?></div><?php endif; ?>
    <?php if ($success): ?><div class="alert alert-s"><?= e($success) ?></div><?php endif; ?>

    <?php if ($page === 'dashboard' && $stats): ?>
      <h2 class="title">Dashboard</h2>
      <p class="desc">Overview of your AgenticMail instance</p>
      <div class="stats">
        <div class="stat"><div class="l">Total Agents</div><div class="v" style="color:var(--primary)"><?= (int)($stats['totalAgents'] ?? 0) ?></div></div>
        <div class="stat"><div class="l">Active Agents</div><div class="v" style="color:var(--success)"><?= (int)($stats['activeAgents'] ?? 0) ?></div></div>
        <div class="stat"><div class="l">Users</div><div class="v"><?= (int)($stats['totalUsers'] ?? 0) ?></div></div>
        <div class="stat"><div class="l">Audit Events</div><div class="v"><?= (int)($stats['totalAuditEvents'] ?? 0) ?></div></div>
      </div>
      <div class="card">
        <div class="card-t">Recent Activity</div>
        <?php $events = $audit['events'] ?? []; if (empty($events)): ?>
          <div class="empty"><div class="empty-i">📋</div>No activity yet</div>
        <?php else: foreach ($events as $ev): ?>
          <div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">
            <span style="color:var(--primary);font-weight:500"><?= e($ev['action']) ?></span> on <?= e($ev['resource']) ?>
            <div style="font-size:11px;color:var(--muted)"><?= date('M j, Y g:i A', strtotime($ev['timestamp'])) ?><?= $ev['ip'] ? " · {$ev['ip']}" : '' ?></div>
          </div>
        <?php endforeach; endif; ?>
      </div>

    <?php elseif ($page === 'agents'): ?>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
        <div><h2 class="title">Agents</h2><p class="desc" style="margin:0">Manage AI agent identities</p></div>
        <button class="btn btn-p" onclick="document.getElementById('modal-agent').style.display='flex'">+ New Agent</button>
      </div>
      <div class="card">
        <?php $list = $agents['agents'] ?? []; if (empty($list)): ?>
          <div class="empty"><div class="empty-i">🤖</div>No agents yet</div>
        <?php else: ?>
          <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
          <?php foreach ($list as $a): ?>
            <tr><td style="font-weight:600"><?= e($a['name']) ?></td><td style="color:var(--dim)"><?= e($a['email']) ?></td><td><?= e($a['role']) ?></td><td><?= badge($a['status']) ?></td><td style="color:var(--muted);font-size:12px"><?= date('M j, Y', strtotime($a['createdAt'])) ?></td><td><?php if ($a['status'] === 'active'): ?><a class="btn btn-sm btn-d" href="?page=agents&action=archive_agent&id=<?= e($a['id']) ?>">Archive</a><?php endif; ?></td></tr>
          <?php endforeach; ?>
          </tbody></table>
        <?php endif; ?>
      </div>
      <!-- Modal -->
      <div id="modal-agent" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;z-index:100">
        <div class="card" style="width:440px;max-width:90vw">
          <h3 style="margin-bottom:16px">Create Agent</h3>
          <form method="POST"><input type="hidden" name="action" value="create_agent">
            <div class="fg"><label class="fl">Name</label><input class="input" name="name" required placeholder="e.g. researcher"></div>
            <div class="fg"><label class="fl">Email (optional)</label><input class="input" name="email" placeholder="auto-generated"></div>
            <div class="fg"><label class="fl">Role</label><select class="input" name="role"><option>assistant</option><option>secretary</option><option>researcher</option><option>writer</option><option>custom</option></select></div>
            <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" type="button" onclick="this.closest('[id]').style.display='none'">Cancel</button><button class="btn btn-p" type="submit">Create</button></div>
          </form>
        </div>
      </div>

    <?php elseif ($page === 'users'): ?>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
        <div><h2 class="title">Users</h2><p class="desc" style="margin:0">Manage team members</p></div>
        <button class="btn btn-p" onclick="document.getElementById('modal-user').style.display='flex'">+ New User</button>
      </div>
      <div class="card">
        <?php $list = $users['users'] ?? []; if (empty($list)): ?>
          <div class="empty"><div class="empty-i">👥</div>No users yet</div>
        <?php else: ?>
          <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th></tr></thead><tbody>
          <?php foreach ($list as $u2): ?>
            <tr><td style="font-weight:600"><?= e($u2['name']) ?></td><td style="color:var(--dim)"><?= e($u2['email']) ?></td><td><?= badge($u2['role']) ?></td><td style="color:var(--muted);font-size:12px"><?= isset($u2['lastLoginAt']) ? date('M j, Y g:i A', strtotime($u2['lastLoginAt'])) : 'Never' ?></td></tr>
          <?php endforeach; ?>
          </tbody></table>
        <?php endif; ?>
      </div>
      <div id="modal-user" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;z-index:100">
        <div class="card" style="width:440px;max-width:90vw">
          <h3 style="margin-bottom:16px">Create User</h3>
          <form method="POST"><input type="hidden" name="action" value="create_user">
            <div class="fg"><label class="fl">Name</label><input class="input" name="name" required></div>
            <div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required></div>
            <div class="fg"><label class="fl">Role</label><select class="input" name="role"><option>member</option><option>admin</option><option>owner</option><option>viewer</option></select></div>
            <div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required minlength="8"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" type="button" onclick="this.closest('[id]').style.display='none'">Cancel</button><button class="btn btn-p" type="submit">Create</button></div>
          </form>
        </div>
      </div>

    <?php elseif ($page === 'api-keys'): ?>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
        <div><h2 class="title">API Keys</h2><p class="desc" style="margin:0">Manage programmatic access</p></div>
        <button class="btn btn-p" onclick="document.getElementById('modal-key').style.display='flex'">+ New Key</button>
      </div>
      <div class="card">
        <?php $list = $keys['keys'] ?? []; if (empty($list)): ?>
          <div class="empty"><div class="empty-i">🔑</div>No API keys</div>
        <?php else: ?>
          <table><thead><tr><th>Name</th><th>Key</th><th>Last Used</th><th>Status</th><th></th></tr></thead><tbody>
          <?php foreach ($list as $k): ?>
            <tr><td style="font-weight:600"><?= e($k['name']) ?></td><td><code style="font-size:12px"><?= e($k['keyPrefix']) ?>...</code></td><td style="color:var(--muted);font-size:12px"><?= isset($k['lastUsedAt']) ? date('M j g:i A', strtotime($k['lastUsedAt'])) : 'Never' ?></td><td><?= badge($k['revoked'] ? 'archived' : 'active') ?></td><td><?php if (!($k['revoked'] ?? false)): ?><a class="btn btn-sm btn-d" href="?page=api-keys&action=revoke_key&id=<?= e($k['id']) ?>">Revoke</a><?php endif; ?></td></tr>
          <?php endforeach; ?>
          </tbody></table>
        <?php endif; ?>
      </div>
      <div id="modal-key" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;z-index:100">
        <div class="card" style="width:440px;max-width:90vw">
          <h3 style="margin-bottom:16px">Create API Key</h3>
          <form method="POST"><input type="hidden" name="action" value="create_key">
            <div class="fg"><label class="fl">Key Name</label><input class="input" name="name" required placeholder="e.g. CI/CD pipeline"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" type="button" onclick="this.closest('[id]').style.display='none'">Cancel</button><button class="btn btn-p" type="submit">Create</button></div>
          </form>
        </div>
      </div>

    <?php elseif ($page === 'audit'): ?>
      <?php $p = max(0, (int)($_GET['p'] ?? 0)); $total = $audit['total'] ?? 0; $pages = max(1, ceil($total / 25)); ?>
      <h2 class="title">Audit Log</h2>
      <p class="desc"><?= $total ?> total events</p>
      <div class="card">
        <?php $events = $audit['events'] ?? []; if (empty($events)): ?>
          <div class="empty"><div class="empty-i">📋</div>No audit events yet</div>
        <?php else: ?>
          <table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead><tbody>
          <?php foreach ($events as $ev): ?>
            <tr><td style="font-size:12px;color:var(--muted);white-space:nowrap"><?= date('M j g:i A', strtotime($ev['timestamp'])) ?></td><td><?= e($ev['actor']) ?></td><td style="color:var(--primary);font-weight:500"><?= e($ev['action']) ?></td><td style="font-size:12px"><?= e($ev['resource']) ?></td><td style="font-size:12px;color:var(--muted)"><?= $ev['ip'] ?: '-' ?></td></tr>
          <?php endforeach; ?>
          </tbody></table>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
            <?php if ($p > 0): ?><a class="btn btn-sm" href="?page=audit&p=<?= $p - 1 ?>">← Prev</a><?php endif; ?>
            <span style="padding:6px 12px;font-size:12px;color:var(--muted)">Page <?= $p + 1 ?> of <?= $pages ?></span>
            <?php if (($p + 1) * 25 < $total): ?><a class="btn btn-sm" href="?page=audit&p=<?= $p + 1 ?>">Next →</a><?php endif; ?>
          </div>
        <?php endif; ?>
      </div>

    <?php elseif ($page === 'settings' && $settings): ?>
      <h2 class="title">Settings</h2>
      <p class="desc">Configure your organization</p>
      <div class="card">
        <div class="card-t">General</div>
        <form method="POST" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <input type="hidden" name="action" value="save_settings">
          <div class="fg"><label class="fl">Organization Name</label><input class="input" name="name" value="<?= e($settings['name'] ?? '') ?>"></div>
          <div class="fg"><label class="fl">Domain</label><input class="input" name="domain" value="<?= e($settings['domain'] ?? '') ?>" placeholder="agents.acme.com"></div>
          <div class="fg"><label class="fl">Primary Color</label><input class="input" type="color" name="primaryColor" value="<?= e($settings['primaryColor'] ?? '#e84393') ?>" style="height:38px;padding:4px"></div>
          <div></div>
          <div><button class="btn btn-p" type="submit">Save Settings</button></div>
        </form>
      </div>
      <div class="card">
        <div class="card-t">Plan</div>
        <?= badge(strtoupper($settings['plan'] ?? 'free')) ?>
        <span style="font-size:13px;color:var(--dim);margin-left:12px">Subdomain: <?= e($settings['subdomain'] ?? 'not set') ?>.agenticmail.cloud</span>
      </div>
      <?php if ($retention): ?>
      <div class="card">
        <div class="card-t">Data Retention</div>
        <div style="font-size:13px">
          Status: <span style="color:<?= ($retention['enabled'] ?? false) ? 'var(--success)' : 'var(--muted)' ?>"><?= ($retention['enabled'] ?? false) ? 'Enabled' : 'Disabled' ?></span><br>
          <span style="color:var(--dim)">Retain emails for <?= (int)($retention['retainDays'] ?? 365) ?> days<?= ($retention['archiveFirst'] ?? true) ? ' (archive before delete)' : '' ?></span>
        </div>
      </div>
      <?php endif; ?>
    <?php endif; ?>
  </div>
</div>
<?php endif; ?>
</body>
</html>
