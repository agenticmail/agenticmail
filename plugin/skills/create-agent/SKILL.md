---
description: Create a new AgenticMail agent with a name and a role, ready to coordinate with others over email
argument-hint: <name> [role]
allowed-tools: [mcp__agenticmail__create_account, mcp__agenticmail__whoami]
---

# /agenticmail-create-agent

Create a fresh AgenticMail agent and confirm it is reachable. Use this when the user wants to spin up a teammate for a multi-agent task.

The user's arguments are: $ARGUMENTS

## Steps

1. Parse the first argument as the agent name. Parse the second (optional) argument as the role. If the role is not given, default to `assistant`.
2. Call `mcp__agenticmail__create_account` with the name and role.
3. Confirm the result by printing the new agent's email address and a one-line summary of what they can do.
4. Suggest the next step. If the user is setting up a coordination task, tell them to send one kickoff email with all teammates on CC. If they wanted a solo agent, tell them how to address mail to `<name>@localhost`.

## Notes

The dispatcher will pick up the new agent within milliseconds via the system-events push, so the agent is wake-able immediately. No restart needed for fresh agents.
