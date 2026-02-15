# @agenticmail/mcp

The MCP (Model Context Protocol) server for [AgenticMail](https://github.com/agenticmail/agenticmail) — gives any MCP-compatible AI client full email capabilities.

When connected, your AI agent can send emails, check inboxes, reply to messages, manage contacts, schedule emails, assign tasks to other agents, and more — all through natural language. The server provides 54 tools that cover every email and agent management operation.

## Install

```bash
npm install -g @agenticmail/mcp
```

**Requirements:** Node.js 20+, AgenticMail API server running

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
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3100",
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
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3100",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTICMAIL_API_URL` | Yes | AgenticMail API server URL (e.g., `http://127.0.0.1:3100`) |
| `AGENTICMAIL_API_KEY` | Yes | Agent API key (`ak_...`). Determines which agent this MCP server acts as. |
| `AGENTICMAIL_MASTER_KEY` | No | Master key (`mk_...`). Required for admin operations (create/delete agents, approve emails, gateway config). |

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
| `assign_task` | Assign a task to another agent (async) | "Assign a research task to the analyst" |
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

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
