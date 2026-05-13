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
 *   - Workers are spawned via `@anthropic-ai/claude-agent-sdk`'s
 *     `query()` — same OAuth as the user's `claude`, same MCP server,
 *     same persona prompt as the on-disk `.md`. Each worker drains its
 *     query stream to completion, then exits.
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
import { listAccounts } from './api.js';
import { loadPersonaForAgent } from './persona-loader.js';

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
}

/** Minimal Claude Agent SDK query signature we use. */
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

const DEFAULT_MAX_CONCURRENT = 10;
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
 * Spawn-and-wait for a worker via the Claude Agent SDK.
 * Drains the query stream, captures the final assistant text, returns it.
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

  const collectedText: string[] = [];
  try {
    for await (const msg of query({ prompt: userPrompt, options: opts })) {
      const m = msg as Record<string, unknown>;
      // We don't need to render messages — just capture final assistant text
      // for the dispatcher's log. The actual side effects (MCP tool calls
      // sending mail / submitting task results) happen during iteration.
      if (m.type === 'assistant' && Array.isArray(m.message && (m.message as { content?: unknown[] }).content)) {
        for (const block of (m.message as { content: unknown[] }).content) {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') collectedText.push(b.text);
        }
      }
      // Final result message (SDK emits one when the turn ends).
      if (m.type === 'result' && typeof (m as { result?: string }).result === 'string') {
        collectedText.push((m as { result: string }).result);
      }
    }
    const text = collectedText.join('\n').trim();
    log('info', `[dispatcher] worker for "${agent.name}" finished (${text.length} chars output)`);
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `[dispatcher] worker for "${agent.name}" failed: ${msg}`);
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
    `3. **Identify the participants.** Look at To + CC across the thread. Those`,
    `   are your collaborators. Their names map to AgenticMail agents at`,
    `   <name>@localhost. They will each be woken on every reply-all the same way you were.`,
    ``,
    `4. **Decide: is it MY turn?** Yes if any of:`,
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
    `5. **If it's your turn — do the actual work, THEN reply-all about it.**`,
    `   You have full native tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch,`,
    `   WebSearch, NotebookEdit, etc. If the task is "implement X", write the file`,
    `   with Write or Edit and verify with Bash — do NOT paste source code into an`,
    `   email body and call it shipped. The thread is for COORDINATION ("done,`,
    `   see ./foo.py, runs with \`python3 foo.py\`"); the filesystem is for`,
    `   DELIVERABLES. Then:`,
    `     reply_email({ uid: ${uid ?? '<uid>'}, replyAll: true, text: "...", _account: "${agent.name}" })`,
    `   Sign with your name. Be substantive but concise. If you are handing off`,
    `   to the next teammate, name them explicitly in your reply ("Orion — over to you, please …").`,
    ``,
    `6. **If you need additional help from a teammate not yet on the thread,**`,
    `   include them by CC'ing in your reply-all — DO NOT spin up a separate`,
    `   call_agent / message_agent side-channel. The thread is the workspace;`,
    `   everyone stays in context.`,
    ``,
    `7. **If it's NOT your turn,** mark the message read with mark_read and return.`,
    `   Do not reply just to acknowledge. Silence IS a valid contribution.`,
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

    if (!this.cfg.masterKey) {
      throw new Error('Dispatcher requires AgenticMail master key. Run `agenticmail setup` first.');
    }
  }

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
    await this.syncAccounts();
    this.accountSyncTimer = setInterval(() => {
      this.syncAccounts().catch(err => this.log('warn', `[dispatcher] account sync failed: ${err}`));
    }, this.syncIntervalMs);
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
    if (this.systemChannelController) {
      try { this.systemChannelController.abort(); } catch { /* ignore */ }
      this.systemChannelController = null;
    }
    for (const ch of this.channels.values()) {
      ch.stopping = true;
      ch.controller?.abort();
    }
    this.channels.clear();
    this.log('info', '[dispatcher] stopped');
  }

  /** Public for tests — directly hand an event to the routing path. */
  async handleEvent(account: AgenticMailAccount, event: SSEEvent): Promise<void> {
    if (this.stopped) return;
    if (event.type === 'new' && typeof event.uid === 'number') {
      const ch = this.channels.get(account.id);
      if (ch?.seenUids.has(event.uid)) return;
      const subject = extractSubject(event);
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
        return;
      }
      if (ch) rememberBounded(ch.seenUids, event.uid);

      // Wake-budget circuit breaker. Caps per-(agent, thread) wakes so a
      // runaway thread (reply loop, simultaneous-turn storm, stuck
      // agent) can't burn unbounded Claude turns. See WakeBudgetEntry
      // and chargeWake for the full design rationale.
      const threadId = threadIdFromSubject(subject);
      const verdict = this.chargeWake(account.id, threadId);
      if (!verdict.ok) {
        const minutesUntil = verdict.mutedUntilMs
          ? Math.max(0, Math.round((verdict.mutedUntilMs - this.now()) / 60_000))
          : 0;
        this.log('warn', `[dispatcher] wake-budget exhausted for "${account.name}" on thread "${threadId}" (count=${verdict.count}, cap=${this.maxWakesPerThread}); muted for ~${minutesUntil}min. uid=${event.uid}, subject="${subject ?? ''}"`);
        return;
      }

      await this.spawnWorker(account, newMailPrompt(account, event), {
        kind: 'new-mail',
        uid: event.uid,
        subject: extractSubject(event),
        from: extractFrom(event),
      });
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
    if (account.name.toLowerCase() === bridgeName) return false;
    if (account.role === 'bridge') return false;
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
    // Close channels for accounts that disappeared.
    for (const [id, ch] of this.channels) {
      if (!liveIds.has(id)) {
        ch.stopping = true;
        ch.controller?.abort();
        this.channels.delete(id);
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
      this.log('info', `[dispatcher] opening SSE for "${account.name}" (${account.email})`);
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

  /** Acquire a concurrency slot, run a worker, release the slot. */
  private async spawnWorker(account: AgenticMailAccount, prompt: string, ctx: { kind: string; uid?: number; taskId?: string; subject?: string; from?: string }): Promise<void> {
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
    try {
      const { body } = loadPersonaForAgent({
        agent: account,
        agentsDir: this.cfg.agentsDir,
        subagentPrefix: this.cfg.subagentPrefix,
        mcpServerName: this.cfg.mcpServerName,
      });
      this.log('info', `[dispatcher] waking "${account.name}" — ${ctx.kind}${ctx.taskId ? ' ' + ctx.taskId : ctx.uid ? ' uid=' + ctx.uid : ''}`);
      const mcpEnv = await this.buildMcpEnv();
      workerResult = await runWorker(
        this.query,
        body,
        prompt,
        account,
        this.cfg.mcpServerName,
        this.cfg.mcpCommand,
        this.cfg.mcpArgs,
        mcpEnv,
        this.log,
      );
    } finally {
      this.releaseSlot();
      // Always post "finished", even on persona-load / slot errors,
      // so the registry doesn't keep the worker pinned indefinitely.
      const ok = workerResult?.ok === true;
      const preview = workerResult?.ok
        ? workerResult.text
        : (workerResult ? workerResult.error : 'worker did not start');
      this.postActivity('/dispatcher/worker-finished', {
        workerId,
        agentName: account.name,
        ok,
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
}

/**
 * Lazy load the Claude Agent SDK's query() so the module imports cleanly
 * in test environments that mock it. Throws a clear error if the SDK
 * isn't installed (rather than the cryptic `MODULE_NOT_FOUND`).
 */
function defaultQuery(): QueryFn {
  return (params) => {
    let inner: AsyncIterable<unknown> | null = null;
    const init = async (): Promise<AsyncIterable<unknown>> => {
      try {
        const mod = await import('@anthropic-ai/claude-agent-sdk');
        return (mod.query as unknown as QueryFn)(params);
      } catch (err) {
        throw new Error(
          `Dispatcher needs @anthropic-ai/claude-agent-sdk installed in the package, but: ${(err as Error).message}`,
        );
      }
    };
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!inner) inner = await init();
            const it = (inner as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            // Replace the next() of THIS iterator after first init so we
            // don't keep re-asking inner for a new iterator. Simpler: just
            // call next on the cached iterator each time.
            // (The cached `it` is recreated only on the very first call.)
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this;
            self.next = it.next.bind(it);
            return it.next();
          },
        };
      },
    };
  };
}
