# @agenticmail/api

The API server for [AgenticMail](https://github.com/agenticmail/agenticmail) — the part that lets AI agents (and humans) talk to the email system over the network.

This package runs a web server that handles everything: sending email, reading inboxes, managing agents, real-time notifications, inter-agent messaging, spam filtering, outbound security scanning, and gateway configuration. Every feature in AgenticMail is accessible through this API.

## Install

```bash
npm install @agenticmail/api
```

**Requirements:** Node.js 20+, `@agenticmail/core`, Stalwart Mail Server running (via Docker)

---

## What This Package Does

The API server is the central hub. It sits between agents (or any client) and the email infrastructure. Rather than agents connecting to IMAP/SMTP directly, they make simple web requests to this server, which handles all the complexity behind the scenes.

### Who talks to the API

- **AI agents** — send and receive email, check inboxes, claim tasks
- **The interactive shell** (`agenticmail start`) — powers every command in the CLI
- **The MCP server** (`@agenticmail/mcp`) — translates AI tool calls into API requests
- **OpenClaw sub-agents** (`@agenticmail/openclaw`) — same thing but for the OpenClaw framework
- **Your own code** — any HTTP client can use the API

---

## How Authentication Works

The API uses two types of keys, and the distinction matters a lot for security.

### Master Key

The master key is the admin password. It is set once during setup and never changes. The person holding the master key is considered the **owner** — the human who controls the system. The master key can do everything: create and delete agents, configure the email gateway, and critically, **approve or reject blocked outbound emails**.

### Agent Keys

Each AI agent gets its own key when created. An agent key lets that agent do things scoped to itself: read its own inbox, send email (subject to security scanning), manage its own contacts, drafts, rules, and so on. An agent **cannot** access another agent's inbox, and **cannot** approve its own blocked emails — that is reserved for the human owner.

### Why This Matters

When an AI agent tries to send an email that the outbound guard flags as potentially sensitive (containing passwords, personal information, internal system details, etc.), the email gets blocked and stored for review. Only the person with the master key can approve or reject it. This prevents an AI from leaking sensitive data without human oversight.

The key comparison uses timing-safe SHA-256 hashing so that the time it takes to check a key doesn't reveal any information about what the correct key is. This is a standard security practice to prevent timing attacks.

---

## Sending Email

When an agent sends an email, several things happen before it actually goes out:

1. **Outbound security scan** — the email is checked against 34+ rules looking for leaked passwords, API keys, personal information (SSN, credit card numbers, phone numbers), internal system URLs, database connection strings, and more. Each match is scored by severity (critical, high, medium, low).

2. **If the email is clean** — it goes out immediately. If a gateway (Gmail relay or custom domain) is configured, the email routes through that. Otherwise it sends via the local Stalwart mail server. A copy is saved to the agent's Sent folder.

3. **If the email is flagged** — it gets stored in a pending queue. The owner receives a notification email with the full content of the blocked email, the security warnings that triggered, and instructions on what to do.

4. **The owner decides** — The owner can approve or reject by calling the API with their master key, using the interactive shell's `/pending` command, or simply **replying to the notification email** with words like "approve", "yes", "lgtm", "go ahead", "send", or "ok". Replying with "reject", "no", "deny", "cancel", or "block" discards the email. The relay polling system automatically detects these replies and acts on them.

5. **Master bypass** — The owner (master key) can send an email with `allowSensitive: true` to bypass all security scanning entirely. Agent keys cannot use this bypass — even if an agent passes the flag, the guard still runs.

### Display Names

Agents can set a display name through their metadata (the `ownerName` field). When an agent sends email, the From header shows something like `"secretary from John" <secretary@yourdomain.com>`. Without a display name, it just shows the agent's name.

### Attachments

Emails can include file attachments. The API accepts them as objects with a filename, content type, and content (as a Buffer or base64 string). The outbound guard also checks attachments for risky file types.

---

## Reading Email

Agents can read their own inbox in several ways:

- **List inbox** — shows message metadata (who it's from, subject, date, read/unread flags, size) with pagination. Default 20 messages per page, up to 200.

- **Digest view** — same as the inbox list but includes a preview of each email's body (the first 200 characters by default, configurable up to 500). Useful for getting a quick sense of what each email says without fetching the full body.

- **Read a specific message** — fetches the complete email: full headers, text body, HTML body, attachment metadata, and a security analysis. The security analysis includes a spam score, whether it's classified as spam or just a warning, the top threat category if any, which rules matched, and whether any invisible Unicode characters or hidden HTML were detected and sanitized.

- **Search** — find emails by sender, recipient, subject, body text, date range, or read/unread status. Can also search the connected relay account (Gmail/Outlook) if one is configured.

### Spam Protection on Read

Every email from an external source gets scored when you read it. The spam scoring engine uses 47 rules across 9 categories (prompt injection, social engineering, data exfiltration, phishing, header anomalies, content spam, suspicious links, authentication issues, and attachment risks). Internal emails (sent between agents on the same system) skip scoring entirely since they are trusted.

If the system detects invisible Unicode characters (zero-width spaces, invisible separators, bidirectional text tricks) or hidden HTML (tiny fonts, invisible text, elements positioned off-screen), it sanitizes them and tells you what it found.

---

## Real-Time Notifications

Agents can open a persistent connection to receive instant notifications about new emails, deleted emails, and flag changes. This uses Server-Sent Events (SSE), which is just a long-lived HTTP connection that the server pushes updates through.

### What happens when a new email arrives

When a new email lands in an agent's inbox, the system does several things in real-time:

1. **Relay detection** — if the email came through the relay gateway (Gmail/Outlook), it's marked as external even if the sender address looks like a local agent. This prevents relay-forwarded emails from bypassing the spam filter.

2. **Spam scoring** — external emails are scored. If the score exceeds the spam threshold, the email is automatically moved to the Spam folder and the notification event includes spam details. If it's a warning (elevated but not spam), the event includes the warning info but the email stays in the inbox.

3. **Rule evaluation** — after spam filtering, the system checks the agent's custom email rules. Rules are checked in priority order and the first match wins. A rule can auto-mark the email as read, delete it, or move it to a specific folder.

4. **Notification sent** — the event is pushed to all of the agent's connected SSE streams.

### Connection limits

Each agent can have up to 5 simultaneous SSE connections. This prevents resource exhaustion — each connection holds an open IMAP connection to the mail server. A keepalive ping is sent every 30 seconds to prevent timeouts.

### Spam logging

Every spam score is recorded in the `spam_log` table with the full analysis. These logs are automatically cleaned up after 30 days.

---

## Managing Agents

### Creating Agents

Only the master key can create new agents. Each agent gets a name, an email address on the local domain, an API key, and a role. The first agent created is automatically marked as "persistent" (won't be deleted during cleanup).

Agent names must be alphanumeric (plus dots, hyphens, and underscores), up to 64 characters.

### Agent Lifecycle

Agents have an activity tracker. Every time an agent makes an API call, its `last_activity_at` timestamp is updated (throttled to at most once per 60 seconds to avoid database churn). This lets the system identify inactive agents.

The `/accounts/cleanup` endpoint finds agents that haven't been active for a configurable number of hours (default 24) and deletes them — unless they're marked as persistent. You can do a dry run first to see who would be deleted.

### Deleting Agents

When an agent is deleted, its emails can optionally be archived first. The deletion creates a report recording which agent was deleted, when, why, and by whom. Past deletion reports are kept and can be reviewed later.

Deleting the last remaining agent is not allowed — the system always needs at least one.

### Agent Directory

Any authenticated user (agent or master) can look up the directory — a simple list of all agents with their name, email address, and role. This lets agents discover each other for inter-agent communication.

---

## Inter-Agent Tasks

Agents can assign work to each other through a built-in task system.

### Assigning Tasks

Any authenticated user can assign a task to an agent. You specify the assignee (by name), a task type (like "lookup" or "analyze"), and an optional payload with details. The target agent is notified three ways:

1. **SSE event** — instant notification if connected
2. **Broadcast** — pushed to all SSE connections as fallback
3. **Email** — a notification email sent to the agent's inbox (fire-and-forget, doesn't block)

### Task Lifecycle

A task goes through states: **pending** (just assigned) → **claimed** (agent accepted it) → **completed** or **failed**. Any agent that knows a task's ID can claim it — this supports sub-agent architectures where a parent agent's tasks are claimed by a specialized child agent.

Tasks can have an expiration time. The payload and result are stored as JSON.

### Synchronous RPC

For cases where you need an answer right away, there's an RPC endpoint. It assigns a task and then holds the HTTP connection open, waiting for the target agent to complete it. The connection stays open for up to 5 minutes (configurable from 5 seconds to 300 seconds).

The waiting is efficient — when the target agent submits a result, the server instantly resolves the waiting connection. There's also a polling fallback (every 2 seconds) in case the instant notification is missed.

If the task isn't completed before the timeout, you get back a timeout response with the task ID so you can check on it later.

---

## Email Approval Workflow

This is one of the most important security features. Here is how it works end-to-end:

1. **Agent tries to send an email** — the outbound guard scans it and finds sensitive content (a password, an API key, a credit card number, whatever).

2. **Email is blocked** — stored in the `pending_outbound` table with the full email content, the security warnings, and a summary.

3. **Owner is notified** — a notification email is sent to the owner's relay address (e.g., their Gmail). The email includes the full content of the blocked message, all security warnings, the pending ID, and instructions: "Reply approve to send, or reject to discard."

4. **Owner responds** — the owner can:
   - **Use the API** — call `POST /mail/pending/:id/approve` or `/reject` with the master key
   - **Use the shell** — type `/pending` in the interactive shell
   - **Reply to the email** — just reply "yes", "approve", "lgtm", "go ahead", "send", or "ok" to approve, or "no", "reject", "deny", "cancel", or "block" to reject. The relay polling system checks for these replies and processes them automatically.

5. **Email is sent or discarded** — if approved, the system re-sends the email through the gateway (or local SMTP). If rejected, it's marked as rejected and discarded.

6. **Agent cannot self-approve** — even if an agent has the pending email's ID and tries to call the approve endpoint, the server rejects the request with a 403 error. Only the master key works.

### Relay Polling as a Follow-Up System

When the relay gateway (Gmail/Outlook) is configured, the system continuously polls the relay inbox for new messages. This polling runs on an exponential backoff schedule (starting at 30 seconds, growing to a cap of 5 minutes, and resetting when new mail arrives). This means the system automatically picks up approval replies within a few minutes at most.

This also means the agent effectively has a "cron job" — the polling loop keeps running in the background, checking for responses and delivering them to the right agent's local inbox. The agent doesn't need to do anything special; replies just show up.

---

## Inbound Email Webhook

For domain mode (when you have a custom domain like `@yourdomain.com`), incoming internet email arrives through a Cloudflare Email Worker. The worker forwards the raw email to the API's inbound webhook endpoint.

The webhook:
1. Authenticates using a shared secret (`X-Inbound-Secret` header), not a Bearer token
2. Looks up which agent should receive the email based on the recipient address (the part before the @)
3. Checks for duplicates — if this exact email was already delivered, it's skipped
4. Delivers the email into the agent's local mailbox via SMTP
5. Records the delivery to prevent future duplicates

---

## Email Organization

Each agent gets a full set of email management tools:

### Folders
Agents can create custom IMAP folders, list all folders, and move messages between them. Folder names are validated (max 200 characters, no special IMAP characters).

### Contacts
A personal address book per agent. Contacts have a name, email address, and optional notes. Adding a contact with an existing email updates the existing entry.

### Drafts
Save email drafts for later editing and sending. Drafts store the full email (to, subject, body, CC, BCC, threading headers). You can send a draft directly, which validates it has a recipient, sends it, and then deletes the draft.

### Signatures
Reusable email signatures in both text and HTML format. One signature can be marked as the default. Setting a new default automatically unsets the previous one.

### Templates
Reusable email templates with variable substitution. Templates have a name, subject line, and body. When sending from a template, you provide the recipient and a variables object — the system replaces `{{ variableName }}` patterns in the subject and body with your values.

### Tags
Create colored tags and apply them to messages. Tags can be listed, created, deleted, and attached to or removed from specific messages. You can look up which messages have a specific tag, or which tags are on a specific message.

### Email Rules
Automated rules that run when new email arrives. Each rule has conditions (match on sender, recipient, subject, or attachment presence) and actions (mark as read, delete, or move to folder). Rules have a priority number — higher priority rules are checked first, and the first match wins. Rules can be enabled or disabled.

### Scheduled Emails
Schedule emails to be sent at a future time. The system supports many time formats:

- ISO dates: `2026-02-14T10:00:00Z`
- Relative times: `in 30 minutes`, `in 2 hours`
- Named times: `tomorrow 8am`, `tomorrow 2pm`
- Day references: `next monday 9am`, `next friday 2pm`
- Specific dates: `02-14-2026 3:30 PM EST`
- Casual: `tonight`, `this evening` (sends at 8 PM)

The scheduled sender checks every 30 seconds for emails whose send time has arrived, then sends them through the gateway or local SMTP.

---

## Batch Operations

For efficiency, agents can perform operations on multiple messages at once:

- **Batch read** — fetch multiple messages in one request (up to 1000 UIDs)
- **Batch seen/unseen** — mark multiple messages as read or unread
- **Batch delete** — delete multiple messages
- **Batch move** — move multiple messages to a folder

---

## Gateway Configuration

The gateway connects the local mail system to the internet. There are two modes:

### Relay Mode
Uses an existing Gmail or Outlook account. Easy to set up — just provide your email and an app password. Agent emails go out through your account as sub-addressed emails (like `yourname+agentname@gmail.com`). Incoming replies are polled and delivered to the right agent.

### Domain Mode
Uses a custom domain with Cloudflare for DNS, email routing, and tunneling. More professional — agents get addresses like `secretary@yourdomain.com`. Requires a Cloudflare account and API token. The system can set up DNS records, email routing rules, and a Cloudflare Tunnel automatically.

Domain mode also supports a Gmail relay for outbound sending, which means you get the professional addresses but send through Gmail's reliable infrastructure.

### Gateway Test
After configuration, you can send a test email through the gateway to verify everything is working.

---

## Connection Management

The API server manages connections to the mail server efficiently:

- **Sender connections** (SMTP) and **receiver connections** (IMAP) are cached per agent, with a 10-minute time-to-live
- Maximum 100 connections cached at once
- Stale connections are cleaned up every 60 seconds
- When the cache is full, the oldest connection is evicted
- Multiple concurrent requests for the same agent reuse the same connection (prevents thundering herd)
- On shutdown, all connections are gracefully closed with a 5-second timeout

---

## Rate Limiting and Protections

- **Global rate limit:** 100 requests per IP per 60-second window
- **Request body size:** maximum 10 MB (for attachments)
- **SSE connections:** maximum 5 per agent
- **Batch operations:** maximum 1000 UIDs per request
- **CORS:** enabled (all origins allowed by default)

---

## Background Services

The API server runs two background services:

### Scheduled Email Sender
Runs every 30 seconds. Checks for scheduled emails whose send time has arrived, sends them, and updates their status. Also performs housekeeping: cleans up delivery deduplication records and spam logs older than 30 days.

### Gateway Resume
On startup, the server resumes any previously configured gateway (relay polling or domain mode tunnel). This means restarting the API server doesn't break the email gateway — it picks up right where it left off.

---

## Graceful Shutdown

When the server receives a shutdown signal (Ctrl+C or SIGTERM):

1. Stops the scheduled email sender
2. Closes all SSE watchers and their IMAP connections
3. Closes all cached SMTP and IMAP connections
4. Shuts down the gateway manager
5. Closes the HTTP server
6. Force-exits after 5 seconds if cleanup hasn't finished

---

## Error Handling

The API returns standard HTTP status codes:

- **200** — success
- **201** — created (new agent, new rule, etc.)
- **204** — deleted (no content returned)
- **400** — bad request (missing or invalid parameters)
- **401** — unauthorized (missing or invalid API key)
- **403** — forbidden (agent trying to use master-only endpoint)
- **404** — not found
- **409** — conflict (agent name already exists)
- **429** — too many requests (rate limit exceeded)
- **500** — internal server error
- **503** — service unavailable (Stalwart mail server is down)

JSON parse errors (malformed request bodies) return a clear 400 error rather than a confusing 500.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTICMAIL_MASTER_KEY` | Yes | — | Admin API key (the human owner's key) |
| `AGENTICMAIL_API_PORT` | No | `3100` | Port for the API server |
| `STALWART_URL` | No | `http://localhost:8080` | Stalwart mail server admin URL |
| `STALWART_ADMIN_USER` | No | `admin` | Stalwart admin username |
| `STALWART_ADMIN_PASSWORD` | No | `changeme` | Stalwart admin password |
| `SMTP_HOST` | No | `localhost` | SMTP server host |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `IMAP_HOST` | No | `localhost` | IMAP server host |
| `IMAP_PORT` | No | `143` | IMAP server port |
| `AGENTICMAIL_INBOUND_SECRET` | No | (built-in default) | Shared secret for the inbound email webhook |
| `AGENTICMAIL_DEBUG` | No | — | Set to any value to enable verbose per-message logging |

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
