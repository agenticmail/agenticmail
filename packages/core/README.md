# @agenticmail/core

Core SDK for [AgenticMail](https://github.com/agenticmail/agenticmail) — email infrastructure for AI agents.

This is the foundation layer that everything else builds on. If the API server, MCP server, OpenClaw plugin, and CLI are the ways people interact with AgenticMail, this package is what actually does the work underneath. It handles creating and managing AI agent accounts, sending and receiving real email, watching inboxes for new messages in real time, routing email to and from the internet (through Gmail relay or a custom domain with Cloudflare), filtering spam, scanning outgoing emails to prevent agents from leaking sensitive data, and storing everything in a local SQLite database.

Every other AgenticMail package depends on this one.

---

## Table of Contents

- [What This Package Does](#what-this-package-does)
- [How Agents Work](#how-agents-work)
- [Sending and Receiving Email](#sending-and-receiving-email)
- [Real-Time Inbox Watching](#real-time-inbox-watching)
- [Internet Email (Gateway)](#internet-email-gateway)
- [Keeping Things Safe](#keeping-things-safe)
- [Email Approval Workflow](#email-approval-workflow)
- [Spam Protection](#spam-protection)
- [Email Sanitization](#email-sanitization)
- [Search](#search)
- [Data Storage](#data-storage)
- [Setup and Dependencies](#setup-and-dependencies)
- [License](#license)

---

## What This Package Does

AgenticMail Core provides 15 major components organized into modules:

### Agent Management
- **AccountManager** — Creates, lists, finds, and deletes AI agent accounts. Each agent gets their own email address, login credentials, and a unique API key. Agent names must be email-safe (letters, numbers, dots, hyphens, underscores only).
- **AgentDeletionService** — When you delete an agent, this service first archives every email from their inbox, sent folder, and any custom folders into a JSON file and a database record. It produces a detailed deletion report with statistics: total emails archived, date range, top correspondents, and which folders had messages. The report is saved to `~/.agenticmail/deletions/` and the database. At least one agent must always exist — the system prevents deleting the last one.

### Email Operations
- **MailSender** — Sends email through the local Stalwart mail server using SMTP. Supports plain text bodies, HTML bodies, file attachments, CC/BCC recipients, reply-to addresses, and proper email threading headers (In-Reply-To and References) so replies show up correctly in email clients. You can also set a display name that appears in the "From" field (e.g., "Research Assistant" instead of just the email address). Every sent email returns the raw RFC822 message bytes so it can be copied to the Sent folder.
- **MailReceiver** — Reads email from the local Stalwart mail server using IMAP. Can list messages (newest first, with pagination), fetch the full content of a specific email, search by sender/subject/body/date/read-status, move messages between folders, create new folders, mark messages as read or unread, delete messages, and fetch multiple messages at once. Tracks connection state carefully and guards against stale connections.
- **parseEmail** — Takes a raw email (the RFC822 format that mail servers use internally) and turns it into a structured object with separate fields for subject, sender, recipients, body text, HTML, attachments, and headers. Handles relay emails specially — when an email was forwarded through Gmail/Outlook relay, it detects the `X-Original-From` header and uses the real external sender address instead of the local `@localhost` address.

### Inbox Monitoring
- **InboxWatcher** — Monitors an agent's inbox in real time using IMAP IDLE (a protocol feature where the mail server pushes notifications instead of the client polling). When a new email arrives, it fires a "new" event with the parsed email content. When an email is deleted, it fires an "expunge" event. When flags change (like read/unread status), it fires a "flags" event. The watcher creates a fresh IMAP connection each time it starts and holds a mailbox lock for the duration, which is required for IMAP IDLE to work.

### Internet Email Gateway
- **GatewayManager** — The central orchestrator for sending and receiving real internet email (not just local agent-to-agent email). Supports two modes: relay mode (uses your existing Gmail or Outlook as a middleman) and domain mode (your own domain with Cloudflare handling DNS, tunnels, and email routing). Automatically figures out whether an email is going to another local agent or to the outside world, and routes it through the right path. Handles inbound email delivery from relay polling or the Cloudflare webhook, runs spam filtering on incoming messages, and manages the blocked email approval workflow (including detecting when the owner replies "approve" or "reject" to the notification email).
- **RelayGateway** — Handles the Gmail/Outlook relay mode specifically. For outbound email, it sends through Gmail/Outlook SMTP using sub-addressing (e.g., `you+agentname@gmail.com`) so replies route back to the right agent. For inbound email, it polls the Gmail/Outlook IMAP account every 30 seconds looking for new messages. Uses exponential backoff on failures (30 seconds → 1 minute → 2 minutes, capping at 5 minutes) and never permanently stops polling — it always reschedules. On the first poll, it scans the 50 most recent messages; after that, it only looks at new arrivals. Tracks which messages have been delivered to prevent duplicates.
- **CloudflareClient** — API client for Cloudflare services. Can manage DNS zones, create/delete DNS records, create and manage Cloudflare Tunnels, deploy Cloudflare Workers (the Email Worker that receives inbound email), enable/disable Email Routing, set catch-all rules, search for available domains, and check domain registration status.
- **TunnelManager** — Manages the Cloudflare Tunnel lifecycle. Downloads the `cloudflared` binary if needed (platform-specific for macOS and Linux, both ARM and Intel), creates tunnels via the Cloudflare API, starts the tunnel process, configures ingress rules (routing web traffic to the API server and email traffic to Stalwart), and stops tunnels cleanly. The tunnel token is passed via environment variable rather than command-line argument so it doesn't show up in process listings.
- **DNSConfigurator** — Automatically creates all the DNS records needed for email to work on a custom domain: MX records (for receiving), SPF record (proving you're authorized to send), DKIM TXT record (cryptographic signature verification), and DMARC record (policy for handling authentication failures). Also creates CNAME records for the Cloudflare Tunnel. Before making changes, it detects and removes conflicting records, but preserves Cloudflare Email Routing's own managed MX records. Can detect the server's public IP address automatically.
- **DomainPurchaser** — Searches for available domain names across multiple TLDs (.com, .net, .io, .dev) and checks availability. Note that Cloudflare's API doesn't support programmatic domain purchase with API tokens, so actual purchases must be done through the Cloudflare dashboard or another registrar.
- **RelayBridge** — A small local HTTP-to-SMTP bridge that runs on localhost. Used in domain mode so that Cloudflare Workers (which can't connect to SMTP ports directly) can submit outbound email through an HTTP endpoint that then relays it to Stalwart for DKIM signing and delivery.

### Mail Server Administration
- **StalwartAdmin** — Admin API client for the Stalwart mail server. Creates and manages user accounts (called "principals"), manages domains, generates DKIM signing keys, sets the server hostname (important for email deliverability), configures outbound relay through Gmail SMTP (for domain mode when your server's IP doesn't have a PTR record), and performs health checks. Can restart the Stalwart Docker container when configuration changes require it.

### Security
- **scanOutboundEmail** — Scans every outgoing email before it's sent, looking for sensitive data that an AI agent shouldn't be leaking. Detects API keys (AWS, OpenAI, GitHub, Stripe, and many more), passwords, private keys (SSH, PGP, RSA), personally identifiable information (Social Security numbers, credit card numbers, bank account numbers, passport numbers, dates of birth, driver's licenses), database connection strings, JWT tokens, cryptocurrency wallet addresses, webhook URLs, environment variable blocks, and more. Also checks attachment filenames for risky file types. If any high-severity match is found, the email is blocked. Emails between local agents (`@localhost` recipients) skip scanning entirely.
- **sanitizeEmail** — Cleans up incoming email HTML to remove hidden content that could be used for prompt injection or phishing. Strips invisible Unicode characters (tag characters, zero-width joiners, bidirectional controls, soft hyphens), removes hidden HTML elements (display:none, visibility:hidden, font-size:0, white-on-white text, off-screen positioned elements, hidden iframes), removes script tags, strips data: and javascript: URIs, and removes suspicious HTML comments that contain words like "ignore", "system", "instruction", or "prompt". Returns both the cleaned content and a list of everything it found and removed.
- **scoreEmail** — Scores incoming email for spam and threat indicators using 47 pattern-matching rules across 9 categories. Returns a numeric score (0-100), whether it's classified as spam (score 40+) or a warning (score 20-39), the top threat category, and a list of every rule that matched with its score contribution.
- **isInternalEmail** — Detects whether an email is from another local agent (agent-to-agent communication on `@localhost`). Importantly, it recognizes relay emails — if the "from" address is `@localhost` but the reply-to address is external, it's a forwarded relay email and should be treated as external, not internal.
- **buildInboundSecurityAdvisory** — Analyzes incoming email attachments and spam matches to build a structured security advisory with risk levels (critical, high, medium) for attachments, double-extension detection (like `invoice.pdf.exe`), and link warnings.

### Storage
- **getDatabase** — Opens (or returns the existing) SQLite database with WAL mode enabled for better concurrent access. Automatically runs all pending migrations on first access. The database stores agent accounts, gateway configuration, pending blocked emails, delivered message tracking (for deduplication), spam logs, contacts, drafts, signatures, templates, scheduled emails, tags, email rules, agent tasks, and deletion reports.
- **EmailSearchIndex** — Full-text email search using SQLite FTS5. Indexes emails by agent, subject, sender, recipient, and body text. Search queries are run as phrase searches with FTS5 ranking for relevance ordering.

### Setup
- **SetupManager** — Handles first-time setup: checks if Docker, Stalwart, and cloudflared are installed, generates configuration files (docker-compose.yml, stalwart.toml, config.json, .env), creates the data directory, and initializes the database.
- **DependencyChecker** — Checks whether Docker, Stalwart (the Docker container), and cloudflared are installed and running. Returns version information for each.
- **DependencyInstaller** — Auto-installs missing dependencies. Installs Docker via Homebrew on macOS or the official script on Linux, starts the Stalwart container via docker-compose, and downloads the cloudflared binary from GitHub releases.

---

## How Agents Work

Every AI agent in AgenticMail is a real email user account on the Stalwart mail server. When you create an agent, the system:

1. Validates the agent name (must be letters, numbers, dots, hyphens, or underscores)
2. Generates a unique API key (starts with `ak_`, 48 random hex characters)
3. Generates a random password for SMTP/IMAP authentication
4. Creates a Stalwart mail server account (called a "principal") with the agent's email address
5. Stores everything in the SQLite database

Each agent has:
- A **name** (like "secretary" or "researcher") that's unique across the system
- An **email address** (like `secretary@localhost`, or `secretary@yourdomain.com` in domain mode)
- An **API key** for authenticating with the REST API
- A **role** (secretary, assistant, researcher, writer, or custom)
- **Metadata** — a flexible JSON field for storing anything (owner name, department, custom settings). Internal fields starting with `_` (like `_password` and `_gateway`) are protected and can't be overwritten by users.

Available roles: `secretary`, `assistant`, `researcher`, `writer`, `custom`

Agent names are lowercased when creating the Stalwart principal to match Stalwart's behavior.

---

## Sending and Receiving Email

### Sending

The MailSender connects to Stalwart via SMTP (port 587 by default) and can send emails with:
- Plain text and/or HTML bodies
- File attachments (with filename, content buffer, and MIME type)
- CC and BCC recipients (single address or array)
- Reply-To address
- Threading headers (In-Reply-To and References) for proper email thread display
- Custom display name in the From header
- Custom SMTP headers

Connection timeouts are set to 10 seconds for initial connection and greeting, and 15 seconds for socket operations. TLS certificate verification is disabled for local development (the local Stalwart server uses self-signed certificates).

### Receiving

The MailReceiver connects to Stalwart via IMAP (port 143 by default) and provides:
- **List messages** — Returns email envelopes (UID, sender, recipients, subject, date, flags, size) with pagination. Default: 20 messages, max: 1000. Returns newest first.
- **Fetch full message** — Downloads the complete RFC822 email content for a specific message by UID.
- **Search** — Filter by sender, recipient, subject, body text, date range (since/before), and read/unread status.
- **Move messages** — Between folders (e.g., INBOX to Archive).
- **Mark read/unread** — Set or remove the IMAP \Seen flag.
- **Delete messages** — Mark for deletion.
- **Create folders** — Create new IMAP mailbox folders.
- **List folders** — Get all folders with their special-use attributes (Sent, Drafts, Trash, etc.) and flags.
- **Batch operations** — Mark multiple messages as read, unread, or deleted, or move multiple messages at once.
- **Fetch multiple** — Download several messages at once by UID list.
- **Append message** — Add a raw RFC822 message to a folder (used for copying sent emails to the Sent folder).

The receiver tracks its connection state and provides a `usable` property that checks both the connection flag and the underlying ImapFlow client's internal state, preventing operations on stale connections.

---

## Real-Time Inbox Watching

The InboxWatcher uses IMAP IDLE to receive push notifications from the mail server when the inbox changes. This is much more efficient than polling — the server tells the watcher immediately when something happens.

Events emitted:
- **new** — A new email arrived. If `autoFetch` is enabled (default), the event includes the fully parsed email content. Otherwise, it just includes the UID.
- **expunge** — An email was deleted. Includes the IMAP sequence number.
- **flags** — An email's flags changed (e.g., marked as read). Includes the UID and new flag set.
- **error** — Something went wrong with the IMAP connection.
- **close** — The IMAP connection was closed.

The watcher holds a mailbox lock for the entire time it's running, which is necessary for IMAP IDLE to work. It creates a new IMAP connection each time `start()` is called because ImapFlow clients can't be reused after logout.

---

## Internet Email (Gateway)

By default, agents can only email each other within the local Stalwart server. The gateway system adds the ability to send and receive real internet email through two modes:

### Relay Mode

Uses your existing Gmail or Outlook account as a middleman. This is the easiest way to get started — you don't need to buy a domain or configure DNS.

**How outbound works:** When an agent sends to an external address, the email goes through Gmail/Outlook SMTP. The "from" address uses sub-addressing: `you+agentname@gmail.com`. This way, replies automatically route back to the right agent.

**How inbound works:** The RelayGateway polls your Gmail/Outlook IMAP account every 30 seconds, looking for new messages. When it finds one addressed to `you+agentname@gmail.com`, it delivers it to that agent's local Stalwart mailbox. The first poll scans the 50 most recent messages; subsequent polls only check for new arrivals.

**Reliability:** If polling fails (network issue, auth problem, etc.), the system uses exponential backoff: 30 seconds → 1 minute → 2 minutes → 4 minutes, capping at 5 minutes between attempts. It never permanently stops — polling always reschedules. Every 5 consecutive failures, it logs detailed connection information for debugging. Each poll has a 30-second connection timeout to prevent hung connections.

**Agent routing:** When an inbound email arrives, the system figures out which agent it belongs to by checking (in order): sub-address in the To/CC/Delivered-To headers, In-Reply-To header matched against tracked sent messages, References header chain, or falls back to the default agent.

**Deduplication:** The system tracks delivered messages by (message_id, agent_name) to prevent the same email from being delivered twice. Sent message tracking keeps up to 10,000 entries in memory for reply routing.

### Domain Mode

Full custom domain through Cloudflare. Agents send from `agent@yourdomain.com` with proper email authentication (DKIM, SPF, DMARC).

**What gets set up automatically:**
1. Cloudflare DNS zone for the domain
2. Existing DNS records backed up to `~/.agenticmail/dns-backup-{domain}-{timestamp}.json`
3. Cloudflare Tunnel created (or reused if one with the same name exists)
4. Stalwart hostname set to the domain (critical for SMTP EHLO greeting)
5. DKIM signing key generated in Stalwart (selector: `agenticmail`)
6. DNS records configured: MX (via Email Routing), SPF, DMARC, DKIM TXT, tunnel CNAME
7. Tunnel started with ingress rules routing traffic to the API server (port 3100) and Stalwart (port 8080)
8. Cloudflare Email Routing enabled on the zone
9. Email Worker deployed — catches all inbound email, base64-encodes the raw RFC822 content, and POSTs it to the AgenticMail inbound webhook with a shared secret
10. Catch-all Email Routing rule set to route all `*@domain` to the Worker
11. Domain principal created in Stalwart
12. `@domain` email aliases added to all existing agent accounts
13. Configuration saved to the database
14. Optional: Gmail SMTP configured as outbound relay in Stalwart (for servers without PTR records)

**Outbound email flow:** The GatewayManager rewrites `@localhost` addresses to `@yourdomain.com`, then submits to local Stalwart via SMTP. Stalwart signs with DKIM and delivers directly to the recipient's mail server (or through the optional Gmail relay).

**Inbound email flow:** External email → Cloudflare Email Routing → catch-all rule → Email Worker → base64 encode → POST to `/api/agenticmail/mail/inbound` → parse, spam filter, deliver to agent's mailbox → InboxWatcher fires SSE event.

---

## Keeping Things Safe

### Outbound Guard

Every outgoing email is scanned before sending. The guard looks for 34+ types of sensitive data patterns across 5 categories:

**Personally Identifiable Information (PII)**
- Social Security numbers (with dashes, dots, spaces, or in "SSN: 123456789" format)
- Credit card numbers (with or without separators)
- Bank routing and account numbers
- Driver's license numbers
- Dates of birth (multiple formats: MM/DD/YYYY, "born on Jan 15, 1990", etc.)
- Passport numbers
- Tax IDs and EINs
- ITINs (Individual Taxpayer Identification Numbers)
- Medicare/Medicaid/health insurance IDs
- Immigration A-numbers
- PIN codes
- Security question answers and mother's maiden name

**Credentials**
- API keys (generic `sk_`, `pk_`, `api_key_` patterns, plus OpenAI `sk-proj-` format)
- AWS access keys (AKIA prefix + 16 characters)
- Passwords (including leet-speak variants like `p4ssw0rd`)
- Private keys (RSA, EC, DSA, OpenSSH PEM blocks)
- Bearer tokens
- Database connection strings (MongoDB, PostgreSQL, MySQL, Redis, AMQP URIs)
- GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_ prefixes)
- Stripe API keys (sk_live_, pk_live_, etc.)
- JWT tokens (eyJ... pattern)
- Webhook URLs (Slack, Discord, webhook.site)
- Environment variable blocks (3+ consecutive KEY=value lines)
- Cryptocurrency seed/recovery phrases
- 2FA backup codes
- Username + password pairs
- OAuth access/refresh tokens
- VPN credentials

**Financial Information**
- IBAN numbers
- SWIFT/BIC codes
- Cryptocurrency wallet addresses (Bitcoin, Ethereum)
- Wire transfer instructions (with routing/account details)

**System Internals**
- Private IP addresses (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
- Local file paths (/Users/, /home/, /etc/, C:\Users\, etc.)
- Environment variable assignments with sensitive suffixes (_URL, _KEY, _SECRET, _TOKEN, _PASSWORD, _HOST, _PORT, _DSN)

**Owner Privacy**
- Revealing the owner's personal info ("my owner's name/address/phone")
- Agent revealing operator details ("the person who runs me lives...")

**Attachment Scanning**
- High-risk extensions immediately flagged: .pem, .key, .p12, .pfx, .env, .credentials, .keystore, .jks, .p8
- Medium-risk extensions: .db, .sqlite, .sql, .csv, .json, .yml, .yaml, .conf, .config, .ini
- Text-scannable attachments (.txt, .csv, .json, .xml, .yaml, .md, .log, .env, .conf, .sql, .js, .ts, .py, .sh, .html, etc.) have their content scanned through all the same text rules

**How blocking works:** If any HIGH-severity match is found, the email is blocked entirely. The scan result includes the blocked flag, all warnings with their severity and category, and a match preview (up to 80 characters of the detected text). Medium-severity warnings don't block but are reported.

**Internal emails skip scanning:** If every recipient is `@localhost` (agent-to-agent communication), the entire scan is skipped — agents need to communicate freely with each other.

**HTML evasion prevention:** The guard strips all HTML tags and decodes HTML entities (including numeric entities like `&#65;`) before scanning, so tricks like inserting `<b>` tags in the middle of an API key (`AKI<b>A</b>IOSFODNN7EXAMPLE`) don't work.

---

## Email Approval Workflow

When the outbound guard blocks an email, here's what happens:

1. **Email is held** — The blocked email, along with all its warnings and a summary, is saved to the `pending_outbound` database table with a status of "pending".

2. **Owner is notified** — If a relay gateway is configured, the owner receives a notification email at their relay address (e.g., their Gmail). This notification includes:
   - The agent's name and the subject line
   - All security warnings with severity, rule ID, and description
   - The full email content for review (complete headers: From, To, CC, BCC, Subject, Attachments, plus the full body text)
   - The pending ID for reference
   - Instructions: "Reply 'approve' to send it, or 'reject' to discard it"

3. **Owner can approve by replying** — The system stores the notification email's Message-ID. When the relay gateway polls for new mail and finds a reply to that notification, it extracts the first meaningful line of the reply (ignoring quoted text starting with `>`) and matches it against approval patterns:
   - **Approve:** "approve", "approved", "yes", "send", "go ahead", "lgtm", "ok"
   - **Reject:** "reject", "rejected", "no", "deny", "don't send", "cancel", "block"

   If the owner replies "yes" or "approve", the system retrieves the blocked email from the database, sends it through the normal outbound path, marks the pending record as "approved" with `resolved_by: 'owner-reply'`, and sends the owner a confirmation email. If rejected, the record is marked as "rejected" and the owner gets a confirmation.

4. **Owner can approve via API** — The owner can also use the master key to call `POST /mail/pending/:id/approve` or `POST /mail/pending/:id/reject` through the API. Only the master key works — agent API keys are rejected with a 403 error.

5. **Agents cannot self-approve** — This is enforced at multiple levels:
   - The API endpoints require the master key
   - The MCP server rejects approve/reject actions with a message directing the agent to inform their owner
   - The OpenClaw plugin does the same
   - The OpenClaw system prompt explicitly instructs agents to never try to approve their own emails or rewrite them to avoid detection

6. **Agents can check status** — Agents can list and view their own pending emails to see if the owner has approved or rejected them. When using the master key, all pending emails across all agents are visible.

---

## Spam Protection

Incoming emails are scored against 47 pattern-matching rules across 9 threat categories. Each rule has a point value, and points are added up to get a total score.

**Scoring thresholds:**
- Score 0-19: Clean, no action taken
- Score 20-39: Warning flag added, email delivered normally
- Score 40+: Classified as spam, moved to Spam folder

**Internal emails are exempt:** Emails between agents (`@localhost`) skip spam filtering entirely. The system also detects relay-rewritten emails — if the "from" shows `@localhost` but the reply-to is external, it's treated as an external email and gets scored.

### Threat Categories and Rules

**Prompt Injection (10 rules, 10-25 points each)**
Detects attempts to manipulate AI agents through email content:
- "Ignore previous instructions" / "ignore prior rules" (25 pts)
- "You are now a..." roleplay injection (25 pts)
- LLM delimiters: [SYSTEM], [INST], <<SYS>>, <|im_start|> (20 pts)
- "New instructions:" / "override instructions:" (20 pts)
- "Act as" / "pretend to be" (15 pts)
- "Do not mention/tell/reveal" suppression (15 pts)
- Invisible Unicode: tag characters (U+E0001-E007F), dense zero-width characters (20 pts)
- "DAN", "jailbreak", "bypass safety/filter" (20 pts)
- Long base64 blocks (100+ characters) that could hide instructions (15 pts)
- Code block injection: ```system, ```python exec (10 pts)

**Social Engineering (7 rules, 10-20 points each)**
- "Your owner/admin asked/told/wants you to..." impersonation (20 pts)
- "Share your API key/password/secret" (15 pts)
- "This is a system/security automated message" (15 pts)
- Urgency language combined with authority/threat language (10 pts)
- "Send me $X", "wire transfer", "Western Union" (15 pts)
- "Buy me gift cards", iTunes/Google Play cards (20 pts)
- CEO/CFO fraud: executive title + payment/wire/urgent (15 pts)

**Data Exfiltration (5 rules, 15-20 points each)**
- "Forward all/every emails" (20 pts)
- "Search inbox for password" / "find credentials" (20 pts)
- "Send the/all/every ... to external@email.com" (15 pts)
- "Reveal system prompt" / "dump instructions" (15 pts)
- Webhook/ngrok/pipedream/requestbin URLs (15 pts)

**Phishing (8 rules, 3-15 points each)**
- Sender name contains brand (Google, Microsoft, Apple, Amazon, PayPal, Meta, Netflix, Bank) but domain doesn't match (10 pts)
- "Verify your account/password" with links present (15 pts)
- Links with IP addresses, URL shorteners (bit.ly, t.co, etc.), or excessive subdomains (10 pts)
- data:text/html or javascript: URIs in links (15 pts)
- Punycode domains (xn--) or mixed Cyrillic+Latin scripts in sender domain (15 pts)
- Link text shows one URL but href points to a different domain (10 pts)
- "Click here/sign in" combined with urgency (expire/suspend/locked) (10 pts)
- 5+ unique links but no List-Unsubscribe header (3 pts)

**Authentication (4 rules, 3-20 points each)**
- SPF authentication failed (15 pts)
- DKIM authentication failed (15 pts)
- DMARC authentication failed (20 pts)
- No Authentication-Results header at all (3 pts)

**Attachment Risk (4 rules, 10-25 points each)**
- Executable files: .exe, .bat, .cmd, .ps1, .sh, .dll, .scr, .vbs, .js, .msi, .com (25 pts)
- Double extensions: document.pdf.exe (20 pts)
- Archive files: .zip, .rar, .7z, .tar.gz (15 pts)
- HTML/SVG attachments (10 pts)

**Header Anomalies (3 rules, 5-10 points each)**
- Missing Message-ID header (5 pts)
- Empty or missing From address (10 pts)
- Reply-To domain differs from From domain (5 pts)

**Content Spam (7 rules, 3-25 points each)**
- Subject >80% uppercase (min 10 chars) (5 pts)
- Lottery/prize language, "Nigerian prince" (25 pts)
- Crypto investment scams, "guaranteed returns" (10 pts)
- 4+ exclamation marks or question marks in subject (3 pts)
- Pharmacy spam: Viagra, Cialis, "online pharmacy" (15 pts)
- Weight loss scams: "diet pill", "lose 30 lbs" (10 pts)
- HTML-only email with no plain text (5 pts)
- High density of spam words (congratulations, winner, prize, claim, free, limited time, act now, click here, etc.) — 10 pts if >5 words, 20 pts if >10 words

**Link Analysis (1 rule, 5 points)**
- 10+ unique links in one email (5 pts)

Each rule is wrapped in error handling so a failure in one rule doesn't crash the entire spam filter.

---

## Email Sanitization

Before showing email content to an AI agent, the sanitizer cleans it to remove hidden content that could manipulate the agent or trick it into taking harmful actions.

**Invisible Unicode removal:**
- Tag characters (U+E0001-E007F) — invisible characters that could encode hidden messages
- Zero-width characters (U+200B, U+200C, U+200D, U+FEFF) — invisible when 3+ appear together
- Bidirectional control characters (U+202A-202E, U+2066-2069) — can make text display in a different order than it actually is
- Soft hyphens (U+00AD) — invisible in most contexts
- Word joiners (U+2060) — invisible spacing control

**Hidden HTML removal:**
- Elements styled with `display:none`, `visibility:hidden`, `font-size:0`, or `opacity:0`
- White-on-white text (same foreground and background color)
- Elements positioned off-screen with extreme negative coordinates (left:-9999px, etc.)
- Script tags and their contents
- `data:text/html` and `javascript:` URIs in src, href, or action attributes
- HTML comments containing suspicious words: "ignore", "system", "instruction", "prompt", "inject"
- Hidden iframes (width=0, height=0, or display:none)

The sanitizer returns both the cleaned content and a detailed list of every detection it made (type, description, count), along with a flag indicating whether any changes were made.

---

## Search

The EmailSearchIndex provides full-text search across all indexed emails using SQLite FTS5.

Emails are indexed by: agent ID, message ID, subject, sender address, recipient address, body text, and received date.

Search queries are automatically wrapped in quotes for phrase matching and sanitized to prevent FTS5 injection. Results are ranked by relevance using FTS5's built-in ranking algorithm. If a search query has invalid syntax, it returns an empty result set rather than throwing an error.

Limits: minimum 1 result, maximum 1000 results per query (default 20).

---

## Data Storage

AgenticMail uses a SQLite database with WAL mode (Write-Ahead Logging) for better concurrent access and foreign keys enabled for referential integrity. The database is initialized with automatic migrations that run on first access.

**Database location:** `~/.agenticmail/agenticmail.db`

**Tables (13 migrations):**
- **agents** — Agent accounts with name, email, API key, Stalwart principal, role, metadata (JSON), creation/update timestamps, last activity timestamp, and persistent flag
- **domains** — Custom email domains with Stalwart principal, DKIM selector and public key, verification status
- **config** — Key-value configuration store (e.g., `relay_last_seen_uid` for relay polling state)
- **email_search** — FTS5 virtual table for full-text email search
- **gateway_config** — Gateway mode and configuration (JSON), single row with id='default'
- **purchased_domains** — Purchased domain records with Cloudflare zone ID, tunnel ID, DNS/tunnel status
- **delivered_messages** — Relay deduplication tracking (message_id + agent_name composite key)
- **pending_outbound** — Blocked outbound emails awaiting approval, with mail options (JSON), warnings (JSON), status (pending/approved/rejected), notification message ID (for reply matching), resolution info
- **contacts** — Per-agent address book
- **drafts** — Per-agent draft emails
- **signatures** — Per-agent email signatures (one default per agent)
- **templates** — Per-agent reusable email templates
- **scheduled_emails** — Emails scheduled for future delivery (pending/sent/error status)
- **tags** — Per-agent message tags with colors
- **message_tags** — Many-to-many relationship between tags and messages (with folder context)
- **email_rules** — Per-agent email filtering rules with conditions (JSON) and actions (JSON), priority ordering
- **agent_deletions** — Audit trail for deleted agents with full archived report (JSON), file path to backup
- **agent_tasks** — Inter-agent task assignments with type, payload (JSON), status (pending/claimed/completed/failed), result, timestamps
- **spam_log** — Spam scoring history per agent per message

---

## Setup and Dependencies

The SetupManager handles getting everything installed and configured for the first time:

**Dependency checking:**
- Docker — checks `docker --version` for version
- Stalwart — checks `docker ps` for the `agenticmail-stalwart` container
- cloudflared — checks managed binary at `~/.agenticmail/bin/cloudflared` or system-wide via `which`

**Automatic installation:**
- Docker: via Homebrew (`brew install --cask docker`) on macOS, or the official install script on Linux. Opens Docker Desktop on macOS and waits up to 60 seconds for the daemon to start.
- Stalwart: starts the container via `docker compose up -d` and waits up to 30 seconds for it to be running.
- cloudflared: downloads the platform-specific binary from GitHub releases (supports macOS ARM/Intel and Linux ARM/Intel). Installs atomically (write to temp file, chmod, rename) at `~/.agenticmail/bin/cloudflared`.

**Configuration generation:**
- `docker-compose.yml` — Stalwart service with ports 8080 (HTTP admin), 587 (SMTP submission), 143 (IMAP), 25 (SMTP inbound)
- `stalwart.toml` — Stalwart configuration with RocksDB storage, internal directory, stdout logging, and fallback admin credentials
- `config.json` — Master key, Stalwart URL/credentials, SMTP/IMAP host/port, API host/port, data directory (written with mode 0600 for security)
- `.env` — Environment variables (written with mode 0600)

Configuration files are placed in the data directory (default: `~/.agenticmail/`). Calling `initConfig()` is idempotent — it loads existing config if present, but always regenerates Docker files to keep passwords in sync.

---

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/ope-olatunji))
