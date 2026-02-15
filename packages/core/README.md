# @agenticmail/core

Core SDK for [AgenticMail](https://github.com/agenticmail/agenticmail) — programmatic email infrastructure for AI agents.

This package is the foundation layer. It provides everything needed to manage AI agent accounts, send and receive email via SMTP/IMAP, watch inboxes in real-time, route email through internet gateways (Gmail relay or custom domain via Cloudflare), filter spam, scan outbound emails for sensitive data, and store state in SQLite.

## Install

```bash
npm install @agenticmail/core
```

**Requirements:** Node.js 20+, [Stalwart Mail Server](https://stalw.art) running (Docker recommended)

---

## Table of Contents

- [Quick Examples](#quick-examples)
- [Modules](#modules)
- [Account Management](#account-management)
- [Sending Email](#sending-email)
- [Receiving Email](#receiving-email)
- [Inbox Watching](#inbox-watching)
- [Gateway (Internet Email)](#gateway-internet-email)
- [Spam Filter](#spam-filter)
- [Outbound Guard](#outbound-guard)
- [Search](#search)
- [Storage](#storage)

---

## Quick Examples

### Send an email

```typescript
import { MailSender } from '@agenticmail/core';

const sender = new MailSender({
  host: 'localhost',
  port: 587,
  email: 'secretary@localhost',
  password: 'agent-password',
  authUser: 'secretary@localhost',
});

await sender.send({
  to: 'colleague@example.com',
  subject: 'Weekly Report',
  text: 'Please find the weekly report attached.',
  html: '<h1>Weekly Report</h1><p>See attachment.</p>',
  attachments: [{
    filename: 'report.pdf',
    content: pdfBuffer,
    contentType: 'application/pdf',
  }],
});

sender.close();
```

### Read inbox

```typescript
import { MailReceiver } from '@agenticmail/core';

const receiver = new MailReceiver({
  host: 'localhost',
  port: 143,
  email: 'secretary@localhost',
  password: 'agent-password',
  secure: false,
});

await receiver.connect();

// List recent messages (metadata only)
const messages = await receiver.listInbox(20);
for (const msg of messages) {
  console.log(`UID ${msg.uid}: ${msg.from} — ${msg.subject} (${msg.flags})`);
}

// Fetch full message with body and attachments
const full = await receiver.fetchMessage(messages[0].uid);
console.log(full.text);
console.log(`Attachments: ${full.attachments.length}`);

// Search
const results = await receiver.search({ from: 'boss@example.com', unseen: true });

// Move message to folder
await receiver.moveMessage(messages[0].uid, 'INBOX', 'Archive');

// Mark as read
await receiver.markSeen(messages[0].uid);

await receiver.disconnect();
```

### Watch inbox in real-time

```typescript
import { InboxWatcher } from '@agenticmail/core';

const watcher = new InboxWatcher({
  host: 'localhost',
  port: 143,
  email: 'secretary@localhost',
  password: 'agent-password',
});

watcher.on('new', (event) => {
  console.log(`New email! UID: ${event.uid}, Subject: ${event.subject}`);
});

watcher.on('expunge', (event) => {
  console.log(`Email deleted: UID ${event.uid}`);
});

watcher.on('flags', (event) => {
  console.log(`Flags changed: UID ${event.uid} → ${event.flags}`);
});

watcher.on('error', (err) => {
  console.error('Watcher error:', err.message);
});

await watcher.start();

// Later:
await watcher.stop();
```

### Create and manage agents

```typescript
import { AccountManager, StalwartAdmin, getDatabase } from '@agenticmail/core';

const db = getDatabase('~/.agenticmail/agenticmail.db');
const stalwart = new StalwartAdmin({
  url: 'http://localhost:8080',
  user: 'admin',
  pass: 'changeme',
});
const accounts = new AccountManager(db, stalwart);

// Create an agent
const agent = await accounts.create({
  name: 'researcher',
  role: 'researcher',
  metadata: { department: 'R&D' },
});

console.log(`Email: ${agent.email}`);       // researcher@localhost
console.log(`API Key: ${agent.apiKey}`);     // ak_...
console.log(`Principal: ${agent.stalwartPrincipal}`); // researcher@localhost

// List all agents
const agents = await accounts.list();

// Get agent by name
const found = await accounts.getByName('researcher');

// Delete agent (archives emails first)
await accounts.delete(agent.id);
```

### Score email for spam

```typescript
import { scoreEmail, parseEmail } from '@agenticmail/core';

const rawEmail = Buffer.from(emailString);
const parsed = await parseEmail(rawEmail);
const result = scoreEmail(parsed);

console.log(`Score: ${result.score}`);           // 0-100
console.log(`Is spam: ${result.isSpam}`);        // true if score >= 40
console.log(`Is warning: ${result.isWarning}`);  // true if score >= 20
console.log(`Category: ${result.topCategory}`);  // 'phishing', 'scam', etc.
console.log(`Matches:`, result.matches);         // Array of matched rules
```

### Scan outbound email for sensitive data

```typescript
import { scanOutboundEmail } from '@agenticmail/core';

const result = scanOutboundEmail({
  to: 'external@example.com',
  subject: 'API credentials',
  text: 'Here is the key: sk-1234567890abcdef',
});

console.log(`Blocked: ${result.blocked}`);       // true
console.log(`Warnings:`, result.warnings);       // [{ category: 'api_key', ... }]
```

When integrated via the API layer, blocked emails are held in a `pending_outbound` table for **human-only approval**. The owner (master key holder) receives a notification email with the full blocked email content and security warnings. Agents cannot approve or reject their own blocked emails — only the master key holder can do so via `POST /mail/pending/:id/approve` or `POST /mail/pending/:id/reject`.

---

## Modules

| Module | Class/Function | Description |
|--------|---------------|-------------|
| **Accounts** | `AccountManager` | Create, list, get, delete AI agents. Each agent gets a Stalwart principal, email address, and API key. |
| **Accounts** | `AgentDeletionService` | Delete agents with email archival, generates deletion reports. |
| **Mail** | `MailSender` | Send email via SMTP (nodemailer). Supports text, HTML, attachments, CC/BCC, reply-to, in-reply-to, references. |
| **Mail** | `MailReceiver` | Read email via IMAP (imapflow). List, fetch, search, move, delete, mark seen/unseen, create folders. |
| **Mail** | `parseEmail` | Parse raw RFC822 email buffer into structured `ParsedEmail` object (mailparser). |
| **Spam** | `scoreEmail` | Rule-based spam scoring. Returns score (0-100), category, matched rules, isSpam/isWarning flags. |
| **Spam** | `isInternalEmail` | Detect if email is agent-to-agent (checks from domain + replyTo for relay detection). |
| **Security** | `scanOutboundEmail` | Scan outgoing email for API keys, credentials, PII, private keys, internal URLs. |
| **Security** | `sanitizeEmail` | Sanitize HTML email content (strip scripts, dangerous attributes). |
| **Inbox** | `InboxWatcher` | Real-time inbox monitoring via IMAP IDLE. Emits `new`, `expunge`, `flags`, `error` events. |
| **Gateway** | `GatewayManager` | Orchestrates relay and domain modes. Routes outbound email, handles inbound delivery, manages config. |
| **Gateway** | `RelayGateway` | Gmail/Outlook IMAP polling + SMTP relay. Sub-address routing (`+agent`). |
| **Gateway** | `CloudflareClient` | Cloudflare API client — zones, DNS, tunnels, email routing, workers, registrar. |
| **Gateway** | `TunnelManager` | Cloudflare Tunnel lifecycle — create, start (via cloudflared), configure ingress, stop. |
| **Gateway** | `DNSConfigurator` | Automatic DNS setup — MX, SPF, DKIM TXT, DMARC, tunnel CNAME. Cleans conflicting records. |
| **Gateway** | `DomainPurchaser` | Search available domains, purchase via Cloudflare Registrar. |
| **Stalwart** | `StalwartAdmin` | Stalwart mail server admin — create principals, manage DKIM, set hostname, configure outbound relay. |
| **Storage** | `getDatabase` | SQLite database factory with automatic migrations. |
| **Storage** | `EmailSearchIndex` | Full-text email search using SQLite FTS5. |
| **Setup** | `SetupManager` | Dependency checking (Docker, Node.js, cloudflared) and installation. |

---

## Account Management

Agents are created as Stalwart mail server principals. Each agent has:

- **name** — unique identifier (e.g., `secretary`, `researcher`)
- **email** — `name@localhost` (or `name@yourdomain.com` in domain mode)
- **stalwartPrincipal** — Stalwart username for SMTP/IMAP auth
- **apiKey** — unique API key (`ak_...`) for REST API authentication
- **role** — agent role (e.g., `secretary`, `researcher`, `writer`, `developer`)
- **metadata** — arbitrary JSON (owner name, department, persistent flag, etc.)

```typescript
// Available roles
import { AGENT_ROLES } from '@agenticmail/core';
// ['secretary', 'researcher', 'writer', 'developer', 'analyst', 'coordinator', 'custom']
```

---

## Gateway (Internet Email)

The `GatewayManager` handles routing email between local Stalwart and the internet:

```typescript
import { GatewayManager, getDatabase, StalwartAdmin } from '@agenticmail/core';

const gw = new GatewayManager({
  db: getDatabase('~/.agenticmail/agenticmail.db'),
  stalwart: new StalwartAdmin({ url: 'http://localhost:8080', user: 'admin', pass: 'changeme' }),
  accountManager: accounts,
  localSmtp: { host: 'localhost', port: 587, user: 'admin', pass: 'changeme' },
});

// Relay mode
await gw.setupRelay({
  provider: 'gmail',
  email: 'you@gmail.com',
  password: 'xxxx xxxx xxxx xxxx',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  imapHost: 'imap.gmail.com',
  imapPort: 993,
});

// Domain mode
await gw.setupDomain({
  cloudflareToken: 'cf_token',
  cloudflareAccountId: 'cf_account_id',
  domain: 'yourdomain.com',
  gmailRelay: { email: 'you@gmail.com', appPassword: 'xxxx' },
});

// Route outbound email (automatic — checks if external, picks relay or Stalwart)
const result = await gw.routeOutbound('secretary', {
  to: 'external@example.com',
  subject: 'Hello',
  text: 'Message body',
});

// Check status
const status = gw.getStatus();
// { mode: 'relay', healthy: true, relay: { provider: 'gmail', email: '...', polling: true } }
```

---

## Spam Filter

The spam filter uses pattern-matching rules organized by category:

```typescript
import { scoreEmail, SPAM_THRESHOLD, WARNING_THRESHOLD } from '@agenticmail/core';

// SPAM_THRESHOLD = 40 (emails >= 40 are blocked)
// WARNING_THRESHOLD = 20 (emails 20-39 get a warning flag)

const result = scoreEmail(parsedEmail);
// {
//   score: 45,
//   isSpam: true,
//   isWarning: true,
//   topCategory: 'phishing',
//   matches: [
//     { ruleId: 'ph_urgent_action', score: 15, category: 'phishing' },
//     { ruleId: 'ph_verify_account', score: 20, category: 'phishing' },
//     { ruleId: 'cs_unsubscribe_heavy', score: 10, category: 'commercial' },
//   ]
// }
```

---

## Storage

SQLite database with automatic migrations:

```typescript
import { getDatabase, closeDatabase } from '@agenticmail/core';

// Opens database, runs pending migrations automatically
const db = getDatabase('~/.agenticmail/agenticmail.db');

// Use the database (better-sqlite3 instance)
const row = db.prepare('SELECT * FROM agents WHERE name = ?').get('secretary');

// Close when done
closeDatabase();
```

### Full-text search

```typescript
import { EmailSearchIndex } from '@agenticmail/core';

const search = new EmailSearchIndex(db);

// Index an email
search.index({
  uid: 42,
  agentId: 'agent-uuid',
  from: 'sender@example.com',
  to: 'agent@localhost',
  subject: 'Project Update',
  body: 'The project is on track for Q2 delivery...',
  date: new Date(),
});

// Search
const results = search.search('agent-uuid', 'project Q2');
// [{ uid: 42, rank: 0.95 }]
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
