# @agenticmail/core — Technical Reference

Complete API reference for developers and AI agents. Every exported class, function, type, constant, method signature, configuration option, database table, and detection rule.

---

## Table of Contents

- [Exports Overview](#exports-overview)
- [Configuration](#configuration)
- [Account Management](#account-management)
- [Mail Operations](#mail-operations)
- [Email Parsing](#email-parsing)
- [Inbox Watching](#inbox-watching)
- [Spam Filter](#spam-filter)
- [Outbound Guard](#outbound-guard)
- [Email Sanitizer](#email-sanitizer)
- [Gateway Manager](#gateway-manager)
- [Relay Gateway](#relay-gateway)
- [Cloudflare Client](#cloudflare-client)
- [Tunnel Manager](#tunnel-manager)
- [DNS Configurator](#dns-configurator)
- [Domain Purchaser](#domain-purchaser)
- [Relay Bridge](#relay-bridge)
- [Stalwart Admin](#stalwart-admin)
- [Domain Manager](#domain-manager)
- [Storage](#storage)
- [Search Index](#search-index)
- [Setup](#setup)
- [Database Schema](#database-schema)
- [Constants](#constants)

---

## Exports Overview

87 items exported from the barrel (`src/index.ts`):

### Classes (17)
`AgenticMailClient`, `AccountManager`, `AgentDeletionService`, `MailSender`, `MailReceiver`, `InboxWatcher`, `GatewayManager`, `RelayGateway`, `CloudflareClient`, `TunnelManager`, `DNSConfigurator`, `DomainPurchaser`, `RelayBridge`, `StalwartAdmin`, `DomainManager`, `EmailSearchIndex`, `SetupManager`, `DependencyChecker`, `DependencyInstaller`

### Functions (9)
`resolveConfig`, `ensureDataDir`, `saveConfig`, `parseEmail`, `scoreEmail`, `isInternalEmail`, `scanOutboundEmail`, `buildInboundSecurityAdvisory`, `sanitizeEmail`, `getDatabase`, `closeDatabase`, `createTestDatabase`, `startRelayBridge`

### Types & Interfaces (55+)
`AgenticMailConfig`, `AgenticMailClientOptions`, `Agent`, `CreateAgentOptions`, `AgentRole`, `DeletionReport`, `DeletionSummary`, `ArchivedEmail`, `ArchiveAndDeleteOptions`, `SendMailOptions`, `SendResult`, `SendResultWithRaw`, `Attachment`, `EmailEnvelope`, `AddressInfo`, `ParsedEmail`, `ParsedAttachment`, `MailboxInfo`, `SearchCriteria`, `MailSenderOptions`, `MailReceiverOptions`, `FolderInfo`, `InboxWatcherOptions`, `InboxEvent`, `InboxNewEvent`, `InboxExpungeEvent`, `InboxFlagsEvent`, `WatcherOptions`, `SpamResult`, `SpamRuleMatch`, `SpamCategory`, `SanitizeResult`, `SanitizeDetection`, `OutboundScanResult`, `OutboundScanInput`, `OutboundWarning`, `OutboundCategory`, `Severity`, `SecurityAdvisory`, `AttachmentAdvisory`, `LinkAdvisory`, `GatewayMode`, `GatewayConfig`, `GatewayStatus`, `GatewayManagerOptions`, `LocalSmtpConfig`, `RelayConfig`, `RelayProvider`, `DomainModeConfig`, `PurchasedDomain`, `InboundEmail`, `DomainSearchResult`, `DomainPurchaseResult`, `DnsSetupResult`, `TunnelConfig`, `RelayBridgeOptions`, `StalwartAdminOptions`, `StalwartPrincipal`, `DomainInfo`, `DnsRecord`, `DomainSetupResult`, `SearchableEmail`, `DependencyStatus`, `InstallProgress`, `SetupConfig`, `SetupResult`

### Constants (5)
`AGENT_ROLES`, `DEFAULT_AGENT_ROLE`, `DEFAULT_AGENT_NAME`, `SPAM_THRESHOLD`, `WARNING_THRESHOLD`, `RELAY_PRESETS`

---

## Configuration

### `resolveConfig(overrides?: Partial<AgenticMailConfig>): AgenticMailConfig`
Loads configuration from environment variables, config file, and programmatic overrides (in that priority order).

### `ensureDataDir(config: AgenticMailConfig): void`
Creates the data directory (`~/.agenticmail/` by default) if it doesn't exist.

### `saveConfig(config: AgenticMailConfig): void`
Saves configuration to `{dataDir}/config.json` with file mode 0600.

### `AgenticMailConfig`
```typescript
interface AgenticMailConfig {
  masterKey: string;
  stalwart: { url: string; adminUser: string; adminPassword: string };
  smtp: { host: string; port: number };
  imap: { host: string; port: number };
  api: { port: number; host: string };
  gateway?: { mode: GatewayMode; relay?: RelayConfig; domain?: DomainModeConfig };
  dataDir: string;
}
```

---

## Account Management

### `AccountManager`
```typescript
class AccountManager {
  constructor(db: Database.Database, stalwart: StalwartAdmin)

  create(options: CreateAgentOptions): Promise<Agent>
  getById(id: string): Promise<Agent | null>
  getByApiKey(apiKey: string): Promise<Agent | null>
  getByName(name: string): Promise<Agent | null>
  getByRole(role: AgentRole): Promise<Agent[]>
  list(): Promise<Agent[]>
  delete(id: string): Promise<boolean>
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<Agent | null>
  getCredentials(id: string): Promise<{ email; password; principal; smtpHost; smtpPort; imapHost; imapPort } | null>
}
```

**`create()`** — Validates name against `/^[a-zA-Z0-9._-]+$/`, generates UUID + API key (`ak_` + 48 hex) + password (32 hex), creates Stalwart principal, inserts DB record. Rolls back Stalwart on DB failure.

**`updateMetadata()`** — Merge semantics. Preserves internal `_`-prefixed fields. Users cannot overwrite `_password` or `_gateway`.

**`getCredentials()`** — Returns hardcoded localhost SMTP(587)/IMAP(143) with password from `metadata._password`.

### Types

```typescript
interface Agent {
  id: string;                          // UUID
  name: string;                        // email-safe unique name
  email: string;                       // principal@domain
  apiKey: string;                      // ak_... (48 hex chars)
  stalwartPrincipal: string;           // lowercase principal name
  createdAt: string;                   // ISO timestamp
  updatedAt: string;                   // ISO timestamp
  metadata: Record<string, unknown>;   // flexible JSON (internal fields: _password, _gateway)
  role: AgentRole;
}

interface CreateAgentOptions {
  name: string;                        // required, must match /^[a-zA-Z0-9._-]+$/
  domain?: string;                     // default: 'localhost'
  password?: string;                   // auto-generated if omitted
  metadata?: Record<string, unknown>;
  gateway?: 'relay' | 'domain';        // stored in metadata._gateway
  role?: AgentRole;                    // default: 'secretary'
}

type AgentRole = 'secretary' | 'assistant' | 'researcher' | 'writer' | 'custom';
```

### `AgentDeletionService`
```typescript
class AgentDeletionService {
  constructor(db: Database.Database, accountManager: AccountManager, config: AgenticMailConfig)

  archiveAndDelete(agentId: string, options?: ArchiveAndDeleteOptions): Promise<DeletionReport>
  getReport(deletionId: string): DeletionReport | null
  listReports(): DeletionSummary[]
}
```

**`archiveAndDelete()`** — Prevents deleting last agent. Connects to IMAP, archives all emails (inbox, sent, custom folders, up to 10,000 per folder), builds summary with top 10 correspondents, saves JSON to `~/.agenticmail/deletions/{name}_{timestamp}.json`, inserts DB record, then deletes agent.

```typescript
interface DeletionReport {
  id: string;                          // del_{uuid}
  agent: { id; name; email; role; createdAt };
  deletedAt: string;
  deletedBy: string;
  reason?: string;
  emails: {
    inbox: ArchivedEmail[];
    sent: ArchivedEmail[];
    other: Record<string, ArchivedEmail[]>;
  };
  summary: {
    totalEmails: number;
    inboxCount: number;
    sentCount: number;
    otherCount: number;
    folders: string[];
    firstEmailDate?: string;
    lastEmailDate?: string;
    topCorrespondents: Array<{ address: string; count: number }>;
  };
}
```

---

## Mail Operations

### `MailSender`
```typescript
class MailSender {
  constructor(options: MailSenderOptions)

  send(mail: SendMailOptions): Promise<SendResultWithRaw>
  verify(): Promise<boolean>
  close(): void
}
```

**Timeouts:** connectionTimeout=10s, greetingTimeout=10s, socketTimeout=15s. TLS: rejectUnauthorized=false.

**`send()`** — Builds RFC822 via MailComposer, returns messageId + envelope + raw Buffer. Supports `fromName` for display name in From header.

```typescript
interface MailSenderOptions {
  host: string;
  port: number;
  email: string;                       // From address
  password: string;
  authUser?: string;                   // defaults to email
  secure?: boolean;                    // default: false
}

interface SendMailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  inReplyTo?: string;                  // Message-ID for threading
  references?: string[];               // ancestor Message-IDs
  attachments?: Attachment[];
  headers?: Record<string, string>;
  fromName?: string;                   // display name in From header
}

interface Attachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
  encoding?: string;                   // e.g., 'base64'
}

interface SendResultWithRaw extends SendResult {
  raw: Buffer;                         // RFC822 bytes for Sent folder
}
```

### `MailReceiver`
```typescript
class MailReceiver {
  constructor(options: MailReceiverOptions)

  connect(): Promise<void>
  disconnect(): Promise<void>
  get usable(): boolean

  // Listing
  listEnvelopes(mailbox?: string, options?: { limit?: number; offset?: number }): Promise<EmailEnvelope[]>
  getMailboxInfo(mailbox?: string): Promise<MailboxInfo>

  // Reading
  fetchMessage(uid: number, mailbox?: string): Promise<Buffer>
  batchFetch(uids: number[], mailbox?: string): Promise<Map<number, Buffer>>

  // Searching
  search(criteria: SearchCriteria, mailbox?: string): Promise<number[]>

  // Flags
  markSeen(uid: number, mailbox?: string): Promise<void>
  markUnseen(uid: number, mailbox?: string): Promise<void>
  batchMarkSeen(uids: number[], mailbox?: string): Promise<void>
  batchMarkUnseen(uids: number[], mailbox?: string): Promise<void>

  // Delete & Move
  deleteMessage(uid: number, mailbox?: string): Promise<void>
  batchDelete(uids: number[], mailbox?: string): Promise<void>
  moveMessage(uid: number, fromMailbox: string, toMailbox: string): Promise<void>
  batchMove(uids: number[], fromMailbox: string, toMailbox: string): Promise<void>

  // Folders
  listFolders(): Promise<FolderInfo[]>
  createFolder(path: string): Promise<void>

  // Advanced
  appendMessage(raw: Buffer, mailbox: string, flags?: string[]): Promise<void>
  getImapClient(): ImapFlow
}
```

**`listEnvelopes()`** — Pagination: default limit=20 (max 1000), offset=0. Returns newest first.

**`appendMessage()`** — Default flags: `['\\Seen']`. Attaches current Date.

```typescript
interface EmailEnvelope {
  uid: number;
  seq: number;
  messageId: string;
  subject: string;
  from: AddressInfo[];
  to: AddressInfo[];
  date: Date;
  flags: Set<string>;
  size: number;
}

interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  since?: Date;
  before?: Date;
  seen?: boolean;
  text?: string;                       // body text search
}

interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;                 // \\Sent, \\Drafts, \\Trash, etc.
  flags: string[];
}

interface MailboxInfo {
  name: string;
  exists: number;
  recent: number;
  unseen: number;
}
```

---

## Email Parsing

### `parseEmail(raw: Buffer | string): Promise<ParsedEmail>`

Uses mailparser's `simpleParser`. Special handling:
- **X-Original-From header**: If present and from address is `@localhost`, replaces with the original external sender (relay email detection).
- **References**: Normalizes single string to array.
- **Attachments**: Extracts filename (default 'unnamed'), contentType, size, content Buffer.

```typescript
interface ParsedEmail {
  messageId: string;
  subject: string;
  from: AddressInfo[];
  to: AddressInfo[];
  cc?: AddressInfo[];
  replyTo?: AddressInfo[];
  date: Date;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: ParsedAttachment[];
  headers: Map<string, string>;
}

interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}
```

---

## Inbox Watching

### `InboxWatcher`
```typescript
class InboxWatcher extends EventEmitter {
  constructor(options: InboxWatcherOptions)

  start(): Promise<void>
  stop(): Promise<void>
  isWatching(): boolean

  // Events
  on(event: 'new', listener: (e: InboxNewEvent) => void): this
  on(event: 'expunge', listener: (e: InboxExpungeEvent) => void): this
  on(event: 'flags', listener: (e: InboxFlagsEvent) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'close', listener: () => void): this
}
```

**`start()`** — Creates fresh ImapFlow client, connects, acquires mailbox lock (held for IDLE). When `exists` event fires (new messages), calculates range, fetches and parses all new messages, emits 'new' for each. `expunge` and `flags` events forwarded directly.

**`stop()`** — Removes all event listeners, releases lock, logs out. Idempotent.

```typescript
interface InboxWatcherOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  secure?: boolean;                    // default: false
}

interface InboxNewEvent {
  type: 'new';
  uid: number;
  message?: ParsedEmail;               // present if autoFetch=true (default)
}

interface InboxExpungeEvent {
  type: 'expunge';
  seq: number;                         // IMAP sequence number
}

interface InboxFlagsEvent {
  type: 'flags';
  uid: number;
  flags: Set<string>;
}
```

---

## Spam Filter

### `scoreEmail(email: ParsedEmail): SpamResult`

Runs 47 rules across 9 categories. Each rule is try-catch wrapped. Concatenates subject + text + html for pattern testing.

### `isInternalEmail(email: ParsedEmail, localDomains?: string[]): boolean`

Returns true if from address is `@localhost` (or in localDomains). **Exception:** If from is `@localhost` but replyTo has an external domain, returns false (relay email detection).

```typescript
interface SpamResult {
  score: number;                       // 0-100+
  isSpam: boolean;                     // score >= SPAM_THRESHOLD (40)
  isWarning: boolean;                  // score >= WARNING_THRESHOLD (20) && < SPAM_THRESHOLD
  matches: SpamRuleMatch[];
  topCategory: SpamCategory | null;    // category with highest total score
}

interface SpamRuleMatch {
  ruleId: string;
  category: SpamCategory;
  score: number;
  description: string;
}

type SpamCategory =
  | 'prompt_injection'
  | 'social_engineering'
  | 'data_exfiltration'
  | 'phishing'
  | 'header_anomaly'
  | 'content_spam'
  | 'link_analysis'
  | 'authentication'
  | 'attachment_risk';
```

### Complete Rule Inventory (47 rules)

| Rule ID | Category | Score | What it detects |
|---------|----------|-------|-----------------|
| pi_ignore_instructions | prompt_injection | 25 | "ignore previous/prior instructions" |
| pi_you_are_now | prompt_injection | 25 | "you are now a..." roleplay injection |
| pi_system_delimiter | prompt_injection | 20 | [SYSTEM], [INST], <<SYS>>, <\|im_start\|> |
| pi_new_instructions | prompt_injection | 20 | "new instructions:" / "override instructions:" |
| pi_act_as | prompt_injection | 15 | "act as a" / "pretend to be" |
| pi_do_not_mention | prompt_injection | 15 | "do not mention/tell/reveal that" |
| pi_invisible_unicode | prompt_injection | 20 | Tag chars (U+E0001-E007F), dense zero-width |
| pi_jailbreak | prompt_injection | 20 | "DAN", "jailbreak", "bypass safety" |
| pi_base64_injection | prompt_injection | 15 | 100+ char base64 blocks |
| pi_markdown_injection | prompt_injection | 10 | \`\`\`system, \`\`\`python exec |
| se_owner_impersonation | social_engineering | 20 | "your owner/admin asked/told/wants" |
| se_secret_request | social_engineering | 15 | "share your API key/password/secret" |
| se_impersonate_system | social_engineering | 15 | "this is a system/security automated message" |
| se_urgency_authority | social_engineering | 10 | urgency + authority/threat language combined |
| se_money_request | social_engineering | 15 | "send me $X", "wire transfer" |
| se_gift_card | social_engineering | 20 | "buy me gift cards", iTunes/Google Play |
| se_ceo_fraud | social_engineering | 15 | CEO/CFO/CTO + payment/wire/urgent |
| de_forward_all | data_exfiltration | 20 | "forward all/every emails" |
| de_search_credentials | data_exfiltration | 20 | "search inbox for password" |
| de_send_to_external | data_exfiltration | 15 | "send the/all to external@email" |
| de_dump_instructions | data_exfiltration | 15 | "reveal system prompt" / "dump instructions" |
| de_webhook_exfil | data_exfiltration | 15 | webhook/ngrok/pipedream/requestbin URLs |
| ph_spoofed_sender | phishing | 10 | brand name in From but mismatched domain |
| ph_credential_harvest | phishing | 15 | "verify your account" + links present |
| ph_suspicious_links | phishing | 10 | IP in URL, shorteners, 4+ subdomains |
| ph_data_uri | phishing | 15 | data:text/html or javascript: in hrefs |
| ph_homograph | phishing | 15 | punycode (xn--) or mixed Cyrillic+Latin domain |
| ph_mismatched_display_url | phishing | 10 | link text URL != href URL domain |
| ph_login_urgency | phishing | 10 | "click here/sign in" + urgency words |
| ph_unsubscribe_missing | phishing | 3 | 5+ links, no List-Unsubscribe header |
| auth_spf_fail | authentication | 15 | SPF fail/softfail in Authentication-Results |
| auth_dkim_fail | authentication | 15 | DKIM fail in Authentication-Results |
| auth_dmarc_fail | authentication | 20 | DMARC fail in Authentication-Results |
| auth_no_auth_results | authentication | 3 | missing Authentication-Results header |
| at_executable | attachment_risk | 25 | .exe/.bat/.cmd/.ps1/.sh/.dll/.scr/.vbs/.js/.msi/.com |
| at_double_extension | attachment_risk | 20 | .pdf.exe, .doc.bat, etc. |
| at_archive_carrier | attachment_risk | 15 | .zip/.rar/.7z/.tar.gz/.tgz |
| at_html_attachment | attachment_risk | 10 | .html/.htm/.svg |
| ha_missing_message_id | header_anomaly | 5 | no Message-ID header |
| ha_empty_from | header_anomaly | 10 | empty or missing From |
| ha_reply_to_mismatch | header_anomaly | 5 | Reply-To domain != From domain |
| cs_all_caps_subject | content_spam | 5 | subject >80% uppercase (min 10 chars) |
| cs_lottery_scam | content_spam | 25 | lottery/prize/"Nigerian prince" |
| cs_crypto_scam | content_spam | 10 | crypto investment/"guaranteed returns" |
| cs_excessive_punctuation | content_spam | 3 | 4+ !!!! or ???? in subject |
| cs_pharmacy_spam | content_spam | 15 | viagra/cialis/"online pharmacy" |
| cs_weight_loss | content_spam | 10 | "diet pill"/"lose 30 lbs" |
| cs_html_only_no_text | content_spam | 5 | HTML body but no plain text |
| cs_spam_word_density | content_spam | 10-20 | >5 spam words=10pts, >10 words=20pts |
| la_excessive_links | link_analysis | 5 | 10+ unique links |

---

## Outbound Guard

### `scanOutboundEmail(input: OutboundScanInput): OutboundScanResult`

Skips all scanning if every recipient ends with `@localhost`. Strips HTML tags and decodes entities before scanning text. Scans attachment content for text-scannable types.

### `buildInboundSecurityAdvisory(attachments, spamMatches): SecurityAdvisory`

Analyzes attachments for risk (executables, archives, double extensions, HTML files) and extracts link warnings from spam matches.

```typescript
interface OutboundScanInput {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    content?: Buffer | string;
    encoding?: string;
  }>;
}

interface OutboundScanResult {
  warnings: OutboundWarning[];
  hasHighSeverity: boolean;
  hasMediumSeverity: boolean;
  blocked: boolean;                    // true if ANY high-severity warning
  summary: string;
}

interface OutboundWarning {
  category: OutboundCategory;
  severity: Severity;
  ruleId: string;
  description: string;
  match: string;                       // up to 80 chars of matched text
}

type OutboundCategory = 'pii' | 'credential' | 'system_internal' | 'owner_privacy' | 'attachment_risk';
type Severity = 'high' | 'medium';
```

### Complete Rule Inventory (34+ text rules + attachment rules)

#### PII Rules

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| ob_ssn | HIGH | `\b\d{3}-\d{2}-\d{4}\b` |
| ob_ssn_obfuscated | HIGH | XXX.XX.XXXX, "ssn #123456789" variants |
| ob_credit_card | HIGH | `\b(?:\d{4}[-\s]?){3}\d{4}\b` |
| ob_phone | MEDIUM | US phone (optional +1, parens, dots) |
| ob_bank_routing | HIGH | routing/account number with 6-17 digits |
| ob_drivers_license | HIGH | driver's license + alphanumeric ID |
| ob_dob | MEDIUM | DOB/born on + date formats |
| ob_passport | HIGH | passport + 6-12 char ID |
| ob_tax_id | HIGH | EIN/TIN/tax id + XX-XXXXXXX |
| ob_itin | HIGH | ITIN + 9XX-XX-XXXX |
| ob_medicare | HIGH | medicare/medicaid + 8-14 char ID |
| ob_immigration | HIGH | A-number/alien number + 8-9 digits |
| ob_pin | MEDIUM | PIN/pin code = 4-8 digits |
| ob_security_qa | MEDIUM | security Q&A / mother's maiden name |

#### Financial Rules

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| ob_iban | HIGH | Country code + 2 digits + alphanumeric blocks |
| ob_swift | MEDIUM | SWIFT/BIC code (6 alpha + 2 alphanum + optional 3) |
| ob_crypto_wallet | HIGH | Bitcoin (bc1...), Legacy (1.../3...), Ethereum (0x...) |
| ob_wire_transfer | HIGH | wire transfer terms + account details |

#### Credential Rules

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| ob_api_key | HIGH | sk_/pk_/rk_/api_key_ + 20+ chars, sk-proj-... |
| ob_aws_key | HIGH | `AKIA[A-Z0-9]{16}` |
| ob_password_value | HIGH | p[a@4]ss(w[o0]rd)? := value |
| ob_private_key | HIGH | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH) PRIVATE KEY-----` |
| ob_bearer_token | HIGH | `Bearer [a-zA-Z0-9_\-.]{20,}` |
| ob_connection_string | HIGH | mongodb/postgres/mysql/redis/amqp:// |
| ob_github_token | HIGH | ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ + 20+ chars |
| ob_stripe_key | HIGH | sk_live_/pk_live_/rk_live_/sk_test_ + 20+ chars |
| ob_jwt | HIGH | eyJ...eyJ...eyJ... (3 base64url segments) |
| ob_webhook_url | HIGH | hooks.slack.com, discord webhooks, webhook.site |
| ob_env_block | HIGH | 3+ consecutive KEY=VALUE lines |
| ob_seed_phrase | HIGH | seed phrase/recovery phrase/mnemonic + content |
| ob_2fa_codes | HIGH | 2FA backup/recovery codes (series of 4-8 char codes) |
| ob_credential_pair | HIGH | username=X password=Y pairs |
| ob_oauth_token | HIGH | access_token/refresh_token/oauth_token = value |
| ob_vpn_creds | HIGH | VPN/OpenVPN/WireGuard + password/key/secret |

#### System Internal Rules

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| ob_private_ip | MEDIUM | 10.x.x.x, 192.168.x.x, 172.16-31.x.x |
| ob_file_path | MEDIUM | /Users/, /home/, /etc/, C:\Users\ paths |
| ob_env_variable | MEDIUM | KEY_URL/KEY_SECRET/KEY_TOKEN = value |

#### Owner Privacy Rules

| Rule ID | Severity | Pattern |
|---------|----------|---------|
| ob_owner_info | HIGH | "owner's name/address/phone/email/ssn" |
| ob_personal_reveal | HIGH | "the person who runs/owns me is/lives/named" |

#### Attachment Rules

| Extension Type | Severity | Extensions |
|----------------|----------|------------|
| Sensitive files | HIGH | .pem, .key, .p12, .pfx, .env, .credentials, .keystore, .jks, .p8 |
| Data files | MEDIUM | .db, .sqlite, .sqlite3, .sql, .csv, .tsv, .json, .yml, .yaml, .conf, .config, .ini |

Text-scannable extensions (content scanned through all rules): .txt, .csv, .json, .xml, .yaml, .yml, .md, .log, .env, .conf, .config, .ini, .sql, .js, .ts, .py, .sh, .html, .htm, .css, .toml

---

## Email Sanitizer

### `sanitizeEmail(email: ParsedEmail): SanitizeResult`

```typescript
interface SanitizeResult {
  text: string;                        // cleaned plain text
  html: string;                        // cleaned HTML
  detections: SanitizeDetection[];
  wasModified: boolean;
}

interface SanitizeDetection {
  type: string;                        // detection identifier
  description: string;
  count: number;
}
```

**Invisible Unicode patterns removed:**
| Pattern | Chars |
|---------|-------|
| invisible_tags | U+E0001-E007F |
| zero_width | U+200B, U+200C, U+200D, U+FEFF (when 3+ consecutive) |
| bidi_control | U+202A-202E, U+2066-2069 |
| soft_hyphen | U+00AD |
| word_joiner | U+2060 |

**Hidden HTML patterns removed:**
| Pattern | What it catches |
|---------|----------------|
| hidden_css | display:none, visibility:hidden, font-size:0, opacity:0 |
| white_on_white | same foreground/background color (#fff/#ffffff/white) |
| offscreen | position:absolute/fixed + left/top: -9999+ |
| script_tags | `<script>...</script>` |
| data_uri | src/href/action with data:text/html or javascript: |
| suspicious_comment | HTML comments containing: ignore, system, instruction, prompt, inject |
| hidden_iframe | `<iframe>` with width/height=0 or display:none |

---

## Gateway Manager

### `GatewayManager`
```typescript
class GatewayManager {
  constructor(options: GatewayManagerOptions)

  // Setup
  setupRelay(config: RelayConfig, options?: { createDefaultAgent?: boolean }): Promise<void>
  setupDomain(options: {
    cloudflareToken: string;
    cloudflareAccountId: string;
    domain?: string;
    purchase?: { keywords: string[]; tlds?: string[] };
    gmailRelay?: { email: string; appPassword: string };
    outboundWorkerUrl?: string;
    outboundSecret?: string;
  }): Promise<{ domain; zoneId; tunnelId; dkimPublicKey; dnsRecords; outboundRelay?; nextSteps }>

  // Email routing
  routeOutbound(agentName: string, mail: SendMailOptions): Promise<SendResult | { pendingId: string }>
  sendViaStalwart(agentName: string, mail: SendMailOptions): Promise<SendResult>
  sendTestEmail(to: string): Promise<SendResult>

  // Relay search & import
  searchRelay(criteria: SearchCriteria): Promise<RelaySearchResult[]>
  importRelayMessage(relayUid: number, agentName: string): Promise<void>

  // Lifecycle
  resume(): Promise<void>
  getStatus(): GatewayStatus
  getMode(): GatewayMode
  getConfig(): GatewayConfig | null
  getStalwart(): StalwartAdmin

  // Deduplication
  isAlreadyDelivered(messageId: string, agentName: string): boolean
  recordDelivery(messageId: string, agentName: string): void
}
```

**`routeOutbound()`** — If all recipients are `@localhost`, routes locally. Otherwise routes through relay or Stalwart depending on mode.

**`sendViaStalwart()`** — Rewrites `@localhost` → `@domain` in sender address, submits to Stalwart SMTP (port 587).

**Inbound delivery (internal `deliverInboundLocally()`):**
- Authenticates as the target agent (Stalwart requires sender=auth user)
- Runs spam filter via `scoreEmail()`
- Detects approval reply emails (matches In-Reply-To against `pending_outbound.notification_message_id`)
- Approval patterns recognized: `approve[d]?`, `yes`, `send`, `go ahead`, `lgtm`, `ok`
- Rejection patterns recognized: `reject[ed]?`, `no`, `deny`, `don't send`, `cancel`, `block`
- Adds headers: `X-AgenticMail-Relay`, `X-Original-From`, `X-Original-Message-Id`

**Domain mode setup (17 steps) returns:**
```typescript
{
  domain: string;
  zoneId: string;
  tunnelId: string;
  dkimPublicKey: string;
  dnsRecords: DnsRecord[];
  outboundRelay?: { configured: boolean; smtpHost: string };
  nextSteps: string[];                 // e.g., Gmail "Send mail as" instructions
}
```

---

## Relay Gateway

### `RelayGateway`
```typescript
class RelayGateway {
  constructor(options?: { onInboundMail?: (email: InboundEmail, agentName: string) => Promise<void>; defaultAgentName?: string })

  setup(config: RelayConfig): Promise<void>
  sendViaRelay(agentName: string, mail: SendMailOptions): Promise<SendResult>
  startPolling(intervalMs?: number): void       // default: 30000
  stopPolling(): void
  searchRelay(criteria: SearchCriteria, maxResults?: number): Promise<RelaySearchResult[]>
  fetchRelayMessage(uid: number): Promise<InboundEmail>
  setLastSeenUid(uid: number): void
  trackSentMessage(messageId: string, agentName: string): void
  isConfigured(): boolean
  isPolling(): boolean
  getConfig(): RelayConfig | null
  shutdown(): Promise<void>
}
```

**Polling details:**
- Uses `setTimeout` (not `setInterval`) for natural backoff
- Backoff: `interval * 2^(failures-1)`, capped at 5 minutes
- Connection timeout: 30 seconds per poll
- First poll: scans UID range `uidNext-50` to `*`
- Subsequent: only `lastSeenUid+1` to `*`
- Never permanently stops — always reschedules
- Logs every 5 consecutive failures

**Agent routing priority:**
1. Sub-address in To/CC/Delivered-To/X-Original-To (`user+agent@domain`)
2. In-Reply-To matched against tracked sent messages
3. References chain (newest first)
4. Default agent fallback

**Sent message tracking:** Map capped at 10,000 entries.

```typescript
interface InboundEmail {
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  attachments: Array<{ filename: string; contentType: string; size: number; content: Buffer }>;
}
```

---

## Cloudflare Client

### `CloudflareClient`
```typescript
class CloudflareClient {
  constructor(apiToken: string, accountId: string)

  // Zones
  listZones(): Promise<CloudflareZone[]>
  getZone(domain: string): Promise<CloudflareZone>
  createZone(domain: string): Promise<CloudflareZone>

  // DNS
  listDnsRecords(zoneId: string): Promise<CloudflareDnsRecord[]>
  createDnsRecord(zoneId: string, record: { type; name; content; ttl?; priority?; proxied? }): Promise<CloudflareDnsRecord>
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>

  // Registrar
  searchDomains(query: string): Promise<CloudflareDomainAvailability[]>
  checkAvailability(domain: string): Promise<CloudflareDomainAvailability>
  purchaseDomain(domain: string, autoRenew?: boolean): Promise<void>
  listRegisteredDomains(): Promise<any[]>

  // Tunnels
  createTunnel(name: string): Promise<CloudflareTunnel>
  getTunnel(tunnelId: string): Promise<CloudflareTunnel>
  getTunnelToken(tunnelId: string): Promise<string>
  createTunnelRoute(tunnelId: string, hostname: string, service: string, options?: { apiService?: string; apiPort?: number }): Promise<void>
  deleteTunnel(tunnelId: string): Promise<void>
  listTunnels(): Promise<CloudflareTunnel[]>

  // Email Routing
  enableEmailRouting(zoneId: string): Promise<void>
  disableEmailRouting(zoneId: string): Promise<void>
  getEmailRoutingStatus(zoneId: string): Promise<any>
  setCatchAllWorkerRule(zoneId: string, workerName: string): Promise<void>

  // Workers
  deployEmailWorker(scriptName: string, scriptContent: string, envVars: Record<string, string>): Promise<void>
  deleteWorker(scriptName: string): Promise<void>
}
```

**API base:** `https://api.cloudflare.com/client/v4`

**`createTunnel()`** — Reuses existing tunnel if name matches. Generates random 32-byte secret.

**`createTunnelRoute()`** — Creates ingress: `/api/agenticmail/*` → apiService (port 3100), `*` → primary service (port 8080), catch-all → 404.

**`deployEmailWorker()`** — Multipart form upload with ES module metadata and plain_text env var bindings. Compatibility date: 2024-01-01.

---

## Tunnel Manager

### `TunnelManager`
```typescript
class TunnelManager {
  constructor(cf: CloudflareClient)

  install(): Promise<string>           // returns binary path
  create(name: string): Promise<TunnelConfig>
  start(tunnelToken: string): Promise<void>
  createIngress(tunnelId: string, domain: string, smtpPort?: number, httpPort?: number, apiPort?: number): Promise<void>
  stop(): Promise<void>
  status(): { running: boolean; pid?: number }
  healthCheck(tunnelId: string): Promise<boolean>
}
```

**`install()`** — Priority: managed binary (`~/.agenticmail/bin/cloudflared`) → system-wide (`which`) → download from GitHub releases. Platform detection: darwin-arm64, darwin-amd64, linux-arm64, linux-amd64. Atomic install: write .tmp, chmod 0755, rename.

**`start()`** — Spawns cloudflared with `--no-autoupdate`. Token passed via env var (not CLI arg). Waits up to 30 seconds for "Registered tunnel connection" or "Connection registered" in stdout/stderr.

**`stop()`** — SIGTERM with 5 second timeout.

---

## DNS Configurator

### `DNSConfigurator`
```typescript
class DNSConfigurator {
  constructor(cf: CloudflareClient)

  detectPublicIp(): Promise<string>
  configureForEmail(domain: string, zoneId: string, options?: {
    serverIp?: string;
    dkimSelector?: string;
    dkimPublicKey?: string;
  }): Promise<DnsSetupResult>
  configureForTunnel(domain: string, zoneId: string, tunnelId: string): Promise<DnsSetupResult>
  verify(domain: string): Promise<{ mx: boolean; spf: boolean; dmarc: boolean }>
}
```

**`configureForEmail()`** records created:
- SPF TXT: `v=spf1 ip4:{serverIp} include:_spf.mx.cloudflare.net mx ~all`
- DMARC TXT: `v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain}`
- DKIM TXT: `v=DKIM1; k=rsa; p={publicKey}` (if key provided)
- Preserves Cloudflare Email Routing `_dc-mx.*` MX records
- Removes conflicting foreign MX records

**`configureForTunnel()`** records created:
- CNAME: `{domain} → {tunnelId}.cfargotunnel.com` (proxied)
- CNAME: `mail.{domain} → {tunnelId}.cfargotunnel.com` (proxied)
- Removes conflicting A/AAAA/CNAME records

---

## Domain Purchaser

### `DomainPurchaser`
```typescript
class DomainPurchaser {
  constructor(cf: CloudflareClient)

  searchAvailable(keywords: string[], tlds?: string[]): Promise<DomainSearchResult[]>
  purchase(domain: string, autoRenew?: boolean): Promise<void>  // throws — use CF dashboard
  getStatus(domain: string): Promise<any>
  listRegistered(): Promise<any[]>
}
```

Default TLDs: `.com`, `.net`, `.io`, `.dev`

**Note:** `purchase()` throws an error because Cloudflare API tokens only get read access to registrar. Users must purchase via Cloudflare dashboard.

---

## Relay Bridge

### `RelayBridge`
```typescript
class RelayBridge {
  constructor(options: RelayBridgeOptions)

  start(): Promise<void>
  stop(): Promise<void>
}

function startRelayBridge(options: RelayBridgeOptions): Promise<RelayBridge>
```

Local HTTP-to-SMTP bridge on `127.0.0.1:{port}`. Validates `X-Relay-Secret` header. Accepts POST `/send` with JSON payload, submits to Stalwart SMTP for DKIM signing and delivery.

---

## Stalwart Admin

### `StalwartAdmin`
```typescript
class StalwartAdmin {
  constructor(options: StalwartAdminOptions)

  // Principals
  createPrincipal(principal: StalwartPrincipal): Promise<void>
  getPrincipal(name: string): Promise<StalwartPrincipal>
  updatePrincipal(name: string, changes: Partial<StalwartPrincipal>): Promise<void>
  addEmailAlias(name: string, email: string): Promise<void>
  deletePrincipal(name: string): Promise<void>
  listPrincipals(type?: string): Promise<string[]>

  // Domains
  ensureDomain(domain: string): Promise<void>     // idempotent

  // Health
  healthCheck(): Promise<boolean>                  // 5s timeout

  // Settings
  getSetting(key: string): Promise<string | undefined>
  getSettings(prefix: string): Promise<Record<string, string>>
  updateSetting(key: string, value: string): Promise<void>   // via stalwart-cli in Docker

  // Config
  setHostname(domain: string): Promise<void>       // modifies stalwart.toml on host

  // DKIM
  createDkimSignature(domain: string, selector?: string): Promise<{ signatureId: string; publicKey: string }>
  hasDkimSignature(domain: string): Promise<boolean>

  // Outbound Relay
  configureOutboundRelay(config: {
    smtpHost: string;
    smtpPort: number;
    username: string;
    password: string;
    routeName?: string;                // default: 'gmail'
  }): Promise<void>                    // modifies stalwart.toml, restarts container
}
```

**Request timeout:** 15 seconds. Auth: HTTP Basic.

**`updateSetting()`** — Uses stalwart-cli inside Docker container. Deletes then adds config. Verifies by reading back.

**`createDkimSignature()`** — Idempotent. Signature ID: `agenticmail-{domain with dots→dashes}`. Default selector: `agenticmail`. Creates via `stalwart-cli dkim create rsa`. Sets signing rules in `auth.dkim.sign.*`. Returns base64 public key for DNS TXT record.

**`configureOutboundRelay()`** — Appends relay route and strategy to stalwart.toml. Routes: local domains → 'local', everything else → relay. Restarts container (15s wait).

```typescript
interface StalwartPrincipal {
  type: 'individual' | 'group' | 'domain' | 'list' | 'apiKey';
  name: string;
  secrets?: string[];
  emails?: string[];
  description?: string;
  quota?: number;
  memberOf?: string[];
  members?: string[];
  roles?: string[];
}
```

---

## Domain Manager

### `DomainManager`
```typescript
class DomainManager {
  constructor(db: Database.Database, stalwart: StalwartAdmin)

  setup(domain: string): Promise<DomainSetupResult>
  get(domain: string): Promise<DomainInfo | null>
  list(): Promise<DomainInfo[]>
  getDnsRecords(domain: string): Promise<DnsRecord[]>
  verify(domain: string): Promise<boolean>         // checks MX records
  delete(domain: string): Promise<boolean>
}
```

---

## Storage

### `getDatabase(config: AgenticMailConfig | string): Database.Database`

Singleton. Opens SQLite with WAL mode and foreign keys. Runs all pending migrations automatically.

### `closeDatabase(): void`

Closes and resets singleton.

### `createTestDatabase(): Database.Database`

In-memory database with all migrations applied. For testing.

---

## Search Index

### `EmailSearchIndex`
```typescript
class EmailSearchIndex {
  constructor(db: Database.Database)

  index(email: SearchableEmail): void
  search(agentId: string, query: string, limit?: number): Array<{ uid: number; rank: number }>
  deleteByAgent(agentId: string): void
}
```

**`search()`** — Wraps query in quotes (phrase search). Escapes internal quotes. Limit: 1-1000 (default 20). Returns empty on FTS5 syntax error. Ordered by FTS5 rank.

```typescript
interface SearchableEmail {
  agentId: string;
  messageId: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  bodyText: string;
  receivedAt: Date;
}
```

---

## Setup

### `SetupManager`
```typescript
class SetupManager {
  constructor(onProgress?: InstallProgress)

  checkDependencies(): Promise<{ docker; stalwart; cloudflared }>
  installAll(composePath?: string): Promise<void>
  ensureDocker(): Promise<void>
  ensureStalwart(composePath?: string): Promise<void>
  ensureCloudflared(): Promise<void>
  getComposePath(): string
  initConfig(): Promise<SetupConfig>
  isInitialized(): boolean
}
```

### `DependencyChecker`
```typescript
class DependencyChecker {
  checkAll(): Promise<DependencyStatus[]>
  checkDocker(): Promise<DependencyStatus>
  checkStalwart(): Promise<DependencyStatus>
  checkCloudflared(): Promise<DependencyStatus>
}
```

### `DependencyInstaller`
```typescript
class DependencyInstaller {
  constructor(onProgress?: InstallProgress)

  installDocker(): Promise<void>       // Homebrew (macOS) or official script (Linux)
  startStalwart(composePath: string): Promise<void>
  installCloudflared(): Promise<void>  // GitHub releases download
  installAll(composePath: string): Promise<void>
}
```

---

## Database Schema

### Tables

```sql
-- agents (migration 001 + 003 + 009)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  stalwart_principal TEXT NOT NULL,
  role TEXT DEFAULT 'secretary',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_activity_at TEXT,
  persistent INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}'
);

-- pending_outbound (migration 012 + 013)
CREATE TABLE pending_outbound (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mail_options TEXT NOT NULL,          -- JSON: to, subject, text, html, cc, bcc, etc.
  warnings TEXT NOT NULL,              -- JSON array of OutboundWarning
  summary TEXT,
  status TEXT DEFAULT 'pending',       -- pending | approved | rejected
  notification_message_id TEXT,        -- Message-ID of owner notification email
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,                    -- 'master' | 'owner-reply'
  error TEXT
);
CREATE INDEX idx_pending_agent_status ON pending_outbound(agent_id, status);
CREATE INDEX idx_pending_notification ON pending_outbound(notification_message_id);

-- agent_tasks (migration 010)
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  assigner_id TEXT,
  assignee_id TEXT,
  task_type TEXT DEFAULT 'generic',
  payload TEXT,                        -- JSON
  status TEXT DEFAULT 'pending',       -- pending | claimed | completed | failed
  result TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);

-- gateway_config (migration 002)
CREATE TABLE gateway_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  mode TEXT DEFAULT 'none',            -- relay | domain | none
  config TEXT DEFAULT '{}',            -- JSON: RelayConfig or DomainModeConfig
  created_at TEXT DEFAULT (datetime('now'))
);

-- delivered_messages (migration 004)
CREATE TABLE delivered_messages (
  message_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  delivered_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, agent_name)
);

-- email_search (FTS5, migration 001)
CREATE VIRTUAL TABLE email_search USING fts5(
  agent_id, message_id, subject, from_address, to_address, body_text, received_at
);

-- Plus: domains, config, purchased_domains, contacts, drafts, signatures,
-- templates, scheduled_emails, tags, message_tags, email_rules, agent_deletions, spam_log
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SPAM_THRESHOLD` | 40 | Score >= 40 → classified as spam |
| `WARNING_THRESHOLD` | 20 | Score 20-39 → warning flag |
| `AGENT_ROLES` | `['secretary', 'assistant', 'researcher', 'writer', 'custom']` | Valid agent roles |
| `DEFAULT_AGENT_ROLE` | `'secretary'` | Default role for new agents |
| `DEFAULT_AGENT_NAME` | `'secretary'` | Default agent name |
| `RELAY_PRESETS` | `{ gmail: {...}, outlook: {...} }` | SMTP/IMAP presets for Gmail and Outlook |

### Timeouts & Limits

| Setting | Value | Context |
|---------|-------|---------|
| SMTP connection timeout | 10,000ms | MailSender |
| SMTP greeting timeout | 10,000ms | MailSender |
| SMTP socket timeout | 15,000ms | MailSender |
| Stalwart API request timeout | 15,000ms | StalwartAdmin |
| Stalwart health check timeout | 5,000ms | StalwartAdmin |
| Relay poll interval (initial) | 30,000ms | RelayGateway |
| Relay poll backoff cap | 300,000ms (5 min) | RelayGateway |
| Relay connection timeout | 30,000ms | RelayGateway |
| Tunnel startup timeout | 30,000ms | TunnelManager |
| Tunnel stop timeout | 5,000ms | TunnelManager |
| Stalwart container wait | 30,000ms | DependencyInstaller |
| Docker daemon wait | 60,000ms | DependencyInstaller |
| Max emails per folder (archive) | 10,000 | AgentDeletionService |
| Sent message tracking cap | 10,000 entries | RelayGateway |
| IMAP list max limit | 1,000 | MailReceiver |
| FTS5 search max limit | 1,000 | EmailSearchIndex |
| Outbound match preview | 80 chars | scanOutboundEmail |

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
