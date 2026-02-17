// 🎀 AgenticMail Enterprise Dashboard — Go Edition
//
// ZERO dependencies beyond the standard library. No frameworks.
//
// Setup:
//   go run main.go
//
// Or:
//   AGENTICMAIL_URL=https://your-company.agenticmail.cloud go run main.go

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var apiURL = "http://localhost:3000"

// ─── Session Store (in-memory) ──────────────────────────

type Session struct {
	Token string
	User  map[string]interface{}
}

var (
	sessions = map[string]*Session{}
	sessMu   sync.RWMutex
)

func getSession(r *http.Request) *Session {
	c, err := r.Cookie("am_session")
	if err != nil {
		return nil
	}
	sessMu.RLock()
	defer sessMu.RUnlock()
	return sessions[c.Value]
}

func setSession(w http.ResponseWriter, s *Session) string {
	id := fmt.Sprintf("%d", time.Now().UnixNano())
	sessMu.Lock()
	sessions[id] = s
	sessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "am_session", Value: id, Path: "/", HttpOnly: true, MaxAge: 86400})
	return id
}

func clearSession(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie("am_session")
	if err == nil {
		sessMu.Lock()
		delete(sessions, c.Value)
		sessMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "am_session", Value: "", Path: "/", MaxAge: -1})
}

// ─── API Client ─────────────────────────────────────────

func apiCall(path, method, token string, body interface{}) (map[string]interface{}, error) {
	var reqBody io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, apiURL+path, reqBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}

// ─── Helpers ────────────────────────────────────────────

func esc(s interface{}) string {
	if s == nil {
		return ""
	}
	return html.EscapeString(fmt.Sprintf("%v", s))
}

func badge(status string) string {
	colors := map[string]string{
		"active": "#22c55e", "archived": "#888", "suspended": "#ef4444",
		"owner": "#f59e0b", "admin": "#e84393", "member": "#888", "viewer": "#555",
	}
	c := colors[status]
	if c == "" {
		c = "#888"
	}
	return fmt.Sprintf(`<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:%s20;color:%s">%s</span>`, c, c, esc(status))
}

func intVal(m map[string]interface{}, key string) int {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		}
	}
	return 0
}

func strVal(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

// ─── Layout ─────────────────────────────────────────────

func layout(page string, user map[string]interface{}, content string) string {
	navItem := func(href, icon, label, key string) string {
		cls := ""
		if page == key {
			cls = " on"
		}
		return fmt.Sprintf(`<a href="%s" class="%s">%s <span>%s</span></a>`, href, cls, icon, label)
	}

	userName := ""
	userEmail := ""
	if user != nil {
		userName = strVal(user, "name")
		userEmail = strVal(user, "email")
	}

	return fmt.Sprintf(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🎀 AgenticMail Enterprise — Go</title>
<style>*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sh{padding:20px;border-bottom:1px solid var(--border)}.sh h2{font-size:16px}.sh h2 em{font-style:normal;color:var(--primary)}.sh small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.on{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}tr:hover td{background:rgba(255,255,255,0.015)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn:hover{background:rgba(255,255,255,0.05)}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.btn-d{color:var(--danger);border-color:var(--danger)}.btn-sm{padding:4px 10px;font-size:12px}.input{width:100%%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}.empty{text-align:center;padding:48px 20px;color:var(--muted)}.empty-i{font-size:36px;margin-bottom:10px}select.input{appearance:auto}@media(max-width:768px){.sidebar{width:56px}.sh h2,.sh small,.nav a span,.ns,.sf{display:none}.nav a{justify-content:center;padding:14px 0;font-size:18px}.content{margin-left:56px;padding:16px}}</style></head>
<body><div class="layout">
<div class="sidebar"><div class="sh"><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · Go</small></div>
<div class="nav"><div class="ns">Overview</div>%s
<div class="ns">Manage</div>%s%s%s
<div class="ns">System</div>%s%s</div>
<div class="sf"><div style="color:var(--dim)">%s</div><div style="color:var(--muted);font-size:11px">%s</div><a href="/logout" style="color:var(--muted);font-size:11px;margin-top:6px;display:inline-block">Sign out</a></div></div>
<div class="content">%s</div></div></body></html>`,
		navItem("/", "📊", "Dashboard", "dashboard"),
		navItem("/agents", "🤖", "Agents", "agents"),
		navItem("/users", "👥", "Users", "users"),
		navItem("/api-keys", "🔑", "API Keys", "keys"),
		navItem("/audit", "📋", "Audit Log", "audit"),
		navItem("/settings", "⚙️", "Settings", "settings"),
		esc(userName), esc(userEmail), content)
}

func loginPage() string {
	return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>🎀 AgenticMail Enterprise</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f8f9fa;color:#212529;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{width:380px}h1{text-align:center;font-size:22px;margin-bottom:4px}h1 em{font-style:normal;color:#e84393}.sub{text-align:center;color:#868e96;font-size:13px;margin-bottom:32px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:#868e96;margin-bottom:4px}.input{width:100%;padding:10px 14px;background:#ffffff;border:1px solid #dee2e6;border-radius:8px;color:#212529;font-size:14px;outline:none}.input:focus{border-color:#e84393}.btn{width:100%;padding:10px;background:#e84393;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}.btn:hover{background:#f06595}</style></head>
<body><div class="box"><h1>🏢 <em>AgenticMail</em> Enterprise</h1><p class="sub">Sign in · Go Dashboard</p>
<form method="POST" action="/login"><div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required autofocus></div>
<div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required></div>
<button class="btn" type="submit">Sign In</button></form></div></body></html>`
}

// ─── Handlers ───────────────────────────────────────────

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if getSession(r) == nil {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		next(w, r)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, loginPage())
		return
	}
	r.ParseForm()
	data, err := apiCall("/auth/login", "POST", "", map[string]string{
		"email": r.FormValue("email"), "password": r.FormValue("password"),
	})
	if err != nil || data["token"] == nil {
		errMsg := "Login failed"
		if data != nil && data["error"] != nil {
			errMsg = fmt.Sprintf("%v", data["error"])
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<html><body style="background:#f8f9fa;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><div>%s <a href="/login" style="color:#e84393">Try again</a></div></body></html>`, esc(errMsg))
		return
	}
	user, _ := data["user"].(map[string]interface{})
	setSession(w, &Session{Token: fmt.Sprintf("%v", data["token"]), User: user})
	http.Redirect(w, r, "/", http.StatusFound)
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	clearSession(w, r)
	http.Redirect(w, r, "/login", http.StatusFound)
}

func handleDashboard(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)
	stats, _ := apiCall("/api/stats", "GET", s.Token, nil)
	audit, _ := apiCall("/api/audit?limit=8", "GET", s.Token, nil)

	var eventsHTML string
	if events, ok := audit["events"].([]interface{}); ok && len(events) > 0 {
		for _, ev := range events {
			e := ev.(map[string]interface{})
			eventsHTML += fmt.Sprintf(`<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--primary);font-weight:500">%s</span> on %s<div style="font-size:11px;color:var(--muted)">%s</div></div>`,
				esc(e["action"]), esc(e["resource"]), esc(e["timestamp"]))
		}
	} else {
		eventsHTML = `<div class="empty"><div class="empty-i">📋</div>No activity yet</div>`
	}

	if stats == nil {
		stats = map[string]interface{}{}
	}

	content := fmt.Sprintf(`<h2 class="t">Dashboard</h2><p class="desc">Overview of your AgenticMail instance</p>
<div class="stats">
<div class="stat"><div class="l">Total Agents</div><div class="v" style="color:var(--primary)">%d</div></div>
<div class="stat"><div class="l">Active Agents</div><div class="v" style="color:var(--success)">%d</div></div>
<div class="stat"><div class="l">Users</div><div class="v">%d</div></div>
<div class="stat"><div class="l">Audit Events</div><div class="v">%d</div></div></div>
<div class="card"><div class="ct">Recent Activity</div>%s</div>`,
		intVal(stats, "totalAgents"), intVal(stats, "activeAgents"),
		intVal(stats, "totalUsers"), intVal(stats, "totalAuditEvents"), eventsHTML)

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("dashboard", s.User, content))
}

func handleAgents(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)

	// Handle archive
	if strings.Contains(r.URL.Path, "/archive") {
		parts := strings.Split(r.URL.Path, "/")
		if len(parts) >= 3 {
			apiCall("/api/agents/"+parts[2]+"/archive", "POST", s.Token, nil)
		}
		http.Redirect(w, r, "/agents", http.StatusFound)
		return
	}

	// Handle create
	if r.Method == "POST" {
		r.ParseForm()
		body := map[string]string{"name": r.FormValue("name"), "role": r.FormValue("role")}
		if email := r.FormValue("email"); email != "" {
			body["email"] = email
		}
		apiCall("/api/agents", "POST", s.Token, body)
		http.Redirect(w, r, "/agents", http.StatusFound)
		return
	}

	data, _ := apiCall("/api/agents", "GET", s.Token, nil)
	var tableHTML string
	if agents, ok := data["agents"].([]interface{}); ok && len(agents) > 0 {
		rows := ""
		for _, ag := range agents {
			a := ag.(map[string]interface{})
			archiveBtn := ""
			if strVal(a, "status") == "active" {
				archiveBtn = fmt.Sprintf(`<a class="btn btn-sm btn-d" href="/agents/%s/archive">Archive</a>`, esc(a["id"]))
			}
			rows += fmt.Sprintf(`<tr><td style="font-weight:600">%s</td><td style="color:var(--dim)">%s</td><td>%s</td><td>%s</td><td>%s</td></tr>`,
				esc(a["name"]), esc(a["email"]), esc(a["role"]), badge(strVal(a, "status")), archiveBtn)
		}
		tableHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>` + rows + `</tbody></table>`
	} else {
		tableHTML = `<div class="empty"><div class="empty-i">🤖</div>No agents yet</div>`
	}

	content := fmt.Sprintf(`<h2 class="t">Agents</h2><p class="desc">Manage AI agent identities</p>
<div class="card" style="margin-bottom:16px"><div class="ct">Create Agent</div>
<form method="POST" action="/agents" style="display:flex;gap:10px;align-items:end">
<div class="fg" style="flex:1;margin:0"><label class="fl">Name</label><input class="input" name="name" required placeholder="e.g. researcher"></div>
<div class="fg" style="margin:0"><label class="fl">Role</label><select class="input" name="role"><option>assistant</option><option>researcher</option><option>writer</option><option>secretary</option></select></div>
<button class="btn btn-p" type="submit">Create</button></form></div>
<div class="card">%s</div>`, tableHTML)

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("agents", s.User, content))
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)

	if r.Method == "POST" {
		r.ParseForm()
		apiCall("/api/users", "POST", s.Token, map[string]string{
			"name": r.FormValue("name"), "email": r.FormValue("email"),
			"role": r.FormValue("role"), "password": r.FormValue("password"),
		})
		http.Redirect(w, r, "/users", http.StatusFound)
		return
	}

	data, _ := apiCall("/api/users", "GET", s.Token, nil)
	var tableHTML string
	if users, ok := data["users"].([]interface{}); ok && len(users) > 0 {
		rows := ""
		for _, us := range users {
			u := us.(map[string]interface{})
			lastLogin := "Never"
			if v := strVal(u, "lastLoginAt"); v != "" {
				lastLogin = v
			}
			rows += fmt.Sprintf(`<tr><td style="font-weight:600">%s</td><td style="color:var(--dim)">%s</td><td>%s</td><td style="color:var(--muted);font-size:12px">%s</td></tr>`,
				esc(u["name"]), esc(u["email"]), badge(strVal(u, "role")), esc(lastLogin))
		}
		tableHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th></tr></thead><tbody>` + rows + `</tbody></table>`
	} else {
		tableHTML = `<div class="empty"><div class="empty-i">👥</div>No users yet</div>`
	}

	content := fmt.Sprintf(`<h2 class="t">Users</h2><p class="desc">Manage team members</p>
<div class="card" style="margin-bottom:16px"><div class="ct">Create User</div>
<form method="POST" action="/users" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
<div class="fg"><label class="fl">Name</label><input class="input" name="name" required></div>
<div class="fg"><label class="fl">Email</label><input class="input" type="email" name="email" required></div>
<div class="fg"><label class="fl">Role</label><select class="input" name="role"><option>member</option><option>admin</option><option>owner</option></select></div>
<div class="fg"><label class="fl">Password</label><input class="input" type="password" name="password" required minlength="8"></div>
<div><button class="btn btn-p" type="submit">Create</button></div></form></div>
<div class="card">%s</div>`, tableHTML)

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("users", s.User, content))
}

func handleAPIKeys(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)
	data, _ := apiCall("/api/api-keys", "GET", s.Token, nil)
	var tableHTML string
	if keys, ok := data["keys"].([]interface{}); ok && len(keys) > 0 {
		rows := ""
		for _, ky := range keys {
			k := ky.(map[string]interface{})
			status := "active"
			if revoked, ok := k["revoked"].(bool); ok && revoked {
				status = "revoked"
			}
			lastUsed := "Never"
			if v := strVal(k, "lastUsedAt"); v != "" {
				lastUsed = v
			}
			rows += fmt.Sprintf(`<tr><td style="font-weight:600">%s</td><td><code style="font-size:12px">%s...</code></td><td style="color:var(--muted);font-size:12px">%s</td><td>%s</td></tr>`,
				esc(k["name"]), esc(k["keyPrefix"]), esc(lastUsed), badge(status))
		}
		tableHTML = `<table><thead><tr><th>Name</th><th>Key</th><th>Last Used</th><th>Status</th></tr></thead><tbody>` + rows + `</tbody></table>`
	} else {
		tableHTML = `<div class="empty"><div class="empty-i">🔑</div>No API keys</div>`
	}

	content := fmt.Sprintf(`<h2 class="t">API Keys</h2><p class="desc">Manage programmatic access</p><div class="card">%s</div>`, tableHTML)
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("keys", s.User, content))
}

func handleAudit(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)
	p := 0
	fmt.Sscanf(r.URL.Query().Get("p"), "%d", &p)
	if p < 0 {
		p = 0
	}

	data, _ := apiCall(fmt.Sprintf("/api/audit?limit=25&offset=%d", p*25), "GET", s.Token, nil)
	total := intVal(data, "total")
	var tableHTML string
	if events, ok := data["events"].([]interface{}); ok && len(events) > 0 {
		rows := ""
		for _, ev := range events {
			e := ev.(map[string]interface{})
			ip := strVal(e, "ip")
			if ip == "" {
				ip = "-"
			}
			rows += fmt.Sprintf(`<tr><td style="font-size:12px;color:var(--muted);white-space:nowrap">%s</td><td>%s</td><td style="color:var(--primary);font-weight:500">%s</td><td style="font-size:12px">%s</td><td style="font-size:12px;color:var(--muted)">%s</td></tr>`,
				esc(e["timestamp"]), esc(e["actor"]), esc(e["action"]), esc(e["resource"]), esc(ip))
		}
		pages := (total + 24) / 25
		nav := fmt.Sprintf(`<div style="display:flex;gap:8px;justify-content:center;margin-top:16px"><span style="padding:6px 12px;font-size:12px;color:var(--muted)">Page %d of %d</span></div>`, p+1, pages)
		if p > 0 {
			nav = fmt.Sprintf(`<div style="display:flex;gap:8px;justify-content:center;margin-top:16px"><a class="btn btn-sm" href="/audit?p=%d">← Prev</a><span style="padding:6px 12px;font-size:12px;color:var(--muted)">Page %d of %d</span>`, p-1, p+1, pages)
			if (p+1)*25 < total {
				nav += fmt.Sprintf(`<a class="btn btn-sm" href="/audit?p=%d">Next →</a>`, p+1)
			}
			nav += `</div>`
		} else if (p+1)*25 < total {
			nav = fmt.Sprintf(`<div style="display:flex;gap:8px;justify-content:center;margin-top:16px"><span style="padding:6px 12px;font-size:12px;color:var(--muted)">Page %d of %d</span><a class="btn btn-sm" href="/audit?p=%d">Next →</a></div>`, p+1, pages, p+1)
		}
		tableHTML = `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead><tbody>` + rows + `</tbody></table>` + nav
	} else {
		tableHTML = `<div class="empty"><div class="empty-i">📋</div>No audit events yet</div>`
	}

	content := fmt.Sprintf(`<h2 class="t">Audit Log</h2><p class="desc">%d total events</p><div class="card">%s</div>`, total, tableHTML)
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("audit", s.User, content))
}

func handleSettings(w http.ResponseWriter, r *http.Request) {
	s := getSession(r)

	if r.Method == "POST" {
		r.ParseForm()
		apiCall("/api/settings", "PATCH", s.Token, map[string]string{
			"name":         r.FormValue("name"),
			"domain":       r.FormValue("domain"),
			"primaryColor": r.FormValue("primaryColor"),
		})
		http.Redirect(w, r, "/settings", http.StatusFound)
		return
	}

	settings, _ := apiCall("/api/settings", "GET", s.Token, nil)
	retention, _ := apiCall("/api/retention", "GET", s.Token, nil)
	if settings == nil {
		settings = map[string]interface{}{}
	}
	if retention == nil {
		retention = map[string]interface{}{}
	}

	retEnabled := "Disabled"
	retColor := "var(--muted)"
	if enabled, ok := retention["enabled"].(bool); ok && enabled {
		retEnabled = "Enabled"
		retColor = "var(--success)"
	}
	retDays := intVal(retention, "retainDays")
	if retDays == 0 {
		retDays = 365
	}

	content := fmt.Sprintf(`<h2 class="t">Settings</h2><p class="desc">Configure your organization</p>
<div class="card"><div class="ct">General</div>
<form method="POST" action="/settings" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
<div class="fg"><label class="fl">Organization Name</label><input class="input" name="name" value="%s"></div>
<div class="fg"><label class="fl">Domain</label><input class="input" name="domain" value="%s" placeholder="agents.acme.com"></div>
<div class="fg"><label class="fl">Primary Color</label><input class="input" type="color" name="primaryColor" value="%s" style="height:38px;padding:4px"></div>
<div></div><div><button class="btn btn-p" type="submit">Save Settings</button></div></form></div>
<div class="card"><div class="ct">Plan</div>%s <span style="font-size:13px;color:var(--dim);margin-left:12px">Subdomain: %s.agenticmail.cloud</span></div>
<div class="card"><div class="ct">Data Retention</div><div style="font-size:13px">Status: <span style="color:%s">%s</span><br><span style="color:var(--dim)">Retain emails for %d days</span></div></div>`,
		esc(settings["name"]), esc(settings["domain"]),
		esc(settings["primaryColor"]),
		badge(strings.ToUpper(strVal(settings, "plan"))),
		esc(settings["subdomain"]),
		retColor, retEnabled, retDays)

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, layout("settings", s.User, content))
}

// ─── Main ───────────────────────────────────────────────

func main() {
	if url := os.Getenv("AGENTICMAIL_URL"); url != "" {
		apiURL = url
	}

	_ = template.New("") // ensure html/template is used

	http.HandleFunc("/login", handleLogin)
	http.HandleFunc("/logout", handleLogout)
	http.HandleFunc("/", requireAuth(handleDashboard))
	http.HandleFunc("/agents", requireAuth(handleAgents))
	http.HandleFunc("/agents/", requireAuth(handleAgents))
	http.HandleFunc("/users", requireAuth(handleUsers))
	http.HandleFunc("/api-keys", requireAuth(handleAPIKeys))
	http.HandleFunc("/audit", requireAuth(handleAudit))
	http.HandleFunc("/settings", requireAuth(handleSettings))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("\n🏢 🎀 AgenticMail Enterprise Dashboard (Go)\n")
	fmt.Printf("   API:       %s\n", apiURL)
	fmt.Printf("   Dashboard: http://localhost:%s\n\n", port)

	log.Fatal(http.ListenAndServe(":"+port, nil))
}
