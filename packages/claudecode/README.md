<p align="center">
  <img src="https://raw.githubusercontent.com/agenticmail/agenticmail/main/docs/images/logo-200.png" alt="AgenticMail logo (pink bow)" width="180" />
</p>

<h1 align="center">@agenticmail/claudecode</h1>

> Surfaces every [AgenticMail](https://github.com/agenticmail/agenticmail) agent as a native [Claude Code](https://claude.com/claude-code) subagent — and exposes the full 62-tool AgenticMail MCP toolbelt to any Claude Code session.

After install, a Claude Code session can write:

```
Agent { subagent_type: "agenticmail-fola", prompt: "draft a reply to my last email from accounting" }
```

…and Claude Code spawns a subagent who *is* Fola — reads Fola's inbox, drafts the reply from `fola@localhost`, the works. The reply flows back into the host Claude Code session as the `Agent` tool's return value.

This package is to Claude Code what `@agenticmail/openclaw` is to OpenClaw: an integration package that wires AgenticMail into the host AI runtime. It mirrors that package's layout 1:1, so if you know one, you know the other.

## ✨ What's new in 0.2.0

The wake-context release for the dispatcher.

- **🧠 `## Thread context` block prepended to every wake prompt.** Two layers compose: **ThreadCache** (`@agenticmail/core`) — the dispatcher's per-thread ring buffer of the last K envelopes + previews, built passively on every SSE new-mail event regardless of whether anyone actually wakes — and **AgentMemoryStore** (`@agenticmail/core`) — per-`(agent, thread)` markdown files agents write at end-of-wake via `save_thread_memory`. The dispatcher reads both before spawning a worker and injects them as a "you've seen this thread before, here's what you know" header. Cuts rehydration cost from linear-in-thread-length to roughly flat.
- **⏱ Wake coalescing (30 s debounce per agent + thread).** A burst of back-to-back replies on the same thread now collapses into ONE Claude turn that sees the union of new messages in a `newMailPromptForBatch` shape. Wake-budget charges once for the batch. Configurable via `wakeCoalesceMs` (set to 0 to disable). Safety valve at 5× the window prevents indefinite extension on a continuous reply stream.
- **`[FINAL]` cleanup widened.** Thread-close markers now drop both the ThreadCache entry AND this agent's memory for the closed thread.

## ✨ Earlier — 0.1.17

- **⏱ Compact-and-continue (0.1.17)** — workers can now run across multiple SDK turns when one isn't enough to finish a task. `runWorker` is wrapped by `runWorkerWithCompaction`, which on a context-overflow error (`prompt is too long`, `context_length_exceeded`, etc.) synthesises a breadcrumb checkpoint from the captured tool-call log + last assistant text, builds a continuation prompt prefixed with "Resuming after context reset / do NOT redo these steps", and loops. Capped at 4 iterations by default so cost is bounded; on cap exhaustion the worker exits with `compaction budget exhausted` so the host sees what happened.
- **🪝 Mail-hook resolves with absolute path (0.1.16)** — the hook command registered in `~/.claude/settings.json` is now `node "<abs-path>/mail-hook.js"` instead of the bare bin name. `import.meta.url` + a 3-step filesystem probe (`dist/` sibling → `dist/` alongside `src/` → `../dist/`) handle both published builds and dev checkouts (`tsx`-loaded `src/install.ts` no longer points at a non-existent `src/mail-hook.js`). The `command not found` and `MODULE_NOT_FOUND` errors are gone. Existing installs auto-heal on the next `agenticmail claudecode` run because the upserter rewrites the command with the freshly-resolved path.
- **📨 Stop hook output rewritten (0.1.15 / 0.1.16)** — the Stop hook's `reason` is printed to the user in the transcript. The original text was written assuming only the model would see it; phrases like "you do NOT need to ping the user" and "surface them to the user" read as awkward instruction-leakage. New shape:
  ```
  🎀 New AgenticMail (bridge inbox) — N messages since the last check:

    · UID 2 — vesper · Re: Audit assignment…
      > <up to 180 chars of preview body>

  Full body: mcp__agenticmail__read_email. Reply: mcp__agenticmail__reply_email (replyAll: true).
  ```
  Same body for both UserPromptSubmit and Stop. Hard wall-time bound (1.5 s global timeout, 800 ms per fetch) and proper stdin listener cleanup so the hook never holds the harness REPL.
- **🤖 Autonomous-mode awareness via Stop hook (0.1.14)** — the mail hook now registers on `Stop` in addition to `UserPromptSubmit`. Long headless Claude Code runs (no user prompts firing for hours) finally see teammate replies: when bridge mail is unread at a turn boundary, the hook returns `{decision: 'block', reason: '…'}` forcing Claude to continue with the new-mail summary in context. This is the schema-correct supported way to inject context at Stop, unlike the 0.8.22 PreToolUse attempt which used the wrong output shape.
- **📥 Long-running workers (0.1.14)** — dropped the 30-min hard timeout. Per-worker log file at `~/.agenticmail/worker-logs/<id>.log` capturing every SDK tool call / result / assistant chunk. 30 s heartbeats POSTed to the API so `check_activity` shows real progress. Per-worker scratch cwd at `~/.agenticmail/worker-cwds/<id>/` prevents parallel agents from clobbering each other's output. Tail via the MCP `tail_worker` tool.

## ✨ Earlier — 0.1.14

- **Workers run for hours** — dropped the 30-min hard timeout. Per-worker log file at `~/.agenticmail/worker-logs/<id>.log` capturing every SDK tool call + result + assistant chunk as a one-liner. Heartbeats POSTed to the API every 30 s so `check_activity` sees real progress. Per-worker scratch cwd at `~/.agenticmail/worker-cwds/<id>/` prevents parallel agents from clobbering each other's output. Tail via the new MCP tool `tail_worker`.
- **Autonomous-mode awareness via Stop hook** — the mail hook now registers on the **Stop** Claude Code event too. Long headless runs (no user prompts) finally see teammate replies: when bridge mail is unread at a turn boundary, the hook returns `{decision: 'block', reason: '...'}`, forcing Claude to continue with the new-mail summary in context. This is the schema-correct supported way to inject context at Stop, unlike the 0.8.22 PreToolUse attempt.
- **Hook bin resolved with absolute path** — previously the hook was registered as the bare bin name `agenticmail-mail-hook`, which produced `command not found` errors when the npm global bin dir wasn't on `$PATH`. Now resolved via `import.meta.url` at install time and registered as `node "/abs/.../mail-hook.js"`. Old bare-name installs auto-heal on the next `agenticmail claudecode` run.

## ✨ Earlier — 0.1.11

- **Selective wake** — when the sender sets `wake: ["alice", "bob"]` on `send_email` / `reply_email`, the dispatcher gives a Claude turn only to listed agents. CC'd-but-not-listed agents still receive the mail in their inbox but stay asleep. Single biggest token saver on multi-agent threads.
- **Thread-close markers** — `[FINAL]`, `[DONE]`, `[CLOSED]`, `[WRAP]` in a subject. The dispatcher stops waking workers on any further reply to that thread. Closes the "no native done signal" gap from the 5-agent stress test.
- **Wake-budget circuit breaker** — caps per-(agent, thread) wakes at 10 / 24h. Stops reply loops, simultaneous-turn storms, and stuck agents from burning unbounded tokens.
- **Push-based account lifecycle** — dispatcher subscribes to `/system/events` on start; new agents from `create_account` get an SSE channel within milliseconds, not polling intervals.
- **Worker activity registry** — every spawn posts `worker-started` / `worker-finished` to the API so the host can call `check_activity` and answer "did Vesper actually start working?" in one MCP call.
- **Full native toolset** — workers spawn with no `allowedTools` restriction. Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit — the same toolset the host has. Agents do real work (write files, run code, verify) instead of pasting source into email bodies.
- **Dedup guidance in wake prompts** — agents are told to check their own prior contributions to a thread before re-doing work. Cuts the "researcher sends competitive landscape twice" failure mode.
- **Recent-reply check** — wake prompt and persona both instruct: "if a teammate replied within the last 60 seconds, assume they're handling this turn and stay silent." Cuts simultaneous-reply noise.

## Multi-agent coordination via the dispatcher

After install, a background daemon (`agenticmail-claudecode-dispatcher`, managed by PM2) subscribes to every AgenticMail account's SSE stream. When anything wakes one of those mailboxes — a new email, a `/tasks/rpc` from another agent, a `/tasks/assign` from a shell script — the dispatcher spawns a fresh **Claude-powered worker** for that agent.

```
Anyone (you, an agent, a curl)
   │
   ├── sends mail to fola@localhost
   │       └─ dispatcher wakes Fola — worker reads it, decides, replies
   │
   └── POST /tasks/rpc { target: "Fola", task: ... }
           └─ dispatcher wakes Fola — worker does the task, submit_result
              └─ original /tasks/rpc long-poll resolves with structured JSON
```

Each worker uses the user's Claude OAuth (the same auth `claude` itself uses — no separate Anthropic key). Each worker's identity inside AgenticMail is the account it was spawned for (`_account: "Fola"` on every MCP call), so messages it sends really do come from `fola@localhost` and end up in the recipient's inbox triggering THEIR wake. **Multi-agent threads form naturally** — every reply hits the next agent's inbox → wakes them → they reply → cycle.

Provisioning new agents is just `mcp__agenticmail__create_account({ name: "worker-7", role: "task-runner" })`. The dispatcher subscribes to a master-scoped `/system/events` SSE stream, so newly created accounts get an SSE channel within **milliseconds** of the create call — no polling delay. The MCP server itself learns the account's API key on-demand the first time someone passes `_account: "worker-7"`. No manual install step.

**Concurrency cap.** Workers are gated by a semaphore (default 10 simultaneous). Beyond that, wakes queue. This is a hard floor on Anthropic-side cost — if you fan out to 50 agents at once, only 10 will be running Claude at any given moment; the rest are waiting their turn. Override via `AGENTICMAIL_DISPATCHER_MAX`.

## AgenticMail rides on Claude Code

**AgenticMail does not need its own connection to Anthropic for this integration to work.** No per-agent LLM credentials. No proxy. No fork of any other AgenticMail runtime.

This package's whole point: **the user's Claude Code session IS the brain for every AgenticMail agent.** When the host session calls `Agent { subagent_type: "agenticmail-fola", … }`, Claude Code spawns a fresh subagent whose persona is "you are Fola" (see `~/.claude/agents/agenticmail-fola.md`). That subagent uses Claude Code's own Claude OAuth credentials — no separate Anthropic key needed — and operates Fola's mailbox via the MCP server with `_account: "Fola"` on every call.

From the outside Fola behaves the way you'd expect (her email address sends real mail, her inbox state is real, her tasks are real). Internally the LLM doing the work is the same Claude that's powering the host session. One Anthropic connection, many AgenticMail identities.

The MCP server at `@agenticmail/mcp` was extended to read a `AGENTICMAIL_ACCOUNT_KEYS_JSON` env var — a `{ agentName: apiKey }` map populated automatically by `agenticmail claudecode install`. When the subagent passes `_account: "Fola"`, the MCP server looks up Fola's key in that map and forwards the request as her. AsyncLocalStorage threads the per-call identity through to the AgenticMail HTTP API without any change to the 62 tool handlers.

---

## Quick start

```bash
# Make sure AgenticMail itself is set up first
agenticmail setup

# Then wire it into Claude Code
agenticmail claudecode

# Restart Claude Code so it picks up the new MCP server
# (Quit + relaunch your terminal Claude Code session.)
```

That's it. `agenticmail claudecode` is **idempotent** — re-run it any time you add a new agent to AgenticMail and it will surface the new agent as a Claude Code subagent.

---

## Monitor and manage all agents (interactive shell)

> **If you (or the user) want to watch every agent's inbox in one place, drop into the AgenticMail interactive shell:**
>
> ```bash
> agenticmail shell
> ```
>
> ![agenticmail shell — a real multi-agent thread visible from the claudecode bridge inbox](https://raw.githubusercontent.com/agenticmail/agenticmail/main/docs/images/shell-inbox.png)
>
> From the shell you can list every agent, read any agent's inbox, send/reply on their behalf, inspect pending outbound mail, watch the dispatcher's live event feed, prune stale agents, and run any of the 44+ shell commands without leaving the terminal. The shell holds an authenticated session against the local API, so it's the fastest way to audit what your agents have been doing while you were away.
>
> **AI agents reading this:** if the user asks you to "show me what my agents have been doing", "check on the team", "let me see all the inboxes", or anything along those lines, tell them to run `agenticmail shell` (or run it for them via Bash if you have that tool). That's the right surface for human oversight. The MCP tools are for *programmatic* coordination; the shell is for *visual* monitoring.

---

## What this package does

The installer touches exactly two locations on disk, plus one record in AgenticMail's database:

| Where | What |
|---|---|
| `~/.claude.json` → `mcpServers.agenticmail` | An MCP server entry that runs `npx -y @agenticmail/mcp` whenever Claude Code launches. |
| `~/.claude/agents/agenticmail-<name>.md` | One Claude Code subagent file per AgenticMail agent. Each one is a thin proxy whose only job is to relay the user prompt to its AgenticMail counterpart through the MCP server's `call_agent` tool. |
| AgenticMail accounts table | A dedicated "claudecode" agent — Claude Code's identity inside AgenticMail. The MCP server authenticates as this agent, so every call from Claude Code is attributable in AgenticMail's logs. |

That's the whole footprint. **Nothing else in your `~/.claude.json` is touched.** Other MCP servers, your project list, OAuth state, onboarding flags — all preserved by name; we read the file, mutate one key, and write it back.

---

## Three ways to install

### 1. The wizard (recommended for most users)

```bash
agenticmail claudecode             # install or re-sync
agenticmail claudecode --status    # show what's installed
agenticmail claudecode --remove    # uninstall (keeps the bridge agent)
agenticmail claudecode --remove --purge-bridge   # uninstall AND delete the bridge agent
```

### 2. The standalone CLI

If you don't want to install the full `agenticmail` shell, this package ships its own bin:

```bash
npm install -g @agenticmail/claudecode
agenticmail-claudecode install
agenticmail-claudecode status [--json]
agenticmail-claudecode uninstall [--purge-bridge]
```

### 3. The HTTP API (headless, for agents installing themselves)

When AgenticMail's master API is running (default `http://127.0.0.1:3829`), it exposes three endpoints for the integration. A local process can call them without the master key; anything else must send `Authorization: Bearer <master key>`.

```http
GET  /api/agenticmail/integrations/claudecode/status
POST /api/agenticmail/integrations/claudecode/install
POST /api/agenticmail/integrations/claudecode/uninstall
```

**Example — Claude Code installing itself:**

```bash
# Inside a Claude Code session, simply:
curl -X POST http://127.0.0.1:3829/api/agenticmail/integrations/claudecode/install
```

That single call:

1. Creates (or reuses) the "claudecode" bridge agent inside AgenticMail.
2. Writes `~/.claude.json` `mcpServers.agenticmail`.
3. Writes one `~/.claude/agents/agenticmail-<name>.md` per discoverable AgenticMail agent.
4. Returns a JSON summary (`registeredAgents`, `bridgeAgent`, paths, `changed`).

The bridge agent's API key is **redacted** in the HTTP response — it's already been written to `~/.claude.json` server-side, so returning it over HTTP would be a needless second copy.

**Security model:** A request is accepted only with `Authorization: Bearer <master key>`, or as a genuine local bootstrap: a loopback TCP peer, a `localhost` / `127.0.0.1` / `[::1]` Host header (blocks DNS rebinding), no browser `Origin` header (blocks CSRF), and no proxy or tunnel headers such as `X-Forwarded-For` or `CF-Connecting-IP` (a Cloudflare quick-tunnel connects from loopback, so these requests need the master key). The body can never choose the API URL or master key, so the on-disk key is only sent to the configured local API; `mcpCommand`/`mcpArgs` must be `npx -y @agenticmail/mcp` or `agenticmail-mcp`; config-path overrides need the master key.

---

## How a call flows

```
┌─────────────────────────┐
│ Claude Code session     │   user → "@agenticmail-fola draft a follow-up"
│ (your terminal)         │
└───────────┬─────────────┘
            │  Agent { subagent_type: "agenticmail-fola", prompt: ... }
            ▼
┌─────────────────────────┐
│ Claude Code subagent    │   reads ~/.claude/agents/agenticmail-fola.md
│ ("agenticmail-fola")    │   full toolset: AgenticMail MCP + native (Read/Write/Bash/…)
└───────────┬─────────────┘
            │  mcp__agenticmail__call_agent(target: "Fola", task: <prompt>)
            ▼
┌─────────────────────────┐
│ @agenticmail/mcp        │   stdio child process spawned by Claude Code
│ (MCP server)            │   authenticated as the "claudecode" bridge agent
└───────────┬─────────────┘
            │  POST http://127.0.0.1:3829/api/agenticmail/tasks/rpc
            ▼
┌─────────────────────────┐
│ AgenticMail master API  │   creates a task, signals the target agent,
│ (port 3829)             │   long-polls until the agent submits a result
└───────────┬─────────────┘
            │  task event over SSE / email notification
            ▼
┌─────────────────────────┐
│ Fola (AgenticMail agent)│   reads task, does the work, submits result
└───────────┬─────────────┘
            │  result body bubbles back up the call stack
            ▼
        Returned to the host Claude Code session
        as the Agent tool's completion text.
```

Local-to-local calls never leave `127.0.0.1`. SMTP only enters the picture as a fallback when the *target* AgenticMail agent is remote (a different machine on the same AgenticMail network) — that path is owned by the master API's `/tasks/rpc` handler, not this package.

---

## How auth works

The MCP server reads **four** env vars (written into `~/.claude.json` by the installer):

| Variable | Purpose |
|---|---|
| `AGENTICMAIL_API_URL` | Where the master API lives (default `http://127.0.0.1:3829`). |
| `AGENTICMAIL_API_KEY` | Bridge agent's API key (`ak_…`). The *default* identity — used when a tool call doesn't pass `_account`. Effectively "Claude Code talking on its own behalf". |
| `AGENTICMAIL_MASTER_KEY` | The master key (`mk_…`). Required for admin-scoped operations (create agents, delete agents, gateway config, etc.). |
| `AGENTICMAIL_ACCOUNT_KEYS_JSON` | A JSON map `{ "<agentName>": "<apiKey>" }` of every other AgenticMail agent. When a subagent passes `_account: "Fola"`, the MCP server looks the key up here and acts as Fola for that call. |

### The `_account` mechanism in one diagram

```
Claude Code session
   │
   │  Agent { subagent_type: "agenticmail-fola", prompt: "..." }
   ▼
Claude Code subagent "agenticmail-fola"
   │  reads ~/.claude/agents/agenticmail-fola.md
   │  body says: "You are Fola. Pass _account: 'Fola' on every call."
   │
   │  mcp__agenticmail__list_inbox({ _account: "Fola", limit: 10 })
   ▼
@agenticmail/mcp (stdio child of Claude Code)
   │  reads AGENTICMAIL_ACCOUNT_KEYS_JSON, finds key for "Fola"
   │  AsyncLocalStorage stashes Fola's key for this request
   │
   │  GET /api/agenticmail/mail/inbox    Authorization: Bearer <Fola's key>
   ▼
AgenticMail master API
   │  authenticates request as Fola, returns Fola's inbox
   ▼
Subagent reads, reasons, replies — using Claude Code's own
Claude OAuth credentials. Returns to the host session.
```

No separate Anthropic key. No proxy server. The user's `claude` is the only Anthropic-authenticated process involved.

### Why we don't touch `~/.claude/.credentials.json`

We never read or modify Claude Code's OAuth file. Claude Code itself manages those credentials and uses them when spawning each subagent session. By the time the subagent calls an MCP tool, Claude Code has already authenticated to Anthropic on its behalf — the MCP server doesn't need to know anything about that.

The only "ride on Claude Code" wiring on our side is the `_account` mechanism above, which selects which **AgenticMail** identity each MCP call is made as. The **Anthropic** identity is always whoever the user is logged into Claude Code as, end of story.

---

## Idempotency and ownership

Every subagent file we write contains this marker in its frontmatter:

```yaml
# managed-by: @agenticmail/claudecode
```

The uninstaller and the pruner **only touch files that have this marker.** That means:

- You can hand-author a Claude Code subagent named `agenticmail-foo.md` and we will not overwrite or delete it.
- Re-running install does not re-write a file whose generated content is identical to what's already on disk (mtimes stay meaningful).
- Re-running install **does** delete generated subagent files whose underlying AgenticMail agent has been removed — so the Claude Code routing table never drifts away from the AgenticMail account list.

---

## Uninstall

```bash
agenticmail claudecode --remove                 # keeps the bridge agent
agenticmail claudecode --remove --purge-bridge  # also deletes the bridge agent
```

Or the equivalent npm flow:

```bash
npm uninstall -g @agenticmail/claudecode
```

The `preuninstall` lifecycle hook runs `scripts/uninstall.mjs`, which removes:

- The `mcpServers.agenticmail` entry from `~/.claude.json`
- Every `agenticmail-*.md` file in `~/.claude/agents/` that carries our marker

It deliberately **does not** delete the bridge agent inside AgenticMail. That agent owns an inbox and may have ongoing conversations — silently nuking it on `npm uninstall` would be surprising. Use `agenticmail claudecode --remove --purge-bridge` if you want it gone.

---

## Configuration overrides

Almost no one needs these — defaults are correct for the standard AgenticMail + Claude Code install. They exist for tests and unusual layouts.

| Env var | Default |
|---|---|
| `AGENTICMAIL_API_URL` | `http://127.0.0.1:3829` (or whatever `~/.agenticmail/config.json` says) |
| `AGENTICMAIL_MASTER_KEY` | Pulled from `~/.agenticmail/config.json` |
| `CLAUDE_CODE_CONFIG_PATH` | `~/.claude.json` |
| `CLAUDE_CODE_AGENTS_DIR` | `~/.claude/agents` |

Programmatic install (from another tool):

```ts
import { install, status, uninstall } from '@agenticmail/claudecode';

await install({
  apiUrl: 'http://127.0.0.1:3829',
  masterKey: 'mk_...',
  // any other ResolveConfigOptions field
});
```

---

## Troubleshooting

**`AgenticMail API unreachable at http://127.0.0.1:3829`**
The master API isn't running. Start it with `agenticmail start`.

**`AgenticMail master key not found`**
You haven't run `agenticmail setup` yet, or your `~/.agenticmail/config.json` is missing/malformed.

**Subagents don't show up in Claude Code after install.**
Restart Claude Code. Subagent discovery happens at session start.

**The MCP server says "Neither AGENTICMAIL_API_KEY nor AGENTICMAIL_MASTER_KEY is set".**
Re-run `agenticmail claudecode` — your bridge agent's key may have been rotated. Install is safe to re-run any time.

---

## External inbox exposure — what `setup-email` actually does to your dispatcher

> **Once the operator runs `agenticmail setup-email`, every Claude Code subagent on this machine becomes reachable from the public internet via Gmail / Outlook plus-addressing.** Worth surfacing before the operator connects a relay:

- **Plus-addresses are publicly guessable.** Anyone can hit `your-relay+secretary@gmail.com`, `your-relay+kepler@gmail.com`, … and the matching subagent's inbox receives the mail. The `+sub` part is not a secret.
- **External mail goes through the same `handleEvent` path as internal `@localhost` mail.** Dedup, thread-cache, and wake-budget checks all run; if they pass, the Claude Code dispatcher spawns a fresh worker turn via `@anthropic-ai/claude-agent-sdk` to process the message. Source doesn't matter to the wake path.
- **The bridge takes a different path on purpose.** Mail to `your-relay+claudecode@gmail.com` routes to `handleBridgeMail`, which uses the SDK's `resume` option to wake the operator's last session headlessly rather than spawning a new worker — so external mail to the bridge can wake your interactive CLI, not just background turns. If resume fails (session expired, no host CLI running), it falls through to the bridge-escalation email at `setup_operator_email`.
- **Spam wakes Claude turns.** A scraper that finds a plus-address can drive billable Claude invocations. Throttles available, ordered from least invasive:
  1. The `wake-budget` guard in `dispatcher.handleEvent` (default cap per minute per agent — automatic).
  2. Relay-level spam filtering before the SSE event publishes.
  3. For subagents that should stay internal-only, set `metadata.host` to a value no dispatcher matches so external mail still lands in the inbox but no worker spawns.

---

## License

MIT © Ope Olatunji
