# agenticmail

CLI and main package for [AgenticMail](https://github.com/agenticmail/agenticmail) — email infrastructure for AI agents.

This is the package you install to get started. It includes the setup wizard, API server launcher, and an interactive shell with 35+ commands.

## Install

```bash
npm install -g agenticmail
```

## Quick Start

```bash
# Run the setup wizard (starts Docker, configures Stalwart, creates first agent)
agenticmail setup

# Start the API server and interactive shell
agenticmail start

# Check system status
agenticmail status
```

## Interactive Shell

The shell provides full email management:

```
agenticmail> /help

Email:
  /inbox       Check inbox (arrow keys, previews, inline read)
  /send        Send email
  /read        Read specific email
  /reply       Reply to email
  /forward     Forward email
  /search      Search emails
  /delete      Delete email
  /thread      View email thread

Organization:
  /folders     List/manage folders
  /contacts    Manage contacts
  /drafts      Manage drafts
  /tag         Manage tags
  /signature   Manage signatures
  /templates   Manage templates
  /schedule    Schedule emails

Agents:
  /agents      List all agents
  /switch      Switch active agent
  /deleteagent Delete agent

Security:
  /spam        View spam folder, report spam
  /rules       Manage email filtering rules
  /pending     View/approve blocked outbound emails

Gateway:
  /relay       Configure email relay
  /digest      Inbox digest with previews
  /setup       Setup wizard
  /status      Server and gateway status
```

## Programmatic Usage

The package re-exports everything from `@agenticmail/core`:

```typescript
import {
  AgenticMailClient,
  MailSender,
  MailReceiver,
  InboxWatcher,
  AccountManager,
  GatewayManager,
} from 'agenticmail';
```

See the [@agenticmail/core README](https://github.com/agenticmail/agenticmail/tree/main/packages/core) for SDK documentation.

## Environment Variables

Create a `.env` file or set these variables:

```bash
# Required
AGENTICMAIL_MASTER_KEY=mk_your_key

# Stalwart Mail Server
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=changeme
STALWART_URL=http://localhost:8080

# SMTP/IMAP (local Stalwart)
SMTP_HOST=localhost
SMTP_PORT=587
IMAP_HOST=localhost
IMAP_PORT=143

# Optional
AGENTICMAIL_API_PORT=3100
AGENTICMAIL_DATA_DIR=~/.agenticmail
```

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
