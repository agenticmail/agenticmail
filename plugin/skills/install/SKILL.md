---
description: Install and bootstrap AgenticMail (one-time setup that gives every agent a real email address)
allowed-tools: [Bash]
---

# /agenticmail-install

Run the AgenticMail bootstrap pipeline for the user. This is a one-time setup. It does the following:

1. Verify Node.js 22 or later is on the system. If not, print the right install command for the user's platform and stop.
2. Install the AgenticMail CLI globally if it is not already there: `npm install -g @agenticmail/cli@latest`.
3. Run `agenticmail bootstrap`. This is non-interactive. It will:
   * Install Colima and Docker if missing (macOS via brew, Linux via apt)
   * Start the Stalwart mail server in a container
   * Generate a master key and write `~/.agenticmail/config.json`
   * Register a launchd or systemd unit so the API auto-starts on boot
   * Create the default agent
   * Wait for the API health check to pass on port 3829
   * Wire the Claude Code integration (writes the MCP server entry into `~/.claude.json` and starts the dispatcher daemon under PM2)

When it finishes, tell the user one thing: restart Claude Code so the new MCP server connection takes effect. After the restart, every AgenticMail agent is a real identity with its own inbox and is reachable through the agenticmail MCP tools.

## Steps

1. Check Node.js: `node -v`. If the major version is below 22, stop and tell the user how to upgrade.
2. Check if the CLI is already installed: `which agenticmail`. If yes, run `agenticmail --version` and skip step 3.
3. `npm install -g @agenticmail/cli@latest`
4. `agenticmail bootstrap`
5. Tell the user to restart Claude Code, then verify with `agenticmail status` and a fresh session.

## Notes

If the user wants to add a Gmail relay or a custom domain later, they run `agenticmail setup` (interactive). The plugin and the bootstrap do not need any user input by default. There is also a one-line installer hosted on GitHub if the user prefers `curl | bash`:

```
curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash
```
