/**
 * AgenticMail → Claude Code event dispatcher.
 *
 * Long-lived daemon that bridges AgenticMail's event stream to the
 * Claude Agent SDK. Concretely: subscribes to the master API's SSE
 * stream for every AgenticMail account, and when an event arrives —
 * either a new mail in some agent's inbox, or a task assigned to some
 * agent — it spawns a Claude-powered worker that *is* that agent (same
 * persona, same `_account`-scoped MCP toolbelt) and lets it handle the
 * trigger.
 *
 * This is what makes "send an email to fola@localhost and she wakes up
 * and replies" work — without any always-on enterprise runtime, and
 * without an interactive Claude Code session having to be open.
 *
 * # Design notes
 *
 *   - One SSE connection per account (the master API does not currently
 *     expose a master-key "watch everything" endpoint). The dispatcher
 *     polls `GET /accounts` every `accountSyncIntervalMs` to discover
 *     newly-created accounts and tear down ones that disappeared, so
 *     `create_account` is wake-able within ~one sync interval with zero
 *     manual steps.
 *
 *   - Workers are spawned via `@openai/codex-sdk`'s `Thread.runStreamed()`
 *     — same OpenAI auth as the user's `codex`, same MCP server, same
 *     persona prompt as the on-disk `.toml`. Each worker drains its event
 *     stream to completion, then exits. Codex emits a different event shape
 *     than Claude (item.started / item.updated / item.completed / turn.*),
 *     so `defaultQuery()` includes a small adapter that translates Codex
 *     events into the Claude-shaped frames the rest of the dispatcher
 *     consumes — keeps the wake / coalesce / budget / catch-up logic
 *     completely host-agnostic.
 *
 *   - Concurrency is capped via a small semaphore (default 10). Beyond
 *     that, wakes queue. This is a hard floor on Anthropic-side cost:
 *     50 simultaneous wakes = 50 simultaneous Claude calls, which the
 *     user is unlikely to want by default.
 *
 *   - Task events get an explicit "claim + submit_result" instruction
 *     in the wake prompt so the call_agent long-poll on the master API
 *     resolves cleanly. Mail events just say "you've got new mail" and
 *     trust the persona to do the right thing (read / reply / archive).
 */

import type { AgenticMailAccount } from './types.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { listAccounts, listInboxForAgent, listPendingTasksForAgent } from './api.js';
import { loadPersonaForAgent } from './persona-loader.js';
import { DispatcherState } from './dispatcher-state.js';
import { mkdirSync, createWriteStream, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ThreadCache, AgentMemoryStore, threadIdFor, normalizeSubject } from '@agenticmail/core';

/** Event shape we accept off the SSE stream. */
interface SSEEvent {
  type?: string;
  uid?: number;
  from?: string;
  /**
   * Subject MAY appear at top-level on some code paths AND nested under
   * `message.subject` on others (the master API enriches new-mail events
   * with the full IMAP envelope, which lands under `message`). Always use
   * `extractSubject(event)` rather than reading either path directly.
   */
  subject?: string;
  message?: { subject?: string; from?: unknown; to?: unknown; messageId?: string };
  taskId?: string;
  taskType?: string;
  task?: string;
  assignee?: string;
  /**
   * Optional wake allowlist set by the sender via `send_email({ wake })`.
   * When present, only listed agents (case-insensitive bare name) get a
   * Claude turn. When absent, every CC'd recipient wakes (v0.8.x default).
   */
  wakeAllowlist?: string[];
  /** Per-recipient "was I on the To field?" flag emitted by the
   *  API in 0.9.1+. Pairs with the recipient's `wake_on_cc`
   *  preference: when the agent registered with wake_on_cc:false
   *  and `wasOnTo !== true`, the dispatcher drops the wake. */
  wasOnTo?: boolean;
  [key: string]: unknown;
}

/**
 * Read the subject from a new-mail SSE event regardless of which path
 * the master API put it on. Returns undefined if no subject is present.
 *
 * Why this exists: the master API's events.ts route handler enriches
 * the InboxWatcher 'new' event with the full IMAP envelope under
 * `event.message`. On some code paths (relay-classified mail, spam-
 * scored mail, the early-return for internal mail) the subject also
 * gets copied to top-level. We've seen BOTH shapes in production —
 * `event.subject` AND `event.message.subject` — so just check both.
 */
function extractSubject(event: SSEEvent): string | undefined {
  if (typeof event.subject === 'string') return event.subject;
  if (event.message && typeof event.message.subject === 'string') return event.message.subject;
  return undefined;
}

/** Same idea for `from`, used by the wake prompt. */
function extractFrom(event: SSEEvent): string | undefined {
  if (typeof event.from === 'string') return event.from;
  if (event.message && Array.isArray(event.message.from)) {
    const first = (event.message.from as Array<{ address?: string; name?: string }>)[0];
    if (first?.address) return first.address;
    if (first?.name) return first.name;
  }
  return undefined;
}

/**
 * Pull the wake allowlist from an SSE event, if the sender opted in.
 *
 * The API normalises wake list entries to lowercase bare names (no
 * @localhost) before publishing, so the dispatcher can match against
 * `account.name` directly without re-normalising.
 *
 * Returns:
 *   undefined  → no allowlist; use the default "wake everyone" behaviour
 *   []         → explicit "wake nobody" — deliver mail silently
 *   [names]    → wake only these named agents
 */
function extractWakeAllowlist(event: SSEEvent): string[] | undefined {
  const raw = event.wakeAllowlist;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined; // malformed → ignore
  return raw.map(x => String(x).trim().toLowerCase()).filter(Boolean);
}

/**
 * Should the dispatcher actually spawn a Claude worker for this
 * recipient given the wake allowlist on the event?
 *
 *   no allowlist  → yes (preserves the default "wake everyone CC'd" behaviour
 *                   from v0.8.x and earlier)
 *   empty list    → no  (sender deliberately marked the mail as
 *                   "deliver silently — no Claude turns please")
 *   has entries   → yes only if the recipient's name is on the list
 */
function isAgentOnWakeAllowlist(accountName: string, list: string[] | undefined): boolean {
  if (list === undefined) return true;
  if (list.length === 0) return false;
  return list.includes(accountName.trim().toLowerCase());
}

export interface DispatcherOptions extends ResolveConfigOptions {
  /** Max concurrent workers. Default 10. Hard floor on Anthropic cost. */
  maxConcurrentWorkers?: number;
  /** How often to re-poll /accounts for new agents. Default 60s. */
  accountSyncIntervalMs?: number;
  /** How long to wait between SSE reconnect attempts (start). Default 2s. */
  sseReconnectBaseMs?: number;
  /** Max backoff between SSE reconnect attempts. Default 60s. */
  sseReconnectMaxMs?: number;
  /**
   * Max times a single agent is woken on the same thread before the
   * circuit breaker trips. Default 10. Protects against reply loops,
   * storms when many agents share a thread, and stuck agents that
   * keep replying without making progress. Per-(agent, thread).
   */
  maxWakesPerThread?: number;
  /**
   * Window (ms) for the per-thread wake counter. Default 24h. The
   * counter resets after this period elapses since the FIRST wake in
   * the window — wall-clock-relative, not sliding, so a runaway
   * thread stays muted for the full period (which is what we want).
   */
  wakeWindowMs?: number;
  /** Override the Claude Agent SDK `query` function. Used by tests. */
  querySdk?: QueryFn;
  /** Override the global `fetch`. Used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the global EventSource. Optional — we don't use EventSource
   *  by default (fetch + reader is simpler). */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Override Date.now() — tests use this to advance the budget clock. */
  nowMs?: () => number;
  /** Debounce window for wake-coalescing per (agent, thread).
   *  Default 30 s — covers a typical "burst of back-to-back
   *  replies in 5–15 s" pattern without making single replies
   *  feel sluggish. Set to 0 to disable coalescing entirely
   *  (one Claude turn per event, pre-0.9.0 behaviour). */
  wakeCoalesceMs?: number;
  /** Override the ThreadCache disk root. Tests use a tmpdir;
   *  production runs against ~/.agenticmail/thread-cache/. */
  threadCacheDir?: string;
  /** Override the AgentMemoryStore disk root. Same rationale as
   *  threadCacheDir — only tests should set this. */
  agentMemoryDir?: string;
  /** Override the dispatcher state file (per-account cursors used
   *  for restart recovery). Tests use a tmpdir; production runs
   *  against ~/.agenticmail/dispatcher-state.json. */
  stateFilePath?: string;
  /**
   * Disable catch-up scan + pending-task scan on channel open.
   * Default false. Tests that don't want the dispatcher hitting the
   * inbox/tasks endpoints on first connect set this true. Has no
   * effect on the persisted seenUids restore — that's always on.
   */
  disableCatchupScan?: boolean;
}

/**
 * Minimal SDK-query signature we use. The shape matches Claude's
 * `@anthropic-ai/claude-agent-sdk` query() for historical reasons —
 * `runWorker` reads frames in that shape and adapter code translates
 * Codex's events into it (see `defaultQuery()` below). Tests can mock
 * this directly without going through the Codex SDK.
 */
export interface QueryFn {
  (params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<unknown>;
}

interface ChannelState {
  /** Account currently watched on this channel. */
  account: AgenticMailAccount;
  /** Active AbortController for the SSE fetch. */
  controller: AbortController | null;
  /** True once the channel has been instructed to stop permanently. */
  stopping: boolean;
  /** Current reconnect backoff in ms. */
  backoffMs: number;
  /** UIDs we've already woken on (per channel). Bounded — see below. */
  seenUids: Set<number>;
  /** Task IDs we've already started a worker for. Bounded. */
  seenTaskIds: Set<string>;
  /**
   * Cross-channel-type dedup: when /tasks/rpc and /tasks/assign fire, the
   * master API simultaneously (a) emits a task SSE event AND (b) sends a
   * `[RPC] …` / `[Task] …` notification email to the assignee. We get
   * BOTH from our per-agent SSE — same logical wake, double the worker
   * cost. We track the last time a task wake happened on this channel;
   * if a notification-shaped mail arrives within the suppression window,
   * we drop it.
   *
   * The window is bounded so we still recover when the dispatcher
   * reconnects after a drop and misses the task event — in that case
   * the notification email IS our only signal and must wake the worker.
   */
  suppressTaskMailUntilMs: number;
}

/** Defensive cap so seenUids/seenTaskIds can't grow unbounded over weeks. */
const SEEN_CAP = 1024;
function rememberBounded<T>(set: Set<T>, item: T): void {
  set.add(item);
  if (set.size > SEEN_CAP) {
    // Drop the oldest ~half. Set iteration order is insertion order.
    const drop = Array.from(set).slice(0, Math.floor(SEEN_CAP / 2));
    for (const x of drop) set.delete(x);
  }
}

/**
 * Global concurrency cap — total workers running simultaneously
 * across the whole dispatcher. Bumped from 10 → 50 in 0.9.4 now
 * that the per-agent serialization below guarantees we never
 * fan out N concurrent workers FOR THE SAME AGENT (which was
 * the actual crash mode at broadcast-to-everyone scale).
 *
 * A 5-agent thread with wake:'all' under the old cap would
 * spawn 5 simultaneous workers — fine. With 50 agents and a
 * 50-recipient broadcast it would spawn 10 immediately + queue
 * 40 globally, choking through 5 batches. Per-agent
 * serialization + this higher cap mean 50 distinct agents can
 * run in parallel and each agent's own queue serialises any
 * burst on that agent.
 */
const DEFAULT_MAX_CONCURRENT = 50;
// Polling is now a safety net behind the push-based /system/events
// stream — newly-created accounts are picked up within milliseconds via
// SSE, not via this poll. 30s is a generous fallback that covers cases
// where /system/events isn't available (older API) or briefly dropped.
const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

/**
 * How long after a task wake do we suppress the matching notification
 * email. 30s is generous — the API sends the notification synchronously
 * within milliseconds of the task event, but mail delivery can hop
 * through Stalwart's queue with a few seconds of latency under load.
 *
 * After this window expires, any inbound `[RPC] / [Task] / [Async-RPC]`
 * mail wakes the agent as a normal new-mail trigger — which is what we
 * want for the post-reconnect recovery case.
 */
const TASK_MAIL_SUPPRESS_WINDOW_MS = 30_000;

/**
 * Subject prefixes the master API uses for task-notification emails.
 * Matching is case-insensitive on the prefix only (the rest of the
 * subject contains the task description / type).
 */
const TASK_NOTIFICATION_SUBJECT_PREFIXES = ['[RPC]', '[Task]', '[Async-RPC]'];

function isTaskNotificationSubject(subject: string | undefined): boolean {
  if (!subject) return false;
  const head = subject.trimStart();
  for (const prefix of TASK_NOTIFICATION_SUBJECT_PREFIXES) {
    if (head.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
}

/**
 * Thread-termination markers the host can put in a subject line to tell
 * the dispatcher "this thread is done — stop waking workers on replies
 * to it". Replies still flow (the mail server doesn't know about this);
 * agents just don't get a Claude turn for them.
 *
 * The user named this gap directly: "No native 'done' signal — the
 * thread just keeps cascading." Subject prefix is the lightest possible
 * answer — the host adds `[FINAL]` / `[DONE]` / `[CLOSED]` to a wrap-up
 * email, and the dispatcher honours it from that point forward on every
 * reply in the same thread.
 *
 * Matched case-insensitively, anywhere in the subject (not just prefix)
 * so `Re: [FINAL] my project` works the same as `[FINAL] Re: my project`.
 */
const THREAD_CLOSED_MARKERS = ['[FINAL]', '[DONE]', '[CLOSED]', '[WRAP]'];

function isThreadClosedSubject(subject: string | undefined): boolean {
  if (!subject) return false;
  const s = subject.toLowerCase();
  return THREAD_CLOSED_MARKERS.some(m => s.includes(m.toLowerCase()));
}

/**
 * Normalise a subject into a thread identifier.
 *
 * Why subject and not Message-ID/References: the event payload carries
 * the subject without us having to fetch the email body. Subject-based
 * threading is what every mail client uses for "grouped by conversation"
 * views, and for the agent-coordination case ("Re: Build a small game")
 * it is accurate in practice. We accept the edge case where two
 * unrelated threads share an identical subject — that costs at worst a
 * dropped wake or a slightly fast-tripped circuit breaker, never silent
 * data corruption.
 *
 * Strips leading `Re:`, `Fwd:`, `Re[3]:`, etc. (repeatedly, case-
 * insensitive). Returns the lowercased, trimmed remainder. An empty or
 * missing subject hashes to '' — the wake-budget code treats that as
 * "no thread context" and falls back to the per-agent default budget.
 */
function threadIdFromSubject(subject: string | undefined): string {
  if (!subject) return '';
  let s = subject.trim();
  // Re: / Fwd: / Fw: with optional [N] count, repeated.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = s.replace(/^(re|fwd?|fw)(\[\d+\])?:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase().trim();
}

/**
 * Wake-budget circuit breaker.
 *
 * # The failure modes we're guarding against
 *
 * Three real concerns from production multi-agent coordination:
 *
 *   1. **Reply loops.** Agent A replies-all → agents B/C/D wake → one
 *      of them replies-all → A wakes again on its own thread → ad
 *      infinitum. Without a brake this burns tokens forever.
 *
 *   2. **Storms.** 10 agents CC'd on the same thread = every reply
 *      wakes 9 workers. Most "stay silent" but each still costs one
 *      Claude turn. We let this work naturally up to a point, but
 *      cap the absolute number per (agent, thread).
 *
 *   3. **Stuck agents.** One agent keeps replying without progress.
 *      Per-(agent, thread) cap catches this even if the persona-level
 *      "stay silent unless it's your turn" rule fails.
 *
 * # Design
 *
 * One entry per (account.id, threadId) tuple. Each entry tracks how
 * many times we've spawned a worker for that combination, plus the
 * timestamp of the first wake in the current window. When the count
 * hits `maxWakesPerThread`, further wakes for that pair are dropped
 * with a log line — until the window expires and the entry resets.
 *
 * The window is wall-clock-relative (not sliding) which is the cheap-
 * and-good-enough trade-off: a thread that maxes out at minute 0 of a
 * 24h window stays muted for the full 24h. That's the right behaviour
 * — if a thread is generating runaway wakes, we WANT it muted for a
 * long time, not for the agent to be re-wakeable as soon as its 24h
 * window slides past oldest entry.
 *
 * The store is bounded by periodic GC (every wake we sweep entries
 * older than the window). Set growth is therefore proportional to
 * unique active threads in the window, not total history.
 */
interface WakeBudgetEntry {
  count: number;
  firstWakeAtMs: number;
}

const DEFAULT_MAX_WAKES_PER_THREAD = 10;
const DEFAULT_WAKE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
/**
 * Default debounce window for wake-coalescing. 30 seconds is the
 * sweet spot: long enough to collapse a burst of replies a human
 * (or AI agent) types in a 5–15 s window, short enough that
 * single-reply latency still feels real-time. Override via
 * DispatcherOptions.wakeCoalesceMs (0 to disable).
 */
const DEFAULT_WAKE_COALESCE_MS = 30_000;

/**
 * Per-worker observation channel. `runWorker` calls `onMessage` for every
 * SDK message — assistant text, tool calls, tool results, result frames.
 * The caller (spawnWorker) wires this to:
 *   - a per-worker log file at `~/.agenticmail/worker-logs/<id>.log`
 *   - a heartbeat ticker that POSTs progress to /dispatcher/worker-heartbeat
 *
 * Kept generic so tests don't need to mock disk + network to verify the
 * observation path.
 */
export interface WorkerObserver {
  /** Called once per SDK message. Tag is a short event name. */
  onMessage(tag: string, summary: string): void;
}

/**
 * Compact-and-continue: drive a worker across multiple SDK turns
 * when one turn isn't enough to finish (context overflow, natural
 * pause + continuation marker, etc.). Each iteration:
 *
 *   1. Run `runWorker` with the current prompt.
 *   2. If it succeeds (worker exited naturally — likely after
 *      submit_result, reply_email, or a graceful end), return.
 *   3. If it fails with a context-overflow error AND we have
 *      budget left, synthesize a checkpoint from the captured
 *      log lines + last assistant text, build a continuation
 *      prompt, and loop.
 *   4. If iterations are exhausted, return the last failure.
 *
 * Iteration cap defaults to 4 — enough for a worker to finish a
 * multi-hour task across context resets, low enough to bound
 * runaway cost. Override per worker via the env knob.
 *
 * NOTE: this only addresses the case where ONE query() hits the
 * model's context limit mid-conversation. Workers that genuinely
 * never end (no submit_result, no mail send) still loop until
 * the iteration cap; no infinite-spend hazard, just a graceful
 * abort with a clear "compaction budget exhausted" reason.
 */
async function runWorkerWithCompaction(
  query: QueryFn,
  persona: string,
  initialPrompt: string,
  agent: AgenticMailAccount,
  mcpServerName: string,
  mcpCommand: string,
  mcpArgs: string[],
  mcpEnv: Record<string, string>,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  observer: WorkerObserver,
  cwd: string,
  maxIterations = 4,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let prompt = initialPrompt;
  let lastResult: { ok: true; text: string } | { ok: false; error: string } | null = null;
  /** Rolling capture of tool calls + their truncated results for
   *  the continuation prompt. We don't keep the full conversation —
   *  just enough breadcrumbs so the next-turn worker knows what's
   *  already been done. */
  const breadcrumbs: string[] = [];
  const captureObserver: WorkerObserver = {
    onMessage(tag, summary) {
      observer.onMessage(tag, summary);
      if (tag === 'tool_use') breadcrumbs.push(`✓ ${summary}`);
      else if (tag === 'tool_result') breadcrumbs.push(`  → ${summary}`);
    },
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    if (iter > 0) {
      log('info', `[dispatcher] compaction iter ${iter + 1}/${maxIterations} for "${agent.name}"`);
    }
    lastResult = await runWorker(
      query, persona, prompt, agent,
      mcpServerName, mcpCommand, mcpArgs, mcpEnv,
      log, undefined, captureObserver, cwd,
    );
    if (lastResult.ok) return lastResult;
    if (!isContextOverflowError(lastResult.error)) return lastResult;
    if (iter === maxIterations - 1) {
      return { ok: false, error: `compaction budget exhausted (${maxIterations} iters): ${lastResult.error}` };
    }
    // Build a continuation prompt. The checkpoint is a terse list
    // of what's been done so far + the original task, with an
    // explicit instruction not to redo the completed steps.
    const checkpoint = breadcrumbs.slice(-40).join('\n');  // cap at 40 most recent
    prompt = [
      initialPrompt,
      '',
      '## Resuming after context reset',
      '',
      'You hit the model context limit on the previous turn. Here is a',
      'breadcrumb of what you already accomplished in that turn —',
      'do NOT redo any of these steps:',
      '',
      checkpoint || '(no breadcrumbs captured)',
      '',
      'Continue from where you left off. If you have already produced',
      'the final deliverable on the previous turn (e.g. submit_result,',
      'reply_email), do nothing this turn and end cleanly.',
    ].join('\n');
    log('info', `[dispatcher] context overflow on "${agent.name}" — compacting (${breadcrumbs.length} breadcrumbs)`);
  }
  return lastResult ?? { ok: false, error: 'worker did not run' };
}

/**
 * True when the SDK error message looks like the model hit its
 * context window. We match conservatively (substring patterns) —
 * Anthropic's error string is "prompt is too long: ... tokens..."
 * but a future SDK might phrase it differently, so we also match
 * common synonyms.
 */
function isContextOverflowError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('prompt is too long')
      || m.includes('context_length_exceeded')
      || m.includes('context length exceeded')
      || m.includes('max tokens')
      || m.includes('maximum context')
      || m.includes('token limit');
}

/**
 * Spawn-and-wait for a worker via the Claude Agent SDK.
 * Drains the query stream, captures the final assistant text, returns it.
 *
 * `cwd` (when given) is passed straight through to the SDK so each
 * worker runs in its own scratch directory — prevents parallel agents
 * from clobbering each other's output files.
 */
async function runWorker(
  query: QueryFn,
  persona: string,
  userPrompt: string,
  agent: AgenticMailAccount,
  mcpServerName: string,
  mcpCommand: string,
  mcpArgs: string[],
  mcpEnv: Record<string, string>,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  abortSignal?: AbortSignal,
  observer?: WorkerObserver,
  cwd?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const opts: Record<string, unknown> = {
    systemPrompt: persona,
    mcpServers: {
      [mcpServerName]: {
        command: mcpCommand,
        args: mcpArgs,
        env: mcpEnv,
      },
    },
    // No `allowedTools` restriction.
    //
    // Earlier versions of the dispatcher locked workers to MCP-only tools
    // ("you operate an email account, not a developer environment"). That
    // was the wrong design: AgenticMail agents are real Claude Code
    // subagents running under the host's OAuth, and the work humans
    // delegate to them (write code, run tests, do research, edit files)
    // demands the full native toolset (Read, Write, Edit, Bash, Glob,
    // Grep, WebFetch, WebSearch, NotebookEdit, …). Restricting them
    // turned "Zephyr implements the game" into "Zephyr emails source
    // code as plaintext and the human has to copy-paste it" — which
    // defeats the point of having agents in the first place.
    //
    // Omitting allowedTools lets the SDK fall through to its defaults
    // (all built-in tools + every tool exposed by the MCP servers we
    // declare above). Outbound mail is still guarded by AgenticMail's
    // own outbound guard (HIGH-severity sends held for owner approval)
    // and the worker is sandboxed by Claude Code's permission system
    // just like any other subagent.
    permissionMode: 'bypassPermissions' as const,
    abortController: abortSignal ? wrapSignal(abortSignal) : undefined,
  };
  // Per-worker scratch dir — prevents parallel workers from clobbering
  // each other's output files when both run the same Bash one-liner.
  if (cwd) opts.cwd = cwd;

  const collectedText: string[] = [];
  try {
    for await (const msg of query({ prompt: userPrompt, options: opts })) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'assistant' && Array.isArray(m.message && (m.message as { content?: unknown[] }).content)) {
        for (const block of (m.message as { content: unknown[] }).content) {
          const b = block as { type?: string; text?: string; name?: string; input?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') {
            collectedText.push(b.text);
            if (observer) observer.onMessage('assistant', b.text.slice(0, 240).replace(/\s+/g, ' ').trim());
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            // Capture tool name + truncated input — the most useful
            // breadcrumb for "what was Vesper actually doing?"
            const inputSummary = (() => {
              try { return JSON.stringify(b.input).slice(0, 200); }
              catch { return '(uninspectable input)'; }
            })();
            if (observer) observer.onMessage('tool_use', `${b.name} ${inputSummary}`);
          }
        }
      } else if (m.type === 'user' && Array.isArray(m.message && (m.message as { content?: unknown[] }).content)) {
        // Tool results land here. We log the tool name + truncated body.
        for (const block of (m.message as { content: unknown[] }).content) {
          const b = block as { type?: string; tool_use_id?: string; content?: unknown };
          if (b.type === 'tool_result') {
            const bodyStr = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as Array<{ text?: string }>).map(c => c.text ?? '').join(' ')
                : '';
            if (observer) observer.onMessage('tool_result', bodyStr.slice(0, 240).replace(/\s+/g, ' ').trim());
          }
        }
      }
      // Final result message (SDK emits one when the turn ends).
      if (m.type === 'result') {
        const r = m as {
          result?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          total_cost_usd?: number;
        };
        if (typeof r.result === 'string') {
          collectedText.push(r.result);
          if (observer) observer.onMessage('result', r.result.slice(0, 240).replace(/\s+/g, ' ').trim());
        }
        // Context-budget telemetry. Surface SDK's reported usage so
        // check_activity / tail_worker can show real token cost
        // and the cache+memory savings become visible. We emit it
        // through the observer; spawnWorker forwards it to the
        // API's worker-finished payload.
        if (r.usage && observer) {
          const u = r.usage;
          const summary = `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cacheR=${u.cache_read_input_tokens ?? 0} cacheW=${u.cache_creation_input_tokens ?? 0}${typeof r.total_cost_usd === 'number' ? ` cost=$${r.total_cost_usd.toFixed(4)}` : ''}`;
          observer.onMessage('usage', summary);
        }
      }
    }
    const text = collectedText.join('\n').trim();
    log('info', `[dispatcher] worker for "${agent.name}" finished (${text.length} chars output)`);
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `[dispatcher] worker for "${agent.name}" failed: ${msg}`);
    if (observer) observer.onMessage('error', msg);
    return { ok: false, error: msg };
  }
}

/** AbortController wrapper that bridges an AbortSignal in. */
function wrapSignal(signal: AbortSignal): AbortController {
  const c = new AbortController();
  if (signal.aborted) c.abort();
  else signal.addEventListener('abort', () => c.abort(), { once: true });
  return c;
}

/** Build the wake prompt for a new-mail trigger. */
/**
 * Wake prompt for a coalesced BATCH of events on the same thread.
 *
 * Single-event wakes use `newMailPrompt`. When the dispatcher
 * coalesces a burst of replies (designer sends 3 quick replies
 * in 10 s, all CC the same agent), one wake fires for the batch
 * and the agent sees this prompt instead: a leading "You have
 * N new messages" header, a list of (UID, sender, subject) for
 * each, then the standard coordination protocol body unchanged.
 *
 * Crucially this REPLACES per-event re-reading: the agent reads
 * the batch list, picks the latest message to drive the reply,
 * and acknowledges all of them in one turn. The thread cache +
 * memory blocks (added by composeWakePromptWithContext) cover
 * older context.
 */
function newMailPromptForBatch(agent: AgenticMailAccount, events: SSEEvent[]): string {
  const lines: string[] = [];
  const count = events.length;
  lines.push(`You have ${count} new messages on this thread (coalesced — they arrived in a burst and you are seeing them in one turn).`);
  lines.push('');
  lines.push('### Burst details');
  for (const ev of events) {
    const f = extractFrom(ev) ?? 'unknown';
    const s = extractSubject(ev) ?? '(no subject)';
    lines.push(`- UID ${ev.uid ?? '?'} · ${f} · "${s}"`);
  }
  lines.push('');
  lines.push(`The LATEST message in the burst is UID ${events[events.length - 1].uid ?? '?'}.`);
  lines.push('Read it first (and any others on the thread you have not yet seen). Then decide:');
  lines.push('- If the burst is multiple replies converging on one ask, respond ONCE on the thread.');
  lines.push('- If the burst is genuinely N independent asks addressed to you, handle them in one reply where possible.');
  lines.push('- If your prior work already addressed the burst, do NOT repeat yourself — stay silent for this wake.');
  lines.push('');
  lines.push('Reuse the standard thread-aware coordination protocol below; the only difference is the batch shape.');
  lines.push('');
  // Reuse the single-event protocol body verbatim with the latest event as anchor.
  const latest = events[events.length - 1];
  lines.push(newMailPrompt(agent, latest));
  return lines.join('\n');
}

function newMailPrompt(agent: AgenticMailAccount, event: SSEEvent): string {
  const from = extractFrom(event) ?? 'unknown sender';
  const subject = extractSubject(event) ?? '(no subject)';
  const uid = event.uid;
  return [
    `You have new mail.`,
    ``,
    `- From: ${from}`,
    `- Subject: ${subject}`,
    uid ? `- UID: ${uid}` : '',
    ``,
    `## Thread-aware coordination protocol`,
    ``,
    `You are ${agent.name}. Multiple agents may be CC'd on the same thread —`,
    `that is intentional: a thread is the shared workspace, and turn-taking is`,
    `implicit from context (who was addressed last, whose stage of the workflow`,
    `is next, who was @mentioned). Follow these steps in order:`,
    ``,
    `1. **Read this message.** read_email({ uid: ${uid ?? '<uid>'}, _account: "${agent.name}" }).`,
    ``,
    `2. **If this is a reply (Subject starts with "Re:" or an In-Reply-To header is present), load the rest of the thread.**`,
    `   Use search_emails({ subject: "<core subject without Re:>", _account: "${agent.name}" })`,
    `   to surface earlier messages in the thread, then read_email each prior UID.`,
    `   You MUST read the full thread before deciding what to do.`,
    ``,
    `3. **CHECK YOUR PRIOR CONTRIBUTIONS to this thread.** When you searched`,
    `   in step 2, look at how many of the messages were sent BY YOU`,
    `   (from: ${agent.email}). If you have already contributed your work`,
    `   to this thread, **do NOT redo it on a new wake**. Redelivering`,
    `   identical content when a teammate posts an update is the most`,
    `   common multi-agent failure mode — it triples noise and wastes`,
    `   tokens. Only re-contribute if EITHER:`,
    `     (a) the latest reply contains a NEW specific ask addressed to`,
    `         you by name and you have not yet answered THAT ask, OR`,
    `     (b) a teammate's reply genuinely changes the picture and your`,
    `         prior work needs an explicit revision (not a re-post).`,
    `   Otherwise stay silent.`,
    ``,
    `4. **Identify the participants.** Look at To + CC across the thread. Those`,
    `   are your collaborators. Their names map to AgenticMail agents at`,
    `   <name>@localhost. They will each be woken on every reply-all the same way you were.`,
    ``,
    `5. **Decide: is it MY turn?** Yes if any of:`,
    `     - The latest message addresses you by name ("Vesper, please …", "@${agent.name} …").`,
    `     - The previous-stage handoff is to your role (e.g. designer → developer, and you are the developer).`,
    `     - You were directly asked a question and nobody has answered yet.`,
    `   No if:`,
    `     - The current ask is targeted at a teammate (their turn, not yours).`,
    `     - **A teammate replied within the last 60 seconds.** They are likely`,
    `       already handling this turn; jumping in creates simultaneous replies`,
    `       and confusion. Assume good faith and stay silent unless their reply`,
    `       was clearly off-target.`,
    `     - You have nothing substantive to add right now.`,
    `   When in doubt, stay silent — over-replying creates noise. Better to let`,
    `   the right teammate take the turn than to step on theirs.`,
    ``,
    `6. **If it's your turn — do the actual work, THEN reply-all about it.**`,
    `   You have full native tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch,`,
    `   WebSearch, NotebookEdit, etc. If the task is "implement X", write the file`,
    `   with Write or Edit and verify with Bash — do NOT paste source code into an`,
    `   email body and call it shipped. The thread is for COORDINATION ("done,`,
    `   see ./foo.py, runs with \`python3 foo.py\`"); the filesystem is for`,
    `   DELIVERABLES. Then:`,
    `     reply_email({ uid: ${uid ?? '<uid>'}, replyAll: true, text: "...", _account: "${agent.name}" })`,
    `   Sign with your name. Be substantive but concise.`,
    ``,
    `   ## Reply addressing — CRITICAL for wake control`,
    `   reply_email({ replyAll: true }) automatically builds the right shape:`,
    `   the ORIGINAL SENDER ends up on To (so they wake by default),`,
    `   every other participant ends up on Cc (so they see it without`,
    `   waking). DO NOT pass a hand-rolled comma-separated address list`,
    `   via send_email — that puts every recipient on To and re-wakes`,
    `   the whole thread, defeating the wake gating. Trust replyAll.`,
    ``,
    `   If you want to wake someone OTHER than the original sender`,
    `   (e.g. you are handing off to a different next actor), name them`,
    `   explicitly in the reply body ("Orion — over to you, please…")`,
    `   AND pass \`wake: ["orion"]\` so the dispatcher gives them a`,
    `   Claude turn instead. Example:`,
    `     reply_email({ uid, replyAll: true, text: "Orion — your turn …",`,
    `                   wake: ["orion"], _account: "${agent.name}" })`,
    `   If nobody specific is next (the work is complete and you're just`,
    `   signing off), pass \`wake: []\` to deliver silently — every`,
    `   participant still sees the reply, no Claude turn is spawned.`,
    ``,
    `7. **If you need additional help from a teammate not yet on the thread,**`,
    `   include them by CC'ing in your reply-all — DO NOT spin up a separate`,
    `   call_agent / message_agent side-channel. The thread is the workspace;`,
    `   everyone stays in context.`,
    ``,
    `8. **If it's NOT your turn,** mark the message read with mark_read and return.`,
    `   Do not reply just to acknowledge. Silence IS a valid contribution.`,
    ``,
    `## How threads end`,
    ``,
    `A thread is done when the host (or any participant) sends a wrap-up`,
    `message with one of these markers in the subject: \`[FINAL]\`, \`[DONE]\`,`,
    `\`[CLOSED]\`, \`[WRAP]\`. The dispatcher will stop waking workers on any`,
    `further replies to that thread. If you are sending a wrap-up yourself`,
    `(because the work is complete and no more contributions are needed),`,
    `include one of those markers in your reply subject.`,
    ``,
    `When you finish, return a one-line summary of what you did:`,
    `  "Contributed: <one-line description>"  OR  "Stayed silent — not my turn."`,
    ``,
    `## Fallback for non-thread mail`,
    ``,
    `If this is a fresh standalone email (not part of a thread, only addressed`,
    `to you), handle it directly: answer the question, do the work, reply.`,
    `Spam: trust the auto-filter unless something obviously slipped through.`,
  ].filter(Boolean).join('\n');
}

/** Build the wake prompt for a task-assignment trigger. */
function taskPrompt(agent: AgenticMailAccount, event: SSEEvent): string {
  const taskId = event.taskId ?? '(missing taskId)';
  const taskText = event.task ?? '(no task description)';
  const taskType = event.taskType ?? 'generic';
  const from = event.from ?? 'unknown';
  return [
    `You have a pending task — handle it now.`,
    ``,
    `- Task ID: ${taskId}`,
    `- Type: ${taskType}`,
    `- From: ${from}`,
    `- Task: ${taskText}`,
    ``,
    `Workflow:`,
    `  1. Call claim_task({ id: "${taskId}", _account: "${agent.name}" }) to mark yourself as the owner.`,
    `  2. Do the work using whatever pre-loaded or invoke-able MCP tools fit.`,
    `  3. Call submit_result({ id: "${taskId}", result: { ... }, _account: "${agent.name}" }) with structured JSON.`,
    `     The caller is waiting on a synchronous long-poll — submit_result is what wakes them.`,
    ``,
    `If you cannot complete the task, submit_result with { status: "failed", reason: "..." }. Never leave it unclaimed — that strands the caller until timeout.`,
  ].join('\n');
}

/**
 * The dispatcher itself. Construct once, call .start() to begin watching,
 * .stop() to tear down. Returns when stop() has finished cleaning up.
 */
export class Dispatcher {
  private cfg: ReturnType<typeof resolveConfig>;
  private maxConcurrent: number;
  private syncIntervalMs: number;
  private reconnectBaseMs: number;
  private reconnectMaxMs: number;
  private query: QueryFn;
  private fetchImpl: typeof fetch;
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void;

  private channels = new Map<string, ChannelState>(); // keyed by account.id
  private accountSyncTimer: ReturnType<typeof setInterval> | null = null;
  private systemChannelController: AbortController | null = null;
  private running = 0;
  private waiters: Array<() => void> = [];
  private stopped = false;

  /**
   * Wake-budget store, keyed by `${accountId}::${threadId}`. See the
   * comment block on WakeBudgetEntry for the failure modes this guards.
   * Pruned opportunistically on each lookup — no separate timer.
   */
  private wakeBudget = new Map<string, WakeBudgetEntry>();
  private maxWakesPerThread: number;
  private wakeWindowMs: number;
  private now: () => number;

  /**
   * Layered wake-context system. ThreadCache holds the last K
   * envelopes per thread (built passively on every SSE new-mail
   * event, even when no agent wakes). AgentMemoryStore holds
   * per-(agent, thread) markdown that workers write at end-of-
   * wake via the save_thread_memory MCP tool. Both are read on
   * worker spawn and injected into the wake prompt — see
   * spawnWorker for the rendering.
   */
  private threadCache: ThreadCache;
  private agentMemory: AgentMemoryStore;

  /**
   * Persistent dispatcher state — per-account `{ lastSeenUid, seenUids[] }`
   * that survives a restart. On `start()` we use it to seed each
   * channel's `seenUids` (so IMAP IDLE replays of old UIDs stay
   * deduped) and to drive the catch-up scan (anything strictly
   * newer than `lastSeenUid` got missed during downtime — route it
   * through handleEvent like a synthetic SSE 'new' event).
   *
   * Writes are debounced inside the state module; we just call
   * `markSeen(accountId, uid)` everywhere we decide on a UID.
   */
  private state: DispatcherState;
  /** Tracks which accounts have already gone through catch-up + pending-task scan
   *  so reconnects don't replay the same backlog. */
  private caughtUp = new Set<string>();

  /**
   * Coalesced wake queue. Keyed by `${accountId}::${threadId}`,
   * each entry holds the pending events + the timer that will
   * fire the spawn. A new event arriving while the entry exists
   * EXTENDS the timer (debounce, not throttle) and appends to
   * the event list. When the timer fires, a single Claude turn
   * sees the union of new messages and replies once.
   *
   * Why debounce + not throttle: bursts of replies from one
   * sender are typically a single logical handoff, not N
   * separate actions. Throttling would still produce a stale
   * wake after the burst settles; debouncing collapses the
   * whole burst into one wake at the trailing edge.
   */
  private wakeCoalesce = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    events: SSEEvent[];
    account: AgenticMailAccount;
    threadId: string;
    firstScheduledAt: number;
  }>();
  private wakeCoalesceMs: number;

  /** Wall-clock timestamp the dispatcher started. Surfaced via
   *  process-heartbeat so check_activity can show uptime. */
  private startedAtMs = Date.now();
  /** Periodic timer that posts a process-heartbeat to the API.
   *  Without this, a hung dispatcher looks identical to "no
   *  events to wake on" — the host has no liveness signal. */
  private processHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DispatcherOptions = {}) {
    this.cfg = resolveConfig(opts);
    this.maxConcurrent = opts.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT;
    this.syncIntervalMs = opts.accountSyncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.reconnectBaseMs = opts.sseReconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.sseReconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.query = opts.querySdk ?? defaultQuery();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.log ?? defaultLog;
    this.maxWakesPerThread = opts.maxWakesPerThread ?? DEFAULT_MAX_WAKES_PER_THREAD;
    this.wakeWindowMs = opts.wakeWindowMs ?? DEFAULT_WAKE_WINDOW_MS;
    this.now = opts.nowMs ?? Date.now;
    this.threadCache = new ThreadCache({ cacheDir: opts.threadCacheDir });
    this.agentMemory = new AgentMemoryStore({ memoryDir: opts.agentMemoryDir });
    this.wakeCoalesceMs = opts.wakeCoalesceMs ?? DEFAULT_WAKE_COALESCE_MS;
    this.state = new DispatcherState({ path: opts.stateFilePath });
    this.disableCatchupScan = !!opts.disableCatchupScan;

    if (!this.cfg.masterKey) {
      throw new Error('Dispatcher requires AgenticMail master key. Run `agenticmail setup` first.');
    }
  }

  private disableCatchupScan: boolean = false;

  /**
   * Charge one wake against the (agent, thread) budget. Returns true
   * if the wake should proceed, false if the circuit breaker is open.
   *
   * Empty threadId means "no thread context" (a fresh standalone email
   * with no Subject — rare); we always allow those since there is no
   * thread to runaway on.
   */
  private chargeWake(accountId: string, threadId: string): { ok: boolean; count?: number; mutedUntilMs?: number } {
    if (!threadId) return { ok: true };
    const key = `${accountId}::${threadId}`;
    const now = this.now();
    let entry = this.wakeBudget.get(key);
    if (entry && now - entry.firstWakeAtMs >= this.wakeWindowMs) {
      // Window expired — reset.
      entry = undefined;
      this.wakeBudget.delete(key);
    }
    if (!entry) {
      entry = { count: 1, firstWakeAtMs: now };
      this.wakeBudget.set(key, entry);
      this.maybePruneWakeBudget(now);
      return { ok: true, count: 1 };
    }
    if (entry.count >= this.maxWakesPerThread) {
      return {
        ok: false,
        count: entry.count,
        mutedUntilMs: entry.firstWakeAtMs + this.wakeWindowMs,
      };
    }
    entry.count++;
    return { ok: true, count: entry.count };
  }

  /**
   * Drop wake-budget entries that have aged out of their window.
   *
   * Called inline from chargeWake, but at most once per ~1024 inserts so
   * the cost stays bounded. We don't need a separate timer because the
   * Map only grows on real wakes (capped by maxWakesPerThread per pair),
   * and the prune is O(n) over the current entries — cheap enough.
   */
  private wakeBudgetInsertsSinceLastPrune = 0;
  private maybePruneWakeBudget(now: number): void {
    this.wakeBudgetInsertsSinceLastPrune++;
    if (this.wakeBudgetInsertsSinceLastPrune < 1024) return;
    this.wakeBudgetInsertsSinceLastPrune = 0;
    for (const [k, v] of this.wakeBudget) {
      if (now - v.firstWakeAtMs >= this.wakeWindowMs) this.wakeBudget.delete(k);
    }
  }

  async start(): Promise<void> {
    this.log('info', `[dispatcher] starting (maxConcurrent=${this.maxConcurrent}, syncEvery=${this.syncIntervalMs}ms)`);
    this.startedAtMs = Date.now();
    await this.syncAccounts();
    this.accountSyncTimer = setInterval(() => {
      this.syncAccounts().catch(err => this.log('warn', `[dispatcher] account sync failed: ${err}`));
    }, this.syncIntervalMs);
    // Process heartbeat — every 30 s the dispatcher posts its
    // alive-state to the API so check_activity / the new
    // /dispatcher/diagnostics endpoint can show "dispatcher is
    // up, watching N channels, queue size M, uptime X." Without
    // this, a stale dispatcher (crashed / hung) looked identical
    // to "no mail to wake on" — the host had no signal.
    this.processHeartbeatTimer = setInterval(() => {
      this.postActivity('/dispatcher/process-heartbeat', {
        startedAtMs: this.startedAtMs,
        uptimeMs: Date.now() - this.startedAtMs,
        channels: this.channels.size,
        coalesceQueueSize: this.wakeCoalesce.size,
        running: this.running,
        maxConcurrent: this.maxConcurrent,
      });
    }, 30_000);
    (this.processHeartbeatTimer as unknown as { unref?: () => void }).unref?.();
    // Fire one heartbeat immediately on start so the host sees
    // "dispatcher is alive" without waiting 30 s.
    this.postActivity('/dispatcher/process-heartbeat', {
      startedAtMs: this.startedAtMs,
      uptimeMs: 0,
      channels: this.channels.size,
      coalesceQueueSize: 0,
      running: 0,
      maxConcurrent: this.maxConcurrent,
    });
    // Subscribe to system-level account-lifecycle events so new accounts
    // get an SSE channel within MILLISECONDS of `create_account`, not at
    // the next poll tick. The polling above stays as a safety net for
    // events lost across reconnects.
    void this.runSystemChannel();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.accountSyncTimer) clearInterval(this.accountSyncTimer);
    this.accountSyncTimer = null;
    if (this.processHeartbeatTimer) clearInterval(this.processHeartbeatTimer);
    this.processHeartbeatTimer = null;
    if (this.systemChannelController) {
      try { this.systemChannelController.abort(); } catch { /* ignore */ }
      this.systemChannelController = null;
    }
    for (const ch of this.channels.values()) {
      ch.stopping = true;
      ch.controller?.abort();
    }
    this.channels.clear();
    // Drop pending coalesced wakes — we never fired them, and on
    // restart the cache + memory have already absorbed the events.
    for (const entry of this.wakeCoalesce.values()) clearTimeout(entry.timer);
    this.wakeCoalesce.clear();
    // Flush any pending cursor updates synchronously so a restart
    // immediately after stop sees the latest lastSeenUid. The
    // debounced timer might not have fired yet.
    try {
      this.state.stop();
      this.state.flushNow();
    } catch (err) {
      this.log('warn', `[dispatcher] could not flush state on stop: ${(err as Error).message}`);
    }
    this.log('info', '[dispatcher] stopped');
  }

  /** Public for tests — directly hand an event to the routing path. */
  async handleEvent(account: AgenticMailAccount, event: SSEEvent): Promise<void> {
    if (this.stopped) return;
    if (event.type === 'new' && typeof event.uid === 'number') {
      const ch = this.channels.get(account.id);
      if (ch?.seenUids.has(event.uid)) return;
      const subject = extractSubject(event);

      // Update the ThreadCache BEFORE any wake-skip checks. Cache
      // is built forward-only and reflects every message we see,
      // regardless of whether THIS account will wake on it. Other
      // agents on the same thread share the cache. See
      // packages/core/src/threading/thread-cache.ts for the
      // design rationale.
      const cacheThreadId = threadIdFor({ subject });
      try {
        const fromAddr = extractFrom(event) ?? '(unknown)';
        const previewSource = (event as { preview?: string }).preview
          ?? (event.message as { preview?: string } | undefined)?.preview
          ?? '';
        this.threadCache.pushMessage(cacheThreadId, {
          uid: event.uid,
          from: fromAddr,
          fromAddr,
          subject: subject ?? '(no subject)',
          preview: typeof previewSource === 'string' ? previewSource : '',
          date: new Date().toISOString(),
        }, {
          subject: normalizeSubject(subject),
          rootFromAddr: fromAddr,
        });
      } catch (err) {
        // Cache writes are best-effort — a corrupt entry or
        // read-only fs shouldn't break the wake path.
        this.log('warn', `[dispatcher] thread-cache push failed for "${account.name}" uid=${event.uid}: ${(err as Error).message}`);
      }

      // Cross-type dedup: if the master API just pushed a task event for
      // us (within the suppression window) AND this incoming mail looks
      // like the matching `[RPC] / [Task]` notification, drop it. Without
      // this, every call_agent wakes the recipient TWICE — once for the
      // task event, once for the notification email — and runs the agent
      // through Claude twice per logical RPC.
      if (ch
          && Date.now() < ch.suppressTaskMailUntilMs
          && isTaskNotificationSubject(subject)) {
        this.log('info', `[dispatcher] suppressed task-notification mail wake for "${account.name}" (uid=${event.uid}, subject="${subject}") — task event already dispatched`);
        rememberBounded(ch.seenUids, event.uid);
        this.state.markSeen(account.id, event.uid);
        return;
      }
      if (ch) rememberBounded(ch.seenUids, event.uid);
      // Persist the cursor on every routed UID so a restart sees a
      // monotonic lastSeenUid + the recent-UID window for IDLE
      // dedup. Writes are debounced inside DispatcherState.
      this.state.markSeen(account.id, event.uid);

      // Hard stop: thread closed by the host. Adding `[FINAL]` / `[DONE]`
      // / `[CLOSED]` / `[WRAP]` to a subject tells the dispatcher "we're
      // done here, no more wakes". This is the lightest possible answer
      // to "no native done signal" — works on any mail client, costs
      // zero round trips, and pairs cleanly with the wake-budget
      // circuit breaker below.
      if (isThreadClosedSubject(subject)) {
        this.log('info', `[dispatcher] thread closed (subject="${subject ?? ''}") — skipping wake for "${account.name}" uid=${event.uid}`);
        this.postSkipped(account, event, 'thread-closed', `subject contains a thread-close marker: "${subject ?? ''}"`);
        // Drop the per-thread cache + this agent's memory for the
        // closed thread. Other CC'd agents' memories survive — they
        // will fade naturally on their next wake (no cache to load
        // means just an empty context block; their own memory still
        // helps them decide "no more action needed on this thread").
        try { this.threadCache.delete(cacheThreadId); } catch { /* ignore */ }
        try { this.agentMemory.delete(account.id, cacheThreadId); } catch { /* ignore */ }
        return;
      }

      // Selective-wake allowlist. When the sender included a `wake` list
      // (translated by the API into the `wakeAllowlist` field on the SSE
      // event), only listed agents get a Claude turn. This is the big
      // token-saver on large threads — sender knows who needs to act
      // next, dispatcher trusts it. CC'd-but-not-listed agents still
      // receive the mail in their inbox; they just don't burn a Claude
      // turn deciding "not my turn" and going silent.
      const allowlist = extractWakeAllowlist(event);
      if (!isAgentOnWakeAllowlist(account.name, allowlist)) {
        this.log('info', `[dispatcher] wake allowlist excludes "${account.name}" (list=${JSON.stringify(allowlist)}) — mail delivered, no Claude turn`);
        this.postSkipped(account, event, 'allowlist-excluded', `wake list ${JSON.stringify(allowlist)} did not include "${account.name}"`);
        return;
      }

      // Per-agent wake_on_cc preference. When the recipient
      // registered with `wake_on_cc: false`, any delivery where
      // they were NOT on the To field (i.e. only on Cc/Bcc) is
      // silently dropped from the wake path. This is the "I am
      // a coder; only wake me when explicitly addressed to To"
      // opt-in from the wake-thrash feedback. We require the
      // event to carry an explicit `wasOnTo: true` to fire;
      // ambiguous events (older API versions that don't emit
      // the field) default to firing, preserving back-compat.
      const wakeOnCc = (account as { wakeOnCc?: boolean }).wakeOnCc !== false;
      if (!wakeOnCc) {
        const wasOnTo = (event as { wasOnTo?: boolean }).wasOnTo === true;
        if (!wasOnTo) {
          this.log('info', `[dispatcher] "${account.name}" has wake_on_cc:false and was not on To — mail delivered, no Claude turn (uid=${event.uid})`);
          this.postSkipped(account, event, 'wake-on-cc', `"${account.name}" has wake_on_cc:false; not on To`);
          return;
        }
      }

      // Compute the thread id once; it threads through both the
      // wake-budget check (inside fireCoalescedWake / fireWakeImmediately)
      // and the wake coalescing queue key.
      const threadId = threadIdFromSubject(subject);

      // Wake coalescing — debounce per (account, thread) so a burst
      // of back-to-back replies on the same thread collapses into
      // ONE Claude turn. See `scheduleCoalescedWake` for the design
      // rationale; the feedback that motivated this is documented
      // in CHANGELOG 0.9.0 (wake-thrash on multi-CC threads).
      //
      // We `await` so that when coalescing is disabled
      // (wakeCoalesceMs === 0, the test-mode default) the spawn
      // resolves before handleEvent returns. With coalescing on,
      // schedule returns immediately and the worker fires later
      // via the debounce timer.
      await this.scheduleCoalescedWake(account, event, threadId);
      return;
    }
    if (event.type === 'task' && typeof event.taskId === 'string') {
      // Task events broadcast to all watchers — only act if WE are the assignee.
      if (typeof event.assignee === 'string'
          && event.assignee.toLowerCase() !== account.name.toLowerCase()) return;
      const ch = this.channels.get(account.id);
      if (ch?.seenTaskIds.has(event.taskId)) return;
      if (ch) {
        rememberBounded(ch.seenTaskIds, event.taskId);
        // Open the suppression window for the matching notification mail.
        ch.suppressTaskMailUntilMs = Date.now() + TASK_MAIL_SUPPRESS_WINDOW_MS;
      }
      await this.spawnWorker(account, taskPrompt(account, event), {
        kind: 'task',
        taskId: event.taskId,
        subject: typeof event.task === 'string' ? event.task.slice(0, 120) : undefined,
        from: typeof event.from === 'string' ? event.from : undefined,
      });
      return;
    }
    // Other event types (expunge, flags, connected, error, reconnecting,
    // reconnect_failed, etc.) — ignore.
  }

  /**
   * Should the dispatcher own a wake-channel for this account?
   *
   * We skip the bridge agent (default name "claudecode"). The bridge is
   * the host session's own inbox proxy — when mail lands there, the
   * HOST Claude Code session reads it via MCP (`list_inbox` /
   * `wait_for_email` / `read_email`), NOT via a separately-spawned
   * dispatcher worker. Spawning a worker for the bridge would:
   *   1. Compete with the host (two Claude instances trying to "be"
   *      Claude Code, both potentially replying autonomously).
   *   2. Waste tokens — the host is already aware via its MCP polling.
   *   3. Send the bridge into an autonomous loop if it ever replies-all
   *      (because that mail would wake it again, ad infinitum).
   *
   * Role="bridge" is also skipped for symmetry with selectExposableAgents
   * in install.ts — anything tagged as a bridge is host-managed.
   */
  private shouldWatch(account: AgenticMailAccount): boolean {
    const bridgeName = this.cfg.bridgeAgentName.toLowerCase();
    // (a) This host's own bridge — never watch it; the host's
    //     interactive REPL drives that inbox via UserPromptSubmit /
    //     SessionStart hooks.
    if (account.name.toLowerCase() === bridgeName) return false;
    // (b) ANY account explicitly tagged as a bridge — including OTHER
    //     hosts' bridges. With multiple host integrations co-installed
    //     (e.g. claudecode + codex on the same machine), the codex
    //     dispatcher should NOT wake on mail to the claudecode bridge
    //     inbox — that inbox is owned by Claude Code's REPL.
    if (account.role === 'bridge') return false;
    // (c) Defensive: catch bridges that haven't been migrated to the
    //     role yet. Pre-migration accounts carry the role='assistant'
    //     workaround but ALWAYS have metadata.bridge=true and/or
    //     metadata.host=<hostname>. Either marker is authoritative.
    const meta = account.metadata as { bridge?: unknown; host?: unknown } | undefined;
    if (meta && meta.bridge === true) return false;
    if (meta && typeof meta.host === 'string' && meta.host.length > 0) return false;
    return true;
  }

  /** Re-fetch /accounts; open SSE for new ones, close for vanished ones. */
  private async syncAccounts(): Promise<void> {
    let accounts: AgenticMailAccount[];
    try {
      accounts = await listAccounts(this.cfg.apiUrl, this.cfg.masterKey);
    } catch (err) {
      this.log('warn', `[dispatcher] could not list accounts: ${(err as Error).message}`);
      return;
    }
    // Filter out the bridge — it's host-owned, not dispatcher-owned.
    accounts = accounts.filter(a => this.shouldWatch(a));
    const liveIds = new Set(accounts.map(a => a.id));
    // Close channels for accounts that disappeared. Also drop their
    // persisted cursor so we don't carry dead-agent state forever.
    for (const [id, ch] of this.channels) {
      if (!liveIds.has(id)) {
        ch.stopping = true;
        ch.controller?.abort();
        this.channels.delete(id);
        this.state.forget(id);
        this.caughtUp.delete(id);
        this.log('info', `[dispatcher] account "${ch.account.name}" removed — closed SSE channel`);
      }
    }
    // Open channels for new accounts.
    for (const account of accounts) {
      if (this.channels.has(account.id)) {
        // Refresh stored account metadata in case name/role changed.
        this.channels.get(account.id)!.account = account;
        continue;
      }
      // Restore persisted seenUids so IMAP IDLE re-deliveries of UIDs
      // we already processed pre-restart stay deduped. The Set is
      // bounded by SEEN_CAP anyway, so even a large restore is safe.
      const persistedCursor = this.state.getCursor(account.id);
      const seenUids = new Set<number>(persistedCursor?.seenUids ?? []);
      const ch: ChannelState = {
        account,
        controller: null,
        stopping: false,
        backoffMs: this.reconnectBaseMs,
        seenUids,
        seenTaskIds: new Set(),
        suppressTaskMailUntilMs: 0,
      };
      this.channels.set(account.id, ch);
      this.log('info', `[dispatcher] opening SSE for "${account.name}" (${account.email})` + (persistedCursor ? ` (restored ${seenUids.size} seen UIDs, lastSeenUid=${persistedCursor.lastSeenUid})` : ''));
      void this.runChannel(ch);
    }
  }

  /**
   * Subscribe to the API's master-scoped system events SSE.
   *
   * Pushes from /system/events arrive as JSON-per-frame just like the
   * per-account stream:
   *   { type: "connected" }
   *   { type: "account_created", account: { id, name, email, apiKey, ... } }
   *   { type: "account_deleted", accountId, name }
   *
   * On `account_created` we eagerly open a per-account SSE channel using
   * the apiKey carried in the event payload — no extra round trip, the
   * channel is live within milliseconds of the POST /accounts response.
   *
   * Reconnect with the same exponential backoff scheme as per-account
   * channels. If the API is older and doesn't expose /system/events
   * (404), we log once and stop trying — polling-only fallback still
   * works.
   */
  private async runSystemChannel(): Promise<void> {
    let backoff = this.reconnectBaseMs;
    let giveUp = false;
    while (!this.stopped && !giveUp) {
      this.systemChannelController = new AbortController();
      try {
        const url = `${this.cfg.apiUrl.replace(/\/$/, '')}/api/agenticmail/system/events`;
        const res = await this.fetchImpl(url, {
          headers: {
            'Authorization': `Bearer ${this.cfg.masterKey}`,
            'Accept': 'text/event-stream',
          },
          signal: this.systemChannelController.signal,
        });
        if (res.status === 404) {
          this.log('warn', '[dispatcher] /system/events not available on this API — falling back to polling-only account discovery (please upgrade @agenticmail/api to >=0.7.3)');
          giveUp = true;
          break;
        }
        if (!res.ok || !res.body) {
          throw new Error(`system/events HTTP ${res.status}`);
        }
        backoff = this.reconnectBaseMs; // healthy stream — reset backoff
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(line.slice(6));
                this.handleSystemEvent(event);
              } catch { /* skip malformed frame */ }
            }
          }
        }
      } catch (err) {
        if (this.stopped) break;
        this.log('warn', `[dispatcher] system-events stream error: ${(err as Error).message}; reconnecting in ${backoff}ms`);
      }
      if (this.stopped || giveUp) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, this.reconnectMaxMs);
    }
  }

  /** Apply an account-lifecycle event from /system/events. */
  private handleSystemEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'account_created' && event.account && typeof event.account === 'object') {
      const account = event.account as AgenticMailAccount;
      if (!account.id || !account.name || !account.apiKey) {
        this.log('warn', '[dispatcher] account_created event missing required fields; ignoring');
        return;
      }
      if (!this.shouldWatch(account)) {
        this.log('info', `[dispatcher] account_created "${account.name}" — skipping (bridge/role excluded)`);
        return;
      }
      if (this.channels.has(account.id)) return; // already watching
      const ch: ChannelState = {
        account,
        controller: null,
        stopping: false,
        backoffMs: this.reconnectBaseMs,
        seenUids: new Set(),
        seenTaskIds: new Set(),
        suppressTaskMailUntilMs: 0,
      };
      this.channels.set(account.id, ch);
      this.log('info', `[dispatcher] account_created "${account.name}" (${account.email}) — opening SSE channel immediately`);
      void this.runChannel(ch);
      return;
    }
    if (type === 'account_deleted' && typeof event.accountId === 'string') {
      const ch = this.channels.get(event.accountId);
      if (!ch) return;
      ch.stopping = true;
      try { ch.controller?.abort(); } catch { /* ignore */ }
      this.channels.delete(event.accountId);
      this.log('info', `[dispatcher] account_deleted "${ch.account.name}" — closed SSE channel`);
      return;
    }
    // type === 'connected' or unknown — no action
  }

  /** Watch one account's SSE stream forever; reconnect with backoff on drop. */
  private async runChannel(ch: ChannelState): Promise<void> {
    while (!ch.stopping && !this.stopped) {
      try {
        ch.controller = new AbortController();
        await this.streamOne(ch);
        if (!ch.stopping) {
          this.log('warn', `[dispatcher] SSE for "${ch.account.name}" ended unexpectedly; reconnecting in ${ch.backoffMs}ms`);
        }
      } catch (err) {
        if (ch.stopping) break;
        this.log('warn', `[dispatcher] SSE error for "${ch.account.name}": ${(err as Error).message}; reconnecting in ${ch.backoffMs}ms`);
      }
      if (ch.stopping) break;
      await sleep(ch.backoffMs);
      ch.backoffMs = Math.min(ch.backoffMs * 2, this.reconnectMaxMs);
    }
  }

  /**
   * One-shot backlog scan after a (re)connect: route unprocessed mail
   * + pending tasks that arrived while the dispatcher was unreachable.
   *
   * Mail path: pull the newest 50 envelopes from `/mail/inbox`. For
   * each UID strictly greater than the persisted `lastSeenUid` (and
   * not already in the channel's `seenUids`), synthesise an SSE
   * `new` event and hand it to `handleEvent`. The wake-budget
   * circuit breaker still applies, so a runaway thread that hit
   * the cap pre-restart STAYS muted — restart isn't a free reset.
   *
   * Tasks path: fetch `/tasks/pending`. Anything not in the
   * channel's `seenTaskIds` becomes a synthetic task SSE event.
   *
   * Failures here are NEVER fatal — they're "best effort". The
   * dispatcher continues processing live SSE traffic regardless.
   */
  private async runCatchUp(ch: ChannelState): Promise<void> {
    const account = ch.account;
    // ── Mail backlog ─────────────────────────────────────────────
    try {
      const envelopes = await listInboxForAgent(this.cfg.apiUrl, account.apiKey, { limit: 50 });
      const cursor = this.state.getCursor(account.id);
      // FIRST-RUN SAFETY: if we have no persisted cursor yet (fresh
      // install / first upgrade to 0.9.8 / state file deleted), do NOT
      // replay everything in the inbox as "missed mail" — that would
      // burn through the wake budget and spam every agent. Seed the
      // cursor with the current max UID instead, so we only wake on
      // mail that arrives AFTER this point. Live SSE traffic is the
      // source of truth from here forward.
      if (!cursor) {
        if (envelopes.length > 0) {
          let maxUid = 0;
          for (const e of envelopes) {
            if (Number.isFinite(e.uid) && e.uid > 0) {
              ch.seenUids.add(e.uid);
              if (e.uid > maxUid) maxUid = e.uid;
            }
          }
          if (maxUid > 0) this.state.markSeen(account.id, maxUid);
          this.log('info', `[dispatcher] catch-up for "${account.name}": first run, seeded cursor at uid=${maxUid} (skipping ${envelopes.length} pre-existing messages)`);
        }
      } else {
        const lastSeenUid = cursor.lastSeenUid;
        // Replay in ascending UID order so the wake-budget / coalesce
        // queue sees the same temporal shape it would have if the
        // events had streamed in live.
        const sorted = envelopes
          .filter(e => Number.isFinite(e.uid) && e.uid > lastSeenUid && !ch.seenUids.has(e.uid))
          .sort((a, b) => a.uid - b.uid);
        if (sorted.length > 0) {
          this.log('info', `[dispatcher] catch-up for "${account.name}": replaying ${sorted.length} unprocessed UIDs (lastSeenUid=${lastSeenUid})`);
          for (const env of sorted) {
            const event: SSEEvent = {
              type: 'new',
              uid: env.uid,
              subject: env.subject,
              // Format `from` to match what extractFrom expects
              // (top-level string OR nested under message). Use the
              // first sender's address — that's what the live SSE
              // path delivers.
              from: env.from?.[0]?.address,
              message: {
                subject: env.subject,
                from: env.from,
                to: env.to,
              },
            };
            // handleEvent itself dedupes via seenUids (which we just
            // restored) so duplicate replays are no-ops.
            await this.handleEvent(account, event);
          }
        }
      }
    } catch (err) {
      this.log('warn', `[dispatcher] catch-up mail scan failed for "${account.name}": ${(err as Error).message}`);
    }
    // ── Pending task backlog ──────────────────────────────────────
    try {
      const tasks = await listPendingTasksForAgent(this.cfg.apiUrl, account.apiKey);
      const fresh = tasks.filter(t => t.id && !ch.seenTaskIds.has(t.id));
      if (fresh.length > 0) {
        this.log('info', `[dispatcher] catch-up for "${account.name}": replaying ${fresh.length} pending tasks`);
        for (const t of fresh) {
          const event: SSEEvent = {
            type: 'task',
            taskId: t.id,
            taskType: t.task_type ?? t.type,
            task: t.description ?? t.task ?? '',
            assignee: account.name,
          };
          await this.handleEvent(account, event);
        }
      }
    } catch (err) {
      this.log('warn', `[dispatcher] catch-up task scan failed for "${account.name}": ${(err as Error).message}`);
    }
  }

  /** Single SSE attach. Returns when the stream closes for any reason. */
  private async streamOne(ch: ChannelState): Promise<void> {
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}/api/agenticmail/events`;
    const res = await this.fetchImpl(url, {
      headers: {
        'Authorization': `Bearer ${ch.account.apiKey}`,
        'Accept': 'text/event-stream',
      },
      signal: ch.controller!.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE handshake HTTP ${res.status}`);
    }
    // Reset backoff once we have a healthy stream.
    ch.backoffMs = this.reconnectBaseMs;

    // Restart-recovery: on FIRST successful connect for this channel
    // since dispatcher start, scan for backlog. The SSE stream only
    // delivers IDLE-relayed events from this point forward, so
    // anything that arrived during the dispatcher's downtime has to
    // be discovered explicitly. We fire-and-forget so a slow inbox
    // doesn't delay event routing.
    if (!this.caughtUp.has(ch.account.id) && !this.disableCatchupScan) {
      this.caughtUp.add(ch.account.id);
      void this.runCatchUp(ch).catch(err =>
        this.log('warn', `[dispatcher] catch-up scan failed for "${ch.account.name}": ${(err as Error).message}`)
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!ch.stopping) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE framing: events separated by \n\n; each event is one-or-more
      // lines, of which the "data: …" lines hold our payload.
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let event: SSEEvent;
          try { event = JSON.parse(line.slice(6)) as SSEEvent; } catch { continue; }
          // Route in the background — don't block the SSE reader.
          this.handleEvent(ch.account, event).catch(err =>
            this.log('error', `[dispatcher] handleEvent threw for "${ch.account.name}": ${err}`)
          );
        }
      }
    }
  }

  /**
   * Enqueue (or extend) a wake for `(account, thread)`. First
   * event creates the entry + starts the debounce timer; every
   * subsequent event within the window APPENDS to the event
   * list and EXTENDS the timer to `now + wakeCoalesceMs`.
   *
   * When the timer fires, `fireCoalescedWake` synthesises a
   * single wake prompt covering every event that arrived in
   * the burst and spawns one worker. The wake-budget is
   * charged ONCE for the batch (a burst of 4 replies is one
   * logical handoff, not four).
   *
   * When `wakeCoalesceMs` is 0 (test mode / opt-out), we skip
   * the queue and spawn immediately to keep the pre-0.9.0
   * one-event-per-wake semantics.
   */
  private async scheduleCoalescedWake(account: AgenticMailAccount, event: SSEEvent, threadId: string): Promise<void> {
    if (this.wakeCoalesceMs <= 0) {
      await this.fireWakeImmediately(account, event, threadId);
      return;
    }
    const key = `${account.id}::${threadId}`;
    const existing = this.wakeCoalesce.get(key);
    if (!existing) {
      // FIRST event for this (agent, thread) — fire immediately
      // (leading-edge). Set a sentinel entry with an empty event
      // list + a debounce timer; any subsequent events that
      // arrive within the window get queued onto the entry and
      // fire as a coalesced batch when the timer expires. This
      // gives lone replies zero perceived latency while still
      // collapsing bursts into one extra wake (so 4 quick
      // replies = first one fires immediately + one coalesced
      // catch-up wake at the trailing edge, not 4 separate
      // wakes).
      const entry = {
        events: [] as SSEEvent[],         // empty — first event already fired
        account,
        threadId,
        firstScheduledAt: this.now(),
        timer: setTimeout(() => this.fireCoalescedWake(key), this.wakeCoalesceMs),
      };
      (entry.timer as unknown as { unref?: () => void }).unref?.();
      this.wakeCoalesce.set(key, entry);
      await this.fireWakeImmediately(account, event, threadId);
      return;
    }
    // Subsequent event within the window — append + extend timer.
    clearTimeout(existing.timer);
    existing.events.push(event);
    this.postActivity('/dispatcher/worker-queued', {
      agentName: account.name,
      agentId: account.id,
      threadId,
      queuedCount: existing.events.length,
      fireAtMs: this.now() + this.wakeCoalesceMs,
      reason: 'coalescing subsequent burst events',
    });
    existing.timer = setTimeout(() => this.fireCoalescedWake(key), this.wakeCoalesceMs);
    (existing.timer as unknown as { unref?: () => void }).unref?.();
    // Hard cap on debounce extension — a continuous reply stream
    // could hold the batch open forever. After 5× the window from
    // the first event, force the timer to fire.
    const elapsedFromFirst = this.now() - existing.firstScheduledAt;
    if (elapsedFromFirst > this.wakeCoalesceMs * 5) {
      clearTimeout(existing.timer);
      this.fireCoalescedWake(key);
    }
  }

  /**
   * Pre-0.9.0 fast path used when coalescing is disabled. Same
   * spawn that scheduleCoalescedWake/fireCoalescedWake would do
   * for a single-event batch.
   */
  private async fireWakeImmediately(account: AgenticMailAccount, event: SSEEvent, threadId: string): Promise<void> {
    const verdict = this.chargeWake(account.id, threadId);
    if (!verdict.ok) {
      this.log(
        'warn',
        `[dispatcher] wake-budget exhausted for "${account.name}" on thread "${threadId}" — ` +
          `dropped uid=${event.uid} (cap=${this.maxWakesPerThread} per ${Math.round(this.wakeWindowMs / 60000)}min; ` +
          `raise with AGENTICMAIL_DISPATCHER_MAX_WAKES_PER_THREAD env var, or via ~/.agenticmail/dispatcher.json)`,
      );
      this.postSkipped(account, event, 'budget-exhausted', `wake budget exhausted for thread "${threadId}" (count=${verdict.count}, cap=${this.maxWakesPerThread})`);
      return;
    }
    await this.spawnWorker(account, newMailPrompt(account, event), {
      kind: 'new-mail',
      uid: event.uid,
      subject: extractSubject(event),
      from: extractFrom(event),
    });
  }

  /**
   * Timer callback for the coalesced wake. Builds a single wake
   * prompt that summarises every event in the batch and fires
   * one worker. Wake budget is charged once for the batch.
   */
  private fireCoalescedWake(key: string): void {
    const entry = this.wakeCoalesce.get(key);
    if (!entry) return;
    this.wakeCoalesce.delete(key);
    if (this.stopped) return;
    // Sentinel-only case: the leading-edge wake already fired for this
    // (agent, thread) and no follow-up events arrived inside the debounce
    // window. The timer is just here to clean up the sentinel; there is
    // nothing to coalesce. Bail out before charging wake budget or
    // building a prompt — otherwise newMailPromptForBatch would dereference
    // events[-1] and throw. See scheduleCoalescedWake() leading-edge path.
    if (entry.events.length === 0) return;
    const verdict = this.chargeWake(entry.account.id, entry.threadId);
    if (!verdict.ok) {
      this.log('warn', `[dispatcher] wake-budget exhausted for "${entry.account.name}" on thread "${entry.threadId}" — dropped batch of ${entry.events.length}`);
      return;
    }
    const lastEvent = entry.events[entry.events.length - 1];
    const prompt = entry.events.length === 1
      ? newMailPrompt(entry.account, lastEvent)
      : newMailPromptForBatch(entry.account, entry.events);
    if (entry.events.length > 1) {
      this.log('info', `[dispatcher] coalesced ${entry.events.length} wakes into one Claude turn for "${entry.account.name}" on thread "${entry.threadId}"`);
    }
    void this.spawnWorker(entry.account, prompt, {
      kind: 'new-mail',
      uid: lastEvent.uid,
      subject: extractSubject(lastEvent),
      from: extractFrom(lastEvent),
    });
  }

  /**
   * Prepend the thread-context block (cache + memory) to the
   * wake prompt for a given account. Returns the prompt
   * unchanged when neither layer has content — the very first
   * wake on a brand-new thread shouldn't show the agent an
   * empty "Thread context" section that screams "you've seen
   * this before" when there's nothing to see.
   *
   * Exposed as a separate method so tests can drive it
   * directly without invoking the SDK.
   */
  composeWakePromptWithContext(
    account: AgenticMailAccount,
    ctx: { kind: string; subject?: string; uid?: number },
    prompt: string,
  ): string {
    if (ctx.kind !== 'new-mail' && ctx.kind !== 'task') return prompt;
    const t = threadIdFor({ subject: ctx.subject });
    let cacheBlock = '';
    let memoryBlock = '';
    try {
      const entry = this.threadCache.read(t);
      // Exclude the current message from the cache view — the agent
      // sees it explicitly in the "NEW event" section below, no
      // point repeating it under "Facts". The thread cache push
      // happens BEFORE wake decisions are made (so other CC'd
      // agents benefit even when we skip), which means by the time
      // we render the prompt, the current message is already in
      // the cache.
      if (entry) {
        const filtered = ctx.uid
          ? { ...entry, messages: entry.messages.filter(m => m.uid !== ctx.uid) }
          : entry;
        cacheBlock = filtered.messages.length > 0
          ? this.threadCache.renderForPrompt(filtered)
          : '';
      }
    } catch { /* tolerate corrupt cache */ }
    try {
      memoryBlock = this.agentMemory.renderForPrompt(this.agentMemory.read(account.id, t));
    } catch { /* tolerate missing memory */ }
    if (!cacheBlock && !memoryBlock) return prompt;
    const sections: string[] = [
      '## Thread context',
      '',
      'You have seen this thread before. The two blocks below are',
      "your shortcut to context — DO NOT re-read every prior message",
      'on this thread. Read only the NEW event at the bottom of this',
      'prompt and decide based on these blocks plus that event.',
      '',
    ];
    if (cacheBlock) {
      sections.push('### Facts (last messages on this thread, newest first)');
      sections.push(cacheBlock);
      sections.push('');
    }
    if (memoryBlock) {
      sections.push('### Your own memory of this thread');
      sections.push(memoryBlock);
      sections.push('');
    }
    sections.push('## NEW event');
    sections.push('');
    sections.push(prompt);
    sections.push('');
    sections.push('---');
    sections.push('At end of turn, call `save_thread_memory` with `threadId`,');
    sections.push('a one-paragraph `summary` of where the thread stands, your');
    sections.push('current `commitments`, any `openQuestions`, your `lastAction`,');
    sections.push('and the newest `lastUid` you have digested. Future wakes on');
    sections.push('this thread will load that memory into context for you.');
    return sections.join('\n');
  }

  /** Acquire a concurrency slot, run a worker, release the slot. */
  private async spawnWorker(account: AgenticMailAccount, prompt: string, ctx: { kind: string; uid?: number; taskId?: string; subject?: string; from?: string }): Promise<void> {
    // Per-agent serialization gate. If another worker is mid-flight
    // for the SAME agent, this await chains onto its tail and we
    // resume after it finishes. Prevents two simultaneous Vesper
    // workers from racing on the same IMAP connection, the same
    // thread cache, and the same agent memory file. The gate fires
    // BEFORE the global concurrency slot acquisition so the slot
    // budget is only paid by workers that will actually run now.
    const releaseAgentLock = await this.acquireAgentSerial(account.id);
    await this.acquireSlot();
    // Generate a stable id BEFORE the try so the finally block can
    // post a matching finished event even if persona load throws.
    const workerId = `${account.id}:${ctx.kind}:${ctx.uid ?? ctx.taskId ?? ''}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let workerResult: { ok: true; text: string } | { ok: false; error: string } | null = null;
    // Push "started" — host can now see this agent is working via
    // `check_activity` or wait_for_email on /system/events. We fire
    // and forget; never let observer failures block worker spawn.
    this.postActivity('/dispatcher/worker-started', {
      workerId,
      agentName: account.name,
      agentEmail: account.email,
      kind: ctx.kind,
      trigger: { uid: ctx.uid, taskId: ctx.taskId, subject: ctx.subject, from: ctx.from },
    });

    // ─── Per-worker log file ─────────────────────────────────────
    // Every SDK message (tool call, tool result, assistant chunk)
    // gets a one-liner appended here, so the host can tail what a
    // long-running worker is actually doing via tail_worker / GET
    // /dispatcher/worker-log/<id>. Append-only, never rotated by us
    // — workers are short-lived in the median case, and the active-
    // log path is bounded by the registry size.
    const logsDir = join(homedir(), '.agenticmail', 'worker-logs');
    try { mkdirSync(logsDir, { recursive: true }); } catch { /* best-effort */ }
    const logPath = join(logsDir, `${sanitizeId(workerId)}.log`);
    let logStream: WriteStream | null = null;
    try { logStream = createWriteStream(logPath, { flags: 'a' }); } catch { /* fail-soft */ }
    const writeLog = (line: string) => {
      try { logStream?.write(`[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
    };
    writeLog(`worker_started agent=${account.name} kind=${ctx.kind}${ctx.uid ? ' uid=' + ctx.uid : ''}${ctx.taskId ? ' task=' + ctx.taskId : ''}`);

    // ─── Per-worker scratch cwd ─────────────────────────────────
    // Two parallel workers running the same Bash one-liner against
    // the same project would clobber each other's output files.
    // Each worker gets its own scratch dir, advertised via the SDK's
    // `cwd` option. Cleaned up after the worker finishes.
    const cwdDir = join(homedir(), '.agenticmail', 'worker-cwds', sanitizeId(workerId));
    try { mkdirSync(cwdDir, { recursive: true }); } catch { /* fail-soft */ }

    // ─── Observer + heartbeat ───────────────────────────────────
    // The observer feeds the log file; the heartbeat ticker
    // tells the API "this worker is still alive, here is the last
    // thing it did". Heartbeats let `check_activity` show real
    // progress instead of an opaque "still running" for hours.
    let turnCount = 0;
    let lastTool = '';
    let lastUsage: string | undefined;
    /**
     * UIDs the worker explicitly consumed via `read_email` during
     * this turn. At end of turn we use this to dedupe the
     * dispatcher's coalesce queue: if the worker proactively
     * read mail UID 43 while running, the queued wake for 43
     * (which arrived as an SSE event mid-turn) is dropped — the
     * agent already handled it. Without this, the agent would
     * spawn again and re-process the same mail.
     *
     * We also seed the channel's `seenUids` from this set so a
     * subsequent SSE replay (e.g. IMAP IDLE reconnect) of the
     * same UID stays deduped.
     */
    const digestedUids = new Set<number>();
    const observer: WorkerObserver = {
      onMessage: (tag, summary) => {
        writeLog(`${tag} ${summary}`);
        if (tag === 'tool_use') {
          lastTool = summary.split(' ')[0];
          turnCount++;
          // Detect explicit consumption of a mail UID. Tool
          // tracking is by string-match on the dispatcher log
          // line; brittle in theory, but the read_email tool
          // input shape (`{"uid":<n>,"_account":"..."}`) has
          // been stable across the entire 0.x line. If the MCP
          // tool name ever changes, this regex needs updating
          // — captured here in one place rather than scattered.
          const m = /read_email\b[^}]*"uid"\s*:\s*(\d+)/.exec(summary);
          if (m) {
            const uid = parseInt(m[1], 10);
            if (Number.isFinite(uid) && uid > 0) digestedUids.add(uid);
          }
        }
        // Hold onto the latest usage line so the worker-finished
        // event can forward it to check_activity.
        if (tag === 'usage') lastUsage = summary;
      },
    };
    const heartbeatHandle = setInterval(() => {
      this.postActivity('/dispatcher/worker-heartbeat', {
        workerId,
        agentName: account.name,
        lastTool: lastTool || undefined,
        turnCount,
      });
    }, 30_000);
    // Don't keep the process alive just for heartbeats.
    (heartbeatHandle as unknown as { unref?: () => void }).unref?.();

    try {
      const { body } = loadPersonaForAgent({
        agent: account,
        agentsDir: this.cfg.agentsDir,
        subagentPrefix: this.cfg.subagentPrefix,
        mcpServerName: this.cfg.mcpServerName,
      });
      this.log('info', `[dispatcher] waking "${account.name}" — ${ctx.kind}${ctx.taskId ? ' ' + ctx.taskId : ctx.uid ? ' uid=' + ctx.uid : ''}`);
      const mcpEnv = await this.buildMcpEnv();
      // Prepend Layer 1 (thread cache) + Layer 2 (per-agent memory)
      // context blocks to the wake prompt so the worker doesn't have
      // to re-derive thread history from scratch on every wake. See
      // packages/core/src/threading/ for the layered design. The
      // composer is null-safe — when both layers are empty (cold-
      // start, first wake on a brand-new thread), the prompt falls
      // through unchanged.
      const composedPrompt = this.composeWakePromptWithContext(account, ctx, prompt);
      workerResult = await runWorkerWithCompaction(
        this.query,
        body,
        composedPrompt,
        account,
        this.cfg.mcpServerName,
        this.cfg.mcpCommand,
        this.cfg.mcpArgs,
        mcpEnv,
        this.log,
        observer,
        cwdDir,
      );
    } finally {
      clearInterval(heartbeatHandle);
      this.releaseSlot();
      // Dedupe the coalesce queue against UIDs the worker just
      // explicitly handled. If Vesper proactively `read_email`'d
      // UID 43 while running and a wake for UID 43 was queued
      // mid-turn, drop it — spawning again would have her re-read
      // her own already-actioned mail.
      //
      // Also seed the channel's seenUids so a future SSE replay
      // for the same UID (IMAP IDLE reconnect, push retry) stays
      // deduped without firing a fresh worker.
      if (digestedUids.size > 0) {
        const prefix = `${account.id}::`;
        for (const [key, entry] of this.wakeCoalesce.entries()) {
          if (!key.startsWith(prefix)) continue;
          const before = entry.events.length;
          entry.events = entry.events.filter(e => !(typeof e.uid === 'number' && digestedUids.has(e.uid)));
          if (entry.events.length < before) {
            this.log('info', `[dispatcher] dropped ${before - entry.events.length} queued wake(s) for "${account.name}" — UIDs already digested this turn`);
          }
          if (entry.events.length === 0) {
            try { clearTimeout(entry.timer); } catch { /* ignore */ }
            this.wakeCoalesce.delete(key);
          }
        }
        const ch = this.channels.get(account.id);
        if (ch) {
          for (const uid of digestedUids) {
            rememberBounded(ch.seenUids, uid);
            this.state.markSeen(account.id, uid);
          }
        }
      }
      // Release the per-agent serial lock so any remaining queued
      // wakes for this agent (true new mail that did NOT get
      // digested during the run) can spawn next. CRITICAL that
      // this happens in `finally` — a thrown spawn must not leave
      // the agent permanently locked.
      try { releaseAgentLock(); } catch { /* ignore */ }
      // Always post "finished", even on persona-load / slot errors,
      // so the registry doesn't keep the worker pinned indefinitely.
      const ok = workerResult?.ok === true;
      const preview = workerResult?.ok
        ? workerResult.text
        : (workerResult ? workerResult.error : 'worker did not start');
      writeLog(`worker_finished ok=${ok} chars=${preview.length}`);
      try { logStream?.end(); } catch { /* ignore */ }
      // Best-effort cwd cleanup. We don't block on failure — if the
      // worker wrote a 5GB file the user can delete it manually; we
      // shouldn't crash the dispatcher trying to clean up.
      try { rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.postActivity('/dispatcher/worker-finished', {
        workerId,
        agentName: account.name,
        ok,
        turnCount,
        // Context-budget telemetry: the SDK-reported usage line
        // (input/output/cache tokens + cost). Forwarded so
        // check_activity can show real cost per worker and the
        // cache+memory savings vs pre-0.9.0 become measurable.
        usage: lastUsage,
        resultPreview: typeof preview === 'string' ? preview.slice(0, 240) : undefined,
      });
    }
  }

  /**
   * Fire-and-forget POST to the API's worker-activity endpoints.
   *
   * Failures are swallowed deliberately — the dispatcher must never
   * block worker spawn or interrupt teardown because the API is briefly
   * unreachable. The activity registry is best-effort observability, not
   * load-bearing state.
   */
  private postActivity(path: string, body: Record<string, unknown>): void {
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}/api/agenticmail${path}`;
    try {
      const result = this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.cfg.masterKey}`,
        },
        body: JSON.stringify(body),
      });
      // Defensive against test fetch mocks (vi.fn() returns undefined by
      // default) and any future fetch shim that does not return a Promise.
      // Real fetch always returns a Promise; this guard costs one truthy
      // check at runtime and prevents an "undefined.catch" crash in tests.
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch(() => { /* best-effort */ });
      }
    } catch { /* best-effort — never let observer failures touch spawn flow */ }
  }

  /**
   * Post a "skipped wake" notification with the reason the
   * dispatcher decided not to fire a Claude turn. Surfaced in
   * `check_activity` so the host can see the decision instead
   * of just observing silence ("did my mail land? did the
   * dispatcher skip it? is the dispatcher even alive?").
   *
   * Reasons cover every filter that drops a wake:
   *   - thread-closed       — subject had [FINAL]/[DONE]/[CLOSED]/[WRAP]
   *   - allowlist-excluded  — sender's `wake` list did not include the agent
   *   - wake-on-cc          — agent registered wake_on_cc:false and was on Cc
   *   - dedup               — duplicate UID seen recently
   *   - rpc-suppress        — RPC-notification mail right after a task event
   *   - budget-exhausted    — per-(agent, thread) wake budget hit the cap
   */
  private postSkipped(
    account: AgenticMailAccount,
    event: SSEEvent,
    reason: string,
    detail: string,
  ): void {
    this.postActivity('/dispatcher/worker-skipped', {
      agentId: account.id,
      agentName: account.name,
      uid: event.uid,
      subject: extractSubject(event),
      from: extractFrom(event),
      reason,
      detail,
    });
  }

  /** Build the env block we pass to the worker's MCP server child process. */
  private async buildMcpEnv(): Promise<Record<string, string>> {
    // Master key gives the MCP server everything it needs — including
    // on-demand `_account` resolution via the lazy-cache path. We do NOT
    // pin AGENTICMAIL_ACCOUNT_KEYS_JSON here; letting the MCP server's
    // cache fill itself keeps workers from going stale when accounts
    // change underneath us.
    return {
      AGENTICMAIL_API_URL: this.cfg.apiUrl,
      AGENTICMAIL_MASTER_KEY: this.cfg.masterKey,
      // No AGENTICMAIL_API_KEY: workers should ALWAYS pass `_account`
      // explicitly. Omitting the default key forces that discipline at
      // the MCP-server level (any forgotten `_account` becomes a clear
      // error rather than a silent identity drift).
    };
  }

  private acquireSlot(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Per-agent serialization. At most ONE worker runs for any
   * given agent at a time. When a new wake fires for an agent
   * whose worker is still running, the new wake's spawnWorker
   * waits on the prior worker's tail before proceeding.
   *
   * This is the fix for the "dispatcher crashed when sender
   * broadcast to a 5-CC thread" failure mode: under the old
   * design, 5 emails landing for vesper-on-3-different-threads
   * in the same second spawned 5 simultaneous vesper workers,
   * each opening its own IMAP connection, each calling the
   * SDK, racing on the same inbox cache. With this gate they
   * queue tail-to-head and run sequentially.
   *
   * `nextRun` is a chained promise: each new spawn calls
   * `then()` on the previous tail so the order is preserved.
   * When the chain resolves to a no-op (empty queue), the
   * entry is garbage-collected from the map so memory stays
   * bounded at #active-agents.
   */
  private agentSerial = new Map<string, Promise<unknown>>();
  private async acquireAgentSerial(agentId: string): Promise<() => void> {
    const prev = this.agentSerial.get(agentId);
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.agentSerial.set(agentId, prev ? prev.then(() => next).catch(() => next) : next);
    if (prev) await prev.catch(() => {});  // swallow upstream failures
    return () => {
      release();
      // Best-effort cleanup: if the current tail is the one we
      // just released, drop the entry so the map doesn't grow.
      if (this.agentSerial.get(agentId) === next) this.agentSerial.delete(agentId);
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Filesystem-safe form of a worker id. Worker ids embed `:` and `/`
 * (account id, kind, uid) which are fine for URLs but not for file
 * names on every OS — collapse to `_`.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

/**
 * Lazy-load @openai/codex-sdk and wrap it in a Claude-shaped event stream.
 *
 * The dispatcher's worker event loop (`runWorker`) reads frames in the
 * shape Claude's SDK emits:
 *
 *   { type: 'assistant', message: { content: [ { type: 'text', text } | { type: 'tool_use', name, input } ] } }
 *   { type: 'user',      message: { content: [ { type: 'tool_result', content } ] } }
 *   { type: 'result',    result: <final text>, usage: { input_tokens, output_tokens, ... } }
 *
 * Codex emits a different shape — `ThreadEvent` from `@openai/codex-sdk`:
 *
 *   { type: 'thread.started', thread_id }
 *   { type: 'turn.started' }
 *   { type: 'item.started' | 'item.updated' | 'item.completed', item: ThreadItem }
 *   { type: 'turn.completed', usage: Usage }
 *   { type: 'turn.failed', error }
 *   { type: 'error', message }
 *
 * `ThreadItem` is one of: agent_message, reasoning, command_execution,
 * file_change, mcp_tool_call, web_search, todo_list, error.
 *
 * The adapter below translates Codex events into Claude-shaped frames so
 * the dispatcher's spawnWorker / runWorker / observer pipeline stays
 * untouched. The translation table:
 *
 *   agent_message (completed)     → { assistant: [{ text }] }
 *   mcp_tool_call  (started)      → { assistant: [{ tool_use: mcp__<server>__<tool>, input }] }
 *   mcp_tool_call  (completed/err)→ { user:      [{ tool_result: <content> }] }
 *   command_execution             → { assistant: [{ tool_use: Bash, input: {command} }] }
 *                                 + { user:      [{ tool_result: <aggregated_output> }] }
 *   file_change                   → { assistant: [{ tool_use: Edit, input: {changes} }] }
 *   web_search                    → { assistant: [{ tool_use: WebSearch, input: {query} }] }
 *   reasoning                     → dropped (internal; Claude doesn't surface these either)
 *   todo_list                     → dropped (no Claude equivalent)
 *   turn.completed                → { result: <final_message_text>, usage: <mapped> }
 *
 * The `read_email` UID dedup logic added in 0.9.5 still works: it greps
 * `tool_use` breadcrumbs for `read_email\b[^}]*"uid":<n>`, and the mapped
 * tool_use name `mcp__agenticmail__read_email` matches on the `read_email`
 * substring with the unchanged `input.uid` arg.
 */
function defaultQuery(): QueryFn {
  return (params) => {
    const { prompt, options = {} } = params as {
      prompt: string;
      options?: Record<string, unknown>;
    };

    // System prompt / persona goes BEFORE the user prompt — Codex doesn't
    // have a separate system-message channel for one-off `run()` calls.
    // The persona is markdown and the wake prompt is markdown, so a clean
    // section break keeps both legible to the model.
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${prompt}`
      : prompt;

    const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
    const abortSignal = (() => {
      const ac = (options as { abortController?: AbortController }).abortController;
      return ac instanceof AbortController ? ac.signal : undefined;
    })();

    // Promise of the event source. Lazy so import errors surface on the
    // FIRST consumer pull (matching the Claude adapter's contract).
    let eventsPromise: Promise<AsyncGenerator<unknown>> | null = null;

    async function initEvents(): Promise<AsyncGenerator<unknown>> {
      let sdk: typeof import('@openai/codex-sdk');
      try {
        sdk = await import('@openai/codex-sdk');
      } catch (err) {
        throw new Error(
          `Dispatcher needs @openai/codex-sdk installed (peerDependency), but: ${(err as Error).message}. ` +
          `Run \`npm install -g @openai/codex-sdk\` and retry.`,
        );
      }
      const codex = new sdk.Codex({});
      const thread = codex.startThread({
        workingDirectory: cwd,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
      });
      const streamed = await thread.runStreamed(fullPrompt, {
        signal: abortSignal,
      });
      return adaptCodexEvents(streamed.events);
    }

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!eventsPromise) eventsPromise = initEvents();
            const it = (await eventsPromise);
            const self = this;
            self.next = it.next.bind(it);
            return it.next();
          },
        };
      },
    } as AsyncIterable<unknown>;
  };
}

/**
 * Translate the Codex SDK's typed `ThreadEvent` stream into the loose
 * Claude-shaped frames the dispatcher's runWorker consumes.
 *
 * Stateful only in one tiny way: when an mcp_tool_call FIRST appears
 * (item.started or item.updated with status='in_progress'), we emit the
 * `tool_use` block. When it completes (item.completed with status=
 * 'completed' or 'failed'), we emit the `tool_result` block. We track
 * which item ids we've already announced the tool_use for so we don't
 * double-emit when Codex sends both `started` AND `updated` frames.
 */
async function* adaptCodexEvents(
  events: AsyncGenerator<unknown>,
): AsyncGenerator<unknown> {
  // Track which tool_call ids we've already emitted the opening `tool_use`
  // frame for. Codex sends both `item.started` and `item.completed` for
  // most items; we want the breadcrumb at the FIRST visibility, not twice.
  const toolUseEmitted = new Set<string>();
  let finalMessage = '';

  for await (const raw of events) {
    const ev = raw as { type?: string; item?: Record<string, unknown>; usage?: Record<string, unknown>; error?: { message: string }; message?: string };
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
      const item = ev.item;
      if (!item) continue;
      const itemType = item.type as string | undefined;
      const itemId = (item.id as string | undefined) ?? '';

      if (itemType === 'agent_message') {
        // Only surface on completion — `started`/`updated` may carry
        // partial text we don't want to double-count in collectedText.
        if (ev.type === 'item.completed') {
          const text = (item.text as string | undefined) ?? '';
          if (text) finalMessage = text;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text }] },
          };
        }
        continue;
      }

      if (itemType === 'mcp_tool_call') {
        // First-sight tool_use frame.
        if (!toolUseEmitted.has(itemId)) {
          toolUseEmitted.add(itemId);
          const server = (item.server as string | undefined) ?? 'unknown';
          const tool = (item.tool as string | undefined) ?? 'unknown';
          const args = item.arguments;
          yield {
            type: 'assistant',
            message: {
              content: [{
                type: 'tool_use',
                name: `mcp__${server}__${tool}`,
                input: args ?? {},
              }],
            },
          };
        }
        // tool_result frame on completion.
        if (ev.type === 'item.completed') {
          const status = item.status as string | undefined;
          if (status === 'completed') {
            const result = item.result as { content?: unknown } | undefined;
            yield {
              type: 'user',
              message: {
                content: [{
                  type: 'tool_result',
                  content: result?.content ?? '',
                }],
              },
            };
          } else if (status === 'failed') {
            const err = item.error as { message?: string } | undefined;
            yield {
              type: 'user',
              message: {
                content: [{
                  type: 'tool_result',
                  content: `error: ${err?.message ?? 'unknown'}`,
                }],
              },
            };
          }
        }
        continue;
      }

      if (itemType === 'command_execution' && ev.type === 'item.completed') {
        const command = (item.command as string | undefined) ?? '';
        const output = (item.aggregated_output as string | undefined) ?? '';
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
          },
        };
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: output }] },
        };
        continue;
      }

      if (itemType === 'file_change' && ev.type === 'item.completed') {
        const changes = item.changes as Array<{ path?: string; kind?: string }> | undefined;
        // Translate to a synthetic `Edit` tool_use so dispatcher
        // breadcrumbs surface the affected paths.
        yield {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              name: 'Edit',
              input: { changes: changes ?? [] },
            }],
          },
        };
        continue;
      }

      if (itemType === 'web_search' && ev.type === 'item.completed') {
        const query = (item.query as string | undefined) ?? '';
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'WebSearch', input: { query } }],
          },
        };
        continue;
      }

      if (itemType === 'error' && ev.type === 'item.completed') {
        const message = (item.message as string | undefined) ?? '';
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `[item error] ${message}` }] },
        };
        continue;
      }
      // reasoning / todo_list — drop, no Claude equivalent surfaced today.
      continue;
    }

    if (ev.type === 'turn.completed') {
      const u = (ev.usage ?? {}) as {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
      // Map Codex usage → Claude usage. cache_creation/read split doesn't
      // exist in Codex; we surface input/output and put cached as cache_read.
      yield {
        type: 'result',
        result: finalMessage,
        usage: {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
          cache_read_input_tokens: u.cached_input_tokens ?? 0,
          cache_creation_input_tokens: 0,
        },
      };
      // Codex emits one turn per run; we're done.
      return;
    }

    if (ev.type === 'turn.failed') {
      const err = ev.error;
      yield {
        type: 'result',
        result: `[turn failed] ${err?.message ?? 'unknown error'}`,
        usage: {},
      };
      return;
    }

    if (ev.type === 'error') {
      yield {
        type: 'result',
        result: `[stream error] ${ev.message ?? 'unknown error'}`,
        usage: {},
      };
      return;
    }
    // thread.started / turn.started — drop, no equivalent.
  }
}
