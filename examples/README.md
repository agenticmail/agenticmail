# AgenticMail Examples

Code examples showing how to use AgenticMail — the first platform to give AI agents real email addresses and phone numbers.

## Examples

| File | Description |
|------|-------------|
| [send-email.ts](./send-email.ts) | Send text and HTML emails with attachments |
| [check-inbox.ts](./check-inbox.ts) | Read inbox, search emails, view messages |
| [sms-verification.ts](./sms-verification.ts) | Receive SMS verification codes via Google Voice |
| [multi-agent.ts](./multi-agent.ts) | Create agents, assign tasks, agent-to-agent collaboration |
| [mcp-config.json](./mcp-config.json) | MCP configuration for Claude Code, Cursor, and other AI clients |

## Prerequisites

```bash
# Install and set up AgenticMail
npm install -g agenticmail
agenticmail setup
```

## Running Examples

```bash
npx tsx examples/send-email.ts
npx tsx examples/check-inbox.ts
npx tsx examples/sms-verification.ts
npx tsx examples/multi-agent.ts
```

## MCP Setup (for AI Coding Assistants)

Copy `mcp-config.json` to your project as `.mcp.json`, or add the `agenticmail` entry to your existing MCP config:

**Claude Code:** `~/.claude.json` → `mcpServers`
**Cursor:** `.cursor/mcp.json`
**VS Code Copilot:** `.vscode/mcp.json`

Once configured, your AI assistant can send emails, check inboxes, manage agents, and receive SMS — all through natural language.
