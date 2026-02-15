# agenticmail — Technical Reference

Complete technical reference for the AgenticMail CLI and facade package. Covers CLI commands, interactive shell commands, keyboard shortcuts, re-exports, and all configuration.

---

## Package Structure

| Entry | File | Purpose |
|-------|------|---------|
| CLI binary | `dist/cli.js` | Command-line interface |
| Library | `dist/index.js` | Re-exports from `@agenticmail/core` |
| Shell | (bundled in cli) | Interactive REPL |

**Bin:** `agenticmail` → `./dist/cli.js`

---

## Re-Exports from @agenticmail/core

The package re-exports the entire public API of `@agenticmail/core`:

### Classes

| Export | Description |
|--------|-------------|
| `AgenticMailClient` | High-level client for sending/receiving |
| `StalwartAdmin` | Stalwart mail server admin interface |
| `AccountManager` | Agent CRUD operations |
| `MailSender` | SMTP email sending |
| `MailReceiver` | IMAP email receiving |
| `InboxWatcher` | Real-time inbox monitoring via IMAP IDLE |
| `GatewayManager` | Email gateway orchestration |
| `RelayGateway` | Gmail/Outlook relay |
| `CloudflareClient` | Cloudflare API client |
| `DomainPurchaser` | Domain search and purchase |
| `DNSConfigurator` | DNS record management |
| `TunnelManager` | Cloudflare Tunnel management |
| `DomainManager` | Domain setup and verification |
| `EmailSearchIndex` | Full-text email search |

### Functions

| Export | Description |
|--------|-------------|
| `parseEmail` | MIME email parser |
| `resolveConfig` | Config resolution |
| `ensureDataDir` | Data directory creation |
| `saveConfig` | Config persistence |
| `getDatabase` | SQLite database access |
| `closeDatabase` | Database cleanup |
| `createTestDatabase` | In-memory test database |

### Types

```typescript
AgenticMailClientOptions, AgenticMailConfig, StalwartAdminOptions,
StalwartPrincipal, Agent, CreateAgentOptions, MailSenderOptions,
MailReceiverOptions, SendMailOptions, SendResult, EmailEnvelope,
ParsedEmail, AddressInfo, Attachment, ParsedAttachment, MailboxInfo,
SearchCriteria, InboxWatcherOptions, InboxEvent, InboxNewEvent,
InboxExpungeEvent, InboxFlagsEvent, WatcherOptions, SearchableEmail,
DomainInfo, DnsRecord, DomainSetupResult, GatewayManagerOptions,
InboundEmail, DomainSearchResult, DomainPurchaseResult, DnsSetupResult,
TunnelConfig, GatewayMode, GatewayConfig, GatewayStatus, RelayConfig,
RelayProvider, DomainModeConfig, PurchasedDomain
```

### Constants

| Export | Description |
|--------|-------------|
| `RELAY_PRESETS` | Gmail/Outlook SMTP/IMAP server presets |

---

## CLI Commands

### agenticmail setup

Interactive setup wizard.

**Steps:**
1. System dependency check (Docker, Stalwart, Cloudflared)
2. Account creation (master key, data directory, database)
3. Service startup (Docker, Stalwart)
4. Email connection (relay or domain)

**Relay Setup Flow:**
- Provider selection: Gmail, Outlook, Custom
- Credentials: email + app password (Gmail spaces auto-stripped)
- Agent name input
- 3-attempt retry on auth failure
- Welcome test email
- Friendly error parsing

**Domain Setup Flow:**
- Cloudflare token + account ID
- Optional domain search (keywords + TLD)
- Automatic DNS: MX, SPF, DKIM, DMARC
- Cloudflare Tunnel setup
- Email Worker + catch-all routing
- Manual verification instructions

### agenticmail start

**Flow:**
1. Check config exists (auto-setup if missing)
2. Verify Docker + Stalwart running
3. Check if API already running on port
4. Fork `@agenticmail/api` as child process
5. Capture stderr (last 50 lines for crash diagnostics)
6. Wait up to 20s for health check
7. Launch `interactiveShell()`

**Child Process:**
- Forked via `child_process.fork()`
- Monitored for crashes with exit code reporting
- Environment variables passed from config

### agenticmail status

**Checks:**
- Docker daemon
- Stalwart mail server
- Cloudflared binary
- Config file existence
- API server health (`GET /api/agenticmail/health`)
- Gateway status (mode, provider, domain, polling)

### agenticmail openclaw

5-step OpenClaw integration:
1. Infrastructure check (Docker, Stalwart)
2. Start API server (fork)
3. Create/select agent account
4. Merge plugin config into `openclaw.json` (searches cwd, `~/.openclaw/`)
5. Offer gateway restart

**Config file support:** JSON, JSONC (via json5), warns about YAML

### agenticmail help

Displays usage and all available commands.

---

## Interactive Shell

### Entry

```typescript
function interactiveShell(options: ShellOptions): void
```

**ShellOptions:**
```typescript
{
  apiUrl: string;       // e.g., 'http://127.0.0.1:3100'
  masterKey: string;
  onExit: () => void;   // Cleanup callback
}
```

### Prompt Format

```
│ {agent-name} ❯ _
```

Agent name in cyan. Pipe character in dim.

### Command Menu

- Typing `/` shows a filtered command list
- Arrow keys navigate, Enter selects, Tab auto-completes
- Escape dismisses menu

---

## Shell Commands (36)

### Email Commands

#### /inbox

Interactive inbox viewer with pagination.

**Controls:**
| Key | Action |
|-----|--------|
| ↑ / ↓ | Move cursor (green `❯` indicator) |
| ← / `p` | Previous page |
| → / `n` | Next page |
| Enter | Open selected email (full-screen, any key to return) |
| `v` | Toggle body previews on/off |
| Escape | Exit inbox |

**Display:**
- 10 emails per page
- Unread: cyan `★` star, bold text
- Color-coded dots (8 rotating colors)
- Shows: sender address, subject (truncated), date

#### /send

Compose email interactively.

**Prompts:**
1. To (email address)
2. Subject
3. Body (multiline, empty line to finish)
4. Attachments (file path or drag-drop, empty to skip, can repeat)

**Attachment handling:** Base64 encoding, size display in KB, filename sanitization.

#### /read

Read specific email by number.

**Display:** Full headers (From, To, CC, Date, Subject, Message-ID), body (text or HTML-stripped), attachment list with sizes.

#### /reply

Reply to email.

**Auto-fills:** To (original sender), Subject (`Re: ...`), In-Reply-To, References.
**Body:** Quoted original with `> ` prefix.
**Supports:** Attachments, reply-all option.

#### /forward

Forward email.

**Auto-fills:** Subject (`Fwd: ...`), forwarded message header.
**Preserves:** Original attachments.

#### /search

Two modes:
1. **Local search** — searches IMAP inbox by keyword
2. **Relay search** — searches connected Gmail/Outlook account

Shows up to 10 local results, 15 relay results. Relay results offer import option.

#### /delete

Shows inbox preview, prompts for email number, confirms deletion.

#### /save

Download attachments. Interactive picker: `[1]`, `[2]`, ... or `[a]` for all. Prompts for save directory.

#### /thread

View email conversation. Groups by subject (strips `Re:` / `Fwd:` prefixes). Shows up to 20 messages chronologically.

#### /unread

Mark email as unread by number.

#### /archive

Move email to Archive folder.

#### /trash

Move email to Trash folder.

#### /sent

Browse sent emails with left/right arrow pagination.

#### /digest

Inbox preview with body snippets (first ~200 chars per message).

---

### Organization Commands

#### /folders

Three actions:
1. **List** — show all IMAP folders
2. **Create** — create new folder by name
3. **Browse** — paginated folder viewer (← → navigation)

#### /contacts

Three actions:
1. **List** — show all contacts with name and email
2. **Add** — name + email
3. **Delete** — by number from list

#### /drafts

Five actions:
1. **List** — show all drafts
2. **New** — compose a draft (to, subject, body)
3. **Send** — send a draft immediately
4. **Delete** — remove a draft
5. **Browse** — view the Drafts IMAP folder

#### /signature

Three actions:
1. **List** — show all signatures (default marked with `★`)
2. **Create** — name + text + optional "set as default"
3. **Delete** — by number from list

Setting as default automatically unsets previous default.

#### /templates

Four actions:
1. **List** — show all templates
2. **Create** — name + subject + body
3. **Use** — send from template (prompts for recipient and variable values)
4. **Delete** — by number from list

Variable substitution: `{{ variableName }}` in subject and body.

#### /schedule

**Quick presets:**
1. In 30 minutes
2. In 1 hour
3. In 3 hours
4. Tomorrow 8:00 AM
5. Tomorrow 9:00 AM
6. Custom date/time

**Custom format:** `MM-DD-YYYY H:MM AM/PM [TZ]`

**Supported timezones:** EST, EDT, CST, CDT, MST, MDT, PST, PDT, GMT, UTC, BST, CET, CEST, IST, JST, AEST, AEDT, NZST, NZDT, WAT, EAT, SAST, HKT, SGT, KST, HST, AKST, AKDT, AST, ADT, NST, NDT

**Also accepts:** ISO 8601, relative (`in 30 minutes`), named (`tomorrow 2pm`), day-based (`next monday 9am`), casual (`tonight`).

Validation: must be in the future. Lists pending scheduled emails with countdown.

#### /tag

Five actions:
1. **List** — show all tags with colors
2. **Create** — name + color (hex)
3. **Tag message** — apply tag to email by UID
4. **View by tag** — show all emails with a specific tag
5. **Delete** — remove a tag

#### /rules

Three actions:
1. **List** — show all rules with conditions and actions
2. **Create** — conditions (from_contains, subject_contains) + actions (move_to, mark_read, delete) + priority
3. **Delete** — by number from list

Rules evaluated on new email arrival (via SSE event handler). Higher priority checked first, first match wins.

---

### Agent Commands

#### /agents

Shows all agents with: email address, API key (first 8 chars + ...), owner name (from metadata).

#### /switch

Multi-agent selection. Changes which inbox is viewed and which agent sends email. Persists for the session.

#### /deleteagent

Three-attempt name confirmation. Archives all emails. Generates deletion report with email count and top correspondents.

#### /deletions

Browse past deletion reports. Shows: agent name, deletion date, reason, deleted by, email count, top correspondents.

#### /name

Set display name (stored as `ownerName` in agent metadata). Appears in From: header as `"agentname from YourName"`.

---

### Security Commands

#### /spam

Four actions:
1. **View** — list spam folder contents
2. **Report** — move email to Spam folder
3. **Not spam** — move email back to INBOX
4. **Score** — detailed spam analysis with rule matches and point values

#### /pending

Three actions:
1. **List** — show all pending (blocked) outbound emails with warnings
2. **Approve** — send the blocked email (master key required)
3. **Reject** — discard the blocked email (master key required)

Agents cannot self-approve — only the master key holder (human) can approve or reject. The human can also reply to the notification email with "approve"/"yes" or "reject"/"no".

---

### Gateway Commands

#### /relay

Two actions:
1. **Search** — search connected relay account (Gmail/Outlook)
2. **Import** — import a specific email from relay into local inbox

#### /setup

Displays message to run `agenticmail setup` from the command line.

#### /status

Shows server health, Stalwart status, gateway mode, and agent count.

#### /openclaw

Launches OpenClaw TUI in a new terminal window:
- **macOS:** `open -a Terminal`
- **Linux:** `gnome-terminal`, `xterm`, or `konsole` (tries in order)

---

### System Commands

#### /help

Formatted list of all commands with descriptions.

#### /clear

Clears terminal screen (`\x1b[2J\x1b[H`).

#### /exit, /quit

Calls `onExit()` cleanup callback. Exits process.

---

## Configuration

### Config File

Location: `~/.agenticmail/config.json`

```typescript
interface SetupConfig {
  dataDir: string;
  masterKey: string;
  stalwart: {
    adminUser: string;
    adminPassword: string;
    url: string;
  };
  api: {
    port: number;
    host: string;
  };
  smtp: { host: string; port: number };
  imap: { host: string; port: number };
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENTICMAIL_MASTER_KEY` | Master API key |
| `AGENTICMAIL_DATA_DIR` | Data directory (default: `~/.agenticmail`) |
| `STALWART_ADMIN_USER` | Stalwart admin username |
| `STALWART_ADMIN_PASSWORD` | Stalwart admin password |
| `STALWART_URL` | Stalwart HTTP admin URL |
| `AGENTICMAIL_API_PORT` | API server port |
| `AGENTICMAIL_API_HOST` | API server host |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP server port |
| `IMAP_HOST` | IMAP server host |
| `IMAP_PORT` | IMAP server port |

---

## UI Elements

### Colors

| Color | Usage |
|-------|-------|
| Green (`✓`) | Success, active, confirmation |
| Red (`✗`) | Error, warning, danger |
| Cyan | Links, primary info, agent name |
| Yellow | Warnings, loading, time info |
| Magenta | Prompts |
| Dim | Secondary text, navigation hints |

### Layout

| Element | Character |
|---------|-----------|
| Box border | `╭─╮`, `│`, `╰─╯` |
| Horizontal rule | `─` |
| Bullet | `●` (8 rotating colors) |
| Menu pointer | `▸` |
| Unread star | `★` (cyan) |
| Active agent | `◂` |

### Spinner Messages

Category-specific loading messages:

| Category | Example Messages |
|----------|-----------------|
| docker | "Getting the engine ready...", "Just warming things up..." |
| stalwart | "Setting up your personal post office..." |
| cloudflared | "Opening a secure path to the internet..." |
| config | "Creating your private settings..." |
| relay | "Connecting to your email account..." |
| domain | "Pointing your domain to AgenticMail..." |
| server | "Firing up the server..." |

---

## Input Helpers

### ask(prompt)

Standard readline input with prompt text.

### askSecret(prompt)

Raw-mode password input. Characters displayed as `*`. Supports backspace.

### pick(options)

Single-keypress selection. Arrow keys move cursor, Enter or number key selects.

### askNumber(prompt)

Integer input with retry logic.

### askChoice(options)

Numbered list selection with validation.

### cleanFilePath(path)

Handles:
- Drag-and-drop paths (strips quotes, trailing spaces)
- Home directory expansion (`~`)
- Backslash conversion
- Quote removal

---

## Process Management

### Server Forking

```typescript
const child = fork(apiEntryPath, [], {
  env: { ...process.env, ...configToEnv(setupConfig) },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
});
```

- Stderr captured (last 50 lines) for crash diagnostics
- Health check polling: `GET /api/agenticmail/health` with 20s timeout
- Signal forwarding: SIGINT and SIGTERM

### API Resolution

`resolveApiEntry()` finds `@agenticmail/api` entry point:
1. `require.resolve('@agenticmail/api')` (npm install)
2. `../packages/api/dist/index.js` (monorepo)

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@agenticmail/api` | Server process (forked) |
| `@agenticmail/core` | Re-exported SDK |
| `json5` | JSONC config parsing (OpenClaw) |

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
