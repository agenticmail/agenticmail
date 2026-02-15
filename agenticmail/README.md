# agenticmail

The main package for [AgenticMail](https://github.com/agenticmail/agenticmail) — email infrastructure for AI agents. This is the package you install to get started.

It bundles a setup wizard, API server launcher, and a full interactive shell with 36 commands for managing agents, sending and receiving email, configuring gateways, and more. It also re-exports everything from `@agenticmail/core` so you can use it as an SDK.

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
agenticmail setup

# 3. Start the API server + interactive shell
agenticmail start

# 4. Check system status
agenticmail status
```

---

## The Setup Wizard

Running `agenticmail setup` walks you through everything needed to get email working:

1. **System check** — verifies Docker is running, Stalwart mail server is healthy, and optionally checks for Cloudflared (the Cloudflare tunnel tool). Shows friendly status indicators and auto-installs missing components where possible.

2. **Account creation** — generates a master API key (the admin password for the entire system), creates the `~/.agenticmail` data directory, and initializes the SQLite database with all required tables.

3. **Service startup** — starts Docker if needed, ensures Stalwart is running and healthy.

4. **Email connection** — this is where you choose how your agents connect to the outside world:

### Relay Mode (Recommended for Getting Started)

Uses your existing Gmail or Outlook account. You provide your email address and an app password (not your regular password). The wizard:

- Lets you pick Gmail, Outlook, or a custom provider
- Handles Gmail's app password format (strips spaces automatically)
- Creates your first AI agent
- Sends a welcome test email
- Sets up relay polling so incoming mail gets delivered to agent inboxes
- Retries up to 3 times if authentication fails

Agent emails go out as sub-addresses like `yourname+agentname@gmail.com`. Replies come back through the same account.

### Domain Mode (For Professional Use)

Uses a custom domain with Cloudflare for DNS, email routing, and tunneling. The wizard:

- Takes your Cloudflare API token and account ID
- Optionally lets you search for and purchase a domain
- Configures MX records, SPF, DKIM, and DMARC automatically
- Sets up a Cloudflare Tunnel for inbound email delivery
- Configures a Cloudflare Email Worker as the catch-all handler
- Provides manual verification instructions for anything that needs confirmation

Agent emails use proper addresses like `secretary@yourdomain.com`.

---

## Starting the Server

`agenticmail start` does three things:

1. **Checks prerequisites** — verifies Docker and Stalwart are running. If there's no config file, runs the setup wizard automatically.

2. **Launches the API server** — forks `@agenticmail/api` as a child process, monitors it for crashes (captures the last 50 lines of error output for diagnostics), and waits up to 20 seconds for a health check response.

3. **Drops into the interactive shell** — once the API is healthy, you get an interactive command prompt where you can manage everything.

If the server crashes, you get clear error output showing what went wrong.

---

## System Status

`agenticmail status` shows a full health report:

- **Services** — Docker, Stalwart mail server, Cloudflared (if configured)
- **Account setup** — whether the config file and database exist
- **Server health** — API server connectivity and Stalwart reachability
- **Email gateway** — current mode (relay or domain), provider name, domain name, polling status

---

## The Interactive Shell

The shell is the main way to interact with AgenticMail. It provides 36 commands organized by category, with arrow-key navigation, color-coded output, and keyboard shortcuts.

### Getting Around

- Type `/` to see the command menu, then use arrow keys to navigate and Enter to select
- Type any command directly (e.g., `/inbox`)
- Press **Escape** at any point to cancel and go back
- Press **Tab** to auto-complete commands

### Email Commands

| Command | What It Does |
|---------|-------------|
| `/inbox` | Interactive inbox viewer — use arrow keys to select messages, Enter to read, `v` to toggle body previews, left/right arrows for pagination. Unread messages marked with a star. |
| `/send` | Compose and send an email. Prompts for recipient, subject, and body. Supports file attachments via drag-and-drop or file path. |
| `/read` | Read a specific email by number. Shows full headers, body, and attachment list. |
| `/reply` | Reply to an email. Auto-fills the recipient, subject (with Re: prefix), and quoted body. Supports attachments. |
| `/forward` | Forward an email. Includes original message and attachments. |
| `/search` | Search emails by keyword. Can search both local inbox and connected relay account (Gmail/Outlook). Offers to import relay results. |
| `/delete` | Delete an email (shows inbox preview first). |
| `/save` | Download email attachments to a file. Lets you pick individual attachments or save all. |
| `/thread` | View an email conversation. Groups messages by subject (strips Re:/Fwd: prefixes) and shows up to 20 messages. |
| `/unread` | Mark an email as unread. |
| `/archive` | Move an email to the Archive folder. |
| `/trash` | Move an email to Trash. |
| `/sent` | Browse sent emails with pagination. |
| `/digest` | Quick inbox overview with body previews for each message. |

### Organization Commands

| Command | What It Does |
|---------|-------------|
| `/folders` | List all folders, create new ones, or browse a specific folder with pagination. |
| `/contacts` | Manage your address book — list, add, or delete contacts. |
| `/drafts` | Save, edit, and send draft emails. Also lets you browse the Drafts IMAP folder. |
| `/signature` | Create and manage email signatures. One can be marked as default (shown with a star). |
| `/templates` | Create reusable email templates. Use them to quickly send formatted emails. |
| `/schedule` | Schedule emails for future delivery. Comes with 5 quick presets (30 min, 1 hour, 3 hours, tomorrow 8am, tomorrow 9am) plus custom date/time input with timezone support. |
| `/tag` | Create colored tags and apply them to messages. View messages by tag. |
| `/rules` | Create email filtering rules. Set conditions (from address, subject contains) and actions (move to folder, mark as read, delete). |

### Agent Commands

| Command | What It Does |
|---------|-------------|
| `/agents` | List all AI agents with their email address, API key (partially hidden), and owner name. |
| `/switch` | Switch the active agent. Changes which inbox you're viewing and which agent sends email. |
| `/deleteagent` | Delete an agent. Requires typing the agent's name to confirm (3 attempts). Archives all emails and generates a deletion report. |
| `/deletions` | View past agent deletion reports with email counts and top correspondents. |
| `/name` | Set a display name for the active agent. This appears in the From: header (e.g., "secretary from John"). |

### Security Commands

| Command | What It Does |
|---------|-------------|
| `/spam` | View spam folder, report emails as spam, mark emails as not-spam, or get a detailed spam score showing which detection rules matched and their point values. |
| `/rules` | Create email filtering rules (also listed under Organization). |
| `/pending` | View blocked outbound emails that need approval. List all pending, approve to send, or reject to discard. Master key required — agents cannot approve their own emails. |

### Chat & Agent Commands

| Command | What It Does |
|---------|-------------|
| `/chat` | **Chat directly with your OpenClaw AI agent** — opens a real-time chat session via WebSocket. Features bubble-style UI (agent left, user right), markdown rendering, elapsed timer during thinking, and multi-line input support. Uses Ed25519 device auth for secure gateway access. |
| `/tasks` | View pending tasks assigned to your agent. |
| `/msg` | Send a message to another AI agent by name. |
| `/assign` | Assign a task to another agent via the task queue. |

### Gateway Commands

| Command | What It Does |
|---------|-------------|
| `/relay` | Search the connected relay account (Gmail/Outlook) and import specific emails into the local inbox. |
| `/setup` | Re-run the setup wizard. |
| `/status` | Show server health, gateway mode, and agent count. |
| `/openclaw` | Launch an OpenClaw terminal session. Opens in a new terminal window (macOS Terminal, or gnome-terminal/xterm/konsole on Linux). |

### System Commands

| Command | What It Does |
|---------|-------------|
| `/help` | Show all available commands with descriptions. |
| `/clear` | Clear the screen. |
| `/exit` | Exit the shell (also `/quit`). Stops the server and cleans up. |

---

## Inbox Navigation

The inbox viewer (`/inbox`) is fully interactive:

- **Up/Down arrows** — move the cursor between emails (green arrow indicator)
- **Left arrow or `p`** — previous page
- **Right arrow or `n`** — next page
- **Enter** — open the selected email full-screen (press any key to return)
- **`v`** — toggle body previews on/off
- **Escape** — exit the inbox viewer

10 emails per page. Unread emails show a cyan star. Colors rotate through 8 different colors for visual variety.

---

## Email Approval Workflow

This is one of the most important features. When an AI agent sends an email that the outbound security guard flags (containing passwords, API keys, personal information, etc.):

1. The email is **blocked and stored** in the pending queue
2. The **owner is notified** via a notification email to their relay address (Gmail/Outlook)
3. The owner can approve or reject through the `/pending` command in the shell

But there's an easier way: the owner can simply **reply to the notification email**. Reply with "approve", "yes", "lgtm", "go ahead", "send", or "ok" to send the blocked email. Reply with "reject", "no", "deny", "cancel", or "block" to discard it. The relay polling system picks up the reply and acts on it automatically.

The relay polling acts like a persistent background job — it keeps checking for new messages on an exponential backoff schedule (starting at 30 seconds, growing to a cap of 5 minutes, resetting when mail arrives). This means the agent effectively has a follow-up mechanism: it can periodically check if its blocked email was approved and continue accordingly.

---

## Scheduled Emails

The `/schedule` command supports many time formats:

- **Quick presets:** 30 minutes, 1 hour, 3 hours, tomorrow 8am, tomorrow 9am
- **Custom dates:** `02-14-2026 3:30 PM EST`
- **Relative:** `in 30 minutes`, `in 2 hours`
- **Named:** `tomorrow 8am`, `tomorrow 2pm`
- **Day of week:** `next monday 9am`, `next friday 2pm`
- **Casual:** `tonight`, `this evening` (sends at 8 PM)

Timezone support includes: EST, EDT, CST, CDT, MST, MDT, PST, PDT, GMT, UTC, BST, CET, CEST, IST, JST, AEST, AEDT, and many more. The system automatically detects your local timezone as a default.

---

## Attachments

The shell supports file attachments in `/send`, `/reply`, and `/forward`:

- **Drag and drop** — drag a file from Finder/Explorer into the terminal
- **File path** — type or paste a file path (handles quotes, spaces, and `~` expansion)
- Files are base64-encoded before upload
- File sizes are displayed in KB
- You can attach multiple files to a single email

For downloading attachments, `/save` lets you pick individual attachments or save all at once.

---

## OpenClaw Integration

`agenticmail openclaw` is a 5-step setup command that integrates AgenticMail with the OpenClaw agent framework:

1. Checks if Docker and Stalwart are already running (reuses existing infrastructure)
2. Starts the API server if not already running
3. **Agent selection** — shows existing agents with inbox/sent counts in an interactive arrow-key selector, or lets you create a new one
4. Merges the AgenticMail plugin configuration into your `openclaw.json` (searches current directory and `~/.openclaw/`, supports JSON and JSONC formats)
5. Offers to restart the OpenClaw gateway so the plugin activates immediately

### Chat with Your AI Agent

Once set up, use `/chat` in the AgenticMail shell to talk directly to your OpenClaw agent:

- **Real-time WebSocket connection** to the OpenClaw gateway
- **Bubble-style UI** — agent messages left-aligned with gray borders, your messages right-aligned with blue borders
- **Markdown rendering** — bold, italic, code, headers, and bullet lists rendered in ANSI
- **Thinking indicator** — animated spinner with elapsed timer while the agent processes
- **Multi-line input** — Enter sends, `\` + Enter for new lines, arrow keys to navigate, backspace merges lines
- **Ed25519 device authentication** — secure keypair-based auth for full scope access
- **Esc to exit** — returns cleanly to the main shell

### Smart Sub-Agent Spawning (`call_agent`)

The `call_agent` tool intelligently spawns sub-agents with:

- **Auto mode detection** — analyzes task complexity to choose light (simple math/lookups), standard (web research, file ops), or full (multi-agent coordination) mode
- **Dynamic timeouts** — light=60s, standard=180s, full=300s, max=600s
- **Dynamic tool discovery** — probes OpenClaw config at runtime to detect available tools (Brave search, web_fetch, etc.)
- **Web search fallback** — when Brave API isn't configured, sub-agents automatically use DuckDuckGo via `web_fetch`
- **Async mode** — `call_agent(async=true)` for long-running tasks (hours/days); agent runs independently and emails results when done

---

## Programmatic Usage

The package re-exports everything from `@agenticmail/core`, so you can use it as an SDK:

```typescript
import {
  AgenticMailClient,
  MailSender,
  MailReceiver,
  parseEmail,
  InboxWatcher,
  AccountManager,
  StalwartAdmin,
  GatewayManager,
  RelayGateway,
  CloudflareClient,
  TunnelManager,
  DNSConfigurator,
  DomainPurchaser,
  getDatabase,
  EmailSearchIndex,
  type SendMailOptions,
  type ParsedEmail,
  type Agent,
  type GatewayConfig,
} from 'agenticmail';
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

# === Debug ===
# AGENTICMAIL_DEBUG=1                       # Verbose per-message logging
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
