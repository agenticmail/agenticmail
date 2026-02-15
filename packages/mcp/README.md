# @agenticmail/mcp

MCP (Model Context Protocol) server for [AgenticMail](https://github.com/agenticmail/agenticmail) — gives Claude Code, Claude Desktop, and any MCP-compatible AI client full email capabilities.

This server exposes 49 tools via stdio transport. When connected, Claude can send emails, check inboxes, reply to messages, manage contacts, assign tasks to other agents, and more — all through natural language.

## Install

```bash
npm install -g @agenticmail/mcp
```

**Requirements:** Node.js 20+, AgenticMail API server running

---

## Setup

### Claude Code

Add to your Claude Code MCP configuration (`.claude/mcp.json` or project settings):

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

### Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

## Tools

### Email — Core Operations

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `send_email` | Send email with to, subject, text/html, attachments, CC, BCC | "Send an email to john@example.com about the meeting" |
| `list_inbox` | List recent inbox messages (paginated) | "Check my inbox" |
| `read_email` | Read full email content by UID | "Read email #42" |
| `reply_email` | Reply to an email (preserves threading) | "Reply to that email saying I'll attend" |
| `forward_email` | Forward an email to another address | "Forward that to sarah@example.com" |
| `search_emails` | Search by from, subject, body, date range | "Find emails from John about the budget" |
| `delete_email` | Delete a specific email by UID | "Delete that spam email" |
| `move_email` | Move email to a folder | "Move this to the Archive folder" |
| `mark_read` | Mark email as read | "Mark email #15 as read" |
| `mark_unread` | Mark email as unread | "Mark that as unread" |
| `inbox_digest` | Get inbox summary with body previews | "Give me a digest of my inbox" |
| `wait_for_email` | Poll for email matching criteria (with timeout) | "Wait for a reply from john@example.com" |
| `import_relay_email` | Import specific email from relay account | "Import email UID 500 from Gmail" |

### Email — Batch Operations

| Tool | Description |
|------|-------------|
| `batch_delete` | Delete multiple emails by UID list |
| `batch_mark_read` | Mark multiple emails as read |
| `batch_mark_unread` | Mark multiple emails as unread |
| `batch_move` | Move multiple emails to a folder |
| `batch_read` | Read multiple emails at once (returns array) |

### Email — Organization

| Tool | Description |
|------|-------------|
| `manage_contacts` | Add, remove, list contacts in address book |
| `manage_drafts` | Create, list, edit, delete, send drafts |
| `manage_tags` | Create tags, assign to messages, remove, list |
| `manage_rules` | Create email filtering rules (auto-move, auto-delete, mark read) |
| `manage_signatures` | Create, list, delete email signatures |
| `manage_templates` | Create, list, delete email templates |
| `manage_scheduled` | Schedule emails for future delivery, list, cancel |
| `manage_spam` | List spam folder, report spam, mark as not-spam |
| `manage_pending_emails` | List blocked outbound emails, check approval status |
| `template_send` | Send an email using a saved template |
| `create_folder` | Create a new IMAP folder |
| `list_folder` | List messages in a specific folder |
| `list_folders` | List all available folders |

### Multi-Agent — Communication & Tasks

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `list_agents` | List all agents with name, email, role | "Show me all agents" |
| `message_agent` | Send email to another agent | "Tell the researcher agent to look up pricing data" |
| `check_messages` | Check for new messages from other agents | "Any new messages from other agents?" |
| `assign_task` | Assign a task to another agent (async) | "Assign a research task to the analyst" |
| `claim_task` | Claim a pending task assigned to you | "Claim that task" |
| `submit_result` | Submit result for a claimed task | "Submit the research findings" |
| `check_tasks` | Check pending tasks assigned to you | "Do I have any pending tasks?" |
| `call_agent` | Synchronous RPC call to another agent (waits for result) | "Ask the researcher to find competitor pricing and wait for the answer" |

### Administration

| Tool | Description |
|------|-------------|
| `create_account` | Create a new agent (requires master key) |
| `delete_agent` | Delete an agent with email archival |
| `cleanup_agents` | Remove inactive agents (keeps persistent ones) |
| `creation_reports` | View past agent deletion reports |
| `update_metadata` | Update agent metadata (name display, owner, etc.) |
| `whoami` | Get current agent info (name, email, role) |
| `check_health` | Check AgenticMail server health |

### Gateway — Email Configuration

| Tool | Description |
|------|-------------|
| `check_gateway_status` | Check current email gateway mode and health |
| `setup_email_relay` | Configure Gmail/Outlook relay mode |
| `setup_email_domain` | Configure custom domain with Cloudflare |
| `setup_gmail_alias` | Get instructions for Gmail "Send mail as" alias |
| `setup_guide` | Show gateway setup guide (relay vs domain comparison) |
| `send_test_email` | Send a test email to verify gateway config |
| `purchase_domain` | Search for and purchase a domain via Cloudflare |

---

## How It Works

The MCP server connects to the AgenticMail REST API via HTTP. It translates MCP tool calls into API requests:

```
Claude → MCP tool call → agenticmail-mcp → HTTP request → AgenticMail API → Stalwart
```

Each tool call:
1. Receives structured arguments from Claude
2. Makes one or more HTTP requests to the AgenticMail API
3. Returns formatted text results back to Claude

The server runs as a subprocess with stdio transport — Claude sends JSON-RPC messages via stdin, and the server responds via stdout. No network ports are opened by the MCP server itself.

---

## Example Conversation

```
User: Check my email and summarize anything important

Claude: [calls list_inbox]
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

Claude: [calls reply_email]
Reply sent to john@example.com with subject "Re: Q2 Budget Review"
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
