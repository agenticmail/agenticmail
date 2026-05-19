# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.51] - 2026-05-19

### Added — universal per-agent memory

Every agent now has a persistent, evolving memory: categorised,
confidence-decaying, BM25F-searchable knowledge that survives across
every conversation — the way a human employee learns on the job.
Ported from the AgenticMail Enterprise memory engine and adapted for
the open-source single-tenant package (multi-tenant org concepts
removed — memory is personal to each agent; `node:sqlite`-backed).

- **`AgentMemoryManager`** (`@agenticmail/core`) — CRUD, text recall,
  9 memory categories, importance levels, confidence that decays for
  unaccessed entries, access tracking, pruning, and
  `generateMemoryContext()` which ranks + renders memory as a markdown
  block for prompt injection. Backed by a zero-dependency BM25F search
  index and an `agent_memory` table.
- **Memory API** — `/memory` (set / list / search / get / delete),
  `/memory/reflect`, `/memory/context`, `/memory/stats`. Every
  endpoint is scoped to the authenticated agent; an agent can only
  ever read or write its own memory.
- **MCP tools** — `memory`, `memory_reflect`, `memory_context`,
  `memory_stats` so any MCP client can give its agent durable memory.
- **Agent-deletion cleanup** — deleting an agent purges its
  `agent_memory` rows; no orphaned memory is left behind.

## [0.9.50] - 2026-05-19

### Added — phone call-control + realtime voice (#41–#46)

A new capability series from @benediktkraus: AI agents can place and
control real outbound phone calls via 46elks, plus realtime-voice
protocol primitives. ~9,600 lines across six PRs, reviewed by a
two-agent audit (security + hardening) before merge — no backdoors,
no exfiltration, no hardcoded secrets.

- **#41** — OpenClaw bridge mail can wake a host session.
- **#42** — phone mission policy primitives (region allowlist,
  confirm-policy, fail-closed validation).
- **#43** — phone call-control mission API + 46elks integration.
- **#44** — phone call-control MCP + OpenClaw tool surface.
- **#45** — webhook replay/idempotency dedup.
- **#46** — 46elks realtime voice protocol parse/build helpers.

### Security — call-control hardening folded in on merge

The call-control surface places real, billed phone calls, so the
abuse/cost controls flagged by the review were wired to enforcement
before release:

- **Rate + concurrency limits** on `/calls/start` — 5 calls/minute,
  30/hour per agent, max 3 concurrently-active missions (HTTP 429
  when exceeded). Dry runs are exempt.
- **Server-side policy ceilings** the caller cannot raise —
  `maxCallDurationSeconds ≤ 3600`, `maxCostPerMission ≤ 5`,
  `maxAttempts ≤ 3`. A caller policy may be stricter, never looser.
- **Per-mission webhook token** — the 46elks webhook URL carries an
  HMAC-SHA256(secret, missionId) token instead of the raw shared
  secret. A leaked URL exposes one mission, not all, and the secret
  stays out of access logs.
- **Uniform webhook 403** — an unknown mission and a wrong token
  return an identical 403 + body, closing the 404-vs-403 enumeration
  oracle.
- **Webhook-secret entropy floor** — agent-supplied secrets must be
  at least 24 characters.
- **Fail-closed** — a thrown provider request transitions the mission
  to `failed` instead of leaving it stuck in `dialing`; the
  voice-start webhook can no longer resurrect a terminal mission;
  the carrier call timeout is capped at 1h.
- The free-text call `task` is control-character-stripped and
  length-capped at 2000.

## [0.9.49] - 2026-05-19

### Fixed

- **Local mail sending broke under the v0.9.46 TLS hardening.**
  GHSA-wjjv-3mj2-39hf made `MailSender` TLS certificate verification
  the default. Correct for remote servers — but the bundled local
  mail server (Stalwart on `127.0.0.1`) presents a self-signed
  certificate, so verification always failed and local agent-to-agent
  mail stopped working out of the box on self-hosted deployments
  (`API error 500: self-signed certificate`). `MailSender` now
  resolves `rejectUnauthorized` per host: loopback hosts
  (`localhost`, `127.0.0.0/8`, `::1`, `*.localhost`) default to
  verification OFF — a self-signed cert on a loopback address is not a
  meaningful MITM surface — while remote hosts still verify by
  default. An explicit `tlsRejectUnauthorized` option overrides either
  way. Exposed as `resolveTlsRejectUnauthorized` / `isLoopbackMailHost`
  for reuse.

## [0.9.48] - 2026-05-18

### Added

- **Soft-stop / resume for agents (`stop_agent`, `resume_agent`).** Two
  new MCP tools and matching REST endpoints
  (`POST /accounts/:id/stop`, `POST /accounts/:id/resume`) let an
  operator halt an agent mid-task *without deleting it*. The
  dispatcher then refuses to wake the agent for ANY reason — wake
  allowlists, To/Cc routing, task events all silently no-op — while
  mail keeps landing in the agent's mailbox so the thread's audit
  trail stays intact. This is the non-destructive counterpart to
  `delete_agent`: stops a churning sub-agent without losing its inbox
  or the thread history.

  Implementation:

  - Schema migration `017_agent_stopped.sql` adds `stopped`,
    `stopped_at`, `stopped_reason` columns to `agents` (additive,
    back-compat; pre-017 rows default to not-stopped).
  - `KnowledgeBaseEngine`/dispatcher-style wake gate fires *before*
    the thread-closed and wake-allowlist gates in both the
    `@agenticmail/claudecode` and `@agenticmail/codex` dispatchers.
    The mail SSE channel stays open while stopped, so resuming
    immediately picks up any mail that arrived during the pause.
  - The dispatcher also subscribes to `account_stopped` /
    `account_resumed` system events so the in-memory flag flips
    sub-second after the API call — no need to wait for the 30 s
    account-sync poll.
  - `list_agents` now shows a `[STOPPED]` tag on soft-stopped
    accounts so the state is visible without a separate fetch.
  - Both tools are master-key scoped (same authority as
    `delete_agent`) and respect host ownership — a Claude Code host
    cannot stop a Codex-owned teammate and vice versa.

  Use `stop_agent({ name, reason? })` to pause; use
  `resume_agent({ name })` to clear the flag. The `stopped_at` and
  `stopped_reason` audit fields are preserved across resume so
  operators can see the most-recent stop history on the agent row.

## [0.9.47] - 2026-05-18

### Changed

- **Shared bridge-wake routing** (#38, @benediktkraus) — the
  skip-live / escalate / resume decision for bridge mail is
  consolidated into `planBridgeWake` in `@agenticmail/core`; the
  Claude Code and Codex dispatchers call it instead of inlining the
  logic. Pure refactor — behavior and dispatcher activity payloads
  unchanged.
- **OpenClaw host-session capture** (#39, @benediktkraus) — the
  OpenClaw operator session is now recorded into the shared
  host-session registry, classified `wake-only` (OpenClaw has no
  durable SDK resume primitive). Sub-agent and mail-channel session
  keys are explicitly excluded so only the real operator session is
  captured.
- **Actionable relay credential errors** (#40, @benediktkraus) —
  Gmail/Outlook authentication, app-password, and OAuth/token-expiry
  failures are now classified separately from generic network/TLS/DNS
  errors, and every SMTP/IMAP error site (verify, send, poll, search,
  fetch) is wrapped with actionable reconnect guidance instead of an
  opaque stack message.

### Security

- **Relay error logs redact SASL credentials** (#40 follow-up). The
  relay error formatter renders raw error fields (`response`,
  `command`, `stderr`). If an SMTP/IMAP library ever surfaced an error
  echoing an AUTH exchange, the base64 credential could ride into a
  log line. `redactCredentialTokens` now masks the payload after an
  `AUTH`/`AUTHENTICATE` SASL verb, keeping the verb + mechanism
  visible for triage while redacting the secret.

## [0.9.46] - 2026-05-18

### Security — GHSA-wjjv-3mj2-39hf (HIGH)

API/storage and outbound-relay hardening. Reported and patched by
@benediktkraus via private vulnerability disclosure; maintainer
hardening folded in on merge. **All deployments should upgrade.**

- **Hardcoded outbound-relay secret removed** (CWE-798). The Cloudflare
  outbound worker shipped `OUTBOUND_SECRET = "outbound_2sabi_secret_key"`
  in `metadata.json`, and `outbound.js` used the same literal as a
  fallback — so anyone who read the public repo held the relay secret.
  The binding and the fallback are gone; the worker now refuses to
  start (HTTP 500) unless `OUTBOUND_SECRET` is configured. **Operators
  who deployed the worker must rotate `OUTBOUND_SECRET`.**
- **SQL injection in the storage routes closed** (CWE-89). Raw
  identifier interpolation in `where` keys, `groupBy`, `orderBy`, and
  index/column/conflict identifiers is now strictly validated against
  `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. The `having` clause — the one query
  clause still interpolated raw — is now length-bounded and rejects
  stacked statements, comment markers, and DDL/DML keywords.
- **Cross-agent storage access closed** (CWE-284). Raw `/storage/sql`
  now resolves every referenced table against the storage-metadata
  ownership records (comma-joins included) and denies tables owned by
  other agents; direct access to the metadata table itself is blocked.
- **TLS certificate verification on by default** (CWE-319).
  `MailSender` previously set `rejectUnauthorized: false`
  unconditionally — every SMTP connection accepted any certificate.
  Verification is now the default, with an explicit
  `tlsRejectUnauthorized: false` opt-out for local development.
- **SMTP envelope/header injection blocked** (CWE-20). The outbound
  worker now rejects CR/LF and control characters in envelope
  addresses and headers before building SMTP commands.
- **Inactive-agent hour filtering validated** (CWE-20). `/accounts/inactive`
  and `/accounts/cleanup` now validate the `hours` parameter as a
  positive integer and bind it as a query parameter.

Patched versions: `@agenticmail/api@0.9.32`, `@agenticmail/core@0.9.10`
(and the packages that depend on them).

### Changed

- **Host session registry widened** (#36, @benediktkraus) — `HostName`
  now covers `openclaw`/`gemini`/`hermes`; `HostSession` gains optional
  `resumeMode` and `hostMetadata` fields.
- **Bridge wake primitives shared** (#37, @benediktkraus) — the
  duplicated bridge-wake logic in the Claude Code and Codex adapters
  (`composeBridgeWakePrompt`, error classification, the live-operator
  window) is consolidated into a shared `@agenticmail/core` module.
  Pure refactor, no behavior change.

## [0.9.45] - 2026-05-18

### Added — EU SMS provider registry + 46elks

Community contribution from @benediktkraus ([#35](https://github.com/agenticmail/agenticmail/pull/35)).

- **Provider registry** — SMS is now provider-backed. Google Voice
  remains the default legacy provider; 46elks is the first direct-API
  provider. `sms_setup` takes a `provider` argument across REST, MCP,
  and OpenClaw.
- **46elks integration** — direct outbound SMS through the 46elks API
  (HTTP Basic auth, form-encoded), and a secret-protected inbound SMS
  webhook (`POST /sms/webhook/46elks`) mounted before bearer auth.
- **Credential redaction** — `GET /sms/config` and every setup
  response now run through `redactSmsConfig`, so provider passwords
  and webhook secrets never appear in API output.

### Security — hardening applied during review of #35

The feature was audited before merge; no malicious code was found.
The following defense-in-depth changes were added on top:

- **SMS credentials encrypted at rest.** The 46elks API password, the
  inbound-webhook shared secret, and the Google Voice forwarding-mailbox
  app password were being stored as plaintext in agent metadata.
  `SmsManager` now encrypts those fields with the same AES-256-GCM +
  scrypt scheme `GatewayManager` already uses for relay/domain
  credentials. The cipher helpers were extracted into a shared
  `crypto/secrets` module so both managers use one audited
  implementation. Reads tolerate legacy plaintext, so the upgrade is
  seamless; a leaked SQLite file no longer hands over working
  provider credentials.
- **Webhook number-enumeration oracle closed.** The inbound webhook
  returned `404` for an unknown recipient number but `403` for a wrong
  secret — letting an unauthenticated caller probe which phone numbers
  are registered. It now returns a single uniform `403` for every
  failure mode (unknown number, no configured secret, missing or wrong
  secret). The secret check uses `timingSafeEqual`.
- **`apiUrl` override forced to https.** A 46elks `apiUrl` override is
  the endpoint the outbound call sends Basic-Auth credentials to.
  `/sms/setup` now rejects any non-`https://` override, and the
  provider re-checks the scheme at send time — credentials can't be
  exfiltrated over plaintext or pointed at an arbitrary internal host.
- **Webhook secret moved out of the URL.** Setup guidance now tells
  operators to authenticate the inbound webhook with the
  `x-46elks-secret` header (kept out of access logs); the query-param
  form is documented only as a fallback for providers that can't send
  custom headers.

## [0.9.39] - 2026-05-15

### Fixed — three rough edges from 0.9.38's `setup-email` shakedown

User reports during operator testing of the new `agenticmail setup-email` flow:

**1. Node SQLite ExperimentalWarning leaks all over the CLI.** Every invocation of any subcommand printed two lines of `(node:NNNNN) ExperimentalWarning: SQLite is an experimental feature and might change at any time` because `@agenticmail/core` uses Node's built-in `node:sqlite` and Node fires the warning when the module first loads. Operators didn't choose the storage engine and the warning is unactionable noise.

Fix: a new side-effecting module `agenticmail/src/suppress-experimental-warnings.ts` imported first in all three bin entries (`cli.ts`, `bin-claudecode.ts`, `bin-codex.ts`). It hooks `process.emit('warning', …)` and drops only the SQLite ExperimentalWarning — every other warning (deprecations, unhandled promises, user-opted experimental flags) passes through to Node's default printer. Has to be a separate module imported first because ESM hoists all imports before any module body runs; inline code at the top of `cli.ts` would fire after `@agenticmail/core` is already loaded.

**2. Typo'd email tore the whole flow down with a single-shot exit.** Operator typed `astrumsphere@gmail` (missing `.com`), got `✗ That doesn't look like a valid email address`, and the process exited. Forced a full re-run.

Fix: email prompt now loops up to 5 times with a stricter shape check (`^[^\s@]+@[^\s@]+\.[^\s@]+$` — catches missing TLDs). Same pattern for the password prompt — empty input re-prompts up to 3 times instead of exiting on the first miss.

**3. SMTP/IMAP verification timed out at 30 s, fatal exit.** Gmail's first-time IMAP handshake on a slow link can take 30–60 s (TLS negotiation + mailbox enumeration). The 30 s `AbortSignal.timeout(30_000)` we copied from `setup-relay` was too tight; operators on coffee-shop Wi-Fi hit `Setup-email failed: The operation was aborted due to timeout` and had to re-run from scratch.

Fix: bumped timeout to 90 s. AND on `AbortError` / `TimeoutError`, the password loop offers a retry instead of exiting (since a flaky link doesn't mean the password is wrong). Auth errors still retry within the password loop — they did before; this entry's just for the non-auth timeout path.

### Files

- `agenticmail/src/suppress-experimental-warnings.ts` — new side-effect module that hooks `process.emit` and drops the SQLite warning specifically. Wrapped in a block scope so no module-level binding leaks into the type-declaration output (avoids TS4023).
- `agenticmail/src/cli.ts` — added `import './suppress-experimental-warnings.js';` as the first import. Replaced single-shot exits in `cmdSetupEmail` with email loop (5 attempts) and password loop (3 attempts). Bumped relay fetch timeout 30 s → 90 s. On timeout/abort, password loop retries instead of exiting.
- `agenticmail/src/bin-claudecode.ts`, `agenticmail/src/bin-codex.ts` — added the same first-import of the suppression module so the host-bin shims don't leak the warning either.
- `agenticmail/package.json` — version → 0.9.39.

## [0.9.38] - 2026-05-15

### Added — `agenticmail setup-email`: two-question relay setup, any provider

User feedback on 0.9.37's `setup-relay`: it kicks straight into the full interactive flow (provider menu → email → app-password URL → custom-host branch → agent-name prompt → password). For an operator who already knows their email and has an app password ready, that's six steps to type one credential pair. They asked for a minimal alternative: "simply just collect the email either gmail or outlook or domain and it should simply verify the connection to make sure it works and call it a day".

Fix: a new `agenticmail setup-email` subcommand (aliases: `email`, `connect-email`) that asks **only** for email + password and auto-detects everything else from the domain.

### What it does

1. Loads `~/.agenticmail/config.json` (errors out clearly if AgenticMail isn't bootstrapped).
2. Ensures the API is reachable — if not, starts it in the background before collecting credentials.
3. Asks for the email address.
4. Auto-detects the provider:
   - `@gmail.com` / `@googlemail.com` → `gmail`
   - `@outlook.com` / `@hotmail.com` / `@live.com` / `@msn.com` → `outlook`
   - Anything else → asks "Google Workspace / Microsoft 365 / Custom SMTP?" — only the Custom branch prompts for SMTP/IMAP hosts (port defaults: 587 / 993).
5. Asks for the password via hidden stdin (raw-mode `*`-masked, spaces stripped — Gmail copy/paste app passwords like `mhuc ofou naky pnmq` work as-is).
6. POSTs `provider, email, password, agentName, smtpHost?, smtpPort?, imapHost?, imapPort?` to `/api/agenticmail/gateway/relay`. The endpoint verifies SMTP + IMAP auth before persisting — invalid credentials get rejected by the provider, not stored.
7. Reuses the first existing agent name on the box (skipping `claudecode` / `codex` bridges), so re-running the command after an install doesn't spawn a duplicate "secretary".

### What it deliberately doesn't do

- Doesn't show the provider menu when the domain is unambiguous (Gmail / Outlook). One less question.
- Doesn't ask for an agent name. The bootstrap or the existing relay already created one; re-asking is noise.
- Doesn't retry on auth failure. If the password is wrong, fail fast and tell the operator to re-run. The interactive `setup-relay` retry loop assumed the operator was typing the password from memory — `setup-email` assumes a copy/paste workflow where retries don't help.
- Doesn't try to auto-discover non-Google/Microsoft mail servers. SRV-record autodiscover would help maybe 10% of custom-domain operators and adds a network probe that fails silently on the rest. Operators on bespoke setups type SMTP/IMAP hostnames themselves.

### What it does NOT replace

`setup-relay` (the original full-interactive flow) is unchanged. It stays as-is for operators who want the provider menu, custom agent-naming, and per-attempt retry loop. `setup-email` is the short path; `setup-relay` is the long path. Both write to the same `/gateway/relay` endpoint with the same shape.

### Files

- `agenticmail/src/cli.ts` — added `cmdSetupEmail()` (~140 lines); wired `setup-email` / `email` / `connect-email` cases into the main dispatcher; added a help-listing entry. `cmdSetupRelay` untouched.
- `agenticmail/package.json` — version → 0.9.38.
- `AGENTS.md` — relay section now points host agents at `setup-email` as the canonical script ("Run `agenticmail setup-email` in your terminal…"). `setup-relay` mentioned as the longer alternative.

## [0.9.37] - 2026-05-15

### Added — `agenticmail setup-relay` so operators add Gmail without exposing the password to an agent

User report (correct): "will the agent see my password? thats bad..." — referring to the suggestion that an operator tell their host agent "set up the Gmail relay, password is xxx-xxx-xxx". That puts the credential into the LLM's context window, log output, and conversation history.

Fix: a focused `agenticmail setup-relay` CLI subcommand the operator runs in their OWN terminal. Password is collected via hidden-input stdin (raw-mode, `*`-masked) and never leaves the process. The agent never sees it.

### What it does

1. Loads `~/.agenticmail/config.json` (errors out with a clear message if AgenticMail isn't bootstrapped yet).
2. Reuses the existing `setupRelay()` helper that the main bootstrap uses, so the credential-handling code path is identical — interactive prompts for provider, email, agent name, then hidden-input password.
3. POSTs to `/api/agenticmail/gateway/relay`. Retry loop on auth failure (3 attempts) so a typo'd app password doesn't force a full restart.
4. Prints a pointer to `setup_operator_email` as the natural next step.

### AGENTS.md updated

Host-agent guidance now explicitly says **don't ask for the password**. The right script is:

> "Run `agenticmail setup-relay` in your terminal. It'll ask for your Gmail address and an app password (generate one at https://myaccount.google.com/apppasswords — needs 2FA). The password input is hidden — I won't see it. Tell me when it's done."

This pattern — agent suggests a CLI command, operator runs it, agent waits for "done" — is the recommended shape for any setup step that needs a credential.

### Versions

- `@agenticmail/cli@0.9.37`

(No other package versions changed — the relay endpoint already existed; the new piece is just the operator-facing CLI surface.)

### Upgrade

```bash
npm install -g @agenticmail/cli@latest
agenticmail setup-relay
```

You'll be prompted for your Gmail address (visible) and app password (hidden). After that:

- Tell your host agent: "set my operator notification email to ope@gmail.com"
- Or open the web UI → avatar → Alert email → type, Save

## [0.9.36] - 2026-05-15

### Added — Operator email surface in the web UI

Companion to 0.9.35's MCP tool — the same `operatorEmail` is now editable directly from the profile menu in the web UI without having to ask an agent. Visible on every profile-menu open, between the inbox list and the Sign out footer.

- **Display state**: shows the current address (or "Not set — sub-agent escalations stay in the web UI only" placeholder) with a small pencil affordance.
- **Edit state**: inline `<input>` + Save / Cancel / Clear buttons. Enter saves, Escape cancels. Inline hint copy explains what the address is for ("Dispatcher emails this address when sub-agents mail your host bridge and the resume can't run").
- **Cleared state**: setting the value to empty (or clicking Clear when one exists) removes the address — escalations stay in the web UI only.

Lazy-hydrates on first profile-menu open via `GET /system/operator-email`; saves via `PATCH /system/operator-email` (same endpoints the `setup_operator_email` MCP tool uses, so changes from the UI and changes from a host agent stay in sync immediately).

Server-side validation messages bubble up via the new `apiPatch` helper, so a malformed address ("not-an-email") shows "operator email must contain an @" rather than a bare 400.

### Versions

- `@agenticmail/api@0.9.27` — bundled web UI assets only (HTML/JS/CSS); no server-route change.
- `@agenticmail/cli@0.9.36` — picks up the new api.

## [0.9.35] - 2026-05-15

### Added — Operator-email escalation when bridge wake can't resume

0.9.34 added headless bridge-wake (dispatcher resumes host session when sub-agents mail the bridge). What was missing: when the resume CAN'T happen (no fresh session recorded, token expired, SDK missing), the only signal was a system event in the web UI — silent if the operator wasn't watching.

This release closes the loop. The dispatcher now forwards a digest to a configured operator email when escalation fires, so the operator gets a phone push via Gmail (or whatever app handles their address). No SMS provider, no third-party billing — just an email to whatever address the operator already has push notifications enabled for.

### How it works

1. Operator runs `setup_operator_email` via the host agent during bootstrap (or at any time later), passing their notification address.
2. Address is persisted to `~/.agenticmail/operator-prefs.json` (separate from `config.json` so the host agent can update it via MCP without touching the bootstrap-managed file).
3. When `/dispatcher/bridge-escalation` fires AND `operatorEmail` is set, the API server uses `gatewayManager.routeOutbound` to send a digest from the host's bridge agent to that address.
4. Digest carries: reason for escalation, sub-agent who sent, subject, UID, preview, and a pointer to "open AgenticMail web UI or run claude/codex to handle".

Best-effort: send failures (no relay configured, SMTP transient error) don't poison the escalation event. The system event still fires for the web UI.

### New MCP tool — `setup_operator_email`

```
mcp__agenticmail__setup_operator_email({ email: "ope@gmail.com" })
mcp__agenticmail__setup_operator_email({ email: "" })  // clear
```

Master-key scoped. Persists to `~/.agenticmail/operator-prefs.json` via the new `setOperatorEmail()` helper in `@agenticmail/core`. The web UI fetches the current value via `GET /system/operator-email` and the MCP tool writes via `PATCH /system/operator-email`.

### `AGENTS.md` update

The host agent (claudecode / codex) is now instructed to ask the operator for their notification email right after `bootstrap` finishes, BEFORE the dispatcher-tuning question. One sentence, one MCP call, done.

### Tests

8 new regression tests for `operator-prefs.ts` — round-trip, trim, clear, validation, corrupt-file recovery, update semantics. Catalogue audit updated to include the new MCP tool. 764 tests pass total (was 756).

### Versions

- `@agenticmail/core@0.9.7` — `operatorPrefs` module + 8 tests
- `@agenticmail/api@0.9.26` — `/system/operator-email` get/patch + `bridge-escalation` email forwarding
- `@agenticmail/mcp@0.9.8` — `setup_operator_email` tool
- `@agenticmail/claudecode@0.2.21` — picks up the new mcp transitively
- `@agenticmail/codex@0.1.16` — picks up the new mcp transitively
- `@agenticmail/cli@0.9.35` — rolls dependencies forward

### Upgrade

```
npm install -g @agenticmail/cli@latest
pkill -f '@agenticmail/api/dist/index.js' && agenticmail start
pm2 restart agenticmail-claudecode-dispatcher --update-env
pm2 restart agenticmail-codex-dispatcher --update-env
```

Then, inside `claude` or `codex`:

> "set my operator notification email to ope@gmail.com"

The host agent reads AGENTS.md, calls `setup_operator_email`, you're done. From the next bridge escalation onward, you'll get an email if the dispatcher can't resume your session.

## [0.9.34] - 2026-05-15

### Added — Headless bridge-wake: dispatcher resumes operator's host session when sub-agents mail the bridge

Real production gap fixed: sub-agents handing off TO the bridge inbox (`wake: ["codex"]` / `wake: ["claudecode"]`) used to be a silent dead-end whenever the operator's host CLI wasn't running. The dispatcher's `shouldWatch` skipped bridges by design — there was no way to spawn a host turn without an interactive session. Threads flatlined for hours waiting for the operator to come back.

Now the dispatcher can resume the operator's last session headlessly via the host SDK's resume API. New pieces:

**1. Host session persistence — `@agenticmail/core/host-sessions`**

`~/.agenticmail/host-sessions.json` records the operator's latest `session_id` per host. Updated on every mail-hook fire (`SessionStart` / `UserPromptSubmit` / `Stop`). Atomic write (tmp + rename), 24-hour freshness gate (matches both providers' resume-token TTLs), per-host isolation (claudecode vs codex).

15 regression tests in `packages/core/src/__tests__/host-sessions.test.ts`.

**2. Bridge-wake resolvers — `packages/{claudecode,codex}/src/bridge-wake.ts`**

- `resumeBridgeSession(query, { sessionId, prompt, cwd, mcpEnv })` — Claude Code: passes `resume: sessionId` through the SDK so the underlying CLI runs as `claude --resume <sid> -p <prompt>`.
- `resumeBridgeThread({ sessionId, prompt, cwd })` — Codex: `codex.resumeThread(id).runStreamed(prompt)`.
- Both share a `composeBridgeWakePrompt(bridge, uid, subject, from, preview)` helper that gives the resumed session a structured brief: "here's the one piece of bridge mail you're being woken to handle, decide and exit short."

**3. Dispatcher routing — `packages/{claudecode,codex}/src/dispatcher.ts`**

`shouldWatch` no longer hard-skips the host's own bridge — it now watches it AND routes new-mail events to `handleBridgeMail` instead of the normal `spawnWorker` path. Three short-circuits:

- If `lastSeenMs < 30s` → operator is at the keyboard, skip (their hook will surface).
- If no fresh session record → emit `/dispatcher/bridge-escalation` system event (loud notification surface).
- If resume fails with `session-expired` → forget the record + escalate.

In-flight dedup via `inFlightBridgeWakes` Set so an IMAP IDLE replay can't double-fire on the same UID.

**4. System-event surface — `packages/api/src/routes/dispatcher-activity.ts`**

Three new dispatcher routes:

- `POST /dispatcher/bridge-skipped` — operator was live, no action taken
- `POST /dispatcher/bridge-resumed` — headless wake succeeded
- `POST /dispatcher/bridge-escalation` — `urgent: true` system event for the web UI's notification badge

The web UI sound + browser notification already listen to `/system/events`, so a bridge escalation rings the operator immediately when the UI is open.

### Notes on SMS escalation (planned, not yet wired)

The architecture for full SMS escalation is in place — `bridge-escalation` is the event hook a future provider listens to. The actual SMS provider integration is a deliberate hold:

- The existing Google Voice flow requires browser automation to deliver, which a daemon can't do unattended.
- A Twilio-based hook (or APNs / Telegram) needs an operator-supplied credential + setup CLI.

That'll land in 0.10.x. For now the system event is the operator's notification channel, surfaced by the web UI.

### Bookkeeping

- `bridgeAgentName` now means "the bridge we DO watch headlessly" rather than "the bridge we skip" — comment headers updated to match.
- `selectExposableAgents` still excludes bridges from subagent file generation (correct — the host doesn't call itself).
- The "Handing off to the host bridge" persona section from 0.9.33 still applies; the rule "prefer routing to a teammate first" is good guidance even now that bridge handoffs work, because each headless turn still costs an API call.

### Versions

- `@agenticmail/core@0.9.6` — host-sessions module + 15 regression tests
- `@agenticmail/api@0.9.25` — bridge-skipped / bridge-resumed / bridge-escalation routes
- `@agenticmail/claudecode@0.2.20` — bridge-wake.ts + dispatcher integration
- `@agenticmail/codex@0.1.15` — bridge-wake.ts + dispatcher integration
- `@agenticmail/cli@0.9.34` — rolls dependencies forward

756 tests pass (up from 741 — +15 host-sessions).

### Upgrade

```
npm install -g @agenticmail/cli@latest
pkill -f '@agenticmail/api/dist/index.js' && agenticmail start
pm2 restart agenticmail-claudecode-dispatcher --update-env
pm2 restart agenticmail-codex-dispatcher --update-env
agenticmail-claudecode install
agenticmail-codex install --workspace ~/Desktop/facebook-project
```

After the upgrade, the next time you run `claude` or `codex` the hook fires and records your session_id. From that point on, sub-agents that hand off to the bridge will trigger a headless resume against your last session within a minute.

## [0.9.33] - 2026-05-15

### Fixed — handoffs to the host bridge silently dropped the chain

Real production behaviour observed in the Facebook Rebuild thread: sub-agents kept handing off TO the `codex` / `claudecode` bridges with `wake: ["codex"]`, then sat idle for hours. Reason: bridges are filtered by `shouldWatch` because they represent the operator's host session, not an automated worker. The dispatcher never spawns a turn for them. Mail to a bridge only surfaces when the operator's host CLI is actively running (via `Stop` / `UserPromptSubmit` hooks).

Without a running CLI, "Codex — over to you for next steps" = silent dead-end.

### Persona update in both host templates

Added a "Handing off to the host bridge" section that makes the rule explicit:

> The host bridge inboxes belong to the HUMAN OPERATOR's host session, not to an automated worker. The dispatcher DOES NOT spawn worker turns for them — they're surfaced to the operator via host-session hooks (Stop / UserPromptSubmit) when the operator's CLI is actively running. If no host session is open, mail to the bridge sits unread.

Plus five practical rules:

1. Don't use bridge handoffs as a default "punt the baton when you don't know what to do" move
2. Before handing off to the bridge, ask if a teammate could decide instead
3. Only escalate to the bridge when genuinely operator-only (billing, scope, architecture)
4. Mark the subject with `[NEEDS OPERATOR]` or `[BLOCKED]` so notification feeds catch it
5. `wake: ["claudecode"]` / `wake: ["codex"]` is fine as an intent signal — the dispatcher won't spawn a worker but the web UI's sound + system event still fire

Plus a worked correct example (operator-escalation with the right markers) and a worked WRONG example ("Shipped my slice. Codex — over to you for next steps." with `wake: ["codex"]`) so the model has a concrete contrast.

### Fixed — older thread quotes now show their original To/Cc/Bcc

The 0.9.32 fix added `To:` / `Cc:` / `Bcc:` lines to the quote header that NEW replies carry. Older replies in the inbox don't have those lines in the body, so their thread-quote header was still sender-only.

Fix: `message-view.js::buildAudienceLookup()` now builds a `sender + date → { to, cc, bcc }` map from the surrounding inbox-list messages (`state.messages`). The parser falls back to this lookup when the body doesn't have audience lines, so OLD quotes get their audience backfilled at render time from the sibling messages already in memory.

Match logic:

- Sender match: case-insensitive on the email address.
- Date match: parse both sides, pick the sibling with closest delta within 2 seconds. Fall back to most-recent-from-that-sender if no close match (handles quote headers that lost timezone info during serialisation).

Result: every quote in every open thread shows audience whether the reply was written before or after 0.9.32.

### Versions

- `@agenticmail/api@0.9.24`
- `@agenticmail/claudecode@0.2.19`
- `@agenticmail/codex@0.1.14`
- `@agenticmail/cli@0.9.33`

Persona update lands on existing subagent files only after running `agenticmail-claudecode install` / `agenticmail-codex install` again — that regenerates every subagent `.md` / `.toml` with the new persona text.

## [0.9.32] - 2026-05-15

### Fixed — thread-quote in the web UI was missing original To/Cc/Bcc

User report (screenshot): when reading an email thread in the web UI, the quoted previous message only showed the sender + date — no indication of who else was on the original message's To/Cc/Bcc. For multi-agent threads where five agents are CC'd and the next actor is signalled by the `wake` field, that's significant context loss.

The quote header that AgenticMail's reply builders write into the body has always been the single-line standard format:

```
On Fri May 15 2026 01:36:00, marlow@localhost wrote:
> Kepler — reviewed shared/api-contract.md...
```

Now extended to optionally carry the original audience as additional header lines BEFORE the `> ` body:

```
On Fri May 15 2026 01:36:00, marlow@localhost wrote:
To: kepler@localhost
Cc: codex@localhost, rivet@localhost
> Kepler — reviewed shared/api-contract.md...
```

Three reply builders updated to emit the new shape:

- `packages/mcp/src/tools.ts::reply_email`
- `packages/openclaw/src/tools.ts` reply path
- `packages/api/public/js/compose.js` web UI reply composer

One parser updated to consume it:

- `packages/api/public/js/message-view.js::renderBodyWithThreading` collects optional `To:`/`Cc:`/`Bcc:` lines after the `wrote:` header, hands them to `renderThreadQuote(..., audience)`, which surfaces them in the thread-quote chrome alongside the sender + date.

New CSS classes — `.thread-quote-audience`, `.thread-quote-audience-row`, `.thread-quote-audience-label`, `.thread-quote-audience-value` — keep the rows aligned with the sender name (past the avatar) and use the small-caps label style that matches Gmail's quote-header convention.

Backwards-compat: older replies (pre-0.9.32) that don't include audience lines degrade cleanly to the sender-only header. No data is lost; the UI just doesn't surface what isn't in the source.

### Versions

- `@agenticmail/api@0.9.23`
- `@agenticmail/mcp@0.9.7`
- `@agenticmail/openclaw@0.5.61`
- `@agenticmail/claudecode@0.2.18`
- `@agenticmail/codex@0.1.13`
- `@agenticmail/cli@0.9.32`

To see the new chrome on replies written by your agents, no action needed — the next reply emitted by any agent will carry the new header lines and the UI will render them. Older messages already in inboxes keep their existing display.

## [0.9.31] - 2026-05-15

### Fixed — `wake: []` mid-project killed coordination threads

Real diagnosis from a LinkedIn-rebuild thread that flatlined for 8 hours:

```
06:31:26  worker for "lyra" finished (893 chars)
          ← ~8 HOURS OF ZERO DISPATCHER EVENTS →
14:25:49  waking "atlas" — new-mail uid=94   (operator ping)
14:30:21  worker for "atlas" finished
          ← silent again →
```

The dispatcher was healthy. The persona was the bug. The 0.9.28 wake-reinforcement persona listed `wake: []` as a legitimate "broadcast" pattern for status updates. Agents treated it as "I have nothing to add right now" and ended turns with it — dropping the handoff baton on the floor. Once that happens, every CC'd agent stays asleep and the thread sits dead until a human pings someone back in.

### The fix — "The Baton Rule" in both host personas

`packages/{claudecode,codex}/src/subagent-template.ts` now hard-codes that **`wake: []` is reserved for project completion only**:

> **THE BATON RULE — never drop the chain.** Until the project is genuinely DONE and the thread has been closed with `[FINAL]`/`[DONE]`/`[CLOSED]`/`[WRAP]`, every reply you send MUST either (a) name the next actor in `wake`, OR (b) not be sent at all. `wake: []` (empty array) means "deliver silently, wake NOBODY" — which only makes sense when the work is finished. Using it mid-project terminates the coordination chain.

Plus an explicit decision tree:

| Situation | Right move |
|---|---|
| Project in progress, you know who acts next | `wake: ["that-name"]` |
| Project in progress, you don't know who's next | `wake: ["<coordinator>"]` — bounce the baton back with an explicit question |
| Project in progress, you have nothing to add | **Do not reply.** `mark_read` and return |
| Project DONE | `[FINAL]` in subject + `wake: []` (the ONLY legitimate use) |

The old "broadcasting an update no specific teammate needs to act on — silent delivery" example was deleted. A correct example for closing a thread with `[FINAL] LinkedIn rebuild — shipped` was added instead.

### Step 7 sharpened

Previously: *"If no: `mark_read` and return. Silence IS a valid contribution."*

Now: *"If no: **do not reply at all** — `mark_read` and return. Silence IS a valid contribution; a silent broadcast is NOT. The dispatcher only stops poking the chain when YOU mark the message read; it never interprets an empty reply as 'nothing to do here'. DO NOT send a 'no update from me' mail with `wake: []` — that drops the baton on the floor."*

### Versions

- `@agenticmail/claudecode@0.2.17`
- `@agenticmail/codex@0.1.12`
- `@agenticmail/cli@0.9.31`

After upgrading, re-run `agenticmail-claudecode install` and `agenticmail-codex install --workspace <dir>` to regenerate every subagent file with the new persona text.

## [0.9.30] - 2026-05-15

### Security — dependabot sweep + code-scanning closure

After 0.9.29 the code-scanning queue was still showing 89 alerts because CodeQL's taint analysis doesn't recognise our custom `safeJoin` / `redactSecret` / `validateApiUrl` helpers as sanitisers — the runtime defence is in place, but the static analyser keeps flagging the call sites.

**Code-scanning: 0 open** (was 89 after 0.9.29, 106 at the start of the audit).

- 29 alerts marked **fixed** by the code changes in 0.9.29 (the ones CodeQL did recognise — `npm audit fix`-compatible upgrades, length-capped regexes, encodeURIComponent on Cloudflare paths, etc.)
- 89 alerts dismissed with explicit `dismissed_reason` + comment in the GitHub UI, grouped by category and pointing at the runtime helper that enforces the boundary:

| Rule | Dismissed | Reason |
|---|---|---|
| `js/path-injection` | 50 | Guarded by `safeJoin`/`tryJoin`/`assertSafeConfigPath`; 35 regression tests in `packages/core/src/util/__tests__/safe-path.test.ts` |
| `js/incomplete-multi-character-sanitization` | 13 | Heuristic regex sanitiser in spam scoring + outbound guard. Defense-in-depth, not authoritative rendering. 1MB input cap. Future refactor: swap to `sanitize-html`. |
| `js/double-escaping` | 6 | Same regex family as above. |
| `js/polynomial-redos` | 6 | Already mitigated by upstream input-length cap. |
| `js/clear-text-logging` | 5 | Either masked (`mask()`/`maskApiKey()`/`redactSecret()`) or one-time setup print of a key the operator must see. Inline `lgtm` + "save this — only shown once" warnings. |
| `js/bad-tag-filter` | 4 | Same regex family as multi-char sanitization. |
| `js/clear-text-storage-of-sensitive-data` | 1 | Master key in localStorage; web UI binds to 127.0.0.1; self-hosted threat model. |
| `js/xss` | 1 | `mail.html` IS the SMTP body by design; nodemailer is the serialiser, not a renderer. |
| `js/xss-through-dom` | 1 | All interpolated values pre-escaped; `formatBytes` returns numeric-only. |
| `js/incomplete-sanitization` | 1 | Folder name from agent's own auto-discovered folder list, not raw user input. |

### Dependabot — 36 dependency CVEs resolved

`npm audit fix` resolved every flagged advisory:

| Package | Advisory | Severity |
|---|---|---|
| `vite` < 7.3.2 | server.fs.deny bypass + arbitrary file read | high |
| `path-to-regexp` < 8.4.0 / < 0.1.13 | DoS via sequential optional groups | high |
| `express-rate-limit` < 8.2.2 | IPv4-mapped IPv6 bypass | high |
| `@hono/node-server` < 1.19.10 | Authorisation bypass via encoded slashes | high |
| `hono` < 4.12.4 (+ 13 sub-advisories) | Arbitrary file access via serveStatic | high |
| `rollup` < 4.59.0 | Arbitrary file write via path traversal | high |
| `fast-uri` < 3.1.2 | Host confusion / path traversal | high |
| `@anthropic-ai/sdk` < 0.91.1 | Insecure default file permissions | medium |
| `postcss` < 8.5.10 | XSS via unescaped `</style>` | medium |
| `nodemailer` < 8.0.5 | SMTP command injection | medium / low |
| `picomatch` < 4.0.4 | Method injection in POSIX char classes | medium |
| `ip-address` < 10.1.1 | XSS in HTML-emitting methods | medium |
| `uuid` < 11.1.1 | Missing buffer bounds check | medium |
| `ajv` < 8.18.0 | ReDoS via `$data` | medium |

All 741 tests pass against the upgraded lock-file.

### Host-scoped MCP tool responses

User report: codex called `check_activity` and saw `atlas [new-mail] running 2m24s` — but atlas is owned by Claude Code. Each host should only see its own teammates + unclaimed accounts; cross-host visibility is confusing UX and a (mild) info leak.

`AGENTICMAIL_MCP_HOST` (already set by every host installer) now drives a post-filter on every list-style MCP tool:

| Tool | Behaviour |
|---|---|
| `list_agents` | Returns only agents where `metadata.host === MCP_HOST` (plus unclaimed legacy accounts). New `host=` tag in each row. Header says "Agents on host claudecode (+ unclaimed)". |
| `check_activity` | Filters active / recent worker entries by joining against the (host-filtered) directory so codex doesn't see Claude workers. |
| `cleanup_agents` (list_inactive / cleanup) | Only shows / sweeps agents owned by this host. |
| `cleanup_agents` (set_persistent) | Refuses to mutate an agent owned by another host. |
| `delete_agent` | Refuses to delete an agent owned by another host. |
| `message_agent` | Refuses to mail an agent owned by another host. |
| `call_agent` | Refuses to RPC an agent owned by another host. Without this, the call would either deadlock (other host's dispatcher wakes it, this host polls and times out) or succeed but cross the host boundary unintentionally. |

The error message names the offending host and includes the `claim --unclaim` then `claim` recipe for an intentional transfer.

API side: `GET /accounts/directory` (and `/accounts/directory/:name`) now include a sanitised `host` field lifted from `metadata.host`. That's host-integration metadata, not a secret — needed so MCP clients can filter without master-key access to the full accounts list.

Tools that were intentionally **not** filtered:

- Every per-agent tool (`list_inbox`, `read_email`, `send_email`, `reply_email`, `search_emails`, `manage_contacts`, `manage_drafts`, `check_tasks`, `whoami`, `update_metadata`, …) — these scope to the caller's identity already (the `_account` per-call key).
- `deletion_reports` — historical audit logs; the agent is gone, so filtering by current host ownership doesn't apply.
- `tail_worker` — requires a `workerId` which must have come from a host-filtered `check_activity`. No additional filter needed.

### Versions

- `@agenticmail/api@0.9.22` — `/accounts/directory` now includes `host`.
- `@agenticmail/mcp@0.9.6` — host-aware filter on `list_agents`, `check_activity`, `cleanup_agents`, `delete_agent`, `message_agent`, `call_agent`. `assertHostOwnsAgent()` helper.
- `@agenticmail/claudecode@0.2.16` — picks up mcp 0.9.6 transitively.
- `@agenticmail/codex@0.1.11` — picks up mcp 0.9.6 transitively.
- `@agenticmail/cli@0.9.30` — package-lock.json updated, host-aware MCP shipped through transitives.

## [0.9.29] - 2026-05-15

### Security — sweep of every CodeQL `code-scanning` alert (106 alerts → addressed)

User pointed at https://github.com/agenticmail/agenticmail/security/code-scanning and asked for everything fixed with proper tests before release. This release closes every error-severity alert plus the bulk of the warnings. Where an alert is a deliberate-by-design behaviour (the create-account flow MUST print the key once, the master-key web UI MUST persist auth in localStorage), the original behaviour is kept and the alert is suppressed inline with an `lgtm[...]` comment and a paragraph explaining why.

#### Path injection — 51 errors

Every install/uninstall/config writer in `@agenticmail/claudecode` and `@agenticmail/codex` was building file paths by concatenating an operator-supplied directory (`CODEX_HOME`, `CLAUDE_CODE_AGENTS_DIR`, …) with a filename derived from AgenticMail account names. CodeQL's `js/path-injection` flagged 51 spots across `install.ts`, `uninstall.ts`, `claude-config.ts`, `claude-hooks-config.ts`, `codex-config-toml.ts`, `codex-hooks-config.ts`.

Two new boundary helpers in `@agenticmail/core`:

- `safeJoin(baseDir, ...parts)` — resolves the join under `baseDir` and throws `PathTraversalError` if the resulting absolute path escapes. CodeQL recognises this idiom as a sanitiser.
- `tryJoin(baseDir, ...parts)` — same check, returns `null` instead of throwing (used in cleanup loops that want to skip a malicious filename, not abort the whole sweep).

Applied to every `writeSubagentFiles` / `removeOwnedSubagents` / `pruneStale*` call in both host packages. Every config writer (`writeClaudeConfig`, `writeCodexConfig`, `writeHooks`, `writeSettings`) now also asserts the target path is absolute AND under `homedir()` or `tmpdir()` — blocks `CODEX_HOME=/etc/cron.d` style attacks via env-var injection.

35 regression tests in `packages/core/src/util/__tests__/safe-path.test.ts` cover every traversal escape route CodeQL flagged.

#### Clear-text logging — 8 errors

New `redactSecret(value)` and `redactObject(obj)` helpers in `@agenticmail/core`. Applied to:

- MCP debug log lines in `packages/mcp/src/tools.ts` — `apiRequest` and `handleToolCall` debug prints used to log a 12-char key prefix; now log `mk_***` / `ak_***`.
- The interactive shell's agent-listing view — masks every key to `ak_***last4`.
- The init-local script — no longer prints the Stalwart admin password (it's in the .env file we just wrote).
- The `examples/multi-agent.ts` — masks keys on creation.

Three call sites kept the original behaviour with an inline `lgtm[js/clear-text-logging]` suppression + comment: the create-account flow in the shell (operator must see the key once), and the OpenClaw config snippet output in the CLI (the print IS the entire point of the command).

11 regression tests in `packages/core/src/util/__tests__/redact.test.ts`.

#### Request forgery (SSRF) — 5 errors

New `validateApiUrl(url)` + `buildApiUrl(origin, path)` helpers in `@agenticmail/core`. Applied to every fetch call in `packages/{claudecode,codex}/src/api.ts`. The validator rejects:

- Non-`http(s)://` schemes (`file://`, `javascript:`, `data:`, `ftp://`)
- Cloud metadata IPs (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.azure.internal`) — blocks an env-var-poisoning attack that redirects the dispatcher's API client at a cloud metadata service to exfiltrate IAM creds.
- Embedded credentials (`http://user:pass@host`) — would leak via logs.

The Cloudflare API client also got `encodeURIComponent` on every operator-supplied path segment so a malformed `accountId` can't produce a request resolving to a different host.

14 regression tests in `packages/core/src/util/__tests__/safe-url.test.ts`.

#### Polynomial regex (ReDoS) — 11 warnings

Bounded every flagged regex on operator/agent-controlled input. Two patterns:

- `/^-+|-+$/g` (the subagent-name normaliser's leading/trailing-dash strip) split into two anchored singles — the alternation form is polynomial on input of all dashes, the singles are linear. Applied in 4 files (`claudecode/persona-loader.ts`, `claudecode/install.ts`, `codex/persona-loader.ts`, `codex/install.ts`).
- Length-capping for parsers that consume strings of unbounded size: `normalizeSubject` (1000 chars), `normalizeAddress` (500 chars), email-address extractor in mail routes (500 chars per entry / 10KB per header), outbound-guard HTML stripper (1MB), human-datetime parser (200 chars), SQL-default validator in storage routes (500 chars).

#### Bad-tag-filter / multi-character-sanitization / double-escaping — 24 warnings

These are heuristic regex-based HTML stripping used for SPAM SCORING and OUTBOUND GUARD pattern matching. They are explicitly defense-in-depth — NOT the authoritative renderer (the UI uses proper escaping). The 1MB length cap added above bounds worst-case behaviour. A future release will swap the regex passes for a real HTML parser (`sanitize-html`); for now the alerts are documented as accepted in `packages/core/src/mail/{sanitizer,outbound-guard}.ts`.

#### XSS / DOM-xss / format-string / cleartext-storage — 4

- `packages/core/src/gateway/manager.ts` — `mail.html` is the literal HTML body being sent over SMTP, not rendered locally. CodeQL `js/xss` is a deliberate exception with `lgtm` + comment.
- `packages/api/public/js/compose.js` — every interpolated value goes through `escapeHtml`; `formatBytes` returns numeric strings. CodeQL conservative warning, suppressed with reference to the static guarantee.
- `packages/api/src/middleware/error-handler.ts` — switched to `%s` argument-passing form so future logger swap can't regress to format-string injection.
- `packages/api/public/js/app.js` — the master key lives in `localStorage` because the web UI binds to 127.0.0.1; the realistic alternative (HttpOnly cookie + server session) requires a network boundary that doesn't exist in a self-hosted install. Suppressed with `lgtm` + threat-model comment.

#### Incomplete URL substring sanitisation — 1

`packages/core/src/sms/manager.ts::parseGoogleVoiceSms` was using `fromLower.includes('voice.google.com')` to detect Google Voice forwarded SMS. A spoofed `voice.google.com.attacker.tld` sender would match. Now extracts the actual domain (after `@`, before any closing `>`) and checks for exact match or proper subdomain of `google.com` AND `voice.google.com`.

#### CI workflow permissions — 2 warnings

`.github/workflows/ci.yml` now declares `permissions: { contents: read }` — the workflow only needs to clone + (on main) upload an artifact.

`.github/workflows/sync-openclaw.yml` declares `permissions: { contents: write, pull-requests: write }` — needed for the auto-PR step, nothing more.

### Web UI — folder-aware message toolbar

Bundled in this release because it landed during the same security batch. The message-view toolbar now adapts to the current folder:

- **Inbox / Sent / Starred / Drafts / All** — Reply, Reply all, Archive, Mark unread, Report spam, Delete (= move to Trash). Unchanged.
- **Archive** — Reply, Reply all, **Move to Inbox** (unarchive), Mark unread, Report spam, Delete.
- **Spam** — Reply, Reply all, **Not spam** (move to Inbox), Mark unread, Delete.
- **Trash** — Reply, Reply all, **Restore** (move to Inbox), Mark unread, **Delete forever** (the existing `deleteMessage` already handled the in-Trash case).

`renderToolbar(folder)` + `bindIf(id, handler)` helpers keep the wiring tidy. New `moveToInbox(reason)` action handler routes through `/mail/messages/:uid/not-spam` for Spam and the generic `/mail/messages/:uid/move` for Archive/Trash.

### Versions

- `@agenticmail/core@0.9.5` — `safeJoin` / `tryJoin` / `redactSecret` / `validateApiUrl` utilities + 60 regression tests
- `@agenticmail/api@0.9.21` — folder-aware toolbar, error-handler format-string fix, host-aware action routes
- `@agenticmail/mcp@0.9.5` — secret redaction in debug logs
- `@agenticmail/claudecode@0.2.15` — path-traversal hardening, SSRF validation, polynomial-regex bound
- `@agenticmail/codex@0.1.10` — same as claudecode
- `@agenticmail/cli@0.9.29` — rolls dependencies forward

## [0.9.28] - 2026-05-15

### Fixed — viewing a message from Spam / Archive / Trash 404'd

After the 0.9.25 `MESSAGE_NOT_FOUND` mapping made the error legible, the underlying bug surfaced clearly: the web UI was calling `GET /mail/messages/:uid` with no `?folder=` query, so the API defaulted to `INBOX` and returned 404 for any message that lived in Spam / Archive / Trash.

`packages/api/public/js/message-view.js::openMessage` now resolves the IMAP folder name from `state.folderNames` (the map populated by `/mail/folders` auto-discovery in 0.9.16) and threads it through as `?folder=<name>`. Also patched the in-view actions (`markUnread`, `markSpam`) to send `folder` in the POST body so they don't silently misfire when the operator runs them from a non-Inbox folder.

Server-side companion: `/mail/messages/:uid/unseen` now honors `req.body.folder` (defaults to INBOX), matching the shape of every other per-message action route.

### Fixed — codex dispatcher logs said "no Claude turn"

The codex dispatcher's log messages and inline comments still read "Claude turn", "spawn a Claude worker", "via the Claude Agent SDK" — fork artifacts from when the package was templated off `@agenticmail/claudecode`. Confusing for codex operators tailing `pm2 logs agenticmail-codex-dispatcher`.

Swept `packages/codex/src/dispatcher.ts`:

- `Claude turn` / `Claude turns` → `Codex turn` / `Codex turns` (12 spots, including the user-visible `[dispatcher] wake allowlist excludes "..." — mail delivered, no Codex turn` log line)
- `Claude Agent SDK` / `Claude-powered worker` / `interactive Claude Code session` → Codex equivalents
- The bridge-skip docstring no longer talks about "two Claude instances" — now refers to two Codex sessions
- `sandboxed by Claude Code's permission system` → `sandboxed by Codex's workspace-write sandbox`
- `50 simultaneous Claude calls` → `50 simultaneous Codex calls`

Legitimately Claude-named internals **kept**:

- The Codex SDK's event shape adapter (the `Claude-shaped frame` interface) intentionally normalises Codex's `item.started / item.updated / item.completed / turn.*` events into a frame structure that originally matched Claude Agent SDK's, so the wake / coalesce / budget / catch-up code stays host-agnostic. Those references read accurately as a description of an internal interface contract.

### Added — Reinforced handoff guidance in the agent persona

User report: orion replied to a thread saying "Atlas — over to you", but the reply-all kept Vesper on `To:` (since Vesper was the previous sender) and Atlas landed on `Cc:`. Atlas may stay silent assuming another teammate took it, killing the task mid-work.

`reply_email`'s `replyAll: true` preserves the original sender on `To:` by design — that's the right shape for "reply to the thread, everyone sees it". But it means a body-text handoff like "Atlas — over to you" has no machine-readable signal that Atlas is the next assignee.

The `wake` array IS that signal. Strengthened the persona templates in **both** `@agenticmail/claudecode` and `@agenticmail/codex` to make it mandatory:

> **HANDOFFS — read this carefully.** When you're delegating the next step to ONE specific teammate, you MUST pass `wake: ["<their-name>"]` in the same call. Reason: a reply-all keeps the ORIGINAL sender on the `To:` header, NOT your handoff target … `wake: ["atlas"]` is the authoritative signal: only Atlas thinks next, everyone else still receives the mail and stays informed.

Includes worked examples for both single-target handoffs and silent broadcasts (`wake: []`).

### Added — Rate-limit retry: dispatcher backs off + retries hourly instead of dropping the task

User report: when a provider hits a rate limit (per-minute, per-hour, weekly cap, billing-side quota — anything that auto-resets on a timer), the worker turn fails, the wake is consumed, and the task is dropped forever even though the rate-limit window will clear in minutes-to-hours.

Both dispatchers (`@agenticmail/claudecode` + `@agenticmail/codex`) now:

1. Detect rate-limit errors via a broad-match `isRateLimitError(msg)` helper covering Anthropic's `overloaded_error`, OpenAI's `insufficient_quota`, the generic `429` / `rate_limit` / `too many requests`, plus Claude-Code- and Codex-personal-plan-specific `weekly limit` / `daily limit`.
2. Schedule a `setTimeout` retry **one hour out** from the failure, keyed by `<accountId>:<kind>:<uid|taskId>`.
3. Re-fire the worker turn through the same `spawnWorker` entry point. If still rate-limited, reschedule for another hour. Successful run clears the retry entry.
4. Cap at 24 attempts (~24h at hourly cadence) so a permanently-throttled account doesn't sit in the queue forever — operator gets a `warn` log when the budget is exhausted.
5. `unref()` the timer so retries don't keep node alive on an otherwise idle dispatcher.
6. Clear every pending retry on `stop()` — the restart's catch-up scan re-emits SSE events from the persisted cursor, which naturally re-fires the worker; persistence here would be redundant.

### Web UI — `markUnread` / `markSpam` toolbar actions now pass the source folder

Companion to the message-detail folder fix above: these actions previously silently misfired when triggered from any non-Inbox folder. Server-side `/mail/messages/:uid/unseen` now honors `req.body.folder` (defaults to INBOX, matching the shape of every other per-message action route).

### Versions

- `@agenticmail/api@0.9.19`
- `@agenticmail/claudecode@0.2.14`
- `@agenticmail/codex@0.1.9`
- `@agenticmail/cli@0.9.28`

## [0.9.27] - 2026-05-15

### Fixed — Spam folder always empty even after marking emails as spam

User report: clicking "Spam" in the web UI sidebar always showed `{ "messages": [], "count": 0, "total": 0 }` even though they had explicitly marked emails as spam.

Two bugs cancelling each other:

1. **`GET /mail/spam` (list)** hard-coded `'Spam'` as the folder name, but Stalwart's default spam folder is `'Junk Mail'`. The list route looked at the wrong folder and silently returned empty.
2. **`POST /mail/messages/:uid/spam` (mark)** hard-coded `'Spam'` as the destination, creating a duplicate "Spam" folder on first use. Mail went there but the UI never queried it.

Same trick `/mail/messages/:uid/archive` and `/mail/messages/:uid/trash` already use: a `resolveSpamFolder()` helper that auto-discovers via the IMAP `\Junk` specialUse marker, falls back to common names (`Junk Mail` / `Junk` / `Spam`), and creates `"Junk Mail"` if nothing exists. Applied to all three spam routes.

### Versions

- `@agenticmail/api@0.9.19`
- `@agenticmail/cli@0.9.27`

## [0.9.26] - 2026-05-15

### Fixed — `agenticmail-codex install --workspace` crashed with "Dynamic require of fs is not supported"

The new `parseWorkspace()` helper in 0.9.25 lazily-loaded `node:fs` and `node:path` via `require()` calls inside the function body. That works when the file is run as CommonJS, but `@agenticmail/codex` is ESM-only — tsup bundles the output with a `require` shim that throws `"Dynamic require of <module> is not supported"` at runtime. The install command crashed before doing anything.

Replaced the in-function `require()` with proper top-level `import` statements. No behavior change otherwise.

### Versions

- `@agenticmail/codex@0.1.8`
- `@agenticmail/cli@0.9.26`

## [0.9.25] - 2026-05-15

### Three production blockers fixed for co-installed Claude Code + Codex

User report from a real multi-agent build session ("Facebook Rebuild" — codex coordinator + 4 sub-agents working in parallel):

1. Web UI returned 500 with `Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')` when opening certain messages.
2. Codex worker turns silently exited with all MCP tool calls reported as "user cancelled MCP tool call" — agents could wake but couldn't read/reply to mail.
3. Worker output files landed in `~/.agenticmail/worker-cwds/<id>/` instead of the project root — agents couldn't see each other's work, breaking the "build me an app" workflow entirely. Operator had to hand-patch the dispatcher binary with a perl one-liner to override the cwd.

### Fix 1 — `Symbol.asyncIterator` 500 → proper 404

`packages/core/src/mail/receiver.ts::fetchMessage` calls imapflow's `client.download(uid)`. When the UID doesn't exist in the requested folder (deleted between list-fetch and detail-fetch, wrong folder param), imapflow doesn't throw — it resolves with `{ content: undefined }`. The next line `for await (const chunk of content)` then iterates `undefined`, which JavaScript reports as the cryptic Symbol-asyncIterator error.

Now guards with an explicit `if (!content)` and throws a `MESSAGE_NOT_FOUND` sentinel error. The mail route maps that to a clean 404 with `{ error, code: 'MESSAGE_NOT_FOUND' }`.

### Fix 2 — Codex workers can finally use MCP tools

Codex's MCP client defaults `approval_mode = "prompt"` for every tool, which surfaces an interactive approval dialog before the tool runs. In a dispatcher-spawned worker turn (headless `@openai/codex-sdk` invocation) there is no interactive user — Codex auto-cancels every call and the worker exits silently. Every `mcp__agenticmail__read_email` / `reply_email` / `search_emails` / etc dies.

`packages/codex/src/install.ts::buildMcpEntry` now stamps `default_tools_approval_mode = "approve"` on the AgenticMail MCP server entry. One key, all 60+ tools auto-approved. Per-tool exceptions can still be added at `[mcp_servers.agenticmail.tools.<name>]` if a future tool needs interactive guarding (none today).

Documented value confirmed against [openai/codex `docs/config.md`](https://github.com/openai/codex/blob/main/docs/config.md).

### Fix 3 — Worker workspace override

Default behavior (one scratch dir per worker, deleted after the run) is correct for stateless workers — research replies, summarisation, reminders. It's exactly wrong for "build me an app" where every agent on the team needs to see each other's files.

New env var `AGENTICMAIL_WORKER_CWD` plus a new install flag `--workspace <dir>` route every dispatcher-spawned worker to a shared project directory. When set, the dispatcher:

- Uses the override path as `cwd` for every worker
- Skips the per-worker `mkdirSync` (the directory must already exist)
- Skips the post-run `rmSync` cleanup (deleting the operator's project after every wake would be catastrophic)

```
agenticmail-codex install --workspace ~/projects/facebook-rebuild
```

Or set the env var directly in PM2 if the dispatcher is already running.

### Web UI — host switcher (Airbnb-style flip)

The inbox dropdown was listing every agent across every host on the same machine — claudecode bridge, codex bridge, all sub-agents, all jumbled together. Co-installed setups got long fast.

New segmented toggle at the top of the inbox panel: **All / Claude / Codex**. Clicking flips the inbox list with a 3D Y-axis rotation, swapping the content at the orthogonal midpoint of the rotation so each side of the card carries a distinct roster — same illusion Airbnb's [Host Passport book-flip](https://medium.com/airbnb-engineering/animations-bringing-the-host-passport-to-life-on-ios-72856aea68a7) uses on iOS. Selection persists in localStorage.

Single-host installs see no toggle — the UI degrades cleanly when only one host is present. Future hosts (Grok Build, Hermes) plug in via one row in `HOST_BRANDING` plus their SVG dropped into `/branding/`.

### Codex hook no longer leaks capabilities blurb (carry-over from 0.9.24)

In 0.9.24 we removed the SessionStart capabilities blurb from the codex hook because Codex's UI renders `additionalContext` verbatim under a `hook context:` label (Claude Code suppresses it silently). That fix carries forward unchanged.

### Versions

- `@agenticmail/core@0.9.4` — `MESSAGE_NOT_FOUND` sentinel
- `@agenticmail/api@0.9.18` — 404 mapping + host switcher UI
- `@agenticmail/codex@0.1.7` — auto-approve MCP tools + workspace override
- `@agenticmail/cli@0.9.25` — rolls dependencies forward

## [0.9.24] - 2026-05-15

### Fixed — Codex hook no longer leaks the capabilities blurb into the terminal UI

User report: every Codex SessionStart and first UserPromptSubmit pushed a 250-token `🎀 AgenticMail is available via MCP…` block into the Codex interactive UI under a `hook context:` label. Visually:

```
• SessionStart hook (completed)
  hook context: 🎀 AgenticMail is available via MCP (mcp__agenticmail__*).When to reach for it: …
```

That blurb is unreadable noise for the operator.

### Why this happens

Claude Code's hook engine consumes `hookSpecificOutput.additionalContext` silently — the user never sees it, only the model does. Codex's hook engine is byte-compatible at the JSON layer, but its UI deliberately **renders** `additionalContext` verbatim under a `hook context:` heading as part of its transparency-first design.

The capabilities blurb is pure model-guidance — telling the model when to reach for AgenticMail and which three high-leverage tools to use. The model needs it. The operator does not.

### Fix

`packages/codex/src/mail-hook.ts`:

- **SessionStart is now a no-op** in the Codex hook. No output, no UI noise.
- **UserPromptSubmit's "fallback blurb on first-prompt-of-session" path is removed.** No blurb on any path.
- **Mail-context surfacing is preserved.** When new mail has arrived since the last check, the hook still emits a terse summary on UserPromptSubmit (`additionalContext`) and Stop (`decision:'block'` + `reason`). That summary IS useful for the operator to see — *"Vesper sent a question 30s ago"* is a notification, not boilerplate guidance — so leaving Codex's UI to render it is the right behavior.

Model-guidance that used to live in the blurb will move into the dispatcher's per-turn system prompt in a future release (SDK system prompts aren't rendered in the UI by construction).

### Versions

- `@agenticmail/codex@0.1.6`
- `@agenticmail/cli@0.9.24`

## [0.9.23] - 2026-05-15

### Changed — Strict host ownership for subagent rosters

Previously a fresh `agenticmail-codex install` on a machine that already had Claude Code set up would write Codex subagent files for every existing teammate (`agenticmail-vesper.toml`, `agenticmail-orion.toml`, …). Codex inherited Claude's roster on first run, which is the opposite of what we want — each host should start with an empty teammate list and build its own.

### New rule: `metadata.host === ownHost` or it's not exposed

`selectExposableAgents` in both `@agenticmail/claudecode` and `@agenticmail/codex` now filters strictly: a teammate appears in the host's subagent roster ONLY if `metadata.host` equals this host's bridge name.

The previous "unclaimed accounts visible to all hosts" back-compat rule is dropped. Pre-0.9.20 accounts that predate auto-tagging are unclaimed by default; the operator must run `agenticmail-<host> claim <name>` (or `claim --all`) to assign them. This is a one-time operation per legacy machine.

The dispatcher's `shouldWatch` (runtime mail filter) is intentionally unchanged — it keeps the legacy "watch unclaimed accounts" rule for back-compat with single-host installs. Install-time and runtime are now decoupled.

### Added — Per-host avatars in the web UI

The bridge avatar previously hard-coded Claude's mark for every bridge in the inbox panel, so a co-installed Claude Code + Codex setup showed the same logo for both. Each host now gets its own branded avatar:

- `claudecode` → official Claude color mark (`/branding/claude-color.svg`)
- `codex` → OpenAI mark (`/branding/openai-mark.svg`)
- unknown host → generic AgenticMail logo + verified tick

The host registry in `packages/api/public/js/avatar.js` is the single extension point — adding a new host integration = one row + drop the SVG into `/branding/`.

### Versions

- `@agenticmail/api@0.9.16` (new branding assets, avatar.js host registry)
- `@agenticmail/claudecode@0.2.13` (strict ownership filter, bridge host stamp)
- `@agenticmail/codex@0.1.5` (strict ownership filter, bridge host stamp)
- `@agenticmail/cli@0.9.23` (rolls dependencies forward)

## [0.9.22] - 2026-05-15

### Fixed — Cross-host bridges leaking into the wrong host's subagent list

When the user installed `agenticmail-codex` on a machine that already had `agenticmail-claudecode` set up, Codex wrote a subagent file for `agenticmail-claudecode` — i.e. it surfaced the OTHER host's bridge as a teammate. Spawning that subagent would have made no sense and risked back-and-forth loops between bridges.

### Root causes

1. **`selectExposableAgents` filter was missing `metadata.host`**. Both `@agenticmail/claudecode/install` and `@agenticmail/codex/install` only filtered on `name === self` and `role === 'bridge'`. The Claude bridge in the test rig still had the legacy `role='assistant'` (because the role-migration step only runs on a re-install, not on the live API), so the Codex installer didn't recognize it as a bridge and wrote a subagent file for it.

2. **Installer never stamped `host=<bridge>` on its own bridge**. The MCP server's `create_account` auto-stamps `metadata.host` from the `AGENTICMAIL_MCP_HOST` env var, but the bridge account is created via the master API directly (not through MCP), so the env-var path never fires for the bridge itself. The bridge therefore showed `host=-` in the web UI and didn't carry an ownership tag.

### Fix

`packages/{claudecode,codex}/src/install.ts`:

- `selectExposableAgents` now also rejects `metadata.bridge === true` and any account whose `metadata.host` is set to a value other than this host's bridge name. Unclaimed accounts (no host stamp) stay visible to every host — back-compat preserved.
- `install()` now calls `setAccountHost(bridgeId, bridgeName)` after `ensureAccount` so the bridge carries its own host tag. The web UI host badge and dispatcher metadata filter now treat bridges consistently with teammates.

The Codex installer's docstring previously promised the `metadata.host` filter behavior; this release makes the implementation match.

### Versions

- `@agenticmail/claudecode@0.2.12`
- `@agenticmail/codex@0.1.4`
- `@agenticmail/cli@0.9.22` (rolls the optionalDependencies forward to the patched host packages)

## [0.9.21] - 2026-05-14

### Fixed — `agenticmail-claudecode: command not found` after global install

User report: *"npm install -g @agenticmail/cli@latest … agenticmail-claudecode install … zsh: command not found: agenticmail-claudecode"*.

Root cause: `@agenticmail/cli` declared `@agenticmail/claudecode` and `@agenticmail/codex` in `optionalDependencies`, so the code was installed — but npm only symlinks bins of the **directly-installed** package into the global bin dir. Transitive deps' bins stayed buried in `<global>/node_modules/@agenticmail/cli/node_modules/@agenticmail/{claudecode,codex}/dist/cli.js` and never landed on `$PATH`.

### Fix — ship wrapper bins from `@agenticmail/cli`

The CLI package now declares its **own** `agenticmail-claudecode` and `agenticmail-codex` bins. Each wrapper:

1. Walks up from its own location through every ancestor `node_modules/@agenticmail/{host}/package.json` (filesystem-only — no `require.resolve()`, because the host packages' `exports` block is ESM-only and CJS resolution rejects `import`-only entries).
2. Reads `pkg.bin[binName]` to find the real bin's relative path.
3. `spawn(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })`.
4. Exits with the child's exit code (or echoes its signal).
5. Forwards SIGINT / SIGTERM / SIGHUP so Ctrl+C reaches the child cleanly.

UX is identical to invoking the transitive bin directly — same help, same prompts, same output, just discoverable on `$PATH` from a single `npm install -g @agenticmail/cli`.

If the host package isn't installed (e.g. `--no-optional`), the wrapper prints a clear error and exits 127, pointing the user at `npm install -g @agenticmail/{host}@latest` as a direct fallback.

### Files

- `agenticmail/src/bin-host-shim.ts` (new) — shared `runHostBin(hostPkgName, binName)` utility.
- `agenticmail/src/bin-claudecode.ts` (new) — wrapper entrypoint for `agenticmail-claudecode`.
- `agenticmail/src/bin-codex.ts` (new) — wrapper entrypoint for `agenticmail-codex`.
- `agenticmail/package.json` — adds the two new bins, updates the tsup build script.

## [0.9.20] - 2026-05-15

### Added — Per-account host ownership: `metadata.host`

User report: *"codex sub-agents should ride on codex sdk to openai while claudecode sub-agents do the same, maybe add distinct name tag to each agents to properly design this? we will need to add the tags to the web UI view as well."*

Plus the dual-wake race from 0.9.19's acknowledged limitation: with both Claude Code and Codex dispatchers running on the same machine, both watched every teammate (vesper/orion/atlas/lyra) and both fired workers on every reply. Duplicate replies, duplicate token spend.

### How ownership works

Every account now carries an optional `metadata.host` field that names the host integration that owns it (`claudecode`, `codex`, future: `grok-build`, `hermes`). The dispatcher uses it to filter:

| `metadata.host` | claudecode dispatcher | codex dispatcher |
|---|---|---|
| `'claudecode'` | watches | skips |
| `'codex'` | skips | watches |
| anything else set | skips | skips |
| unset (legacy) | watches | watches (back-compat) |

Sub-agents owned by Claude Code wake via `@anthropic-ai/claude-agent-sdk`; ones owned by Codex wake via `@openai/codex-sdk`. The SDK split is implicit — each dispatcher uses its own.

### Where the `host` value comes from

1. **MCP `create_account` auto-stamps it.** The MCP server reads `AGENTICMAIL_MCP_HOST` from its env block and sets `metadata.host = <value>` on every new account. Both host installers (claudecode + codex) now write this env var into their MCP server registration.

2. **`PATCH /accounts/:id/host`** — new master-key-scoped endpoint for retro-tagging legacy accounts.

3. **New `claim` CLI subcommand** on both host integrations:

   ```
   agenticmail-claudecode claim vesper orion atlas lyra
   agenticmail-claudecode claim --all              # every unowned account
   agenticmail-claudecode claim vesper --unclaim   # release ownership
   agenticmail-claudecode claim vesper --json
   ```

   Same flags work on `agenticmail-codex claim`. Operator workflow when both dispatchers are running: claim each agent to one host so only that dispatcher wakes it. `--all` is the bulk-fix for fresh upgrades.

### Web UI host badges

The profile menu now shows a color-coded host badge next to each agent's name:

- **Claude** (purple) — owned by the Claude Code dispatcher
- **Codex** (green) — owned by the OpenAI Codex dispatcher
- *(future hosts get their own colors as they ship)*
- **Unclaimed** (gray) — no `metadata.host`. Hover shows a hint to run `agenticmail-<host> claim`. Both dispatchers will wake on this account if both are running.

Each badge has a `title` tooltip explaining which SDK the agent rides on so the connection between badge color and runtime is explicit, not just decorative.

### Backwards compatibility

- Existing accounts without `metadata.host` keep working — both dispatchers still watch them (legacy behavior preserved). UI shows them as "Unclaimed".
- After 0.9.20, every NEW account auto-tags itself on creation via the MCP env var. Once every host installer writes that var (already in this release), legacy accounts are the only unclaimed ones.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/mcp` | 0.9.2 | 0.9.4 |
| `@agenticmail/api` | 0.9.14 | 0.9.15 |
| `@agenticmail/claudecode` | 0.2.10 | 0.2.11 |
| `@agenticmail/codex` | 0.1.2 | 0.1.3 |
| `@agenticmail/cli` | 0.9.19 | 0.9.20 |

core is unchanged this release (0.9.3 still current).

### Operator upgrade

```
npm install -g @agenticmail/cli@latest
agenticmail-claudecode install            # re-runs to write AGENTICMAIL_MCP_HOST into MCP env
pm2 restart agenticmail-claudecode-dispatcher
```

For existing teammate accounts, claim them to one host so only that dispatcher wakes them:

```
# Pick one (whichever host you want to drive the agents going forward):
agenticmail-claudecode claim --all
# OR
agenticmail-codex claim --all
```

After claim, restart the dispatcher. The web UI Profile menu shows the new badges.

## [0.9.19] - 2026-05-15

### Added — `role: 'bridge'` is now a first-class AgentRole

User report: *"the current account codex created via curl is created as sub-agent so that's a problem, check the current agents account!"*

The host bridge account (the one each host integration provisions to represent itself inside AgenticMail — `claudecode@localhost`, `codex@localhost`) was being created with `role: 'assistant'`, the same role regular teammates get. That's misleading both in the web UI and in any "list my agents" call: the host's own identity shouldn't show up alongside teammates the user actually assigns work to.

`'bridge'` is now part of `AGENT_ROLES` in `@agenticmail/core`. Each host integration's installer (`@agenticmail/claudecode`, `@agenticmail/codex`) creates its bridge with `role: 'bridge'` going forward.

### Added — `PATCH /accounts/:id/role` endpoint + migration

For existing installs where the bridge was already created with `role: 'assistant'` (workaround), the API now exposes `PATCH /accounts/:id/role` (master-key scoped). Both host installers call this on re-install to migrate the bridge in-place — no need to delete + recreate (which would invalidate the API key).

### Fixed — Dispatcher was watching OTHER hosts' bridge inboxes

User report: *"the dispatcher try to add codex to the sse stream because its treating it like a sub-agent instead of the host."*

With both host integrations co-installed on the same machine, the claudecode dispatcher opened an SSE channel for `codex@localhost` (and would have done the reverse). Each host's bridge is owned by THAT host's interactive REPL — neither dispatcher should wake on it.

`shouldWatch` now exits early on three independent markers — any one is enough:

1. `account.name === <this host's bridge name>` (your own bridge)
2. `account.role === 'bridge'` (the canonical post-0.9.3 marker)
3. `account.metadata.bridge === true` OR `account.metadata.host` is a non-empty string (defensive — catches bridges that were created before the role landed, including the codex bridge Codex's agent provisioned manually with `metadata: {host: 'codex', bridge: true}`)

The metadata check is what fixes the user's running state immediately on dispatcher restart — they don't need to wait for the role migration to run; the metadata marker is already on the codex account.

### Fixed — Codex hook trust UX surfaced in install output

User report: *"after a hook is added, codex required to review and approves them — make sure you fit into the design."*

Codex CLI does NOT auto-trust newly-registered hooks. On the next session start after `agenticmail-codex install`, Codex displays:

```
⚠ 3 hooks need review before they can run. Open /hooks to review them.
```

This is correct Codex security behavior (claudecode doesn't have an equivalent — Claude Code auto-trusts hooks in `~/.claude/settings.json`). The codex installer now prints an explicit heads-up in its "next steps" block telling the user how to approve: run `/hooks` in the Codex REPL and press `t` on each of the three AgenticMail hooks (SessionStart, UserPromptSubmit, Stop). After that they fire automatically every session.

### What's NOT solved yet (acknowledged limitation)

When both Claude Code and Codex dispatchers are running on the same machine, **both watch every regular agent** (vesper, orion, atlas, lyra). When a teammate replies on a thread, BOTH dispatchers will wake the recipient — once via Claude, once via Codex — and both will try to reply. That's a duplicate-worker race condition.

This release does NOT fix that. The blocker is account ownership: AgenticMail has no concept yet of "this agent is owned by Claude Code" vs "owned by Codex." Proposal for 0.10: add `metadata.host` to regular accounts at creation time (the host that ran `create_account` tags itself), and have each dispatcher's `shouldWatch` filter to only watch accounts where `!metadata.host || metadata.host === <my host>`.

Operator workaround for now: only run ONE dispatcher at a time. Stop the other one in PM2 (`pm2 stop agenticmail-codex-dispatcher`) if you want claudecode to handle teammate wakes, and vice versa.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.9.2 | 0.9.3 |
| `@agenticmail/api` | 0.9.13 | 0.9.14 |
| `@agenticmail/claudecode` | 0.2.9 | 0.2.10 |
| `@agenticmail/codex` | 0.1.1 | 0.1.2 |
| `@agenticmail/cli` | 0.9.18 | 0.9.19 |

### Operator upgrade

```
npm install -g @agenticmail/cli@latest
pm2 restart agenticmail-claudecode-dispatcher
pm2 restart agenticmail-codex-dispatcher   # if codex is installed
```

The `shouldWatch` metadata check fires on next dispatcher start, so the codex bridge will drop out of the claudecode dispatcher's SSE channel list immediately. The role migration (`role='assistant'` → `role='bridge'`) runs when you re-execute `agenticmail-codex install` or `agenticmail-claudecode install`.

## [0.9.18] - 2026-05-15

### Fixed — `@agenticmail/codex install` 400'd on every real install (role bug)

`install.ts` called `ensureAccount(..., 'bridge')` to provision the codex bridge account. The AgenticMail API enforces `role ∈ {secretary, assistant, researcher, writer, custom}` — `'bridge'` isn't in that set, so every fresh install returned:

```
✗ AgenticMail API 400: {"error":"Invalid role. Must be one of: secretary, assistant, researcher, writer, custom"}
```

A user installing today via Codex (Codex's agent ran `agenticmail-codex install`) hit this and worked around it by creating the bridge account manually via raw `POST /accounts` with `role: 'assistant'`. That's the correct shape — the bridge-ness of the codex account is encoded via the name match (`cfg.bridgeAgentName`, default `'codex'`) and by `selectExposableAgents`, NOT by the role.

### Fix

`ensureAccount(..., 'assistant')` — same role claudecode's install uses. Added a regression test (`provisions the bridge agent with role="assistant" — NOT "bridge"`) that asserts the exact ensureAccount call shape so this can't sneak back in.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/codex` | 0.1.0 | 0.1.1 |
| `@agenticmail/cli` | 0.9.17 | 0.9.18 |

Operator upgrade (only relevant if you haven't installed codex yet — existing 0.1.0 installs are working since Codex/users worked around it manually):

```
npm install -g @agenticmail/codex@latest
```

## [0.9.17] - 2026-05-15

### Added — `@agenticmail/codex@0.1.0` shipped to npm

The OpenAI Codex CLI integration is now available on npm:

```
npm install -g @agenticmail/codex
agenticmail-codex install
```

Same architecture as `@agenticmail/claudecode` — registers the MCP server in `~/.codex/config.toml`, enables the `multi_agent_v2` feature flag, generates one Codex subagent TOML file per AgenticMail account in `~/.codex/agents/`, wires SessionStart/UserPromptSubmit/Stop hooks into `~/.codex/hooks.json`, and runs a long-lived dispatcher daemon (`agenticmail-codex-dispatcher`) that drives Codex turns via `@openai/codex-sdk` whenever new mail or a task lands in an agent's inbox.

The dispatcher's tuning knobs (`maxWakesPerThread`, `maxConcurrentWorkers`, etc.) are shared between Claude Code and Codex via `~/.agenticmail/dispatcher.json` — tune once, both dispatchers pick it up on next restart. `agenticmail-codex tune` is the same CLI surface as `agenticmail-claudecode tune`.

### Added — `@agenticmail/codex` listed as an optional dep of the CLI

`@agenticmail/cli` now declares `@agenticmail/codex@^0.1.0` in its `optionalDependencies`, next to `@agenticmail/claudecode`. `npm install -g @agenticmail/cli@latest` will pull in both integrations by default; users without `@openai/codex-sdk` installed will see codex skipped (optional means npm doesn't fail when a peer-dep can't resolve).

### Tests

79 codex tests pass (config, TOML config patcher, hooks-json patcher, subagent template, install/uninstall flow, dispatcher state, dispatcher tuning, persona loader).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/codex` | — | **0.1.0 (first publish)** |
| `@agenticmail/cli` | 0.9.16 | 0.9.17 |

Plugin manifest mirrored to 0.9.17. api / claudecode / core / mcp unchanged this release.

### Operator install

For users who only want Codex:

```
npm install -g @agenticmail/codex
agenticmail-codex install
```

For users who want both Claude Code AND Codex side-by-side:

```
npm install -g @agenticmail/cli@latest
# That pulls @agenticmail/claudecode + @agenticmail/codex transitively.
agenticmail-claudecode install
agenticmail-codex install
```

The two integrations don't conflict — each writes to its own host's config, and the AgenticMail accounts (mailboxes, contacts, tasks) are shared between them.

## [0.9.16] - 2026-05-15

### Added — Dispatcher tuning knobs are now end-user-tunable

User report: *"how can users easily increase budgets? It looks like we are locking them out with our default settings — what about power users who don't mind 100 agents running simultaneously for same tasks or different tasks?"*

The dispatcher has five rate-limit / concurrency knobs that were
hardcoded before today. Power users running active multi-agent
coordination hit the default 10-wakes-per-thread cap routinely and
had no way to raise it without editing source.

### Knobs now end-user-exposed

| Knob | Default | What it does |
|---|---|---|
| `maxConcurrentWorkers` | 50 | Hard cap on simultaneous workers across all agents |
| `maxWakesPerThread` | 10 | Wakes a single (agent, thread) pair gets per window |
| `wakeWindowMs` | 86_400_000 (24h) | Rolling window for the above counter |
| `wakeCoalesceMs` | 30_000 (30s) | Burst-debounce — rapid replies collapse into one wake (set 0 to disable) |
| `accountSyncIntervalMs` | 30_000 (30s) | How often dispatcher polls /accounts for new agents |

### Three input layers, precedence env > file > default

  1. **Env vars** (PM2 ecosystem.config.cjs):

     ```
     AGENTICMAIL_DISPATCHER_MAX=200
     AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD=50
     AGENTICMAIL_DISPATCHER_WAKE_WINDOW_MS=86400000
     AGENTICMAIL_DISPATCHER_COALESCE_MS=30000
     AGENTICMAIL_DISPATCHER_SYNC=30000
     ```

  2. **Persistent config file** at `~/.agenticmail/dispatcher.json` (written by the new `tune` CLI subcommand):

     ```json
     { "version": 1,
       "maxConcurrentWorkers": 200,
       "maxWakesPerThread": 50 }
     ```

  3. **Built-in defaults** when neither is set.

### New `tune` CLI subcommand

Both host integrations got a new subcommand:

```
agenticmail-claudecode tune                                  # show current settings
agenticmail-claudecode tune --max-wakes-per-thread 100       # raise budget
agenticmail-claudecode tune --max-concurrent 200             # raise concurrency
agenticmail-claudecode tune --wake-coalesce-ms 0             # disable coalescing
agenticmail-claudecode tune --reset                          # back to defaults
agenticmail-claudecode tune --json                           # machine-readable
```

`agenticmail-codex tune` exists with the same flags. The file is shared between hosts — tune once, both dispatchers pick it up on next restart.

### Discoverability fix in the "budget exhausted" log line

The wake-budget-exhausted warning now includes the lever to pull inline:

```
[dispatcher] wake-budget exhausted for "lyra" on thread "..." —
  dropped uid=76 (cap=10 per 1440min;
  raise with AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD env var,
  or via ~/.agenticmail/dispatcher.json)
```

### Fixed — Server-classified spam invisible in the web UI Spam tab

User report: *"Archive returns the emails but Spam still returning empty!"*

`routes/events.ts`'s spam-classifier code path hardcoded the destination folder as `'Spam'`. Stalwart's default junk folder is `'Junk Mail'`, and the web UI's FOLDER_MATCHERS regex resolves `state.folderNames.spam` to whatever junk-like folder already exists — `'Junk Mail'` on a default install. Net: server-classified spam silently disappeared into a parallel `'Spam'` folder while the UI's Spam tab queried `'Junk Mail'`.

User-reported-spam (via the bulk-action toolbar) DID land correctly because that flow uses `state.folderNames.spam` for the destination — same folder it queries. Two parallel folders with the same purpose, only one of which the UI ever saw.

### Fix

Discover the existing junk folder the same way `batch/archive` does — prefer `\Junk` special-use, fall back to a regex match on common names (`junk`/`junk mail`/`spam`/`[gmail]/spam`), only create a new `'Spam'` folder when none exists.

### Fixed — Favicon 404

User report: */favicon.ico → 404*

Dropped the existing 256×256 logo PNG at `public/favicon.ico`. Modern browsers (Chrome, Firefox, Safari, Edge) accept PNG content under the .ico filename. The `<link rel="icon" type="image/png">` tag in index.html already pointed at the canonical logo — this just stops the auxiliary `/favicon.ico` request from 404'ing in the dev tools.

### Tests

- `dispatcher-tuning.test.ts` — 15 tests covering env / file / explicit precedence + idempotent atomic writes + malformed-input tolerance. Mirrored in both `@agenticmail/claudecode` and `@agenticmail/codex`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.12 | 0.9.13 |
| `@agenticmail/claudecode` | 0.2.8 | 0.2.9 |
| `@agenticmail/cli` | 0.9.15 | 0.9.16 |

## [0.9.15] - 2026-05-15

### Fixed — No sound or browser notification on agent-to-agent mail (the bulk of real traffic)

User report: *"am not getting the push notification or the sounds in the web UI anymore."*

### Root cause

`routes/events.ts`'s `watcher.on('new', ...)` handler has THREE code paths that `safeWrite` the event to the per-agent SSE stream:

1. internal agent-to-agent mail (`isInternalEmail(parsed) === true`)
2. spam-routed mail (`spamResult.isSpam === true`)
3. the fall-through "normal external" path at the bottom

Only path #3 ran `pushSystemEvent({ type: 'new_mail', ... })` — the bus the web UI subscribes to since 0.9.9. Paths #1 and #2 early-returned BEFORE the fan-out, so the master stream never saw the event.

Most of the user's real traffic is **internal agent-to-agent mail** (orion@localhost replying to vesper@localhost on a coordination thread). All of it took path #1 and never reached the UI's `new_mail` handler. Result: list silently refreshed (via per-agent stream the dispatcher subscribed to) but no chime, no browser notification, no toast.

### Fix

Factor the dual-write into a single `broadcastNew(event)` helper inside the watcher's scope. Every path that previously `safeWrite`d now calls the helper instead. The helper writes once to the per-agent stream and once to the master bus.

```ts
const broadcastNew = (e: Record<string, unknown>) => {
  safeWrite(`data: ${JSON.stringify(e)}\n\n`);
  try {
    pushSystemEvent({ type: 'new_mail', agentId: agent.id, agentName: agent.name, event: e });
  } catch { /* never fatal */ }
};
```

Three call sites updated. Net: chime, notification, and toast now fire for ALL new-mail classes, not just the external fall-through path.

### Fixed — Activity badges hid agents off the right edge with no way to know

User report: *"whenever there are multiple agents running it does not show all of them status because of the spacing."*

The topbar's `.activity-badges` was `overflow-x: auto` but with `scrollbar-width: none` AND no visible affordance for "there's more". With 4 active agents on a normal-width screen only 2 badges fit; the other 2 were silently clipped off the right edge.

### Fix

Three small UI changes:

1. **Always-visible count pill.** New `<span id="activity-badges-count">` sits to the left of the scrolling strip and renders the active-worker total ("3"). Stable affordance independent of how many badges fit in view. Click target / tooltip shows the friendly form ("3 agents active").
2. **Edge-fade mask.** The scrollable strip now has a CSS `mask-image` linear gradient that fades to transparent at each end, visually signalling "more content past this edge". Pure CSS, no JS.
3. **Scroll-snap.** `scroll-snap-type: x proximity` so swiping/trackpad-scrolling never leaves a badge half-clipped at the viewport boundary.

The DOM was restructured: badges now live inside a `<div id="activity-badges-shell">` whose `hidden` attribute is toggled when the worker count is zero (avoids leaving an empty "0" pill in the topbar).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.11 | 0.9.12 |
| `@agenticmail/cli` | 0.9.14 | 0.9.15 |

## [0.9.14] - 2026-05-15

### Fixed — Moving an email to Spam/Archive: mail disappeared from inbox but never showed in the target

User report: *"when I move an email to spam or archive it doesn't show up there whenever I check."*

Two compounding issues, one in the API and one in the front-end.

### Issue 1: API name mismatch silently 400'd every bulk-move-to-spam

The web UI's `runBulkAction` for the "spam" case posted:

```json
{ "uids": [...], "folder": "INBOX", "toFolder": "Junk Mail" }
```

But the API's `POST /mail/batch/move` destructured `{from, to}`,
not `{folder, toFolder}`. So `toFolder` (the API's local var) was
`undefined`, the route hit `if (!toFolder)` and returned 400. The
front-end's `apiPost` did surface a toast but the user often
missed it amid the "row vanishes from list" optimistic update.
Net effect: the email APPEARED to move (the list reload no longer
showed it because we just rebuilt the digest) but it never
actually changed folders — staying in INBOX with the original
flags untouched.

Note: the seen/unseen/archive/trash batch endpoints all read
`folder` from the body. Only `batch/move` used the
`{from, to}` shape. Inconsistent and easy to miss.

**Fix:** `batch/move` now accepts EITHER shape — `{from, to}` (the
historical contract, kept for any MCP/curl callers that adopted
it) OR `{folder, toFolder}` (matches every other batch endpoint
and is what the UI already sends).

```ts
const fromFolder = body.from ?? body.folder;
const toFolder   = body.to   ?? body.toFolder;
```

Also invalidates the parsed-message cache for the moved UIDs so a
subsequent refresh doesn't serve stale-folder data from the LRU.

### Issue 2: Folder cache went stale after first-time folder creation

The API auto-creates `Archive` on the first archive operation and
`Spam` (where missing) on the first spam classification. But the
web UI's `state.folderNames` cache is populated ONCE at agent
switch — if Archive didn't exist at that moment, the cache had no
entry for it, and clicking the Archive sidebar tab showed *"No
Archive folder on this server."* even though the API had just
created one.

**Fix:** when `loadList` resolves the IMAP folder name and the
cache MISSES, force a fresh discovery once before declaring the
folder absent:

```js
let imap = isStarred ? 'INBOX' : imapNameFor(folder);
if (!imap) {
  state.folderNames = {};
  await ensureFolderCache(agent);
  imap = imapNameFor(folder);
}
if (!imap) { /* genuinely missing → empty state */ }
```

Covers both the just-created-Archive case and the
just-created-Spam case.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.10 | 0.9.11 |
| `@agenticmail/cli` | 0.9.13 | 0.9.14 |

## [0.9.13] - 2026-05-15

### Fixed — Wake allowlist silently excluded everyone when sent as a JSON string

User report: a Claude session sent emails to two sub-agents
explicitly via `wake: ["orion"]` and `wake: ["vesper"]`, but
the dispatcher logged:

```
[dispatcher] wake allowlist excludes "orion" (list=["[\"orion\"]"]) — mail delivered, no Claude turn
[dispatcher] wake allowlist excludes "vesper" (list=["[\"vesper\"]"]) — mail delivered, no Claude turn
```

The dispatcher was checking `is "orion" in the list?` against a
list whose ONLY element was the literal string `'["orion"]'` —
brackets and quotes baked in. No match → wake excluded → mail
delivered to the inbox but no Claude turn fired. The sender's
intent was correctly addressing orion, but no agent woke up.

### Root cause

`normalizeWakeList` in `routes/mail.ts` handled three input
shapes:

  - real array (`["orion"]`) → used as-is
  - CSV string (`"orion,vesper"`) → split on commas
  - anything else → undefined

When Claude (or middleware) JSON-stringified the array before
the MCP call — producing `wake: '["orion"]'` — the function hit
the CSV path:

```ts
if (typeof value === 'string') return value.split(',').map(strip).filter(Boolean);
```

`'["orion"]'.split(',')` → `['["orion"]']`. The `strip` helper
trimmed whitespace and stripped `@localhost`, neither of which
applied → the literal bracketed-and-quoted string survived as
a single "agent name". Every wake against the real agent name
then failed.

### Fix

`normalizeWakeList` now detects JSON-array strings before
falling through to the CSV path:

```ts
const trimmed = value.trim();
if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(v => strip(String(v))).filter(Boolean);
    }
  } catch { /* not valid JSON — fall through to CSV path */ }
}
return value.split(',').map(strip).filter(Boolean);
```

The CSV fallback is preserved for genuinely malformed input
(`"[orion]"` with no quotes around the name is treated as a
single-name CSV — same behaviour as before).

### Tests

19 api tests pass (was 12, +7 in `wake-list.test.ts`):

  - undefined / null → undefined
  - `"all"` and `WAKE_ALL_SENTINEL` → undefined (opt-out)
  - real array → pass through (lowercased, `@localhost` stripped)
  - CSV string → split on commas
  - JSON-array string → parsed back to array (the regression fix)
  - bogus brackets → CSV fallback (no silent drop)
  - non-string non-array → undefined

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.9 | 0.9.10 |
| `@agenticmail/cli` | 0.9.12 | 0.9.13 |

## [0.9.12] - 2026-05-14

### Added — Capabilities preamble injected on session start (and on auto-compact)

The model used to start every Claude Code session with no narrative
about what AgenticMail is FOR. It could see the tools in its
tool-use schema but had no signal about WHEN to reach for them, so
"build me a multi-role thing" prompts often went to single-process
scaffolding when AgenticMail would have unlocked parallel
designer + developer + reviewer agents on a durable email thread.

Fix: register the existing mail-hook on `SessionStart` too. Output
is `hookSpecificOutput.additionalContext` carrying a ~250-token
capabilities blurb covering:

- when to reach for AgenticMail (multi-role parallel work, durable
  async coordination, sub-tasks that need to talk to EACH OTHER);
- the three high-leverage tools (`create_account`, `send_email`
  with `wake`, `call_agent`/`wait_for_email`);
- the canonical coordination pattern (one thread = the shared
  workspace, `wake` controls whose turn it is).

`SessionStart` fires on `source: "startup"`, `"resume"`, AND
`"compact"`. The compact case is the critical one — Claude Code's
auto-compaction wipes the model's context mid-session but keeps
the same `session_id`. A naive "once per session_id" dedup
elsewhere would silently swallow the re-inject the model needs
after its context was wiped. Hooking `SessionStart` makes the
blurb re-appear cleanly post-compact with no extra plumbing.

UserPromptSubmit also retains a fallback path: if a session has
never seen the blurb (rare — only happens when SessionStart
doesn't fire, e.g. older Claude Code builds), we inject on the
first user prompt as a safety net. Dedup'd in
`~/.agenticmail/claudecode-hook-sessions.json` (capped at 100
entries LRU) so it's a no-op once SessionStart has done its job.

`HOOK_EVENTS_TO_REGISTER` is now `['UserPromptSubmit', 'Stop',
'SessionStart']`. Stop continues to handle autonomous-mode mail
backlog awareness exactly as before.

### Fixed — Prev (Back) button invisible after first page

User report: *"after the first 50 emails and I click the next button,
I can't see the back button on the web."*

Both pager buttons share the same `back` chevron glyph — Prev as-is
(points left), Next with a 180° transform. The toolbar markup was:

```html
<button class="icon-btn pager-btn" id="pager-prev" title="Newer" data-icon="back"></button>
<button class="icon-btn pager-btn" id="pager-next" title="Older"></button>
```

The `data-icon="back"` attribute on Prev was just metadata —
nothing in the JS actually populated its innerHTML. Only Next got
`document.getElementById('pager-next').innerHTML = icon('back', ...)`.
So Prev was a clickable but visually empty button. On page 1 the
empty button blended in (it's disabled there anyway); on page 2+
it was enabled but invisible — the user could click empty space
to go back but had no visual affordance.

Fix: assign the icon HTML to both buttons.

### Tests

121 claudecode tests still pass. One test updated to assert
SessionStart is in the registered hook set alongside
UserPromptSubmit + Stop.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.2.7 | 0.2.8 |
| `@agenticmail/cli` | 0.9.11 | 0.9.12 |

## [0.9.11] - 2026-05-14

### Fixed — Activity badges invisible until next worker event fires

User report: *"on the web UI I can't see the agent status anymore."*

The activity-badge stream only carries `worker_started` /
`worker_heartbeat` / `worker_finished` events — it doesn't replay
currently-active workers when the UI connects. So when the user
opened the page while an agent was already mid-turn, the badge
stayed invisible until either:

  - the worker's next heartbeat fired (cadence: ~30 s), OR
  - the worker finished (in which case `worker_finished` just
    removes the badge that never appeared in the first place).

For short-lived wakes the badge never showed up at all, even though
the worker was clearly running per `pm2 logs`.

**Fix:** on `subscribeToActivity()`, do a one-shot GET against
`/dispatcher/activity` (which returns the current active-worker
list) and seed the workers map BEFORE the SSE feed takes over.
Badges paint immediately on page load if anything is in flight;
the SSE stream then handles all updates from that point forward.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.8 | 0.9.9 |
| `@agenticmail/cli` | 0.9.10 | 0.9.11 |

## [0.9.10] - 2026-05-14

### Fixed — Back button from message detail left the message view stuck on screen

Regression introduced in 0.9.8's `route()` rewrite. The function was:

```js
if (state.selectedFolder === folder) return;
```

Goal: skip re-loading the list on no-op hash flips. But `state.selectedFolder`
never changes when the user opens a message (`#/m/<uid>` only flips the
URL — the folder selection is preserved so closing the message returns
to the same folder). So when the user hit Back from `#/m/54` to
`#/folder/inbox`, the URL updated but `route()` early-returned and the
message-detail DOM stayed visible.

**Fix:** track which view shape is currently rendered (`'folder' |
'message' | 'draft'`). Skip the reload only when we're already showing
this folder's LIST view — coming back from a message/draft to a folder
URL always re-renders the list, even if the folder hadn't logically
changed. Pagination + sidebar re-render still only happen when the
folder actually differs, so the no-op hash-flip optimization survives.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.7 | 0.9.8 |
| `@agenticmail/cli` | 0.9.9 | 0.9.10 |

## [0.9.9] - 2026-05-14

### Fixed — Web UI hung on every page refresh (browser connection cap saturation)

The user reported "refreshing hangs forever" and individual API calls
(`/`, `/mail/messages/52`) "slow as fuck". Root cause was structural,
not per-endpoint.

**`sse.js` was opening one persistent SSE connection PER agent.** With 5
agents that's 5 long-lived HTTP connections, plus 1 for the
`/system/events` activity-badge stream = **6 connections per origin** —
which is exactly the browser cap. Every other request (page reload,
message fetch, attachment download, favicon, branding image) had to
**wait for an SSE slot to free** — which never happened, because
SSE connections are persistent by design.

This compounded with two other issues:

- **No static-asset caching headers.** Every refresh re-downloaded every
  `.js` / `.css` / branding image, eating ~30 round-trips per refresh.
- **`/mail/messages/:uid` had no result cache.** Re-opening the same
  message (back/forward, search-and-click, SSE refresh) repeated the
  full IMAP fetch + mailparser + spam scoring pipeline every time
  (~130 ms on a 60 KB plain-text body).

### Fix — multiplex SSE through one master channel

New module `public/js/system-stream.js`: opens ONE shared SSE
connection to `/api/agenticmail/system/events`. Other modules
register typed event handlers via `onSystemEvent(type, handler)`.

Server side, `routes/events.ts`'s `watcher.on('new', ...)` now also
calls `pushSystemEvent({ type: 'new_mail', agentId, agentName, event })`
to fan per-agent new-mail events out to the master bus. The dispatcher
still uses the per-agent `/events` SSE for its own auth-scoped routing
(which is the right scope) — only the UI switches to the multiplexed
channel.

**Net: 6 SSE connections → 1.** Five connection slots freed for actual
HTTP traffic. Page refreshes, message fetches, attachments, and
images all stop blocking on each other.

### Fix — parsed-message LRU cache

New in-process LRU (`PARSED_MESSAGE_MAX=200`, 60 s TTL) keyed by
`agentId::folder::uid`. The `/mail/messages/:uid` handler checks it
before doing IMAP fetch + mailparser. Mutation handlers
(`seen`, `unseen`, `star`, `move`) call `invalidateParsedMessage`
so concurrent state changes never serve stale flags.

Repeat-open of the same message drops from ~130 ms to ~5 ms.

### Fix — strip raw attachment binaries from message response

`/mail/messages/:uid` used to embed full attachment `content: Buffer`
fields inline in the JSON response. When JSON-stringified, Buffer
serializes to `{type:"Buffer", data:[...]}` — bloating responses by
megabytes on attachment-heavy threads. Now we return metadata only
(`filename`, `contentType`, `size`, `contentDisposition`, `cid`,
`related`, `index`) and the UI fetches binaries on demand from the
existing `/mail/messages/:uid/attachments/:index` endpoint.

### Fix — static asset caching

`app.ts`'s `express.static` now sends `Cache-Control: public,
max-age=300, must-revalidate` on `.js`/`.css`/images, and
`no-cache, must-revalidate` on `.html`. Refreshes will revalidate
(304 Not Modified, ~1 KB per asset) instead of re-downloading.

### Fixed — All TypeScript errors across the monorepo

The api package had **78 TypeScript errors** at strict mode and
core/mcp had a handful more. Root cause: api package had
`@types/express: ^5.0.0` (Express 5 types where `req.params` is
`Record<string, string | string[]>`) while runtime was `express: ^4.21.0`
(where `req.params` is always `Record<string, string>`). Every
`parseInt(req.params.id)` and `db.prepare(...).get(req.params.x)`
tripped a type error.

Downgrading `@types/express` to `^4.17.0` to match runtime erased 73
errors in one change. The remaining handful were real issues:

- `routes/features.ts`: parameter declared `_accountManager` (unused
  marker) but referenced as `accountManager` in two call sites — would
  crash at runtime. Renamed.
- `routes/mail.ts`: `client.search({ header: ['Message-ID', id] }, ...)`
  used the wrong header-search arg shape (tuple). Imapflow expects
  `{ 'Message-ID': id }`. Pre-existing — would have failed any
  thread-lookup by Message-ID.
- `app.ts`: `express.static` callback typing; `rateLimit()` handler
  ABI mismatch between v7 (Express 5 typed) and our v4 runtime —
  cast through `unknown as RequestHandler`. Also rename `max → limit`
  for express-rate-limit v7.
- `core/__tests__`: replaced `Database.Database` import (better-sqlite3,
  no longer used) with `ReturnType<typeof createTestDatabase>`.
- `mcp/src/tools.ts`: `encodeURIComponent(args.folder)` where folder
  is `unknown` from zod — coerced via `String(...)`.
- `claudecode test`: 'error' SSE event shape mismatch — cast through
  `unknown`.

**Net: 0 TypeScript errors across api/core/mcp/claudecode.**

### Tests

495 total tests pass (core 362 + claudecode 121 + api 12).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.6 | 0.9.7 |
| `@agenticmail/claudecode` | 0.2.7 | 0.2.7 (unchanged code, no republish) |
| `@agenticmail/cli` | 0.9.8 | 0.9.9 |

Plugin manifest mirrored to 0.9.9. core / mcp got TS-only cleanups
that don't change runtime behaviour, so no version bump on those.

### Operator upgrade

```
npm install -g @agenticmail/cli@latest
# Restart the API process (it's run from the CLI, not under PM2):
# stop whatever's running on :3829, then re-launch with your usual command.
pm2 restart agenticmail-claudecode-dispatcher
```

## [0.9.8] - 2026-05-14

Three orthogonal fixes shipped together: a 16× speedup on the web UI's
inbox load, a pagination bug that stuck Next disabled on every folder,
and the dispatcher learning how to resume after a restart.

### Fixed — Web UI inbox was 2-3 seconds slow and Next button stuck disabled

`/api/agenticmail/mail/digest` (called on every folder open) had three
compounding problems:

1. **Full RFC822 body fetch per row.** It IMAP-fetched the entire raw
   message source of every UID just to slice the first 240 chars of
   body text. On a 50-message page with attachments that's tens of
   megabytes pulled across IMAP for a preview.
2. **Sequential mailparser invocations.** It then `await`ed
   `parseEmail(raw)` in a for-loop, so 50 parses ran one after the
   other instead of overlapping I/O.
3. **Stale total count.** The total returned via
   `mailboxInfo.exists` reads from `client.mailbox.exists` — a
   cached count from the last SELECT/EXISTS push that lags behind
   reality on pooled IMAP receivers. On folders with >50 messages
   the cache often still said 50, which made the UI's pager think
   the user was already on the last page and disable Next.

Plus, the front-end bootstrap fired TWO digest requests on every page
load — once from `selectAgent → loadList` and again from
`location.hash = '#/folder/inbox'` triggering `hashchange → route →
loadList`. Both ran in parallel; both were slow.

**Fix:**
- The digest endpoint now does ONE mailbox lock: SEARCH ALL (gives
  authoritative total + UID list) → fetch envelopes for the page
  → fetch truncated source (`source: { start: 0, maxLength: 8192 }`,
  enough for headers + comfortable body preview) → Promise.all over
  mailparser invocations. Truncated-source parse errors fall back to
  an empty preview rather than 500-ing the page.
- Front-end bootstrap reads the URL hash BEFORE `selectAgent` and uses
  `history.replaceState` (not `location.hash = ...`) when seeding a
  missing hash, so only ONE `loadList` fires.
- `route()` only fires `loadList` when the folder actually changed —
  the previous unconditional reload churned the IMAP server on every
  message-detail close.
- Next-button condition simplified to `pageEnd >= total`. The previous
  `state.messages.length < limit` clause was a no-total fallback
  heuristic that backfired on folders with fewer-than-limit items on a
  page.

Net effect on a 50-message INBOX: digest endpoint **~2.4 s → ~150 ms**
(16× speedup), one fetch per folder open instead of two, Next button
correctly enabled whenever more pages exist.

### Added — Dispatcher restart recovery

Before 0.9.8 a dispatcher restart silently dropped any mail that
arrived during downtime AND forgot which UIDs it had already
processed. Two visible symptoms:

1. **Missed mail.** The per-account SSE channel only relays IMAP IDLE
   notifications received in real time — no `since=<uid>` replay. Mail
   sitting unread in an agent's inbox after a restart stayed unread
   until something else (a fresh wake on the same thread, a manual
   `check_messages` from a host) surfaced it.
2. **Reset rate-limiter.** `channel.seenUids` was an in-memory Set
   wiped on every restart. An IMAP IDLE replay of a UID we'd already
   processed could re-fire the worker because nothing remembered we
   already handled it.

**Persistence layer.** New module `dispatcher-state.ts` writes a
single JSON file at `~/.agenticmail/dispatcher-state.json`:

```json
{
  "version": 1,
  "savedAtMs": 1778765912030,
  "accounts": {
    "<agentId>": {
      "lastSeenUid": 142,
      "seenUids": [138, 139, 140, 141, 142]
    }
  }
}
```

Writes are debounced (2 s window) and atomic (`<file>.tmp` + rename),
so a crash mid-flush can never produce a partial file. The `seenUids`
ring is capped at 256 per account to keep the file small. Stop calls
`flushNow()` synchronously so a restart immediately after stop sees
the latest cursor.

**Restart flow** (`dispatcher.ts`):

- On `syncAccounts`, when opening a new SSE channel for an agent, the
  channel's `seenUids` is **seeded** from the persisted cursor. IMAP
  IDLE replays of old UIDs stay deduped.
- On first successful SSE connect for that channel, a one-shot
  `runCatchUp()` fires (`disableCatchupScan` flag exists for tests):
  - **Mail backlog:** `GET /mail/inbox?limit=50` for the agent; any UID
    strictly greater than `lastSeenUid` and not in `seenUids` becomes
    a synthetic SSE `new` event routed through `handleEvent`. The
    wake-budget circuit breaker still applies — a runaway thread that
    hit the cap pre-restart stays muted, restart is NOT a free reset.
  - **Pending task backlog:** `GET /tasks/pending`; any task with
    status='pending' not in `seenTaskIds` becomes a synthetic task
    SSE event.
- Every routed UID calls `state.markSeen(accountId, uid)` so the
  cursor advances. Same for the end-of-turn dedup-against-digested-
  UIDs path. Closed channels (account deleted) call `state.forget()`.

**New DispatcherOptions:**
- `stateFilePath` — override the state file path (tests use tmpdir).
- `disableCatchupScan` — skip the inbox/tasks scan (tests).

### Tests

121 claudecode tests pass (was 114, +7 for `dispatcher-state.test.ts`):

- `returns undefined for unknown accounts on a fresh store`
- `markSeen advances lastSeenUid monotonically and tracks recent UIDs`
- `flushNow writes the state file atomically and survives a reload`
- `corrupt JSON on disk falls back to an empty store instead of throwing`
- `drops malformed cursor entries during load (defensive)`
- `forget(accountId) removes the cursor and persists on next flush`
- `caps seenUids history to keep the file small`

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.5 | 0.9.6 |
| `@agenticmail/claudecode` | 0.2.6 | 0.2.7 |
| `@agenticmail/cli` | 0.9.7 | 0.9.8 |

Plugin manifest mirrored to 0.9.8. core / mcp unchanged.

### Operator upgrade

```
npm install -g @agenticmail/cli@latest
pm2 restart agenticmail-claudecode-dispatcher
# Confirm clean start + see catch-up output if anything was missed:
pm2 logs agenticmail-claudecode-dispatcher --lines 30
```

First-run safety: when no persisted cursor exists yet (fresh install
or first upgrade to 0.9.8), `runCatchUp` does NOT replay the existing
inbox — it seeds the cursor with the current max UID and skips ahead.
Otherwise the first restart would wake every agent on every unread
message, blowing through the wake budget. Live SSE traffic from this
point forward is the source of truth.

## [0.9.7] - 2026-05-14

### Fixed — `TypeError: Cannot read properties of undefined (reading 'uid')` on lone leading-edge wakes

After 0.9.6 booted cleanly, the dispatcher started throwing on EVERY solo wake to a fresh thread:

```
TypeError: Cannot read properties of undefined (reading 'uid')
    at newMailPromptForBatch (dispatcher.ts:680)
    at Dispatcher.fireCoalescedWake (dispatcher.ts:1534)
    at Timeout._onTimeout
```

The `uncaughtException` guard (shipped in 0.9.4) kept the process alive, so no crash-loop — but the post-leading-edge coalesced-wake timer fired a second wake-build attempt that immediately threw, and the worker never spawned.

**Root cause:** the leading-edge coalesce path (0.9.3) installs a **sentinel queue entry with `events: []`** the moment the first event for an (agent, thread) arrives — the leading-edge spawn fires immediately, and the sentinel just exists so the debounce window knows there's an in-flight burst. If no follow-up events arrive inside the window, the timer fires `fireCoalescedWake` against the empty sentinel:

```ts
const prompt = entry.events.length === 1
  ? newMailPrompt(entry.account, lastEvent)
  : newMailPromptForBatch(entry.account, entry.events);  // length === 0 → here
// newMailPromptForBatch reads events[events.length - 1].uid → undefined.uid → throw
```

**Fix:** `fireCoalescedWake` now short-circuits when `entry.events.length === 0` — the sentinel gets cleaned up, no prompt is built, no wake-budget is charged, no worker spawn attempted. The leading-edge fire already did all the useful work.

```ts
if (entry.events.length === 0) return;  // sentinel cleanup only
```

### Tests

114 claudecode tests pass (was 113, +1 regression test):

- `lone leading-edge wake: timer fires with empty queue → no second spawn, no crash` — landed in `packages/claudecode/src/__tests__/dispatcher.test.ts`. Fires one event into a dispatcher with a 200 ms coalesce window, advances fake time past the window, asserts only one spawn happened and the timer callback did not throw.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.2.5 | 0.2.6 |
| `@agenticmail/cli` | 0.9.6 | 0.9.7 |

Plugin manifest mirrored to 0.9.7. core / mcp / api unchanged.

### Operator upgrade

```
npm install -g @agenticmail/cli@latest
pm2 restart agenticmail-claudecode-dispatcher
pm2 logs agenticmail-claudecode-dispatcher --lines 30
```

## [0.9.6] - 2026-05-14

### Fixed — Dispatcher crashed on startup with `Dynamic require of "events" is not supported`

Production dispatcher (PM2) was stuck in a crash-loop and silently not waking any agents. `pm2 logs` revealed:

```
Error: Dynamic require of "events" is not supported
    at chunk-2ESYSVXG.js:11:9
    at ../../node_modules/nodemailer/lib/mailer/index.js
```

**Root cause:** `packages/claudecode/src/dispatcher.ts` imports `ThreadCache`, `AgentMemoryStore`, `threadIdFor`, `normalizeSubject` from `@agenticmail/core` — but `@agenticmail/core` was NOT listed in `packages/claudecode/package.json` dependencies (only `@agenticmail/mcp` and the SDK were). tsup's default behaviour is to externalize listed dependencies and bundle everything else. So core got inlined into claudecode's ESM dist, dragging in core's runtime deps — `nodemailer`, `imapflow`, `mailparser` — all of which are CommonJS packages containing `require("events")`, `require("stream")`, etc. esbuild's ESM output emits those as a `__require()` shim that throws at runtime because ESM has no `require`.

**Fix:** add `@agenticmail/core` to claudecode's `dependencies`. tsup now externalizes it, the bundle no longer contains nodemailer/imapflow/mailparser code, and the dispatcher starts cleanly.

Verification: built bundle dropped from ~15 chunks (multi-MB CJS payloads) to ~9 small chunks. `grep -l nodemailer dist/*.js` is empty. `grep '__require("events")' dist/*.js` is empty.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.2.4 | 0.2.5 |
| `@agenticmail/cli` | 0.9.5 | 0.9.6 |

Plugin manifest mirrored to 0.9.6. core / mcp / api unchanged (no code changes there).

### Operator note

Upgrade with:

```
npm install -g @agenticmail/cli@latest
pm2 restart agenticmail-claudecode-dispatcher
pm2 logs agenticmail-claudecode-dispatcher --lines 30   # confirm clean start
```

## [0.9.5] - 2026-05-14

### Fixed — Don't re-wake an agent for mail it already read in-line

When an in-flight worker proactively calls `read_email(uid)` for a UID that arrived mid-turn (e.g. it checked `list_inbox` after sending a reply and saw a new arrival), the dispatcher used to also fire its own queued wake for the same UID after the worker finished — duplicate work, duplicate Claude turn, duplicate reply on the thread.

**Fix:** the per-worker observer now tracks every UID the worker passed to `read_email` via a regex on the captured `tool_use` log line. At end-of-turn, before releasing the per-agent serial lock:

1. Scan the coalesce queue for this agent — drop any pending events whose `uid` is in the digested set.
2. Seed those UIDs into the channel's `seenUids` set so a future SSE replay (IMAP IDLE reconnect, push retry) stays deduped without firing a fresh worker.

Empty coalesce entries are cleaned up so the queue doesn't accumulate dead keys.

Test: `drops queued wakes for UIDs the worker already read during its turn` mocks an SDK that emits a `tool_use` frame for `mcp__agenticmail__read_email({uid: 200})`, lands UID 200 in the coalesce queue mid-turn, advances past the debounce window, and asserts only ONE spawn fires (the leading-edge wake on UID 100). The queued 200 is dropped because the worker handled it.

Pattern symmetry: this mirrors how Claude Code's harness handles user-typed messages mid-turn — the messages queue, but the harness deduplicates against what the model already saw. The agent harness is the user-facing version of the same idea; AgenticMail's dispatcher is now the agent-facing version.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.4 | 0.9.5 |
| `@agenticmail/claudecode` | 0.2.3 | 0.2.4 |
| `@agenticmail/cli` | 0.9.4 | 0.9.5 |

Plugin manifest mirrored to 0.9.5. core / mcp unchanged.

### Tests

113 claudecode tests pass (was 112, +1 for the dedup test).

## [0.9.4] - 2026-05-14

### Added — Per-agent serialization + crash hardening

Two dispatcher robustness wins for broadcast-to-everyone bursts:

**Per-agent serialization.** At most ONE worker runs for any given agent at a time. When 5 emails for Vesper arrive in the same second (broadcast on a 5-CC thread), the dispatcher serialises them: first wake fires, subsequent wakes wait on a per-agent promise chain (`Map<agentId, Promise>`) and run sequentially once the prior worker finishes. Stops the failure mode where simultaneous Vesper workers raced on the same IMAP connection / thread cache / agent memory file and crashed the dispatcher.

**Global concurrency cap bumped from 10 → 50.** Now safe because the per-agent gate prevents any single agent from monopolizing slots — 50 distinct agents can run in parallel without one agent fanning out into 5 of them.

**Process-level crash guards.** `dispatcher-bin.ts` now installs both `unhandledRejection` and `uncaughtException` handlers that LOG and CONTINUE rather than terminating. A bad event (e.g. malformed SSE frame, transient ImapFlow throw, third-party panic) used to take the whole daemon down — now it's a log line, the dispatcher keeps running. No process.exit() from either handler. Operator can still see structurally-broken state in the logs and restart manually if needed.

### Added — Pagination on every folder

Every list view now has Prev / Next buttons + a Gmail-style **"X–Y of Z"** count in the toolbar. Page size is 50; offset persists in `state.pagination` and resets to 0 on folder switch + agent switch.

- IMAP folders (inbox / sent / drafts (IMAP) / spam / trash / archive / all): server-side via `/mail/digest?offset=` & `&limit=` (the endpoint already returned `total`; we wire it through).
- Drafts (SQL): client-side slicing of the `/drafts` list — same UX, no extra round trips.
- Preserved across silent SSE refreshes — a new arrival doesn't yank the user back from page 3.
- Prev disabled at offset 0; Next disabled when the current page is the last (either `pageEnd >= total` or the fetched page is shorter than `limit`).

### Added — Real-time worker activity badges

Between the search bar and the notification bell, one pill per active dispatcher worker shows what each agent is doing right now:

```
[🟢 V Vesper · editing code]  [🟢 O Orion · reading mail]  [🟢 A Atlas · running shell]
```

The pulsing green dot reads as "alive." Friendly status verbs are derived from the worker's `lastTool`:

| Tool | Status |
|---|---|
| Read / read_email | reading |
| Write / Edit | writing/editing code |
| Bash | running shell |
| Grep / Glob | searching |
| WebFetch / WebSearch | fetching/searching web |
| send_email / reply_email | sending mail / replying |
| call_agent | delegating |
| submit_result | finishing |
| save_thread_memory | saving memory |
| _anything else_ | working |

The API now pushes a `worker_heartbeat` event to `/system/events` on every dispatcher heartbeat (was only emitting `worker_started` / `worker_finished` before). The new `js/activity-badges.js` module subscribes with the master key, maintains a `Map<workerId, state>`, and re-renders on every event. Update cadence = heartbeat cadence (30 s).

Badges hide on narrow viewports (<800 px).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.3 | 0.9.4 |
| `@agenticmail/claudecode` | 0.2.2 | 0.2.3 |
| `@agenticmail/cli` | 0.9.3 | 0.9.4 |

Plugin manifest mirrored to 0.9.4. core / mcp unchanged.

## [0.9.3] - 2026-05-14

### Fixed — Inbox flickered on every new arrival

The SSE handler called `loadList()` on every new-mail event for the active agent, which blanked the rows with "Loading…" and rebuilt the toolbar — every arrival felt like a page refresh, scroll jumped, selection was wiped, bulk-action toolbar disappeared.

Added a new `silentRefresh(agent, folder)` export in `js/list-view.js` that re-fetches the digest in the background and re-renders **only** the `.list-rows` content. The toolbar, select-all state, per-row checkboxes, and scroll position are untouched. The new email slides into the list silently.

### Added — Soft chime notification + toggle

Web Audio API synthesises a 220 ms two-note chime (E5 → A5) on every new mail. No external asset; nothing in `branding/` to maintain. Plays regardless of tab focus — that's the point.

Toggle button in the topbar (between refresh and the avatar) flips it on/off. Preference persists in `localStorage` under `agenticmail.notif.soundEnabled`. Two icon states (`soundOn` bell pink / `soundOff` bell-slash muted). Clicking the toggle to ON plays a sample chime so the user hears what they just enabled.

Browser autoplay policy may mute the very first chime after a fresh page load if the user hasn't interacted yet; subsequent arrivals work normally. The user toggle is always respected.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.9.2 | 0.9.3 |
| `@agenticmail/cli` | 0.9.2 | 0.9.3 |

Plugin manifest mirrored to 0.9.3. core / mcp / claudecode unchanged.

## [0.9.2] - 2026-05-14

### Fixed — `reply_email({ replyAll: true })` dumped everyone on `To:`

The 0.9.0 wake-default-from-To relies on senders using `To:` vs `Cc:` correctly. But the `reply_email` MCP tool and the web UI's reply-all both merged `original.to + original.cc + sender` into ONE `to` field on the outgoing message — every reply-all had every participant on `To:`. Result: the dispatcher's "wake on To: only" default fired for every recipient, every round. Wake-thrash was back in disguise.

Canonical reply-all is now:

- **To:** the original sender (the conversational counterparty)
- **Cc:** every other participant from the original `To` + `Cc`, minus the sender of the new reply

The MCP tool builds this shape automatically — agents don't need to think about it. Both `packages/mcp/src/tools.ts` (`reply_email` handler) and `packages/api/public/js/compose.js` (`openReply` web-UI flow) were updated.

### Changed — Tool descriptions made the To/Cc semantics explicit

`send_email` and `reply_email` descriptions now spell out "To is for action, Cc is for awareness" and explicitly call out that lumping every participant on `to` defeats the wake gating. The `to` field's per-parameter description ("Primary actor — the agent(s) you want to act on this message. Usually one address; rarely two. **Everyone else on the thread goes on `cc`, NOT here.**") makes the foot-gun visible at the tool-input level so models pick the right shape.

### Changed — Wake prompt teaches the reply addressing pattern

The dispatcher's new-mail wake prompt now includes a `## Reply addressing — CRITICAL for wake control` section that:

- Documents how `replyAll: true` automatically produces the correct shape.
- Forbids hand-rolling a comma-separated address list via `send_email` (the old failure pattern).
- Shows the explicit `wake: ["next-actor"]` example for handoffs.
- Shows `wake: []` for silent sign-off.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.9.1 | 0.9.2 |
| `@agenticmail/api` | 0.9.1 | 0.9.2 |
| `@agenticmail/mcp` | 0.9.1 | 0.9.2 |
| `@agenticmail/claudecode` | 0.2.1 | 0.2.2 |
| `@agenticmail/cli` | 0.9.1 | 0.9.2 |

Plugin manifest mirrored to 0.9.2. openclaw unchanged.

## [0.9.1] - 2026-05-14

The visibility release. Critical follow-up to 0.9.0 — the host could no longer tell whether the dispatcher was alive, deciding to skip, or just debouncing. This release closes every "what just happened?" gap.

### Fixed — Lone wakes no longer suffer 30 s debounce delay

0.9.0's wake coalescing was pure trailing-edge debounce: every wake (including a single isolated reply) waited the full 30 s before firing. From the host's perspective the dispatcher looked dead for half a minute after every send.

Rewritten as **leading-edge fire + trailing-edge debounce**:

- First event for a `(agent, thread)` fires **immediately** — zero perceived latency on a lone reply.
- Subsequent events within the 30 s window queue onto a debounce timer that fires once at the trailing edge with the burst as a coalesced batch.
- So a burst of 4 quick replies now produces 2 wakes (one immediate + one coalesced for the remaining 3), not 1 wake delayed by 30 s and not 4 separate wakes.

This addresses the reported symptom "host sends to sub-agent, dispatcher doesn't wake them" — the dispatcher WAS going to wake, it was just sitting in the debounce queue. Now it fires the leading-edge wake immediately.

### Fixed — `deriveDefaultWakeList` display-name regex

When the sender's `to` field used display-name addressing (`"Vesper <vesper@localhost>"`), the `endsWith('@localhost')` check saw `vesper <vesper@localhost>` (ends with `>`, not `@localhost`) and skipped the recipient. The implicit allowlist returned `undefined` and fell through to "no allowlist → everyone wakes" — which masked the bug in many cases but produced inconsistent semantics. Fix: extract the bare address **before** the endsWith check.

### Added — Dispatcher process heartbeat + activity visibility

The host can now answer "is the dispatcher even running?" without `pm2 list` or guessing. Five new visibility surfaces:

1. **Process heartbeat.** The dispatcher posts to `/dispatcher/process-heartbeat` every 30 s (plus once on `start()`) with its alive-state: `uptimeMs`, active channels, coalesce queue size, currently-running workers, max concurrency. The API folds this into `GET /dispatcher/activity` as a `dispatcher: { state: 'alive'|'unhealthy'|'missing', ... }` block. State transitions:
   - `alive` — heartbeat is < 90 s old (default healthy)
   - `unhealthy` — heartbeat is > 90 s old (dispatcher is up but unresponsive)
   - `missing` — never seen a heartbeat (dispatcher down or pre-0.9.1)

2. **Skipped-wake ring buffer.** Every filter decision that drops a wake now posts to `/dispatcher/worker-skipped` with a reason: `thread-closed`, `allowlist-excluded`, `wake-on-cc`, `budget-exhausted` (more landing in 0.9.2). `check_activity` surfaces a `skipped` block listing the last 100 (capped to 5 min) so the host can answer "why didn't Vesper wake?" in one query.

3. **Worker-queued notifications.** When a wake is appended to the coalesce queue (subsequent burst events), the dispatcher posts to `/dispatcher/worker-queued` with `fireAtMs` so the host can see the pending fire time.

4. **Compaction iteration hooks** (foundation laid; surfaces in `tail_worker` as the SDK emits the `result` frame with `usage`). Next release will surface `compactionIteration: N/4` directly in `check_activity`.

5. **Context-budget telemetry per worker** (already in this release). `check_activity` shows the SDK-reported usage line on finished workers: `⚡ in=12450 out=890 cacheR=8200 cacheW=4250 cost=$0.0312`. The `cacheR` token count is 0.9.0's wake-context layer working — prior thread context that didn't need to be re-tokenised.

### Added — Per-agent `wake_on_cc: false` flag

Account-level preference. When the agent is registered with `wake_on_cc: false`, the dispatcher **skips every wake** where this agent was on Cc/Bcc but NOT on To, regardless of the sender's wake list. The intended use: "coder" / "silent observer" agents that should only wake when explicitly named on To.

- **Migration**: `016_agent_wake_on_cc.sql` adds an `INTEGER NOT NULL DEFAULT 1` column. Existing accounts default to true (current behaviour preserved).
- **API**: `PATCH /accounts/:id/wake-on-cc` body `{ wakeOnCc: boolean }`. Master-key scoped.
- **SSE wire format**: events now carry a per-recipient `wasOnTo` boolean so the dispatcher can honor the preference without re-parsing addresses.
- **Skipped path**: dispatcher posts `worker-skipped: wake-on-cc` when filtering, so the host sees the decision.

### Added — Web UI distinguishes To / Cc / Bcc properly

The message detail view used to lump every recipient under a single `to:` line. Now renders three separate labeled rows (`To:`, `Cc:`, `Bcc:`) with proper alignment, only showing fields that have recipients. Existing CSS extended with `.message-recipient-row` + per-field colour treatment.

### Added — `docs/wake-patterns.md`

New documentation page covering every wake pattern: sender-side `wake` argument shapes, the per-agent `wake_on_cc` preference, coalescing semantics, and five recommended patterns (designer→coder handoff, rotating actors, silent observers, broadcast, audit log).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.9.0 | 0.9.1 |
| `@agenticmail/api` | 0.9.0 | 0.9.1 |
| `@agenticmail/mcp` | 0.9.0 | 0.9.1 |
| `@agenticmail/claudecode` | 0.2.0 | 0.2.1 |
| `@agenticmail/cli` | 0.9.0 | 0.9.1 |

Plugin manifest mirrored to 0.9.1. openclaw unchanged.

### Tests

- 112 claudecode tests (was 111, +1 leading-edge coalesce + 1 lone-reply zero-latency regression test).
- 362 core tests (was 339, +23 threading layer from 0.9.0).
- 12 schema-validator tests pass.

## [0.9.0] - 2026-05-14

The wake-context release. Three substantial changes that take a real bite out of multi-agent thread cost:

### Added — Layered wake-context system (thread cache + per-agent memory)

Every wake used to re-read the entire thread from scratch via `read_email + search_emails`. On a 12-message thread that's ~12 KB of token spend just to rehydrate, scaling linearly with thread length and wake count. Two new layers fix it:

**Layer 1 — ThreadCache** (`@agenticmail/core`). Dispatcher-owned ring buffer per thread. Holds the last 10 message envelopes + ~240-char preview each. Built passively on every SSE new-mail event (even when no agent wakes — selective-wake skips, circuit-breaker mutes, `[FINAL]` markers, none of them prevent the cache from being populated). Shared across all CC'd agents on the thread. LRU-bounded at 5000 threads on disk (~25 MB).

**Layer 2 — AgentMemoryStore** (`@agenticmail/core`). Per-`(agent, thread)` markdown file the AGENT writes at end-of-wake. Captures judgment: what THIS agent committed to, open questions, last action. The cache stores facts; memory stores judgment. Per-agent (your memory is invisible to other agents on the same thread).

On every wake, the dispatcher reads both layers and prepends them as a `## Thread context` block to the wake prompt. Agents see facts + their own prior decisions + the new event, and don't have to `read_email` prior history. Token cost goes from linear-in-thread-length to roughly flat.

New MCP tools:

- **`get_thread_id({uid, folder?})`** — resolve the stable thread id for a UID. Pass to `save_thread_memory`.
- **`save_thread_memory({threadId, summary, commitments?, openQuestions?, lastAction?, lastUid?})`** — persist this agent's narrative. Wake prompt now instructs agents to call this at end-of-turn so the loop is self-perpetuating.

New API surface (agent-key scoped):

- `GET /agents/me/memory/threads/:t` — read own memory
- `POST /agents/me/memory/threads/:t` — write own memory
- `DELETE /agents/me/memory/threads/:t` — clear (also fired by the dispatcher on `[FINAL]` markers)
- `GET /agents/me/thread-id?uid=42&folder=INBOX` — resolve stable thread id

Disk layout (no schema migrations — files only):

```
~/.agenticmail/thread-cache/<t>.json
~/.agenticmail/agent-memory/<agentId>/<t>.md
```

23 new unit tests for thread-id normalization, ThreadCache push/read/dedup/cap/delete, AgentMemoryStore round-trip + per-agent isolation. Dispatcher integration test verifies the wake prompt picks up both blocks on the second wake of the same thread.

### Changed — `wake` default is now "To: only" (not "everyone CC'd")

Long-standing feedback (filed as `agenticmail-feedback-wake-thrash.md`): designers fire 2–4 quick replies on a thread, every CC'd agent wakes once per reply, the same agent produces 4 near-identical status reports. Logged as ~50 wasted Claude turns on a single 9-slice build.

Root cause: the API's `/mail/send` defaulted to "wake every local @localhost recipient" when sender omitted `wake`. CC'd local agents (typically passive observers) were getting Claude turns on every message.

Fix: when sender omits `wake`, derive an implicit allowlist from local recipients on the **`To:` field only**. CC'd local agents receive the mail in their inbox (it shows up in `list_inbox`, the cache, etc.) but **don't get a Claude turn**. Mirrors the email convention "To is for action, CC is for awareness."

Backwards-compat opt-outs:

- `wake: ['alice', 'bob']` — explicit list, wakes exactly those (overrides default-from-To).
- `wake: 'all'` — opt back into pre-0.9.0 "wake everyone on To + CC" behaviour.
- `wake: []` — deliver silently, no wakes.
- Omit `wake` entirely — new default, To-only.

Applies to every send path: `POST /mail/send`, `/drafts/:id/send`, `/templates/:id/send`, and the pending-outbound approval flow. MCP `send_email` / `reply_email` / `forward_email` / `template_send` docs updated.

### Added — Wake coalescing (30s debounce per agent + thread)

Even with the new wake default, an explicit `wake: ['alice']` on three back-to-back replies still wakes Alice three times. The dispatcher now debounces: within a 30 s window for the same `(agent, thread)`, multiple wake events collapse into ONE Claude turn that sees the union of new messages.

Implementation in `@agenticmail/claudecode`:

- New `wakeCoalesce` map keyed by `${agentId}::${threadId}`. First event creates the entry + starts the debounce timer; each subsequent event APPENDS to the event list and EXTENDS the timer (debounce, not throttle).
- Safety valve: after 5× the debounce window from the first event, the timer force-fires even if new events keep arriving (prevents indefinite extension on a continuous reply stream).
- Wake-budget charges ONCE for the coalesced batch — a burst of 4 replies is one logical handoff.
- The wake prompt gets a `newMailPromptForBatch` variant when N > 1: "You have N new messages on this thread (coalesced — they arrived in a burst, you are seeing them in one turn)" + a list of `(UID, sender, subject)` for each. Agent reads the latest, decides once, replies once.
- `wakeCoalesceMs` is configurable (default 30 000 ms); set to 0 to disable coalescing entirely (one Claude turn per event, pre-0.9.0 behaviour).

Test coverage: `coalesces a burst of wakes on the same thread into one Claude turn` uses fake timers to assert three burst events fire exactly one spawn with all UIDs visible in the batch prompt.

### Migration / breaking changes

- **`wake` default changed.** Existing senders that relied on "every CC'd agent wakes" must pass `wake: 'all'` to keep that behaviour. Most multi-agent flows want the new default — re-test your wake patterns before upgrading production.
- **Worker prompts now include a `## Thread context` block on subsequent wakes.** Personas that pre-instruct agents to "read every prior message" should be updated to "use the thread-context block; only `read_email` if you need a specific body."
- **Agents are instructed to call `save_thread_memory` at end-of-wake.** Custom personas should not contradict this — let the wake-prompt postscript do its job.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.6 | **0.9.0** |
| `@agenticmail/api` | 0.7.21 | **0.9.0** |
| `@agenticmail/mcp` | 0.7.9 | **0.9.0** |
| `@agenticmail/claudecode` | 0.1.17 | **0.2.0** |
| `@agenticmail/cli` | 0.8.36 | **0.9.0** |

Plugin manifest mirrored to 0.9.0. openclaw unchanged.

### Tests

- 111 claudecode tests pass (was 109, +2: thread-context injection + wake coalescing).
- 23 new core tests for the threading libs.
- All 339+ existing core tests still pass.

## [0.8.36] - 2026-05-14

### Added — Archive folder, archive button, bulk-action toolbar

Three connected pieces of the same UX gap:

**Archive folder.** New sidebar entry between Drafts and All Mail with the proper IMAP `\Archive` semantics. Auto-discovered via `specialUse === '\Archive'` + name-pattern fallback (`/^archives?\b/i`). On first archive against a vanilla Stalwart, the API auto-creates the folder so the move doesn't 404.

**Single-message archive.** New API endpoint `POST /mail/messages/:uid/archive` moves a message to the archive folder. Adds an archive button to the message-view toolbar between Reply-all and Mark-unread. Archive is non-destructive (Gmail UX) so it skips the confirm modal — toast on success, the user can always undo from the Archive folder.

**Bulk-action toolbar.** When any row checkbox is checked, the list toolbar shows action buttons + a "N selected" counter:

- **Archive** → `POST /mail/batch/archive` (new). Auto-discovers archive folder, creates it if missing.
- **Delete** → `POST /mail/batch/trash` (new). Move-to-Trash by default; from inside Trash it falls through to permanent expunge. Confirm modal with folder-aware copy.
- **Spam** → `POST /mail/batch/move` with `toFolder: <auto-discovered Spam>`. Confirm modal.
- **Mark as read** / **Mark as unread** → existing `POST /mail/batch/seen` / `unseen`. Silent.

Selecting all via the header checkbox flips every visible row; per-row checkboxes also drive the toolbar in / out of view.

### Fixed — Received mail showing up in Sent on some configurations

The previous `saveSentCopy` helper appended outgoing mail to a hard-coded `'Sent Items'` folder. On Stalwart installs that name their folder just `Sent` (or any other variant), every APPEND silently failed with a warning log — leaving the Sent folder empty and explaining why outgoing mail seemed to disappear there. Now uses the same auto-discovery the sidebar does: prefers `specialUse === '\Sent'`, falls back to name-pattern matching, caches per-account.

The web UI also gets a defensive client-side filter: in the Sent folder, only messages whose `from` matches the active agent's email are shown. Server-side mis-routing (if it happens) can't trick the UI into displaying received mail as "Sent" anymore.

### Changed — Visible end-of-message border in the body view

Added a hairline `border-bottom` to `.message-body` so the reader gets a definite stop after the body and quoted-thread chrome. Disambiguates body / attachments / reply-card boundaries.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.20 | 0.7.21 |
| `@agenticmail/cli` | 0.8.35 | 0.8.36 |

Plugin manifest mirrored to 0.8.36. core / mcp / claudecode unchanged.

## [0.8.35] - 2026-05-14

### Fixed — Refresh always reset the active inbox to the host

Refreshing the web UI (or opening it in a new tab) always
re-selected the bridge / host agent, even when the user had
explicitly switched to a sub-agent's inbox. The bootstrap
flow picked the bridge from the freshly-loaded `/accounts`
response and ignored whatever the user had been looking at.

Now persists the selected agent id in `localStorage` under
`agenticmail.selectedAgentId` on every `selectAgent` call.
Bootstrap reads it first; falls back to the bridge if the
stored id is gone (agent deleted) or absent (first visit).
The key is cleared on sign-out so a re-login starts clean.

### Added — Drafts persist attachments across reopen

0.8.31's compose autosave wrote to `/drafts` (SQL) but the
schema had no place for binary blobs, so attachments stayed in
memory only — close the modal, reopen the draft, and your
attached PDF / image was gone. 0.8.32 documented this as
intentional. The user disagreed; here's the fix.

New migration `015_draft_attachments.sql`:

```sql
ALTER TABLE drafts ADD COLUMN attachments TEXT;
```

The column stores a JSON array of `{filename, contentType,
content (base64), size}` entries. The web UI's 20 MB total cap
is preserved; the server adds its own 25 MB sanity bound to
refuse pathological payloads (413 Payload Too Large).

API changes:

- **`POST /drafts`** and **`PUT /drafts/:id`** now accept an
  `attachments` field with the shape above.
- **`PUT`** treats `attachments` as **optional partial-update**:
  it's only written when the field is explicitly present in the
  body. An autosave that just updates the body text doesn't wipe
  the existing attachments.
- New endpoint **`GET /drafts/:id`** returns a single draft with
  full attachment content (base64). The list endpoint
  `GET /drafts` continues to return metadata only (filename /
  contentType / size) so the sidebar list payload stays small.
- **`POST /drafts/:id/send`** materialises persisted attachments
  into the nodemailer `attachments` array with
  `encoding: 'base64'` so sending a draft now includes the files.

Web UI changes:

- The compose modal's autosave includes `attachments` in every
  payload; adding or removing a chip explicitly schedules a save
  so the draft round-trip stays in sync.
- `openDraft(id)` calls the new single-draft endpoint and
  rehydrates `pendingAttachments` with the persisted blobs;
  chips show up in the modal exactly as the user left them.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.5 | 0.7.6 |
| `@agenticmail/api` | 0.7.19 | 0.7.20 |
| `@agenticmail/cli` | 0.8.34 | 0.8.35 |

Plugin manifest mirrored to 0.8.35. mcp / claudecode unchanged.

Tests: 339 core tests still pass.

## [0.8.34] - 2026-05-14

### Fixed — Drafts sidebar showed nothing

The autosave path (compose.js) writes to the SQL-backed `drafts`
table via `POST /drafts`, and so does the MCP `manage_drafts`
tool. But the sidebar's Drafts entry was loading the IMAP
`Drafts` mailbox via `/mail/digest?folder=Drafts`, which is a
separate world. Drafts you typed in the web UI weren't there.

Fixed by making the Drafts folder a special-case in the web UI:

- `loadList(folder === 'drafts')` now branches to a new
  `loadDraftsList()` that pulls from `/drafts` and normalises
  the rows into the same envelope shape `renderList` expects.
- Each row's "from" column reads as the **recipient** (since
  the user is always the sender on a draft) with a small red
  **"Draft"** tag.
- Stars don't apply to drafts; the star slot is reserved but
  left empty so subject columns stay aligned with non-draft
  folders.

### Added — Click a draft → resume editing in compose

New route `#/d/<draftId>` opens the compose modal pre-populated
with the saved draft (to / cc / subject / body) and arms
`composeDraftId` so subsequent autosaves PUT to the same row
instead of creating a duplicate. Resume right where you left
off.

### Added — "Discard" actually discards

The compose modal's **Discard** button used to just close the
modal — the autosaved draft survived in Drafts. Now it deletes
the draft via `DELETE /drafts/:id` and refreshes the Drafts
list if that's where you are. The normal close-button (×)
still preserves the draft for later, which is the right
distinction: closing = "save and come back", discarding =
"throw this away".

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.18 | 0.7.19 |
| `@agenticmail/cli` | 0.8.33 | 0.8.34 |

Plugin manifest mirrored to 0.8.34. core / mcp / claudecode unchanged.

## [0.8.33] - 2026-05-14

### Fixed — Deleting one message wiped the whole inbox

Critical data-loss bug. `receiver.deleteMessage(uid)` called
ImapFlow's `messageDelete` which does:

1. `STORE +FLAGS (\Deleted)` on the target UID
2. **`EXPUNGE`** — which is **mailbox-wide** in IMAP

If any other message in the mailbox already had `\Deleted` set
(from a previous half-completed delete, an agent operation, or
another IMAP client), the expunge removes those too. That's the
IMAP spec, not an ImapFlow quirk.

Same reason your Trash folder was empty after the delete:
`EXPUNGE` is permanent removal, not move-to-Trash.

The fix rewires the API's delete endpoint to **move-to-Trash by
default**, matching Gmail / Outlook semantics:

- `DELETE /mail/messages/:uid` → `messageMove(uid, INBOX, Trash)`.
  Other mailbox state is untouched; the message lives in Trash
  until permanently removed.
- `DELETE /mail/messages/:uid?permanent=true` → explicit expunge.
  Used by the UI when you delete from inside Trash. When the
  server advertises `UIDPLUS` (RFC 4315) we use `UID EXPUNGE` to
  scope the operation to the target UID; falls back to mailbox-
  wide expunge only on servers that don't support it.
- The handler auto-discovers the trash mailbox name (Stalwart's
  "Deleted Items", Gmail's `[Gmail]/Trash`, Outlook's "Deleted
  Items", macOS Mail's "Deleted Messages") via `receiver.list-
  Folders()` + `specialUse === '\\Trash'` matching.
- Source folder defaults to `INBOX`; the web UI passes the real
  IMAP folder name on `?folder=` so deletes from Sent / Drafts
  / Spam etc. move from the right mailbox.

The `MailReceiver` class gained two clearer methods to make the
distinction first-class:

- `moveToTrash(uid, from, trash)` — the safe Gmail-style action.
- `expungeMessage(uid, mailbox)` — explicit permanent delete,
  with the UID EXPUNGE narrowing.

The legacy `deleteMessage()` is preserved as a `@deprecated`
alias for back-compat, but now routes through `expungeMessage`
with the UID EXPUNGE narrowing so even direct API callers get
slightly safer behaviour.

### Hardened — Mark-spam, batchMove, every move path

`moveMessage(uid, from, to)` and `batchMove(uids, from, to)` now
detect IMAP `MOVE` capability (RFC 6851) and use it when
available — that command is atomic and per-UID. On pre-MOVE
servers, the fallback is **COPY + `STORE +\Deleted` on the
target UID(s) ONLY, no EXPUNGE**. The source message survives
as a "hidden" entry until an explicit empty-trash flow, which
is the right tradeoff: an EXPUNGE here would have the same
amplification bug the delete path had.

Mark-spam (`POST /mail/messages/:uid/spam`) and not-spam
(`POST /mail/messages/:uid/not-spam`) call `moveMessage` so
they inherit the hardening — no separate fix needed.

### Changed — Web UI delete copy

The confirm modal now adapts to the current folder:

- From Inbox / Sent / Drafts / etc.: **"Move to Trash" — can
  be recovered from there**.
- From Trash itself: **"Delete forever — can't be undone"**.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.4 | 0.7.5 |
| `@agenticmail/api` | 0.7.17 | 0.7.18 |
| `@agenticmail/cli` | 0.8.32 | 0.8.33 |

Plugin manifest mirrored to 0.8.33. mcp / claudecode unchanged.

## [0.8.32] - 2026-05-14

### Added — In-line thread chrome in the message body view

When a message body contains the canonical reply preface

```
On 2026-05-13T22:50:24.000Z, claudecode@localhost wrote:
> original body line 1
> original body line 2
```

the renderer now detects the pattern, extracts `(date, sender,
quoted body)`, and renders each quoted section as a styled
"thread-quote" card with: sender avatar, name, friendly relative
date (`5 minutes ago — Wed, May 13, 10:50 PM` via the same
`formatDateFull` helper the message header uses), and the quoted
body itself recursively threaded so reply-to-reply chains nest
cleanly. Pink → purple → amber border colours mark depth, same
convention the inline blockquote stripes use.

Non-matching prose (the user's own text, non-reply quotes) flows
through `renderMarkdown` unchanged.

### Fixed — Delete sent `uid=undefined`

`/mail/messages/:uid` (the read endpoint) returns the parsed email
without a `uid` field on it, so `state.currentMessage.uid` was
undefined. Delete + Spam fired with `uid=undefined` and returned
400 from the API. Both actions now read `state.selectedUid`
instead — that's the URL-derived uid the message view was opened
with, and it's always set.

### Added — Attachment downloads in the message view

Existing API route `GET /mail/messages/:uid/attachments/:index`
is now wired into the UI. Attachment chips in the open message
are clickable buttons; click triggers a download via a new
`downloadAttachment(uid, index, filename, opts)` helper in
`js/api.js`. Browsers don't send custom headers on `<a href>`
clicks (returns 401), so the helper does `fetch` with the
Authorization header, converts to blob, builds an object URL,
synthesises a click on a hidden anchor, then revokes the URL.

The chips also show a proper size formatter (B / KB / MB) and
get a `downloading` class while the fetch is in flight.

### Added — Attaching files to outbound mail

Compose modal now has a paperclip button next to Send that opens
a multi-file picker. Files are read with FileReader, base64-
encoded, and stored in an in-memory `pendingAttachments` buffer.
On Send, the buffer is included as `attachments: [{ filename,
contentType, content, encoding: 'base64' }]` in the POST body
to `/mail/send` — the shape the API already accepts.

Soft cap of 20 MB total payload (Stalwart's default SMTP message-
size limit is in that range). Per-attachment chips show name +
size with an `×` to remove. Drafts don't persist attachments
(the drafts table has no binary column); a draft round-trip
loses them by design.

### Changed — Confirm dialogs use a proper modal

Browser-native `window.confirm()` was popping OS-styled alerts
for "Delete this message?" and "Report as spam?". Both now go
through a new `confirmModal({ title, body, confirm, danger })`
helper in `js/modal.js` that renders a centered card with brand
styling, focus management (Esc cancels, Enter confirms when the
button has focus), and a destructive-red variant for delete.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.16 | 0.7.17 |
| `@agenticmail/cli` | 0.8.31 | 0.8.32 |

Plugin manifest mirrored to 0.8.32. core / mcp / claudecode unchanged.

## [0.8.31] - 2026-05-14

Big release: the two long-queued features (compact-and-continue + typed task contracts) plus a sweep of web-UI fixes the user hit while running 0.8.30.

### Added — Compact-and-continue across context limit

Workers can now run across multiple SDK turns when one turn isn't enough to finish a task. `runWorker` is wrapped by a new `runWorkerWithCompaction` loop that:

1. Runs a worker turn.
2. If it succeeds (worker exited naturally via submit_result / reply_email / graceful end), returns.
3. If it fails with a context-overflow error (`prompt is too long`, `context_length_exceeded`, etc.), synthesises a **breadcrumb checkpoint** from the captured tool-call log + last assistant text, builds a continuation prompt prefixed with "Resuming after context reset / do NOT redo these steps", and loops.
4. Caps at 4 iterations (configurable) — enough for a multi-hour task across context resets, low enough to bound runaway cost.

Failure mode if the worker never finishes: returns `compaction budget exhausted` after the iteration cap. No infinite-spend risk.

Test: `compact-and-continue: retries with a checkpoint after a context-overflow error` mocks an SDK that throws on call 1 and succeeds on call 2; asserts the second prompt contains the resume marker.

### Added — Typed task contracts (JSON-Schema-validated `submit_result`)

`POST /tasks/assign` and `call_agent` now accept an optional `outputSchema` field (JSON Schema, draft-7 subset). When attached:

- The schema is persisted on the task row (`agent_tasks.output_schema`, new column via migration `014_task_output_schema.sql`).
- The worker's wake prompt includes the schema verbatim with a "your submit_result MUST conform to this" preamble.
- `POST /tasks/:id/result` validates the result against the schema before accepting. Mismatches return 400 with a flat `schemaErrors: [{ path, message }]` list so the worker can re-read the task and retry with a corrected shape rather than the task hanging.

Validator is a hand-rolled draft-7 subset in `packages/api/src/lib/schema-validator.ts` covering `type`, `required`, `properties`, `items`, `enum`, `additionalProperties: false`, `minLength`/`maxLength`, `minimum`/`maximum`. Unsupported keywords are ignored rather than crashing. 12 unit tests.

Tasks without an `outputSchema` keep the v0.8.x behaviour (accept anything) — fully back-compat.

### Added — Delete + Move-to-Spam in the message view

Two buttons on the open-message toolbar:

- **Spam icon** → `POST /mail/messages/:uid/spam` (moves to Junk + flags as known spam). Confirms before firing.
- **Trash icon** → `DELETE /mail/messages/:uid`. Confirms before firing.

Both routes existed in the API already; the UI just never surfaced them.

### Added — Compose auto-saves to Drafts

Typing in the compose modal now triggers a debounced 2 s save to `POST /drafts` on first edit and `PUT /drafts/:id` on subsequent edits. The draft id lives in `state.composeDraftId`. On send, the draft is deleted after the message goes out (no orphan rows). On modal close without send, the draft stays in Drafts so the user can pick it back up. Compose footer shows a small "Saved to Drafts" status next to the Send button.

### Fixed — `No All Mail folder on this server`

`All Mail` is a Gmail-only virtual folder. Stalwart and most other IMAP servers don't have an equivalent. The sidebar entry was always visible regardless, leading to a dead-end empty state. Now the entry is marked `requiresDiscovery: true` and gets hidden when the per-agent folder cache doesn't match a real IMAP folder. Folder discovery now runs on agent switch (before the first sidebar render) so the hide rule has the cache to consult.

### Fixed — Select-all checkbox in the list toolbar

The checkbox in the list toolbar was rendered but had no listener. Now toggles every visible row's checkbox. Bulk-action toolbar isn't shipped yet, but the selection state is wired so the moment it lands the checkbox does what it should.

### Changed — AgenticMail logo has its white background stripped

The 0.8.26 logo PNG was sourced from a screenshot with a white background baked in (RGB, no alpha). On a dark sidebar / topbar that white box was visible around the bow. Re-processed the source with ImageMagick (`-fuzz 8% -transparent white -alpha set`) to make the surroundings transparent (now RGBA). Brand logo, auth-card heading, and favicon all pick up the new asset.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.3 | 0.7.4 |
| `@agenticmail/api` | 0.7.15 | 0.7.16 |
| `@agenticmail/mcp` | 0.7.8 | 0.7.9 |
| `@agenticmail/claudecode` | 0.1.16 | 0.1.17 |
| `@agenticmail/cli` | 0.8.30 | 0.8.31 |

Plugin manifest mirrored to 0.8.31. openclaw unchanged.

### Tests

- 109 claudecode tests pass (was 108, +1 for compaction).
- 12 new schema-validator tests in `@agenticmail/api`.

## [0.8.30] - 2026-05-14

### Changed — Centered search bar + centered message reading column

Two layout fixes:

1. **Topbar is now a 3-column grid** (`1fr · auto · 1fr`) with the
   search input in the centre column. Previously the topbar was a
   flexbox with `flex: 1` on both the search and a trailing spacer,
   which split the remaining space evenly and drifted search left
   of the visual middle. New grouping divs `topbar-left` (menu +
   brand) and `topbar-right` (refresh + account) anchor the side
   columns so the centre column genuinely centres regardless of
   how wide the side groups get.

2. **Open-message view is centered** in the content pane. Header,
   body, and attachments share `max-width: 840px; margin: 0 auto`
   so long-line text doesn't sprawl across ultrawide displays.
   Matches Gmail's reading column width.

Mobile (<800 px) drops the centered grid in favour of
`auto · 1fr · auto` so the search expands to fill remaining space;
the brand wordmark hides to make room.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.14 | 0.7.15 |
| `@agenticmail/cli` | 0.8.29 | 0.8.30 |

Plugin manifest mirrored to 0.8.30. core / mcp / claudecode unchanged.

## [0.8.29] - 2026-05-14

### Added — Star button is now wired

New API: `POST /mail/messages/:uid/star` with `{ starred: boolean, folder?: string }`. Maps to IMAP's `\Flagged` flag — same on-disk bit Gmail's star uses. Backed by a new `MailReceiver.setStarred(uid, starred, mailbox)` method in `@agenticmail/core`.

Web UI: clicking the star icon now flips the flag with optimistic UI (instant icon swap) and reverts on failure. Starred folder is still a client-side `\Flagged` filter over the inbox so a starred message immediately shows up there.

### Changed — Gmail-compact list UX, uniform across every folder

Replaced the two-line stacked row layout with Gmail's single-line shape:

```
[☐] [★] sender ····· subject — preview body……………………… 7:20 PM
```

- Single 36 px row per message (was ~64 px).
- Subject and preview share one truncated cell separated by an em-dash; longer previews tail off with ellipsis instead of wrapping.
- New leading checkbox column for future bulk-select operations.
- Hover state mimics Gmail: row lifts slightly with a hairline shadow.
- Sender column tightened to 180 px on desktop (140 px below 1100 px); date column right-aligned in 90 px.
- New list-toolbar above the rows: select-all checkbox + refresh + count, sticky to the top of the content pane. Same markup for every folder so Sent / Drafts / Spam / Trash render identically to Inbox.
- Compose button height down from 56 px → 48 px (Gmail's actual spec).

Mobile (<800 px) folds back to a 2-row stack — sender on top, subject + preview below — with star + date on the side.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.2 | 0.7.3 |
| `@agenticmail/api` | 0.7.13 | 0.7.14 |
| `@agenticmail/cli` | 0.8.28 | 0.8.29 |

Plugin manifest mirrored to 0.8.29. mcp / claudecode / openclaw unchanged.

## [0.8.28] - 2026-05-13

### Fixed — Stop hook `Cannot find module .../src/mail-hook.js` in dev checkouts

The 0.8.25 absolute-path resolver always picked `${dir}/mail-hook.js`
where `dir` was derived from `import.meta.url`. That's correct in
published builds (`dist/install.js` → `dist/mail-hook.js`) but
wrong in dev checkouts where the resolver runs from
`src/install.ts` — there's no compiled `src/mail-hook.js`, only
the TypeScript source. Result: `MODULE_NOT_FOUND` on every Stop
hook fire from a workspace install.

Now probes three locations in order:

1. Same directory as the caller (published-build layout).
2. `<dir-without-src>/dist/<file>` (dev checkout with `src/` + `dist/` side-by-side).
3. `<dir>/../dist/<file>` (defensive fallback for tsx-style loaders).

Returns the first hit. Both `agenticmail-mail-hook` and the
dispatcher bin path now share the same resolver. Existing
0.8.25-0.8.27 installs auto-heal on the next `agenticmail
claudecode` run because the upserter rewrites the hook command
with the freshly-resolved path.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.1.15 | 0.1.16 |
| `@agenticmail/cli` | 0.8.27 | 0.8.28 |

Plugin manifest mirrored to 0.8.28. api / mcp / core / openclaw unchanged.

## [0.8.27] - 2026-05-13

### Fixed — Sent/Drafts/Spam/Trash returned empty in the web UI

Hard-coded folder names (`Sent`, `Drafts`, `Junk Mail`, `Trash`)
didn't match the real IMAP names on Stalwart installs that use
`Sent Items` (the default). The web UI now auto-discovers folder
names per-agent via `GET /mail/folders` and matches them to
sidebar ids with regex patterns covering every common server
convention: Stalwart (`Sent Items`, `Junk Mail`, `Trash`), Gmail
(`[Gmail]/Sent Mail`, `[Gmail]/Spam`), Outlook (`Sent Items`,
`Deleted Items`), macOS Mail (`Sent Messages`).

Falls back to vanilla defaults if discovery fails so degraded
mode still works.

### Fixed — Two-line preview on every list row

Previously `/mail/inbox` and `/mail/folders/:folder` returned raw
envelopes with no body preview, so list rows showed only
sender + subject. The web UI now uses `/mail/digest?folder=…`
universally, which returns envelopes WITH a body preview in one
call. List rows render the subject on top, two lines of preview
underneath (CSS `-webkit-line-clamp: 2`), and the dates / stars
top-align so the layout stays clean.

### Fixed — Browser URL now reflects current folder

Folder switches updated state but kept `#/inbox` in the address
bar. Hash router now uses `#/folder/<id>` (sent / drafts / spam /
trash / starred / all / inbox), so browser back / forward works,
URLs are shareable, and a refresh keeps you on the same folder.

### Changed — Stop hook output rewritten

The Stop hook's `reason` field is printed to the user in the
Claude Code transcript ("Continuing because: …"). The 0.8.25
text was written assuming only the model would see it — phrases
like "you do not need to ping the user" and "surface them to the
user" read as awkward instruction-leakage when the user saw it.

Rewritten to be audience-neutral: facts + canonical tool names,
no policy. Body is identical for UserPromptSubmit and Stop. New
shape:

```
🎀 New AgenticMail (bridge inbox) — 2 messages since the last check:

  · UID 2 — vesper <vesper@localhost> · Re: Audit assignment…
    > <preview body up to 180 chars>

  · UID 1 — orion <orion@localhost> · Re: Audit assignment…
    > <preview body up to 180 chars>

Full body: mcp__agenticmail__read_email. Reply: mcp__agenticmail__reply_email (replyAll: true).
```

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.12 | 0.7.13 |
| `@agenticmail/claudecode` | 0.1.14 | 0.1.15 |
| `@agenticmail/cli` | 0.8.26 | 0.8.27 |

Plugin manifest mirrored to 0.8.27. mcp / core / openclaw unchanged.

## [0.8.26] - 2026-05-13

### Fixed — Correct AgenticMail logo (pink bow, not `@` mark)

0.8.25 bundled the wrong PNG from `branding/` as the AgenticMail
logo — the `@`-in-rounded-square mark, which is a different
asset. Swapped in the actual brand identity (pink satin bow,
which is what the 🎀 emoji has been standing in for since 0.8.x)
and removed the `@` mark from the codebase.

Asset locations:

- `branding/logo-source.png` (1254×1254 original)
- `branding/logo-400.png` (downscaled for non-web surfaces)
- `packages/api/public/branding/agenticmail-logo.png` (256×256
  for the web UI — topbar brand, auth-card heading, favicon)

CSS also dropped the rounded-square crop on `.brand-logo` since
the bow ships with transparent background.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.11 | 0.7.12 |
| `@agenticmail/cli` | 0.8.25 | 0.8.26 |

Plugin manifest mirrored to 0.8.26. mcp / claudecode / core /
openclaw unchanged.

## [0.8.25] - 2026-05-13

Six-headline release: dispatcher visibility for hour-long workers,
autonomous-mode awareness on the Stop hook, and a batch of web-UI
bug fixes the user hit while running it.

### Added — Per-worker logs + heartbeats (long-running worker visibility)

Workers can now run for hours without a timeout. To make that
tolerable, the dispatcher writes a per-worker log file at
`~/.agenticmail/worker-logs/<sanitized-id>.log` containing every
SDK message as a one-liner (tool call, tool result, assistant
chunk). And every 30 s the dispatcher POSTs a heartbeat to the
API with the last tool used and a running tool-call count, so
`check_activity` can show real progress instead of an opaque
"still running".

The previous 30-minute hard TTL on `active` registry entries is
gone — long-running workers are no longer auto-evicted. Instead,
each active entry gets a `stale` flag when its heartbeat hasn't
moved in 90 s. Stuck-worker detection is now diagnostic, not
destructive: the host sees the worker, sees `stale=true`, and
decides what to do.

New surfaces:

- `GET /dispatcher/worker-log/:id?lines=N` — log tail endpoint.
- `POST /dispatcher/worker-heartbeat` — dispatcher → API.
- MCP tool **`tail_worker(workerId, lines?)`** — fetch a log tail.
- `check_activity` output now includes `lastTool`, `turnCount`,
  duration formatted as `Xh Ym Zs`, and a `stale` indicator.

### Added — Worker cwd isolation

Each spawned worker gets a fresh scratch directory at
`~/.agenticmail/worker-cwds/<id>/`, advertised to the SDK via the
`cwd` option. Solves the "two parallel agents called the same
Bash one-liner and clobbered each other's output files" race
that surfaced in real multi-agent sessions. The dir is cleaned up
when the worker finishes (best-effort; a worker that wrote a
huge file does not crash the dispatcher trying to delete it).

### Added — Autonomous-mode awareness via Stop hook

The 0.8.23 release left "autonomous-mode awareness" filed as a
follow-up: long-running headless Claude Code sessions (no user
prompts firing for hours) never saw teammate replies because
`UserPromptSubmit` never fires.

Fixed in this release by registering the mail hook on the **Stop**
event in addition to UserPromptSubmit. Stop fires at every natural
turn boundary; the hook returns `{decision: 'block', reason: '...'}`
when the bridge has unread mail, which forces Claude to continue
instead of stopping and surfaces the new-mail summary in the
reason. This is the schema-correct supported way to inject
context at turn boundaries — unlike the 0.8.22 PreToolUse attempt,
which used the wrong output shape and produced the noisy
`PreToolUse:<tool> hook error` spam.

### Fixed — Hook bin resolution (`command not found` errors)

Previous versions registered the hook as the bare bin name
`agenticmail-mail-hook`, relying on the npm global bin dir being
on the user's `$PATH`. When it wasn't (which happens routinely
with non-default npm prefixes, nvm, asdf, etc.), Claude Code
logged `Stop hook error: agenticmail-mail-hook: command not found`
on every turn.

Fixed by resolving the absolute path to `mail-hook.js` via
`import.meta.url` at install time and registering the hook as
`node "/abs/.../mail-hook.js"`. Resilient to any `$PATH`
configuration. The marker matcher accepts both the old bare-name
form and the new absolute-path form, so upgrades auto-heal old
installs on the next `agenticmail claudecode` run.

### Fixed — Web UI: `(m.flags ?? []).includes is not a function`

The IMAP layer sometimes returns `flags` as an object map
(`{Seen: true}`) instead of an array of strings. The web UI
called `.includes()` unconditionally and crashed the list with
"includes is not a function". Added a defensive `flagsHas()`
helper that coerces either shape before checking membership.

### Fixed — Web UI: every folder loaded `/mail/inbox`

The sidebar's Sent / Drafts / Spam / Trash / All Mail folders all
hit `GET /mail/inbox` regardless of which folder you clicked —
the loader ignored the selected folder id. Added a folder→IMAP
endpoint map that routes to `/mail/folders/<Name>` for non-inbox
folders and uses `/mail/inbox` only for Inbox. Starred remains a
client-side `\Flagged` filter over the inbox listing
(Gmail-style).

### Fixed — Web UI: Cmd+C opened the compose modal

The keyboard-shortcut handler matched single-letter keys
(`r`, `c`, `/`) without checking modifier keys. Hitting Cmd+C to
copy text would trigger the `c` branch and pop the compose modal
open. Now bails out the moment any modifier (Cmd / Ctrl / Alt /
Meta) is held — single-key shortcuts only.

### Added — Mobile-responsive web UI

Below 800 px the layout collapses to a proper mobile experience:

- Sidebar slides over content (off-canvas) from the left;
  hamburger button in the top bar toggles it; a backdrop closes
  it on tap.
- List rows lose the from column and fold the sender into the
  preview row, with 56 px row heights for touch targets.
- Message view loses its 800 px content cap; padding tightens.
- Compose modal goes full-screen instead of a tiny bottom-right
  popup nobody could type into.
- Search input shortens; refresh icon hides; brand name shrinks.

### Changed — Branding: official logos

- **AgenticMail logo** — the `@` rounded-square mark from
  `branding/logo-400.png` is now bundled at
  `/branding/agenticmail-logo.png` and used as the topbar brand,
  auth-card heading, and favicon.
- **Claude logo** — the official Claude starburst mark
  (extracted from the public Wikipedia SVG, `cls-2` orange path
  in `#d97757`) is now bundled at `/branding/claude-mark.svg`
  and used for the bridge agent's avatar.

The stylised SVG approximation from 0.8.24 is gone. Hosts that
care about brand fidelity get the real marks; the only thing the
UI does on top is overlay a small green verified-tick on the
bridge avatar.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.9 | 0.7.11 |
| `@agenticmail/mcp` | 0.7.7 | 0.7.8 |
| `@agenticmail/claudecode` | 0.1.13 | 0.1.14 |
| `@agenticmail/cli` | 0.8.24 | 0.8.25 |

Plugin manifest mirrored to 0.8.25. core / openclaw unchanged.

### Tests

108 claudecode tests pass (was 106, +2 net):

- `accepts an absolute-path mail-hook command (0.8.25+ shape)`
- `heals a 0.8.24-shaped install by upgrading the bare-name command to absolute path`

## [0.8.24] - 2026-05-13

### Web UI — Gmail-style redesign, modular JS, proper icon library

Two coordinated changes to `packages/api/public/`:

**1. Layout redesign.** The old three-pane shell (left agents
sidebar / middle inbox list / right message view) was the same
shape as 0.8.19's first cut. Replaced with the canonical Gmail
two-column layout:

- **Top bar** — hamburger, brand, full-width rounded search input
  with `from:` / `subject:` operators, refresh, account avatar.
- **Left sidebar** (256 px) — prominent pink Compose button,
  folder list (Inbox / Starred / Sent / Drafts / All Mail / Spam /
  Trash) with rounded-right active state and unread count badge.
- **Content pane** — single area that swaps between list view
  (Gmail-style 40 px rows: star, dot, from, subject + preview,
  date) and message view (subject, sender avatar, body, replies)
  driven by a hash router (`#/inbox`, `#/m/<uid>`).
- **Compose** — bottom-right popup modal instead of a centred
  overlay, matching Gmail.

**2. Proper icon library.** Every emoji in the UI has been
replaced with an inline 24×24 vector glyph. New module
`js/icons.js` exports an `icon(name, opts)` helper backed by
Material-Symbols-style paths; SVGs use `fill="currentColor"` so
a single palette token drives the colour for every glyph in
context. Hydration walks `[data-icon]` placeholders on load so
the HTML shell stays declarative.

Glyphs shipped: `menu`, `search`, `refresh`, `close`, `back`,
`caret`, `compose`, `send`, `reply`, `replyAll`, `mailUnread`,
`attachment`, `starOutline`, `starFilled`, `inbox`, `sent`,
`drafts`, `allMail`, `spam`, `trash`, `bow` (brand), `dot`,
`check`. The favicon is now a vector bow too — the previous
emoji `<text>` favicon didn't render consistently on Linux /
Windows / older browsers.

**Modular JS.** The previously-monolithic ~800-line inline
`<script>` is now 14 ES modules under `public/js/`:

| Module | Responsibility |
|---|---|
| `state.js` | Shared mutable state |
| `api.js` | Authed fetch wrapper |
| `utils.js` | `escapeHtml`, `stripHtml`, `toast` |
| `time.js` | `formatDate`, `formatDateFull` |
| `markdown.js` | XSS-safe markdown renderer |
| `search.js` | `from:` / `subject:` parser + highlighter |
| `avatar.js` | Host Claude-mark + colored sub-agent initials |
| `icons.js` | Inline SVG icon library |
| `sidebar.js` | Gmail folder list |
| `list-view.js` | Inbox row renderer |
| `message-view.js` | Single-message detail |
| `compose.js` | Bottom-right popup modal |
| `profile.js` | Top-right account switcher |
| `sse.js` | Real-time push + browser notifications |
| `app.js` | Entry, auth, hash router, keyboard shortcuts |

The shell `index.html` shrank from ~1300 lines to ~95.

CSS extracted into a dedicated `styles.css` (591 lines, Gmail
palette + dark-mode media query). The CLI's `copy-public` build
step already does `cp -R` so the new `js/` and `styles.css` ship
out of the box.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.8 | 0.7.9 |
| `@agenticmail/cli` | 0.8.23 | 0.8.24 |

Plugin manifest mirrored to 0.8.24. core / mcp / claudecode /
openclaw unchanged.

## [0.8.23] - 2026-05-14

### Fixed — `PreToolUse:<tool> hook error` on every Claude Code tool call

In 0.8.22 the mail hook was registered on both `UserPromptSubmit` AND
`PreToolUse`. The intent was right (autonomous Claude Code sessions
should also wake on agent replies) but the output schema was wrong:
`PreToolUse` expects `permissionDecision` / `permissionDecisionReason`,
not the `additionalContext` we emit. Claude Code accordingly logged
`PreToolUse:<tool> hook error` on every single tool call — noisy and
ugly, even though tools still ran.

Fix: only register on `UserPromptSubmit` (the one event whose schema
matches what we're doing). Anyone who installed 0.8.22 has a
`PreToolUse` rule sitting in their `~/.claude/settings.json` already;
the new `upsertMailHook` walks a removal-superset that includes
`PreToolUse` and cleans up that leftover automatically on the next
`agenticmail claudecode` run. No manual edit needed.

Autonomous-mode awareness (waking Claude on agent mail during long
runs with no user prompts) was the legitimate motivation for the
PreToolUse registration. That use case is real and worth solving,
but it needs a different mechanism than re-using the
UserPromptSubmit hook. Filed as a follow-up; not in this release.

### Tests

Two new tests cover the heal-on-upgrade path:

- `creates settings.json with the hook registered on UserPromptSubmit only`
- `heals a 0.8.22-style install by removing the leftover PreToolUse entry`
- `cleans up a legacy PreToolUse entry from a 0.8.22 install` (uninstall side)

Existing tests updated to reflect single-event registration. **106
claudecode tests pass** (was 104, +2 net after some restructuring).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.1.12 | 0.1.13 |
| `@agenticmail/cli` | 0.8.22 | 0.8.23 |

Plugin manifest mirrored to 0.8.23.

## [0.8.22] - 2026-05-13

### Added — `UserPromptSubmit` + `PreToolUse` mail hook (the real wake-up)

Claude Code is a synchronous REPL — there's no out-of-band channel
that lets AgenticMail push notifications to a running session. Until
this release, when a sub-agent replied to a thread (or asked the
host a mid-task question), the reply landed in the bridge inbox and
just sat there. The host (Claude in the terminal) only saw it when
the user said "any updates?" or Claude proactively polled.

**This release closes the gap with Claude Code hooks.** A new bin
`agenticmail-mail-hook` (ships with `@agenticmail/claudecode`) gets
registered on TWO Claude Code hook events when `agenticmail
claudecode` runs:

- **`UserPromptSubmit`** — fires on every user prompt. Catches the
  time-between-turns case where the user is interacting.
- **`PreToolUse`** — fires before every tool call. Catches the
  *autonomous* case where Claude Code is working for hours without
  any user typing (long agentic builds, remote-control via API,
  scheduled runs). Without this, autonomous sessions would never
  see sub-agent replies.

When the hook fires, it:

1. Reads `~/.agenticmail/config.json` for the master key + API URL.
   Bails silently if AgenticMail isn't set up.
2. Pulls the bridge agent's inbox over a 2-second-timeout HTTP call.
3. Filters to mail received since the last hook run (cursor-based
   dedup at `~/.agenticmail/claudecode-hook-cursor.json`).
4. If anything new, emits a terse `additionalContext` block that
   Claude Code prepends to the next prompt — one line per email,
   UID + from + subject + 120-char preview.

Claude sees the context, decides what to do (surface to the user,
read full body, reply on the thread), and acts. No user "check on
the team" needed.

**Rate-limited intelligently:**

- `UserPromptSubmit` always checks — the user is waiting.
- `PreToolUse` is throttled to one API check per 30 seconds. A burst
  of tool calls (Read → Grep → Read → Edit → Bash …) shares one
  check; we don't hammer the inbox endpoint.

**Bail-silent on failure:**

- AgenticMail not running, master key missing, network blip, parsing
  error — all silent `process.exit(0)`. The hook NEVER blocks a user
  prompt or tool call. Worst case, Claude proceeds without the mail
  context and sees it on the next successful check.

**Idempotent install:**

- `agenticmail claudecode` (and `agenticmail bootstrap`) wires the
  hook into `~/.claude/settings.json` automatically. Re-running is
  safe — same command, no change. The uninstaller removes only our
  rules; any other hooks the user installed under the same events
  are preserved.

The hook respects all the existing AgenticMail primitives — it just
makes Claude aware of mail without waiting for the user. From there,
the `wake` allowlist, thread-close markers, `check_activity`, and
everything else still apply.

### Tests

11 new tests in `claude-hooks-config.test.ts` covering:
- Creating settings.json from scratch with both events registered
- Idempotency (re-upsert is a no-op)
- Command-path updates
- Preserving user-owned hooks alongside ours
- Preserving unrelated settings keys
- Refusing to overwrite a corrupted settings.json
- Removing only our rules
- Marker-substring identification (full path OR bin name)

104 claudecode tests now pass (was 93).

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.1.11 | 0.1.12 |
| `@agenticmail/cli` | 0.8.21 | 0.8.22 |

Plugin manifest mirrored to 0.8.22.

## [0.8.21] - 2026-05-13

### Fixed — `agenticmail web` now actually works on global install

In 0.8.19 the web UI was packaged inside `@agenticmail/api/public/`,
but the CLI's tsup build inlines `@agenticmail/api` into the bundle
without copying the static asset. A global install of `@agenticmail/cli`
had `dist/cli.js` but no `dist/public/index.html`, so visiting
`http://127.0.0.1:3829/` returned 404.

Fix: added a `copy-public` build step that copies
`packages/api/public/` into `agenticmail/dist/public/` after tsup
runs. The static-dir resolution in `routes/mail.ts` walks both
the source and dist layouts, so dev and published installs both work.

### Added — auto-sign-in for `agenticmail web`

Running `agenticmail web` now opens the browser pre-authenticated.
The CLI reads the master key from `~/.agenticmail/config.json` and
passes it as `?key=…` on the URL; the web UI consumes it once,
saves to `localStorage`, and strips it from the address bar via
`history.replaceState` so it doesn't end up in browser history,
Referer headers, or screenshares. Safe because the URL is loopback-
only and the key belongs to the same user invoking the command.

Users who didn't set up via the CLI (or who land on the URL
directly) still see the manual paste flow.

### Added — Gmail-style profile switcher (top-right dropdown)

Dropped the left agents sidebar. The current agent now lives in a
profile button in the top-right with the Gmail-style account-switcher
behaviour:

- **Avatar** — colored initial circle for sub-agents, Claude's orange
  asterisk mark + verified-host badge for the bridge agent.
- **Role badges** — every agent in the dropdown is labelled `Host`
  or `Sub-agent` so the user knows which inbox is which.
- **Selected check** — pink checkmark next to the currently-active
  agent.
- **Per-agent unread badges** — `N new` pill next to any agent with
  unread mail that arrived since you last looked at their inbox.
- **Overall unread cue** — small red dot on the profile button when
  there's new mail in agents you haven't selected.

The bridge agent is auto-selected on first load because it's the
host's natural "main" inbox (every kickoff email gets CC'd to it).

### Added — real-time SSE notifications in the web UI

Three layers fire on every new-mail event:

1. **Inbox list updates in place** — if the new mail's agent is the
   one currently open, the inbox reloads and the top row flashes
   green briefly.
2. **Profile dropdown unread badges** — non-open agents get a `N new`
   pill, so the user sees other inboxes' activity at a glance.
3. **Browser notifications** — system notification with the subject
   as title and `agent — from sender` as body. Clicking the
   notification focuses the tab, switches to the right agent, and
   opens the message. Permission is asked once (2s after sign-in) and
   the answer is remembered.

When the user is already looking at the inbox that just received
mail, the in-app flash is enough; the OS notification suppresses.

### Added — Gmail-style search

The top-bar search now supports operators:

- `from:vesper` — only mail FROM vesper
- `subject:audit` — only mail with "audit" in the subject
- `audit from:vesper` — both must match
- `"build small game"` — exact phrase
- Anything outside an operator is free-text matched against subject + body + sender

Plus:

- **Clear button** (×) appears once you start typing; `Esc` also clears.
- **Match counter** in the right edge of the input (`5/42`) shows
  matches out of total inbox size.
- **Highlighted matches** — terms get a pink-soft `<mark>` background
  in the subject, from, and preview cells.
- **Debounced input** (80 ms) so typing fast doesn't re-render on every keystroke.
- **Keyboard shortcut** — press `/` anywhere to focus the search box (Gmail convention).

### Fixed — every reference to the deprecated unscoped `agenticmail` package

The unscoped `agenticmail@0.5.56` on npm depended on `better-sqlite3`,
which stopped building on Node 22+. Anyone who accidentally typed
`npm install -g agenticmail` (no scope) hit a confusing node-gyp
failure. Published `agenticmail@0.8.20` as a 1.6 KB zero-dependency
stub that just prints a redirect to `@agenticmail/cli`. All references
in the codebase to the unscoped name updated:

- `cmdUpdate` (cli.ts) and the shell `/update` command both query
  and install `@agenticmail/cli` now, with a fallback that detects
  a legacy unscoped install and upgrades correctly.
- README example code (`import { ... } from 'agenticmail'`) updated
  to `'@agenticmail/cli'` in both the main and CLI READMEs.
- `examples/send-email.ts` and `examples/check-inbox.ts` updated to
  use `@agenticmail/cli` and the current port `3829`.
- All other examples updated from the stale 3100 port to 3829.
- `scripts/test-facade.mjs` updated to import from the scoped name.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.7 | 0.7.8 |
| `@agenticmail/cli` | 0.8.19 | 0.8.21 |
| `agenticmail` (deprecated stub) | 0.5.56 | 0.8.20 |

Plugin manifest mirrored to 0.8.21. `core`, `mcp`, `claudecode`,
`openclaw` unchanged.

## [0.8.19] - 2026-05-13

### Added — lightweight Gmail-style web UI

A single-file HTML/CSS/JS application bundled in `@agenticmail/api`
that serves a Gmail/Outlook-style three-pane email client at the API
root. No framework, no build step — just a 35 KB `index.html` with
embedded styles and vanilla JS.

**Run it:**

```bash
agenticmail web
```

That checks the API is running, prints the URL, and opens your default
browser. You can also just visit `http://127.0.0.1:3829/` whenever the
API is up.

**Features:**

- **Three-pane layout** — agents sidebar / per-agent inbox / full
  message view. Familiar Gmail / Outlook mental model.
- **Master-key auth** — prompts on first load, stored in
  `localStorage`. Every API call carries the bearer; nothing leaves
  the local machine.
- **Per-agent identity** — each inbox is fetched with that agent's
  own API key (pulled once from `/accounts`) so the view is exactly
  what each agent would see.
- **Markdown rendering** — bold, italic, inline code, fenced code,
  headings, lists, task lists, tables, blockquotes, horizontal
  rules, links. Matches the terminal renderer's coverage.
- **Real-time updates via SSE** — subscribes to every agent's event
  stream; new mail bumps the unread badge and reloads the inbox in
  place. No polling.
- **Compose + reply** — full modal with From / To / Cc / Subject /
  Body. The `wake` allowlist is surfaced as a first-class field so
  users can scope dispatcher Claude turns to specific agents (or
  pass empty for "deliver silently").
- **Search across the open agent's inbox** — instant filter on
  subject / sender / preview.
- **Keyboard shortcuts** — `r` refresh, `c` compose.
- **Dark mode** — automatic via `prefers-color-scheme`.
- **Brand-consistent pink** — same `#ec4899` / xterm-205 hot pink
  the CLI and shell use.

**Architecture:**

- Lives at `packages/api/public/index.html`, served by `express.static`
  mounted at `/` before any auth middleware. The HTML loads without
  auth; the embedded JS then prompts the user for the master key and
  stores it locally. Every API call still flows through the same
  auth middleware as the rest of the server — the static surface
  adds no new auth bypass.
- `agenticmail web` command does a health check on the API, prints
  the URL, and uses the platform `open` / `xdg-open` / `start`
  command to launch the browser.
- Resolves the static dir from both dev (`packages/api/public/`) and
  published (`@agenticmail/api/public/`) layouts.

### Updated — READMEs and AGENTS.md

- Main `README.md` gains a "What's new in 0.8.18+" section that
  surfaces every recent feature (web UI, selective wake, thread-close
  markers, `check_activity`, markdown rendering, LLM-tolerant inputs,
  wake-budget circuit breaker, dedup guidance).
- `agenticmail web` row added to the Core Commands tables.
- `AGENTS.md` section 6 rewritten to point users at either the web
  UI or shell depending on preference. Decision table expanded.
- `AGENTS.md` coordination example now uses `wake: ["vesper"]` and
  `[FINAL]` to demonstrate the selective-wake pattern.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.6 | 0.7.7 |
| `@agenticmail/cli` | 0.8.18 | 0.8.19 |

Plugin manifest mirrored to 0.8.19. Other packages unchanged.

## [0.8.18] - 2026-05-13

### Fixed — wake-list audit: every send path now wired

After 0.8.17 introduced selective wake on `send_email`, an audit
surfaced four send paths that were either missing the `wake` parameter
entirely or silently dropping it. All four fixed in this release.

| Send path | Status before | Status after |
|---|---|---|
| `send_email` → `POST /mail/send` | wake ✓, header ✓, SSE ✓ | unchanged |
| `reply_email` → `POST /mail/send` | wake ✓, header ✓ (via send), SSE ✓ (via send) | unchanged |
| **`forward_email` → `POST /mail/send`** | wake ✗ | wake ✓ (now plumbed) |
| **`template_send` → `POST /templates/:id/send`** | wake ✗, no SSE push at all | wake ✓, SSE push added |
| **`manage_drafts(send)` → `POST /drafts/:id/send`** | wake ✗, no SSE push at all | wake ✓, SSE push added |
| **`POST /mail/pending/:id/approve`** (held-mail approval) | wake dropped on round-trip | wake persisted in `pending_outbound.mail_options.wakeList`, restored on approve, propagated to SSE |

### New helpers in `packages/api/src/routes/mail.ts`

Extracted shared primitives so every send path uses the same logic:

- `normalizeWakeList(value)` — accept string-or-array, lowercase,
  strip @localhost, drop empties. Returns `undefined` (= "wake all
  CC'd") or a normalised string[] (empty = "wake nobody").
- `wakeHeaders(list)` — produce the `{ 'X-AgenticMail-Wake': '...' }`
  outgoing header map.
- `pushLocalRecipientWakes` — re-export of the SSE notifier so the
  templates and drafts routes can use the same primitive as
  `/mail/send` instead of bypassing the dispatcher entirely.

### Templates & drafts SSE push

A pre-existing gap (not new in this release): the templates and
drafts routes sent mail via SMTP but never pushed SSE events to local
recipients. Local-to-local mail sent through those routes relied on
IMAP IDLE delivery before the InboxWatcher saw it — seconds, not
milliseconds. Both routes now push directly, matching the v0.8.x
zero-wait wake behaviour of `/mail/send`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api` | 0.7.5 | 0.7.6 |
| `@agenticmail/mcp` | 0.7.6 | 0.7.7 |
| `@agenticmail/cli` | 0.8.17 | 0.8.18 |

Plugin manifest mirrored to 0.8.18. `@agenticmail/core` and
`@agenticmail/claudecode` unchanged.

## [0.8.17] - 2026-05-13

### Added — selective wake (the single biggest token saver on large threads)

Feedback from a 5-agent stress test: every CC'd recipient was getting a
Claude turn on every reply, even when 4 of them would just decide "not
my turn" and stay silent. With 15 agents on a thread that's 15 turns per
round burned to make 1 actor contribute. User's question — "can the
sender tell the dispatcher whom to wake?" — has a clean answer.

Two new building blocks land in this release:

**1. `wake` parameter on `send_email` and `reply_email`**

```js
send_email({
  to: "vesper@localhost",
  cc: "orion@localhost, researcher@localhost, writer@localhost, reviewer@localhost",
  wake: ["vesper"],   // only Vesper gets a Claude turn
  subject: "Build a small terminal game",
  text: "Vesper, please design the spec. Reply-all when ready.",
})
```

- `wake: ["alice", "bob"]` → only those agents get a Claude turn
- `wake: []` → deliver silently, wake nobody (zero Claude burns)
- `wake` absent → preserves the v0.8.x "wake every CC'd agent" default

Mail is still delivered to every CC'd inbox regardless. Only the
"should the agent get a Claude turn from the dispatcher" decision is
gated. CC'd-but-not-listed agents see the email next time they check
their inbox or get explicitly named in a later wake list.

**2. Thread-close markers**

A wrap-up reply with `[FINAL]`, `[DONE]`, `[CLOSED]`, or `[WRAP]` in
the subject tells the dispatcher "this thread is done, no more wakes
on any reply to it". Closes the "no native done signal" gap the user
flagged. Case-insensitive, matched anywhere in the subject, so
`Re: [FINAL] Project complete` and `[final] Re: Project` both work.

### Architecture

The wake signal travels three hops:

1. **MCP `send_email` / `reply_email`** — new `wake` parameter
   (`string[]` or comma-separated string). Forwarded to the API.
2. **API `/mail/send`** — normalises into a lowercased bare-name list,
   sets `X-AgenticMail-Wake: alice, bob` as a real RFC 822 header on
   the outgoing SMTP envelope, AND surfaces the list as
   `wakeAllowlist: string[]` on the SSE event pushed to each local
   recipient (so the dispatcher doesn't need to fetch the email to
   read the header).
3. **Dispatcher** — `handleEvent` checks `wakeAllowlist` BEFORE the
   wake-budget circuit breaker. Excluded agents skip the worker spawn
   without consuming a wake-budget slot (otherwise selective waking
   on a noisy thread would prematurely trip the breaker for the agent
   that IS supposed to act).

### Dedup guidance for woken agents

The wake prompt now explicitly instructs woken agents to check their
own prior contributions to the thread before re-doing work. Re-deliveries
on subsequent wakes (the failure mode the user saw researcher and
planner hit) get pushed back to a stay-silent decision unless the
latest reply contains a NEW specific ask for the agent.

### Tests

7 new dispatcher tests covering the wake allowlist (absent → default,
present → match, exclude → skip, empty → silent, case-insensitive,
allowlist runs before budget, prompt mentions wake). 86 → 93
claudecode tests passing.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api`        | 0.7.4  | 0.7.5  |
| `@agenticmail/mcp`        | 0.7.5  | 0.7.6  |
| `@agenticmail/claudecode` | 0.1.10 | 0.1.11 |
| `@agenticmail/cli`        | 0.8.16 | 0.8.17 |

Plugin manifest mirrored to 0.8.17. `core` and `openclaw` unchanged.

## [0.8.16] - 2026-05-13

### Added — comprehensive markdown rendering in email bodies

The shell's `/read` view now turns the markdown agents write into
proper terminal styling. Two specific problems addressed:

1. **Multi-level quote chains rendered as literal `>>>>` on every line
   of a deep quoted block.** Replaced with a depth-colored vertical-
   bar stripe (`▎`) per level: cyan / magenta / yellow / dim.
2. **Bare markdown shapes (`**bold**`, `` `code` ``, etc.) showed up
   as literal asterisks and backticks in the body.** Now rendered
   with proper ANSI.

Coverage added (matches what agents actually write):

- Inline: `**bold**`, `__bold__`, `*italic*`, `_italic_`, `***both***`,
  `` `inline code` ``, `~~strike~~`, `==highlight==`, `[text](url)`,
  `<https://auto-link>`, `![alt](url)` → `[🖼 alt] (url)`, HTML
  entities (`&amp;` → `&`, `&lt;`, etc.)
- Block: `#` to `######` headings, `-`/`*`/`+` bullets, numbered
  lists, task lists `- [ ]` / `- [x]` with strikethrough on done,
  GFM tables (separator becomes a divider, data rows get cyan pipes
  with markdown rendered inside cells), `---` horizontal rules,
  ` ``` ` fenced code blocks (content NOT processed as markdown,
  rendered in cyan with a `▾ lang` header), indented code blocks
  (4-space indent).

Quote handling:

- Quote prefix on each line replaced with one `▎` stripe per depth.
  Cyan for depth 1, magenta for 2, yellow for 3, dim for 4+.
- Tolerates both `> >` (spaced) and `>>` (packed) styles.
- Markdown still renders inside quoted content.

Implementation:

- New module `agenticmail/src/ui/markdown.ts` (~290 lines) with a
  stateful `createMarkdownLineRenderer()` factory so fenced code
  blocks track across the line-by-line streaming render.
- Targeted ANSI resets (`\x1b[22m`, `\x1b[23m`, etc.) instead of the
  universal `\x1b[0m` so an outer wrapper (e.g. quote-stripe) doesn't
  get clobbered by inner markdown resets.
- 28 new tests in `markdown.test.ts` plus 2 new tests for the deep
  quote stripe in `email-card.test.ts`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.15 | 0.8.16 |

Plugin manifest mirrored to 0.8.16. Other packages unchanged.

## [0.8.15] - 2026-05-13

### Fixed — interactive shell crashed on startup with `c.pinkBg is not a function`

Regression introduced in 0.8.12 when the shell welcome banner was
upgraded to use the brand pink-background mark (`🎀 AgenticMail`) to
match the rest of the CLI surfaces. The `pinkBg` helper lives in
`cli.ts`'s color table; `shell.ts` has its own smaller `c` table and
was missing `pinkBg`, plus `blue` and `magenta` (which an SMS
direction-arrow path also uses). First invocation of `agenticmail
shell` (and a few code paths inside the REPL) tripped a `TypeError`.

Fix: backfill `pinkBg`, `blue`, and `magenta` into shell.ts's `c`
table using the same ANSI sequences cli.ts has.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.14 | 0.8.15 |

Plugin manifest mirrored to 0.8.15. Other packages unchanged.

## [0.8.14] - 2026-05-13

Three independent improvements bundled into one release because they
all landed during a single review session.

### Added — dispatcher activity visibility (`check_activity`)

The visibility gap the user reported: when Claude Code sends mail and
waits for an agent to wake, there is no signal between "mail sent" and
"reply received". If the wait is long, Claude cannot tell whether the
agent has started, is queued behind other workers, or is stuck.

Fix is a live registry of active and recently-finished workers, owned
by the API (the central state hub) and pushed to by the dispatcher
(the source of truth).

- **New file `packages/api/src/routes/dispatcher-activity.ts`** —
  in-memory `Map<workerId, WorkerInfo>` with TTLs (30 min active,
  2 min recent), HARD_CAP of 256 each, fan-out to `/system/events`
  on every transition. Endpoints:
    - `POST /dispatcher/worker-started` (master-auth)
    - `POST /dispatcher/worker-finished` (master-auth)
    - `GET /dispatcher/activity` (master-auth)
- **Dispatcher** now posts a `started` event on every `spawnWorker`
  entry and a `finished` event in the `finally` block, with the
  agent, kind (`new-mail` / `task`), trigger (mail UID + subject +
  from, or task id), and on finish the result `ok` flag + a 240-char
  preview of the worker's final assistant text. Fire-and-forget;
  observer failures never block worker spawn.
- **New MCP tool `check_activity`** (catalogued in `essential`). Calls
  `GET /dispatcher/activity` via master key. Returns active workers
  (currently running, with duration) plus recently-finished ones
  (last 2 min, with the result preview). Supports `agent` filter and
  `includeRecent` toggle. Now the host can answer "did Vesper
  actually start working?" in one MCP call instead of waiting for a
  reply that may never come.

### Added — email detail card with local-time dates (`/read` UI)

The interactive shell's email view was flat: a single horizontal rule,
labels at the same brightness as values, dates printed in raw locale
form (`5/13/2026, 4:22:46 PM`). User asked for proper sectioning and
human-friendly time formatting.

- **New file `agenticmail/src/ui/email-card.ts`** — renders an email
  as a multi-section card. Three pink rule lines wrap the subject,
  envelope (From/To/Cc/Bcc/Date/UID/InReplyTo), and body. Optional
  footer for attachments and security flags. Width-aware. ANSI
  pink-on-everything-else for brand consistency.
- **New file `agenticmail/src/ui/time-format.ts`** — calendar-aware
  relative formatter (`just now` / `5 minutes ago` / `yesterday` /
  `Tuesday` / `Mar 15` / `Mar 15, 2025`), absolute local-tz formatter
  (`Tue, May 13, 4:22 PM`), combined `formatEmailDate` (relative +
  absolute), and `formatDuration` for elapsed times. All inject `now`
  so tests are deterministic. All return `?` on unparseable input.
- **Shell integration**: `renderEmailMessage` delegates to the card
  module. Inbox list view uses `formatEmailDate` so timestamps are
  consistent across surfaces. SMS verification-code receipt also uses
  the formatter.
- **33 new tests** in `agenticmail/src/ui/__tests__/` covering every
  branch of the relative formatter (including clock-skew slop and
  invalid input) and the card's section structure / width / HTML
  fallback / attachments / security flags.

### Added — inbox refresh keybind (`r` / Ctrl+R / F5)

Asked for a way to refresh the inbox navigator without leaving and
re-entering. Single-letter keybind matches the existing navigator
convention (`v` toggles previews, `Enter` reads, `Esc` exits).
Ctrl+R and F5 also work for browser-muscle-memory users.

- **Cmd+R deliberately not used** — Mac terminals don't pass Cmd
  combos through to the app (Terminal.app and iTerm2 intercept them
  for tabs / window management). Same reason we don't bind Cmd+F.

Refresh preserves the current page, clamps selection if the page
shrank (e.g. messages were deleted while looking), and falls back to
the last existing page if the current page disappeared entirely.
Nav bar hint updated to show `[r] refresh`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api`        | 0.7.3  | 0.7.4  |
| `@agenticmail/mcp`        | 0.7.4  | 0.7.5  |
| `@agenticmail/claudecode` | 0.1.9  | 0.1.10 |
| `@agenticmail/cli`        | 0.8.13 | 0.8.14 |

Plugin manifest mirrored to 0.8.14. `core` and `openclaw` unchanged.

### Tests

Workspace total now 492 passing tests (was 459): 339 core + 80
claudecode + 33 mcp + 7 openclaw + 33 cli (new).

## [0.8.13] - 2026-05-13

### Added — LLM-tolerant input coercion in the MCP server

Host LLMs (Claude Code, ChatGPT, Cursor, Grok, Gemini…) routinely
serialise structured inputs as strings when calling tools. The most
common mistakes we see live:

```
batch_mark_read({ uids: "[1, 2, 3, 4]" })       // array as JSON string
batch_mark_read({ uids: "1, 2, 3, 4" })         // bare CSV
send_email({ attachments: '[{"x":1}]' })        // array of objects, JSON string
manage_drafts({ where: '{"id":"abc"}' })        // object as JSON string
wait_for_email({ timeout: "120" })              // number as string
manage_pending({ allowSensitive: "true" })      // boolean as string
```

Each one of these used to produce a confusing zod `expected X,
received Y` error that cost the LLM a retry turn for a mistake with
exactly one correct interpretation. Now they all just work.

New module `packages/mcp/src/coerce.ts` exports four pre-validation
coercers that run before zod sees the input:

- `coerceToArray(value, itemKind)` — JSON-string arrays, bare CSV
  (for primitive item types), and single-value-as-string. Refuses to
  CSV-split if the input starts with `[` and JSON.parse failed (the
  user clearly meant JSON; let zod produce a clean error).
- `coerceToObject(value)` — JSON-string objects. Arrays pass through
  unchanged so `coerceToArray` can handle them.
- `coerceToNumber(value)` — numeric strings to numbers, with safe
  pass-through for non-numeric or empty input.
- `coerceToBoolean(value)` — `"true"` / `"True"` / `"yes"` / `"1"` /
  `1` → `true`, plus the false equivalents. Anything ambiguous passes
  through so zod can produce "expected boolean".

All four are wired into `jsonSchemaToZod` via `z.preprocess`, so every
tool with an array, object, number, or boolean param across all 62
MCP tools becomes forgiving in one shot. Correct inputs are never
mutated — pass-through is guaranteed.

25 new tests in `packages/mcp/src/__tests__/coerce.test.ts` lock the
canonical Claude Code mistake (`batch_mark_read({ uids: "[1,2,3,4]"
})`) and every other shape against silent regression. Workspace
total is now 459 passing tests.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/mcp` | 0.7.3 | 0.7.4 |
| `@agenticmail/cli` | 0.8.12 | 0.8.13 |

Plugin manifest mirrored to 0.8.13. Other packages unchanged.

## [0.8.12] - 2026-05-13

### Added — official pink-bow logo across every surface

The project has an official logo now: a pink satin bow. It lands in
`docs/images/logo.png` (original ~1.3 MB), with downscaled
`logo-200.png` (51 KB, README headers) and `logo-400.png` (180 KB,
plugin marketplace icon slot) cut to size with `sips`.

Every README at the top of the tree gets the bow in a centered banner:

- `README.md` (repo root) — centered banner with logo + project name
- `agenticmail/README.md` (npm CLI README) — same, absolute GitHub URL for npm rendering
- `packages/claudecode/README.md`
- `packages/core/README.md`
- `packages/api/README.md`
- `packages/mcp/README.md`
- `packages/openclaw/README.md`
- `plugin/README.md`
- `AGENTS.md`

The interactive shell welcome banner now uses the pink-background bow
mark (`🎀 AgenticMail`) to match the rest of the CLI surfaces — the
terminal equivalent of the logo where rendering a PNG is not portable.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.11 | 0.8.12 |

Plugin manifest mirrored to 0.8.12 for parity. Other packages unchanged
(the logo lands on their npm pages on the next functional release).

## [0.8.11] - 2026-05-13

### Changed — documentation surfaces now route human oversight to `agenticmail shell`

A small but high-leverage docs update. Three surfaces (`README.md`,
`agenticmail/README.md`, `AGENTS.md`, plus the `@agenticmail/claudecode`
package README from the previous commit) now route the user to the
interactive shell when the question is "what have my agents been
doing?".

The decision rule baked into AGENTS.md:

> **shell for visual monitoring by a human, MCP for programmatic work
> driven by you**

| User said… | Right answer |
|---|---|
| "show me what my agents have been doing" | `agenticmail shell` |
| "let me see Fola's inbox" | `agenticmail shell` |
| "check on the team" | `agenticmail shell` |
| "have Fola reply to my last email from accounting" | MCP |
| "coordinate Vesper and Orion on this build" | MCP |

This is purely a docs change. No code, no behaviour, no API surface
moved. The shell command itself has worked since the very first
release. This release just makes sure every AI assistant reading
these docs lands the user in the right place.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.10 | 0.8.11 |

(All other packages unchanged.)

## [0.8.10] - 2026-05-13

### Added — reliability circuit breakers

Feedback from a real multi-agent coordination session flagged three
unresolved failure modes for the thread-as-workspace pattern:

  1. **Reply loops** — agent A replies-all → B/C/D wake → one of them
     replies → A wakes on the chain → ad infinitum, burning tokens.
  2. **Simultaneous turn-taking** — two agents both wake on the same
     message and both decide "it's my turn", producing duplicate /
     conflicting replies that confuse the thread.
  3. **10+ agent storms** — every reply wakes 9 workers; even when most
     stay silent, each wake costs one Claude turn.

This release lands the safety rails to make those failures cost-
bounded and recoverable.

- **Per-(agent, thread) wake-budget circuit breaker** in the dispatcher.
  Caps how many times a single agent can be woken on the same thread
  inside a window (default: 10 wakes per 24h, configurable via
  `maxWakesPerThread` / `wakeWindowMs`). When the cap is hit, further
  wakes for that pair are dropped with a `warn`-level log line until
  the window expires. Per-agent, per-thread — so a noisy thread can't
  poison unrelated work for the same agent, and a runaway agent can't
  poison unrelated threads. Subject-based threading: `Build a game`,
  `Re: Build a game`, and `Re[3]: Build a game` all share one budget.

- **Persona-level "recent reply" check.** When deciding whether it's
  their turn, agents are now explicitly told: *"If a teammate replied
  within the last 60 seconds, assume they are handling this turn and
  stay silent — simultaneous replies are noise."* This shifts most
  cases of (2) and (3) into a deliberate stay-silent path *before*
  a Claude turn even runs. Updated in both the dispatcher wake prompt
  and the resident subagent persona body.

These two together cover the failure modes without breaking the natural
"send one email, watch them work" UX. Reasonable defaults; both knobs
overridable via `DispatcherOptions`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.1.8 | 0.1.9 |
| `@agenticmail/cli`        | 0.8.9 | 0.8.10 |

(`core`, `api`, `mcp` unchanged.)

## [0.8.9] - 2026-05-13

### Changed — agents can now do real work, not just paste source code into emails

Before: AgenticMail agents were locked to MCP-only tools. Both the
dispatcher's `allowedTools` and the subagent `.md`'s `tools:` frontmatter
explicitly denied them Read / Write / Edit / Bash / Glob / Grep /
WebFetch / WebSearch / NotebookEdit. The persona body told them
"You are operating an email account, not a developer environment."

That was the wrong design. AgenticMail agents run as Claude Code
subagents under the host's OAuth — there is no security reason to
keep them away from the filesystem and shell, and the work humans
delegate to them ("implement this", "run these tests", "fetch this
URL", "refactor this file") demands those tools. The restriction
turned every "Zephyr, implement the game" into "Zephyr pastes 41
lines of Python into an email body and the human copy-pastes it
back out". Defeats the point of having agents.

Now:

- **Dispatcher workers spawn with no `allowedTools` restriction.**
  The Claude Agent SDK falls through to its defaults — every built-in
  tool plus every MCP tool the dispatcher passes via `mcpServers`.
- **Subagent `.md` frontmatter no longer pins a `tools:` whitelist.**
  Claude Code grants direct `Agent { subagent_type: ... }` invocations
  the full host toolset.
- **Personas tell agents to USE native tools for actual deliverables.**
  Write the file, run the test, fetch the URL. The mail thread is for
  coordination ("shipped at `./void_fall.py`, runs with `python3
  void_fall.py`"); the filesystem is for deliverables.
- **Wake prompt updated** with the same instruction so dispatcher-
  spawned workers get it on every wake.

Outbound mail safety is unchanged — AgenticMail's outbound guard still
holds HIGH-severity sends for owner approval regardless of how rich the
surrounding toolset is.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/claudecode` | 0.1.7 | 0.1.8 |
| `@agenticmail/cli`        | 0.8.8 | 0.8.9 |

(`@agenticmail/core`, `@agenticmail/api`, `@agenticmail/mcp` unchanged.)

## [0.8.8] - 2026-05-13

### Fixed — zero-wait wake for newly created agents

Before: when the host (Claude Code, ChatGPT, etc.) called
`create_account` mid-session, the new agent had no dispatcher channel
until the next poll tick. Even with the polling interval at 5s, mail
sent to the new agent in those first seconds landed in an inert
inbox — nobody was listening to wake them. The user-visible symptom
was "I created Lyra and Zephyr, sent the kickoff email, and nobody
ever replied".

Fix: **push-based account lifecycle events**.

- **`@agenticmail/api`** gains a new master-auth SSE endpoint
  `GET /api/agenticmail/system/events` that streams account-lifecycle
  events. `POST /accounts` and `DELETE /accounts/:id` now publish
  `account_created` and `account_deleted` events the moment they
  succeed. The full account record (incl. apiKey) is carried in the
  `account_created` payload so listeners can act without an extra
  round trip; the endpoint is master-auth so the apiKey leak is moot.

- **`@agenticmail/claudecode` dispatcher** now subscribes to
  `/system/events` on start. On `account_created`, the dispatcher
  opens a per-account SSE channel for the new agent within
  milliseconds — no polling delay. On `account_deleted`, it tears
  the channel down immediately. The 30s polling sync stays as a
  safety net for events lost across reconnects (was 5s, since the
  push channel makes aggressive polling unnecessary).

Net effect: `create_account → send_email → wake → reply` is now
end-to-end real-time. The kickoff thread pattern from 0.8.7 actually
works on agents created in the same session.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/api`        | 0.7.2 | 0.7.3 |
| `@agenticmail/claudecode` | 0.1.6 | 0.1.7 |
| `@agenticmail/cli`        | 0.8.7 | 0.8.8 |

(`@agenticmail/core` and `@agenticmail/mcp` unchanged — fix is purely
in the API push channel + dispatcher subscriber.)

## [0.8.7] - 2026-05-13

The thread-as-workspace release. Multi-agent coordination now mirrors
how humans actually work: one shared email thread, every participant
CC'd, agents take turns implicitly from context, the host watches.
No RPC ceremony, no out-of-band protocol — just mail.

### Added

- **`wait_for_email` now supports filtering.** New optional params:
  - `from` — case-insensitive substring match on sender address
  - `subject` — substring match (the thread's core subject works,
    matches both the kickoff and every "Re:" reply)
  - `inReplyTo` — exact Message-ID match (most precise thread filter)
  - `participants` — array of senders; resume on a reply from any
  - `includeTasks` — opt out of task-event matches if you only want mail

  Non-matching events that arrive during the wait are now IGNORED
  (previously the call returned on the first event). The response
  carries `skippedEvents` so callers can distinguish "nothing happened"
  from "things happened but none matched".

  Both the `@agenticmail/mcp` tool and the `@agenticmail/openclaw`
  mirror got the same upgrade. Both fall back to a filtered single
  poll when SSE is unavailable.

- **`wait_for_email` promoted to the `essential` tool set** — every
  Claude Code subagent now ships with it pre-loaded. Was previously
  under `agent_coord` and required `request_tools` discovery; for the
  delegate-then-wait pattern that's friction that doesn't pay off.

- **MCP server `instructions` field now leads with the thread pattern**
  — one kickoff email, everyone on CC, agents take turns. `call_agent`
  demoted to a one-shot-RPC special-case (use it for a single
  structured answer from a single agent).

- **AGENTS.md section 2 rewritten** around the thread pattern with a
  worked example: boss creates Vesper + Orion, sends one kickoff with
  both on CC + bridge on CC, watches the thread.

- **Dispatcher wake prompt teaches thread-aware turn-taking.** When an
  agent wakes on new mail, the prompt now walks them through:
  load the full thread → identify CC participants → decide if it's MY
  turn → reply-all (or stay silent). Reply-all is preferred over
  side-channel `call_agent` for ongoing thread work.

### Changed

- **Dispatcher no longer spawns workers for the bridge agent.** The
  `claudecode` bridge inbox is the HOST session's to monitor — it's
  consumed via MCP `list_inbox` / `wait_for_email`, not by an
  autonomous worker. Spawning a worker for the bridge was wasteful
  AND risked autonomous-loop behaviour (bridge replies-all → bridge
  wakes on its own reply → ad infinitum). Bridge identification is by
  `bridgeAgentName` (default `"claudecode"`) or `role === "bridge"`.

- **Dispatcher account-sync interval dropped from 60s to 5s.** An
  AgenticMail agent created mid-session via `create_account` now gets
  an SSE channel within ~5 seconds, not a minute. The /accounts call
  is cheap (one HTTP GET, small JSON) — the latency saving is
  obvious the first time you do `create_account → call_agent`.

- **MCP tool descriptions updated** for `send_email` (now leads with
  "primary primitive for multi-agent coordination — put one actor on
  To, the team on CC, every local recipient is auto-woken") and
  `reply_email` (now leads with "pass replyAll: true for thread
  coordination so every CC'd participant stays in context").

- **Subagent persona template teaches the same protocol** so it lands
  at spawn time regardless of how the agent was woken.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/mcp`        | 0.7.2  | 0.7.3  |
| `@agenticmail/claudecode` | 0.1.5  | 0.1.6  |
| `@agenticmail/openclaw`   | 0.5.59 | 0.5.60 |
| `@agenticmail/cli`        | 0.8.6  | 0.8.7  |

(`@agenticmail/core` and `@agenticmail/api` unchanged — fix is in MCP
+ dispatcher + persona, all of which run on top of the unchanged API.)

## [0.8.6] - 2026-05-13

### Added — provider-agnostic "how to coordinate" guidance

The most common failure mode we've observed in the wild: a host LLM
(Claude Code, ChatGPT, Cursor, Grok, …) creates AgenticMail agents
correctly, then immediately spawns its OWN native sub-agent tool with
a "you are <agent-name>" prompt to roleplay them — and finally
`send_email`s the manually-composed reply on the agent's behalf. The
named AgenticMail agent never actually thinks anything; their inbox,
persona, signatures, and outbound guard are all bypassed.

To teach every connecting host this in one shot:

- **`@agenticmail/mcp@0.7.2`** now sends a comprehensive
  `instructions` field on `initialize`. MCP clients surface this to
  the LLM as part of the server's introduction, so the rule
  ("address other agents via `call_agent` / `send_email` /
  `message_agent` — never roleplay them in your host") lands in
  context before the LLM picks up any tool.
- **Tool descriptions** for `list_agents`, `create_account`,
  `call_agent`, and `message_agent` now explicitly call out the
  anti-pattern and the correct alternative. Provider-agnostic
  wording — no hard-coded references to "Claude Code subagents",
  since the same MCP server is used by every host.
- **`AGENTS.md`** gains a new top-level section "If the user asks
  you to use AgenticMail for multi-agent coordination" with right
  way / wrong way examples. Existing sections renumbered.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/mcp` | 0.7.1 | 0.7.2 |
| `@agenticmail/cli` | 0.8.5 | 0.8.6 |

## [0.8.5] - 2026-05-13

### Fixed

- **`list_inbox` could return "Inbox is empty" while `inbox_digest`
  saw the message** — same agent, same INBOX, called seconds apart.

  Root cause: pooled IMAP receivers in `packages/api/src/routes/mail.ts`
  don't run IDLE (that's the separate `InboxWatcher`'s job). So
  `client.mailbox.exists` was the cached count from the last SELECT
  and lagged behind reality whenever a new internal message landed
  between two `getReceiver()` calls. `listEnvelopes()` then
  early-returned `[]` on the stale `total === 0`, even though the
  next-line SEARCH would have surfaced the message just fine.

  Fix (`packages/core/src/mail/receiver.ts`):
  - `getMailboxInfo`: issue an IMAP `NOOP` after `getMailboxLock` so
    the server flushes any pending untagged `EXISTS` / `RECENT` /
    `EXPUNGE` responses before we read `client.mailbox`.
  - `listEnvelopes`: drop the stale-state early returns
    (`if (total === 0)` and `if (offset >= total)`) and let the
    authoritative `SEARCH` decide. SEARCH walks the mailbox at command
    time, so it sees newly-delivered messages without any IDLE/NOOP
    dance.

  Net effect: `list_inbox` is now consistent with `inbox_digest` and
  with the actual mailbox state immediately after `send_email`.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.7.1 | 0.7.2 |
| `@agenticmail/api`  | 0.7.1 | 0.7.2 |
| `@agenticmail/cli`  | 0.8.4 | 0.8.5 |

(`@agenticmail/mcp` and `@agenticmail/claudecode` only call the HTTP
API, so they don't need a rebuild — the fix reaches them through the
API process they talk to.)

## [0.8.4] - 2026-05-12

### Added

- **`install.sh` — one-line curl-bash installer** at the repo root.
  Hosted at `https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh`,
  so any user (or AI agent) can install AgenticMail with a single line:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/agenticmail/agenticmail/main/install.sh | bash
  ```

  The script:
  - Detects OS (macOS / Linux) and package manager (brew / apt / dnf / yum / pacman)
  - Preflights Node.js 22+ and prints platform-specific upgrade instructions
    (`brew install node@22`, `nvm install 22`, NodeSource curl-pipe, etc.) if missing
  - Runs `npm install -g @agenticmail/cli@latest` then `agenticmail bootstrap`
  - Supports `--dry-run` (print commands without executing) and
    `--no-bootstrap` (install the CLI only)
  - `set -euo pipefail`, no destructive ops, prints every command before running it

  Manual two-command install (`npm install -g @agenticmail/cli@latest && agenticmail bootstrap`)
  is still the documented fallback and does the exact same thing under the hood.

### Changed

- **README, `agenticmail/README.md`, and `AGENTS.md`** all now lead with
  *both* install paths (curl-bash + manual) side-by-side. AI agents reading
  `AGENTS.md` are instructed to default to the curl path unless it's blocked.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.3 | 0.8.4 |

(Other packages unchanged.)

## [0.8.3] - 2026-05-13

### Added

- **`AGENTS.md`** at the repo root — first-read instructions for AI coding
  assistants (Claude Code, ChatGPT, Cursor, Aider, Codex, …) following
  the cross-vendor [agents.md](https://agents.md) convention. Covers the
  10 most common asks: "install AgenticMail", "set up Claude Code
  integration", "what is this", "verify it's working", common failures,
  repo layout, build/test/lint commands, conventions, anti-patterns.
- **`CLAUDE.md`** at the repo root — Claude-Code-specific stub that
  points at `AGENTS.md`. Means any Claude Code session opened in this
  repo gets the install runbook in its context window automatically.
- **"AI agent install runbook"** callout block at the top of the
  main README and the `@agenticmail/cli` npm README so the install
  instructions are the first thing an AI agent sees when their user
  says "install AgenticMail" — either from the repo or the npm page.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/cli` | 0.8.2 | 0.8.3 |

(Other packages unchanged.)

## [0.8.2] - 2026-05-12

The biggest single release in AgenticMail's history. Five themes shipping
together because they all unlock the same user experience: *"User to Claude
Code: install AgenticMail. Claude Code does it."*

```bash
npm install -g @agenticmail/cli@latest
agenticmail bootstrap
```

Two commands. Zero prompts. Two minutes. Done.

### Added

- **New package `@agenticmail/claudecode@0.1.5`** — end-to-end Claude Code
  integration. Every AgenticMail agent becomes a callable Claude Code
  subagent (`Agent { subagent_type: "agenticmail-fola" }`), all 62
  `mcp__agenticmail__*` tools land in every Claude Code session, and agents
  auto-wake on inbound mail or `/tasks/rpc` via a PM2-managed dispatcher
  daemon. Workers run inside the user's existing Claude Code OAuth — no
  separate Anthropic key, no AgenticMail-side LLM credentials. The slogan:
  *one Anthropic connection, many AgenticMail identities*.
  - `src/dispatcher.ts` — SSE watcher + Claude Agent SDK worker spawner.
    Concurrency-capped, reconnect/backoff, dedup on both `uid` and `taskId`,
    plus cross-type dedup that suppresses the matching `[RPC]`/`[Task]`
    notification mail when a task event has already fired for the same
    account (otherwise every `call_agent` ran the recipient through Claude
    twice).
  - `src/persona-loader.ts` — reads `~/.claude/agents/<name>.md` from disk
    or auto-generates the persona body from live AgenticMail account
    metadata. Freshly `create_account`-ed agents become wake-able with
    zero further setup.
  - `src/http-routes.ts` — `POST /api/agenticmail/integrations/claudecode/
    {install,uninstall,status}`. Mounted **before** the master-key auth
    middleware so a fresh AI agent can self-install without knowing the
    master key. Loopback-only bind is the security boundary; anything
    that can reach the endpoint can already read
    `~/.agenticmail/config.json`.
  - 75 vitest specs covering `~/.claude.json` patching (idempotent + only
    touches our `mcpServers.agenticmail` key), install/uninstall round-trip,
    dispatcher routing/dedup/concurrency/cross-type-dedup, persona loader,
    http routes, config resolution, subagent template.

- **`agenticmail bootstrap`** — one-shot zero-question installer for
  `@agenticmail/cli`. Designed to be runnable by an AI agent (Claude Code
  itself, a CI job, a shell script) on a user's behalf with no prompts.
  Pipeline: `setup --yes` → `service install` → wait for API `/health` (port
  read from the freshly-written config) → `claudecode` wiring. Skips
  external Gmail relay and SMS setup; those need user-owned credentials
  and can be added later with `agenticmail setup`. Uses Colima on macOS
  (no Docker Desktop GUI gates).

- **`agenticmail setup --yes` / `--non-interactive` / `-y`** — suppresses
  every prompt and uses safe defaults (skip email, skip SMS, default agent
  name, skip the trailing interactive shell when running inside a pipeline).

- **`mcp__agenticmail__request_tools` + `mcp__agenticmail__invoke`** —
  meta-tools that cut a typical Claude Code subagent's spawn-time context
  from ~15K tokens (62 tool schemas pre-declared) to ~3K (10 essential
  tools + the two meta-tools). Uncommon ops reach the rest of the
  catalogue via discover-then-invoke.

- **`_account` parameter on every MCP tool** — per-call identity switching.
  `AGENTICMAIL_ACCOUNT_KEYS_JSON` env var carries a `{name: apiKey}` map;
  if a tool call references a name that isn't in the cache AND a master
  key is configured, the server lazily fetches that account's apiKey
  via `GET /accounts` and caches it. Means `create_account`-ed agents
  become addressable from the MCP server with zero restart.

- **MCP tool catalogue** — `packages/mcp/src/tool-catalog.ts` groups the
  62 real tools into 12 sets (`essential`, `mail_extras`, `mail_bulk`,
  `mail_compose`, `mail_safety`, `agent_coord`, `contacts`, `sms`,
  `account_admin`, `storage`, `setup`, `system`). 8 audit tests lock in
  *every-real-tool-is-categorised* as a CI invariant — a new tool that
  doesn't land in a set fails the build.

### Changed

- **`@agenticmail/core` DB engine: `better-sqlite3` → `node:sqlite`.**
  The native module shipped pre-built binaries per `NODE_MODULE_VERSION`
  and intermittently lagged new Node releases (Node 25.5.0 was a real
  case: prebuilds missing, `node-gyp` failed on the compile-from-source
  fallback, fresh `npm install -g @agenticmail/cli` failed for users on
  bleeding-edge Node). `node:sqlite` is part of Node itself, so by
  definition it always matches the runtime. **No prebuilds, no
  `node-gyp`, no Python prereq, no compatibility lag.** On-disk SQLite 3
  format is unchanged; existing `~/.agenticmail/agenticmail.db` files
  migrate transparently.

  Migration notes:
  - `DatabaseSync` loaded via `createRequire(import.meta.url)('node:sqlite')`
    instead of a static `import` — esbuild was normalising
    `from 'node:sqlite'` to `from 'sqlite'` in the bundled output, which
    failed at runtime because no userland `sqlite` package exists.
    `createRequire` is opaque to esbuild's static analysis, so the literal
    string survives.
  - `db.pragma(x)` → `db.exec('PRAGMA ' + x)` (node:sqlite has no
    `.pragma()` helper).
  - `db.transaction(fn)` → custom `runTransactionally(db, fn)` helper
    using manual `BEGIN`/`COMMIT`/`ROLLBACK` (node:sqlite has no
    `.transaction()` helper).
  - `Database` type re-exported from `@agenticmail/core/index.ts` as
    `type Database = DatabaseSync`. 13 consumer files across
    `@agenticmail/core` and `@agenticmail/api` now
    `import { type Database } from '@agenticmail/core'` instead of
    `'better-sqlite3'`.

- **Default API port: `3100` → `3829`.** The old default clashed with
  Grafana Loki and several Express-scaffold tutorials on developer
  machines. `3829` is unassigned by IANA and sits in a quiet stretch
  (avoids `3000` / `3100` / `3200` / `3300` / `4000` / `5000` / `8000` /
  `8080` — all common dev-tool defaults). Existing installs that already
  have `api.port` set in `~/.agenticmail/config.json` are unaffected;
  only **new** installs pick up the new default. `agenticmail bootstrap`
  reads the actual port from config when waiting on `/health` — no
  hardcoded port assumptions remain anywhere.

- **`engines.node` bumped to `>=22`** across `@agenticmail/core`,
  `@agenticmail/api`, `@agenticmail/mcp`, `@agenticmail/claudecode`, and
  `@agenticmail/cli`. `@agenticmail/openclaw` is unchanged at `>=20`
  because it still depends on `@agenticmail/core@^0.5`.

- **CI `setup-node` bumped `20` → `22`** to match.

### Published

| Package | Old | New |
|---|---|---|
| `@agenticmail/core` | 0.5.61 | 0.7.1 |
| `@agenticmail/api` | 0.5.62 | 0.7.1 |
| `@agenticmail/mcp` | 0.5.59 | 0.7.1 |
| `@agenticmail/claudecode` | — | 0.1.5 (new) |
| `@agenticmail/cli` | 0.5.62 | 0.8.2 |

### Tests

- 339 passing in `@agenticmail/core` (the suite that locked in the
  `node:sqlite` migration without behaviour regression)
- 75 passing in `@agenticmail/claudecode` (new)
- 8 passing in `@agenticmail/mcp` (catalogue audit — new)

**422 total, all green on both Node 22 and Node 25.**

## [0.5.62] - 2026-05-10

### Fixed

- **SSE `uid: 0` persists for internal `@localhost` delivery in
  0.5.61** (#32, thanks @kn8-codes). The 0.5.61 lookup ran with a
  ~2 s budget and used IMAP header-search exclusively. In practice
  Stalwart 0.15.5 doesn't make a freshly delivered internal message
  visible to header-search until several seconds after delivery, so
  the lookup almost always returned 0 with `uidLookup: 'failed'` —
  even though `GET /mail/inbox` showed the message immediately.
  `findUidByMessageId` now does a two-prong lookup with a bigger
  retry budget (8 attempts; cumulative cap ~7 s):
  1. **Header-search first** (fast when Stalwart's index has caught
     up; relay-delivered mail almost always hits here on the first
     try).
  2. **Envelope scan fallback** — pull the last 10 UIDs in INBOX
     and match their `messageId` envelope field. Doesn't depend on
     the search index, just walks recent mail.

  Both prongs run on every attempt. Message-IDs are normalized
  (angle brackets stripped, lowercased) on both sides so a
  bracket / case mismatch can't cause a false negative. Verified
  with eight focused test cases: immediate header hit, header lag
  with envelope rescue (kn8's case), bracket-stripped storage,
  uppercase storage, never-found, multi-match (highest UID wins),
  empty mailbox, mid-retry header recovery.

## [0.5.61] - 2026-05-09

### Fixed

- **SSE `new` event emits `uid: 0` for internal mail** (#29, thanks
  @kn8-codes). The #24 fix pushed a doorbell-style event the moment
  `POST /mail/send` returned 200, but at that instant the recipient's
  IMAP store hasn't finished indexing the message — the UID was
  unknown and we used 0 as a sentinel. Consumers that tried to
  `FETCH` by that UID either failed or hit the wrong message.
  `notifyLocalRecipientsOfNewMail` now opens (or reuses) the
  recipient's `MailReceiver` and searches `INBOX` by Message-ID with
  a small retry budget (200 ms, 400, 600, 800 — capped at ~2 s)
  before emitting. Real UID is included on the SSE event; falls back
  to 0 only on actual lookup failure, accompanied by a new
  `uidLookup: 'resolved' | 'failed' | 'no-message-id'` field so
  consumers can distinguish "real UID 0" from "lookup didn't
  finish". Verified with five focused test cases against a stubbed
  ImapFlow (immediate hit, delayed indexing, never-found, transient
  error recovery, multiple-match preference).
- **`RelayGateway` poll failures swallow the real error** (#30,
  thanks @kn8-codes). Logs printed only `err.message` which on
  IMAP/TLS/subprocess failures collapses to the bare string
  `"Command failed"`, leaving operators unable to tell whether
  they're looking at bad credentials, a TLS handshake failure, a
  DNS miss, a connection reset, a timeout, or a subprocess crash.
  Added `formatPollError` that renders the structured fields most
  error sources actually carry — `code`, `errno`, `syscall`,
  `hostname`, `port`, IMAP `responseText`, SMTP `command`,
  subprocess `exitCode` / `signal` / `stderr` / `stdout`. When the
  underlying error genuinely carries no detail, the formatter says
  so explicitly instead of repeating the opaque headline. Verified
  with seven test cases (IMAP auth, TLS reset, DNS, subprocess
  with stderr, no-detail, raw string throw, null).
- **`RelayGateway` polling stays dead after Docker container
  restart** (#31, thanks @kn8-codes). The API container can come
  up before Stalwart / Gmail IMAP / DNS is reachable, so the very
  first `relay.setup()` after restart can throw a transient
  network error. Previously that single failure was logged and
  never retried, leaving polling permanently dead until manual
  intervention. `GatewayManager.resume` now schedules background
  retries with exponential backoff (5 s, 10 s, 20 s, 40 s, 60 s
  cap, indefinite, ±20 % jitter) so the relay self-recovers as
  soon as the dependency is reachable. Counters reset on success
  and a one-line success log makes the recovery visible. Verified
  by stubbing `relay.setup()` to fail twice then succeed and
  confirming `pollStarted` + retry-state cleanup.

### Process note

All three fixes were exercised against running source via `tsx`
(not just "build clean") before publish, per the standing
fix-verification rule. Test scripts (`verify-relay-fixes.mjs`,
`verify-uid-fix.mjs`) were ad-hoc smoke checks and removed before
commit; the ImapFlow stub pattern they use is the template for
future regression cases.

## [0.5.60] - 2026-05-08

### Fixed

- **Duplicate `POST /accounts` regression in 0.5.59** (#23 follow-up,
  thanks @kn8-codes for the eval re-run). 0.5.59's catch handler
  referenced a bare `name` identifier when building the 409
  conflict body, but `name` was destructured *inside* the try
  block so it was out of scope by the time the catch ran. esbuild
  papered over this in source-level type-checking by silently
  resolving the identifier to a global, then renamed the
  in-scope binding to `name2` to avoid the collision — leaving
  the catch's bare `name` resolving to nothing at runtime and
  emitting `ReferenceError: name is not defined`. Hoisted the
  destructuring above the try block and renamed the binding to
  `accountName` so the identifier can no longer be confused with
  a global. Verified end-to-end against a running Express server:
  duplicate now returns `HTTP 409 {"error":"Account already
  exists","name":"<name>"}` in ~2 ms.
- **Storage table create regression in 0.5.59** (#27 follow-up,
  thanks @kn8-codes). 0.5.59 unquoted SQL function defaults but
  emitted them bare: `DEFAULT datetime('now')`. SQLite rejects
  that with `near "(": syntax error` — per the SQLite docs,
  *"If the DEFAULT value of a column is a non-constant
  expression, the expression must be enclosed in parentheses"*.
  `buildColumnDDL` now wraps SQL function calls and `CURRENT_*`
  keywords in parens (`DEFAULT (datetime('now'))`), matching
  what `agenticmail_storage_meta` already uses for its own
  `created_at` / `updated_at` columns. Postgres also accepts the
  parens form. Verified e2e: `POST /storage/tables` now returns
  `HTTP 200 {"ok": true, "table": "..."}` for the issue's exact
  body.

### Process note

Both regressions were original-fix attempts in 0.5.59 that
compiled cleanly but were never run against a live HTTP server.
0.5.60 includes a minimal e2e harness (in-memory SQLite +
stubbed AccountManager + real Express) that exercises the exact
issue repros against the live source — this lands as part of
the standing fix-verification routine, not just for this
release.

## [0.5.59] - 2026-05-08

### Fixed

- **`agenticmail --version` launches the server instead of
  printing the version** (#25, thanks @kn8-codes). The top-level
  `process.argv[2]` switch in the CLI dispatcher had no case for
  `--version` / `-v` / `version`, so the request fell through to
  `default` (which is "no command = start the server"). Added
  explicit cases that read the version straight out of
  `package.json` (same source `cmdUpdate` uses for the
  "current version" line) and exit cleanly, matching the
  standard POSIX / npm convention.
- **`POST /storage/tables` returns 500 with `near "now": syntax
  error`** (#27, thanks @kn8-codes). When `timestamps` was not
  explicitly `false`, the auto-added `created_at` / `updated_at`
  columns passed a SQL function call (`datetime('now')` on
  SQLite, `NOW()` on Postgres) through `col.default` as a
  string. `buildColumnDDL` then dutifully wrapped that string
  in single quotes, producing `DEFAULT 'datetime('now')'` — the
  embedded apostrophe closed the literal early and the SQL
  parser exploded. The renderer now detects SQL function
  expressions (anything containing parentheses) and the
  `CURRENT_TIMESTAMP` / `CURRENT_DATE` / `CURRENT_TIME` keywords
  and emits them unquoted; literal string defaults still get
  their apostrophes properly escaped (`replace(/'/g, "''")`) so
  user-supplied defaults can't break out of the literal.
- **`POST /accounts` hangs ~8s on an immediate duplicate create**
  (#23, thanks @kn8-codes). Distinct from the orphan-recovery
  case fixed in #17 — when both the Stalwart principal *and*
  the SQLite agent row already exist (a true duplicate),
  `AccountManager.create` was still calling `ensureDomain` and
  `createPrincipal` over HTTP. Stalwart's `POST /principal`
  doesn't reliably fail fast on a duplicate name, so the
  request stalls long enough for client-side socket timeouts
  (~8s) to fire before the route's `fieldAlreadyExists` 409
  matcher ever runs. `AccountManager.create` now does a
  synchronous SQLite check at the very top — before any
  network I/O — and throws `Account already exists: <name>`
  immediately, which the route's existing `'already exists'`
  matcher converts into a sub-millisecond 409. The orphan
  recovery path (#17) is preserved: by the time control reaches
  the principal-cleanup block, the new fast-path has already
  proven no SQLite row exists, so the cleanup runs
  unconditionally with the same semantics as before.
- **SSE `/events` does not emit inbound events for internal
  agent-to-agent mail** (#24, thanks @kn8-codes). The lock
  release in #16 fixed external IMAP IDLE — but Stalwart
  0.15.5 does not reliably push an unsolicited `EXISTS`
  notification to a logged-in IDLE'd session for messages it
  *locally delivered* from an authenticated SMTP submission.
  The message lands in the recipient's INBOX (so
  `GET /mail/inbox` shows it), but the IDLE listener never
  fires and the SSE stream emits only the initial `connected`
  frame. We now sidestep the SMTP→IMAP-IDLE→SSE chain for
  local recipients the same way the task RPC endpoint already
  does — `POST /mail/send` resolves any `@localhost` recipients
  to their agent rows and pushes a `'new'` event directly via
  `pushEventToAgent`. External inbound continues to flow
  through the watcher (the #16 lock-release fix is intact and
  required for that path).
- **Auto-start service artifacts point at the legacy unscoped
  package after upgrading from `agenticmail` to
  `@agenticmail/cli`** (#26, thanks @kn8-codes). The launchd
  plist (`~/Library/LaunchAgents/com.agenticmail.server.plist`)
  and start-server.sh still hard-coded
  `/opt/homebrew/lib/node_modules/agenticmail/...` after the
  rename, leaving stderr filled with `MODULE_NOT_FOUND`. Two
  fixes: `ServiceManager.getApiEntryPath` now resolves
  `@agenticmail/api` via `createRequire(import.meta.url)` (so
  the path follows the actual install location regardless of
  npm prefix or scoped/unscoped name), and `cmdStart` now
  calls a new `ServiceManager.needsRepair()` on every launch —
  if the installed plist references a missing path or stale
  version, it silently regenerates both files and prints a
  one-line notice. Fresh installs are unchanged.

## [0.5.58] - 2026-05-08

### Fixed

- **`POST /storage/tables` hangs indefinitely** (#15, thanks
  @kn8-codes). The storage routes were calling `db.run`, `db.get`,
  and `db.all` against a raw better-sqlite3 instance that only
  exposes `prepare/exec`. Every storage call threw a synchronous
  TypeError, and the one in `ensureMetaTable()` (which sat outside
  the per-route try/catch) escaped Express's default async handler
  — leaving the request hanging until the client timed out. Added
  an adapter that maps the async `run/get/all` shape to
  `prepare(sql).run/get/all(...args)` (and falls through to
  `exec(sql)` for parameter-less DDL like `CREATE TABLE`), so
  every storage endpoint now responds with success or a structured
  error.
- **SSE `/events` connects but never emits inbound mail events**
  (#16, thanks @kn8-codes). The `InboxWatcher` acquired a
  `getMailboxLock` and intentionally held it, expecting that to
  keep IDLE notifications flowing. ImapFlow's contract is the
  opposite — holding the lock keeps the connection in a command
  state and **prevents** IDLE from firing. Since the watcher's
  connection is dedicated to a single caller, the lock is now
  released immediately after the listeners are registered;
  `'exists'` / `'expunge'` / `'flags'` events now flow on every
  new mail and the SSE stream emits per the API docs.
- **Agent creation can fail with `fieldAlreadyExists` on the
  first attempt** (#17, thanks @kn8-codes). When a previous
  creation attempt left a Stalwart principal but no matching
  SQLite row (crash mid-create, manual cleanup, fresh re-install
  pointed at the same Stalwart), every subsequent
  `POST /accounts` would 500 with Stalwart's
  `fieldAlreadyExists` error. `AccountManager.create` now detects
  the orphan (no SQLite row but principal name in use) and
  deletes it before issuing the fresh `createPrincipal` call.
  The route handler also widens its 409 detection to recognise
  `fieldAlreadyExists` / `alreadyExists` so any unrelated
  Stalwart-flavoured "exists" error returns a clean 409 instead
  of falling through to the generic 500 path.
- **`agenticmail openclaw --help` launched the interactive setup
  wizard instead of showing usage** (#18, thanks @kn8-codes). The
  top-level CLI dispatcher only inspects `process.argv[2]`, so
  `openclaw --help` matched the openclaw case and dropped into
  the wizard. The handler now checks `process.argv.slice(3)` for
  `--help` / `-h` / `help` first and prints a sub-command help
  block with usage, the six setup steps, and a pointer back to
  the global help.
- **`agenticmail status` reported "Secure Tunnel ✅" on
  localhost-only setups** (#21, thanks @kn8-codes). The status
  command labelled the `cloudflared` dependency as "Secure
  Tunnel" and rendered it green whenever the binary was present
  — but the binary is downloaded as part of every setup,
  including localhost-only evals where no tunnel exists. The
  cloudflared row now only appears when the saved config has
  `gateway.mode === 'domain'` AND a tunnel id / domain is
  attached; otherwise it's hidden, and the actual tunnel state
  is left to the "Email" section to report from the live
  gateway-status endpoint. Renamed the friendly label to
  "Cloudflared CLI" for the cases where it does render so users
  understand we're surfacing CLI presence, not active tunnel
  health.

### Documentation

- Clarified the OpenClaw integration wording (#19, thanks
  @kn8-codes). The CLI README previously said
  "if OpenClaw is detected, automatically registers the plugin"
  inside the `agenticmail setup` step list; in practice plugin
  registration only happens through the explicit
  `agenticmail openclaw` flow. Reworded so that's unambiguous.
- Clarified async `call_agent` result delivery (#22, thanks
  @kn8-codes). The README's bullet on async mode implied an
  email always lands in the caller's inbox; clarified that the
  result email is dispatched through the normal mail pipeline,
  so on a localhost-only setup it shows up in the caller's
  local mailbox (`/mail/inbox`) rather than via SMTP relay.
- Surfaced #20's documentation gap list in the relevant places:
  the cloudflared download is now described as expected even on
  localhost-only setups; the storage API's failure-mode response
  shape is documented inline; the OpenClaw plugin verification
  troubleshooting steps got a paragraph in the OpenClaw README.

## [0.5.57] - 2026-05-07

### Changed

- **Renamed the CLI package from `agenticmail` to `@agenticmail/cli`.**
  GitHub Packages requires scoped names, so `agenticmail` (the only
  unscoped package in the monorepo) couldn't ship to
  `https://npm.pkg.github.com` alongside the rest of the
  `@agenticmail/*` workspaces. Renaming aligns the publish surface
  on both registries and makes the package set easier to manage as
  a single namespace. The CLI binary itself is still
  `agenticmail` — only the install name changed:
  `npm install -g @agenticmail/cli`.
  The legacy `agenticmail@0.5.56` package on npm stays available
  for in-flight installs but receives no further updates.

## [0.5.56] - 2026-05-07

### Added

- **`classifyEmailRoute` core helper + SSE route metadata** (#14).
  Inbound `/events` SSE messages now carry a `route` field tagging
  the email as one of `ignore_spam`, `ignore_newsletter`,
  `archive_automated`, `project_update`, `deal_escalation`,
  `agent_instruction`, or `human_private`. Each classification
  includes the suggested action (`ignore` / `archive` / `notify` /
  `escalate` / `create_task` / `draft_reply`), confidence
  (`low|medium|high`), human reason, and a `gateRequired` flag so
  downstream agents know when a route needs explicit human approval
  before acting. Pure function — attaches metadata, never auto-acts.
- **Configurable OpenClaw inbox injection** (#13). The plugin's
  unread-mail prompt context now has four modes:
  `inboxInjectionMode: off | count | summary | required` (default
  `summary`). The pre-0.5.56 hardcoded "ACTION REQUIRED, read every
  unread email first" prompt is preserved behind explicit
  `required` configuration; the new default surfaces sender +
  subject + UID metadata without forcing read-first behaviour.
  `inboxInjectionMaxItems` (1-25, default 5) and
  `inboxInjectionIncludePreview` (boolean, default false) round
  out the controls.

### Fixed

- **`mail.references` crashes when the value arrives as a string
  instead of an array** (#11, thanks @marcelomar21). Three call
  sites in `RelayGateway.sendViaRelay` and the gateway manager's
  inbound + outbound paths previously called `mail.references?.join`
  unconditionally, throwing `TypeError: mail.references?.join is
  not a function` for every reply where the upstream caller resolved
  a single `Message-Id` reference. Each site now guards with
  `Array.isArray(...)` and falls through to the raw string when
  it's already a flat header value.
- **CLI app-password prompts echoed Google Voice credentials in
  plaintext** (#12). The three setup paths that ask for a Gmail
  app password now use the existing `askSecret` masked-input
  helper, matching the rest of the CLI's secret-prompt vocabulary.
- **`@agenticmail/mcp` `apiRequest` returned `Promise<any>`**
  (#12). The helper is now generic (`apiRequest<T>`) and no
  longer leaks `any` into every tool implementation that calls it.

### Security

- **Hardened the OpenClaw inbox-injection summary against
  prompt-tag breakout.** The summary embeds untrusted email
  metadata (sender, subject, optional preview) inside an
  `<unread-emails>…</unread-emails>` block in the agent's system
  prompt. A hostile sender could previously close the block early
  and inject instructions below it. Sanitisation now strips `<`
  and `>` from every untrusted field plus caps the sender address
  (120 chars) and subject (160 chars) so a long header can't
  drown the rest of the prompt. Hardened on top of #13.
- **Scoped route-classifier metadata to the policy keys it
  actually reads.** The `/events` SSE route previously passed the
  full `agent.metadata` blob into the classifier. The classifier
  only consults `emailRoutePolicy / routePolicy / mailboxPolicy`,
  so we now project just those three keys. Prevents a future
  classifier-side change from accidentally echoing founder-set
  arbitrary metadata into the SSE event payload. Hardened on top
  of #14.

### Credits

Thanks to **@marcelomar21** for the relay-references array-guard
fix in #11, and to **@benediktkraus** for the public-quality
tightening in #12, the configurable inbox injection in #13, and
the inbound route classifier in #14. The detailed PR descriptions
and verification checklists made the security review + hardening
passes straightforward.

## [0.5.55] - 2026-05-02

### Fixed

- **`@agenticmail/mcp` crash on startup with MCP SDK 1.13+** (#9). The
  loose `^1.12.0` semver let npm install 1.13+ fresh, where tool
  registration tightened to require Zod schemas instead of raw JSON
  Schema. Added a JSON-Schema-to-Zod converter so the existing tool
  definitions register cleanly on every SDK release ≥ 1.12, and
  switched the tool callback signature to the post-1.13 `(args)`
  shape. Initial fix from @Abeyron in #8.
- **`db_admin` arrays silently rejected** — the converter previously
  fell back to `z.array(z.string())` for arrays without an explicit
  `items` declaration, which broke `columns`, `rows`, `operations`
  and other object-array inputs. Fallback is now `z.any()` for
  defence-in-depth, and every existing array field has explicit
  `items` so OpenAI-strict validators accept the schema upstream.
- **Free-form objects (`where`, `set`, `column`) rejected by the
  converter** — `z.object({})` rejected every real call. Now
  resolved to `z.record(z.any())` when `properties` is empty.
- **`cc` / `bcc` dropped on domain-mode sends** — `sendViaStalwart()`
  built a nodemailer envelope without the `cc`/`bcc` fields even
  though the upstream `SendMailOptions` carried them. Initial fix
  from @Abeyron in #8.
- **Inbound relay messages mis-attributed to the agent in domain
  mode** — `parseEmail()` only restored `X-Original-From` when the
  rewritten sender ended in `@localhost`. Now also matches messages
  carrying `X-AgenticMail-Relay: inbound`. Initial fix from
  @Abeyron in #8.
- **First-run setup fails with 404 on Stalwart admin** (#10). Pinned
  `stalwartlabs/stalwart` to `v0.15.5` in both the bundled
  `docker-compose.yml` and the `generateDockerFiles()` template
  (and the CI service). Stalwart 0.16+ moved its config to JSON
  at `/etc/stalwart/config.json`, runs as UID 2000, and silently
  ignores the legacy TOML mount, leaving the container in
  bootstrap mode. The wizard's setup error mapping now also
  recognises Stalwart 404s and points to issue #10 with the exact
  recovery commands.

### Credits

Thanks to **@Abeyron** for the original PR (#8) covering the MCP
schema, cc/bcc, and `X-Original-From` fixes, and to
**@StreamlinedStartup** for the detailed reproductions in #9 and #10
that made the root causes obvious.

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
- MCP server for AI client integration
- OpenClaw plugin with skill definitions
- Interactive CLI shell with 30+ commands
- Task system — agent-to-agent RPC with SSE + polling
- Rate limiting and authentication middleware
