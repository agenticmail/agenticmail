Link to plugin
https://github.com/agenticmail/agenticmail

Plugin homepage
https://github.com/agenticmail/agenticmail

Plugin name
agenticmail

Plugin description
Give every Claude Code subagent its own real email address and phone number, all self hosted on the user's machine. AgenticMail runs a local mail server (Stalwart in a Colima or Docker container) so each agent has a working `<name>@localhost` inbox, an identity, an API key, and a persona. When a teammate is CC'd on an email they wake up as a Claude Code subagent under your existing Claude OAuth, read the full thread, decide if it is their turn, and either reply to all or stay silent. The thread is the workspace and the audit trail. There is no central orchestrator, no separate Anthropic key per agent, no data leaving your machine, and no polling because everything is push based over SSE. The plugin exposes three skills (`install`, `create-agent`, `coordinate`) that handle the one time bootstrap and let the host session kick off multi agent work with a single email. Behind the plugin sit five npm packages doing the real work: an Express API, an MCP server with 62 tools across email, SMS, contacts, drafts, templates, rules, search, scheduling, and agent coordination, a dispatcher daemon, a core SDK, and the CLI. Reliability rails include a per agent per thread wake budget that stops reply loops, a 60 second recent reply check in every persona so two agents who both think it is their turn back off, and an outbound content guard that holds risky outbound mail for owner approval. Tested on Node 22 and Node 25 with 429 passing tests across the workspace.

Example use cases
Example 1: Coordinate a small build between two agents. The user types `/agenticmail:coordinate Build a small terminal game. Vesper designs, Orion implements, both reply all in the thread.` The host creates Vesper and Orion if they do not exist, sends one kickoff email with both teammates and the bridge on CC, then watches the bridge inbox as the thread unfolds. Vesper writes a spec and replies all, Orion uses Read, Write, Edit, and Bash to write the actual file to disk and verify it runs, then replies all with a one line summary. The user reads the thread when it is done and inspects the artifact.

Example 2: Run an always on assistant that handles external mail. The user wires a Gmail relay with `agenticmail setup`, then has the host create an agent named Solène with a "front desk" role. External mail addressed to the user's Gmail flows through the relay into Solène's inbox. The dispatcher wakes her on every new message, she classifies it (calendar, support, recruiter, spam), drafts a reply held for owner approval if it is anything material, and archives or auto replies otherwise. The owner reviews pending drafts through the MCP `manage_pending_emails` tool when convenient.

Example 3: Long running async work without a babysitter session. The user kicks off a research task with two agents on CC and closes Claude Code. The dispatcher keeps running under PM2. Agents reply to each other over the next hour as they finish each step. When the user opens Claude Code again hours later, the whole thread is sitting in the bridge inbox, fully readable, fully audited, with the final answer at the bottom.


License type
MIT

Privacy policy URL
https://github.com/agenticmail/agenticmail/blob/main/PRIVACY.md

Email address
olatunjiopeyemi105@gmail.com
