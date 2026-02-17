# AgenticMail Enterprise Dashboards

**Admin dashboards in every popular language.** Pick the one that matches your stack — or use the zero-code HTML version if you're not a developer.

All dashboards connect to the same AgenticMail Enterprise API. They're interchangeable.

---

## 🎯 Quick Start by Language

| Language | File | Dependencies | Run Command |
|----------|------|-------------|-------------|
| **HTML** (zero-code) | `html/index.html` | None! | Just open in browser |
| **PHP** | `php/index.php` | PHP 7.4+ | `php -S localhost:8080 index.php` |
| **Python** | `python/app.py` | Flask, requests | `pip install flask requests && python app.py` |
| **Ruby** | `ruby/app.rb` | Sinatra | `gem install sinatra && ruby app.rb` |
| **Express.js** | `express/app.js` | Express | `npm install express express-session && node app.js` |
| **React** (built-in) | _Served at `/dashboard`_ | None (bundled) | Comes with the enterprise server |

| **Go** | `go/main.go` | None (stdlib only) | `go run main.go` |
| **Java** | `java/AgenticMailDashboard.java` | JDK 11+ | `javac AgenticMailDashboard.java && java AgenticMailDashboard` |
| **C# / .NET** | `dotnet/Program.cs` | .NET 8+ | `dotnet new web && dotnet run` |

### Coming Soon
| Language | Status |
|----------|--------|
| **Laravel** (PHP framework) | Planned |
| **Django** (Python framework) | Planned |
| **Rails** (Ruby framework) | Planned |
| **Svelte** | Planned |
| **Vue.js** | Planned |
| **Angular** | Planned |

---

## 🚀 Non-Coders: Start Here

**You don't need to know how to code.** Use the HTML dashboard:

1. Download `html/index.html`
2. Open it in any web browser (Chrome, Safari, Firefox, Edge)
3. Enter your AgenticMail Enterprise server URL when prompted
4. Login with your admin credentials

That's it. No installation, no terminal, no coding.

---

## 🔌 How It Works

Every dashboard talks to the **AgenticMail Enterprise REST API**:

```
Your Dashboard  →  REST API  →  AgenticMail Enterprise Server
(any language)     (JSON)        (your database)
```

The API endpoints:
- `POST /auth/login` — Get JWT token
- `GET /api/stats` — Dashboard stats
- `GET /api/agents` — List agents
- `POST /api/agents` — Create agent
- `GET /api/users` — List users
- `GET /api/api-keys` — List API keys
- `GET /api/audit` — Audit log
- `GET /api/settings` — Organization settings
- `GET /health` — Health check

Full API docs at your server's `/health` endpoint.

---

## 🎨 All Dashboards Include

- **Dark theme** — Easy on the eyes
- **Responsive** — Works on mobile, tablet, desktop
- **Authentication** — Login with email/password, JWT sessions
- **Dashboard** — Stats overview with agent/user/event counts
- **Agents** — Create, list, archive AI agents
- **Users** — Manage team members with roles (owner/admin/member/viewer)
- **API Keys** — Create, list, revoke programmatic access keys
- **Audit Log** — Paginated event history
- **Settings** — Organization name, domain, branding

---

## 🔧 Configuration

All dashboards use one environment variable:

```bash
AGENTICMAIL_URL=https://your-company.agenticmail.cloud
```

Or edit the `API_URL` variable at the top of each file.

---

## 🏗️ Build Your Own

The API is REST + JSON. Build a dashboard in any language:

```bash
# Login
curl -X POST https://your-server/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"..."}'
# Returns: { "token": "eyJ...", "user": {...} }

# Use the token
curl https://your-server/api/stats \
  -H "Authorization: Bearer eyJ..."
# Returns: { "totalAgents": 5, "activeAgents": 3, ... }
```

---

## 📄 License

MIT — Use these dashboards however you want.
