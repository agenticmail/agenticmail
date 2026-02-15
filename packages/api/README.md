# @agenticmail/api

REST API server for [AgenticMail](https://github.com/agenticmail/agenticmail) — 75+ endpoints for managing AI agent email accounts, sending/receiving email, real-time events, inter-agent tasks, and gateway configuration.

Built on Express with Bearer token authentication, SSE streaming, rate limiting, spam filtering, and outbound security scanning.

## Install

```bash
npm install @agenticmail/api
```

**Requirements:** Node.js 20+, `@agenticmail/core`, Stalwart Mail Server running

---

## Quick Start

```typescript
import { createApp } from '@agenticmail/api';

const app = await createApp({
  masterKey: 'mk_your_master_key',
  smtp: { host: 'localhost', port: 587 },
  imap: { host: 'localhost', port: 143 },
  stalwart: { url: 'http://localhost:8080', user: 'admin', pass: 'changeme' },
  dataDir: '~/.agenticmail',
});

app.listen(3100, () => {
  console.log('AgenticMail API running on http://127.0.0.1:3100');
});
```

---

## Authentication

All endpoints (except `/health` and `/mail/inbound`) require Bearer token authentication:

```
Authorization: Bearer mk_your_master_key    # Master key — full admin access
Authorization: Bearer ak_agent_key_here     # Agent key — scoped to that agent
```

| Auth Level | Can Do |
|------------|--------|
| **Master** | Create/delete agents, approve/reject blocked emails, configure gateway, all agent operations |
| **Agent** | Read own inbox, send email, manage own drafts/contacts/tags/rules/signatures/templates, claim tasks |
| **Both** | Endpoints accessible with either key type |

---

## Endpoints

All routes prefixed with `/api/agenticmail`.

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Server health check with Stalwart connectivity status |

### Mail Operations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mail/send` | Agent | Send email (text, HTML, attachments, CC, BCC, reply-to). Runs outbound guard scan. |
| `GET` | `/mail/inbox` | Agent | List inbox messages with metadata (from, subject, date, flags, uid). Supports `?limit=N&page=N`. |
| `GET` | `/mail/digest` | Agent | List inbox with body preview text (first ~200 chars of each email). |
| `GET` | `/mail/messages/:uid` | Agent | Read full message — headers, body (text + HTML), attachments metadata, spam score. |
| `GET` | `/mail/messages/:uid/attachments/:index` | Agent | Download attachment by index (binary response). |
| `GET` | `/mail/messages/:uid/spam-score` | Agent | Get spam analysis for a specific message. |
| `POST` | `/mail/search` | Agent | Search by from, to, subject, body text, date range, seen/unseen. |
| `DELETE` | `/mail/messages/:uid` | Agent | Delete message (moves to Trash). |
| `POST` | `/mail/messages/:uid/move` | Agent | Move message to a folder. Body: `{ "folder": "Archive" }` |
| `POST` | `/mail/messages/:uid/seen` | Agent | Mark message as read. |
| `POST` | `/mail/messages/:uid/unseen` | Agent | Mark message as unread. |
| `POST` | `/mail/messages/:uid/spam` | Agent | Report as spam (moves to Spam folder). |
| `POST` | `/mail/messages/:uid/not-spam` | Agent | Unmark as spam (moves back to INBOX). |
| `GET` | `/mail/folders` | Agent | List all IMAP folders with message counts. |
| `GET` | `/mail/folders/:folder` | Agent | List messages in a specific folder. |
| `POST` | `/mail/folders` | Agent | Create a new folder. Body: `{ "name": "Projects" }` |
| `POST` | `/mail/import-relay` | Agent | Import a message from relay account by UID. |

### Batch Operations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mail/batch/read` | Agent | Mark multiple messages as read. Body: `{ "uids": [1, 2, 3] }` |
| `POST` | `/mail/batch/seen` | Agent | Mark multiple as seen. |
| `POST` | `/mail/batch/unseen` | Agent | Mark multiple as unseen. |
| `POST` | `/mail/batch/delete` | Agent | Delete multiple messages. |
| `POST` | `/mail/batch/move` | Agent | Move multiple messages. Body: `{ "uids": [1,2], "folder": "Archive" }` |

### Pending Outbound (Blocked Emails — Human-Only Approval)

Agents **cannot** approve or reject their own blocked emails. Only the master key holder (human) can approve or reject. When an email is blocked, the owner receives a notification email with the full content, security warnings, and pending ID.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/mail/pending` | Both | List blocked outbound emails. Master sees all; agent sees only own. |
| `GET` | `/mail/pending/:id` | Both | Get specific pending email details. Master can view any; agent can only view own. |
| `POST` | `/mail/pending/:id/approve` | Master | Approve and send the blocked email. **Master key required** — agent keys are rejected with 403. |
| `POST` | `/mail/pending/:id/reject` | Master | Reject and discard the blocked email. **Master key required** — agent keys are rejected with 403. |

### Spam

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/mail/spam` | Agent | List spam/suspicious emails with scores and categories. |

### Events (SSE)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/events` | Agent | Server-Sent Events stream. Emits `new`, `expunge`, `flags`, `error`, `task` events. Max 5 connections per agent. |

**Event types:**
- `connected` — SSE connection established
- `new` — new email arrived (includes uid, subject, from, spam info if applicable)
- `expunge` — email deleted
- `flags` — flags changed (read/unread)
- `error` — watcher error
- `task` — new task assigned to this agent

### Accounts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/accounts` | Master | Create agent. Body: `{ "name": "researcher", "role": "researcher" }` |
| `GET` | `/accounts` | Master | List all agents with full metadata. |
| `GET` | `/accounts/me` | Agent | Get current agent info. |
| `PATCH` | `/accounts/me` | Agent | Update own metadata. Body: `{ "metadata": { "ownerName": "John" } }` |
| `GET` | `/accounts/:id` | Master | Get specific agent by ID. |
| `DELETE` | `/accounts/:id` | Master | Delete agent (archives emails, removes Stalwart principal). |
| `GET` | `/accounts/directory` | Both | List agents with basic info (name, email, role). |
| `GET` | `/accounts/directory/:name` | Both | Resolve agent by name. |
| `PATCH` | `/accounts/:id/persistent` | Master | Mark/unmark as persistent (exempt from cleanup). |
| `POST` | `/accounts/cleanup` | Master | Clean up inactive agents (keeps persistent ones). |
| `GET` | `/accounts/inactive` | Master | List inactive agents. |
| `GET` | `/accounts/deletions` | Master | List past deletion reports. |
| `GET` | `/accounts/deletions/:id` | Master | View specific deletion report. |

### Tasks (Inter-Agent Communication)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/tasks/assign` | Both | Assign task to agent. Body: `{ "assignee": "researcher", "taskType": "lookup", "payload": {...} }` |
| `POST` | `/tasks/rpc` | Both | Synchronous RPC call (long-poll up to 5 min). Body: `{ "target": "researcher", "task": "lookup prices", "timeout": 180 }` |
| `GET` | `/tasks/pending` | Agent | List tasks assigned to current agent. Supports `?assignee=name`. |
| `GET` | `/tasks/assigned` | Both | List tasks assigned by current agent. |
| `GET` | `/tasks/:id` | Both | Get task details. |
| `POST` | `/tasks/:id/claim` | Agent | Claim task (pending → claimed). |
| `POST` | `/tasks/:id/result` | Agent | Submit result (claimed → completed). Body: `{ "result": {...} }` |
| `POST` | `/tasks/:id/fail` | Agent | Fail task (claimed → failed). Body: `{ "error": "reason" }` |

### Gateway

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/gateway/setup-guide` | Both | Get setup guide with relay vs domain mode comparison. |
| `GET` | `/gateway/status` | Both | Current mode, relay provider, domain, tunnel status. |
| `POST` | `/gateway/relay` | Master | Setup relay mode (Gmail/Outlook). |
| `POST` | `/gateway/domain` | Master | Setup domain mode (Cloudflare). |
| `POST` | `/gateway/domain/alias-setup` | Master | Get Gmail "Send mail as" alias instructions. |
| `POST` | `/gateway/domain/purchase` | Master | Search/purchase domain. |
| `POST` | `/gateway/test` | Both | Send test email through gateway. |
| `GET` | `/gateway/domain/dns` | Master | Get DNS records for configured domain. |
| `POST` | `/gateway/tunnel/start` | Master | Start Cloudflare Tunnel. |
| `POST` | `/gateway/tunnel/stop` | Master | Stop Cloudflare Tunnel. |

### Inbound Webhook

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mail/inbound` | Secret | Cloudflare Email Worker webhook. Auth via `X-Inbound-Secret` header (not Bearer token). Accepts base64-encoded raw email. |

### Features (Drafts, Contacts, Tags, Rules, Signatures, Templates, Scheduled)

Each feature module follows a standard CRUD pattern. See the route files for full details:
- `GET /drafts`, `POST /drafts`, `PUT /drafts/:id`, `DELETE /drafts/:id`, `POST /drafts/:id/send`
- `GET /contacts`, `POST /contacts`, `DELETE /contacts/:id`
- `GET /tags`, `POST /tags`, `DELETE /tags/:id`, tag-message operations
- `GET /rules`, `POST /rules`, `DELETE /rules/:id`
- `GET /signatures`, `POST /signatures`, `DELETE /signatures/:id`
- `GET /templates`, `POST /templates`, `DELETE /templates/:id`, `POST /templates/:id/send`
- `GET /scheduled`, `POST /scheduled`, `DELETE /scheduled/:id`

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTICMAIL_MASTER_KEY` | Yes | — | Master API key for admin access |
| `AGENTICMAIL_API_PORT` | No | `3100` | Port for the API server |
| `STALWART_URL` | No | `http://localhost:8080` | Stalwart admin URL |
| `STALWART_ADMIN_USER` | No | `admin` | Stalwart admin username |
| `STALWART_ADMIN_PASSWORD` | No | `changeme` | Stalwart admin password |
| `SMTP_HOST` | No | `localhost` | SMTP host |
| `SMTP_PORT` | No | `587` | SMTP port |
| `IMAP_HOST` | No | `localhost` | IMAP host |
| `IMAP_PORT` | No | `143` | IMAP port |
| `AGENTICMAIL_INBOUND_SECRET` | No | (default) | Secret for inbound webhook auth |

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
