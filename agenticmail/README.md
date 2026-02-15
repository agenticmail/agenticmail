# agenticmail

CLI and main package for [AgenticMail](https://github.com/agenticmail/agenticmail) — email infrastructure for AI agents.

This is the package you install to get started. It bundles the setup wizard, API server launcher, and a full-featured interactive shell with 35+ commands for managing agents, sending/receiving email, configuring gateways, and more.

## Install

```bash
npm install -g agenticmail
```

**Requirements:** Node.js 20+, Docker (for Stalwart mail server)

---

## Quick Start

```bash
# 1. Start the Stalwart mail server
docker compose up -d

# 2. Run the setup wizard
#    - Checks Docker and Stalwart health
#    - Generates master API key
#    - Creates SQLite database with migrations
#    - Creates your first AI agent
#    - Optionally configures email gateway
agenticmail setup

# 3. Start the API server + interactive shell
agenticmail start

# 4. Check system status
agenticmail status
```

---

## CLI Commands

### `agenticmail setup`

Interactive setup wizard that:
1. Verifies Docker is running and Stalwart is healthy
2. Creates the `~/.agenticmail` data directory
3. Generates a master API key (or uses existing one from `.env`)
4. Initializes the SQLite database with all required tables
5. Creates the first AI agent with email address and API key
6. Prompts for gateway configuration (relay mode or domain mode)

### `agenticmail start`

Starts the Express API server and drops into the interactive shell. The API runs on port 3100 (configurable via `AGENTICMAIL_API_PORT`).

### `agenticmail status`

Shows system health: Stalwart connectivity, API server status, gateway mode, active agents.

---

## Interactive Shell

The shell provides complete email and agent management through an interactive REPL. Type `/help` to see all commands.

### Email Commands

| Command | Description |
|---------|-------------|
| `/inbox` | Interactive inbox viewer with arrow key navigation, body previews (toggle with `v`), inline reading (press Enter), unread markers, pagination |
| `/send` | Compose and send email (prompts for to, subject, body) |
| `/read` | Read a specific email by number |
| `/reply` | Reply to an email (preserves threading) |
| `/forward` | Forward an email |
| `/search` | Search emails by keyword |
| `/delete` | Delete an email |
| `/save` | Save email content to a file |
| `/thread` | View email thread (related messages) |
| `/unread` | Toggle unread status |
| `/archive` | Move email to archive |
| `/trash` | View trash/deleted folder |
| `/sent` | View sent emails |

### Organization Commands

| Command | Description |
|---------|-------------|
| `/folders` | List, create, and manage IMAP folders |
| `/contacts` | Manage address book |
| `/drafts` | View, edit, and send draft emails |
| `/signature` | Manage email signatures |
| `/templates` | Manage reusable email templates |
| `/schedule` | Schedule emails for future delivery |
| `/tag` | Tag and categorize messages |

### Agent Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all AI agents with email and role |
| `/switch` | Switch the active agent (changes which inbox you're viewing) |
| `/deleteagent` | Delete an agent (with 3-retry name confirmation, archives emails) |
| `/deletions` | View past agent deletion reports |
| `/name` | Set display name for the active agent (appears in From: header) |

### Security Commands

| Command | Description |
|---------|-------------|
| `/spam` | View spam folder, report spam, mark as not-spam, view spam score for any email |
| `/rules` | Create, list, and delete email filtering rules (auto-move, auto-delete, mark read) |
| `/pending` | View blocked outbound emails, approve or reject (master key required — agents cannot self-approve) |

### Gateway Commands

| Command | Description |
|---------|-------------|
| `/relay` | Configure Gmail/Outlook relay mode (interactive setup) |
| `/digest` | Show inbox digest with body previews and unread markers |
| `/setup` | Re-run the setup wizard |
| `/status` | Show server health, gateway mode, agent count |
| `/openclaw` | OpenClaw sub-agent controls |

### System Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/clear` | Clear the screen |
| `/exit` | Exit the shell (also `/quit`) |

### Shell Features

- **Arrow key navigation** — use `↑`/`↓` to select emails in inbox, `←`/`→` for pagination
- **Body previews** — press `v` to toggle email body previews in inbox view
- **Inline reading** — press `Enter` to read selected email without leaving inbox
- **Unread markers** — `★` indicates unread messages
- **3-retry input validation** — invalid input gets 3 attempts before canceling
- **Separator lines** above navigation bars for visual clarity
- **Esc to exit** — press `Esc` to go back from any paginated view

---

## Programmatic Usage

The package re-exports everything from `@agenticmail/core`, so you can use it as an SDK:

```typescript
import {
  // Main client
  AgenticMailClient,

  // Mail operations
  MailSender,
  MailReceiver,
  parseEmail,

  // Inbox watching
  InboxWatcher,

  // Account management
  AccountManager,
  StalwartAdmin,

  // Gateway
  GatewayManager,
  RelayGateway,
  CloudflareClient,
  TunnelManager,
  DNSConfigurator,
  DomainPurchaser,

  // Security
  scoreEmail,
  scanOutboundEmail,

  // Storage
  getDatabase,
  EmailSearchIndex,

  // Types
  type SendMailOptions,
  type ParsedEmail,
  type Agent,
  type GatewayConfig,
} from 'agenticmail';
```

### Example: Send email programmatically

```typescript
import { AgenticMailClient } from 'agenticmail';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3100',
  apiKey: 'ak_your_agent_key',
});

// Send
await client.send({
  to: 'colleague@example.com',
  subject: 'Project Update',
  text: 'The project is on track for Q2.',
  attachments: [{
    filename: 'report.pdf',
    content: pdfBuffer,
    contentType: 'application/pdf',
  }],
});

// Read inbox
const messages = await client.listInbox(10);
const email = await client.readMessage(messages[0].uid);
console.log(email.subject, email.text);

// Search
const results = await client.search({ from: 'boss@example.com' });
```

See the [@agenticmail/core README](https://github.com/agenticmail/agenticmail/tree/main/packages/core) for complete SDK documentation.

---

## Environment Variables

Create a `.env` file in your project root or set these in your environment:

```bash
# === Required ===
AGENTICMAIL_MASTER_KEY=mk_your_key          # Admin API key

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
AGENTICMAIL_API_PORT=3100                   # API port (default: 3100)
AGENTICMAIL_DATA_DIR=~/.agenticmail         # Data directory

# === Gateway (optional) ===
RELAY_PROVIDER=gmail                        # gmail or outlook
RELAY_EMAIL=you@gmail.com                   # Relay email
RELAY_PASSWORD=xxxx xxxx xxxx xxxx          # App password
CLOUDFLARE_API_TOKEN=your_token             # For domain mode
CLOUDFLARE_ACCOUNT_ID=your_account          # For domain mode
AGENTICMAIL_DOMAIN=yourdomain.com           # Custom domain
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
