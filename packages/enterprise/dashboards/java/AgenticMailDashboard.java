/**
 * 🎀 AgenticMail Enterprise Dashboard — Java Edition
 * 
 * ZERO dependencies. Uses only JDK built-in classes (Java 11+).
 * No Spring, no Maven, no Gradle needed.
 *
 * Setup:
 *   javac AgenticMailDashboard.java
 *   java AgenticMailDashboard
 *
 * Or with env var:
 *   AGENTICMAIL_URL=https://your-company.agenticmail.cloud java AgenticMailDashboard
 *
 * Single-file, compiles and runs directly.
 */

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import java.util.stream.Collectors;

public class AgenticMailDashboard {
    
    static String API_URL = "http://localhost:3000";
    static final Map<String, Map<String, Object>> sessions = new ConcurrentHashMap<>();
    static final java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
        .connectTimeout(java.time.Duration.ofSeconds(10)).build();

    // ─── API Client ─────────────────────────────────────

    @SuppressWarnings("unchecked")
    static Map<String, Object> api(String path, String method, String token, String body) {
        try {
            var builder = HttpRequest.newBuilder()
                .uri(URI.create(API_URL + path))
                .header("Content-Type", "application/json")
                .timeout(java.time.Duration.ofSeconds(10));
            if (token != null) builder.header("Authorization", "Bearer " + token);
            
            switch (method) {
                case "POST":  builder.POST(HttpRequest.BodyPublishers.ofString(body != null ? body : "")); break;
                case "PATCH": builder.method("PATCH", HttpRequest.BodyPublishers.ofString(body != null ? body : "")); break;
                case "DELETE": builder.DELETE(); break;
                default:      builder.GET();
            }
            
            var resp = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return parseJson(resp.body());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    // ─── Minimal JSON Parser (no dependencies) ──────────

    @SuppressWarnings("unchecked")
    static Map<String, Object> parseJson(String json) {
        // Simple recursive descent parser for JSON objects
        try {
            return (Map<String, Object>) new JsonParser(json.trim()).parseValue();
        } catch (Exception e) {
            return Map.of("error", "Parse error: " + e.getMessage());
        }
    }

    static String toJson(Map<String, String> map) {
        return "{" + map.entrySet().stream()
            .map(e -> "\"" + e.getKey() + "\":\"" + e.getValue().replace("\"", "\\\"") + "\"")
            .collect(Collectors.joining(",")) + "}";
    }

    // Minimal JSON parser
    static class JsonParser {
        String s; int pos;
        JsonParser(String s) { this.s = s; this.pos = 0; }
        
        char peek() { skipWs(); return pos < s.length() ? s.charAt(pos) : 0; }
        char next() { skipWs(); return pos < s.length() ? s.charAt(pos++) : 0; }
        void skipWs() { while (pos < s.length() && " \t\n\r".indexOf(s.charAt(pos)) >= 0) pos++; }
        
        Object parseValue() {
            char c = peek();
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't') { pos += 4; return true; }
            if (c == 'f') { pos += 5; return false; }
            if (c == 'n') { pos += 4; return null; }
            return parseNumber();
        }
        
        Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            next(); // {
            while (peek() != '}') {
                String key = parseString();
                next(); // :
                map.put(key, parseValue());
                if (peek() == ',') next();
            }
            next(); // }
            return map;
        }
        
        List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            next(); // [
            while (peek() != ']') {
                list.add(parseValue());
                if (peek() == ',') next();
            }
            next(); // ]
            return list;
        }
        
        String parseString() {
            next(); // opening "
            StringBuilder sb = new StringBuilder();
            while (pos < s.length()) {
                char c = s.charAt(pos++);
                if (c == '"') break;
                if (c == '\\' && pos < s.length()) {
                    char esc = s.charAt(pos++);
                    switch (esc) {
                        case '"': case '\\': case '/': sb.append(esc); break;
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case 'u': sb.append((char) Integer.parseInt(s.substring(pos, pos+4), 16)); pos += 4; break;
                        default: sb.append(esc);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }
        
        Number parseNumber() {
            int start = pos;
            while (pos < s.length() && "0123456789.eE+-".indexOf(s.charAt(pos)) >= 0) pos++;
            String num = s.substring(start, pos);
            if (num.contains(".") || num.contains("e") || num.contains("E"))
                return Double.parseDouble(num);
            return Long.parseLong(num);
        }
    }

    // ─── Helpers ────────────────────────────────────────

    static String esc(Object v) {
        if (v == null) return "";
        return v.toString().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    static String badge(String status) {
        Map<String, String> colors = Map.of("active","#22c55e","archived","#888","suspended","#ef4444","owner","#f59e0b","admin","#e84393","member","#888");
        String c = colors.getOrDefault(status, "#888");
        return String.format("<span style='display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:%s20;color:%s'>%s</span>", c, c, esc(status));
    }

    static int intVal(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v instanceof Number) return ((Number) v).intValue();
        return 0;
    }

    static String strVal(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v != null ? v.toString() : "";
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> listVal(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v instanceof List) return (List<Map<String, Object>>) v;
        return List.of();
    }

    static String getSession(HttpExchange ex) {
        String cookie = ex.getRequestHeaders().getFirst("Cookie");
        if (cookie == null) return null;
        for (String part : cookie.split(";")) {
            part = part.trim();
            if (part.startsWith("am_session=")) return part.substring(11);
        }
        return null;
    }

    static String getToken(HttpExchange ex) {
        String sid = getSession(ex);
        if (sid == null || !sessions.containsKey(sid)) return null;
        return strVal(sessions.get(sid), "token");
    }

    static Map<String, Object> getUser(HttpExchange ex) {
        String sid = getSession(ex);
        if (sid == null || !sessions.containsKey(sid)) return null;
        Object u = sessions.get(sid).get("user");
        return u instanceof Map ? (Map<String, Object>) u : null;
    }

    static void respond(HttpExchange ex, int code, String html) throws IOException {
        byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/html; charset=UTF-8");
        ex.sendResponseHeaders(code, bytes.length);
        ex.getResponseBody().write(bytes);
        ex.getResponseBody().close();
    }

    static void redirect(HttpExchange ex, String url) throws IOException {
        ex.getResponseHeaders().set("Location", url);
        ex.sendResponseHeaders(302, -1);
        ex.close();
    }

    static Map<String, String> parseForm(HttpExchange ex) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Map<String, String> params = new LinkedHashMap<>();
        for (String pair : body.split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length == 2) params.put(URLDecoder.decode(kv[0], StandardCharsets.UTF_8), URLDecoder.decode(kv[1], StandardCharsets.UTF_8));
        }
        return params;
    }

    // ─── CSS ────────────────────────────────────────────

    static final String CSS = "*{box-sizing:border-box;margin:0;padding:0}:root,[data-theme=light]{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#495057;--muted:#868e96;--primary:#e84393;--success:#2b8a3e;--danger:#c92a2a;--warning:#e67700;--r:6px;color-scheme:light dark}[data-theme=dark]{--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1114;--surface:#16181d;--border:#2c3038;--text:#e1e4e8;--dim:#b0b8c4;--muted:#6b7280;--primary:#f06595;--success:#37b24d;--danger:#f03e3e;--warning:#f08c00}}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text)}.layout{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column}.sh{padding:20px;border-bottom:1px solid var(--border)}.sh h2{font-size:16px}.sh h2 em{font-style:normal;color:var(--primary)}.sh small{font-size:11px;color:var(--muted);display:block;margin-top:2px}.nav{flex:1;padding:8px 0}.ns{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);padding:12px 20px 4px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);text-decoration:none;font-size:13px}.nav a:hover{color:var(--text);background:rgba(255,255,255,0.03)}.nav a.on{color:var(--primary);background:rgba(232,67,147,0.12);border-right:2px solid var(--primary)}.sf{padding:16px 20px;border-top:1px solid var(--border);font-size:12px}.content{flex:1;margin-left:240px;padding:32px;max-width:1100px}h2.t{font-size:22px;font-weight:700;margin-bottom:4px}.desc{font-size:13px;color:var(--dim);margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}.stat .v{font-size:30px;font-weight:700;margin-top:4px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}.ct{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border)}td{padding:12px;border-bottom:1px solid var(--border)}.btn{display:inline-flex;align-items:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none}.btn-p{background:var(--primary);border-color:var(--primary);color:#fff}.btn-d{color:var(--danger);border-color:var(--danger)}.btn-sm{padding:4px 10px;font-size:12px}.input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}.fg{margin-bottom:14px}.fl{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}.empty{text-align:center;padding:48px 20px;color:var(--muted)}.empty-i{font-size:36px;margin-bottom:10px}select.input{appearance:auto}";

    static String navItem(String href, String icon, String label, String active) {
        String cls = active.equals(label.toLowerCase()) ? " on" : "";
        return String.format("<a href='%s' class='%s'>%s <span>%s</span></a>", href, cls, icon, label);
    }

    static String layout(String page, Map<String, Object> user, String content) {
        String userName = user != null ? esc(user.get("name")) : "";
        String userEmail = user != null ? esc(user.get("email")) : "";
        return String.format("<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'><title>🎀 AgenticMail Enterprise — Java</title><style>%s</style></head><body><div class='layout'>" +
            "<div class='sidebar'><div class='sh'><h2>🏢 <em>Agentic</em>Mail</h2><small>Enterprise · Java</small></div>" +
            "<div class='nav'><div class='ns'>Overview</div>%s<div class='ns'>Manage</div>%s%s%s<div class='ns'>System</div>%s%s</div>" +
            "<div class='sf'><div style='color:var(--dim)'>%s</div><div style='color:var(--muted);font-size:11px'>%s</div><a href='/logout' style='color:var(--muted);font-size:11px;margin-top:6px;display:inline-block'>Sign out</a></div></div>" +
            "<div class='content'>%s</div></div></body></html>",
            CSS,
            navItem("/", "📊", "Dashboard", page), navItem("/agents", "🤖", "Agents", page),
            navItem("/users", "👥", "Users", page), navItem("/api-keys", "🔑", "API Keys", page),
            navItem("/audit", "📋", "Audit", page), navItem("/settings", "⚙️", "Settings", page),
            userName, userEmail, content);
    }

    // ─── Handlers ───────────────────────────────────────

    static void handleLogin(HttpExchange ex) throws IOException {
        if ("GET".equals(ex.getRequestMethod())) {
            respond(ex, 200, String.format("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>AgenticMail</title><style>%s</style></head><body style='display:flex;align-items:center;justify-content:center;min-height:100vh'><div style='width:380px'><h1 style='text-align:center;font-size:22px'>🏢 <em style='color:var(--primary)'>AgenticMail</em> Enterprise</h1><p style='text-align:center;color:var(--dim);font-size:13px;margin-bottom:32px'>Sign in · Java Dashboard</p><form method='POST'><div class='fg'><label class='fl'>Email</label><input class='input' type='email' name='email' required></div><div class='fg'><label class='fl'>Password</label><input class='input' type='password' name='password' required></div><button class='btn btn-p' style='width:100%%' type='submit'>Sign In</button></form></div></body></html>", CSS));
            return;
        }
        Map<String, String> form = parseForm(ex);
        var data = api("/auth/login", "POST", null, toJson(Map.of("email", form.getOrDefault("email", ""), "password", form.getOrDefault("password", ""))));
        if (data.containsKey("token")) {
            String sid = UUID.randomUUID().toString();
            Map<String, Object> sess = new HashMap<>();
            sess.put("token", data.get("token").toString());
            sess.put("user", data.get("user"));
            sessions.put(sid, sess);
            ex.getResponseHeaders().set("Set-Cookie", "am_session=" + sid + "; Path=/; HttpOnly; Max-Age=86400");
            redirect(ex, "/");
        } else {
            respond(ex, 401, "Login failed: " + strVal(data, "error") + " <a href='/login'>Try again</a>");
        }
    }

    static void handleDashboard(HttpExchange ex) throws IOException {
        String token = getToken(ex);
        var stats = api("/api/stats", "GET", token, null);
        var audit = api("/api/audit?limit=8", "GET", token, null);
        
        StringBuilder events = new StringBuilder();
        for (var e : listVal(audit, "events")) {
            events.append(String.format("<div style='padding:10px 0;border-bottom:1px solid var(--border);font-size:13px'><span style='color:var(--primary);font-weight:500'>%s</span> on %s<div style='font-size:11px;color:var(--muted)'>%s</div></div>",
                esc(e.get("action")), esc(e.get("resource")), esc(e.get("timestamp"))));
        }
        String evHtml = events.length() > 0 ? events.toString() : "<div class='empty'><div class='empty-i'>📋</div>No activity yet</div>";

        respond(ex, 200, layout("dashboard", getUser(ex), String.format(
            "<h2 class='t'>Dashboard</h2><p class='desc'>Overview</p><div class='stats'>" +
            "<div class='stat'><div class='l'>Total Agents</div><div class='v' style='color:var(--primary)'>%d</div></div>" +
            "<div class='stat'><div class='l'>Active Agents</div><div class='v' style='color:var(--success)'>%d</div></div>" +
            "<div class='stat'><div class='l'>Users</div><div class='v'>%d</div></div>" +
            "<div class='stat'><div class='l'>Audit Events</div><div class='v'>%d</div></div></div>" +
            "<div class='card'><div class='ct'>Recent Activity</div>%s</div>",
            intVal(stats, "totalAgents"), intVal(stats, "activeAgents"), intVal(stats, "totalUsers"), intVal(stats, "totalAuditEvents"), evHtml)));
    }

    static void handleAgents(HttpExchange ex) throws IOException {
        String token = getToken(ex);
        if ("POST".equals(ex.getRequestMethod())) {
            Map<String, String> form = parseForm(ex);
            api("/api/agents", "POST", token, toJson(Map.of("name", form.getOrDefault("name",""), "role", form.getOrDefault("role","assistant"))));
            redirect(ex, "/agents"); return;
        }
        var data = api("/api/agents", "GET", token, null);
        var agents = listVal(data, "agents");
        StringBuilder rows = new StringBuilder();
        for (var a : agents) {
            rows.append(String.format("<tr><td style='font-weight:600'>%s</td><td style='color:var(--dim)'>%s</td><td>%s</td><td>%s</td></tr>",
                esc(a.get("name")), esc(a.get("email")), esc(a.get("role")), badge(strVal(a, "status"))));
        }
        String table = agents.isEmpty() ? "<div class='empty'><div class='empty-i'>🤖</div>No agents yet</div>" :
            "<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>" + rows + "</tbody></table>";
        respond(ex, 200, layout("agents", getUser(ex),
            "<h2 class='t'>Agents</h2><p class='desc'>Manage AI agent identities</p>" +
            "<div class='card' style='margin-bottom:16px'><div class='ct'>Create Agent</div><form method='POST' style='display:flex;gap:10px;align-items:end'>" +
            "<div class='fg' style='flex:1;margin:0'><label class='fl'>Name</label><input class='input' name='name' required placeholder='e.g. researcher'></div>" +
            "<div class='fg' style='margin:0'><label class='fl'>Role</label><select class='input' name='role'><option>assistant</option><option>researcher</option><option>writer</option></select></div>" +
            "<button class='btn btn-p' type='submit'>Create</button></form></div><div class='card'>" + table + "</div>"));
    }

    static void handleUsers(HttpExchange ex) throws IOException {
        String token = getToken(ex);
        var data = api("/api/users", "GET", token, null);
        var users = listVal(data, "users");
        StringBuilder rows = new StringBuilder();
        for (var u : users) {
            rows.append(String.format("<tr><td style='font-weight:600'>%s</td><td style='color:var(--dim)'>%s</td><td>%s</td></tr>",
                esc(u.get("name")), esc(u.get("email")), badge(strVal(u, "role"))));
        }
        String table = users.isEmpty() ? "<div class='empty'><div class='empty-i'>👥</div>No users yet</div>" :
            "<table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>" + rows + "</tbody></table>";
        respond(ex, 200, layout("users", getUser(ex),
            "<h2 class='t'>Users</h2><p class='desc'>Manage team members</p><div class='card'>" + table + "</div>"));
    }

    static void handleSettings(HttpExchange ex) throws IOException {
        String token = getToken(ex);
        var s = api("/api/settings", "GET", token, null);
        respond(ex, 200, layout("settings", getUser(ex),
            "<h2 class='t'>Settings</h2><p class='desc'>Configure your organization</p>" +
            "<div class='card'><div class='ct'>General</div><div style='font-size:13px'>Name: " + esc(s.get("name")) +
            "<br>Domain: " + esc(s.get("domain")) + "<br>Plan: " + badge(strVal(s, "plan").toUpperCase()) +
            "<br>Subdomain: " + esc(s.get("subdomain")) + ".agenticmail.cloud</div></div>"));
    }

    // ─── Main ───────────────────────────────────────────

    public static void main(String[] args) throws Exception {
        String envUrl = System.getenv("AGENTICMAIL_URL");
        if (envUrl != null && !envUrl.isEmpty()) API_URL = envUrl;
        
        int port = 8081;
        String envPort = System.getenv("PORT");
        if (envPort != null) port = Integer.parseInt(envPort);

        var server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newFixedThreadPool(10));
        
        server.createContext("/login", ex -> { try { handleLogin(ex); } catch (Exception e) { respond(ex, 500, e.getMessage()); } });
        server.createContext("/logout", ex -> { sessions.remove(getSession(ex)); ex.getResponseHeaders().set("Set-Cookie", "am_session=; Path=/; Max-Age=0"); redirect(ex, "/login"); });
        server.createContext("/agents", ex -> { if (getToken(ex)==null) { redirect(ex,"/login"); return; } try { handleAgents(ex); } catch (Exception e) { respond(ex, 500, e.getMessage()); } });
        server.createContext("/users", ex -> { if (getToken(ex)==null) { redirect(ex,"/login"); return; } try { handleUsers(ex); } catch (Exception e) { respond(ex, 500, e.getMessage()); } });
        server.createContext("/settings", ex -> { if (getToken(ex)==null) { redirect(ex,"/login"); return; } try { handleSettings(ex); } catch (Exception e) { respond(ex, 500, e.getMessage()); } });
        server.createContext("/", ex -> { if (getToken(ex)==null) { redirect(ex,"/login"); return; } try { handleDashboard(ex); } catch (Exception e) { respond(ex, 500, e.getMessage()); } });

        server.start();
        System.out.printf("%n🏢 🎀 AgenticMail Enterprise Dashboard (Java)%n");
        System.out.printf("   API:       %s%n", API_URL);
        System.out.printf("   Dashboard: http://localhost:%d%n%n", port);
    }
}
