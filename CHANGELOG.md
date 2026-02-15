# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.26] - 2026-02-15

### Added

- **Domain mode** — full Cloudflare integration for custom domain email
  - Automatic DNS configuration (MX, SPF, DKIM, DMARC, tunnel CNAME)
  - Cloudflare Tunnel for secure inbound traffic
  - Email Worker deployment for Cloudflare Email Routing
  - Catch-all routing rule to forward all domain email to AgenticMail
  - DKIM signing via Stalwart
  - Gmail SMTP outbound relay option for residential IPs
  - Automatic @domain email alias addition for existing agents
  - DNS backup before modifications
- **Domain purchase** — search and buy domains via Cloudflare Registrar
- **Outbound guard** — blocks emails containing sensitive data (API keys, PII)
  and requires human (master key) approval
- **Owner approval via email reply** — reply "approve" or "reject" to notification
  emails to process blocked outbound emails
- **Spam filter** — rule-based scoring engine for inbound emails
  - Configurable threshold (default: 40)
  - Categories: phishing, scam, malware, commercial spam, social engineering
  - Runs on both relay inbound and SSE event streams
  - Skips internal agent-to-agent emails
- **Email rules** — per-agent filtering rules (move, delete, mark read)
- **Inbound webhook** — `POST /mail/inbound` endpoint for Cloudflare Email Workers
- **Gateway API routes** — setup, status, DNS, tunnel management
- **MCP tools** — domain setup, relay setup, gateway status, test email, domain purchase
- **OpenClaw tools** — matching set of gateway management tools
- **Shell commands** — `/spam`, `/rules`, `/pending`, `/digest`, `/relay`
- **Inbox enhancements** — body previews, arrow key navigation, unread markers, preview toggle
- **Retry logic** — 3-attempt retry on all interactive shell inputs

### Changed

- Spam threshold lowered from 50 to 40
- Lottery scam rule score increased from 15 to 25
- `isInternalEmail()` now checks replyTo domain to detect relay-rewritten emails
- Navigation bars use `[Esc] back` instead of `[q] back`
- Separator lines added above navigation bars in inbox and folder views

### Fixed

- Relay emails incorrectly classified as internal (score 0) due to @localhost rewrite
- SSE handler now checks `X-AgenticMail-Relay` header to identify relay emails
- Agent deletion with typo in name no longer cancels immediately (3 retries)

## [0.2.0] - 2026-01-15

### Added

- Initial relay mode — Gmail/Outlook IMAP polling and SMTP relay
- Account management — create, list, delete AI agents
- Local Stalwart mail server integration
- IMAP inbox watching with SSE event streaming
- MCP server for Claude Code integration
- OpenClaw plugin with skill definitions
- Interactive CLI shell with 30+ commands
- Task system — agent-to-agent RPC with SSE + polling
- Rate limiting and authentication middleware
