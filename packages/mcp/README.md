# @agenticmail/mcp

MCP (Model Context Protocol) server for [AgenticMail](https://github.com/agenticmail/agenticmail) — use email from Claude Code, Claude Desktop, and any MCP-compatible client.

Provides 49 tools for sending, receiving, searching, and managing email through natural language.

## Install

```bash
npm install -g @agenticmail/mcp
```

## Setup

### Claude Code

Add to your Claude Code MCP config:

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

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Tools

### Email

| Tool | Description |
|------|-------------|
| `send_email` | Send an email |
| `list_inbox` | List recent inbox messages |
| `read_email` | Read full email content |
| `reply_email` | Reply to an email |
| `forward_email` | Forward an email |
| `search_emails` | Search by query |
| `delete_email` | Delete an email |
| `move_email` | Move to folder |
| `mark_read` / `mark_unread` | Toggle read status |
| `inbox_digest` | Inbox summary with previews |
| `wait_for_email` | Wait for email matching criteria |

### Batch Operations

| Tool | Description |
|------|-------------|
| `batch_delete` | Delete multiple emails |
| `batch_mark_read` | Mark multiple as read |
| `batch_mark_unread` | Mark multiple as unread |
| `batch_move` | Move multiple emails |
| `batch_read` | Read multiple emails at once |

### Organization

| Tool | Description |
|------|-------------|
| `manage_contacts` | Add, remove, list contacts |
| `manage_drafts` | Create, list, delete drafts |
| `manage_tags` | Create, assign, remove tags |
| `manage_rules` | Email filtering rules |
| `manage_signatures` | Email signatures |
| `manage_templates` | Email templates |
| `manage_scheduled` | Scheduled email sending |
| `manage_spam` | Spam folder management |
| `manage_pending_emails` | View blocked outbound emails |

### Multi-Agent

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents |
| `message_agent` | Send message to another agent |
| `check_messages` | Check for new messages |
| `assign_task` | Assign task to agent |
| `claim_task` | Claim a pending task |
| `submit_result` | Submit task result |
| `check_tasks` | Check pending tasks |
| `call_agent` | Synchronous agent-to-agent RPC |

### Administration

| Tool | Description |
|------|-------------|
| `create_account` | Create new agent |
| `delete_agent` | Delete agent with archival |
| `cleanup_agents` | Clean up inactive agents |
| `update_metadata` | Update agent metadata |
| `whoami` | Get current agent info |
| `check_health` | Server health check |
| `check_gateway_status` | Email gateway status |
| `setup_email_relay` | Setup Gmail/Outlook relay |
| `setup_email_domain` | Setup custom domain |
| `send_test_email` | Send test email |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTICMAIL_API_URL` | Yes | API server URL (e.g., `http://127.0.0.1:3100`) |
| `AGENTICMAIL_API_KEY` | Yes | Agent API key (`ak_...`) |
| `AGENTICMAIL_MASTER_KEY` | No | Master key for admin operations |

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
