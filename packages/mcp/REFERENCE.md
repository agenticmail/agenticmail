# AgenticMail MCP Server — Tool Reference

> **62 tools** available via MCP stdio transport (`@agenticmail/mcp`)

---

## Core

### `whoami`
Get the current agent\.

### `update_metadata`
Update the current agent\.

## Email Management

### `delete_email`
Delete an email by its UID.

### `mark_read`
Mark an email as read.

### `mark_unread`
Mark an email as unread.

### `list_folder`
List messages in a specific folder.

### `create_folder`
Create a new mail folder for organizing emails.

## Drafts & Templates

### `template_send`
Send an email using a saved template with variable substitution. Variables like {{name}} are replaced..

## Batch Operations

### `batch_read`
Read multiple emails at once by UIDs. Returns full parsed content for each message in a single call..

### `batch_delete`
Delete multiple emails by UIDs.

### `batch_mark_read`
Mark multiple emails as read.

### `batch_mark_unread`
Mark multiple emails as unread.

### `batch_move`
Move multiple emails to another folder.

## Agent Management

### `list_agents`
List all AI agents in the system with their email addresses and roles. Use this to discover which agents you can communicate with via message_agent..

### `create_account`
Create a new agent email account (requires master API key).

### `delete_agent`
Delete an agent account. Archives all emails and generates a deletion report before removing the account permanently.

### `deletion_reports`
List past agent deletion reports or retrieve a specific report by ID. Shows archived email summaries from deleted agents.

## Agent Coordination

### `message_agent`
Send a message to another AI agent by name. The message is delivered to their email inbox.

### `call_agent`
Synchronous RPC: assign a task to another agent, notify them via email (wakes wait_for_email), and wait for the result. Times out after specified duration..

### `check_messages`
Check for new unread messages from other agents or external senders. Returns a summary of pending communications.

### `check_tasks`
Check for pending tasks assigned to you (or a specific agent) or tasks you assigned to others.

### `claim_task`
Claim a pending task assigned to you.

### `submit_result`
Submit the result for a claimed task, marking it as completed.

### `wait_for_email`
Wait for a new email or task notification using push notifications (SSE). Blocks until an email arrives, a task is assigned to you, or timeout is reached.

## Contacts, Tags & Rules

## Security & Moderation

## Setup & Configuration

### `setup_guide`
Get a comparison of email setup modes (Relay vs Domain) with difficulty levels, requirements, pros/cons, and step-by-step instructions. Show this to users who want to set up real internet email..

### `setup_gmail_alias`
Get step-by-step instructions (with exact field values) to add an agent email as a Gmail "Send mail as" alias. Returns the Gmail settings URL and all field values.

### `setup_payment`
Get instructions for adding a payment method to Cloudflare (required before purchasing domains). Returns Option A (self-service link) and Option B (browser automation steps).

### `purchase_domain`
Search for available domains via Cloudflare Registrar (requires master API key). NOTE: Cloudflare API only supports READ access — domains must be purchased manually at https://dash.cloudflare.com or from another registrar (then point nameservers to Cloudflare)..

## SMS / Phone

### `sms_setup`
Configure SMS/phone number access via Google Voice. The user must have a Google Voice account with SMS-to-email forwarding enabled.

### `sms_send`
Send an SMS text message via Google Voice. Records the message and provides instructions for sending via Google Voice web interface.

### `sms_messages`
List SMS messages (inbound and outbound). Use direction filter to see only received or sent messages..

### `sms_check_code`
Check for recent verification/OTP codes received via SMS. Scans inbound SMS for common code patterns (6-digit, 4-digit, alphanumeric).

### `sms_read_voice`
Get instructions and URL for reading SMS directly from Google Voice web (FASTEST method). Returns the voice.google.com URL and guidance for browser-based SMS reading.

### `sms_record`
Record an SMS message read from Google Voice web or any other source. Saves to SMS database and extracts verification codes.

### `sms_parse_email`
Parse an SMS from a forwarded Google Voice email. Use this when you receive an email from Google Voice containing an SMS.

### `sms_config`
Get the current SMS/phone number configuration for this agent. Shows whether SMS is enabled, the phone number, and forwarding email..

## Database Storage

### `storage`
Full database management system for agents. 28 actions: DDL (create/alter/drop/clone/rename tables & columns), DML (insert/upsert/query/aggregate/update/delete/truncate), indexing (create/list/drop/reindex), import/export (JSON/CSV, conflict handling), raw SQL, maintenance (stats/vacuum/analyze/explain), archiving.

