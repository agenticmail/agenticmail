# @agenticmail/api

REST API server for [AgenticMail](https://github.com/agenticmail/agenticmail) — 75+ endpoints for managing agents, email, and gateway configuration.

Built on Express with authentication middleware, SSE event streaming, rate limiting, and spam/security filtering.

## Install

```bash
npm install @agenticmail/api
```

## Usage

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
  console.log('AgenticMail API running on port 3100');
});
```

## Authentication

All endpoints require authentication via `Authorization` header:

```
Authorization: Bearer mk_your_master_key    # Master key — full admin access
Authorization: Bearer ak_agent_key_here     # Agent key — scoped to that agent
```

## Endpoints

All routes are prefixed with `/api/agenticmail`.

### Mail

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/mail/send` | Agent | Send email |
| GET | `/mail/inbox` | Agent | List inbox messages |
| GET | `/mail/digest` | Agent | Inbox with body previews |
| GET | `/mail/messages/:uid` | Agent | Read full message |
| POST | `/mail/search` | Agent | Search emails |
| DELETE | `/mail/messages/:uid` | Agent | Delete message |
| POST | `/mail/messages/:uid/move` | Agent | Move message to folder |
| POST | `/mail/messages/:uid/seen` | Agent | Mark as read |
| POST | `/mail/messages/:uid/spam` | Agent | Mark as spam |
| GET | `/mail/folders` | Agent | List all folders |
| POST | `/mail/folders` | Agent | Create folder |
| GET | `/mail/pending` | Both | List blocked outbound emails |
| POST | `/mail/pending/:id/approve` | Master | Approve blocked email |
| POST | `/mail/pending/:id/reject` | Master | Reject blocked email |

### Accounts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/accounts` | Master | Create agent |
| GET | `/accounts` | Master | List all agents |
| GET | `/accounts/me` | Agent | Get current agent info |
| DELETE | `/accounts/:id` | Master | Delete agent with archival |
| GET | `/accounts/directory` | Both | Agent directory |

### Events

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/events` | Agent | SSE stream for real-time inbox events |

### Gateway

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/gateway/status` | Both | Gateway status |
| GET | `/gateway/setup-guide` | Both | Setup instructions |
| POST | `/gateway/relay` | Master | Setup relay mode |
| POST | `/gateway/domain` | Master | Setup domain mode |
| POST | `/gateway/test` | Both | Send test email |

### Tasks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/tasks/assign` | Both | Assign task to agent |
| POST | `/tasks/rpc` | Both | Synchronous agent-to-agent call |
| GET | `/tasks/pending` | Agent | Get pending tasks |
| POST | `/tasks/:id/claim` | Agent | Claim a task |
| POST | `/tasks/:id/result` | Agent | Submit task result |

Plus endpoints for drafts, contacts, tags, rules, signatures, templates, scheduled emails, and batch operations.

## Environment Variables

```bash
AGENTICMAIL_MASTER_KEY=mk_your_key    # Required
AGENTICMAIL_API_PORT=3100             # Default: 3100
STALWART_URL=http://localhost:8080
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=changeme
SMTP_HOST=localhost
SMTP_PORT=587
IMAP_HOST=localhost
IMAP_PORT=143
```

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
