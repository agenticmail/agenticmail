---
name: agenticmail
description: Full email for AI agents — send, receive, search, reply, forward, manage mailboxes, and collaborate with 54 tools
homepage: https://github.com/agenticmail/agenticmail
metadata: { "openclaw": { "emoji": "🎀", "primaryEnv": "AGENTICMAIL_API_KEY", "requires": { "bins": ["docker"], "config": ["plugins.entries.agenticmail.config.apiKey"] } } }
---

# AgenticMail

Email infrastructure for AI agents. Gives your agent a real mailbox — send, receive, search, reply, forward, and manage email with 54 tools. Includes outbound security guard, spam filtering, human-in-the-loop approval for sensitive content, inter-agent task delegation, and automatic follow-up scheduling.

## Quick Setup

```bash
agenticmail openclaw
```

That's it. The command sets up the mail server, creates an agent account, configures the plugin, and restarts the gateway.

## Tools

### Core Email (8 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_send` | Send an email with automatic PII/credential scanning and outbound security guard |
| `agenticmail_reply` | Reply to a message (outbound guard applied) |
| `agenticmail_forward` | Forward a message (outbound guard applied) |
| `agenticmail_inbox` | List recent emails in the inbox with pagination |
| `agenticmail_read` | Read a specific email by UID with security metadata (spam score, sanitization) |
| `agenticmail_search` | Search emails by from/subject/text/date/seen, optionally search relay account |
| `agenticmail_delete` | Delete an email by UID |
| `agenticmail_import_relay` | Import an email from connected Gmail/Outlook for thread continuation |

### Batch Operations (5 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_batch_read` | Read multiple emails at once by UIDs (token-efficient) |
| `agenticmail_batch_delete` | Delete multiple messages by UIDs |
| `agenticmail_batch_mark_read` | Mark multiple emails as read |
| `agenticmail_batch_mark_unread` | Mark multiple emails as unread |
| `agenticmail_batch_move` | Move multiple messages to another folder |

### Efficiency (2 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_digest` | Get a compact inbox digest with previews (efficient overview) |
| `agenticmail_template_send` | Send email using a saved template with variable substitution |

### Folders & Message Management (6 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_folders` | List all mail folders |
| `agenticmail_list_folder` | List messages in a specific folder (Sent, Drafts, Trash, etc.) |
| `agenticmail_create_folder` | Create a new mail folder |
| `agenticmail_move` | Move an email to another folder |
| `agenticmail_mark_unread` | Mark a message as unread |
| `agenticmail_mark_read` | Mark a message as read |

### Organization (7 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_contacts` | Manage contacts (list, add, delete) |
| `agenticmail_tags` | Manage tags/labels (list, create, delete, tag/untag messages) |
| `agenticmail_drafts` | Manage email drafts (list, create, update, delete, send) |
| `agenticmail_signatures` | Manage email signatures (list, create, delete) |
| `agenticmail_templates` | Manage email templates (list, create, delete) |
| `agenticmail_schedule` | Manage scheduled emails (create, list, cancel) |
| `agenticmail_rules` | Manage server-side email rules for auto-processing |

### Security & Moderation (3 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_spam` | Manage spam (list spam folder, report, mark not-spam, get spam score) |
| `agenticmail_pending_emails` | Check status of emails blocked by outbound security guard |
| `agenticmail_cleanup` | List or remove inactive non-persistent agent accounts |

### Inter-Agent Communication (3 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_message_agent` | Send a message to another AI agent by name (rate-limited) |
| `agenticmail_check_messages` | Check for new unread messages from other agents |
| `agenticmail_wait_for_email` | Wait for a new email using push notifications (SSE) |

### Agent Task Queue (5 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_assign_task` | Assign a task to another agent via task queue |
| `agenticmail_check_tasks` | Check pending tasks (incoming or outgoing) |
| `agenticmail_claim_task` | Claim a pending task assigned to you |
| `agenticmail_submit_result` | Submit result for a claimed task |
| `agenticmail_call_agent` | Synchronous RPC call to another agent with timeout |

### Account Management (6 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_whoami` | Get current agent info (name, email, role, metadata) |
| `agenticmail_update_metadata` | Update agent metadata |
| `agenticmail_list_agents` | List all AI agents with emails and roles |
| `agenticmail_create_account` | Create a new agent email account (requires master key) |
| `agenticmail_delete_agent` | Delete an agent (archives emails, generates deletion report) |
| `agenticmail_deletion_reports` | List or view past agent deletion reports |

### Gateway & Admin (9 tools)
| Tool | Description |
|------|-------------|
| `agenticmail_status` | Check AgenticMail server health |
| `agenticmail_setup_guide` | Compare setup modes (Relay/Beginner vs Domain/Advanced) with requirements, pros/cons |
| `agenticmail_setup_relay` | Configure Gmail/Outlook relay for real internet email (Beginner) |
| `agenticmail_setup_domain` | Set up a custom domain via Cloudflare with optional Gmail SMTP relay (Advanced) |
| `agenticmail_setup_gmail_alias` | Get instructions to add agent email as Gmail "Send mail as" alias (for domain mode) |
| `agenticmail_setup_payment` | Get instructions to add payment method to Cloudflare (self-service link or browser automation) |
| `agenticmail_purchase_domain` | Search domain availability (purchase must be done manually on Cloudflare or other registrar) |
| `agenticmail_gateway_status` | Check email gateway status (relay, domain, or none) |
| `agenticmail_test_email` | Send a test email to verify setup |

## Usage Examples

### Send an email
```
Send an email to user@example.com with subject "Weekly Report" and a summary of this week's work.
```

### Check and reply
```
Check my inbox for unread emails and reply to any that need a response.
```

### Inter-agent messaging
```
Send a message to the researcher agent asking for the latest findings on topic X.
```

### Search
```
Search my emails for messages from alice@example.com about the Q4 budget.
```

### Delegate a task
```
Assign the analyst agent a task to review the attached spreadsheet and summarize the key metrics.
```

### Batch operations
```
Read emails 5, 12, and 34 at once and summarize the common thread.
```

## Configuration

Set in your OpenClaw config under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "agenticmail": {
        "enabled": true,
        "config": {
          "apiUrl": "http://127.0.0.1:3100",
          "apiKey": "ak_your_agent_key",
          "masterKey": "mk_your_master_key"
        }
      }
    },
    "load": {
      "paths": ["/path/to/@agenticmail/openclaw"]
    }
  }
}
```

## Features

- **Local mail server** — Stalwart runs in Docker, no external dependencies
- **Agent-to-agent email** — Agents message each other at `name@localhost`
- **Sub-agent provisioning** — Sub-agents automatically get their own mailboxes
- **External email** — Configure relay + custom domain for real email delivery
- **Outbound security guard** — 39 rules scan for PII, credentials, API keys, and sensitive data before sending
- **Human-in-the-loop approval** — Blocked emails require owner approval via email reply or API
- **Automatic follow-up** — Exponential backoff reminders when blocked emails await approval
- **Spam filtering** — Inbound emails scored and flagged with configurable thresholds
- **Task delegation** — Inter-agent task queue with assign, claim, submit, and synchronous RPC
- **Rate limiting** — Built-in protection against agent email storms
- **Inbox awareness** — Agents are notified of unread mail at conversation start
