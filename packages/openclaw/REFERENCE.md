# @agenticmail/openclaw — Technical Reference

Complete technical reference for the AgenticMail OpenClaw plugin. Covers every tool, the channel integration, sub-agent lifecycle, rate limiting, follow-up system, and all constants.

---

## Exports

```typescript
export default function activate(api: any): void
```

Single default export. Called by OpenClaw when the plugin loads.

---

## Plugin Manifest

**File:** `openclaw.plugin.json`

```json
{
  "id": "agenticmail",
  "displayName": "AgenticMail",
  "version": "0.2.0",
  "description": "Full email channel + tools for AI agents",
  "channels": ["mail"],
  "configSchema": {
    "apiUrl": { "type": "string", "default": "http://127.0.0.1:3100" },
    "apiKey": { "type": "string", "required": true },
    "masterKey": { "type": "string" }
  },
  "requires": { "bins": ["docker"] }
}
```

---

## Configuration

### ToolContext

```typescript
interface ToolContext {
  config: {
    apiUrl: string;       // Default: 'http://127.0.0.1:3100'
    apiKey: string;       // Agent API key (required)
    masterKey?: string;   // Master admin key (optional)
  };
  ownerName?: string;     // Resolved from OpenClaw agent config
}
```

### Config Resolution

1. `api?.getConfig?.()` or `{}`
2. `api?.pluginConfig` or step 1 result
3. Manifest defaults

### Owner Name Resolution

Extracted from OpenClaw agent config: `api?.config?.agents?.list` → `defaultAgent?.identity?.name` or first agent's name.

---

## API Request Function

```typescript
async function apiRequest(
  ctx: ToolContext,
  method: string,
  path: string,
  body?: unknown,
  useMasterKey = false,
  timeoutMs = 30_000
): Promise<any>
```

- Base URL: `${ctx.config.apiUrl}/api/agenticmail${path}`
- Auth: `Authorization: Bearer ${useMasterKey ? ctx.config.masterKey : ctx.config.apiKey}`
- Throws if required key not configured
- Timeout: `AbortSignal.timeout(timeoutMs)` — 30 seconds default
- Error: `AgenticMail API error {status}: {text}`
- Response: JSON if Content-Type includes `application/json`, else `null`

---

## Sub-Agent Identity System

### SubagentAccount

```typescript
interface SubagentAccount {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  parentEmail: string;    // Coordinator's email (for auto-CC)
  createdAt: number;      // ms since epoch
}
```

### AgentIdentity Registry

```typescript
interface AgentIdentity {
  apiKey: string;
  parentEmail: string;
}

registerAgentIdentity(name: string, apiKey: string, parentEmail: string): void
unregisterAgentIdentity(name: string): void
setLastActivatedAgent(name: string): void
clearLastActivatedAgent(name: string): void
```

### Context Resolution (4-path hierarchy)

1. **Direct injection:** `params._agentApiKey` (from tool factory)
2. **Raw key:** `params._auth` (from prepend context)
3. **Agent name:** `params._account` → lookup in identity registry → fallback to API lookup via master key
4. **Auto-detect:** `lastActivatedAgent` (zero-cooperation fallback)

### Auto-CC

When a sub-agent sends an inter-agent email (`@localhost`), the parent coordinator is automatically added to CC. External emails skip auto-CC. Deduplication prevents adding the parent if already in To or CC.

---

## Inter-Agent Rate Limiting

### Configuration

| Parameter | Value |
|-----------|-------|
| `WARN_THRESHOLD` | 3 unanswered messages |
| `BLOCK_THRESHOLD` | 5 unanswered messages |
| `WINDOW_MAX` | 10 messages per window |
| `WINDOW_MS` | 300,000ms (5 minutes) |
| `COOLDOWN_MS` | 120,000ms (2 minutes) |
| `TRACKER_GC_INTERVAL_MS` | 600,000ms (10 minutes) |
| `TRACKER_STALE_MS` | 1,800,000ms (30 minutes) |

### MessageRecord

```typescript
interface MessageRecord {
  unanswered: number;       // Consecutive unanswered count
  sentTimestamps: number[]; // Timestamps within window
  lastSentAt: number;
  lastReplyAt: number;
}
```

### Functions

| Function | Description |
|----------|-------------|
| `checkRateLimit(from, to)` | Returns `{allowed, warning?}` |
| `recordSentMessage(from, to)` | Increments unanswered, adds timestamp |
| `recordInboundAgentMessage(from, to)` | Resets unanswered count |

---

## Outbound Security Guard

### Scan Function

```typescript
function scanOutbound(
  to: string | string[],
  subject?: string,
  text?: string,
  html?: string,
  attachments?: Array<{ filename?: string }>
): OutboundScanResultInline
```

Returns: `{ warnings: McpOutboundWarning[], blocked: boolean, summary: string }`

Skips scanning if all recipients are `@localhost`.

### Detection Rules (38+)

**PII (13 rules):**

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `ob_ssn` | HIGH | SSN pattern `\d{3}-\d{2}-\d{4}` |
| `ob_ssn_obfuscated` | HIGH | Obfuscated SSN variants |
| `ob_credit_card` | HIGH | Credit card numbers |
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

**Financial (5 rules):**

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `ob_security_qa` | MEDIUM | Security Q&A patterns |
| `ob_iban` | HIGH | IBAN patterns |
| `ob_swift` | MEDIUM | SWIFT/BIC codes |
| `ob_crypto_wallet` | HIGH | BTC/ETH/XMR wallet addresses |
| `ob_wire_transfer` | HIGH | Wire transfer instructions |

**Credentials (16 rules):**

| Rule ID | Severity | Description |
|---------|----------|-------------|
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

**System Internals (3 rules):**

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `ob_private_ip` | MEDIUM | Private IP ranges |
| `ob_file_path` | MEDIUM | File paths (/home, /Users, C:\\) |
| `ob_env_variable` | MEDIUM | Environment variable assignments |

**Owner Privacy (2 rules):**

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `ob_owner_info` | HIGH | Owner's personal info |
| `ob_personal_reveal` | HIGH | Agent's creator/operator |

**Attachment Risk:**

| Risk Level | Extensions |
|------------|------------|
| HIGH (keys) | `.pem`, `.key`, `.p12`, `.pfx`, `.env`, `.credentials`, `.keystore`, `.jks`, `.p8` |
| MEDIUM (data) | `.db`, `.sqlite`, `.sqlite3`, `.sql`, `.csv`, `.tsv`, `.json`, `.yml`, `.yaml`, `.conf`, `.config`, `.ini` |
| HIGH (exec) | `.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.msi`, `.scr`, `.com`, `.vbs`, `.js`, `.wsf`, `.hta`, `.cpl`, `.jar`, `.app`, `.dmg`, `.run` |
| MEDIUM (archive) | `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.bz2`, `.xz`, `.cab`, `.iso` |
| CRITICAL | Double extensions (e.g., `.pdf.exe`) |

---

## Tool Definitions (54 tools)

### Tool Registration

Tools are registered as factories — OpenClaw calls the factory per-session with `{sessionKey, ...}`. The sub-agent API key is injected at execution time through the 4-path context resolution hierarchy.

### Response Format

```typescript
{
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  details: result
}
```

### agenticmail_send

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Recipient |
| `subject` | string | Yes | Subject line |
| `text` | string | No | Plain text body |
| `html` | string | No | HTML body |
| `cc` | string | No | CC recipients |
| `inReplyTo` | string | No | Message-ID for threading |
| `references` | array | No | Message-ID chain |
| `attachments` | array | No | `{filename, content, contentType, encoding}` |

Auto-CC: Parent coordinator added to CC for inter-agent emails.
Outbound guard: Runs inline scan. If blocked, schedules follow-up reminders.

### agenticmail_inbox

| Field | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | number | 20 | 1–100 |
| `offset` | number | 0 | 0+ |

### agenticmail_read

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `uid` | number | Yes | — |
| `folder` | string | No | INBOX |

Response includes `_securityWarnings` and `_securityAdvisory` for external emails.

### agenticmail_search

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Sender filter |
| `to` | string | Recipient filter |
| `subject` | string | Subject filter |
| `text` | string | Body text search |
| `since` | string | ISO 8601 (after) |
| `before` | string | ISO 8601 (before) |
| `seen` | boolean | Read status |
| `searchRelay` | boolean | Also search Gmail/Outlook |

### agenticmail_import_relay

| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes |

### agenticmail_delete

| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes |

### agenticmail_reply

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `uid` | number | Yes | — |
| `text` | string | Yes | — |
| `replyAll` | boolean | No | false |

Auto-quotes original, preserves In-Reply-To and References. Resets rate limiter on reply.

### agenticmail_forward

| Field | Type | Required |
|-------|------|----------|
| `uid` | number | Yes |
| `to` | string | Yes |
| `text` | string | No |

Preserves original attachments.

### Batch Operations

All require `uids: number[]` (non-empty array).

| Tool | Extra Fields | API Endpoint |
|------|-------------|-------------|
| `agenticmail_batch_read` | `folder?` | `POST /mail/batch/read` |
| `agenticmail_batch_delete` | `folder?` | `POST /mail/batch/delete` |
| `agenticmail_batch_mark_read` | `folder?` | `POST /mail/batch/seen` |
| `agenticmail_batch_mark_unread` | `folder?` | `POST /mail/batch/unseen` |
| `agenticmail_batch_move` | `from?`, `to` (required) | `POST /mail/batch/move` |

### agenticmail_digest

| Field | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | number | 20 | 1–50 |
| `offset` | number | 0 | 0+ |
| `folder` | string | INBOX | — |
| `previewLength` | number | 200 | 1–500 |

### agenticmail_template_send

| Field | Type | Required |
|-------|------|----------|
| `id` | string | Yes |
| `to` | string | Yes |
| `variables` | object | No |
| `cc` | string | No |
| `bcc` | string | No |

### Folder Management

| Tool | Fields | API |
|------|--------|-----|
| `agenticmail_folders` | (none) | `GET /mail/folders` |
| `agenticmail_list_folder` | `folder`, `limit?`, `offset?` | `GET /mail/folders/{folder}` |
| `agenticmail_create_folder` | `name` | `POST /mail/folders` |
| `agenticmail_move` | `uid`, `to`, `from?` | `POST /mail/messages/{uid}/move` |
| `agenticmail_mark_read` | `uid` | `POST /mail/messages/{uid}/seen` |
| `agenticmail_mark_unread` | `uid` | `POST /mail/messages/{uid}/unseen` |

### Organization Tools

All action-based tools use `{ action: string, ... }` pattern.

**agenticmail_contacts:** Actions: `list`, `add` (email required, name optional), `delete` (id)

**agenticmail_tags:** Actions: `list`, `create` (name, color?), `delete` (id), `tag_message` (id, uid, folder?), `untag_message` (id, uid, folder?), `get_messages` (id), `get_message_tags` (uid)

**agenticmail_drafts:** Actions: `list`, `create` (to, subject, text), `update` (id, fields), `delete` (id), `send` (id)

**agenticmail_signatures:** Actions: `list`, `create` (name, text, isDefault?), `delete` (id)

**agenticmail_templates:** Actions: `list`, `create` (name, subject, text), `delete` (id)

**agenticmail_schedule:** Actions: `create` (to, subject, text, sendAt), `list`, `cancel` (id)

**agenticmail_rules:** Actions: `list`, `create` (name, conditions, actions, priority?), `delete` (id)
- Conditions: `from_contains`, `from_exact`, `subject_contains`, `subject_regex`, `to_contains`, `has_attachment`
- Actions: `move_to`, `mark_read`, `delete`, `add_tags`

### Security Tools

**agenticmail_spam:** Actions: `list` (limit?, offset?), `report` (uid, folder?), `not_spam` (uid), `score` (uid, folder?)

**agenticmail_pending_emails:** Actions: `list`, `get` (id)
- `approve` and `reject` are **explicitly blocked** — returns error directing agent to notify owner

**agenticmail_cleanup** (master key): Actions: `list_inactive` (hours?), `cleanup` (hours?, dryRun?), `set_persistent` (agentId, persistent)

### Inter-Agent Communication

**agenticmail_list_agents:** Returns `{agents: [{name, email, role}]}`. Falls back to master key list.

**agenticmail_message_agent:**
| Field | Type | Required |
|-------|------|----------|
| `agent` | string | Yes |
| `subject` | string | Yes |
| `text` | string | Yes |
| `priority` | "normal"\|"high"\|"urgent" | No |

Validates agent exists. Prevents self-messaging. Rate-limited. Priority prefixes subject with `[URGENT]` or `[HIGH]`.

**agenticmail_check_messages:** Fetches up to 10 unread messages. Tags as `[agent]` or `[external]`. Resets rate limiter.

**agenticmail_wait_for_email:**
| Field | Type | Default | Range |
|-------|------|---------|-------|
| `timeout` | number | 120 | 5–300 |

Uses SSE push with polling fallback. Returns email or task events.

### Task Queue

**agenticmail_check_tasks:** `{direction: "incoming"|"outgoing", assignee?}`

**agenticmail_claim_task:** `{id}`

**agenticmail_submit_result:** `{id, result?}`

**agenticmail_call_agent:** `{target, task, payload?, timeout?}` — synchronous RPC, polls every 2s

### Account Management

**agenticmail_whoami:** `GET /accounts/me`

**agenticmail_update_metadata:** `{metadata: object}` → `PATCH /accounts/me`

**agenticmail_create_account** (master): `{name, domain?, role?}` — also registers in identity registry

**agenticmail_delete_agent** (master): `{name, reason?}` → archives emails, generates deletion report

**agenticmail_deletion_reports** (master): `{id?}` — list all or get specific

### Gateway Tools (all master key)

**agenticmail_status:** `GET /health`

**agenticmail_setup_guide:** Returns relay vs domain comparison

**agenticmail_setup_relay:** `{provider, email, password, smtpHost?, smtpPort?, imapHost?, imapPort?, agentName?, agentRole?, skipDefaultAgent?}`

**agenticmail_setup_domain:** `{cloudflareToken, cloudflareAccountId, domain?, purchase?, gmailRelay?}`

**agenticmail_setup_gmail_alias:** `{agentEmail, agentDisplayName?}`

**agenticmail_setup_payment:** No input

**agenticmail_purchase_domain:** `{keywords: string[], tld?}`

**agenticmail_gateway_status:** `GET /gateway/status`

**agenticmail_test_email:** `{to}` → `POST /gateway/test`

---

## Email Channel Integration

### Channel Metadata

```typescript
{
  id: 'mail',
  label: 'Email',
  selectionLabel: 'Email (AgenticMail)',
  capabilities: {
    chatTypes: ['direct'],
    media: true,
    reply: true,
    threads: true
  }
}
```

### ResolvedMailAccount

```typescript
{
  accountId: string;
  apiUrl: string;
  apiKey: string;
  watchMailboxes: string[];    // Default: ['INBOX']
  pollIntervalMs: number;      // Default: 30,000
  enabled: boolean;
}
```

### Monitoring

1. **SSE push** — connects to `GET /events` for IMAP IDLE-backed notifications
2. **Polling fallback** — exponential backoff: 2s → 4s → 8s → 16s → 30s max
3. **Processed UID tracking** — caps at 1000 (keeps latest 500)

### Email Dispatch Pipeline

1. New email detected (via SSE or poll)
2. Build message context (OpenClaw format)
3. Extract thread ID from `References[0]` or `messageId`
4. Dispatch through `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher`
5. Mark email as read

---

## Follow-Up System

### FollowUpEntry

```typescript
interface FollowUpEntry {
  pendingId: string;
  recipient: string;
  subject: string;
  step: number;           // 0-indexed within cycle
  cycle: number;          // Full cycles completed
  nextFireAt: string;     // ISO timestamp
  createdAt: string;      // ISO timestamp
  sessionKey: string;     // OpenClaw session key
  apiUrl: string;
  apiKey: string;
}
```

### Schedule

| Step | Delay |
|------|-------|
| 0 | 12 hours |
| 1 | 6 hours |
| 2 | 3 hours |
| 3 | 1 hour (final) |
| — | 3-day cooldown |
| 4+ | Cycle restarts |

### Persistence

Stored at `${stateDir}/agenticmail-followups.json`:
```json
{ "version": 1, "entries": [...] }
```

Restored on startup. Entries >1 day overdue are skipped.

### Delivery

Reminders delivered via `api.runtime.system.enqueueSystemEvent()`.

### API

| Function | Description |
|----------|-------------|
| `initFollowUpSystem(api)` | Initialize (restore persisted state) |
| `scheduleFollowUp(pendingId, recipient, subject, sessionKey, apiUrl, apiKey)` | Start tracking |
| `cancelFollowUp(pendingId)` | Cancel specific |
| `cancelAllFollowUps()` | Cancel all |
| `activeFollowUpCount()` | Count tracked |
| `getFollowUpSummary()` | Get all entries summary |

---

## Lifecycle Hooks

### before_agent_start

1. Detect sub-agent session (`sessionKey.includes(':subagent:')`)
2. Provision email account via `POST /accounts`
3. Handle 409 conflict with UUID-suffixed retry
4. Send auto-intro email in coordination thread
5. Inject context: identity, mailbox requirement, security rules, unread mail summary

### before_tool_call

1. Inject sub-agent API key for `agenticmail_*` tools
2. Inject pending email notifications from SSE watchers
3. Capture `sessions_spawn` info (enforce min 10-minute timeout)

### agent_end

1. Cancel all follow-ups
2. Remove from registries
3. Stop SSE watcher
4. Delay 5 seconds (grace period)
5. Delete account via `DELETE /accounts/{id}` with master key

---

## Health Monitor Service

```typescript
{
  id: 'agenticmail-monitor',
  start(): validates API connectivity, logs agent name and email
  stop(): logs shutdown
}
```

---

## Constants Summary

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_SUBAGENT_TIMEOUT_S` | 600 (10 min) | Minimum sub-agent session timeout |
| `SUBAGENT_GC_INTERVAL_MS` | 900,000 (15 min) | Sub-agent garbage collection interval |
| `SUBAGENT_MAX_AGE_MS` | 7,200,000 (2 hr) | Max sub-agent account age |
| `CLEANUP_GRACE_MS` | 5,000 (5 sec) | Grace period before account deletion |
| `RATE_LIMIT.WARN_THRESHOLD` | 3 | Unanswered messages before warning |
| `RATE_LIMIT.BLOCK_THRESHOLD` | 5 | Unanswered messages before blocking |
| `RATE_LIMIT.WINDOW_MAX` | 10 | Max messages per window |
| `RATE_LIMIT.WINDOW_MS` | 300,000 (5 min) | Rate limit window |
| `RATE_LIMIT.COOLDOWN_MS` | 120,000 (2 min) | Cooldown after block |
| `TRACKER_GC_INTERVAL_MS` | 600,000 (10 min) | Rate limiter GC interval |
| `TRACKER_STALE_MS` | 1,800,000 (30 min) | Rate limiter stale threshold |
| `SSE_INITIAL_DELAY_MS` | 2,000 | Initial SSE reconnect backoff |
| `SSE_MAX_DELAY_MS` | 30,000 | Max SSE reconnect backoff |
| `apiRequest timeout` | 30,000 | Default API timeout |
| `HEARTBEAT_INTERVAL_MS` | 300,000 (5 min) | Pending email check interval |
| Follow-up cooldown | 259,200,000 (3 days) | Between follow-up cycles |
| Follow-up steps | [12h, 6h, 3h, 1h] | Escalating reminder delays |
| `processedUids` cap | 1,000 (keep 500) | Channel UID tracking limit |
| `pollIntervalMs` default | 30,000 | Channel polling interval |

---

## Skill Files

```
skill/
├── SKILL.md                        # Main skill definition (injected into prompt)
├── references/
│   ├── api-reference.md            # API endpoint reference
│   └── configuration.md            # Config guide
└── scripts/
    ├── health-check.sh             # Server health check
    └── setup.sh                    # Setup helper
```

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
