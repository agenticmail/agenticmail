// 🎀 AgenticMail Enterprise Dashboard — .NET / C# Edition
//
// Uses .NET 8+ Minimal API. No MVC, no Razor, no extra NuGet packages.
//
// Setup:
//   dotnet new web -n AgenticMailDashboard
//   cp Program.cs AgenticMailDashboard/Program.cs
//   cd AgenticMailDashboard && dotnet run
//
// Or create project in one shot:
//   mkdir AgenticMailDashboard && cd AgenticMailDashboard
//   dotnet new web
//   # Replace Program.cs with this file
//   dotnet run

using System.Net.Http.Json;
using System.Text.Json;
using System.Web;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(o => { o.IdleTimeout = TimeSpan.FromHours(24); o.Cookie.HttpOnly = true; });
builder.Services.AddHttpClient();

var app = builder.Build();
app.UseSession();

var API_URL = Environment.GetEnvironmentVariable("AGENTICMAIL_URL") ?? "http://localhost:3000";
var httpFactory = app.Services.GetRequiredService<IHttpClientFactory>();

// ─── API Client ─────────────────────────────────────────

async Task<JsonElement?> Api(HttpContext ctx, string path, string method = "GET", object? body = null)
{
    var client = httpFactory.CreateClient();
    client.Timeout = TimeSpan.FromSeconds(10);
    var token = ctx.Session.GetString("token");
    if (token != null) client.DefaultRequestHeaders.Add("Authorization", $"Bearer {token}");

    HttpResponseMessage resp;
    var uri = $"{API_URL}{path}";
    switch (method)
    {
        case "POST": resp = await client.PostAsJsonAsync(uri, body ?? new { }); break;
        case "PATCH": resp = await client.PatchAsJsonAsync(uri, body ?? new { }); break;
        case "DELETE": resp = await client.DeleteAsync(uri); break;
        default: resp = await client.GetAsync(uri); break;
    }
    var json = await resp.Content.ReadAsStringAsync();
    try { return JsonDocument.Parse(json).RootElement; }
    catch { return null; }
}

string Esc(string? s) => HttpUtility.HtmlEncode(s ?? "");
string Str(JsonElement? el, string prop) => el?.TryGetProperty(prop, out var v) == true ? v.ToString() : "";
int Int(JsonElement? el, string prop) => el?.TryGetProperty(prop, out var v) == true && v.TryGetInt32(out var n) ? n : 0;

string Badge(string status)
{
    var colors = new Dictionary<string, string>
    {
        ["active"] = "#22c55e", ["archived"] = "#888", ["suspended"] = "#ef4444",
        ["owner"] = "#f59e0b", ["admin"] = "#e84393", ["member"] = "#888", ["viewer"] = "#555"
    };
    var c = colors.GetValueOrDefault(status, "#888");
    return $"<span style='display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:{c}20;color:{c}'>{Esc(status)}</span>";
}

// ─── CSS & Layout ───────────────────────────────────────

const string CSS = @"*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sh{padding:20px;border-bottom:1px solid var(--border)}.sh h2{font-size:16px}.sh h2 em{font-style:normal;color:var(--primary)}.sh small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.on{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.btn-sm{padding:4px 10px;font-size:12px}.input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}.empty{text-align:center;padding:48px 20px;color:var(--muted)}select.input{appearance:auto}";

string NavItem(string href, string icon, string label, string page) =>
    $"<a href='{href}' class='{(page == label.ToLower() ? "on" : "")}'>{icon} <span>{label}</span></a>";

string Layout(string page, string userName, string userEmail, string content) => $@"<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'><title>🎀 AgenticMail Enterprise — .NET</title><style>{CSS}</style></head>
<body><div class='layout'>
<div class='sidebar'><div class='sh'><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · .NET</small></div>
<div class='nav'><div class='ns'>Overview</div>{NavItem("/", "📊", "Dashboard", page)}<div class='ns'>Manage</div>{NavItem("/agents", "🤖", "Agents", page)}{NavItem("/users", "👥", "Users", page)}{NavItem("/api-keys", "🔑", "API Keys", page)}<div class='ns'>System</div>{NavItem("/audit", "📋", "Audit", page)}{NavItem("/settings", "⚙️", "Settings", page)}</div>
<div class='sf'><div style='color:var(--dim)'>{Esc(userName)}</div><div style='color:var(--muted);font-size:11px'>{Esc(userEmail)}</div><a href='/logout' style='color:var(--muted);font-size:11px;margin-top:6px;display:inline-block'>Sign out</a></div></div>
<div class='content'>{content}</div></div></body></html>";

string Html(HttpContext ctx, string page, string content)
{
    var name = ctx.Session.GetString("userName") ?? "";
    var email = ctx.Session.GetString("userEmail") ?? "";
    return Layout(page, name, email, content);
}

// ─── Auth ───────────────────────────────────────────────

app.MapGet("/login", () => Results.Content($@"<!DOCTYPE html><html><head><meta charset='UTF-8'><title>AgenticMail</title><style>{CSS}</style></head>
<body style='display:flex;align-items:center;justify-content:center;min-height:100vh'>
<div style='width:380px'><h1 style='text-align:center;font-size:22px'>🏢 <em style='color:var(--primary)'>AgenticMail</em> Enterprise</h1>
<p style='text-align:center;color:var(--dim);font-size:13px;margin-bottom:32px'>Sign in · .NET Dashboard</p>
<form method='POST' action='/login'><div class='fg'><label class='fl'>Email</label><input class='input' type='email' name='email' required></div>
<div class='fg'><label class='fl'>Password</label><input class='input' type='password' name='password' required></div>
<button class='btn btn-p' style='width:100%' type='submit'>Sign In</button></form></div></body></html>", "text/html"));

app.MapPost("/login", async (HttpContext ctx) =>
{
    var form = await ctx.Request.ReadFormAsync();
    var data = await Api(ctx, "/auth/login", "POST", new { email = form["email"].ToString(), password = form["password"].ToString() });
    if (data?.TryGetProperty("token", out var tok) == true)
    {
        ctx.Session.SetString("token", tok.ToString());
        if (data?.TryGetProperty("user", out var u) == true)
        {
            ctx.Session.SetString("userName", Str(u, "name"));
            ctx.Session.SetString("userEmail", Str(u, "email"));
        }
        return Results.Redirect("/");
    }
    return Results.Content($"Login failed: {Str(data, "error")} <a href='/login'>Try again</a>", "text/html");
});

app.MapGet("/logout", (HttpContext ctx) => { ctx.Session.Clear(); return Results.Redirect("/login"); });

// ─── Auth Guard ─────────────────────────────────────────

app.Use(async (ctx, next) =>
{
    var path = ctx.Request.Path.Value ?? "";
    if (path != "/login" && !path.StartsWith("/login") && ctx.Session.GetString("token") == null)
    {
        ctx.Response.Redirect("/login");
        return;
    }
    await next();
});

// ─── Dashboard ──────────────────────────────────────────

app.MapGet("/", async (HttpContext ctx) =>
{
    var stats = await Api(ctx, "/api/stats");
    var audit = await Api(ctx, "/api/audit?limit=8");
    var events = "";
    if (audit?.TryGetProperty("events", out var evArr) == true)
    {
        foreach (var e in evArr.EnumerateArray())
            events += $"<div style='padding:10px 0;border-bottom:1px solid var(--border);font-size:13px'><span style='color:var(--primary);font-weight:500'>{Esc(Str(e, "action"))}</span> on {Esc(Str(e, "resource"))}<div style='font-size:11px;color:var(--muted)'>{Esc(Str(e, "timestamp"))}</div></div>";
    }
    if (string.IsNullOrEmpty(events)) events = "<div class='empty'><div style='font-size:36px;margin-bottom:10px'>📋</div>No activity yet</div>";

    return Results.Content(Html(ctx, "dashboard",
        $@"<h2 class='t'>Dashboard</h2><p class='desc'>Overview</p>
        <div class='stats'>
        <div class='stat'><div class='l'>Total Agents</div><div class='v' style='color:var(--primary)'>{Int(stats, "totalAgents")}</div></div>
        <div class='stat'><div class='l'>Active Agents</div><div class='v' style='color:var(--success)'>{Int(stats, "activeAgents")}</div></div>
        <div class='stat'><div class='l'>Users</div><div class='v'>{Int(stats, "totalUsers")}</div></div>
        <div class='stat'><div class='l'>Audit Events</div><div class='v'>{Int(stats, "totalAuditEvents")}</div></div></div>
        <div class='card'><div class='ct'>Recent Activity</div>{events}</div>"), "text/html");
});

// ─── Agents ─────────────────────────────────────────────

app.MapGet("/agents", async (HttpContext ctx) =>
{
    var data = await Api(ctx, "/api/agents");
    var rows = "";
    if (data?.TryGetProperty("agents", out var arr) == true)
    {
        foreach (var a in arr.EnumerateArray())
            rows += $"<tr><td style='font-weight:600'>{Esc(Str(a, "name"))}</td><td style='color:var(--dim)'>{Esc(Str(a, "email"))}</td><td>{Esc(Str(a, "role"))}</td><td>{Badge(Str(a, "status"))}</td></tr>";
    }
    var table = string.IsNullOrEmpty(rows) ? "<div class='empty'><div style='font-size:36px;margin-bottom:10px'>🤖</div>No agents yet</div>" :
        $"<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>{rows}</tbody></table>";

    return Results.Content(Html(ctx, "agents",
        $@"<h2 class='t'>Agents</h2><p class='desc'>Manage AI agent identities</p>
        <div class='card' style='margin-bottom:16px'><div class='ct'>Create Agent</div>
        <form method='POST' action='/agents' style='display:flex;gap:10px;align-items:end'>
        <div class='fg' style='flex:1;margin:0'><label class='fl'>Name</label><input class='input' name='name' required placeholder='e.g. researcher'></div>
        <div class='fg' style='margin:0'><label class='fl'>Role</label><select class='input' name='role'><option>assistant</option><option>researcher</option><option>writer</option></select></div>
        <button class='btn btn-p' type='submit'>Create</button></form></div>
        <div class='card'>{table}</div>"), "text/html");
});

app.MapPost("/agents", async (HttpContext ctx) =>
{
    var form = await ctx.Request.ReadFormAsync();
    await Api(ctx, "/api/agents", "POST", new { name = form["name"].ToString(), role = form["role"].ToString() });
    return Results.Redirect("/agents");
});

// ─── Users ──────────────────────────────────────────────

app.MapGet("/users", async (HttpContext ctx) =>
{
    var data = await Api(ctx, "/api/users");
    var rows = "";
    if (data?.TryGetProperty("users", out var arr) == true)
    {
        foreach (var u in arr.EnumerateArray())
            rows += $"<tr><td style='font-weight:600'>{Esc(Str(u, "name"))}</td><td style='color:var(--dim)'>{Esc(Str(u, "email"))}</td><td>{Badge(Str(u, "role"))}</td></tr>";
    }
    var table = string.IsNullOrEmpty(rows) ? "<div class='empty'><div style='font-size:36px;margin-bottom:10px'>👥</div>No users yet</div>" :
        $"<table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{rows}</tbody></table>";
    return Results.Content(Html(ctx, "users", $"<h2 class='t'>Users</h2><p class='desc'>Manage team members</p><div class='card'>{table}</div>"), "text/html");
});

// ─── API Keys ───────────────────────────────────────────

app.MapGet("/api-keys", async (HttpContext ctx) =>
{
    var data = await Api(ctx, "/api/api-keys");
    var rows = "";
    if (data?.TryGetProperty("keys", out var arr) == true)
    {
        foreach (var k in arr.EnumerateArray())
        {
            var status = k.TryGetProperty("revoked", out var rev) && rev.GetBoolean() ? "revoked" : "active";
            rows += $"<tr><td style='font-weight:600'>{Esc(Str(k, "name"))}</td><td><code style='font-size:12px'>{Esc(Str(k, "keyPrefix"))}...</code></td><td>{Badge(status)}</td></tr>";
        }
    }
    var table = string.IsNullOrEmpty(rows) ? "<div class='empty'><div style='font-size:36px;margin-bottom:10px'>🔑</div>No API keys</div>" :
        $"<table><thead><tr><th>Name</th><th>Key</th><th>Status</th></tr></thead><tbody>{rows}</tbody></table>";
    return Results.Content(Html(ctx, "api keys", $"<h2 class='t'>API Keys</h2><p class='desc'>Manage programmatic access</p><div class='card'>{table}</div>"), "text/html");
});

// ─── Audit ──────────────────────────────────────────────

app.MapGet("/audit", async (HttpContext ctx) =>
{
    var data = await Api(ctx, "/api/audit?limit=25");
    var total = Int(data, "total");
    var rows = "";
    if (data?.TryGetProperty("events", out var arr) == true)
    {
        foreach (var e in arr.EnumerateArray())
            rows += $"<tr><td style='font-size:12px;color:var(--muted)'>{Esc(Str(e, "timestamp"))}</td><td>{Esc(Str(e, "actor"))}</td><td style='color:var(--primary);font-weight:500'>{Esc(Str(e, "action"))}</td><td style='font-size:12px'>{Esc(Str(e, "resource"))}</td></tr>";
    }
    var table = string.IsNullOrEmpty(rows) ? "<div class='empty'><div style='font-size:36px;margin-bottom:10px'>📋</div>No audit events</div>" :
        $"<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead><tbody>{rows}</tbody></table>";
    return Results.Content(Html(ctx, "audit", $"<h2 class='t'>Audit Log</h2><p class='desc'>{total} events</p><div class='card'>{table}</div>"), "text/html");
});

// ─── Settings ───────────────────────────────────────────

app.MapGet("/settings", async (HttpContext ctx) =>
{
    var s = await Api(ctx, "/api/settings");
    return Results.Content(Html(ctx, "settings",
        $@"<h2 class='t'>Settings</h2><p class='desc'>Configure your organization</p>
        <div class='card'><div class='ct'>General</div><div style='font-size:13px'>
        Name: {Esc(Str(s, "name"))}<br>Domain: {Esc(Str(s, "domain"))}<br>
        Plan: {Badge(Str(s, "plan").ToUpper())}<br>
        Subdomain: {Esc(Str(s, "subdomain"))}.agenticmail.cloud</div></div>"), "text/html");
});

// ─── Start ──────────────────────────────────────────────

var port = Environment.GetEnvironmentVariable("PORT") ?? "5002";
app.Urls.Add($"http://localhost:{port}");

Console.WriteLine($"\n🏢 🎀 AgenticMail Enterprise Dashboard (.NET)");
Console.WriteLine($"   API:       {API_URL}");
Console.WriteLine($"   Dashboard: http://localhost:{port}\n");

app.Run();
