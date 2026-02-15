# AgenticMail

Email infrastructure for AI agents. Send, receive, search, and manage real email programmatically.

AgenticMail gives your AI agents their own email addresses and full inbox management capabilities. It runs a local [Stalwart](https://stalw.art) mail server via Docker, provides a REST API, and integrates with [Claude](https://claude.ai) via MCP and [OpenClaw](https://github.com/openclaw/openclaw) via plugin.

## Features

- **Full email lifecycle** — send, receive, reply, forward, search, organize with folders and tags
- **Multi-agent** — each agent gets its own email address and inbox
- **Two gateway modes** for internet email:
  - **Relay mode** (easy) — use your existing Gmail/Outlook account
  - **Domain mode** (advanced) — custom domain with DKIM, SPF, DMARC, Cloudflare Tunnel
- **Security built-in** — outbound guard blocks sensitive data leaks, spam filter scores inbound mail
- **Real-time events** — SSE streaming for instant inbox notifications
- **Agent-to-agent communication** — tasks, RPC, and direct messaging between agents
- **MCP server** — use email from Claude Code and Claude Desktop
- **OpenClaw plugin** — add email capabilities to any OpenClaw agent
- **Interactive CLI** — 35+ shell commands for managing agents and email

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Docker](https://docker.com) (for the Stalwart mail server)

### Install

```bash
npm install agenticmail
```

### Setup

```bash
# Start the mail server
docker compose up -d

# Run the setup wizard
npx agenticmail setup

# Start the API server + interactive shell
npx agenticmail start
```

### Send your first email

```typescript
import { AgenticMailClient } from 'agenticmail';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3100',
  apiKey: 'your-agent-api-key',
});

await client.send({
  to: 'someone@example.com',
  subject: 'Hello from my AI agent',
  text: 'This email was sent by an AI agent using AgenticMail.',
});
```

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │                 AgenticMail                  │
                  │                                             │
 Claude ──MCP──>  │  @agenticmail/mcp                           │
                  │       │                                     │
 OpenClaw ─────>  │  @agenticmail/openclaw                      │
                  │       │                                     │
                  │       ▼                                     │
                  │  @agenticmail/api  (Express REST API)       │
                  │       │                                     │
                  │       ▼                                     │
                  │  @agenticmail/core                          │
                  │    ├── Accounts (agent management)          │
                  │    ├── Mail (SMTP send, IMAP receive)       │
                  │    ├── Inbox (IMAP IDLE watcher)            │
                  │    ├── Gateway (relay + domain modes)       │
                  │    ├── Spam Filter (rule-based scoring)     │
                  │    └── Outbound Guard (data leak prevention)│
                  │       │                                     │
                  │       ▼                                     │
                  │  Stalwart Mail Server (Docker)              │
                  └─────────────────────────────────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼                           ▼
     Relay Mode                  Domain Mode
   (Gmail/Outlook)          (Custom domain via
                             Cloudflare Tunnel)
```

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`agenticmail`](./agenticmail) | CLI and facade — install this for quick start | [![npm](https://img.shields.io/npm/v/agenticmail)](https://www.npmjs.com/package/agenticmail) |
| [`@agenticmail/core`](./packages/core) | SDK — accounts, mail, gateway, spam filter | [![npm](https://img.shields.io/npm/v/@agenticmail/core)](https://www.npmjs.com/package/@agenticmail/core) |
| [`@agenticmail/api`](./packages/api) | REST API server (Express) | [![npm](https://img.shields.io/npm/v/@agenticmail/api)](https://www.npmjs.com/package/@agenticmail/api) |
| [`@agenticmail/mcp`](./packages/mcp) | MCP server for Claude Code / Claude Desktop | [![npm](https://img.shields.io/npm/v/@agenticmail/mcp)](https://www.npmjs.com/package/@agenticmail/mcp) |
| [`@agenticmail/openclaw`](./packages/openclaw) | OpenClaw plugin and skill | [![npm](https://img.shields.io/npm/v/@agenticmail/openclaw)](https://www.npmjs.com/package/@agenticmail/openclaw) |

## Gateway Modes

### Relay Mode (Beginner-Friendly)

Use your existing Gmail or Outlook account as a relay. Emails send as `yourname+agent@gmail.com`. No domain purchase needed.

```bash
# In the interactive shell:
/relay
```

### Domain Mode (Advanced)

Full custom domain setup with Cloudflare. Agents send from `agent@yourdomain.com` with DKIM signing.

- Automatic DNS configuration (MX, SPF, DKIM, DMARC)
- Cloudflare Tunnel for secure inbound traffic
- Email Worker for Cloudflare Email Routing
- Optional Gmail SMTP outbound relay

## MCP Integration (Claude)

Add to your Claude Code or Claude Desktop config:

```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "npx",
      "args": ["agenticmail-mcp"],
      "env": {
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3100",
        "AGENTICMAIL_API_KEY": "your-agent-api-key"
      }
    }
  }
}
```

49 tools available including `send_email`, `list_inbox`, `read_email`, `search_emails`, `reply_email`, `manage_contacts`, `manage_drafts`, and more.

## OpenClaw Integration

```bash
# Install the plugin
openclaw plugin install agenticmail
```

33 tools available for sending, receiving, searching, and managing email from any OpenClaw agent.

## Interactive Shell

```
agenticmail> /help

  /inbox     Check inbox (arrow keys, previews, inline read)
  /send      Send email
  /reply     Reply to email
  /search    Search emails
  /agents    List all agents
  /switch    Switch active agent
  /spam      View spam folder
  /rules     Manage email rules
  /pending   View blocked outbound emails
  /relay     Configure email relay
  /setup     Setup wizard
  ... and 25+ more commands
```

## API

75+ REST endpoints under `/api/agenticmail/`. Key endpoints:

```
POST   /mail/send              Send email
GET    /mail/inbox              List inbox
GET    /mail/messages/:uid      Read email
POST   /mail/search             Search emails
GET    /events                  SSE event stream
POST   /accounts                Create agent
POST   /gateway/relay           Setup relay mode
POST   /gateway/domain          Setup domain mode
POST   /tasks/rpc               Agent-to-agent RPC
```

See the [API package README](./packages/api) for full endpoint documentation.

## Security

- **Outbound guard** — scans outgoing emails for API keys, passwords, PII, and other sensitive data. Blocks and requires human approval.
- **Spam filter** — rule-based scoring for inbound email (phishing, scam, malware detection)
- **Human approval flow** — blocked emails require master key holder approval (via API or email reply)
- **DKIM/SPF/DMARC** — automatic DNS setup in domain mode

## Development

```bash
git clone https://github.com/agenticmail/agenticmail.git
cd agenticmail
npm install
docker compose up -d
npm run build
npm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
