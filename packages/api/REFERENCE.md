# @agenticmail/api — Technical Reference

Complete technical reference for the AgenticMail REST API server. All routes are prefixed with `/api/agenticmail` unless otherwise noted.

---

## Exports

The package exports a single factory function:

```typescript
import { createApp } from '@agenticmail/api';
```

### `createApp(options): Promise<Express>`

Creates and configures the Express application with all routes, middleware, and background services.

**Options:**
```typescript
{
  masterKey: string;
  smtp: { host: string; port: number };
  imap: { host: string; port: number };
  stalwart: { url: string; user: string; pass: string };
  dataDir: string;
}
```

**Returns:** Configured Express app ready to `.listen()`.

---

## Authentication

### Bearer Token Authentication

All endpoints (except `/health` and `/mail/inbound`) require:
```
Authorization: Bearer <token>
```

**Token types:**
| Prefix | Type | Scope |
|--------|------|-------|
| `mk_` | Master key | Full admin access |
| `ak_` | Agent key | Scoped to owning agent |

### Timing-Safe Comparison

Key comparison uses SHA-256 hashing + `timingSafeEqual`:
```typescript
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
```
This prevents timing side-channel attacks against key validation.

### Activity Throttling

Agent activity (`last_activity_at`) is updated at most once per 60 seconds per agent via an in-memory timestamp cache. SQL: `UPDATE agents SET last_activity_at = datetime('now') WHERE id = ?`

### Auth Guard Functions

| Function | Behavior |
|----------|----------|
| `requireMaster()` | Returns 403 if `!req.isMaster` |
| `requireAuth()` | Returns 403 if `!req.agent && !req.isMaster` |
| `requireAgent()` | Returns 403 if `!req.agent` (master alone insufficient) |

---

## Middleware Stack

Applied in this order:

1. **CORS** — `cors()` with default options (all origins)
2. **JSON Body Parser** — `express.json({ limit: '10mb' })`
3. **Global Rate Limiter** — 100 requests per IP per 60-second window
4. **Health routes** — mounted before auth (no auth required)
5. **Inbound webhook** — mounted before auth (uses `X-Inbound-Secret`)
6. **Auth middleware** — Bearer token validation
7. **Protected routes** — all remaining routes
8. **404 handler** — `{ error: 'Not found' }`
9. **Error handler** — categorizes errors by message pattern

### Error Handler

Maps errors to HTTP status codes:

| Status | Trigger |
|--------|---------|
| 400 | `SyntaxError` with `.status === 400` (malformed JSON) |
| 400 | Message contains "invalid", "required", or "must " |
| 404 | Message contains "not found" (but not "not found a") |
| 409 | Message contains "already exists" or "unique constraint" |
| Custom | `err.statusCode` property (if set) |
| 500 | Default fallback (response: `{ error: 'Internal server error' }`) |

---

## Routes: Health

### GET /health

**Auth:** None

**Response (200):**
```json
{
  "status": "ok",
  "services": { "api": "ok", "stalwart": "ok" },
  "timestamp": "ISO-8601"
}
```

**Response (503):** Stalwart unreachable → `{ "status": "degraded", "services": { "api": "ok", "stalwart": "unreachable" } }`

---

## Routes: Mail Operations

### Connection Caching

| Parameter | Value |
|-----------|-------|
| `CACHE_TTL_MS` | 600,000 (10 minutes) |
| `MAX_CACHE_SIZE` | 100 entries |
| Eviction interval | 60 seconds |
| Sender cache key | `${stalwartPrincipal}:${fromEmail}` |
| Receiver cache key | `${stalwartPrincipal}` |
| Concurrent dedup | `receiverPending: Map<string, Promise<MailReceiver>>` |
| Draining flag | Prevents new connections during shutdown |

### POST /mail/send

**Auth:** Agent (`requireAgent`)

**Request Body:**
```json
{
  "to": "string | string[]",       // Required
  "subject": "string",             // Required
  "text": "string",                // Optional
  "html": "string",                // Optional
  "cc": "string | string[]",       // Optional
  "bcc": "string | string[]",      // Optional
  "replyTo": "string",             // Optional
  "inReplyTo": "string",           // Optional (Message-ID for threading)
  "references": "string[]",        // Optional (thread chain)
  "attachments": [{                // Optional
    "filename": "string",
    "contentType": "string",
    "content": "Buffer | string",
    "encoding": "string"
  }],
  "allowSensitive": "boolean"      // Optional (master bypass only)
}
```

**Outbound Guard Flow:**
1. Master key + `allowSensitive: true` → bypasses all scanning
2. Agent key → `scanOutboundEmail()` always runs regardless of `allowSensitive`
3. If blocked → stored in `pending_outbound`, notification sent to owner
4. If allowed (with warnings) → sent with `outboundWarnings` in response
5. If clean → sent normally

**Blocked Email Storage:**
```sql
INSERT INTO pending_outbound (id, agent_id, mail_options, warnings, summary, status, created_at)
VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
```

**Notification Email:**
- To: `gatewayConfig.relay.email` (owner's relay address)
- Subject: `[Approval Required] Blocked email from "{agentName}" — "{subject}"`
- Body: Full email preview, all security warnings, pending ID, reply instructions
- Reply detection keywords: approve/yes/lgtm/go ahead/send/ok (approve), reject/no/deny/cancel/block (reject)

**Display Name Logic:**
- If `agent.metadata.ownerName`: `"${agent.name} from ${ownerName}"`
- Else: `agent.name`

**Routing Priority:**
1. Try `gatewayManager.routeOutbound(agentName, mailOpts)`
2. Fallback to local SMTP via `getSender()`
3. Best-effort save to Sent folder

**Response (200):**
```json
{
  "sent": true,
  "messageId": "string",
  "timestamp": "ISO-8601",
  "outboundWarnings": [...],     // Optional
  "outboundSummary": "string"    // Optional
}
```

**Response (blocked):**
```json
{
  "sent": false,
  "blocked": true,
  "pendingId": "uuid",
  "warnings": [...],
  "summary": "string"
}
```

---

### GET /mail/inbox

**Auth:** Agent

**Query Params:**
| Param | Default | Range |
|-------|---------|-------|
| `limit` | 20 | 1–200 |
| `offset` | 0 | 0+ |

**Response:**
```json
{
  "messages": [{
    "uid": 1,
    "subject": "string",
    "from": [{ "name": "string", "address": "string" }],
    "to": [{ "name": "string", "address": "string" }],
    "date": "ISO-8601",
    "flags": ["\\Seen", "\\Flagged"],
    "size": 1234
  }],
  "count": 20,
  "total": 150
}
```

---

### GET /mail/digest

**Auth:** Agent

**Query Params:**
| Param | Default | Range |
|-------|---------|-------|
| `limit` | 20 | 1–50 |
| `offset` | 0 | 0+ |
| `previewLength` | 200 | 50–500 |
| `folder` | "INBOX" | any valid folder |

**Response:** Same as inbox but each message includes `"preview": "First N chars..."`.

---

### GET /mail/messages/:uid

**Auth:** Agent

**Query Params:** `folder` (default: "INBOX")

**Response:**
```json
{
  "uid": 1,
  "subject": "string",
  "from": [...],
  "to": [...],
  "cc": [...],
  "date": "ISO-8601",
  "messageId": "string",
  "inReplyTo": "string",
  "references": "string",
  "text": "string",
  "html": "string",
  "attachments": [{
    "filename": "string",
    "contentType": "string",
    "size": 1234
  }],
  "security": {
    "internal": false,
    "spamScore": 0,
    "isSpam": false,
    "isWarning": false,
    "topCategory": "string | null",
    "matches": ["ruleId", ...],
    "sanitized": false,
    "sanitizeDetections": [...]
  }
}
```

**Spam scoring logic:**
- Internal emails (agent-to-agent on same system) → skip scoring, return `spamScore: 0`
- External emails → `scoreEmail(parsed)` + `sanitizeEmailContent()`

---

### GET /mail/messages/:uid/attachments/:index

**Auth:** Agent

**Path Params:** `uid` (integer), `index` (0-based)

**Query Params:** `folder` (default: "INBOX")

**Response:** Binary data with appropriate `Content-Type`, `Content-Disposition`, `Content-Length` headers.

**Status:** 404 if attachment not found.

---

### GET /mail/messages/:uid/spam-score

**Auth:** Agent

**Response:**
```json
{
  "score": 0,
  "isSpam": false,
  "isWarning": false,
  "matches": [],
  "topCategory": null,
  "internal": true
}
```

---

### POST /mail/search

**Auth:** Agent

**Request Body:**
```json
{
  "from": "string",           // Optional
  "to": "string",             // Optional
  "subject": "string",        // Optional
  "text": "string",           // Optional (body text)
  "since": "ISO-8601",        // Optional
  "before": "ISO-8601",       // Optional
  "seen": true,               // Optional (true=read, false=unread)
  "searchRelay": false         // Optional (also search relay account)
}
```

**Response:**
```json
{
  "uids": [1, 2, 3],
  "relayResults": [{           // Only if searchRelay=true
    "uid": 1,
    "source": "relay",
    "account": "email@gmail.com",
    "messageId": "string",
    "subject": "string",
    "from": [...],
    "to": [...],
    "date": "ISO-8601",
    "flags": [...]
  }]
}
```

---

### POST /mail/import-relay

**Auth:** Agent

**Request Body:** `{ "uid": 123 }`

**Response:** `{ "ok": true, "message": "Email imported to local inbox." }`

**Status:** 400 if no gateway or import failed.

---

### DELETE /mail/messages/:uid

**Auth:** Agent

**Response:** 204 (no content)

---

### POST /mail/messages/:uid/seen

**Auth:** Agent

**Response:** `{ "ok": true }`

---

### POST /mail/messages/:uid/unseen

**Auth:** Agent

**Response:** `{ "ok": true }`

---

### POST /mail/messages/:uid/move

**Auth:** Agent

**Request Body:** `{ "from": "INBOX", "to": "Archive" }`

**Response:** `{ "ok": true }`

---

### GET /mail/folders

**Auth:** Agent

**Response:** `{ "folders": ["INBOX", "Sent Items", "Drafts", ...] }`

---

### POST /mail/folders

**Auth:** Agent

**Request Body:** `{ "name": "Projects" }`

**Validation:** Name <= 200 chars, no `\`, `*`, `%` characters.

**Response:** `{ "ok": true, "folder": "Projects" }`

---

### GET /mail/folders/:folder

**Auth:** Agent

**Query Params:** `limit` (1–200, default 20), `offset` (0+)

**Response:**
```json
{
  "messages": [...],
  "count": 20,
  "total": 150,
  "folder": "Archive"
}
```

---

## Routes: Batch Operations

All batch endpoints require Agent auth. Max 1000 UIDs per request. All UIDs must be positive integers.

### POST /mail/batch/delete

**Request:** `{ "uids": [1, 2, 3], "folder": "INBOX" }`

**Response:** `{ "ok": true, "deleted": 3 }`

### POST /mail/batch/seen

**Request:** `{ "uids": [1, 2, 3], "folder": "INBOX" }`

**Response:** `{ "ok": true, "marked": 3 }`

### POST /mail/batch/unseen

**Request:** `{ "uids": [1, 2, 3], "folder": "INBOX" }`

**Response:** `{ "ok": true, "marked": 3 }`

### POST /mail/batch/move

**Request:** `{ "uids": [1, 2, 3], "from": "INBOX", "to": "Archive" }`

**Response:** `{ "ok": true, "moved": 3 }`

### POST /mail/batch/read

**Request:** `{ "uids": [1, 2, 3], "folder": "INBOX" }`

**Response:** `{ "messages": [{uid, subject, from, to, text, html, ...}], "count": 3 }`

---

## Routes: Spam

### GET /mail/spam

**Auth:** Agent

**Query Params:** `limit` (1–200, default 20), `offset` (0+)

**Response:** Same structure as folder listing (messages from Spam folder).

### POST /mail/messages/:uid/spam

**Auth:** Agent

**Request:** `{ "folder": "INBOX" }` (optional, source folder)

Creates Spam folder if needed, moves message there.

**Response:** `{ "ok": true, "movedToSpam": true }`

### POST /mail/messages/:uid/not-spam

**Auth:** Agent

Moves message from Spam to INBOX.

**Response:** `{ "ok": true, "movedToInbox": true }`

---

## Routes: Pending Outbound (Human-Only Approval)

### GET /mail/pending

**Auth:** Both (agent sees own, master sees all)

**Response:**
```json
{
  "pending": [{
    "id": "uuid",
    "agentId": "uuid",
    "to": "string | string[]",
    "subject": "string",
    "warnings": [...],
    "summary": "string",
    "status": "pending | approved | rejected",
    "createdAt": "datetime",
    "resolvedAt": "datetime | null",
    "resolvedBy": "master | null"
  }],
  "count": 5
}
```

### GET /mail/pending/:id

**Auth:** Both (agent sees own only, master sees any)

**Response:** Full pending email details including `mailOptions`.

### POST /mail/pending/:id/approve

**Auth:** Master only (403 for agent keys)

**Flow:**
1. Look up pending email, verify status is "pending"
2. Look up originating agent
3. Re-parse stored `mailOptions` from JSON
4. Refresh `fromName` from current agent metadata
5. Reconstitute Buffer objects (attachments)
6. Send via gateway first, fallback to local SMTP
7. Update: `status = 'approved'`, `resolved_at = datetime('now')`, `resolved_by = 'master'`

**Response:** `{ "sent": true, "messageId": "...", "approved": true, "pendingId": "uuid" }`

### POST /mail/pending/:id/reject

**Auth:** Master only (403 for agent keys)

Updates: `status = 'rejected'`, `resolved_at = datetime('now')`, `resolved_by = 'master'`

**Response:** `{ "ok": true, "rejected": true, "pendingId": "uuid" }`

---

## Routes: Events (SSE)

### GET /events

**Auth:** Agent (`requireAgent`)

**Connection Limit:** 5 per agent (returns 429 if exceeded)

**SSE Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Keepalive:** `: ping\n\n` every 30 seconds

### Event Types

**`connected`**
```json
{ "type": "connected", "agentId": "uuid" }
```

**`new`** — New email received
```json
{
  "type": "new",
  "uid": 123,
  "subject": "string",
  "from": [{ "name": "string", "address": "string" }],
  "date": "ISO-8601",
  "spam": {                    // Only for external emails flagged as spam
    "score": 75,
    "isSpam": true,
    "topCategory": "phishing",
    "matches": ["ruleId"],
    "movedToSpam": true
  },
  "warning": {                 // Only for elevated-score external emails
    "score": 40,
    "isWarning": true,
    "topCategory": "link_analysis",
    "matches": ["ruleId"]
  },
  "rule": {                    // Only if an email rule matched
    "ruleId": "uuid",
    "ruleName": "Auto-archive newsletters",
    "actions": { "move_to": "Archive" }
  }
}
```

**Processing order for new emails:**
1. Relay detection (check `X-AgenticMail-Relay` header)
2. Internal check (skip spam filter for agent-to-agent)
3. Spam scoring → auto-move to Spam if threshold exceeded
4. Rule evaluation → first matching rule's actions execute
5. Event pushed to all agent's SSE connections

**`expunge`** — Message deleted
```json
{ "type": "expunge", "uid": 123 }
```

**`flags`** — Flags changed
```json
{ "type": "flags", "uid": 123, "flags": ["\\Seen"] }
```

**`error`** — IMAP connection error
```json
{ "type": "error", "message": "Connection lost" }
```

**`task`** — Task assigned (pushed via `pushEventToAgent()`)
```json
{ "type": "task", "taskId": "uuid", "taskType": "string", "from": "agentName" }
```

### Helper Functions

| Function | Purpose |
|----------|---------|
| `pushEventToAgent(agentId, event)` | Push event to specific agent's SSE connections |
| `broadcastEvent(event)` | Push event to ALL active SSE connections |
| `closeAllWatchers()` | Stop all watchers, clear all connections (shutdown) |

---

## Routes: Accounts

### POST /accounts

**Auth:** Master

**Request Body:**
```json
{
  "name": "string",          // Required, max 64 chars, /^[a-zA-Z0-9._-]+$/
  "domain": "string",        // Optional
  "password": "string",      // Optional (auto-generated if omitted)
  "metadata": {},            // Optional (object, _prefixed keys stripped)
  "role": "string",          // Optional (must be in AGENT_ROLES)
  "persistent": true         // Optional (first agent auto-persistent)
}
```

**Response (201):** Sanitized agent object (internal `_`-prefixed metadata stripped)

### GET /accounts

**Auth:** Master

**Response:** `{ "agents": [Agent, ...] }`

### GET /accounts/directory

**Auth:** Both

**Response:** `{ "agents": [{ "name": "...", "email": "...", "role": "..." }] }`

### GET /accounts/directory/:name

**Auth:** Both

**Response:** `{ "name", "email", "role" }` or 404

### GET /accounts/me

**Auth:** Agent (`requireAgent`)

**Response:** Sanitized agent object

### PATCH /accounts/me

**Auth:** Agent

**Request:** `{ "metadata": { "ownerName": "John" } }`

**Response:** Updated agent

### GET /accounts/:id

**Auth:** Master

**Response:** Sanitized agent or 404

### DELETE /accounts/:id

**Auth:** Master

**Query Params:**
- `archive` (default: true) — archive emails before deletion
- `reason` — deletion reason
- `deletedBy` (default: "api")

**Validation:** Cannot delete last remaining agent (400).

**Response:** Deletion summary (if archive=true) or 204

### PATCH /accounts/:id/persistent

**Auth:** Master

**Request:** `{ "persistent": true }`

**Response:** `{ "ok": true, "persistent": true }`

### GET /accounts/inactive

**Auth:** Master

**Query Params:** `hours` (default: 24, min: 1)

Uses `COALESCE(last_activity_at, created_at)` so new agents aren't flagged.

**Response:** `{ "agents": [...], "count": 3 }`

### POST /accounts/cleanup

**Auth:** Master

**Request:** `{ "hours": 24, "dryRun": false }`

**Response:** `{ "deleted": ["agent1"], "count": 1, "dryRun": false }`

### GET /accounts/deletions

**Auth:** Master

**Response:** `{ "deletions": [DeletionReport, ...] }`

### GET /accounts/deletions/:id

**Auth:** Master

**Response:** Full deletion report or 404

---

## Routes: Tasks

### POST /tasks/assign

**Auth:** Both

**Request Body:**
```json
{
  "assignee": "string",           // Required (agent name)
  "taskType": "string",           // Optional (default: "generic")
  "payload": {},                  // Optional
  "expiresInSeconds": 3600        // Optional
}
```

**Notification cascade:**
1. SSE push to assignee via `pushEventToAgent()`
2. Broadcast to all SSE if no direct watcher
3. Email notification (fire-and-forget)

**Response (201):**
```json
{ "id": "uuid", "assignee": "name", "assigneeId": "uuid", "status": "pending" }
```

### GET /tasks/pending

**Auth:** Agent

**Query Params:** `assignee` (optional — check different agent's tasks)

**Response:** `{ "tasks": [...], "count": 5 }`

### GET /tasks/assigned

**Auth:** Both

**Response:** Tasks assigned BY current user (limit 50)

### GET /tasks/:id

**Auth:** Both

**Response:** Full task object with parsed payload/result

### POST /tasks/:id/claim

**Auth:** Agent

Updates: `pending → claimed`, sets `claimed_at`.

Capability-based: any agent with task ID can claim (supports sub-agents).

**Response:** Claimed task object or 404

### POST /tasks/:id/result

**Auth:** Agent

**Request:** `{ "result": {} }`

Updates: `claimed → completed`, stores result, sets `completed_at`.

**Instant RPC wake:** If assigner is long-polling via `/tasks/rpc`, resolver is called immediately.

**Response:** `{ "ok": true, "taskId": "...", "status": "completed" }`

### POST /tasks/:id/fail

**Auth:** Agent

**Request:** `{ "error": "reason" }`

Updates: `claimed → failed`, stores error, sets `completed_at`.

**Response:** `{ "ok": true, "taskId": "...", "status": "failed" }`

### POST /tasks/rpc

**Auth:** Both

**Request Body:**
```json
{
  "target": "string",        // Required (agent name)
  "task": "string",          // Required (task description)
  "payload": {},             // Optional
  "timeout": 180             // Optional (5–300 seconds, default 180)
}
```

**Mechanism:**
1. Creates task with `task_type = 'rpc'`
2. Disables socket timeout: `req.socket.setTimeout(0)`
3. Pushes SSE event + email notification
4. Registers resolver in `rpcResolvers: Map<string, Function>`
5. Polls every 2 seconds as fallback
6. When `/result` or `/fail` called → resolver fires instantly

**Response:**
```json
{
  "taskId": "uuid",
  "status": "completed | failed | timeout | disconnected",
  "result": {},              // If completed
  "error": "string",         // If failed
  "message": "string"        // If timeout
}
```

---

## Routes: Gateway

### GET /gateway/setup-guide

**Auth:** Master

Returns comparison of relay mode vs domain mode with pros/cons and requirements.

### GET /gateway/status

**Auth:** Master

Returns current gateway configuration and status.

### POST /gateway/relay

**Auth:** Master

**Request Body:**
```json
{
  "provider": "gmail | outlook | custom",  // Default: "custom"
  "email": "string",                       // Required
  "password": "string",                    // Required (app password)
  "smtpHost": "string",                   // Optional (preset for gmail/outlook)
  "smtpPort": 465,                        // Optional
  "imapHost": "string",                   // Optional
  "imapPort": 993,                        // Optional
  "agentName": "string",                  // Optional (auto-create agent)
  "agentRole": "string",                  // Optional
  "skipDefaultAgent": false               // Optional
}
```

**Provider Presets:**
- Gmail: `smtp.gmail.com:465`, `imap.gmail.com:993`
- Outlook: `smtp-mail.outlook.com:587`, `outlook.office365.com:993`

**Response:**
```json
{
  "status": "ok",
  "mode": "relay",
  "email": "you@gmail.com",
  "provider": "gmail",
  "agent": {
    "id": "uuid",
    "name": "secretary",
    "email": "secretary@local",
    "apiKey": "ak_...",
    "role": "admin",
    "subAddress": "you+secretary@gmail.com"
  }
}
```

### POST /gateway/domain

**Auth:** Master

**Request Body:**
```json
{
  "cloudflareToken": "string",       // Required
  "cloudflareAccountId": "string",   // Required
  "domain": "string",               // Optional (use existing)
  "purchase": {},                    // Optional (buy new domain)
  "gmailRelay": {                   // Optional (Gmail for outbound)
    "email": "string",
    "appPassword": "string"
  }
}
```

### POST /gateway/domain/alias-setup

**Auth:** Master

**Request:** `{ "agentEmail": "secretary@yourdomain.com", "agentDisplayName": "Secretary" }`

Returns step-by-step Gmail "Send mail as" alias instructions with SMTP settings:
- Server: `smtp.gmail.com`
- Port: 465
- Security: SSL

### GET /gateway/domain/payment-setup

**Auth:** Master

Returns Cloudflare payment method setup instructions.

### POST /gateway/domain/purchase

**Auth:** Master

**Request:** `{ "keywords": ["mycompany"], "tld": "com" }`

**Response:** `{ "domains": [{ "domain": "...", "price": "..." }] }`

### GET /gateway/domain/dns

**Auth:** Master

**Response:** `{ "domain": "...", "dns": [...] }`

### POST /gateway/tunnel/start

**Auth:** Master

**Response:** `{ "status": "ok", "tunnel": {...} }`

### POST /gateway/tunnel/stop

**Auth:** Master

**Response:** `{ "status": "ok", "tunnel": {...} }`

### POST /gateway/test

**Auth:** Master

**Request:** `{ "to": "test@example.com" }`

**Response:** `{ "status": "ok", "messageId": "..." }` or 400 if no gateway

---

## Routes: Domains

### POST /domains

**Auth:** Master

**Request:** `{ "domain": "yourdomain.com" }`

**Response (201):** Setup result from `DomainManager`

### GET /domains

**Auth:** Master

**Response:** `{ "domains": [...] }`

### GET /domains/:domain/dns

**Auth:** Master

**Response:** `{ "records": [...] }`

### POST /domains/:domain/verify

**Auth:** Master

**Response:** `{ "domain": "...", "verified": true }`

### DELETE /domains/:domain

**Auth:** Master

**Response:** 204 or 404

---

## Routes: Inbound Webhook

### POST /mail/inbound

**Auth:** `X-Inbound-Secret` header (NOT Bearer token)

**Default secret:** `inbound_2sabi_secret_key` (configurable via `AGENTICMAIL_INBOUND_SECRET`)

**Request Body:**
```json
{
  "from": "sender@external.com",
  "to": "agentname@yourdomain.com",
  "subject": "string",
  "rawEmail": "base64-encoded-mime"
}
```

**Flow:**
1. Validate secret header
2. Extract local part from `to` address → agent lookup
3. Deduplication check: `gatewayManager.isAlreadyDelivered(messageId, agentName)`
4. Decode base64 → parse with `parseEmail()`
5. Deliver to agent's mailbox via SMTP (authenticated as agent)
6. Custom headers: `X-AgenticMail-Inbound: cloudflare-worker`, `X-Original-From`, `X-Original-Message-Id`
7. Preserve threading: `inReplyTo`, `references`
8. Record delivery: `gatewayManager.recordDelivery(messageId, agentName)`

**Response:** `{ "ok": true, "delivered": "agent@domain.com" }`

**Duplicate Response:** `{ "ok": true, "delivered": "agent@domain.com", "duplicate": true }`

---

## Routes: Features

### Contacts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/contacts` | Agent | List contacts (`ORDER BY name, email`) |
| `POST` | `/contacts` | Agent | Create/update contact. Body: `{ name, email, notes }` |
| `DELETE` | `/contacts/:id` | Agent | Delete contact |

SQL uses `INSERT OR REPLACE` — adding a contact with existing email updates it.

### Drafts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/drafts` | Agent | List drafts (`ORDER BY updated_at DESC`) |
| `POST` | `/drafts` | Agent | Create draft. Body: `{ to, subject, text, html, cc, bcc, inReplyTo, references }` |
| `PUT` | `/drafts/:id` | Agent | Update draft (all fields) |
| `DELETE` | `/drafts/:id` | Agent | Delete draft |
| `POST` | `/drafts/:id/send` | Agent | Send draft and delete it |

### Signatures

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/signatures` | Agent | List signatures (`ORDER BY is_default DESC, name`) |
| `POST` | `/signatures` | Agent | Create. Body: `{ name, text, html, isDefault }` |
| `DELETE` | `/signatures/:id` | Agent | Delete |

Setting `isDefault: true` automatically unsets all other signatures.

### Templates

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/templates` | Agent | List templates (`ORDER BY name`) |
| `POST` | `/templates` | Agent | Create. Body: `{ name, subject, text, html }` |
| `DELETE` | `/templates/:id` | Agent | Delete |
| `POST` | `/templates/:id/send` | Agent | Send from template |

**Template Send:**
```json
{
  "to": "string",           // Required
  "variables": {            // Optional
    "name": "John",
    "company": "Acme"
  },
  "cc": "string",
  "bcc": "string"
}
```
Replaces `{{ variableName }}` in subject and body with provided values.

### Scheduled Emails

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/scheduled` | Agent | List scheduled (`ORDER BY send_at ASC`) |
| `POST` | `/scheduled` | Agent | Schedule email |
| `DELETE` | `/scheduled/:id` | Agent | Cancel (pending only) |

**Schedule Request:**
```json
{
  "to": "string",           // Required
  "subject": "string",      // Required
  "text": "string",
  "html": "string",
  "cc": "string",
  "bcc": "string",
  "sendAt": "string"        // Required (see format list below)
}
```

**Supported `sendAt` formats:**
| Format | Example |
|--------|---------|
| ISO 8601 | `2026-02-14T10:00:00Z` |
| Relative | `in 30 minutes`, `in 2 hours` |
| Named | `tomorrow 8am`, `tomorrow 2pm` |
| Day of week | `next monday 9am`, `next friday 2pm` |
| MM-DD-YYYY | `02-14-2026 3:30 PM EST` |
| Casual | `tonight`, `this evening` (20:00) |

**Timezone abbreviations supported:** EST, EDT, CST, CDT, MST, MDT, PST, PDT, GMT, UTC, BST, CET, CEST, IST, JST, AEST, AEDT, NZST, NZDT, WAT, EAT, SAST, HKT, SGT, KST, HST, AKST, AKDT, AST, ADT, NST, NDT

### Tags

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tags` | Agent | List tags (`ORDER BY name`) |
| `POST` | `/tags` | Agent | Create. Body: `{ name, color }` (default color: `#888888`) |
| `DELETE` | `/tags/:id` | Agent | Delete tag |
| `POST` | `/tags/:id/messages` | Agent | Tag a message. Body: `{ uid, folder }` |
| `DELETE` | `/tags/:id/messages/:uid` | Agent | Untag. Query: `?folder=INBOX` |
| `GET` | `/tags/:id/messages` | Agent | List messages with tag |
| `GET` | `/messages/:uid/tags` | Agent | List tags on message |

### Email Rules

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/rules` | Agent | List rules (`ORDER BY priority DESC, created_at`) |
| `POST` | `/rules` | Agent | Create rule |
| `DELETE` | `/rules/:id` | Agent | Delete rule |

**Rule Request (201):**
```json
{
  "name": "Auto-archive newsletters",
  "conditions": {
    "from_contains": "newsletter",
    "from_exact": "news@example.com",
    "subject_contains": "weekly update",
    "subject_regex": "\\[Newsletter\\]",
    "to_contains": "list",
    "has_attachment": true
  },
  "actions": {
    "mark_read": true,
    "delete": false,
    "move_to": "Archive"
  },
  "priority": 10,
  "enabled": true
}
```

**Rule evaluation:** Runs on every new email (via SSE event handler). Rules checked by priority (highest first). First match wins. Conditions are case-insensitive. `subject_regex` uses JavaScript RegExp.

---

## Background Services

### Scheduled Email Sender

**Interval:** 30,000ms (30 seconds)

**Per cycle:**
1. Query: `SELECT * FROM scheduled_emails WHERE status = 'pending' AND send_at <= datetime('now')`
2. For each: look up agent, build mail options, send via gateway or SMTP
3. On success: `status = 'sent'`, `sent_at = datetime('now')`
4. On failure: `status = 'failed'`, `error = message`

**Housekeeping (runs each cycle):**
- `DELETE FROM delivered_messages WHERE delivered_at < datetime('now', '-30 days')`
- `DELETE FROM spam_log WHERE created_at < datetime('now', '-30 days')`

### Gateway Resume

On startup, calls `gatewayManager.resume()` to restore relay polling or domain tunnel from saved configuration.

---

## Shutdown Sequence

1. Set `shuttingDown = true`
2. Clear scheduled sender interval
3. `closeAllWatchers()` — stop all SSE watchers and IMAP connections
4. `closeCaches()` — set `draining = true`, close all cached SMTP/IMAP connections
5. `gatewayManager.shutdown()` — stop relay polling, tunnel
6. `server.close()` — stop accepting connections
7. `setTimeout(() => process.exit(0), 5000)` — force exit safety net

Signals: SIGTERM and SIGINT both trigger shutdown.

---

## Constants Summary

| Constant | Value | Location |
|----------|-------|----------|
| Request body limit | 10 MB | `app.ts` |
| Rate limit window | 60,000ms | `app.ts` |
| Rate limit max | 100 requests/window | `app.ts` |
| Activity throttle | 60,000ms | `auth.ts` |
| Cache TTL | 600,000ms (10 min) | `mail.ts` |
| Max cache entries | 100 | `mail.ts` |
| Cache eviction interval | 60,000ms | `mail.ts` |
| Max SSE per agent | 5 | `events.ts` |
| SSE ping interval | 30,000ms | `events.ts` |
| Scheduled sender interval | 30,000ms | `features.ts` |
| Data retention (spam_log) | 30 days | `features.ts` |
| Data retention (delivered_messages) | 30 days | `features.ts` |
| Max batch UIDs | 1,000 | `mail.ts` |
| Max folder name length | 200 chars | `mail.ts` |
| RPC timeout min | 5,000ms | `tasks.ts` |
| RPC timeout max | 300,000ms (5 min) | `tasks.ts` |
| RPC timeout default | 180,000ms (3 min) | `tasks.ts` |
| RPC poll interval | 2,000ms | `tasks.ts` |
| Shutdown force exit | 5,000ms | `index.ts` |
| Agent name max length | 64 chars | `accounts.ts` |
| Default tag color | `#888888` | `features.ts` |
| Digest preview default | 200 chars | `mail.ts` |
| Digest preview range | 50–500 chars | `mail.ts` |
| Inbox limit range | 1–200 | `mail.ts` |
| Digest limit range | 1–50 | `mail.ts` |
| Default inbound secret | `inbound_2sabi_secret_key` | `inbound.ts` |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTICMAIL_MASTER_KEY` | Yes | — | Master API key |
| `AGENTICMAIL_API_PORT` | No | `3100` | Server port |
| `STALWART_URL` | No | `http://localhost:8080` | Stalwart admin URL |
| `STALWART_ADMIN_USER` | No | `admin` | Stalwart admin user |
| `STALWART_ADMIN_PASSWORD` | No | `changeme` | Stalwart admin password |
| `SMTP_HOST` | No | `localhost` | SMTP host |
| `SMTP_PORT` | No | `587` | SMTP port |
| `IMAP_HOST` | No | `localhost` | IMAP host |
| `IMAP_PORT` | No | `143` | IMAP port |
| `AGENTICMAIL_INBOUND_SECRET` | No | `inbound_2sabi_secret_key` | Inbound webhook secret |

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
