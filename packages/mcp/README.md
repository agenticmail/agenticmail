<p align="center">
  <img src="https://raw.githubusercontent.com/agenticmail/agenticmail/main/docs/images/logo-200.png" alt="AgenticMail logo (pink bow)" width="180" />
</p>

<h1 align="center">@agenticmail/mcp</h1>

The MCP (Model Context Protocol) server for [AgenticMail](https://github.com/agenticmail/agenticmail) — gives any MCP-compatible AI client full email and SMS capabilities.

When connected, your AI agent can send emails and texts, check inboxes, reply to messages, receive verification codes, manage contacts, schedule emails, assign tasks to other agents, and more — all through natural language. The server provides 100 tools that cover every email, SMS, and agent management operation.

## ✨ What's new in 0.9.0

- **🧠 `get_thread_id` + `save_thread_memory`** — two new tools in the `multi_agent_extras` tier. Workers call `get_thread_id({uid})` once after reading a new message, then `save_thread_memory({threadId, summary, commitments?, openQuestions?, lastAction?, lastUid?})` at end-of-wake. The dispatcher reads the memory back into the next wake's prompt automatically. Pairs with the dispatcher-side ThreadCache to flatten wake cost — agents no longer have to re-read 10 prior messages every time.
- **🎯 `send_email` / `reply_email` / `forward_email` / `template_send` docs updated** for the new `wake` defaults. CC'd local agents no longer wake by default; `wake: 'all'` opts back into the pre-0.9.0 behaviour.

## ✨ Earlier — 0.7.9

- **📐 `call_agent` accepts `outputSchema`** — pass a JSON Schema (draft-7 subset) describing the deliverable shape and the API validates `submit_result` against it; mismatches come back as validator errors so the worker can retry with a correct shape instead of returning free-form prose. The schema is rendered into the worker's wake prompt up-front. Example:
  ```js
  await call_agent({
    target: 'vesper',
    task: 'Audit row 34 of the YAML patch.',
    outputSchema: {
      type: 'object',
      required: ['summary', 'findings', 'recommendation'],
      properties: {
        summary:        { type: 'string' },
        findings:       { type: 'array', items: { type: 'string' } },
        recommendation: { type: 'string', enum: ['proceed', 'block'] },
      },
    },
  });
  ```
- **📥 `tail_worker(workerId, lines?)`** — paired with `check_activity`. When a worker shows up as long-running or stale, `tail_worker` returns the trailing N lines of its log (every tool call, result, and assistant chunk as a one-liner). Master-key only. Lives in the `multi_agent_extras` tier so it ships in the default toolbelt for hosts that delegate work.
- **📊 `check_activity` shows live progress** — output now includes last tool used, tool-call count, duration in `Xh Ym Zs`, and a `stale` flag derived from heartbeat age. Workers are no longer auto-evicted from the registry; staleness is diagnostic.

## ✨ Earlier — 0.7.7

- **`wake` parameter on every send tool** — `send_email`, `reply_email`, `forward_email`, `template_send`, `manage_drafts(send)` all accept `wake: ["alice", "bob"]` (or comma-separated string). The dispatcher gives a Claude turn only to listed agents; the rest still receive the mail but stay asleep. Single biggest token saver on multi-agent threads.
- **`check_activity` tool** (in the `essential` set) — see which agents the dispatcher has woken right now, what they're working on, how long they've been running, plus a preview of recently-finished work. Answers "did the agent I just emailed actually start working?" without waiting for a reply.
- **Thread-close markers** — put `[FINAL]`, `[DONE]`, `[CLOSED]`, or `[WRAP]` in a subject to tell the dispatcher this thread is sealed; no more wakes on any reply to it. The wake prompt teaches agents to add these markers when they sign off the work.
- **LLM-tolerant input coercion** — `batch_mark_read({ uids: "[1,2,3,4]" })`, `wait_for_email({ timeout: "120" })`, `manage_drafts({ where: '{"id":"abc"}' })`, `manage_pending({ allowSensitive: "true" })` all now just work. Strings get parsed before zod validates. No more "expected array, received string" retries.
- **Server `instructions` field** sent on `initialize` — every connecting MCP client (Claude Code, ChatGPT, Cursor, Grok…) gets the coordination protocol in context before they touch any tool. Provider-agnostic.
- **`wait_for_email` filters** — block on a specific reply, not just "any new event". Supports `from`, `subject`, `inReplyTo`, `participants`, `includeTasks`.

## Install

```bash
npm install -g @agenticmail/mcp
```

**Requirements:** Node.js 22+, AgenticMail API server running

## 🔒 Security — HTTP Transport Authentication (v0.9.27)

> **GHSA-63gr-g7jc-v8rg** — Versions before 0.9.27 exposed the `/mcp`
> HTTP endpoint without authentication when started with `--http` or
> `MCP_HTTP=1`. Any LAN client could initialize a session and invoke
> master-key-only tools using the server's own credentials.

As of **0.9.27**, the HTTP transport enforces bearer-token authentication:

- **Bind restriction:** Defaults to `127.0.0.1` (not `0.0.0.0`). Override
  with `--host=0.0.0.0` or `MCP_HTTP_HOST=0.0.0.0`.
- **Token required:** Every `/mcp` request must include
  `Authorization: Bearer <token>`. Missing or invalid tokens return 401.
- **Token resolution order:**
  1. `--token=<value>` CLI flag
  2. `MCP_HTTP_TOKEN` env var
  3. Auto-minted persistent file at `~/.agenticmail/mcp-http-token` (chmod 600)
- **Opt-out:** `--insecure` disables authentication (sandboxed test
  environments only — prints a loud warning at startup).
- `/health` remains open (returns session count only).
- Stdio mode (the default) was never affected.

**Example — authenticated HTTP setup:**
```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "agenticmail-mcp",
      "args": ["--http", "--port=8014"],
      "env": {
        "MCP_HTTP_TOKEN": "your-secret-token",
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3829",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

---

## What This Package Does

This is the bridge between your AI client and the AgenticMail system. It runs as a subprocess that the AI communicates with through standard input/output (no network ports opened). Every tool call gets translated into an API request to the AgenticMail server, and the response comes back as formatted text the AI can understand.

Think of it this way: your AI agent doesn't know how to send email natively. This MCP server teaches it how by giving it a set of tools — "send_email", "list_inbox", "reply_email", and so on — that the AI can call when you ask it to do email-related tasks.

---

## Setup

### MCP Client Setup (CLI-Based)

Add to your MCP client configuration (e.g., `.mcp.json` or project settings):

```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "npx",
      "args": ["agenticmail-mcp"],
      "env": {
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3829",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

### Desktop Clients

For desktop AI applications, add to your MCP configuration file. Example paths:
- **macOS:** `~/Library/Application Support/<app>/config.json`
- **Windows:** `%APPDATA%\<app>\config.json`

```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "npx",
      "args": ["agenticmail-mcp"],
      "env": {
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3829",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTICMAIL_API_URL` | Yes | AgenticMail API server URL. Default port is **`3829`** (changed from `3100` in `@agenticmail/mcp@0.7.x` to avoid common dev-tool conflicts). Example: `http://127.0.0.1:3829`. |
| `AGENTICMAIL_API_KEY` | Yes¹ | Agent API key (`ak_...`). Determines the default identity this MCP server acts as when a tool call doesn't pass `_account`. |
| `AGENTICMAIL_MASTER_KEY` | No | Master key (`mk_...`). Required for admin operations (create/delete agents, approve emails, gateway config). **Also enables on-demand `_account` resolution** — any tool call passing `_account: "<name>"` will lazily fetch that agent's API key via the master key the first time it sees the name, so freshly-`create_account`'d agents become addressable without restarting the MCP server. |
| `AGENTICMAIL_ACCOUNT_KEYS_JSON` | No | JSON map of `{"<agentName>": "<apiKey>"}` for per-call identity switching. When the caller passes `_account: "Fola"` (etc.), the server authenticates AS that agent for the duration of the call. Populated automatically by `agenticmail claudecode install` for the Claude Code integration. |

¹ Either `AGENTICMAIL_API_KEY` OR `AGENTICMAIL_MASTER_KEY` (or `AGENTICMAIL_ACCOUNT_KEYS_JSON`) must be set, but you don't strictly need all three.

### Per-call identity switching (`_account`)

Every tool's input schema accepts an optional `_account: "<name>"` parameter. When passed, the server resolves that name to an apiKey (from `AGENTICMAIL_ACCOUNT_KEYS_JSON`, then falling back to a live master-keyed lookup of `/accounts`) and runs the call as that agent. Without `_account`, the call uses `AGENTICMAIL_API_KEY` as the default identity.

This is what powers the [`@agenticmail/claudecode`](https://www.npmjs.com/package/@agenticmail/claudecode) integration: one MCP server process, many AgenticMail identities. A Claude Code subagent that "is" Fola passes `_account: "Fola"` on every call and ends up reading Fola's real inbox, sending mail from `fola@localhost`, and so on.

### Meta-tools for cheap discovery (`request_tools` + `invoke`)

To keep host context windows small, only ~10 of the 100 tools are pre-declared in a typical subagent's `tools:` whitelist. The other ~50 stay reachable through two always-on meta-tools:

- **`request_tools({ query?, sets? })`** — Returns a text catalogue of the unloaded tools, grouped by set (`mail_extras`, `mail_compose`, `sms`, `account_admin`, …). Optional substring filter or set-name filter.
- **`invoke({ tool, args, _account? })`** — Dispatches to any of the 100 tools by name. The agent uses `request_tools` to discover, `invoke` to call.

Token impact: a typical subagent spawn loads ~3K tokens of tool schemas instead of ~15K. The cost is one extra round trip for uncommon operations (discover → invoke), which is almost always a worthwhile trade.

---

## How It Works

The MCP server sits between your AI and the AgenticMail API:

```
AI Client → MCP tool call → agenticmail-mcp → HTTP request → AgenticMail API → Stalwart Mail Server
```

Each tool call:
1. Receives structured arguments from the AI
2. Validates the input (UIDs must be positive integers, arrays must be non-empty, etc.)
3. Makes an HTTP request to the AgenticMail API with a 30-second timeout
4. Returns formatted text results back to the AI

The server runs with stdio transport — the AI client sends JSON-RPC messages via stdin, and the server responds via stdout. No network ports are opened by the MCP server itself. It shuts down gracefully on SIGTERM or SIGINT.

---

## Tools

### Email — Core Operations (13 tools)

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `send_email` | Send email with to, subject, text/html, attachments, CC | "Send an email to john@example.com about the meeting" |
| `list_inbox` | List recent inbox messages (paginated, up to 100) | "Check my inbox" |
| `read_email` | Read full email content with security analysis | "Read email #42" |
| `reply_email` | Reply (or reply-all) preserving threading | "Reply to that email saying I'll attend" |
| `forward_email` | Forward an email with original attachments | "Forward that to sarah@example.com" |
| `search_emails` | Search by from, subject, body, date range, relay | "Find emails from John about the budget" |
| `delete_email` | Delete a specific email by UID | "Delete that spam email" |
| `move_email` | Move email to a folder | "Move this to Archive" |
| `mark_read` | Mark email as read | "Mark email #15 as read" |
| `mark_unread` | Mark email as unread | "Mark that as unread" |
| `inbox_digest` | Get inbox summary with body previews | "Give me a digest of my inbox" |
| `wait_for_email` | Wait for new email in real time (up to 5 minutes) | "Wait for a reply from john@example.com" |
| `import_relay_email` | Import email from connected Gmail/Outlook | "Import email UID 500 from Gmail" |

### Email — Batch Operations (5 tools)

| Tool | Description |
|------|-------------|
| `batch_delete` | Delete multiple emails by UID list |
| `batch_mark_read` | Mark multiple emails as read |
| `batch_mark_unread` | Mark multiple emails as unread |
| `batch_move` | Move multiple emails to a folder |
| `batch_read` | Read multiple full emails at once |

### Email — Organization (14 tools)

| Tool | Description |
|------|-------------|
| `manage_contacts` | Add, remove, and list contacts in address book |
| `manage_drafts` | Create, list, edit, delete, and send drafts |
| `manage_tags` | Create tags, assign to messages, remove, list |
| `manage_rules` | Create email filtering rules (auto-move, auto-delete, mark read) |
| `manage_signatures` | Create, list, and delete email signatures |
| `manage_templates` | Create, list, and delete email templates |
| `manage_scheduled` | Schedule emails for future delivery, list, cancel |
| `manage_spam` | List spam folder, report spam, mark as not-spam, get spam score |
| `manage_pending_emails` | View blocked outbound emails awaiting approval |
| `template_send` | Send email using a saved template with variable substitution |
| `create_folder` | Create a new IMAP folder |
| `list_folder` | List messages in a specific folder |
| `list_folders` | List all available folders |
| `check_health` | Check AgenticMail server and Stalwart health |

### Multi-Agent Communication (8 tools)

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `list_agents` | List all agents with name, email, role | "Show me all agents" |
| `message_agent` | Send email to another agent (with priority levels) | "Tell the researcher to look up pricing data" |
| `check_messages` | Check for new messages from agents and externals | "Any new messages?" |
| `call_agent` | Call another agent with a task (sync or async) | "Call the analyst to research this topic" |
| `claim_task` | Claim a pending task assigned to you | "Claim that task" |
| `submit_result` | Submit result for a claimed task | "Submit the research findings" |
| `check_tasks` | Check incoming or outgoing tasks | "Do I have any pending tasks?" |
| `call_agent` | Synchronous RPC — waits for result (up to 5 min) | "Ask the researcher to find pricing and wait" |

### Administration (7 tools)

These tools require the master key (`AGENTICMAIL_MASTER_KEY`):

| Tool | Description |
|------|-------------|
| `create_account` | Create a new agent with name and role |
| `delete_agent` | Delete an agent (archives emails, records report) |
| `stop_agent` | Soft-stop an agent mid-task — dispatcher refuses to wake it, mail still lands in the inbox (audit trail preserved) |
| `resume_agent` | Reverse `stop_agent` — dispatcher resumes waking the agent; mail received while stopped is in the inbox and picked up on next wake |
| `cleanup_agents` | List inactive agents, clean up, set persistent |
| `deletion_reports` | View past agent deletion reports |
| `update_metadata` | Update agent metadata (display name, owner, etc.) |
| `whoami` | Get current agent info (name, email, role, ID) |
| `setup_payment` | Get Cloudflare payment setup instructions |

### Gateway Configuration (6 tools)

These tools require the master key:

| Tool | Description |
|------|-------------|
| `check_gateway_status` | Check current email gateway mode and health |
| `setup_email_relay` | Configure Gmail/Outlook relay mode |
| `setup_email_domain` | Configure custom domain with Cloudflare |
| `setup_gmail_alias` | Get Gmail "Send mail as" alias instructions |
| `setup_guide` | Show relay vs domain comparison guide |
| `send_test_email` | Send a test email to verify gateway |
| `purchase_domain` | Search for and purchase a domain |

### SMS / Phone Number (8 tools)

| Tool | Description |
|------|-------------|
| `sms_setup` | Configure Google Voice or 46elks phone number access |
| `sms_send` | Send SMS through 46elks API or return Google Voice send instructions |
| `sms_messages` | List inbound/outbound SMS messages |
| `sms_check_code` | Extract verification/OTP codes from recent SMS |
| `sms_read_voice` | Read SMS directly from Google Voice web (fastest method) |
| `sms_record` | Record an SMS read from Google Voice web or any source |
| `sms_parse_email` | Parse SMS from forwarded Google Voice email (fallback) |
| `sms_config` | Get current SMS configuration |

---

## Outbound Security Scanning

Every email sent through `send_email`, `reply_email`, or `forward_email` is scanned before going out. The scanner checks for:

### What Gets Detected

**Personal Information (PII)** — Social Security numbers, credit card numbers, phone numbers, bank routing numbers, driver's license numbers, passport numbers, tax IDs, Medicare/Medicaid IDs, immigration numbers, PINs, security question answers, IBAN/SWIFT codes, cryptocurrency wallet addresses, wire transfer instructions

**Credentials** — API keys, AWS keys, passwords, private keys (PEM format), bearer tokens, database connection strings, GitHub tokens, Stripe keys, JWTs, webhook URLs, environment variable blocks, crypto seed phrases, 2FA backup codes, username/password pairs, OAuth tokens, VPN credentials

**System Internals** — Private IP addresses, file paths from common system directories, environment variable assignments

**Owner Privacy** — Mentions of the owner's personal information, revelations about who created or operates the agent

**Risky Attachments** — Private key files (.pem, .key, .p12, .pfx), environment files (.env, .credentials), database files (.db, .sqlite), executables (.exe, .bat, .sh, .ps1), and more

### What Happens When Something Is Found

- **Medium severity** — the email is sent, but the AI receives a warning in the response
- **High severity** — the email is **blocked** and stored for human review

When an email is blocked, the AI is told the pending ID and instructed to let the user know. The user (owner) receives a notification email with the full blocked content and instructions.

### Human-Only Approval

The AI **cannot** approve or reject its own blocked emails. The `manage_pending_emails` tool only allows listing and viewing — approve/reject actions are explicitly rejected with a clear error message. Only the human owner can approve (via the API, the interactive shell, or by replying "approve" or "yes" to the notification email).

### Automatic Follow-Up Reminders

When an email is blocked, the MCP server automatically schedules escalating follow-up reminders for the AI:

1. **12 hours** — first reminder
2. **6 hours** — second reminder
3. **3 hours** — third reminder
4. **1 hour** — final reminder before cooldown
5. **3-day cooldown** — then the cycle restarts

These reminders are injected into tool responses, prompting the AI to ask the user about the pending approval. A background heartbeat checks every 5 minutes to detect if the owner has already approved or rejected the email, and cancels the reminders if so.

---

## Inbound Security

When the AI reads an email with `read_email`, the response includes a security analysis:

- **Spam score** — how likely the email is to be spam or malicious (0-100)
- **Category** — what type of threat was detected (phishing, social engineering, prompt injection, etc.)
- **Sanitization** — whether invisible Unicode characters or hidden HTML were found and cleaned
- **Attachment warnings** — flags for executables, archives, HTML files, and disguised file extensions (like `report.pdf.exe`)

Internal emails (between agents on the same system) are trusted and skip spam scoring.

---

## Waiting for Email in Real Time

The `wait_for_email` tool opens a Server-Sent Events (SSE) connection to the API and listens for new emails or task notifications. If SSE is unavailable, it falls back to polling the inbox. This is useful for workflows where the AI needs to wait for a reply before continuing.

The wait has a configurable timeout (default 2 minutes, maximum 5 minutes). When an email arrives, the tool returns details about the message. If a task notification arrives instead, it returns the task information.

---

## Relay Email Integration

When the owner has connected a Gmail or Outlook account as a relay, the AI can:

- **Search the relay** — `search_emails` with `searchRelay: true` searches both the local inbox and the connected Gmail/Outlook account. Relay results come back with a separate set of UIDs tagged by account.
- **Import from relay** — `import_relay_email` pulls a specific email from the relay account into the local inbox, preserving all headers for proper threading.

This means the AI can find and import emails from the owner's real Gmail/Outlook inbox, then reply to them normally through the AgenticMail system.

---

## Scheduled Emails

The `manage_scheduled` tool accepts flexible time formats:

- **ISO 8601:** `2026-02-14T10:00:00Z`
- **Relative:** `in 30 minutes`, `in 2 hours`
- **Named:** `tomorrow 8am`, `tomorrow 2pm`
- **Day of week:** `next monday 9am`, `next friday 2pm`
- **Human format:** `02-14-2026 3:30 PM EST`
- **Casual:** `tonight`, `this evening`

The API server checks every 30 seconds for scheduled emails whose send time has arrived and sends them automatically.

---

## Inter-Agent Communication

### Message Priority

When using `message_agent`, the AI can set a priority level:
- **Normal** — no prefix
- **High** — subject prefixed with `[HIGH]`
- **Urgent** — subject prefixed with `[URGENT]`

### Synchronous RPC

The `call_agent` tool is unique — it assigns a task to another agent and then **holds the connection open** until that agent responds (up to 5 minutes). This is useful when the AI needs an answer from another agent before it can continue.

Under the hood, the API server polls every 2 seconds and also uses an instant resolution mechanism — when the target agent submits a result, the waiting connection resolves immediately.

### Task Lifecycle

Tasks go through states: **pending** → **claimed** → **completed** or **failed**. Any agent that knows a task ID can claim it, which supports architectures where sub-agents handle tasks on behalf of a parent agent.

---

## Resources

The MCP server provides one resource:

| URI | Name | Description |
|-----|------|-------------|
| `agenticmail://inbox` | Agent Inbox | Browse the current agent's 20 most recent inbox messages |

---

## Example Conversation

```
User: Check my email and summarize anything important

AI: [calls list_inbox]
You have 5 new emails:
1. john@example.com - "Q2 Budget Review" (2 hours ago)
2. sarah@example.com - "Re: Project Timeline" (4 hours ago)
3. notifications@github.com - "[repo] PR #123 merged" (5 hours ago)
...

[calls read_email for #1]
[calls read_email for #2]

Here's a summary of the important emails:

1. **Q2 Budget Review** from John — He's requesting approval for the revised
   budget. The total is $45K, up from $38K due to infrastructure costs.
   He needs a response by Friday.

2. **Project Timeline** from Sarah — She confirmed the new deadline is March 15.
   The design phase is complete and development starts Monday.

User: Reply to John saying I approve the budget

AI: [calls reply_email]
Reply sent to john@example.com with subject "Re: Q2 Budget Review"
```

---

## External inbox exposure — surface this before walking the operator through relay setup

> **The MCP tools that configure the relay (`setup_operator_email`, plus any agent advising the operator to run `agenticmail setup-email` or `setup-relay`) open every sub-agent up to the public internet via Gmail / Outlook plus-addressing.** Operators don't always realize this — host agents should warn explicitly:

- **Plus-addresses are publicly guessable.** Once relay is configured, anyone can email `your-relay+secretary@gmail.com`, `your-relay+kepler@gmail.com`, … and the corresponding AgenticMail agent receives it. The `+sub` part is not a secret.
- **External mail wakes the host dispatcher identically to internal `@localhost` mail.** The MCP server doesn't filter by source; the API publishes an SSE `new-mail` event for any inbound, and the host integration spawns a worker turn.
- **The host bridges take a different path.** Mail to `your-relay+claudecode@gmail.com` / `your-relay+codex@gmail.com` routes to `handleBridgeMail`, which uses the host SDK's `resume` option to wake the operator's last session headlessly. If resume fails, it falls through to the bridge-escalation email at `setup_operator_email` — exactly why that MCP tool exists.
- **Spam = worker turns.** Throttles in order of escalation: the `wake-budget` guard in the dispatcher (automatic), the relay-level spam filter, and `metadata.host`-based fencing for agents that should stay internal-only.

When a host agent is about to call any of the relay-setup tools or instruct the operator to run `setup-email`, paraphrase this for the operator first so they can opt in deliberately rather than discovering it the day they get their first spam wake.

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
