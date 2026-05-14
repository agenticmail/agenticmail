# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
