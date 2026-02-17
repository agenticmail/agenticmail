# @agenticmail/mcp — Technical Reference

Complete technical reference for the AgenticMail MCP server. Lists every tool, resource, input schema, and behavioral detail.

---

## Server Configuration

| Property | Value |
|----------|-------|
| Name | `AgenticMail` |
| Version | `0.2.26` |
| Description | `Email infrastructure for AI agents — by Ope Olatunji` |
| Transport | `StdioServerTransport` (stdin/stdout) |
| Capabilities | Tools, Resources |
| SDK | `@modelcontextprotocol/sdk ^1.12.0` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTICMAIL_API_URL` | `http://127.0.0.1:3100` | API server URL |
| `AGENTICMAIL_API_KEY` | `''` | Agent API key |
| `AGENTICMAIL_MASTER_KEY` | `''` | Master key (for admin tools) |

## API Request Function

```typescript
async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  useMasterKey = false,
  timeoutMs = 30_000
): Promise<any>
```

- Base URL: `${API_URL}/api/agenticmail${path}`
- Auth: `Authorization: Bearer ${useMasterKey && MASTER_KEY ? MASTER_KEY : API_KEY}`
- Content-Type: `application/json` (only when body provided)
- Timeout: `AbortSignal.timeout(timeoutMs)`
- Error: Reads response text, throws `Error: API error {status}: {text}`
- Response: Parses JSON if Content-Type includes `application/json`, returns `null` otherwise

## Master Key Tools

These tools automatically use the master key instead of the agent key:

```
create_account, setup_email_relay, setup_email_domain, setup_guide,
setup_gmail_alias, setup_payment, purchase_domain, check_gateway_status,
send_test_email, delete_agent, deletion_reports, cleanup_agents
```

---

## Tool Definitions

### send_email

Send email from agent's mailbox. External emails scanned for sensitive content.

**Input Schema:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Recipient email |
| `subject` | string | Yes | Email subject |
| `text` | string | No | Plain text body |
| `html` | string | No | HTML body |
| `cc` | string | No | CC recipients |
| `inReplyTo` | string | No | Message-ID for threading |
| `references` | string | No | Reference chain |
| `attachments` | array | No | File attachments |

**Attachment schema:** `{ filename: string, content: string (required), contentType: string, encoding: string }`

**Behavior:**
- Posts to `POST /mail/send`
- If blocked: Returns pending ID, schedules follow-up reminders
- If sent with warnings: Returns message ID + warnings
- If clean: Returns message ID

---

### list_inbox

**Input Schema:**
| Field | Type | Required | Default | Range |
|-------|------|----------|---------|-------|
| `limit` | number | No | 20 | 1–100 |
| `offset` | number | No | 0 | 0+ |

**Behavior:** `GET /mail/inbox?limit=N&offset=N`

**Response format:** `"UID: {uid} | From: {address} | Subject: {subject} | Date: {date}"` per message.

---

### read_email

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes (positive integer) |

**Behavior:** `GET /mail/messages/{uid}`

**Response format:** Multi-line with From, To, Subject, Date, Message-ID, In-Reply-To, body text, attachments list, security section (spam score, sanitization, attachment warnings, phishing alerts).

**Security section includes:**
- `[SPAM]` or `[WARNING]` with score and category
- `[SANITIZED]` with detection types
- Attachment risk levels: `[CRITICAL]` (double extensions), `[HIGH]` (executables, HTML), `[MEDIUM]` (archives)
- Phishing rule matches: `ph_mismatched_display_url`, `ph_data_uri`, `ph_homograph`, `ph_spoofed_sender`, `de_webhook_exfil`, `pi_invisible_unicode`

---

### reply_email

**Input Schema:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `uid` | number | Yes | — |
| `text` | string | Yes | — |
| `html` | string | No | — |
| `replyAll` | boolean | No | false |

**Behavior:**
1. `GET /mail/messages/{uid}` — fetch original
2. Build reply: `Re: {subject}`, `In-Reply-To: {messageId}`, `References: {chain}`
3. If `replyAll`: includes all original recipients
4. Appends quoted body: `\n\n--- Original message ---\n{original text}`
5. `POST /mail/send` with threading headers

---

### forward_email

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes |
| `to` | string | Yes |
| `text` | string | No |

**Behavior:**
1. Fetch original message
2. Build forward: `Fwd: {subject}`
3. Body: `{optional text}\n\n--- Forwarded message ---\n{original text}`
4. Preserves original attachments as base64
5. `POST /mail/send`

---

### search_emails

**Input Schema:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | No | Sender filter |
| `to` | string | No | Recipient filter |
| `subject` | string | No | Subject filter |
| `text` | string | No | Body text search |
| `since` | string | No | ISO 8601 date (after) |
| `before` | string | No | ISO 8601 date (before) |
| `seen` | boolean | No | Read status filter |
| `searchRelay` | boolean | No | Also search relay account (default: false) |

**Behavior:** `POST /mail/search`

**Response:** Local UIDs + relay results (if enabled) with `uid, source, account, messageId, subject, from, to, date, flags`.

---

### import_relay_email

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes |

**Behavior:** `POST /mail/import-relay` — imports email from connected relay into local inbox.

---

### delete_email

**Input Schema:** `{ uid: number (required, positive integer) }`

**Behavior:** `DELETE /mail/messages/{uid}`

---

### move_email

**Input Schema:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `uid` | number | Yes | — |
| `to` | string | Yes | — |
| `from` | string | No | "INBOX" |

**Behavior:** `POST /mail/messages/{uid}/move`

---

### mark_read

**Input Schema:** `{ uid: number (required) }`

**Behavior:** `POST /mail/messages/{uid}/seen`

---

### mark_unread

**Input Schema:** `{ uid: number (required) }`

**Behavior:** `POST /mail/messages/{uid}/unseen`

---

### inbox_digest

**Input Schema:**
| Field | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | number | 20 | 1–50 |
| `offset` | number | 0 | 0+ |
| `folder` | string | "INBOX" | — |
| `previewLength` | number | 200 | 50–500 |

**Behavior:** `GET /mail/digest?limit=N&offset=N&folder=F&previewLength=N`

**Response format:** Compact digest with `[*]` for unread, `[r]` for read, sender, subject, date, and text preview.

---

### wait_for_email

**Input Schema:**
| Field | Type | Default | Range |
|-------|------|---------|-------|
| `timeout` | number | 120 | 1–300 seconds |

**Behavior:**
1. Opens SSE connection to `GET /events`
2. Listens for `new` (email) or `task` events
3. Falls back to polling if SSE unavailable
4. Uses `AbortController` for timeout

**Response:**
```json
{
  "arrived": true,
  "mode": "push",
  "eventType": "email",
  "timedOut": false,
  "uid": 123,
  "subject": "...",
  "from": "..."
}
```

---

### list_folders

**Behavior:** `GET /mail/folders`

**Response:** Folder paths, one per line.

---

### list_folder

**Input Schema:**
| Field | Type | Required | Default | Range |
|-------|------|----------|---------|-------|
| `folder` | string | Yes | — | — |
| `limit` | number | No | 20 | 1–100 |
| `offset` | number | No | 0 | 0+ |

**Behavior:** `GET /mail/folders/{folder}?limit=N&offset=N`

---

### Batch Operations

All batch tools validate: `Array.isArray(uids) && uids.length > 0`

**batch_delete:** `{ uids: number[], folder?: string }` → `POST /mail/batch/delete`

**batch_mark_read:** `{ uids: number[], folder?: string }` → `POST /mail/batch/seen`

**batch_mark_unread:** `{ uids: number[], folder?: string }` → `POST /mail/batch/unseen`

**batch_move:** `{ uids: number[], to: string, from?: string }` → `POST /mail/batch/move`

**batch_read:** `{ uids: number[], folder?: string }` → `POST /mail/batch/read`
Returns 500-char preview per message.

---

### manage_contacts

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "add" \| "delete" | Yes |
| `email` | string | For "add" |
| `name` | string | No (for "add") |
| `id` | string | For "delete" |

**API calls:** `GET /contacts`, `POST /contacts`, `DELETE /contacts/{id}`

---

### manage_drafts

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "create" \| "update" \| "send" \| "delete" | Yes |
| `to` | string | For "create" |
| `subject` | string | For "create" |
| `text` | string | For "create"/"update" |
| `html` | string | No |
| `id` | string | For "update"/"send"/"delete" |

**API calls:** `GET /drafts`, `POST /drafts`, `PUT /drafts/{id}`, `POST /drafts/{id}/send`, `DELETE /drafts/{id}`

---

### manage_signatures

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "create" \| "delete" | Yes |
| `name` | string | For "create" |
| `text` | string | For "create" |
| `isDefault` | boolean | No |
| `id` | string | For "delete" |

**API calls:** `GET /signatures`, `POST /signatures`, `DELETE /signatures/{id}`

---

### manage_templates

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "create" \| "delete" | Yes |
| `name` | string | For "create" |
| `subject` | string | For "create" |
| `text` | string | For "create" |
| `id` | string | For "delete" |

**API calls:** `GET /templates`, `POST /templates`, `DELETE /templates/{id}`

---

### template_send

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `id` | string | Yes |
| `to` | string | Yes |
| `variables` | object | No |
| `cc` | string | No |
| `bcc` | string | No |

**Behavior:** `POST /templates/{id}/send`

Replaces `{{ variableName }}` patterns in subject and body.

---

### manage_scheduled

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "create" \| "list" \| "cancel" | Yes |
| `to` | string | For "create" |
| `subject` | string | For "create" |
| `text` | string | For "create" |
| `sendAt` | string | For "create" |
| `html` | string | No |
| `cc` | string | No |
| `bcc` | string | No |
| `id` | string | For "cancel" |

**Supported `sendAt` formats:** ISO 8601, relative (`in 30 minutes`), named (`tomorrow 8am`), day-based (`next monday 9am`), human (`02-14-2026 3:30 PM EST`), casual (`tonight`).

---

### manage_tags

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "create" \| "delete" \| "tag_message" \| "untag_message" \| "get_messages" \| "get_message_tags" | Yes |
| `name` | string | For "create" |
| `color` | string | No (hex, for "create") |
| `id` | string | For "delete"/"tag_message"/"untag_message"/"get_messages" |
| `uid` | number | For "tag_message"/"untag_message"/"get_message_tags" |
| `folder` | string | No (for message operations) |

**API calls:** `GET /tags`, `POST /tags`, `DELETE /tags/{id}`, `POST /tags/{id}/messages`, `DELETE /tags/{id}/messages/{uid}`, `GET /tags/{id}/messages`, `GET /messages/{uid}/tags`

---

### manage_rules

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "create" \| "delete" | Yes |
| `name` | string | For "create" |
| `priority` | number | No (for "create") |
| `conditions` | object | For "create" |
| `actions` | object | For "create" |
| `id` | string | For "delete" |

**Conditions:** `from_contains`, `subject_contains`, `subject_regex`, `to_contains`, `has_attachment`

**Actions:** `move_to`, `mark_read`, `delete`, `add_tags`

---

### manage_spam

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "report" \| "not_spam" \| "score" | Yes |
| `uid` | number | For "report"/"not_spam"/"score" |
| `folder` | string | No (for "report"/"score") |
| `limit` | number | No (for "list") |
| `offset` | number | No (for "list") |

**API calls:** `GET /mail/spam`, `POST /mail/messages/{uid}/spam`, `POST /mail/messages/{uid}/not-spam`, `GET /mail/messages/{uid}/spam-score`

---

### manage_pending_emails

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list" \| "view" \| "approve" \| "reject" | Yes |
| `id` | string | For "view"/"approve"/"reject" |

**Critical:** `approve` and `reject` actions are **explicitly blocked** — returns error message directing agent to notify the owner.

**API calls:** `GET /mail/pending`, `GET /mail/pending/{id}`

---

### create_folder

**Input Schema:** `{ name: string (required) }`

**Behavior:** `POST /mail/folders`

---

### check_health

**Behavior:** `GET /health`

**Response:** Status message with API and Stalwart status.

---

### create_account

**Master key required.**

**Input Schema:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent name |
| `domain` | string | No | Default: localhost |
| `role` | enum | No | secretary, assistant, researcher, writer, custom |

**Behavior:** `POST /accounts`

---

### delete_agent

**Master key required.**

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `name` | string | Yes |
| `reason` | string | No |

**Behavior:** Looks up agent by name, calls `DELETE /accounts/{id}?archive=true&reason={}&deletedBy=agent`

---

### deletion_reports

**Master key required.**

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `id` | string | No (specific report) |

**Behavior:** `GET /accounts/deletions` or `GET /accounts/deletions/{id}`

---

### cleanup_agents

**Master key required.**

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `action` | "list_inactive" \| "cleanup" \| "set_persistent" | Yes |
| `hours` | number | No (for list/cleanup) |
| `dryRun` | boolean | No (for cleanup) |
| `agentId` | string | For "set_persistent" |
| `persistent` | boolean | For "set_persistent" |

---

### whoami

**Behavior:** `GET /accounts/me`

**Response:** Name, email, role, ID, created date, metadata.

---

### update_metadata

**Input Schema:** `{ metadata: object (required) }`

**Behavior:** `PATCH /accounts/me`

---

### list_agents

**Behavior:** `GET /accounts/directory`

---

### message_agent

**Input Schema:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Target agent name |
| `subject` | string | Yes | Email subject |
| `text` | string | Yes | Message body |
| `priority` | enum | No | normal, high, urgent |

**Behavior:**
1. `GET /accounts/directory/{agent}` — validate target exists
2. If priority=high: prefix `[HIGH] `
3. If priority=urgent: prefix `[URGENT] `
4. `POST /mail/send` to `{agent}@localhost`

---

### check_messages

**Behavior:** `GET /mail/inbox?limit=10`

**Response:** Summary of unread messages, tagged as `[agent]` or `[external]`.

---

### check_tasks

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `direction` | "incoming" \| "outgoing" | Yes |
| `assignee` | string | No (for incoming only) |

**Behavior:** `GET /tasks/pending?assignee={name}` or `GET /tasks/assigned`

---

### claim_task

**Input Schema:** `{ id: string (required) }`

**Behavior:** `POST /tasks/{id}/claim`

---

### submit_result

**Input Schema:**
| Field | Type | Required |
|-------|------|----------|
| `id` | string | Yes |
| `result` | object | No |

**Behavior:** `POST /tasks/{id}/result`

---

### call_agent

**Input Schema:**
| Field | Type | Required | Default | Range |
|-------|------|----------|---------|-------|
| `target` | string | Yes | — | — |
| `task` | string | Yes | — | — |
| `payload` | object | No | — | — |
| `timeout` | number | No | 180 | 5–300 seconds |

**Behavior:** `POST /tasks/rpc` — holds connection open, returns result or timeout.

---

### Gateway Tools

**setup_email_relay** (master):
```
{ provider: "gmail"|"outlook"|"custom", email: string, password: string,
  smtpHost?: string, smtpPort?: number, imapHost?: string, imapPort?: number,
  agentName?: string, agentRole?: string, skipDefaultAgent?: boolean }
```

**setup_email_domain** (master):
```
{ cloudflareToken: string, cloudflareAccountId: string,
  domain?: string, purchase?: { keywords: string[], tld?: string },
  gmailRelay?: { email: string, appPassword: string } }
```

**setup_gmail_alias** (master):
```
{ agentEmail: string, agentDisplayName?: string }
```

**setup_guide** (master): No input.

**setup_payment** (master): No input.

**purchase_domain** (master):
```
{ keywords: string[], tld?: string }
```

**check_gateway_status** (master): No input.

**send_test_email** (master):
```
{ to: string }
```

---

## Outbound Guard Rules

### PII Detection (18 rules)

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| `ob_ssn` | HIGH | `\b\d{3}-\d{2}-\d{4}\b` |
| `ob_ssn_obfuscated` | HIGH | Obfuscated SSN variants |
| `ob_credit_card` | HIGH | `\b(?:\d{4}[-\s]?){3}\d{4}\b` |
| `ob_phone` | MEDIUM | Phone number patterns |
| `ob_bank_routing` | HIGH | Routing/account numbers |
| `ob_drivers_license` | HIGH | Driver's license patterns |
| `ob_dob` | MEDIUM | Date of birth with keywords |
| `ob_passport` | HIGH | Passport numbers |
| `ob_tax_id` | HIGH | EIN/TIN patterns |
| `ob_itin` | HIGH | ITIN patterns |
| `ob_medicare` | HIGH | Medicare/Medicaid IDs |
| `ob_immigration` | HIGH | Immigration A-numbers |
| `ob_pin` | MEDIUM | PIN codes |
| `ob_security_qa` | MEDIUM | Security Q&A patterns |
| `ob_iban` | HIGH | IBAN patterns |
| `ob_swift` | MEDIUM | SWIFT/BIC codes |
| `ob_crypto_wallet` | HIGH | BTC/ETH/XMR wallet addresses |
| `ob_wire_transfer` | HIGH | Wire transfer instructions |

### Credential Detection (19 rules)

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| `ob_api_key` | HIGH | API key patterns |
| `ob_aws_key` | HIGH | `AKIA[A-Z0-9]{16}` |
| `ob_password_value` | HIGH | Password field patterns |
| `ob_private_key` | HIGH | PEM private key headers |
| `ob_bearer_token` | HIGH | Bearer token patterns |
| `ob_connection_string` | HIGH | DB connection strings |
| `ob_github_token` | HIGH | GitHub token patterns |
| `ob_stripe_key` | HIGH | Stripe key patterns |
| `ob_jwt` | HIGH | JWT token patterns |
| `ob_webhook_url` | HIGH | Slack/Discord webhook URLs |
| `ob_env_block` | HIGH | Consecutive ENV variable lines |
| `ob_seed_phrase` | HIGH | Crypto seed/recovery phrases |
| `ob_2fa_codes` | HIGH | 2FA backup codes |
| `ob_credential_pair` | HIGH | Username+password pairs |
| `ob_oauth_token` | HIGH | OAuth tokens |
| `ob_vpn_creds` | HIGH | VPN credentials |

### System Internals (3 rules)

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| `ob_private_ip` | MEDIUM | Private IP ranges (10.x, 172.16-31.x, 192.168.x) |
| `ob_file_path` | MEDIUM | File paths (/home, /Users, /etc, C:\\) |
| `ob_env_variable` | MEDIUM | Environment variable assignments |

### Owner Privacy (2 rules)

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| `ob_owner_info` | HIGH | Mentions of owner's personal info |
| `ob_personal_reveal` | HIGH | Reveals about agent's creator/operator |

### Attachment Risk

| Risk Level | Extensions |
|------------|------------|
| HIGH (keys) | `.pem`, `.key`, `.p12`, `.pfx`, `.env`, `.credentials`, `.keystore`, `.jks`, `.p8` |
| MEDIUM (data) | `.db`, `.sqlite`, `.sqlite3`, `.sql`, `.csv`, `.tsv`, `.json`, `.yml`, `.yaml`, `.conf`, `.config`, `.ini` |
| HIGH (exec) | `.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.msi`, `.scr`, `.com`, `.vbs`, `.js`, `.wsf`, `.hta`, `.cpl`, `.jar`, `.app`, `.dmg`, `.run` |
| MEDIUM (archive) | `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.bz2`, `.xz`, `.cab`, `.iso` |
| CRITICAL | Double extensions (e.g., `.pdf.exe`) |

---

## Pending Email Follow-Up System

### Schedule

| Step | Delay | Description |
|------|-------|-------------|
| 0 | 12 hours | First reminder |
| 1 | 6 hours | Second reminder |
| 2 | 3 hours | Third reminder |
| 3 | 1 hour | Final reminder before cooldown |
| — | 3 days | Cooldown period |
| 4+ | Repeat cycle | Re-starts from 12 hours |

### Heartbeat

Every 5 minutes, checks all tracked pending emails. If externally resolved, cancels reminders.

### API

| Function | Description |
|----------|-------------|
| `scheduleFollowUp(pendingId, recipient, subject, checkFn)` | Start follow-ups |
| `drainFollowUps()` | Get and clear queued notifications |
| `cancelFollowUp(pendingId)` | Cancel specific email follow-ups |
| `cancelAllFollowUps()` | Cancel all follow-ups |
| `activeFollowUpCount()` | Count tracked emails |

### Message Templates

**Interim (steps 0–2):**
```
[FOLLOW-UP REMINDER {step+1}/{4}]
Your blocked email to {recipient} (subject: "{subject}") is still pending owner approval.
Please follow up with your owner — ask if they've reviewed the notification email.
Next reminder in {nextDelayH} hour(s).
Pending ID: {pendingId}
```

**Final (step 3):**
```
[FINAL FOLLOW-UP]
Your blocked email to {recipient} (subject: "{subject}") is STILL pending approval.
This is the last reminder before a 3-day cooldown. Please urgently remind your owner.
Pending ID: {pendingId}
```

**Cycle restart (after cooldown):**
```
[FOLLOW-UP REMINDER — cycle {cycle+2}]
Your blocked email to {recipient} has been pending for over {totalDays} days.
Starting a new follow-up cycle. Please remind your owner.
Pending ID: {pendingId}
```

---

## Resources

| URI | Name | MIME Type | Description |
|-----|------|-----------|-------------|
| `agenticmail://inbox` | Agent Inbox | `text/plain` | 20 most recent inbox messages |

**Format:** `{index}. UID: {uid} | From: {address} | Subject: {subject} | Date: {date}`

---

## Constants Summary

| Constant | Value |
|----------|-------|
| Default API URL | `http://127.0.0.1:3100` |
| API request timeout | 30,000ms |
| list_inbox max limit | 100 |
| list_folder max limit | 100 |
| inbox_digest max limit | 50 |
| inbox_digest max preview | 500 chars |
| wait_for_email max timeout | 300 seconds |
| wait_for_email default timeout | 120 seconds |
| call_agent max timeout | 300 seconds |
| call_agent default timeout | 180 seconds |
| batch_read preview length | 500 chars |
| Follow-up step delays | [12h, 6h, 3h, 1h] |
| Follow-up cooldown | 3 days (259,200,000ms) |
| Follow-up heartbeat | 5 minutes |

---

## Signal Handlers

| Signal | Action |
|--------|--------|
| `SIGTERM` | Close server, exit 0 |
| `SIGINT` | Close server, exit 0 |

Shutdown errors are silently ignored.

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
