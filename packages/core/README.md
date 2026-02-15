# @agenticmail/core

Core SDK for [AgenticMail](https://github.com/agenticmail/agenticmail) — programmatic email infrastructure for AI agents.

This package provides the foundation: account management, SMTP/IMAP operations, inbox watching, gateway orchestration, spam filtering, and outbound security scanning.

## Install

```bash
npm install @agenticmail/core
```

## Usage

### Send an email

```typescript
import { MailSender } from '@agenticmail/core';

const sender = new MailSender({
  host: 'localhost',
  port: 587,
  email: 'agent@localhost',
  password: 'agent-password',
});

await sender.send({
  to: 'someone@example.com',
  subject: 'Hello',
  text: 'Sent from an AI agent.',
});

sender.close();
```

### Receive emails

```typescript
import { MailReceiver } from '@agenticmail/core';

const receiver = new MailReceiver({
  host: 'localhost',
  port: 143,
  email: 'agent@localhost',
  password: 'agent-password',
});

await receiver.connect();
const messages = await receiver.listInbox(10);

for (const msg of messages) {
  const full = await receiver.fetchMessage(msg.uid);
  console.log(full.subject, full.from);
}

await receiver.disconnect();
```

### Watch inbox in real-time

```typescript
import { InboxWatcher } from '@agenticmail/core';

const watcher = new InboxWatcher({
  host: 'localhost',
  port: 143,
  email: 'agent@localhost',
  password: 'agent-password',
});

watcher.on('new', (event) => {
  console.log('New email:', event.uid);
});

await watcher.start();
```

### Manage agents

```typescript
import { AccountManager, StalwartAdmin, getDatabase } from '@agenticmail/core';

const db = getDatabase('~/.agenticmail/agenticmail.db');
const stalwart = new StalwartAdmin({ url: 'http://localhost:8080', user: 'admin', pass: 'changeme' });
const accounts = new AccountManager(db, stalwart);

const agent = await accounts.create({ name: 'secretary', role: 'secretary' });
console.log(agent.email, agent.apiKey);
```

### Spam filter

```typescript
import { scoreEmail, parseEmail } from '@agenticmail/core';

const parsed = await parseEmail(rawEmailBuffer);
const result = scoreEmail(parsed);

console.log(result.score, result.isSpam, result.topCategory);
```

## Modules

| Module | Description |
|--------|-------------|
| `AccountManager` | Create, list, delete AI agents |
| `MailSender` | Send email via SMTP |
| `MailReceiver` | Read email via IMAP |
| `InboxWatcher` | Real-time inbox monitoring (IMAP IDLE) |
| `GatewayManager` | Relay and domain mode orchestration |
| `CloudflareClient` | Cloudflare API (DNS, tunnels, workers, email routing) |
| `DomainPurchaser` | Domain search and purchase via Cloudflare Registrar |
| `DNSConfigurator` | Automatic DNS record setup |
| `TunnelManager` | Cloudflare Tunnel lifecycle management |
| `RelayGateway` | Gmail/Outlook IMAP polling and SMTP relay |
| `StalwartAdmin` | Stalwart mail server administration |
| `scoreEmail` | Rule-based spam scoring |
| `scanOutboundEmail` | Outbound security scanning (API keys, PII detection) |
| `parseEmail` | RFC822 email parsing |
| `EmailSearchIndex` | Full-text email search (SQLite FTS5) |

## Requirements

- Node.js 20+
- [Stalwart Mail Server](https://stalw.art) (Docker recommended)

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
