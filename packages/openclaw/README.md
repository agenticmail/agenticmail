# @agenticmail/openclaw

[OpenClaw](https://github.com/openclaw/openclaw) plugin for [AgenticMail](https://github.com/agenticmail/agenticmail) — add full email capabilities to any OpenClaw agent.

Provides 33 tools for sending, receiving, searching, and managing email, plus a skill definition for agent system prompts.

## Install

```bash
openclaw plugin install agenticmail
```

Or manually add to `~/.openclaw/openclaw.json`:

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

## Tools

### Email Operations

- `agenticmail_send` — Send email
- `agenticmail_inbox` — List inbox
- `agenticmail_read` — Read email
- `agenticmail_search` — Search emails
- `agenticmail_delete` — Delete email
- `agenticmail_reply` — Reply to email
- `agenticmail_forward` — Forward email
- `agenticmail_move` — Move email to folder
- `agenticmail_mark_read` / `agenticmail_mark_unread` — Toggle read status

### Organization

- `agenticmail_folders` / `agenticmail_list_folder` / `agenticmail_create_folder` — Folder management
- `agenticmail_contacts` — Manage contacts
- `agenticmail_drafts` — Manage drafts
- `agenticmail_signatures` — Manage signatures
- `agenticmail_templates` — Manage templates
- `agenticmail_schedule` — Schedule emails
- `agenticmail_tags` — Manage tags

### Batch Operations

- `agenticmail_batch_delete` — Delete multiple
- `agenticmail_batch_mark_read` — Mark multiple as read
- `agenticmail_batch_mark_unread` — Mark multiple as unread
- `agenticmail_batch_move` — Move multiple

### Multi-Agent & Administration

- `agenticmail_list_agents` — List agents
- `agenticmail_message_agent` — Message another agent
- `agenticmail_check_messages` — Check for messages
- `agenticmail_create_account` — Create agent
- `agenticmail_status` — Health check

### Gateway

- `agenticmail_setup_relay` — Setup Gmail/Outlook relay
- `agenticmail_setup_domain` — Setup custom domain
- `agenticmail_purchase_domain` — Purchase domain
- `agenticmail_gateway_status` — Gateway status
- `agenticmail_test_email` — Send test email

## Skill

The plugin includes a skill at `skill/SKILL.md` that provides:

- Email management guidelines for AI agents
- Security rules (outbound guard awareness)
- Best practices for professional email communication

## Configuration

| Key | Required | Description |
|-----|----------|-------------|
| `apiUrl` | No | API URL (default: `http://127.0.0.1:3100`) |
| `apiKey` | Yes | Agent API key |
| `masterKey` | No | Master key for admin operations |

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
