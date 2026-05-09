# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
