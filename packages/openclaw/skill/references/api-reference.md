# AgenticMail API Reference

Base URL: `http://127.0.0.1:3100/api/agenticmail`

## Authentication

All endpoints require a Bearer token:
```
Authorization: Bearer <api_key>
```

- **Master Key** (`mk_...`): Admin operations (account/domain management)
- **Agent Key** (`ak_...`): Agent-scoped operations (send/receive/search)

## Endpoints

### Health
- `GET /health` — Server status (no auth required)

### Accounts

**Master key required:**
- `POST /accounts` — Create agent account
  - Body: `{ "name": "agent-name", "role": "assistant" }`
  - Returns: `{ "id", "name", "email", "apiKey", "role" }`
- `GET /accounts` — List all accounts
- `GET /accounts/:id` — Get account details
- `DELETE /accounts/:id` — Delete account

**Any valid key:**
- `GET /accounts/directory` — List all agents (name, email, role only)
- `GET /accounts/directory/:name` — Resolve agent by name

**Agent key:**
- `GET /accounts/me` — Get current agent info
- `PATCH /accounts/me` — Update agent metadata
  - Body: `{ "metadata": { "key": "value" } }`

### Mail (Agent key required)

- `POST /mail/send` — Send email
  - Body: `{ "to", "subject", "text", "html", "cc", "inReplyTo", "references", "attachments" }`
- `GET /mail/inbox?limit=20&offset=0` — List inbox
- `GET /mail/messages/:uid` — Read message
- `POST /mail/search` — Search messages
  - Body: `{ "from", "to", "subject", "text", "seen", "since", "before" }`
- `POST /mail/messages/:uid/seen` — Mark as read
- `DELETE /mail/messages/:uid` — Delete message
- `POST /mail/messages/:uid/move` — Move message
  - Body: `{ "folder": "Archive" }`
- `GET /mail/folders` — List folders
- `POST /mail/folders` — Create folder
  - Body: `{ "name": "FolderName" }`
- `GET /mail/folders/:name?limit=20&offset=0` — List messages in folder

### Domains (Master key required)
- `POST /domains` — Setup domain
- `GET /domains` — List domains
- `GET /domains/:domain/dns` — Get DNS records
- `POST /domains/:domain/verify` — Verify DNS
- `DELETE /domains/:domain` — Delete domain

### Gateway (Master key required)
- `GET /gateway/status` — Gateway/tunnel status
- `POST /gateway/relay` — Configure relay
- `POST /gateway/test` — Send test email
