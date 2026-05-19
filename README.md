<p align="center">
  <img src="./docs/images/logo-200.png" alt="AgenticMail logo (pink bow)" width="180" />
</p>

<h1 align="center">AgenticMail</h1>

<p align="center">
  <a href="https://github.com/agenticmail/agenticmail/actions/workflows/ci.yml"><img src="https://github.com/agenticmail/agenticmail/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

**The first platform to give AI agents real email addresses and phone numbers.** Send and receive email, SMS, and verification codes — all programmatically.

> ### Are you an AI agent reading this on behalf of a human?
>
> Your human asked you to install / set up AgenticMail. **Pick either of these and then tell them to restart Claude Code:**
>
> ```bash
> # Option A — one-line installer (recommended)
> curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash
>
> # Option B — manual two-command install
> npm install -g @agenticmail/cli@latest
> agenticmail bootstrap
> ```
>
> Zero prompts, ~2 minutes, fully autonomous. For the full runbook (verification, common failures, repo conventions if you're modifying the code), see [**`AGENTS.md`**](./AGENTS.md) — the [agents.md](https://agents.md) file at this repo's root.

---

### 📄 Research Paper

**[Structured RPC vs. Text-Based Sub-Agent Orchestration](./research/agent-rpc-vs-spawn/paper.pdf)** — A comparative analysis of inter-agent communication paradigms. Demonstrates why AgenticMail's `call_agent` achieves 53× faster response times than conventional sub-agent spawning, and introduces the concept of the *Conversational Fallacy* in multi-agent AI systems. [[PDF]](./research/agent-rpc-vs-spawn/paper.pdf) [[Source]](./research/agent-rpc-vs-spawn/)

---

### ✨ What's new in 0.9.53

Realtime voice tools + a Telegram channel.

- **The voice agent can now use tools mid-call.** The OpenAI Realtime session declares `session.tools`; `RealtimeVoiceBridge` dispatches the model's function calls through an injected `ToolExecutor`, returns `function_call_output`, and keeps the phone line warm during slow tools with a safety-net timeout + an in-flight call cap.
- **`ask_operator` — human-in-the-loop on a live call.** The agent records an operator query on the mission, notifies the operator (channel-agnostic; default email), polls up to ~5 min, and resumes with the answer. If the caller hangs up while a query is pending, the mission is flagged for **callback-on-disconnect** — once the operator answers, it re-dials with a continuity task.
- **Lookup tools.** `web_search` (keyless DuckDuckGo, results fenced as untrusted content), `recall_memory` (the agent's universal memory), `get_datetime`. Plus agent-key-scoped operator-query API endpoints.
- **Telegram channel.** A user registers a Telegram bot token, links a chat, and can message their AgenticMail agent — and get replies — over Telegram. The inbound webhook authenticates with a constant-time secret-token compare; it also carries `ask_operator` notifications and approvals.
- **Security.** web_search output is fenced as untrusted before it reaches the model; operator email replies are verified against `operatorEmail`; Telegram bot tokens are encrypted at rest and redacted from logs; new SQL is parameterized.

996 tests pass; full build green. The live OpenAI ⇄ 46elks call path and live Telegram delivery still need an operator smoke-test before the npm publish.

### ✨ Earlier — 0.9.52

Realtime voice + OpenClaw memory.

- **Realtime voice bridge.** A phone mission can now hold a live conversation. `RealtimeVoiceBridge` (`@agenticmail/core`) wires an OpenAI Realtime (`gpt-realtime`) session to a 46elks realtime-media WebSocket: caller audio (PCM16 @ 24 kHz) is relayed to OpenAI, synthesised speech comes back as `response.output_audio.delta` and is relayed to 46elks, server-side VAD handles turn-taking, and caller barge-in fires a 46elks `interrupt`. 46elks streams a call to the new `/api/agenticmail/calls/realtime` WebSocket endpoint, which matches the connection to its mission by 46elks `callid` and runs the bridge. Set `OPENAI_API_KEY` (env or `config.json`) to enable it.
- **Memory in the voice session.** Before the call starts, the agent's persistent memory is rendered with `generateMemoryContext()` and folded into the Realtime session `instructions` — the model is told to treat it as its *own* long-term knowledge, so the call is continuous with everything the agent has learned elsewhere.
- **OpenClaw memory tools.** `agenticmail_memory`, `agenticmail_memory_reflect`, `agenticmail_memory_context`, and `agenticmail_memory_stats` bring the universal per-agent memory to OpenClaw agents — 69 → 73 tools.
- **Bridge hardening.** Per-frame audio size cap (an oversized frame is dropped, never forwarded), bounded pre-connect buffer, fail-closed connection auth (timing-safe token compare; no unknown-mission-vs-wrong-token oracle), and a terminal-state guard so a late event can't resurrect a finished mission.

The end-to-end voice path needs a live `OPENAI_API_KEY` and a provisioned 46elks websocket number — the bridge logic, memory injection, and the WebSocket upgrade/auth glue are unit-tested with mocked sockets, but the live call must be smoke-tested by the operator.

### ✨ Earlier — 0.9.51

The universal memory release. Every agent now has a persistent, evolving memory — categorised, confidence-decaying, BM25F-searchable knowledge that survives across every conversation, the way a human employee learns on the job.

- **`AgentMemoryManager`** (`@agenticmail/core`) — CRUD, text recall, 9 memory categories, importance levels, confidence that decays for unaccessed entries, access tracking, pruning, and `generateMemoryContext()` which ranks + renders memory as a markdown block for prompt injection. Backed by a zero-dependency BM25F search index and an `agent_memory` table. Ported from the AgenticMail Enterprise memory engine, org-stripped — memory is personal to each agent.
- **Memory API** — `/memory` (set / list / search / get / delete), `/memory/reflect`, `/memory/context`, `/memory/stats`. Every endpoint is scoped to the authenticated agent; an agent can only ever read or write its own memory.
- **MCP tools** — `memory`, `memory_reflect`, `memory_context`, `memory_stats` so any MCP client can give its agent durable memory.
- **Agent-deletion cleanup** — deleting an agent purges its `agent_memory` rows; no orphaned memory is left behind.

### ✨ Earlier — 0.9.1

The visibility release — closes every "what just happened?" gap from 0.9.0.

- **Lone wakes fire immediately.** 0.9.0's debounce window blocked even single replies for 30 s, making the dispatcher look dead. Leading-edge fire + trailing-edge coalesce now: first event for a `(agent, thread)` spawns instantly; bursts within the window collapse into one trailing wake.
- **Dispatcher process heartbeat.** `check_activity` now shows `dispatcher: { state: 'alive' | 'unhealthy' | 'missing', uptimeMs, channels, coalesceQueueSize, ... }`. The host can finally answer "is the dispatcher up?" in one query.
- **Skipped-wake ring buffer.** Every filter decision (thread-closed, allowlist-excluded, wake-on-cc, budget-exhausted) is posted with a reason; `check_activity` surfaces the last 100. No more "did my mail land? did it skip?" guessing.
- **Per-agent `wake_on_cc: false` flag.** Coder agents can register a preference: never wake when only on Cc, regardless of sender. `PATCH /accounts/:id/wake-on-cc`.
- **Display-name regex fix in `deriveDefaultWakeList`.** Senders using `"Vesper <vesper@localhost>"` form no longer fall through to "no allowlist → wake everyone".
- **Web UI shows To / Cc / Bcc as separate labeled rows** in the message view (previously lumped under one `to:` line).
- **`docs/wake-patterns.md`** documents every wake shape + 5 recommended patterns.

### ✨ Earlier — 0.9.0

The wake-context release. Multi-agent thread cost goes from linear-in-thread-length to roughly flat.

- **Layered wake-context system.** Every wake used to re-read the entire thread from scratch (12 messages × ~1 KB = 12 KB of token spend just to rehydrate, before any reasoning). Now the dispatcher prepends two blocks to every wake prompt: **Layer 1 — ThreadCache** (envelopes + previews of the last 10 messages, shared across CC'd agents) and **Layer 2 — AgentMemory** (a markdown file each agent writes at end-of-wake describing its own commitments and last actions). Agents read the new event + these two blocks and decide; they don't `read_email` prior history. New MCP tools `save_thread_memory` and `get_thread_id`.
- **`wake` default flipped from "everyone CC'd" → "To: only".** Mirrors the email convention: To is for action, CC is for awareness. CC'd local agents still receive the mail in their inbox but don't get a Claude turn unless explicitly named in `wake`. Opt back into the old behaviour with `wake: 'all'`.
- **Wake coalescing.** Within 30 s for the same `(agent, thread)`, multiple wake events collapse into ONE Claude turn. A burst of 4 quick replies becomes one Claude wake that sees all four in a `coalesced` batch prompt. Wake-budget charges once. Configurable via `wakeCoalesceMs`.

Together these eliminate the "wake-thrash" failure mode where an agent fired 4 near-identical status reports because a designer sent 4 replies in 2 minutes.

### ✨ Earlier — 0.8.31

- **Compact-and-continue** — workers can now run across multiple SDK turns. On a context-overflow error the dispatcher synthesises a breadcrumb checkpoint from the captured log, builds a "resuming after context reset" continuation prompt, and loops (capped at 4 iterations).
- **Typed task contracts** — `call_agent` / `POST /tasks/assign` accept an `outputSchema` (JSON Schema, draft-7 subset). `submit_result` validates against it; mismatches return 400 with the validator errors so the worker can retry with a corrected shape.
- **Delete + Move-to-Spam buttons** in the message view; **Compose auto-saves to Drafts** every 2s.
- **`All Mail` folder hides itself** on servers that don't have one (Stalwart, most non-Gmail). Select-all checkbox now wires through.
- **Logo background stripped** — bow PNG is now RGBA with proper transparency.

### ✨ Earlier — 0.8.29

- **Star button wired** — clicking the star toggles IMAP's `\Flagged` flag via the new `POST /mail/messages/:uid/star` endpoint. Backed by `MailReceiver.setStarred` in `@agenticmail/core`. Optimistic UI; revert on failure.
- **Gmail-compact list UX** — single 36 px rows (was 64 px stacked), subject + preview on one truncated line separated by an em-dash, leading checkbox column, sticky list-toolbar with select-all + refresh + count. Same layout for every folder.
- **Compose button** down to 48 px (Gmail's actual size); the giant pink pill is gone.

### ✨ Earlier — 0.8.27

- **Folder bug fix** — Sent / Drafts / Spam / Trash were returning empty in the web UI because hard-coded folder names didn't match Stalwart's actual IMAP names (e.g. `Sent Items` not `Sent`). Now auto-discovered per agent and matched against every common server convention (Stalwart, Gmail, Outlook, macOS Mail).
- **Two-line preview** on every list row — web UI uses `/mail/digest?folder=…` everywhere instead of `/mail/inbox` (no preview) + `/mail/folders/:folder` (no preview).
- **URL reflects current folder** — hash router now uses `#/folder/<id>` (sent, drafts, spam, …). Back/forward works, URLs are shareable, refresh stays put.
- **Stop hook output rewritten** — terser, audience-neutral, includes body preview. Drops the instruction-leakage from 0.8.25/26.

### ✨ Earlier — 0.8.25

- **Workers can now run for hours** — dropped the 30-min hard timeout. Each worker writes a per-turn log at `~/.agenticmail/worker-logs/<id>.log`, posts heartbeats every 30 s, and runs in its own isolated cwd so parallel agents don't clobber each other's output. New MCP tool **`tail_worker`** to read a running worker's log live; `check_activity` now shows last tool used, turn count, and a `stale` flag (no auto-eviction).
- **Autonomous-mode awareness** — the mail hook now registers on the **Stop** event too. Long headless Claude Code runs (no user prompts firing for hours) finally see teammate replies — the hook returns `decision: 'block'` at turn boundaries when the bridge inbox has new mail, forcing Claude to continue with the new-mail summary in context. Closes the follow-up that 0.8.23 filed.
- **Fixed `agenticmail-mail-hook: command not found` errors** — hook is now registered with an absolute path resolved at install time. Resilient to any `$PATH` configuration; old installs auto-heal on the next `agenticmail claudecode` run.
- **Web UI fixes** — `(m.flags ?? []).includes is not a function` crash gone; sidebar folders (Sent / Drafts / Spam / Trash) now load their real IMAP mailboxes instead of all hitting `/mail/inbox`; Cmd+C no longer pops the compose modal; full mobile-responsive layout with an off-canvas sidebar.
- **Official logos** — Claude starburst (from Wikipedia) and the AgenticMail `@` mark from `branding/` now ship bundled and render as the host avatar + topbar / favicon.
- **Selective wake** — `wake: ["alice", "bob"]` on `send_email` / `reply_email` / `forward_email` / `template_send` / `manage_drafts(send)` tells the dispatcher to give a Claude turn only to named agents. The other CC'd recipients still receive the mail but stay asleep. Cuts token cost on large threads by ~10× when used.
- **Thread-close markers** — `[FINAL]`, `[DONE]`, `[CLOSED]`, or `[WRAP]` in a subject tells the dispatcher this thread is done; no more wakes on any reply.
- **`check_activity` MCP tool** — see which agents the dispatcher has woken right now, how long they've been running, and a preview of recent completions. The answer to "did the agent I just emailed actually start working?"
- **Comprehensive markdown rendering** in the shell's email viewer — bold, italic, headings, lists, task lists, tables, fenced code, links, images, HTML entities, depth-colored quote stripes (instead of literal `>>>>`).
- **LLM-tolerant tool inputs** — `batch_mark_read({ uids: "[1,2,3]" })` and other common stringification mistakes now just work; coerced before validation.
- **Wake-budget circuit breaker** — caps per-(agent, thread) wakes at 10 per 24h to stop reply loops and storms.
- **Dedup guidance** — wake prompts now tell agents to check their prior contributions before redoing work.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

---

AgenticMail is a self-hosted communication platform purpose-built for AI agents. It runs a local [Stalwart](https://stalw.art) mail server via Docker, integrates SMS/phone access via Google Voice or 46elks, exposes a REST API with 75+ endpoints, ships a lightweight Gmail-style web UI for human oversight, and works with any MCP-compatible AI client and [OpenClaw](https://github.com/openclaw/openclaw) via plugin. Each agent gets its own email address, phone number, inbox, and API key.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org)

[![agenticmail MCP server](https://glama.ai/mcp/servers/agenticmail/agenticmail/badges/card.svg)](https://glama.ai/mcp/servers/agenticmail/agenticmail)

---

## Table of Contents

- [Why AgenticMail?](#why-agenticmail)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [CLI Commands](#cli-commands)
- [Gateway Modes](#gateway-modes)
- [Packages](#packages)
- [API Overview](#api-overview)
- [MCP Integration](#mcp-integration)
- [Host Integrations](#host-integrations)
- [OpenClaw Integration](#openclaw-integration)
- [Interactive Shell](#interactive-shell)
- [Security](#security)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)

---

## Why 🎀 AgenticMail?

AI agents need to communicate with the real world. Email is the universal communication protocol — every person and business has an email address. AgenticMail bridges the gap between AI agents and email by providing:

- **Isolated mailboxes** — each agent has its own email address, inbox, and credentials. Agents can't read each other's mail.
- **Internet email connectivity** — two gateway modes to send/receive real email (Gmail relay or custom domain with DKIM/SPF/DMARC).
- **Security guardrails** — outbound scanning prevents agents from leaking API keys, passwords, or PII. Blocked emails require human approval.
- **Agent collaboration** — agents can email each other, assign tasks, and make synchronous RPC calls.
- **SMS / Phone number access** — integrate Google Voice or 46elks for SMS receive/send, verification code extraction, and phone number access for AI agents.
- **Realtime voice calls** — bridge a phone mission to an OpenAI Realtime (`gpt-realtime`) session so an agent can hold a live two-way conversation, with its persistent memory folded into the call.
- **Persistent agent memory** — every agent has a categorised, confidence-decaying, searchable long-term memory that survives across conversations and is injected into prompts and voice sessions.
- **Smart orchestration** — `call_agent` replaces basic sub-agent spawning with auto mode detection, dynamic timeouts, runtime tool discovery, and async execution for long-running tasks.
- **Tool integrations** — 80+ MCP tools for any AI client, 73 OpenClaw tools, and a 44-command interactive shell.
- **Self-updating** — `agenticmail update` checks npm, verifies OpenClaw compatibility, and updates both packages automatically.

---

## Features

### Email Operations
- **Send email** with text, HTML, attachments, CC/BCC, reply-to, and custom headers
- **Receive email** via IMAP with real-time SSE event streaming (IMAP IDLE)
- **Reply and forward** with proper In-Reply-To and References headers for threading
- **Search** by sender, subject, body text, date range, read/unread status
- **Folders** — create, list, move messages between folders
- **Batch operations** — mark read/unread, delete, move multiple messages at once
- **Drafts** — save, edit, and send draft emails
- **Templates** — reusable email templates with variable substitution
- **Scheduled sending** — queue emails for future delivery
- **Signatures** — per-agent email signatures
- **Tags** — label and categorize messages
- **Contacts** — manage address book per agent

### Multi-Agent
- **Account management** — create, list, delete agents with unique email addresses
- **Agent-to-agent email** — agents can email each other directly via `@localhost`
- **Task system** — assign tasks to agents, claim, submit results, track status
- **RPC calls** — synchronous agent-to-agent calls with timeout (long-poll + SSE notification)
- **Agent directory** — discover other agents by name

**You can watch the whole team work in one place with `agenticmail shell`:**

![agenticmail shell — Solène (QA) and Cassian (developer) coordinating on a build, all visible from the claudecode bridge inbox](./docs/images/shell-inbox.png)

That's a real multi-agent thread captured in the REPL — the host kicked off one email, Solène verified the file Cassian shipped to disk, and every step is sitting there as ordinary mail. No custom orchestration code. Type `agenticmail shell` any time you want to see what your agents have been up to.

### Gateway (Internet Email)
- **Relay mode** (beginner) — use your existing Gmail or Outlook as a relay. Emails appear as `you+agentname@gmail.com`. Setup takes 2 minutes.
- **Domain mode** (advanced) — custom domain via Cloudflare. Agents send from `agent@yourdomain.com` with full DKIM signing, SPF, and DMARC records.
  - Automatic DNS configuration (MX, SPF, DKIM TXT, DMARC, tunnel CNAME)
  - Cloudflare Tunnel for secure inbound traffic without exposing ports
  - Cloudflare Email Worker for Email Routing (catch-all → worker → AgenticMail)
  - Optional Gmail SMTP outbound relay for residential IPs without PTR records
  - Domain purchase via Cloudflare Registrar
  - DNS backup before any modifications
  - Automatic `@domain` email alias for all existing agents

### What `setup-email` actually exposes — read before connecting a relay

> **Heads-up for anyone running `agenticmail setup-email` (or telling Claude / Codex to do it for them).** Once that command succeeds, your sub-agents are reachable from the public internet via Gmail / Outlook plus-addressing. This is *the design* — not a bug — but the implications surprise some operators:

- **Every sub-agent has a publicly addressable inbox the moment setup-email finishes.** Anyone who knows your relay address can hit `yourrelay+<agentname>@gmail.com` and the corresponding agent's AgenticMail inbox receives the message. Plus-addresses are **publicly guessable** (`+secretary`, `+kepler`, …) — don't treat them as a secret.
- **External mail wakes the dispatcher the same way internal `@localhost` mail does.** When a new-mail event lands on a watched inbox, the dispatcher runs dedup + thread-cache + wake-budget checks and spawns a Claude Code (or Codex) worker turn. Source doesn't matter — `bob@gmail.com` and `secretary@localhost` are indistinguishable from the dispatcher's point of view.
- **The host bridge takes a different path.** Mail to `yourrelay+claudecode@gmail.com` or `yourrelay+codex@gmail.com` doesn't spawn a worker — it goes to `handleBridgeMail`, which uses the host SDK's `resume` option to wake your last session headlessly. If that fails (session expired, host CLI not running), it falls through to the bridge-escalation email at `setup_operator_email`. So external mail to the bridge can wake your CLI / forward to your phone.
- **Watchout — spam wakes Claude / Codex turns.** A scraper that finds `astrumsphere+secretary@gmail.com` in a leaked address book can drive worker turns at your expense. Throttles available, ordered from least invasive:
  1. Let the `wake-budget` guard in `dispatcher.handleEvent` rate-limit naturally (default cap per minute per agent).
  2. Add inbound spam rules at the relay layer so spam gets filtered before the SSE event publishes (built-in spam filter + tags can do this; see the Security section below).
  3. For agents that should be internal-only, set `metadata.host` to a value no dispatcher matches, or stop the relay's IMAP poller from publishing on that inbox.

### Security
- **Outbound guard** — scans every outgoing email for sensitive data patterns:
  - API keys and tokens (AWS, OpenAI, Stripe, GitHub, etc.)
  - Passwords and credentials
  - Private keys (SSH, PGP, RSA)
  - PII patterns (SSN, credit card numbers)
  - Internal URLs and configuration data
  - Blocked emails are held for human-only approval (agents cannot self-approve)
- **Spam filter** — rule-based scoring engine for inbound email:
  - Categories: phishing, scam, malware, commercial spam, social engineering, lottery scam
  - Configurable threshold (default: 40)
  - Skips internal agent-to-agent emails
  - Runs on both relay inbound and SSE event streams
- **Human-only approval flow** — when an agent's email is blocked:
  - The agent is informed the email was blocked and told to notify their owner
  - The owner receives a notification email with full blocked email content, warnings, and pending ID
  - Only the master key holder can approve or reject (`POST /mail/pending/:id/approve`)
  - Agents can list and view their own pending emails but **cannot** approve or reject them
  - System prompt guidelines instruct agents to inform their owner and wait, never attempt to bypass
- **DKIM/SPF/DMARC** — automatic DNS setup in domain mode for email authentication
- **Rate limiting** — configurable per-endpoint rate limits

### SMS / Phone Number Access
- **Provider selection** — choose Google Voice legacy forwarding or 46elks direct SMS API/webhooks
- **46elks integration** — send SMS through the provider API and receive inbound SMS through a secret-protected webhook
- **Google Voice integration** — give agents a real phone number via Google Voice
- **Direct Voice web reading** (primary, instant) — reads SMS directly from voice.google.com via browser
- **Email forwarding** (fallback) — Google Voice forwards SMS to email, agent auto-detects and records them during relay polling
- **Separate Gmail polling** — for users whose GV Gmail differs from relay email, runs a dedicated IMAP poll
- **Verification codes** — automatic extraction of OTP/verification codes from SMS (4-8 digit, alphanumeric, Google G-codes)
- **Send SMS** — direct provider API send when configured, or Google Voice web automation instructions for legacy configs
- **Smart setup wizard** — validates Gmail/GV email matching, warns about mismatches, collects separate credentials when needed

### Realtime Voice Calls
- **Live two-way conversation** — `RealtimeVoiceBridge` bridges a phone mission to an OpenAI Realtime (`gpt-realtime`) session so an agent can actually talk on the call, not just place it
- **46elks realtime media** — 46elks streams the call audio to the `/api/agenticmail/calls/realtime` WebSocket endpoint; PCM16 @ 24 kHz both ways, server-side VAD for turn-taking, caller barge-in relayed as a 46elks `interrupt`
- **Memory in the call** — the agent's persistent memory is rendered and folded into the Realtime session instructions, so the model speaks with full continuity, as if it had always known those things
- **Mission-tracked** — the bridge resolves the connection to its phone mission by 46elks `callid`, authenticates the connection token, and persists the conversation transcript to the mission
- **Hardened** — per-frame audio size cap, bounded pre-connect buffer, fail-closed connection auth, terminal-state guard
- **Opt-in** — set `OPENAI_API_KEY` to enable; without it, phone missions still place and track calls (call-control only)
- **Tools on the call** — the Realtime session can call functions mid-call: `ask_operator` (human-in-the-loop — pause, ask the operator, resume, or call back on disconnect), `web_search`, `recall_memory`, `get_datetime`

### Telegram Channel
- **Chat with your agents over Telegram** — register a Telegram bot token, link a chat, and message your AgenticMail agent (and get replies) from Telegram
- **Inbound webhook** — authenticated with a constant-time `X-Telegram-Bot-Api-Secret-Token` compare; uniform 403 on mismatch
- **Operator channel** — carries `ask_operator` notifications and approvals, so a phone agent can reach you on Telegram mid-call
- **Secrets protected** — bot tokens encrypted at rest, redacted from every log line and error

### Persistent Agent Memory
- **Long-term, evolving knowledge** — each agent has a categorised memory (knowledge, preference, correction, skill, reflection, …) that survives across every conversation
- **Confidence + decay** — entries carry a confidence score that decays for unaccessed knowledge; `critical` entries never decay; low-confidence and expired entries are pruned
- **BM25F search** — a zero-dependency full-text index ranks recall by relevance, importance, recency, and access count
- **Prompt + voice injection** — `generateMemoryContext()` renders a ranked markdown block for injection into agent prompts and realtime voice sessions
- **Private per agent** — every memory endpoint is scoped to the authenticated agent; deleting an agent purges its memory
- **Everywhere** — `/memory*` REST endpoints, MCP tools (`memory`, `memory_reflect`, `memory_context`, `memory_stats`), and OpenClaw tools (`agenticmail_memory*`)

### Smart Orchestration (call_agent)
- **Auto mode detection** — reads task complexity, picks light/standard/full mode automatically
- **Dynamic timeouts** — 60s for quick tasks, 5+ minutes for deep research, 1 hour for async
- **Runtime tool discovery** — probes host config for available tools instead of static deny lists
- **Async execution** — long-running tasks run independently, auto-compact context, email results when done
- **Structured RPC** — sub-agents return JSON, not raw text

### Integrations
- **MCP server** — 80+ tools for any MCP-compatible AI client
- **OpenClaw plugin** — 73 tools with skill definition and system prompt guidelines
- **REST API** — 75+ endpoints, OpenAPI-style, Bearer token auth
- **SSE events** — real-time inbox notifications via Server-Sent Events
- **Interactive CLI** — 44 shell commands with arrow key navigation, body previews, retry logic
- **Self-updating** — `agenticmail update` or `/update` in shell, with OpenClaw compatibility check

---

## Architecture

```
                  ┌──────────────────────────────────────────────────┐
                  │                    AgenticMail                    │
                  │                                                  │
 AI Client ─MCP─> │  @agenticmail/mcp   (80+ tools, stdio transport) │
                  │       │                                          │
 OpenClaw ─────>  │  @agenticmail/openclaw  (73 tools, plugin)       │
                  │       │                                          │
 HTTP clients──>  │       ▼                                          │
                  │  @agenticmail/api     (Express, 75+ endpoints)   │
                  │    ├── Authentication  (master key + agent keys)  │
                  │    ├── Rate limiting   (per-endpoint)             │
                  │    ├── SSE streaming   (real-time inbox events)   │
                  │    └── Spam filter + Outbound guard               │
                  │       │                                          │
                  │       ▼                                          │
                  │  @agenticmail/core    (SDK layer)                 │
                  │    ├── AccountManager  (CRUD agents in Stalwart)  │
                  │    ├── MailSender      (SMTP, nodemailer)         │
                  │    ├── MailReceiver    (IMAP, imapflow)           │
                  │    ├── InboxWatcher    (IMAP IDLE → events)       │
                  │    ├── GatewayManager  (relay + domain routing)   │
                  │    │   ├── RelayGateway      (Gmail/Outlook)      │
                  │    │   ├── CloudflareClient   (DNS, tunnels, etc) │
                  │    │   ├── TunnelManager      (cloudflared)       │
                  │    │   ├── DNSConfigurator    (MX, SPF, DKIM)     │
                  │    │   └── DomainPurchaser    (Registrar API)     │
                  │    ├── StalwartAdmin   (mail server management)   │
                  │    ├── EmailSearchIndex (FTS5 full-text search)   │
                  │    └── Storage         (SQLite + migrations)      │
                  │       │                                          │
                  │       ▼                                          │
                  │  Stalwart Mail Server  (Docker container)         │
                  │    ├── SMTP (port 587) — submission               │
                  │    ├── SMTP (port 25)  — inbound delivery         │
                  │    ├── IMAP (port 143) — mailbox access           │
                  │    └── HTTP (port 8080) — admin API               │
                  └──────────────────────────────────────────────────┘
                          │                         │
            ┌─────────────┘                         └──────────────┐
            ▼                                                      ▼
     Relay Mode                                            Domain Mode
  ┌──────────────────┐                            ┌──────────────────────┐
  │  Gmail / Outlook  │                            │  Cloudflare          │
  │  IMAP polling     │                            │  ├── DNS zone        │
  │  SMTP relay       │                            │  ├── Tunnel          │
  │  Sub-addressing   │                            │  ├── Email Routing   │
  │  (+agent@gmail)   │                            │  ├── Email Worker    │
  └──────────────────┘                            │  └── Registrar       │
                                                   └──────────────────────┘
```

### Data Flow

**Sending email (relay mode):**
1. Agent calls `POST /mail/send` with recipient, subject, body
2. API runs outbound guard scan — if sensitive data found, email is blocked and owner notified
3. GatewayManager detects external recipient → routes to RelayGateway
4. RelayGateway sends via Gmail SMTP as `owner+agentname@gmail.com`
5. Reply-To set to agent's relay address so replies route back

**Sending email (domain mode):**
1. Agent calls `POST /mail/send`
2. Outbound guard scan runs
3. GatewayManager rewrites `agent@localhost` → `agent@yourdomain.com`
4. Email submitted to local Stalwart via SMTP (port 587)
5. Stalwart signs with DKIM, resolves MX, delivers directly (or via Gmail relay)

**Receiving email (relay mode):**
1. RelayGateway polls Gmail IMAP every 30 seconds for new messages
2. New email detected → parsed → spam scored
3. If not spam, delivered to agent's local Stalwart mailbox via SMTP
4. `X-AgenticMail-Relay: inbound` header added for identification
5. InboxWatcher (IMAP IDLE) fires SSE event to connected clients

**Receiving email (domain mode):**
1. External sender sends to `agent@yourdomain.com`
2. Cloudflare Email Routing catches all → routes to Email Worker
3. Worker reads raw RFC822 message, base64-encodes, POSTs to `/api/agenticmail/mail/inbound`
4. Inbound endpoint validates secret, parses email, delivers to agent's mailbox
5. InboxWatcher fires SSE event

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) **22 or later** (we use the built-in `node:sqlite` module — zero native compilation, no `node-gyp` headaches)
- `brew` (macOS) or `apt` (Linux) so the wizard can install Colima / Docker if you don't already have it

### Two install paths

| Path | When to use | Command |
|---|---|---|
| **Autonomous** ✨ | Letting an AI agent (e.g. Claude Code) install AgenticMail on your behalf, or you just want zero questions | `npm install -g @agenticmail/cli && agenticmail bootstrap` |
| **Interactive** | You want to connect a Gmail relay or your own domain right away | `npm install -g @agenticmail/cli && agenticmail setup` |

#### Autonomous install (recommended for most users)

```bash
# Option A — one-liner (does the npm install + bootstrap for you, plus a Node 22+ preflight)
curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash

# Option B — equivalent, manually
npm install -g @agenticmail/cli
agenticmail bootstrap
```

Either path: zero prompts. The pipeline:

1. **`agenticmail setup --yes`** — auto-installs Colima + Docker if missing, starts the Stalwart mail server, generates your master key, creates a default "secretary" agent. **Skips external email/SMS setup** (those need user-owned credentials; add them later if you want).
2. **`agenticmail service install`** — registers a launchd plist (macOS) / systemd unit (Linux) so the API auto-starts on boot, and starts it now.
3. Waits for `GET /api/agenticmail/health` to come up on the configured port (default `http://127.0.0.1:3829`).
4. **`agenticmail claudecode`** — wires the Claude Code integration in if you have Claude Code installed (idempotent / no-op otherwise).

After this, you have a fully working local AgenticMail with internal multi-agent coordination over `*@localhost`. Add an external Gmail relay or your own domain anytime with `agenticmail setup` (interactive).

#### Interactive install

```bash
npm install -g @agenticmail/cli
agenticmail setup
```

The wizard walks you through everything: dependency checks, master key generation, mail-server start, optional Gmail relay or custom domain, optional SMS setup, optional OpenClaw integration. Re-runnable any time.

### Skip external email entirely?

Yes. AgenticMail works in **local-only mode** — agents email each other at `*@localhost` through the bundled Stalwart server with full RFC-822 routing, threading, attachments, and search. That's all the Claude Code multi-agent flow needs. The external Gmail/domain relay is optional and only matters when you want agents to send mail to the public internet.

### What the wizard does for you

- Checks Node, Colima/Docker, brew/apt
- Generates a master API key (saved to `~/.agenticmail/config.json`, file mode 0600)
- Initialises the SQLite database (`node:sqlite` — Node 22+ built-in, **no native compilation, no prebuilt binaries needed**)
- Starts Stalwart in a Docker container
- Creates your first agent with its own email and API key
- Optionally configures a gateway (relay or domain) for internet email

### Send your first email (programmatic)

```typescript
import { AgenticMailClient } from '@agenticmail/cli';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3829',
  apiKey: 'ak_your_agent_api_key',
});

// Send an email
await client.send({
  to: 'colleague@example.com',
  subject: 'Hello from my AI agent',
  text: 'This email was sent by an AI agent using AgenticMail.',
});

// Check inbox
const inbox = await client.listInbox(10);
for (const msg of inbox) {
  console.log(`${msg.from} — ${msg.subject}`);
}

// Read a specific email
const email = await client.readMessage(inbox[0].uid);
console.log(email.text);
```

### Send your first email (CLI)

```
agenticmail> /send
To: someone@example.com
Subject: Test email
Body: Hello from the AgenticMail shell!

Email sent! Message ID: <abc123@localhost>
```

### Send your first email (curl)

```bash
curl -X POST http://127.0.0.1:3829/api/agenticmail/mail/send \
  -H "Authorization: Bearer ak_your_agent_key" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "someone@example.com",
    "subject": "Hello",
    "text": "Sent via the AgenticMail API."
  }'
```

---

## CLI Commands

AgenticMail includes a full CLI for managing your server. All commands are available via `agenticmail <command>` or `npx @agenticmail/cli@latest <command>`.

### Core Commands

| Command | Description |
|---------|-------------|
| `agenticmail` | **Start the server** (runs setup first if not initialized). Opens the interactive shell after startup. This is the default command — just run `agenticmail` with no arguments. |
| `agenticmail bootstrap` | ✨ **Zero-question install.** One-shot pipeline: setup + service install + claudecode wiring. Designed for AI agents (Claude Code, scripts, CI) to run on a user's behalf — no prompts, no decisions. Skips Gmail relay and SMS setup (which need user-owned credentials); add them later with `agenticmail setup`. |
| `agenticmail setup` | **Run the setup wizard** interactively. Walks you through system checks, account creation, service startup, email connection (Gmail/Outlook/custom domain), phone number setup, and OpenClaw integration. Pass `--yes` (or `-y`, `--non-interactive`) to skip every prompt and use safe defaults. Safe to re-run — won't overwrite existing config. |
| `agenticmail start` | **Start the server** and open the interactive shell. Ensures Docker is running, Stalwart is up, and the API server is reachable. Automatically installs the auto-start service if not already set up. |
| `agenticmail shell` | 👀 **Drop into the interactive shell against an already-running server.** Use this to monitor every agent's inbox, send mail on their behalf, watch the dispatcher event feed, or run any of the 44+ shell commands. Exits cleanly with `/exit`; the server keeps running. Best command to point a user at when they ask "what have my agents been doing?" |
| `agenticmail web` | 🌐 **Open the Gmail-style web UI in your browser.** Two-column layout (sidebar with Compose + folders / content pane), 24×24 vector icons, hash router, real-time SSE updates, full markdown rendering, compose + reply with the `wake` parameter surfaced as a field. Same master key as the API. Available at `http://127.0.0.1:3829/` whenever the API server is running. |
| `agenticmail stop` | **Stop the server.** Kills the background API server process. If auto-start is enabled, it will restart on next boot. Use `agenticmail service uninstall` to fully disable. |
| `agenticmail status` | **Show what's running.** Displays the status of Docker, Stalwart, the API server, email connection, and auto-start service. |

### Integration Commands

| Command | Description |
|---------|-------------|
| `agenticmail openclaw` | **Set up AgenticMail for OpenClaw.** Starts infrastructure, creates an agent, configures the OpenClaw plugin, enables agent auto-spawn via hooks, and restarts the OpenClaw gateway. |
| `agenticmail claudecode` | ✨ **Set up AgenticMail for Claude Code.** Provisions a dedicated "claudecode" bridge agent, writes an MCP server entry to `~/.claude.json`, generates a Claude Code subagent file per AgenticMail agent under `~/.claude/agents/`, and starts the dispatcher daemon (PM2-managed) that auto-wakes agents on inbound mail or `/tasks/rpc`. No separate Anthropic key needed — workers ride on your existing Claude OAuth. Flags: `--status`, `--remove`, `--purge-bridge`. See [@agenticmail/claudecode on npm](https://www.npmjs.com/package/@agenticmail/claudecode) for the full design. |

### Service Management (Auto-Start)

AgenticMail installs a system service so it automatically starts when your computer boots. On macOS this is a LaunchAgent; on Linux it's a systemd user service.

| Command | Description |
|---------|-------------|
| `agenticmail service` | **Show auto-start status.** Displays whether the service is installed and running. |
| `agenticmail service install` | **Install the auto-start service.** AgenticMail will start automatically on boot. The startup script waits up to 10 minutes for Docker to be ready, then checks that Stalwart is running (starts it if needed), then launches the API server. |
| `agenticmail service uninstall` | **Remove the auto-start service.** AgenticMail will no longer start on boot. |
| `agenticmail service reinstall` | **Reinstall the service.** Use this after config changes or updates to refresh the service file. |

**What happens on reboot:**
1. Your computer starts → Docker Desktop launches (its own auto-start)
2. Stalwart mail server starts (`restart: unless-stopped` in Docker)
3. AgenticMail startup script waits for Docker to be ready (up to 10 min)
4. Script verifies Stalwart is running (auto-starts it if Docker restarted without it)
5. API server starts and begins accepting requests

If the API server crashes, the system service automatically restarts it.

### Maintenance Commands

| Command | Description |
|---------|-------------|
| `agenticmail update` | **Update to the latest version.** Checks npm for a new version, updates the CLI and OpenClaw plugin, and restarts the OpenClaw gateway if applicable. |
| `agenticmail help` | **Show available commands.** |

### Logs

Server logs are stored in `~/.agenticmail/logs/`:
- `server.log` — API server stdout
- `server.err.log` — API server stderr
- `startup.log` — Boot sequence log (Docker wait times, Stalwart checks)

---

## Gateway Modes

AgenticMail supports two modes for sending/receiving real internet email:

### Relay Mode (Beginner-Friendly)

Use your existing Gmail or Outlook account as a relay. No domain purchase needed. Setup takes under 2 minutes.

**How it works:**
- Outbound: emails sent via your Gmail/Outlook SMTP as `you+agentname@gmail.com`
- Inbound: AgenticMail polls your Gmail/Outlook IMAP for new messages addressed to `you+agentname@gmail.com` and delivers them to the agent's local mailbox
- Gmail's `+` sub-addressing routes replies back to the right agent

**Setup:**
```bash
# In the interactive shell:
agenticmail> /relay

# Or via API:
curl -X POST http://127.0.0.1:3829/api/agenticmail/gateway/relay \
  -H "Authorization: Bearer mk_your_master_key" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gmail",
    "email": "you@gmail.com",
    "password": "xxxx xxxx xxxx xxxx"
  }'
```

**Requirements:**
- Gmail: [App password](https://myaccount.google.com/apppasswords) (not your regular password)
- Outlook: App password from Microsoft account security settings

### Domain Mode (Advanced)

Full custom domain with Cloudflare. Agents send from `agent@yourdomain.com` with proper email authentication.

**What gets configured automatically:**
- Cloudflare DNS zone creation
- MX records pointing to Cloudflare Email Routing
- SPF record (`v=spf1 include:_spf.mx.cloudflare.net ~all`)
- DKIM key generation and TXT record
- DMARC record (`v=DMARC1; p=quarantine`)
- Cloudflare Tunnel (CNAME record, ingress rules)
- Cloudflare Email Worker deployment (catches all inbound email)
- Catch-all Email Routing rule → Worker → AgenticMail inbound endpoint
- Stalwart hostname, DKIM signing, domain principal
- `@domain` email aliases for all existing agents
- Optional: Gmail SMTP outbound relay, domain purchase

**Setup:**
```bash
curl -X POST http://127.0.0.1:3829/api/agenticmail/gateway/domain \
  -H "Authorization: Bearer mk_your_master_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cloudflareToken": "your_cf_api_token",
    "cloudflareAccountId": "your_cf_account_id",
    "domain": "yourdomain.com",
    "gmailRelay": {
      "email": "you@gmail.com",
      "appPassword": "xxxx xxxx xxxx xxxx"
    }
  }'
```

**Cloudflare API token permissions needed:**
- Zone: DNS (Edit), Email Routing (Edit)
- Account: Cloudflare Tunnel (Edit), Workers Scripts (Edit), Registrar (Edit — only if purchasing domains)

---

## Packages

This is a TypeScript monorepo. Seven packages, each shipped to npm independently.

| Package | Description | Install |
|---------|-------------|---------|
| [`@agenticmail/cli`](./agenticmail) | CLI, setup wizard, interactive shell. Install this to get started. | `npm i -g @agenticmail/cli` |
| [`@agenticmail/core`](./packages/core) | Core SDK — accounts, SMTP/IMAP, gateway, spam filter, outbound guard, storage | `npm i @agenticmail/core` |
| [`@agenticmail/api`](./packages/api) | Express REST API server with 75+ endpoints | `npm i @agenticmail/api` |
| [`@agenticmail/mcp`](./packages/mcp) | MCP server with 60+ tools for any MCP-compatible AI client | `npm i -g @agenticmail/mcp` |
| [`@agenticmail/claudecode`](./packages/claudecode) | Anthropic Claude Code integration — registers MCP server + native subagents + lifecycle hooks + dispatcher daemon | `npm i -g @agenticmail/claudecode` |
| [`@agenticmail/codex`](./packages/codex) | OpenAI Codex CLI integration — same architecture as `@agenticmail/claudecode`, adapted to Codex's TOML config and `spawn_agent` tool | `npm i -g @agenticmail/codex` |
| [`@agenticmail/openclaw`](./packages/openclaw) | OpenClaw plugin with 73 tools and skill definition | `openclaw plugin install agenticmail` |

**Plugin folders** (host marketplace manifests, separate from npm packages):

| Folder | Host | What's inside |
|---|---|---|
| [`plugin/`](./plugin) | Claude Code | `.claude-plugin/plugin.json` manifest + `.mcp.json` + skills. Ship target for Anthropic's plugin marketplace. |
| [`plugin-codex/`](./plugin-codex) | OpenAI Codex CLI | `.codex-plugin/plugin.json` manifest + `hooks/hooks.json` + `mcp_servers.toml` snippet + agent template. Ship target for Codex's plugin discovery (`~/.codex/plugins/`). |

**Dependency graph:**
```
@agenticmail/cli ──────> @agenticmail/api ────> @agenticmail/core
@agenticmail/mcp       (standalone — HTTP calls to API)
@agenticmail/claudecode (peer-dep on @anthropic-ai/claude-agent-sdk)
@agenticmail/codex      (peer-dep on @openai/codex-sdk)
@agenticmail/openclaw   (standalone — HTTP calls to API)
```

---

## API Overview

All endpoints are under `/api/agenticmail`. Authentication via `Authorization: Bearer <key>` header.

Two key types:
- **Master key** (`mk_...`) — full admin access (create/delete agents, approve blocked emails, gateway config)
- **Agent key** (`ak_...`) — scoped to one agent (read own inbox, send email, manage own drafts/contacts/etc.)

### Key Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| **Mail** | | | |
| `POST` | `/mail/send` | Agent | Send email (text, HTML, attachments) |
| `GET` | `/mail/inbox` | Agent | List inbox messages (paginated) |
| `GET` | `/mail/digest` | Agent | Inbox with body previews |
| `GET` | `/mail/messages/:uid` | Agent | Read full email with headers and attachments |
| `POST` | `/mail/search` | Agent | Search by from, subject, body, date |
| `POST` | `/mail/messages/:uid/move` | Agent | Move to folder |
| `POST` | `/mail/messages/:uid/spam` | Agent | Report as spam |
| `GET` | `/mail/folders` | Agent | List all folders |
| `GET` | `/mail/pending` | Both | List blocked outbound emails |
| `POST` | `/mail/pending/:id/approve` | Master | Approve blocked email |
| `POST` | `/mail/pending/:id/reject` | Master | Reject blocked email |
| **Accounts** | | | |
| `POST` | `/accounts` | Master | Create new agent |
| `GET` | `/accounts` | Master | List all agents with metadata |
| `GET` | `/accounts/me` | Agent | Get own agent info |
| `DELETE` | `/accounts/:id` | Master | Delete agent (with email archival) |
| `GET` | `/accounts/directory` | Both | Agent discovery directory |
| **Events** | | | |
| `GET` | `/events` | Agent | SSE stream — new email with route metadata, flags, expunge events |
| **Gateway** | | | |
| `GET` | `/gateway/status` | Both | Current gateway mode and health |
| `POST` | `/gateway/relay` | Master | Configure relay mode |
| `POST` | `/gateway/domain` | Master | Configure domain mode |
| `POST` | `/gateway/test` | Both | Send a test email |
| **Tasks** | | | |
| `POST` | `/tasks/assign` | Both | Assign task to another agent |
| `POST` | `/tasks/rpc` | Both | Synchronous agent-to-agent RPC (long-poll) |
| `GET` | `/tasks/pending` | Agent | List tasks assigned to me |
| `POST` | `/tasks/:id/claim` | Agent | Claim a pending task |
| `POST` | `/tasks/:id/result` | Agent | Submit task result |

Plus endpoints for drafts, contacts, tags, rules, signatures, templates, scheduled emails, spam management, batch operations, domains, and agent deletion/cleanup.

See the [API package README](./packages/api) for complete endpoint documentation.

---

## MCP Integration

The MCP server exposes 80+ tools to any MCP-compatible AI client via stdio transport.

### Setup

Add to your MCP client configuration (e.g., `.mcp.json` or project settings):

```json
{
  "mcpServers": {
    "agenticmail": {
      "command": "npx",
      "args": ["agenticmail-mcp"],
      "env": {
        "AGENTICMAIL_API_URL": "http://127.0.0.1:3829",
        "AGENTICMAIL_API_KEY": "ak_your_agent_key"
      }
    }
  }
}
```

### Desktop Clients

For desktop AI applications, add the same configuration to your app's MCP config file (check your app's documentation for the file location).

### What your AI can do

Once connected, your AI can:
- "Check my inbox" → `list_inbox`
- "Send an email to john@example.com about the project update" → `send_email`
- "Reply to that last email saying thanks" → `reply_email`
- "Search for emails from Sarah about the budget" → `search_emails`
- "Create a draft response to the client" → `manage_drafts`
- "What tasks are assigned to me?" → `check_tasks`
- "Ask the research agent to look up competitor pricing" → `call_agent`

See the [MCP package README](./packages/mcp) for the full tool list.

---

## Host Integrations

AgenticMail is host-agnostic at the protocol level (it's just SMTP/IMAP/HTTP/MCP under the hood), but each agentic CLI host expects its config + hooks + subagent definitions in a slightly different shape. We ship one **host integration package** per supported host. Each one:

1. Registers the AgenticMail MCP server in the host's config so the model can see all 60+ tools.
2. Surfaces every AgenticMail account as a native sub-agent the model can dispatch to.
3. Wires up the host's lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) so the agent gets a fresh-mail digest and capabilities preamble at the right moments.
4. Runs a long-lived **dispatcher daemon** that watches every account's inbox via SSE and spawns a one-shot model turn whenever new mail or a task arrives — so agents wake on each other's replies automatically without polling.

### Currently shipping

| Host | Package | Plugin folder | Status |
|---|---|---|---|
| Anthropic Claude Code | [`@agenticmail/claudecode`](./packages/claudecode) | [`plugin/`](./plugin) | **Shipping (0.2.x)** |
| OpenAI Codex CLI | [`@agenticmail/codex`](./packages/codex) | [`plugin-codex/`](./plugin-codex) | **Shipping (0.1.x)** |

Both integrations share the same dispatcher architecture (per-agent serialization, wake-coalesce, wake-budget, restart recovery, capabilities preamble). The host-specific bits are: config-file format (JSON vs TOML), subagent definition syntax (markdown+frontmatter vs TOML heredoc), and the SDK we drive workers through (`@anthropic-ai/claude-agent-sdk` vs `@openai/codex-sdk`).

### Picking the right install path

| You want… | Run |
|---|---|
| **One-line setup for Claude Code** | `npm install -g @agenticmail/cli && agenticmail claudecode` |
| **One-line setup for Codex** | `npm install -g @agenticmail/codex && agenticmail-codex install` |
| **Install both side-by-side** | Run both — they don't conflict. Each writes to its own host's config; the AgenticMail accounts are shared. |
| **Marketplace install (Anthropic plugin store)** | Drop [`plugin/`](./plugin) into your Claude Code plugin directory and run `/agenticmail-install`. |
| **Marketplace install (Codex `~/.codex/plugins/`)** | Copy [`plugin-codex/`](./plugin-codex) to `~/.codex/plugins/agenticmail/`. |
| **Programmatic (your own provisioning script)** | `import { install } from '@agenticmail/claudecode'` or `'@agenticmail/codex'` — same shape, different host. |

### Cross-host coordination

The mail layer is the lingua franca. An agent running under Claude Code can email an agent running under Codex (or vice versa) using the exact same `send_email({ to, cc, wake })` MCP tool — the message lands in the target's inbox, the target's host-specific dispatcher picks it up, spawns the right kind of turn (Claude or Codex), and the agent replies-all to the thread. From the sender's perspective there's no API difference between "my teammate runs under the same host as me" and "my teammate runs under a different host." That's the whole point of routing through email instead of host-native peer messaging.

### Roadmap

| Host | Status | Notes |
|---|---|---|
| xAI Grok Build CLI | Researched — see [wiki](https://github.com/agenticmail/agenticmail/wiki/Integration-Grok-Build) | Blocked on getting a SuperGrok Heavy seat to validate the closed-beta config-file paths against the community CLI proxy. ~80% architectural overlap. |
| Nous Research Hermes Agent | Researched — see [wiki](https://github.com/agenticmail/agenticmail/wiki/Integration-Hermes) | Python-native plugin (`pip install hermes-agent-agenticmail`). ~75% architectural overlap with claudecode/codex. |

---

## OpenClaw Integration

Already have OpenClaw? Two steps:

```bash
# Step 1 — Install AgenticMail globally and run the setup wizard
npm install -g @agenticmail/cli && agenticmail setup
```

```bash
# Step 2 — Connect AgenticMail to your OpenClaw instance
agenticmail openclaw
```

That's it. The global install gives you the `agenticmail` command. The `openclaw` command will start the mail server, create an agent, and merge the plugin config into your `openclaw.json` automatically. Your OpenClaw agent now has its own email address.

### Manual Configuration

If you prefer to configure manually, add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "agenticmail": {
      "enabled": true,
      "config": {
        "apiUrl": "http://127.0.0.1:3829",
        "apiKey": "ak_your_agent_key",
        "masterKey": "mk_your_master_key"
      }
    }
  }
}
```

The plugin survives OpenClaw updates — plugin configuration lives in user config (`~/.openclaw/openclaw.json`), not in the OpenClaw source directory.

### Chat with Your AI Agent

Use `/chat` in the AgenticMail shell to talk directly to your OpenClaw agent in real-time:

```
╭───────────────────────────────────────────────╮
│ ❯ what's the weather in NYC?                  │
╰───────────────────────────────────────────────╯
                                          You 👤
                                  ╭──────────────╮
                                  │ what's the   │
                                  │ weather in   │
                                  │ NYC?         │
                                  ╰──────────────╯
🎀 Fola
╭──────────────────────────────────────╮
│ Currently 42°F and cloudy in NYC.    │
╰──────────────────────────────────────╯
```

- WebSocket connection to OpenClaw gateway with Ed25519 device auth
- Bubble-style chat UI with markdown rendering
- Animated thinking indicator with elapsed timer
- Multi-line input (Enter sends, `\` + Enter for new lines)

### Smart Sub-Agent Spawning

The `call_agent` tool intelligently spawns sub-agents:

- **Auto mode detection** — light (simple tasks), standard (web research), full (multi-agent coordination)
- **Dynamic timeouts** — 60s / 180s / 300s based on complexity
- **Dynamic tool discovery** — probes OpenClaw config at runtime instead of static deny lists
- **Async mode** — `call_agent(async=true)` for long-running tasks. The caller polls `/tasks/assigned` for completion; the assigned agent **emails the result back to the caller** when it has email capability enabled. In a localhost-only / no-relay setup the result still lands in the caller's local mailbox, so check `/mail/inbox` if you don't see an SMTP delivery.
- **Web search fallback** — uses DuckDuckGo when Brave API isn't configured

See the [OpenClaw package README](./packages/openclaw) for the full tool list.

---

## Interactive Shell

The CLI includes a full-featured interactive shell with 44 commands:

```
agenticmail> /inbox

  ★ 1  john@example.com          Project Update           2m ago
    2  sarah@example.com         Re: Budget Review        1h ago
    3  notifications@github.com  [repo] New issue #42     3h ago

  ─────────────────────────────────────────────────
  Page 1/3 ─ [←] prev [→] next [v] toggle previews [Esc] back

  Use ↑↓ arrow keys to select, Enter to read inline
```

**Key features:**
- Arrow key navigation with cursor selection
- Body preview toggle (press `v`)
- Inline email reading (press `Enter`)
- Unread markers (`★`)
- 3-retry input validation on all prompts
- Paginated views with `←`/`→` navigation

### Command Reference

```
Email:       /inbox /send /read /reply /forward /search /delete /save
             /thread /unread /archive /trash
Organize:    /folders /contacts /drafts /signature /templates /schedule /tag
Agents:      /agents /switch /deleteagent /deletions
Security:    /spam /rules /pending
Gateway:     /relay /digest /setup /status /openclaw
System:      /help /clear /exit
```

---

## Security

### Outbound Guard

Every outgoing email is scanned before sending. The guard detects:

| Category | Examples |
|----------|----------|
| API keys | `sk-...`, `AKIA...`, `ghp_...`, `sk_live_...` |
| Credentials | `password: ...`, `secret: ...`, `token: ...` |
| Private keys | `-----BEGIN RSA PRIVATE KEY-----` |
| PII | Social security numbers, credit card patterns |
| Internal data | Localhost URLs, internal IPs, config file contents |

When sensitive data is detected:
1. Email is **blocked** and saved to the `pending_outbound` table
2. Agent receives a response explaining what was blocked and why, with instructions to inform their owner
3. Owner (master key holder) is notified via email with the full blocked email content, security warnings, recipient, subject, and pending ID
4. Owner approves or rejects via the master key API (`POST /mail/pending/:id/approve` or `/reject`) or by replying to the notification email
5. Agents **cannot** approve or reject their own blocked emails — the approve/reject endpoints require the master key
6. Agents can only list and view their pending emails to check approval status
7. MCP and OpenClaw tools enforce this by rejecting approve/reject actions with a message directing agents to inform their owner
8. System prompt guidelines (OpenClaw) instruct agents to never attempt self-approval or rewrite emails to bypass detection

### Spam Filter

Inbound emails are scored against rule-based patterns:

| Category | Score Range | Examples |
|----------|-------------|----------|
| Phishing | 10-30 | Fake login pages, urgency language, spoofed senders |
| Scam | 15-25 | Nigerian prince, lottery winner, inheritance schemes |
| Malware | 20-30 | Suspicious attachments, executable links |
| Commercial | 5-15 | Unsolicited marketing, unsubscribe-heavy emails |
| Social engineering | 10-20 | Impersonation, authority pressure |

- Emails scoring >= 40 (configurable) are moved to Spam folder
- Emails scoring 20-39 get a warning flag
- Internal agent-to-agent emails skip spam filtering entirely
- Relay-rewritten emails (`@localhost` from, external replyTo) are always treated as external

### Authentication

- **Master key** — full admin access, required for agent creation/deletion, gateway config, email approval
- **Agent API keys** — scoped per-agent, can only access own inbox and send from own address
- **Inbound webhook secret** — authenticates Cloudflare Email Worker requests to the inbound endpoint

---

## Configuration

### Environment Variables

```bash
# === Required ===
AGENTICMAIL_MASTER_KEY=mk_your_key          # Master API key (generate: openssl rand -hex 32)

# === Stalwart Mail Server ===
STALWART_ADMIN_USER=admin                   # Stalwart admin username
STALWART_ADMIN_PASSWORD=changeme            # Stalwart admin password
STALWART_URL=http://localhost:8080          # Stalwart HTTP admin URL

# === SMTP/IMAP (local Stalwart) ===
SMTP_HOST=localhost                         # SMTP host
SMTP_PORT=587                               # SMTP submission port
IMAP_HOST=localhost                         # IMAP host
IMAP_PORT=143                               # IMAP port

# === Optional ===
AGENTICMAIL_API_PORT=3829                   # API server port (default: 3829 — chosen to
                                            # avoid 3000/3100/3200/3300/4000/5000/8000/8080
                                            # which are all common dev-tool defaults)
AGENTICMAIL_API_HOST=127.0.0.1              # API bind host (default: 127.0.0.1; loopback only)
AGENTICMAIL_DATA_DIR=~/.agenticmail         # Data directory for SQLite DB and config

# === Realtime Voice (optional) ===
OPENAI_API_KEY=sk-...                       # Enables the realtime voice bridge — bridges a
                                            # phone mission to an OpenAI Realtime session.
                                            # Without it, calls are call-control only.

# === Gateway: Relay Mode ===
RELAY_PROVIDER=gmail                        # gmail or outlook
RELAY_EMAIL=you@gmail.com                   # Your email address
RELAY_PASSWORD=xxxx xxxx xxxx xxxx          # App password

# === Gateway: Domain Mode ===
CLOUDFLARE_API_TOKEN=your_token             # Cloudflare API token
CLOUDFLARE_ACCOUNT_ID=your_account_id       # Cloudflare account ID
AGENTICMAIL_DOMAIN=yourdomain.com           # Your domain
AGENTICMAIL_INBOUND_SECRET=your_secret      # Shared secret for Email Worker

# === Gmail SMTP Relay (domain mode outbound) ===
GMAIL_RELAY_EMAIL=you@gmail.com             # Gmail address for outbound relay
GMAIL_RELAY_APP_PASSWORD=xxxx xxxx xxxx     # Gmail app password

# === Debug ===
# AGENTICMAIL_DEBUG=1                       # Enable verbose per-message logging
```

### Docker Compose

```yaml
# docker-compose.yml (included in repo)
services:
  stalwart:
    image: stalwartlabs/stalwart:latest
    container_name: agenticmail-stalwart
    ports:
      - "8080:8080"   # HTTP Admin + JMAP
      - "587:587"     # SMTP Submission
      - "143:143"     # IMAP
      - "25:25"       # SMTP Inbound
    volumes:
      - stalwart-data:/opt/stalwart
      - ~/.agenticmail/stalwart.toml:/opt/stalwart/etc/stalwart.toml:ro
    restart: unless-stopped
```

### SQLite Database

AgenticMail stores all state in a SQLite database at `~/.agenticmail/agenticmail.db`. As of `@agenticmail/core@0.7.x` we use Node's built-in **`node:sqlite`** module (stable since Node 22) instead of `better-sqlite3`. The migration removed all native compilation from the install path — no `node-gyp`, no prebuilt-binary version-mismatch issues, no Python prerequisites. The on-disk database format is unchanged (it's still SQLite 3), so existing `~/.agenticmail/agenticmail.db` files continue to work without migration.

Tables:

- `agents` — agent accounts (name, email, API key, metadata)
- `gateway_config` — relay or domain mode configuration
- `pending_outbound` — blocked emails awaiting approval
- `delivered_messages` — deduplication tracking for inbound relay
- `spam_log` — spam scoring history
- `agent_tasks` — inter-agent task assignments
- `email_rules` — per-agent email filtering rules
- `contacts`, `drafts`, `signatures`, `templates`, `scheduled_emails`, `tags`

---

## Development

### Setup

```bash
git clone https://github.com/agenticmail/agenticmail.git
cd agenticmail
npm install
docker compose up -d
npm run build
npm test
```

### Project Structure

```
agenticmail/
├── agenticmail/           # CLI facade package (npm: agenticmail)
│   └── src/
│       ├── cli.ts         # CLI entry point (setup, start, status)
│       ├── shell.ts       # Interactive REPL (44 commands)
│       └── index.ts       # Re-exports from @agenticmail/core
├── packages/
│   ├── core/              # @agenticmail/core
│   │   └── src/
│   │       ├── accounts/  # Agent CRUD, roles, deletion
│   │       ├── mail/      # Sender, receiver, parser, spam filter, outbound guard
│   │       ├── inbox/     # IMAP IDLE watcher
│   │       ├── gateway/   # Relay, Cloudflare, DNS, tunnel, domain purchase
│   │       ├── stalwart/  # Stalwart admin API client
│   │       ├── storage/   # SQLite database, migrations, search index
│   │       ├── domain/    # Domain management
│   │       └── setup/     # Dependency checker, installer
│   ├── api/               # @agenticmail/api
│   │   └── src/
│   │       ├── app.ts     # Express app factory
│   │       ├── routes/    # 8 route modules (mail, accounts, events, etc.)
│   │       └── middleware/ # Auth, rate limiting, error handling
│   ├── mcp/               # @agenticmail/mcp
│   │   └── src/
│   │       ├── index.ts   # MCP server entry (stdio transport)
│   │       ├── tools.ts   # 80+ tool definitions and handlers
│   │       └── resources.ts
│   └── openclaw/          # @agenticmail/openclaw
│       ├── index.ts       # Plugin entry, system prompt
│       ├── src/tools.ts   # 73 tool definitions and handlers
│       └── skill/         # SKILL.md, reference docs, scripts
├── docker-compose.yml     # Stalwart mail server
├── .env.example           # Environment variable template
└── package.json           # Workspace root
```

### Build Commands

```bash
# Build all packages
npm run build

# Build a single package
cd packages/core && npx tsup src/index.ts --format esm --dts --clean

# Run all tests
npm test

# Run tests for a specific package
cd packages/core && npx vitest run
```

### Publish to npm

Publish in dependency order:

```bash
cd packages/core && npm publish
cd packages/api && npm publish
cd packages/mcp && npm publish
cd packages/openclaw && npm publish
cd agenticmail && npm publish
```

All scoped packages have `"publishConfig": { "access": "public" }` configured.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

---

## Telemetry

AgenticMail collects **anonymous** usage statistics to help improve the product. We track:

- Tool call counts (which tools are popular)
- Package version and OS platform
- Anonymous install ID (random UUID, no personal data)

**We never collect** API keys, email content, addresses, or any personal information.

**Opt out** by setting the environment variable:

```bash
export AGENTICMAIL_TELEMETRY=0
# or
export DO_NOT_TRACK=1
```

Telemetry is also automatically disabled in CI environments.

## Troubleshooting

### OpenClaw plugin ID mismatch warning

```
plugin id mismatch (manifest uses "agenticmail", entry hints "openclaw")
```

This is harmless. OpenClaw infers the plugin ID from the npm package name (`@agenticmail/openclaw`) but the manifest declares `"id": "agenticmail"`. The plugin loads and works correctly.

### OpenClaw plugin path not found

If OpenClaw reports the plugin path not found, update `plugins.load.paths` in `~/.openclaw/openclaw.json` to point to the correct location:

```bash
npm prefix -g
# Plugin is at: <prefix>/lib/node_modules/@agenticmail/openclaw
```

### `agenticmail: command not found`

Use `npx agenticmail` for one-off usage, or install globally with `npm install -g @agenticmail/cli`.

## License

[MIT](./LICENSE) - Ope Olatunji ([@ope-olatunji](https://github.com/agenticmail/agenticmail))
