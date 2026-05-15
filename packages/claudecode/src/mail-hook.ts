#!/usr/bin/env node
/**
 * AgenticMail Claude Code mail hook.
 *
 * # What this script is
 *
 * A Claude Code `UserPromptSubmit` hook. It runs every time the user
 * sends a prompt in the Claude Code interactive UI, BEFORE Claude
 * sees the prompt. The hook checks the AgenticMail bridge inbox
 * (`claudecode@localhost`) for new mail that arrived since the last
 * hook run, and if it finds any, injects a summary as additional
 * context so Claude becomes aware of it without the user having to
 * ask "any updates?"
 *
 * # Why this exists
 *
 * Claude Code is a synchronous REPL — there is no out-of-band channel
 * that lets external services push notifications to a running session.
 * When AgenticMail sub-agents reply to a coordination thread (or ask
 * the host a mid-task question), the reply lands in the bridge inbox
 * but Claude doesn't know about it until either:
 *
 *   (a) Claude proactively polls `list_inbox` / `wait_for_email`, OR
 *   (b) the user explicitly says "check on the team"
 *
 * That latency makes async multi-agent coordination feel half-built.
 * This hook closes the gap. The user types ANY prompt — even
 * "thanks", "what time is it", anything — and Claude transparently
 * gets "by the way, Vesper sent you a question 30 seconds ago" in
 * the system context. Claude can decide to surface it, act on it,
 * or store it for later.
 *
 * # Two event types, two output schemas
 *
 *   - UserPromptSubmit — fires when the user types. Output uses
 *     `hookSpecificOutput.additionalContext` to inject a system-style
 *     message before Claude reasons about the prompt.
 *
 *   - Stop — fires when Claude was about to stop a turn. THIS is the
 *     autonomous-mode awareness mechanism. If new mail arrived during
 *     a long autonomous run (Claude Code running headless for hours
 *     with no user prompts), Stop fires when Claude is about to stop
 *     and we return `{decision: 'block', reason: '...'}`. Claude is
 *     forced to continue, sees the reason as context, and can read
 *     and respond to the mail before finally stopping.
 *
 *     This is the proper fix for the autonomous-mode case we filed
 *     as a follow-up in 0.8.23. Unlike PreToolUse (whose schema
 *     does not accept additionalContext, hence the noisy error
 *     spam in 0.8.22), the Stop hook's `decision: 'block'` is the
 *     supported supported way to inject context at turn boundaries
 *     without firing on every single tool call.
 *
 * # Design constraints
 *
 *   - Must be FAST: this runs on every prompt; >500ms perceived latency
 *     would be a tax on every interaction. We use 2s HTTP timeouts and
 *     bail silently on any error so user prompts never block.
 *
 *   - Must be SILENT on failure: AgenticMail might not be running,
 *     master key might be missing, network might be down. None of
 *     those are reasons to make a regular Claude Code prompt fail.
 *     `process.exit(0)` with no output = no context injection.
 *
 *   - Must DEDUP: we don't want to re-tell Claude about the same
 *     email on every turn. We persist a cursor (timestamp of the
 *     latest mail we surfaced) in `~/.agenticmail/claudecode-hook-cursor.json`
 *     and only surface mail received after it.
 *
 * # Output format
 *
 * Claude Code's `UserPromptSubmit` hook accepts a JSON response with
 * `hookSpecificOutput.additionalContext`. That string gets prepended
 * to the user's prompt as a system-style message so Claude sees it
 * before reasoning about the user's request.
 *
 * We deliberately keep the injected context terse — one line per new
 * mail (UID, sender, subject, ~120 char preview). The full email is
 * one `read_email` call away if Claude wants more.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

interface AgenticMailDiskConfig {
  masterKey?: string;
  api?: { host?: string; port?: number };
}

interface Account {
  id: string;
  name: string;
  email: string;
  role?: string;
  apiKey: string;
}

interface InboxMessage {
  uid: number;
  date?: string;
  subject?: string;
  from?: Array<{ address?: string; name?: string }>;
  flags?: string[];
  preview?: string;
}

/** Where AgenticMail keeps its config. The hook is a pure consumer
 *  of this file; it never writes to it. */
const AGENTICMAIL_DIR = join(homedir(), '.agenticmail');
const CONFIG_PATH = join(AGENTICMAIL_DIR, 'config.json');
const CURSOR_PATH = join(AGENTICMAIL_DIR, 'claudecode-hook-cursor.json');
/**
 * Tracks which Claude Code session_ids we've already injected the
 * AgenticMail capabilities blurb into. Capped at SESSIONS_CAP entries
 * (LRU by insertion order) so the file stays small even after
 * months of use. Without this we'd either:
 *   - re-inject on every prompt (token waste, drowns the model in
 *     boilerplate it already saw), or
 *   - never inject (model is unaware of the toolbelt unless the user
 *     names it explicitly, which defeats the point of the hook).
 *
 * Per-session is the right granularity: each `claude` invocation is
 * a fresh model + fresh context, so the blurb needs to land ONCE on
 * that session's first prompt and never again.
 */
const SESSIONS_PATH = join(AGENTICMAIL_DIR, 'claudecode-hook-sessions.json');
const SESSIONS_CAP = 100;

/** Tag the cursor file with the version so future schema changes can
 *  detect and re-bootstrap cleanly. */
const HOOK_VERSION = '1';

/** HTTP timeout. The whole hook should finish in well under this. */
const HTTP_TIMEOUT_MS = 800;

/**
 * Absolute upper bound on hook wall time. Belt-and-suspenders for the
 * per-fetch HTTP_TIMEOUT_MS — if the underlying socket or DNS path stalls
 * past AbortSignal.timeout (we have seen this in practice), the hook
 * still exits within this budget instead of blocking the harness on
 * the 10-minute default hook timeout.
 *
 * NEVER raise this above ~1500ms: users feel >500ms latency on every
 * prompt submit, and the whole point of the hook is to be invisible.
 */
const GLOBAL_TIMEOUT_MS = 1500;

/**
 * Minimum gap between API checks when we're firing on `Stop`. Stop
 * fires at every turn boundary during autonomous work — much rarer
 * than PreToolUse, but a long run can still rack up dozens of them.
 * 15s is a polite floor that keeps autonomous awareness fresh
 * without spamming the inbox endpoint. UserPromptSubmit always
 * bypasses this floor because the user is waiting.
 */
const STOP_THROTTLE_MS = 15_000;

/**
 * Read stdin and try to parse it as the hook input JSON Claude Code
 * sends. Returns null on any failure — the hook still works without
 * the input, we just lose the event-type signal.
 *
 * Claude Code payload (relevant subset):
 *   { hook_event_name: "UserPromptSubmit" | "PreToolUse" | ..., session_id?: string, ... }
 */
async function readStdinJson(): Promise<{ hook_event_name?: string; session_id?: string } | null> {
  if (process.stdin.isTTY) return null;
  return new Promise(resolve => {
    let buf = '';
    let settled = false;
    const onData = (chunk: string) => { buf += chunk; };
    const onEnd = () => finish(() => {
      if (!buf.trim()) return null;
      try { return JSON.parse(buf); } catch { return null; }
    });
    const onError = () => finish(() => null);
    // Detach all listeners + unref stdin once we have an answer. Without
    // this the listeners stay registered for the rest of the process
    // lifetime and the readable side of stdin keeps the event loop alive,
    // which is the root cause of "hook completed its work in 20ms but the
    // node process sat alive for 10 minutes" observed in 0.8.x.
    const finish = (compute: () => { hook_event_name?: string } | null) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      try { process.stdin.unref(); } catch { /* not all streams support unref */ }
      resolve(compute());
    };
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    setTimeout(() => finish(() => null), 200).unref();
  });
}

/**
 * One-shot capabilities preamble injected on the FIRST UserPromptSubmit
 * of each Claude Code session.
 *
 * Why this exists
 * ───────────────
 * Claude Code sessions start with no prior knowledge of which MCP tools
 * are wired up. The model can SEE the tools (they appear in its
 * tool-use schema), but a tool name + zod schema is a thin signal —
 * the model doesn't know when AgenticMail is the right reach for a
 * problem. So when the user asks "build me a flashcard app", Claude
 * often goes straight to single-process scaffolding when AgenticMail
 * would unlock multi-agent design/build/review in parallel.
 *
 * This blurb tells the model:
 *   - what AgenticMail is for in plain language
 *   - the specific patterns it should reach for it (multi-agent
 *     coordination, durable email threads, sub-agent spawning)
 *   - the THREE high-leverage tools (send_email, create_account,
 *     call_agent) — not the full 60+, which would just be noise
 *
 * Kept short: ~250 tokens. Long enough to shape behaviour, short
 * enough that on a 30-prompt session it's <1% of total tokens.
 */
function capabilitiesBlurb(): string {
  return [
    '🎀 AgenticMail is available via MCP (mcp__agenticmail__*).',
    '',
    'When to reach for it:',
    '  · Building anything that benefits from MULTIPLE specialized roles working in parallel — designer + developer + reviewer, researcher + writer + fact-checker, planner + executor + critic.',
    '  · Coordinating long-running async work that survives across Claude Code restarts (email threads are durable; in-memory state is not).',
    '  · Anywhere you would otherwise spawn the Task tool repeatedly for sub-tasks — prefer AgenticMail when those sub-tasks need to talk to EACH OTHER, not just back to you.',
    '',
    'High-leverage tools:',
    '  · mcp__agenticmail__create_account({ name, role })       — spawn a fresh persistent agent identity with its own inbox + API key.',
    '  · mcp__agenticmail__send_email({ to, cc, subject, text, wake }) — kick off the work. CC the whole team; use `wake: ["alice"]` to give exactly one agent the next turn while others stay informed.',
    '  · mcp__agenticmail__call_agent({ agent, message }) / mcp__agenticmail__wait_for_email — blocking RPC when you need a specific answer back before continuing your own turn.',
    '',
    'Coordination pattern: one email thread = the shared workspace. Reply-all keeps the audit trail. Use `wake` to control whose turn it is.',
    '',
    'Other tools cover: inbox/folder management, drafts, templates, tasks, contacts, signatures, SMS, voice. Full list under mcp__agenticmail__* — discover on demand, don\'t front-load them all.',
  ].join('\n');
}

/**
 * Load the set of session_ids we've already injected the capabilities
 * blurb into. Missing / corrupt file → empty set (next session gets
 * injected, no harm). Bounded by SESSIONS_CAP via LRU at write time.
 */
function loadSeenSessions(): string[] {
  if (!existsSync(SESSIONS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
    const arr = Array.isArray(parsed?.seen) ? parsed.seen : [];
    return arr.filter((s: unknown): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

/**
 * Record that we've injected the blurb into `sessionId`. LRU-trims to
 * SESSIONS_CAP so the file can never grow unbounded over months of
 * use. Silent on write failure — worst case we re-inject on the
 * next prompt of the same session (annoying, not broken).
 */
function rememberSession(sessionId: string, seen: string[]): void {
  const next = seen.filter(s => s !== sessionId);
  next.push(sessionId);
  while (next.length > SESSIONS_CAP) next.shift();
  try {
    if (!existsSync(dirname(SESSIONS_PATH))) mkdirSync(dirname(SESSIONS_PATH), { recursive: true });
    writeFileSync(SESSIONS_PATH, JSON.stringify({ seen: next, hookVersion: HOOK_VERSION }, null, 2));
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  // Read the event type up front — drives the rate-limit decision below.
  const input = await readStdinJson();
  const eventName = input?.hook_event_name ?? 'UserPromptSubmit';
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';

  // ─── SessionStart fast path ─────────────────────────────────────
  //
  // Claude Code fires SessionStart on:
  //   - "startup" — fresh `claude` invocation
  //   - "resume"  — `claude --resume <id>`
  //   - "compact" — auto-compaction wiped the model's context mid-session
  //
  // All three want the capabilities blurb re-injected. The compact case
  // is the one that matters most for long-running sessions: session_id
  // stays the same across compact, so dedup-by-session-id WOULD swallow
  // the re-inject silently. SessionStart fires explicitly, so we just
  // always emit on it — no dedup, no API calls.
  //
  // Output schema (per Claude Code hook contract): SessionStart uses
  // `hookSpecificOutput.additionalContext` just like UserPromptSubmit.
  if (eventName === 'SessionStart') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: capabilitiesBlurb(),
      },
    }));
    return;
  }

  // For UserPromptSubmit, we also opportunistically emit the blurb if
  // we've never seen this session_id before. This is a safety net for
  // Claude Code versions that don't fire SessionStart (some older
  // releases) or for sessions where SessionStart failed silently. It
  // is dedup'd by session_id so once SessionStart succeeds, this
  // fallback is a no-op for the rest of that session.
  let blurbContext = '';
  if (eventName === 'UserPromptSubmit' && sessionId) {
    const seen = loadSeenSessions();
    if (!seen.includes(sessionId)) {
      blurbContext = capabilitiesBlurb();
      rememberSession(sessionId, seen);
    }
  }

  // Helper: build the final output. Combines the optional blurb (only
  // populated on the UserPromptSubmit fallback path) with the
  // optional mail summary. Empty → no injection, hook is a no-op.
  const emitAndExit = (mailContext: string) => {
    const combined = [blurbContext, mailContext].filter(Boolean).join('\n\n');
    if (!combined) return;
    if (eventName === 'Stop') {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: combined }));
    } else {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: combined,
        },
      }));
    }
  };

  // 1. Load AgenticMail config. If it doesn't exist OR is missing the
  //    master key, we can't talk to the API for mail context — but we
  //    can still emit the fallback blurb if one is queued.
  if (!existsSync(CONFIG_PATH)) { emitAndExit(''); return; }
  let cfg: AgenticMailDiskConfig;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { emitAndExit(''); return; }
  if (!cfg.masterKey) { emitAndExit(''); return; }

  const apiHost = cfg.api?.host ?? '127.0.0.1';
  const apiPort = cfg.api?.port ?? 3829;
  const apiUrl = `http://${apiHost}:${apiPort}`;

  // 2. Find the bridge agent — the host's identity inside AgenticMail.
  //    Name is configurable; we accept either "claudecode" or the
  //    role-based marker for forward compatibility.
  let bridge: Account | undefined;
  try {
    const r = await fetch(`${apiUrl}/api/agenticmail/accounts`, {
      headers: { Authorization: `Bearer ${cfg.masterKey}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) { emitAndExit(''); return; }
    const data = (await r.json()) as { agents?: Account[] };
    bridge = (data.agents ?? []).find(
      a => a.name === 'claudecode' || a.name === 'claude' || a.role === 'bridge',
    );
  } catch { emitAndExit(''); return; }
  if (!bridge?.apiKey) { emitAndExit(''); return; }

  // 3. Load the cursor — the timestamp of the latest mail we've
  //    already surfaced to Claude. Anything newer than this is "new".
  //    Also holds `lastCheckedMs` so we can rate-limit PreToolUse fires.
  let cursorMs = 0;
  let lastCheckedMs = 0;
  if (existsSync(CURSOR_PATH)) {
    try {
      const c = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'));
      if (typeof c?.lastSeenMs === 'number') cursorMs = c.lastSeenMs;
      if (typeof c?.lastCheckedMs === 'number') lastCheckedMs = c.lastCheckedMs;
    } catch { /* corrupted cursor → treat as zero, will be rewritten */ }
  }

  // 3a. Rate-limit `Stop` fires — even at turn boundaries, an
  //     autonomous session can produce a flurry over short timescales.
  //     UserPromptSubmit is always allowed through (user is waiting).
  const now = Date.now();
  if (eventName === 'Stop' && (now - lastCheckedMs) < STOP_THROTTLE_MS) {
    // Throttled — but the fallback blurb (UserPromptSubmit only) is
    // already gated above, so this is genuinely a no-op for Stop.
    return;
  }

  // 4. Pull the bridge inbox. We don't filter on the server side
  //    (`/mail/search` could but adds latency) — the inbox is small
  //    in practice and filtering 20 rows client-side is microseconds.
  let messages: InboxMessage[] = [];
  try {
    const r = await fetch(`${apiUrl}/api/agenticmail/mail/inbox?limit=20`, {
      headers: { Authorization: `Bearer ${bridge.apiKey}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) { emitAndExit(''); return; }
    const data = (await r.json()) as { messages?: InboxMessage[] };
    messages = data.messages ?? [];
  } catch { emitAndExit(''); return; }

  // 5. Filter to mail received after the cursor. Some servers return
  //    invalid dates for half-resolved internal pushes — drop those
  //    rather than re-injecting them every turn.
  const newOnes = messages.filter(m => {
    if (!m.date) return false;
    const t = new Date(m.date).getTime();
    return Number.isFinite(t) && t > cursorMs;
  });

  // Even when there's no new mail, update lastCheckedMs so the
  // PreToolUse throttle has a recent reference. Skip cursor write
  // on UserPromptSubmit no-news so we don't churn the file on every
  // user keystroke; the throttle only cares about PreToolUse anyway.
  if (newOnes.length === 0) {
    if (eventName === 'Stop') {
      try {
        if (!existsSync(dirname(CURSOR_PATH))) mkdirSync(dirname(CURSOR_PATH), { recursive: true });
        writeFileSync(
          CURSOR_PATH,
          JSON.stringify({ lastSeenMs: cursorMs, lastCheckedMs: now, hookVersion: HOOK_VERSION }, null, 2),
        );
      } catch { /* fine — next call will retry */ }
    }
    // Still emit the fallback blurb if one is queued from
    // UserPromptSubmit's first-prompt-of-session path.
    emitAndExit('');
    return;
  }

  // 6. Format a terse summary. One line per email, sorted newest first.
  //    Claude can `read_email` for full details on anything that
  //    looks actionable.
  newOnes.sort((a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime());
  // Output is shown verbatim to the user when injected at Stop
  // (Claude Code prints the block reason in the transcript) AND
  // consumed silently by the model at UserPromptSubmit. So phrasing
  // is audience-neutral: just facts + the canonical follow-up tool
  // names. No "you should…" / "do not ping the user" — that read as
  // instruction-leakage when the user saw it in the Stop output.
  const lines: string[] = [];
  const count = newOnes.length;
  lines.push(`🎀 New AgenticMail (bridge inbox) — ${count} message${count === 1 ? '' : 's'} since the last check:`);
  lines.push('');
  for (const m of newOnes) {
    const fromAddr = m.from?.[0]?.address ?? 'unknown';
    const fromName = m.from?.[0]?.name ?? '';
    const fromDisp = fromName && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr;
    const subj = m.subject ?? '(no subject)';
    const preview = (m.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    lines.push(`  · UID ${m.uid} — ${fromDisp} · ${subj}`);
    if (preview) lines.push(`    > ${preview}${preview.length === 180 ? '…' : ''}`);
    lines.push('');
  }
  lines.push('Full body: mcp__agenticmail__read_email. Reply: mcp__agenticmail__reply_email (replyAll: true).');

  // 7. Persist the cursor. Use the newest timestamp we saw so the
  //    next invocation only surfaces strictly-newer mail.
  const newestMs = Math.max(...newOnes.map(m => new Date(m.date!).getTime()));
  try {
    if (!existsSync(dirname(CURSOR_PATH))) mkdirSync(dirname(CURSOR_PATH), { recursive: true });
    writeFileSync(
      CURSOR_PATH,
      JSON.stringify(
        { lastSeenMs: newestMs, lastCheckedMs: now, hookVersion: HOOK_VERSION },
        null,
        2,
      ),
    );
  } catch { /* losing the cursor only means we re-tell on next run — annoying, not broken */ }

  // 8. Emit. emitAndExit handles the event-shape dispatch and
  //    prepends the fallback capabilities blurb if one is queued.
  emitAndExit(lines.join('\n'));
}

// Hard requirement: NEVER block a user prompt because of a hook failure.
//
// The harness's default hook timeout is 10 minutes (TOOL_HOOK_EXECUTION_TIMEOUT_MS
// in Claude Code's utils/hooks.ts). That is FAR too long to ever wait on a
// best-effort notification hook. We enforce our own global ceiling here:
// whichever resolves first (main or the timeout) wins, and the process
// always exits explicitly so dangling stdin listeners / AbortSignal timers
// can't keep node alive past the work we care about.
//
// Two failure modes this guards against, both observed in practice:
//   1. AgenticMail's API server (port 3829) accepts the TCP connection
//      but never responds — AbortSignal.timeout SHOULD fire, but on some
//      Node + libuv combinations the fetch sits in a syscall longer than
//      its own deadline.
//   2. main() resolves but the readStdinJson() promise left 'data'/'end'
//      listeners on process.stdin keeping the event loop alive.
const globalTimeout = new Promise<void>(resolve => {
  setTimeout(() => resolve(), GLOBAL_TIMEOUT_MS).unref();
});
Promise.race([main(), globalTimeout])
  .catch(() => {})
  .finally(() => process.exit(0));
