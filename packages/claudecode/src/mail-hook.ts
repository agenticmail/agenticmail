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

/** Tag the cursor file with the version so future schema changes can
 *  detect and re-bootstrap cleanly. */
const HOOK_VERSION = '1';

/** HTTP timeout. The whole hook should finish in well under this. */
const HTTP_TIMEOUT_MS = 2000;

/**
 * Minimum gap between API checks when we're firing on `PreToolUse`.
 * Tool calls can come in tight bursts (Claude reads a file, greps it,
 * reads another, etc.) — without this floor we'd hit the AgenticMail
 * inbox endpoint 10+ times per second during heavy work. 30s is a
 * compromise between freshness and politeness; UserPromptSubmit
 * always bypasses this floor because the user is waiting.
 */
const PRE_TOOL_USE_THROTTLE_MS = 30_000;

/**
 * Read stdin and try to parse it as the hook input JSON Claude Code
 * sends. Returns null on any failure — the hook still works without
 * the input, we just lose the event-type signal.
 *
 * Claude Code payload (relevant subset):
 *   { hook_event_name: "UserPromptSubmit" | "PreToolUse" | ..., ... }
 */
async function readStdinJson(): Promise<{ hook_event_name?: string } | null> {
  if (process.stdin.isTTY) return null;
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      if (!buf.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(buf)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 200).unref();
  });
}

async function main(): Promise<void> {
  // Read the event type up front — drives the rate-limit decision below.
  const input = await readStdinJson();
  const eventName = input?.hook_event_name ?? 'UserPromptSubmit';

  // 1. Load AgenticMail config. If it doesn't exist, silently no-op.
  if (!existsSync(CONFIG_PATH)) return;
  let cfg: AgenticMailDiskConfig;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { return; }
  if (!cfg.masterKey) return;

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
    if (!r.ok) return;
    const data = (await r.json()) as { agents?: Account[] };
    bridge = (data.agents ?? []).find(
      a => a.name === 'claudecode' || a.name === 'claude' || a.role === 'bridge',
    );
  } catch { return; }
  if (!bridge?.apiKey) return;

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

  // 3a. Rate-limit `PreToolUse` fires — tool calls come in tight
  //     bursts during autonomous work, and we don't want to hit the
  //     AgenticMail server on every Read/Grep/Edit. UserPromptSubmit
  //     is always allowed through (user is waiting).
  const now = Date.now();
  if (eventName === 'PreToolUse' && (now - lastCheckedMs) < PRE_TOOL_USE_THROTTLE_MS) {
    return; // throttled — no output, tool call proceeds normally
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
    if (!r.ok) return;
    const data = (await r.json()) as { messages?: InboxMessage[] };
    messages = data.messages ?? [];
  } catch { return; }

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
    if (eventName === 'PreToolUse') {
      try {
        if (!existsSync(dirname(CURSOR_PATH))) mkdirSync(dirname(CURSOR_PATH), { recursive: true });
        writeFileSync(
          CURSOR_PATH,
          JSON.stringify({ lastSeenMs: cursorMs, lastCheckedMs: now, hookVersion: HOOK_VERSION }, null, 2),
        );
      } catch { /* fine — next call will retry */ }
    }
    return;
  }

  // 6. Format a terse summary. One line per email, sorted newest first.
  //    Claude can `read_email` for full details on anything that
  //    looks actionable.
  newOnes.sort((a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime());
  const lines: string[] = [];
  lines.push(`[AgenticMail bridge inbox] You have ${newOnes.length} new email${newOnes.length === 1 ? '' : 's'} since your last turn:`);
  for (const m of newOnes) {
    const fromAddr = m.from?.[0]?.address ?? 'unknown';
    const fromName = m.from?.[0]?.name ?? '';
    const fromDisp = fromName && fromName !== fromAddr ? `${fromName} <${fromAddr}>` : fromAddr;
    const subj = m.subject ?? '(no subject)';
    const preview = (m.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const tail = preview ? ` — ${preview}${preview.length === 120 ? '…' : ''}` : '';
    lines.push(`- UID ${m.uid} | from ${fromDisp} | "${subj}"${tail}`);
  }
  lines.push('');
  lines.push(
    'These are real replies from sub-agents (or mid-task questions). ' +
    'If any of them are addressed to you (Claude Code, the host), surface them to the user ' +
    'and act on whichever they direct you to. Use mcp__agenticmail__read_email for the full body, ' +
    'mcp__agenticmail__reply_email (with replyAll: true) to respond on the thread. ' +
    'You do NOT need to ping the user — just be aware these landed.',
  );

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

  // 8. Emit the hook output. Claude Code reads stdout as JSON and
  //    routes `additionalContext` into the next prompt. We echo the
  //    actual event name so Claude Code routes the output correctly
  //    on each event type (UserPromptSubmit vs PreToolUse — they have
  //    slightly different output schemas but both honour
  //    additionalContext).
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: lines.join('\n'),
    },
  }));
}

main().catch(() => {
  // Hard requirement: NEVER block a user prompt because of a hook
  // failure. Any uncaught error → silent exit, Claude Code proceeds
  // without the AgenticMail context.
  process.exit(0);
});
