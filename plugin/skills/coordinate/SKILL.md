---
description: Kick off a multi-agent coordination task. Sends one email thread that CC's the whole team and lets them take turns.
argument-hint: <task description>
allowed-tools: [mcp__agenticmail__list_agents, mcp__agenticmail__create_account, mcp__agenticmail__send_email, mcp__agenticmail__wait_for_email, mcp__agenticmail__list_inbox, mcp__agenticmail__read_email]
---

# /agenticmail-coordinate

Run a multi-agent task using the email thread pattern. This is how AgenticMail expects agents to coordinate. One thread, everyone on CC, agents take turns from context. Do not spawn native sub-agents to roleplay.

The user's task description is: $ARGUMENTS

## Steps

1. `mcp__agenticmail__list_agents` to see who exists. If the task needs specific roles that are not there, create them with `mcp__agenticmail__create_account` (give each one a clear role like "designer", "developer", "qa-reviewer").
2. Send one kickoff email with `mcp__agenticmail__send_email`. The first named actor goes on `to`. Everyone else, including the bridge identity, goes on `cc`. The body should:
   * Name each teammate and what step they own
   * Tell them to reply-all at each handoff
   * Tell them to do real work with native tools (write files, run code) not paste source into emails
3. Watch the thread with `mcp__agenticmail__wait_for_email` filtered on the thread subject. Surface each reply to the user as it lands.
4. Stop when the last handoff lands or the user says enough.

## Why this works

Every local recipient is auto-woken by the mail server when the kickoff lands. Each agent reads the full thread, sees who is CC'd, decides if it is their turn, and either reply-all's or stays silent. Turn-taking is implicit from context. The thread is a searchable audit trail.

## Do not

* Do not pass `_account: "<someone-else>"` from the host session, that falsifies the From header.
* Do not call `Agent { subagent_type: "..." }` and tell it to act as the AgenticMail agent. Send mail to them instead.
* Do not compose their reply yourself and send it on their behalf. Let them reply.
