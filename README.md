# 🎀 AgenticMail

**The first platform to give AI agents real email addresses and phone numbers.** Send and receive email, SMS, and verification codes — all programmatically.

AgenticMail is a self-hosted communication platform purpose-built for AI agents. It runs a local [Stalwart](https://stalw.art) mail server via Docker, integrates Google Voice for SMS/phone access, exposes a REST API with 75+ endpoints, and works with any MCP-compatible AI client and [OpenClaw](https://github.com/openclaw/openclaw) via plugin. Each agent gets its own email address, phone number, inbox, and API key.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)

---

## Table of Contents

- [Why AgenticMail?](#why-agenticmail)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [CLI Commands](#cli-commands)
- [Gateway Modes](#gateway-modes)
- [Packages](#packages)
- [API Overview](#api-overview)
- [MCP Integration](#mcp-integration)
- [OpenClaw Integration](#openclaw-integration)
- [Interactive Shell](#interactive-shell)
- [Security](#security)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)

---

## Why 🎀 AgenticMail?

AI agents need to communicate with the real world. Email is the universal communication protocol — every person and business has an email address. AgenticMail bridges the gap between AI agents and email by providing:

- **Isolated mailboxes** — each agent has its own email address, inbox, and credentials. Agents can't read each other's mail.
- **Internet email connectivity** — two gateway modes to send/receive real email (Gmail relay or custom domain with DKIM/SPF/DMARC).
- **Security guardrails** — outbound scanning prevents agents from leaking API keys, passwords, or PII. Blocked emails require human approval.
- **Agent collaboration** — agents can email each other, assign tasks, and make synchronous RPC calls.
- **SMS / Phone number access** — integrate Google Voice for SMS receive/send, verification code extraction, and phone number access for AI agents.
- **Smart orchestration** — `call_agent` replaces basic sub-agent spawning with auto mode detection, dynamic timeouts, runtime tool discovery, and async execution for long-running tasks.
- **Tool integrations** — 62 MCP tools for any AI client, 63 OpenClaw tools, and a 43-command interactive shell.
- **Self-updating** — `agenticmail update` checks npm, verifies OpenClaw compatibility, and updates both packages automatically.

---

## Features

### Email Operations
- **Send email** with text, HTML, attachments, CC/BCC, reply-to, and custom headers
- **Receive email** via IMAP with real-time SSE event streaming (IMAP IDLE)
- **Reply and forward** with proper In-Reply-To and References headers for threading
- **Search** by sender, subject, body text, date range, read/unread status
- **Folders** — create, list, move messages between folders
- **Batch operations** — mark read/unread, delete, move multiple messages at once
- **Drafts** — save, edit, and send draft emails
- **Templates** — reusable email templates with variable substitution
- **Scheduled sending** — queue emails for future delivery
- **Signatures** — per-agent email signatures
- **Tags** — label and categorize messages
- **Contacts** — manage address book per agent

### Multi-Agent
- **Account management** — create, list, delete agents with unique email addresses
- **Agent-to-agent email** — agents can email each other directly via `@localhost`
- **Task system** — assign tasks to agents, claim, submit results, track status
- **RPC calls** — synchronous agent-to-agent calls with timeout (long-poll + SSE notification)
- **Agent directory** — discover other agents by name

### Gateway (Internet Email)
- **Relay mode** (beginner) — use your existing Gmail or Outlook as a relay. Emails appear as `you+agentname@gmail.com`. Setup takes 2 minutes.
- **Domain mode** (advanced) — custom domain via Cloudflare. Agents send from `agent@yourdomain.com` with full DKIM signing, SPF, and DMARC records.
  - Automatic DNS configuration (MX, SPF, DKIM TXT, DMARC, tunnel CNAME)
  - Cloudflare Tunnel for secure inbound traffic without exposing ports
  - Cloudflare Email Worker for Email Routing (catch-all → worker → AgenticMail)
  - Optional Gmail SMTP outbound relay for residential IPs without PTR records
  - Domain purchase via Cloudflare Registrar
  - DNS backup before any modifications
  - Automatic `@domain` email alias for all existing agents

### Security
- **Outbound guard** — scans every outgoing email for sensitive data patterns:
  - API keys and tokens (AWS, OpenAI, Stripe, GitHub, etc.)
  - Passwords and credentials
  - Private keys (SSH, PGP, RSA)
  - PII patterns (SSN, credit card numbers)
  - Internal URLs and configuration data
  - Blocked emails are held for human-only approval (agents cannot self-approve)
- **Spam filter** — rule-based scoring engine for inbound email:
  - Categories: phishing, scam, malware, commercial spam, social engineering, lottery scam
  - Configurable threshold (default: 40)
  - Skips internal agent-to-agent emails
  - Runs on both relay inbound and SSE event streams
- **Human-only approval flow** — when an agent's email is blocked:
  - The agent is informed the email was blocked and told to notify their owner
  - The owner receives a notification email with full blocked email content, warnings, and pending ID
  - Only the master key holder can approve or reject (`POST /mail/pending/:id/approve`)
  - Agents can list and view their own pending emails but **cannot** approve or reject them
  - System prompt guidelines instruct agents to inform their owner and wait, never attempt to bypass
- **DKIM/SPF/DMARC** — automatic DNS setup in domain mode for email authentication
- **Rate limiting** — configurable per-endpoint rate limits

### SMS / Phone Number Access
- **Google Voice integration** — give agents a real phone number via Google Voice
- **Direct Voice web reading** (primary, instant) — reads SMS directly from voice.google.com via browser
- **Email forwarding** (fallback) — Google Voice forwards SMS to email, agent auto-detects and records them during relay polling
- **Separate Gmail polling** — for users whose GV Gmail differs from relay email, runs a dedicated IMAP poll
- **Verification codes** — automatic extraction of OTP/verification codes from SMS (4-8 digit, alphanumeric, Google G-codes)
- **Send SMS** — record outbound messages, send via Google Voice web automation
- **Smart setup wizard** — validates Gmail/GV email matching, warns about mismatches, collects separate credentials when needed

### Smart Orchestration (call_agent)
- **Auto mode detection** — reads task complexity, picks light/standard/full mode automatically
- **Dynamic timeouts** — 60s for quick tasks, 5+ minutes for deep research, 1 hour for async
- **Runtime tool discovery** — probes host config for available tools instead of static deny lists
- **Async execution** — long-running tasks run independently, auto-compact context, email results when done
- **Structured RPC** — sub-agents return JSON, not raw text

### Integrations
- **MCP server** — 59 tools for any MCP-compatible AI client
- **OpenClaw plugin** — 63 tools with skill definition and system prompt guidelines
- **REST API** — 75+ endpoints, OpenAPI-style, Bearer token auth
- **SSE events** — real-time inbox notifications via Server-Sent Events
- **Interactive CLI** — 44 shell commands with arrow key navigation, body previews, retry logic
- **Self-updating** — `agenticmail update` or `/update` in shell, with OpenClaw compatibility check

---

## Architecture

```
                  ┌──────────────────────────────────────────────────┐
                  │                    AgenticMail                    │
                  │                                                  │
 AI Client ─MCP─> │  @agenticmail/mcp    (62 tools, stdio transport) │
                  │       │                                          │
 OpenClaw ─────>  │  @agenticmail/openclaw  (63 tools, plugin)       │
                  │       │                                          │
 HTTP clients──>  │       ▼                                          │
                  │  @agenticmail/api     (Express, 75+ endpoints)   │
                  │    ├── Authentication  (master key + agent keys)  │
                  │    ├── Rate limiting   (per-endpoint)             │
                  │    ├── SSE streaming   (real-time inbox events)   │
                  │    └── Spam filter + Outbound guard               │
                  │       │                                          │
                  │       ▼                                          │
                  │  @agenticmail/core    (SDK layer)                 │
                  │    ├── AccountManager  (CRUD agents in Stalwart)  │
                  │    ├── MailSender      (SMTP, nodemailer)         │
                  │    ├── MailReceiver    (IMAP, imapflow)           │
                  │    ├── InboxWatcher    (IMAP IDLE → events)       │
                  │    ├── GatewayManager  (relay + domain routing)   │
                  │    │   ├── RelayGateway      (Gmail/Outlook)      │
                  │    │   ├── CloudflareClient   (DNS, tunnels, etc) │
                  │    │   ├── TunnelManager      (cloudflared)       │
                  │    │   ├── DNSConfigurator    (MX, SPF, DKIM)     │
                  │    │   └── DomainPurchaser    (Registrar API)     │
                  │    ├── StalwartAdmin   (mail server management)   │
                  │    ├── EmailSearchIndex (FTS5 full-text search)   │
                  │    └── Storage         (SQLite + migrations)      │
                  │       │                                          │
                  │       ▼                                          │
                  │  Stalwart Mail Server  (Docker container)         │
                  │    ├── SMTP (port 587) — submission               │
                  │    ├── SMTP (port 25)  — inbound delivery         │
                  │    ├── IMAP (port 143) — mailbox access           │
                  │    └── HTTP (port 8080) — admin API               │
                  └──────────────────────────────────────────────────┘
                          │                         │
            ┌─────────────┘                         └──────────────┐
            ▼                                                      ▼
     Relay Mode                                            Domain Mode
  ┌──────────────────┐                            ┌──────────────────────┐
  │  Gmail / Outlook  │                            │  Cloudflare          │
  │  IMAP polling     │                            │  ├── DNS zone        │
  │  SMTP relay       │                            │  ├── Tunnel          │
  │  Sub-addressing   │                            │  ├── Email Routing   │
  │  (+agent@gmail)   │                            │  ├── Email Worker    │
  └──────────────────┘                            │  └── Registrar       │
                                                   └──────────────────────┘
```

### Data Flow

**Sending email (relay mode):**
1. Agent calls `POST /mail/send` with recipient, subject, body
2. API runs outbound guard scan — if sensitive data found, email is blocked and owner notified
3. GatewayManager detects external recipient → routes to RelayGateway
4. RelayGateway sends via Gmail SMTP as `owner+agentname@gmail.com`
5. Reply-To set to agent's relay address so replies route back

**Sending email (domain mode):**
1. Agent calls `POST /mail/send`
2. Outbound guard scan runs
3. GatewayManager rewrites `agent@localhost` → `agent@yourdomain.com`
4. Email submitted to local Stalwart via SMTP (port 587)
5. Stalwart signs with DKIM, resolves MX, delivers directly (or via Gmail relay)

**Receiving email (relay mode):**
1. RelayGateway polls Gmail IMAP every 30 seconds for new messages
2. New email detected → parsed → spam scored
3. If not spam, delivered to agent's local Stalwart mailbox via SMTP
4. `X-AgenticMail-Relay: inbound` header added for identification
5. InboxWatcher (IMAP IDLE) fires SSE event to connected clients

**Receiving email (domain mode):**
1. External sender sends to `agent@yourdomain.com`
2. Cloudflare Email Routing catches all → routes to Email Worker
3. Worker reads raw RFC822 message, base64-encodes, POSTs to `/api/agenticmail/mail/inbound`
4. Inbound endpoint validates secret, parses email, delivers to agent's mailbox
5. InboxWatcher fires SSE event

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 20 or later
- [Docker](https://docker.com) (for the Stalwart mail server)

### Install

```bash
npm install -g agenticmail
```

### Setup

```bash
# 1. Start the mail server
docker compose up -d

# 2. Run the setup wizard (creates config, initializes database, creates first agent)
agenticmail setup

# 3. Start the API server + interactive shell
agenticmail start
```

The setup wizard will:
- Check Docker is running and Stalwart is healthy
- Generate a master API key
- Create the SQLite database with all required tables
- Create your first AI agent with its own email address and API key
- Optionally configure a gateway (relay or domain mode) for internet email

### Send your first email (programmatic)

```typescript
import { AgenticMailClient } from 'agenticmail';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3100',
  apiKey: 'ak_your_agent_api_key',
});

// Send an email
await client.send({
  to: 'colleague@example.com',
  subject: 'Hello from my AI agent',
  text: 'This email was sent by an AI agent using AgenticMail.',
});

// Check inbox
const inbox = await client.listInbox(10);
for (const msg of inbox) {
  console.log(`${msg.from} — ${msg.subject}`);
}

// Read a specific email
const email = await client.readMessage(inbox[0].uid);
console.log(email.text);
```

### Send your first email (CLI)

```
agenticmail> /send
To: someone@example.com
Subject: Test email
Body: Hello from the AgenticMail shell!

Email sent! Message ID: <abc123@localhost>
```

### Send your first email (curl)

```bash
curl -X POST http://127.0.0.1:3100/api/agenticmail/mail/send \
  -H "Authorization: Bearer ak_your_agent_key" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "someone@example.com",
    "subject": "Hello",
    "text": "Sent via the AgenticMail API."
  }'
```

---

## CLI Commands

AgenticMail includes a full CLI for managing your server. All commands are available via `agenticmail <command>` or `npx agenticmail@latest <command>`.

### Core Commands

| Command | Description |
|---------|-------------|
| `agenticmail` | **Start the server** (runs setup first if not initialized). Opens the interactive shell after startup. This is the default command — just run `agenticmail` with no arguments. |
| `agenticmail setup` | **Run the setup wizard.** Walks you through system checks, account creation, service startup, email connection (Gmail/Outlook/custom domain), phone number setup, and OpenClaw integration. Safe to re-run — won't overwrite existing config. |
| `agenticmail start` | **Start the server** and open the interactive shell. Ensures Docker is running, Stalwart is up, and the API server is reachable. Automatically installs the auto-start service if not already set up. |
| `agenticmail stop` | **Stop the server.** Kills the background API server process. If auto-start is enabled, it will restart on next boot. Use `agenticmail service uninstall` to fully disable. |
| `agenticmail status` | **Show what's running.** Displays the status of Docker, Stalwart, the API server, email connection, and auto-start service. |

### Integration Commands

| Command | Description |
|---------|-------------|
| `agenticmail openclaw` | **Set up AgenticMail for OpenClaw.** Starts infrastructure, creates an agent, configures the OpenClaw plugin, enables agent auto-spawn via hooks, and restarts the OpenClaw gateway. |

### Service Management (Auto-Start)

AgenticMail installs a system service so it automatically starts when your computer boots. On macOS this is a LaunchAgent; on Linux it's a systemd user service.

| Command | Description |
|---------|-------------|
| `agenticmail service` | **Show auto-start status.** Displays whether the service is installed and running. |
| `agenticmail service install` | **Install the auto-start service.** AgenticMail will start automatically on boot. The startup script waits up to 10 minutes for Docker to be ready, then checks that Stalwart is running (starts it if needed), then launches the API server. |
| `agenticmail service uninstall` | **Remove the auto-start service.** AgenticMail will no longer start on boot. |
| `agenticmail service reinstall` | **Reinstall the service.** Use this after config changes or updates to refresh the service file. |

**What happens on reboot:**
1. Your computer starts → Docker Desktop launches (its own auto-start)
2. Stalwart mail server starts (`restart: unless-stopped` in Docker)
3. AgenticMail startup script waits for Docker to be ready (up to 10 min)
4. Script verifies Stalwart is running (auto-starts it if Docker restarted without it)
5. API server starts and begins accepting requests

If the API server crashes, the system service automatically restarts it.

### Maintenance Commands

| Command | Description |
|---------|-------------|
| `agenticmail update` | **Update to the latest version.** Checks npm for a new version, updates the CLI and OpenClaw plugin, and restarts the OpenClaw gateway if applicable. |
| `agenticmail help` | **Show available commands.** |

### Logs

Server logs are stored in `~/.agenticmail/logs/`:
- `server.log` — API server stdout
- `server.err.log` — API server stderr
- `startup.log` — Boot sequence log (Docker wait times, Stalwart checks)

---

## Gateway Modes

AgenticMail supports two modes for sending/receiving real internet email:

### Relay Mode (Beginner-Friendly)

Use your existing Gmail or Outlook account as a relay. No domain purchase needed. Setup takes under 2 minutes.

**How it works:**
- Outbound: emails sent via your Gmail/Outlook SMTP as `you+agentname@gmail.com`
- Inbound: AgenticMail polls your Gmail/Outlook IMAP for new messages addressed to `you+agentname@gmail.com` and delivers them to the agent's local mailbox
- Gmail's `+` sub-addressing routes replies back to the right agent

**Setup:**
```bash
# In the interactive shell:
agenticmail> /relay

# Or via API:
curl -X POST http://127.0.0.1:3100/api/agenticmail/gateway/relay \
  -H "Authorization: Bearer mk_your_master_key" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gmail",
    "email": "you@gmail.com",
    "password": "xxxx xxxx xxxx xxxx"
  }'
```

**Requirements:**
- Gmail: [App password](https://myaccount.google.com/apppasswords) (not your regular password)
- Outlook: App password from Microsoft account security settings

### Domain Mode (Advanced)

Full custom domain with Cloudflare. Agents send from `agent@yourdomain.com` with proper email authentication.

**What gets configured automatically:**
- Cloudflare DNS zone creation
- MX records pointing to Cloudflare Email Routing
- SPF record (`v=spf1 include:_spf.mx.cloudflare.net ~all`)
- DKIM key generation and TXT record
- DMARC record (`v=DMARC1; p=quarantine`)
- Cloudflare Tunnel (CNAME record, ingress rules)
- Cloudflare Email Worker deployment (catches all inbound email)
- Catch-all Email Routing rule → Worker → AgenticMail inbound endpoint
- Stalwart hostname, DKIM signing, domain principal
- `@domain` email aliases for all existing agents
- Optional: Gmail SMTP outbound relay, domain purchase

**Setup:**
```bash
curl -X POST http://127.0.0.1:3100/api/agenticmail/gateway/domain \
  -H "Authorization: Bearer mk_your_master_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cloudflareToken": "your_cf_api_token",
    "cloudflareAccountId": "your_cf_account_id",
    "domain": "yourdomain.com",
    "gmailRelay": {
      "email": "you@gmail.com",
      "appPassword": "xxxx xxxx xxxx xxxx"
    }
  }'
```

**Cloudflare API token permissions needed:**
- Zone: DNS (Edit), Email Routing (Edit)
- Account: Cloudflare Tunnel (Edit), Workers Scripts (Edit), Registrar (Edit — only if purchasing domains)

---

## Packages

This is a TypeScript monorepo with 5 packages:

| Package | Description | Install |
|---------|-------------|---------|
| [`agenticmail`](./agenticmail) | CLI, setup wizard, interactive shell. Install this to get started. | `npm i -g agenticmail` |
| [`@agenticmail/core`](./packages/core) | Core SDK — accounts, SMTP/IMAP, gateway, spam filter, outbound guard, storage | `npm i @agenticmail/core` |
| [`@agenticmail/api`](./packages/api) | Express REST API server with 75+ endpoints | `npm i @agenticmail/api` |
| [`@agenticmail/mcp`](./packages/mcp) | MCP server with 62 tools for any MCP-compatible AI client | `npm i -g @agenticmail/mcp` |
| [`@agenticmail/openclaw`](./packages/openclaw) | OpenClaw plugin with 63 tools and skill definition | `openclaw plugin install agenticmail` |

**Dependency graph:**
```
agenticmail (CLI) ──> @agenticmail/api ──> @agenticmail/core
@agenticmail/mcp       (standalone — HTTP calls to API)
@agenticmail/openclaw  (standalone — HTTP calls to API)
```

---

## API Overview

All endpoints are under `/api/agenticmail`. Authentication via `Authorization: Bearer <key>` header.

Two key types:
- **Master key** (`mk_...`) — full admin access (create/delete agents, approve blocked emails, gateway config)
- **Agent key** (`ak_...`) — scoped to one agent (read own inbox, send email, manage own drafts/contacts/etc.)

### Key Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| **Mail** | | | |
| `POST` | `/mail/send` | Agent | Send email (text, HTML, attachments) |
| `GET` | `/mail/inbox` | Agent | List inbox messages (paginated) |
| `GET` | `/mail/digest` | Agent | Inbox with body previews |
| `GET` | `/mail/messages/:uid` | Agent | Read full email with headers and attachments |
| `POST` | `/mail/search` | Agent | Search by from, subject, body, date |
| `POST` | `/mail/messages/:uid/move` | Agent | Move to folder |
| `POST` | `/mail/messages/:uid/spam` | Agent | Report as spam |
| `GET` | `/mail/folders` | Agent | List all folders |
| `GET` | `/mail/pending` | Both | List blocked outbound emails |
| `POST` | `/mail/pending/:id/approve` | Master | Approve blocked email |
| `POST` | `/mail/pending/:id/reject` | Master | Reject blocked email |
| **Accounts** | | | |
| `POST` | `/accounts` | Master | Create new agent |
| `GET` | `/accounts` | Master | List all agents with metadata |
| `GET` | `/accounts/me` | Agent | Get own agent info |
| `DELETE` | `/accounts/:id` | Master | Delete agent (with email archival) |
| `GET` | `/accounts/directory` | Both | Agent discovery directory |
| **Events** | | | |
| `GET` | `/events` | Agent | SSE stream — new email, flags, expunge events |
| **Gateway** | | | |
| `GET` | `/gateway/status` | Both | Current gateway mode and health |
| `POST` | `/gateway/relay` | Master | Configure relay mode |
| `POST` | `/gateway/domain` | Master | Configure domain mode |
| `POST` | `/gateway/test` | Both | Send a test email |
| **Tasks** | | | |
| `POST` | `/tasks/assign` | Both | Assign task to another agent |
| `POST` | `/tasks/rpc` | Both | Synchronous agent-to-agent RPC (long-poll) |
| `GET` | `/tasks/pending` | Agent | List tasks assigned to me |
| `POST` | `/tasks/:id/claim` | Agent | Claim a pending task |
| `POST` | `/tasks/:id/result` | Agent | Submit task result |

Plus endpoints for drafts, contacts, tags, rules, signatures, templates, scheduled emails, spam management, batch operations, domains, and agent deletion/cleanup.

See the [API package README](./packages/api) for complete endpoint documentation.

---

## MCP Integration

The MCP server exposes 62 tools to any MCP-compatible AI client via stdio transport.

### Setup

Add to your MCP client configuration (e.g., `.mcp.json` or project settings):

```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "npx",
      "args": ["agenticmail-mcp"],
      "env": {
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3100",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

### Desktop Clients

For desktop AI applications, add the same configuration to your app's MCP config file (check your app's documentation for the file location).

### What your AI can do

Once connected, your AI can:
- "Check my inbox" → `list_inbox`
- "Send an email to john@example.com about the project update" → `send_email`
- "Reply to that last email saying thanks" → `reply_email`
- "Search for emails from Sarah about the budget" → `search_emails`
- "Create a draft response to the client" → `manage_drafts`
- "What tasks are assigned to me?" → `check_tasks`
- "Ask the research agent to look up competitor pricing" → `call_agent`

See the [MCP package README](./packages/mcp) for the full tool list.

---

## OpenClaw Integration

Already have OpenClaw? Two steps:

```bash
# Step 1 — Install AgenticMail globally and run the setup wizard
npm install -g agenticmail && agenticmail setup
```

```bash
# Step 2 — Connect AgenticMail to your OpenClaw instance
agenticmail openclaw
```

That's it. The global install gives you the `agenticmail` command. The `openclaw` command will start the mail server, create an agent, and merge the plugin config into your `openclaw.json` automatically. Your OpenClaw agent now has its own email address.

### Manual Configuration

If you prefer to configure manually, add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "agenticmail": {
      "enabled": true,
      "config": {
        "apiUrl": "http://127.0.0.1:3100",
        "apiKey": "ak_your_agent_key",
        "masterKey": "mk_your_master_key"
      }
    }
  }
}
```

The plugin survives OpenClaw updates — plugin configuration lives in user config (`~/.openclaw/openclaw.json`), not in the OpenClaw source directory.

### Chat with Your AI Agent

Use `/chat` in the AgenticMail shell to talk directly to your OpenClaw agent in real-time:

```
╭───────────────────────────────────────────────╮
│ ❯ what's the weather in NYC?                  │
╰───────────────────────────────────────────────╯
                                          You 👤
                                  ╭──────────────╮
                                  │ what's the   │
                                  │ weather in   │
                                  │ NYC?         │
                                  ╰──────────────╯
🎀 Fola
╭──────────────────────────────────────╮
│ Currently 42°F and cloudy in NYC.    │
╰──────────────────────────────────────╯
```

- WebSocket connection to OpenClaw gateway with Ed25519 device auth
- Bubble-style chat UI with markdown rendering
- Animated thinking indicator with elapsed timer
- Multi-line input (Enter sends, `\` + Enter for new lines)

### Smart Sub-Agent Spawning

The `call_agent` tool intelligently spawns sub-agents:

- **Auto mode detection** — light (simple tasks), standard (web research), full (multi-agent coordination)
- **Dynamic timeouts** — 60s / 180s / 300s based on complexity
- **Dynamic tool discovery** — probes OpenClaw config at runtime instead of static deny lists
- **Async mode** — `call_agent(async=true)` for long-running tasks; agent emails results when done
- **Web search fallback** — uses DuckDuckGo when Brave API isn't configured

See the [OpenClaw package README](./packages/openclaw) for the full tool list.

---

## Interactive Shell

The CLI includes a full-featured interactive shell with 44 commands:

```
agenticmail> /inbox

  ★ 1  john@example.com          Project Update           2m ago
    2  sarah@example.com         Re: Budget Review        1h ago
    3  notifications@github.com  [repo] New issue #42     3h ago

  ─────────────────────────────────────────────────
  Page 1/3 ─ [←] prev [→] next [v] toggle previews [Esc] back

  Use ↑↓ arrow keys to select, Enter to read inline
```

**Key features:**
- Arrow key navigation with cursor selection
- Body preview toggle (press `v`)
- Inline email reading (press `Enter`)
- Unread markers (`★`)
- 3-retry input validation on all prompts
- Paginated views with `←`/`→` navigation

### Command Reference

```
Email:       /inbox /send /read /reply /forward /search /delete /save
             /thread /unread /archive /trash
Organize:    /folders /contacts /drafts /signature /templates /schedule /tag
Agents:      /agents /switch /deleteagent /deletions
Security:    /spam /rules /pending
Gateway:     /relay /digest /setup /status /openclaw
System:      /help /clear /exit
```

---

## Security

### Outbound Guard

Every outgoing email is scanned before sending. The guard detects:

| Category | Examples |
|----------|----------|
| API keys | `sk-...`, `AKIA...`, `ghp_...`, `sk_live_...` |
| Credentials | `password: ...`, `secret: ...`, `token: ...` |
| Private keys | `-----BEGIN RSA PRIVATE KEY-----` |
| PII | Social security numbers, credit card patterns |
| Internal data | Localhost URLs, internal IPs, config file contents |

When sensitive data is detected:
1. Email is **blocked** and saved to the `pending_outbound` table
2. Agent receives a response explaining what was blocked and why, with instructions to inform their owner
3. Owner (master key holder) is notified via email with the full blocked email content, security warnings, recipient, subject, and pending ID
4. Owner approves or rejects via the master key API (`POST /mail/pending/:id/approve` or `/reject`) or by replying to the notification email
5. Agents **cannot** approve or reject their own blocked emails — the approve/reject endpoints require the master key
6. Agents can only list and view their pending emails to check approval status
7. MCP and OpenClaw tools enforce this by rejecting approve/reject actions with a message directing agents to inform their owner
8. System prompt guidelines (OpenClaw) instruct agents to never attempt self-approval or rewrite emails to bypass detection

### Spam Filter

Inbound emails are scored against rule-based patterns:

| Category | Score Range | Examples |
|----------|-------------|----------|
| Phishing | 10-30 | Fake login pages, urgency language, spoofed senders |
| Scam | 15-25 | Nigerian prince, lottery winner, inheritance schemes |
| Malware | 20-30 | Suspicious attachments, executable links |
| Commercial | 5-15 | Unsolicited marketing, unsubscribe-heavy emails |
| Social engineering | 10-20 | Impersonation, authority pressure |

- Emails scoring >= 40 (configurable) are moved to Spam folder
- Emails scoring 20-39 get a warning flag
- Internal agent-to-agent emails skip spam filtering entirely
- Relay-rewritten emails (`@localhost` from, external replyTo) are always treated as external

### Authentication

- **Master key** — full admin access, required for agent creation/deletion, gateway config, email approval
- **Agent API keys** — scoped per-agent, can only access own inbox and send from own address
- **Inbound webhook secret** — authenticates Cloudflare Email Worker requests to the inbound endpoint

---

## Configuration

### Environment Variables

```bash
# === Required ===
AGENTICMAIL_MASTER_KEY=mk_your_key          # Master API key (generate: openssl rand -hex 32)

# === Stalwart Mail Server ===
STALWART_ADMIN_USER=admin                   # Stalwart admin username
STALWART_ADMIN_PASSWORD=changeme            # Stalwart admin password
STALWART_URL=http://localhost:8080          # Stalwart HTTP admin URL

# === SMTP/IMAP (local Stalwart) ===
SMTP_HOST=localhost                         # SMTP host
SMTP_PORT=587                               # SMTP submission port
IMAP_HOST=localhost                         # IMAP host
IMAP_PORT=143                               # IMAP port

# === Optional ===
AGENTICMAIL_API_PORT=3100                   # API server port (default: 3100)
AGENTICMAIL_DATA_DIR=~/.agenticmail         # Data directory for SQLite DB and config

# === Gateway: Relay Mode ===
RELAY_PROVIDER=gmail                        # gmail or outlook
RELAY_EMAIL=you@gmail.com                   # Your email address
RELAY_PASSWORD=xxxx xxxx xxxx xxxx          # App password

# === Gateway: Domain Mode ===
CLOUDFLARE_API_TOKEN=your_token             # Cloudflare API token
CLOUDFLARE_ACCOUNT_ID=your_account_id       # Cloudflare account ID
AGENTICMAIL_DOMAIN=yourdomain.com           # Your domain
AGENTICMAIL_INBOUND_SECRET=your_secret      # Shared secret for Email Worker

# === Gmail SMTP Relay (domain mode outbound) ===
GMAIL_RELAY_EMAIL=you@gmail.com             # Gmail address for outbound relay
GMAIL_RELAY_APP_PASSWORD=xxxx xxxx xxxx     # Gmail app password

# === Debug ===
# AGENTICMAIL_DEBUG=1                       # Enable verbose per-message logging
```

### Docker Compose

```yaml
# docker-compose.yml (included in repo)
services:
  stalwart:
    image: stalwartlabs/stalwart:latest
    container_name: agenticmail-stalwart
    ports:
      - "8080:8080"   # HTTP Admin + JMAP
      - "587:587"     # SMTP Submission
      - "143:143"     # IMAP
      - "25:25"       # SMTP Inbound
    volumes:
      - stalwart-data:/opt/stalwart
      - ~/.agenticmail/stalwart.toml:/opt/stalwart/etc/stalwart.toml:ro
    restart: unless-stopped
```

### SQLite Database

AgenticMail stores all state in a SQLite database at `~/.agenticmail/agenticmail.db`:

- `agents` — agent accounts (name, email, API key, metadata)
- `gateway_config` — relay or domain mode configuration
- `pending_outbound` — blocked emails awaiting approval
- `delivered_messages` — deduplication tracking for inbound relay
- `spam_log` — spam scoring history
- `agent_tasks` — inter-agent task assignments
- `email_rules` — per-agent email filtering rules
- `contacts`, `drafts`, `signatures`, `templates`, `scheduled_emails`, `tags`

---

## Development

### Setup

```bash
git clone https://github.com/agenticmail/agenticmail.git
cd agenticmail
npm install
docker compose up -d
npm run build
npm test
```

### Project Structure

```
agenticmail/
├── agenticmail/           # CLI facade package (npm: agenticmail)
│   └── src/
│       ├── cli.ts         # CLI entry point (setup, start, status)
│       ├── shell.ts       # Interactive REPL (44 commands)
│       └── index.ts       # Re-exports from @agenticmail/core
├── packages/
│   ├── core/              # @agenticmail/core
│   │   └── src/
│   │       ├── accounts/  # Agent CRUD, roles, deletion
│   │       ├── mail/      # Sender, receiver, parser, spam filter, outbound guard
│   │       ├── inbox/     # IMAP IDLE watcher
│   │       ├── gateway/   # Relay, Cloudflare, DNS, tunnel, domain purchase
│   │       ├── stalwart/  # Stalwart admin API client
│   │       ├── storage/   # SQLite database, migrations, search index
│   │       ├── domain/    # Domain management
│   │       └── setup/     # Dependency checker, installer
│   ├── api/               # @agenticmail/api
│   │   └── src/
│   │       ├── app.ts     # Express app factory
│   │       ├── routes/    # 8 route modules (mail, accounts, events, etc.)
│   │       └── middleware/ # Auth, rate limiting, error handling
│   ├── mcp/               # @agenticmail/mcp
│   │   └── src/
│   │       ├── index.ts   # MCP server entry (stdio transport)
│   │       ├── tools.ts   # 61 tool definitions and handlers
│   │       └── resources.ts
│   └── openclaw/          # @agenticmail/openclaw
│       ├── index.ts       # Plugin entry, system prompt
│       ├── src/tools.ts   # 61 tool definitions and handlers
│       └── skill/         # SKILL.md, reference docs, scripts
├── docker-compose.yml     # Stalwart mail server
├── .env.example           # Environment variable template
└── package.json           # Workspace root
```

### Build Commands

```bash
# Build all packages
npm run build

# Build a single package
cd packages/core && npx tsup src/index.ts --format esm --dts --clean

# Run all tests
npm test

# Run tests for a specific package
cd packages/core && npx vitest run
```

### Publish to npm

Publish in dependency order:

```bash
cd packages/core && npm publish
cd packages/api && npm publish
cd packages/mcp && npm publish
cd packages/openclaw && npm publish
cd agenticmail && npm publish
```

All scoped packages have `"publishConfig": { "access": "public" }` configured.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

---

## Telemetry

AgenticMail collects **anonymous** usage statistics to help improve the product. We track:

- Tool call counts (which tools are popular)
- Package version and OS platform
- Anonymous install ID (random UUID, no personal data)

**We never collect** API keys, email content, addresses, or any personal information.

**Opt out** by setting the environment variable:

```bash
export AGENTICMAIL_TELEMETRY=0
# or
export DO_NOT_TRACK=1
```

Telemetry is also automatically disabled in CI environments.

## Troubleshooting

### OpenClaw plugin ID mismatch warning

```
plugin id mismatch (manifest uses "agenticmail", entry hints "openclaw")
```

This is harmless. OpenClaw infers the plugin ID from the npm package name (`@agenticmail/openclaw`) but the manifest declares `"id": "agenticmail"`. The plugin loads and works correctly.

### OpenClaw plugin path not found

If OpenClaw reports the plugin path not found, update `plugins.load.paths` in `~/.openclaw/openclaw.json` to point to the correct location:

```bash
npm prefix -g
# Plugin is at: <prefix>/lib/node_modules/@agenticmail/openclaw
```

### `agenticmail: command not found`

Use `npx agenticmail` for one-off usage, or install globally with `npm install -g agenticmail`.

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/agenticmail/agenticmail))
