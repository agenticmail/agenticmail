# AgenticMail OpenClaw Plugin — Tool Reference

> **63 tools** available via the OpenClaw plugin (`@agenticmail/openclaw`)

---

## Core

### `agenticmail_status`
Check AgenticMail server health status.

### `agenticmail_whoami`
Get the current agent\'s account info — name, email, role, and metadata.

### `agenticmail_update_metadata`
Update the current agent\'s metadata. Merges provided keys with existing metadata..

## Email Management

### `agenticmail_inbox`
List recent emails in the inbox.

### `agenticmail_read`
Read a specific email by UID. Returns sanitized content with security metadata (spam score, sanitization detections).

### `agenticmail_send`
Send an email from the agent mailbox. Outgoing emails to external recipients are scanned for PII, credentials, and sensitive content.

### `agenticmail_reply`
Reply to an email by UID. Outbound guard applies — HIGH severity content is held for review..

### `agenticmail_forward`
Forward an email to another recipient. Outbound guard applies — HIGH severity content is held for review..

### `agenticmail_search`
Search emails by criteria. By default searches local inbox only.

### `agenticmail_delete`
Delete an email by UID.

### `agenticmail_move`
Move an email to another folder.

### `agenticmail_mark_read`
Mark an email as read.

### `agenticmail_mark_unread`
Mark an email as unread.

### `agenticmail_digest`
Get a compact inbox digest with subject, sender, date, flags and a text preview for each message. Much more efficient than listing then reading emails one-by-one.

### `agenticmail_list_folder`
List messages in a specific mail folder (Sent, Drafts, Trash, etc.).

### `agenticmail_folders`
List all mail folders.

### `agenticmail_create_folder`
Create a new mail folder for organizing emails.

### `agenticmail_import_relay`
Import an email from the user\'s connected Gmail/Outlook account into the agent\'s local inbox. Downloads the full message with all thread headers so you can continue the conversation with agenticmail_reply.

## Drafts & Templates

### `agenticmail_drafts`
Manage email drafts: list, create, update, delete, or send a draft.

### `agenticmail_signatures`
Manage email signatures: list, create, or delete.

### `agenticmail_templates`
Manage email templates: list, create, or delete.

### `agenticmail_template_send`
Send an email using a saved template with variable substitution. Variables in the template like {{name}} are replaced with provided values.

### `agenticmail_schedule`
Manage scheduled emails: create a new scheduled email, list pending scheduled emails, or cancel a scheduled email..

## Batch Operations

### `agenticmail_batch_read`
Read multiple emails at once by UIDs. Returns full parsed content for each.

### `agenticmail_batch_delete`
Delete multiple emails by UIDs.

### `agenticmail_batch_mark_read`
Mark multiple emails as read.

### `agenticmail_batch_mark_unread`
Mark multiple emails as unread.

### `agenticmail_batch_move`
Move multiple emails to another folder.

## Agent Management

### `agenticmail_list_agents`
List all AI agents in the system with their email addresses and roles. Use this to discover which agents are available to communicate with via agenticmail_message_agent..

### `agenticmail_create_account`
Create a new agent email account (requires master key).

### `agenticmail_delete_agent`
Delete an agent account. Archives all emails and generates a deletion report before removing the account permanently.

### `agenticmail_deletion_reports`
List past agent deletion reports or retrieve a specific report. Shows archived email summaries from deleted agents..

### `agenticmail_cleanup`
List or remove inactive non-persistent agent accounts. Use this to clean up test/temporary agents that are no longer active.

## Agent Coordination

### `agenticmail_message_agent`
Send a message to another AI agent by name. The message is delivered to their email inbox.

### `agenticmail_call_agent`
Call another agent with a task. Supports sync (wait for result) and async (fire-and-forget) modes.

### `agenticmail_check_messages`
Check for new unread messages from other agents or external senders. Returns a summary of pending communications.

### `agenticmail_check_tasks`
Check for pending tasks assigned to you (or a specific agent), or tasks you assigned to others..

### `agenticmail_claim_task`
Claim a pending task assigned to you. Changes status from pending to claimed so you can start working on it..

### `agenticmail_submit_result`
Submit the result for a claimed task, marking it as completed..

### `agenticmail_complete_task`
Claim and submit result in one call (skip separate claim + submit). Use for light-mode tasks where you already have the answer..

### `agenticmail_wait_for_email`
Wait for a new email or task notification using push notifications (SSE). Blocks until an email arrives, a task is assigned to you, or timeout is reached.

## Contacts, Tags & Rules

### `agenticmail_contacts`
Manage contacts (list, add, delete).

### `agenticmail_tags`
Manage tags/labels: list, create, delete, tag/untag messages, get messages by tag, or get all tags for a specific message.

### `agenticmail_rules`
Manage server-side email rules that auto-process incoming messages (move, tag, mark read, delete). Rules run before you even see the email, saving tokens on manual triage..

## Security & Moderation

### `agenticmail_spam`
Manage spam: list the spam folder, report a message as spam, mark as not-spam, or get the detailed spam score of a message. Emails are auto-scored on arrival — high-scoring messages (prompt injection, phishing, scams) are moved to Spam automatically..

### `agenticmail_pending_emails`
Check the status of pending outbound emails that were blocked by the outbound guard. You can list all your pending emails or get details of a specific one.

## Setup & Configuration

### `agenticmail_setup_guide`
Get a comparison of email setup modes (Relay vs Domain) with difficulty levels, requirements, and step-by-step instructions. Show this to users who want to set up real internet email to help them choose the right mode..

### `agenticmail_setup_relay`
Configure Gmail/Outlook relay for real internet email (requires master key). BEGINNER-FRIENDLY: Just needs a Gmail/Outlook email + app password.

### `agenticmail_setup_domain`
Set up custom domain for real internet email via Cloudflare (requires master key). ADVANCED: Requires a Cloudflare account, API token, and a domain (can purchase one during setup).

### `agenticmail_setup_gmail_alias`
Get step-by-step instructions (with exact field values) to add an agent email as a Gmail "Send mail as" alias. Returns the Gmail settings URL and all field values needed.

### `agenticmail_setup_payment`
Get instructions for adding a payment method to Cloudflare (required before purchasing domains). Returns two options: (A) direct link for user to do it themselves, or (B) step-by-step browser automation instructions for the agent.

### `agenticmail_gateway_status`
Check email gateway status (relay, domain, or none).

### `agenticmail_test_email`
Send a test email through the gateway to verify configuration (requires master key).

### `agenticmail_purchase_domain`
Search for available domains via Cloudflare Registrar (requires master key). NOTE: Cloudflare API only supports READ access for registrar — domains must be purchased manually.

## SMS / Phone

### `agenticmail_sms_setup`
Configure SMS/phone number access via Google Voice. The user must have a Google Voice account with SMS-to-email forwarding enabled.

### `agenticmail_sms_send`
Send an SMS text message via Google Voice. Records the message and provides instructions for sending via Google Voice web interface.

### `agenticmail_sms_messages`
List SMS messages (inbound and outbound). Use direction filter to see only received or sent messages..

### `agenticmail_sms_check_code`
Check for recent verification/OTP codes received via SMS. Scans inbound SMS for common code patterns (6-digit, 4-digit, alphanumeric).

### `agenticmail_sms_read_voice`
Read SMS messages directly from Google Voice web interface (FASTEST method). Opens voice.google.com in the browser, reads recent messages, and returns any found SMS with verification codes extracted.

### `agenticmail_sms_record`
Record an SMS message that you read from Google Voice web or any other source. Saves it to the SMS database and extracts any verification codes.

### `agenticmail_sms_parse_email`
Parse an SMS from a forwarded Google Voice email. Use this when you receive an email from Google Voice containing an SMS.

### `agenticmail_sms_config`
Get the current SMS/phone number configuration for this agent. Shows whether SMS is enabled, the phone number, and forwarding email..

## Database Storage

### `agenticmail_storage`
Full database management for agents. Create/alter/drop tables, CRUD rows, manage indexes, run aggregations, import/export data, execute raw SQL, optimize & analyze — all on whatever database the user deployed (SQLite, Postgres, MySQL, Turso).

