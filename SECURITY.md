# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in AgenticMail, please report it
responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

### How to Report

Open a **private security advisory** on GitHub:
[https://github.com/agenticmail/agenticmail/security/advisories/new](https://github.com/agenticmail/agenticmail/security/advisories/new)

Or contact the maintainer directly via [GitHub](https://github.com/ope-olatunji).

Include the following in your report:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix for critical issues | Within 30 days |
| Fix for non-critical issues | Within 90 days |

### What to Expect

1. You will receive an acknowledgment within 48 hours
2. We will investigate and provide an initial assessment
3. We will work on a fix and coordinate disclosure with you
4. Credit will be given to reporters (unless anonymity is preferred)

## Security Architecture

### Authentication

- **Master key** — full administrative access to the API
- **Agent API keys** — scoped per-agent access
- **Inbound webhook secret** — authenticates Cloudflare Email Worker requests

### Email Security

- **Outbound guard** — blocks emails containing sensitive data patterns (API keys,
  credentials, PII) and requires human approval before sending
- **Spam filter** — scores inbound emails and blocks spam before delivery
- **DKIM signing** — domain mode emails are signed for authenticity
- **SPF/DMARC** — DNS records configured automatically in domain mode

### Data Protection

- Agent passwords are stored in the local SQLite database
- The database file should have restricted file permissions (0600)
- Cloudflare API tokens are stored in the gateway configuration
- The `.agenticmail/` directory contains sensitive configuration and should not
  be committed to version control

### Network

- Stalwart mail server runs locally (Docker)
- API server binds to `127.0.0.1` by default
- Cloudflare Tunnel provides secure ingress without exposing ports
- IMAP/SMTP connections use TLS where available

## Best Practices for Operators

1. **Use strong master keys** — generate with `openssl rand -hex 32`
2. **Restrict file permissions** on `.agenticmail/` and `.env` files
3. **Keep dependencies updated** — run `npm audit` regularly
4. **Use domain mode with DKIM** for production email sending
5. **Configure the outbound guard** to prevent AI agents from leaking sensitive data
6. **Monitor spam logs** for false positives and adjust thresholds as needed
