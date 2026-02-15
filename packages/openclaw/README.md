# @agenticmail/openclaw

[OpenClaw](https://github.com/openclaw/openclaw) plugin for [AgenticMail](https://github.com/agenticmail/agenticmail) — add full email capabilities to any OpenClaw agent.

Provides 33 tools for email operations, organization, multi-agent communication, and gateway management. Includes a skill definition with system prompt guidelines for professional email handling and security awareness.

## Install

### Via OpenClaw CLI

```bash
openclaw plugin install agenticmail
```

### Manual Installation

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "agenticmail": {
      "enabled": true,
      "config": {
        "apiUrl": "http://127.0.0.1:3100",
        "apiKey": "ak_your_agent_key",
        "masterKey": "mk_your_master_key"
      }
    }
  }
}
```

**Requirements:** Node.js 20+, AgenticMail API server running, Docker (for Stalwart)

---

## Configuration

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `apiUrl` | No | `http://127.0.0.1:3100` | AgenticMail API URL |
| `apiKey` | Yes | — | Agent API key (`ak_...`). Determines which agent this plugin acts as. |
| `masterKey` | No | — | Master key (`mk_...`). Required for admin operations (create agents, approve emails, gateway config). |

### Plugin survives OpenClaw updates

Plugin configuration lives in `~/.openclaw/openclaw.json` (user config), not in OpenClaw's source directory. Updating OpenClaw does not affect your AgenticMail plugin setup.

---

## Tools

### Email Operations (10 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_send` | Send email with to, subject, text/HTML body, attachments |
| `agenticmail_inbox` | List inbox messages with metadata |
| `agenticmail_read` | Read full email content by UID |
| `agenticmail_search` | Search emails by from, subject, body, date |
| `agenticmail_delete` | Delete email by UID |
| `agenticmail_reply` | Reply to email (preserves In-Reply-To threading) |
| `agenticmail_forward` | Forward email to another address |
| `agenticmail_move` | Move email to a folder |
| `agenticmail_mark_read` | Mark email as read |
| `agenticmail_mark_unread` | Mark email as unread |

### Organization (6 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_folders` | List all IMAP folders |
| `agenticmail_list_folder` | List messages in a specific folder |
| `agenticmail_create_folder` | Create a new folder |
| `agenticmail_contacts` | Manage address book (add, remove, list) |
| `agenticmail_drafts` | Manage drafts (create, edit, delete, send) |
| `agenticmail_signatures` | Manage email signatures |
| `agenticmail_templates` | Manage reusable email templates |
| `agenticmail_schedule` | Schedule emails for future delivery |
| `agenticmail_tags` | Tag and categorize messages |

### Batch Operations (4 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_batch_delete` | Delete multiple emails at once |
| `agenticmail_batch_mark_read` | Mark multiple as read |
| `agenticmail_batch_mark_unread` | Mark multiple as unread |
| `agenticmail_batch_move` | Move multiple emails to a folder |

### Multi-Agent (3 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_list_agents` | List all agents with name, email, role |
| `agenticmail_message_agent` | Send message to another agent |
| `agenticmail_check_messages` | Check for new messages from agents |

### Administration (2 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_create_account` | Create a new agent (requires master key) |
| `agenticmail_status` | Check server health and agent status |

### Gateway (5 tools)

| Tool | Description |
|------|-------------|
| `agenticmail_setup_relay` | Configure Gmail/Outlook relay mode |
| `agenticmail_setup_domain` | Configure custom domain with Cloudflare |
| `agenticmail_purchase_domain` | Search and purchase domain via Cloudflare Registrar |
| `agenticmail_gateway_status` | Check gateway mode and health |
| `agenticmail_test_email` | Send test email to verify configuration |

---

## Skill Definition

The plugin includes a skill at `skill/SKILL.md` that gets injected into the agent's system prompt. It provides guidelines for:

- **Email etiquette** — professional communication, appropriate tone
- **Security awareness** — understanding the outbound guard, not attempting to bypass blocks
- **Approval workflow** — informing the owner when emails are blocked instead of self-approving
- **Multi-agent protocol** — how to communicate with and assign tasks to other agents

### Skill Files

```
skill/
├── SKILL.md                        # Main skill instructions for the agent
├── references/
│   ├── api-reference.md            # API endpoint quick reference
│   └── configuration.md            # Configuration guide
└── scripts/
    ├── health-check.sh             # Server health check script
    └── setup.sh                    # Initial setup helper script
```

---

## How It Works

The plugin registers tools with OpenClaw's plugin system. When an agent invokes a tool:

```
OpenClaw Agent → tool call → @agenticmail/openclaw → HTTP request → AgenticMail API → Stalwart
```

Each tool:
1. Receives structured arguments from the OpenClaw agent
2. Constructs an HTTP request to the AgenticMail API with proper authentication
3. Returns formatted results that the agent can understand and act on

The plugin uses the agent's API key for most operations and the master key (if provided) for admin operations like creating agents or approving blocked emails.

### Sub-Agent Support

OpenClaw agents can spawn sub-agents that inherit the parent's AgenticMail configuration. The plugin handles:
- Sub-agent registration and tracking
- Last-activated agent tracking for zero-cooperation fallback
- Context resolution hierarchy: direct API key → raw key → agent name lookup

---

## Plugin Manifest

The `openclaw.plugin.json` file registers the plugin with OpenClaw:

```json
{
  "id": "agenticmail",
  "name": "agenticmail",
  "version": "0.2.0",
  "displayName": "AgenticMail",
  "description": "Full email channel + tools for AI agents",
  "channels": ["mail"],
  "configSchema": {
    "apiUrl": "AgenticMail API URL",
    "apiKey": "Agent API key (required)",
    "masterKey": "Master API key (optional)"
  }
}
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
