/**
 * Dispatcher worker-activity registry.
 *
 * # Why this exists
 *
 * Before this endpoint, the host (Claude Code) had no way to tell what
 * the dispatcher was doing. Send a mail → silence → eventually a reply
 * lands. If the reply takes 30 seconds, the host can't distinguish:
 *
 *   - "Vesper started working, normal think time"
 *   - "the wake fired but the worker is queued behind 9 others"
 *   - "the wake never fired, mail never landed"
 *   - "Vesper is stuck"
 *
 * Auto-acknowledgment emails would pollute the thread and cost a Claude
 * turn per ack. A live activity registry gives richer info with neither
 * cost. The dispatcher already knows who's running — it just needs to
 * tell someone who can answer questions about it. That someone is the
 * API (the dispatcher is a separate process; the API is the central
 * state hub that MCP queries).
 *
 * # Design
 *
 * Push-based: the dispatcher posts a `started` event on `spawnWorker`
 * entry and a `finished` event in the `finally` block. The API keeps
 * an in-memory `Map<workerId, WorkerInfo>`, serves `GET /dispatcher/
 * activity` from it, and broadcasts every event on `/system/events`
 * so push-based consumers don't need to poll.
 *
 * No persistence. If the API restarts, the live registry is empty
 * until the next worker fires. That is correct: workers are
 * dispatcher-owned, and if the dispatcher kept running across an API
 * restart, the next worker event repopulates the registry. The
 * registry has a hard TTL on each entry as defence-in-depth so a
 * crashed dispatcher can't leave orphan entries forever.
 */

import { Router } from 'express';
import { requireMaster } from '../middleware/auth.js';
import { pushSystemEvent } from './system-events.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * One row in the live registry. Mirrors what the dispatcher knows at
 * spawn time — agent identity, what triggered the wake, when it
 * started. `endedAt` and `ok` get filled in by the finished event.
 */
export interface WorkerInfo {
  workerId: string;
  agentName: string;
  agentEmail?: string;
  /** "new-mail" | "task" | something else the dispatcher invented */
  kind: string;
  /** Mail UID for new-mail wakes, taskId for task wakes (best-effort) */
  trigger?: { uid?: number; taskId?: string; subject?: string; from?: string };
  startedAtMs: number;
  /** Filled in by the finished event. */
  endedAtMs?: number;
  /** True if the worker exited cleanly, false if it threw. */
  ok?: boolean;
  /** Optional short message from the worker (final assistant text head). */
  resultPreview?: string;
  /** ms timestamp of last heartbeat from the dispatcher. Updated by the
   *  worker-heartbeat endpoint and by worker-finished. Read by the
   *  activity endpoint to compute a `stale` flag without ever auto-
   *  evicting long-running workers from the registry. */
  lastHeartbeatMs?: number;
  /** Most recent tool the worker invoked (e.g. "Bash", "Read",
   *  "mcp__agenticmail__reply_email"). For "what is it doing right
   *  now?" visibility. */
  lastTool?: string;
  /** How many tool calls the worker has made so far. Cheap progress
   *  signal — a worker that's bumping this every minute is making
   *  progress; one whose count is frozen for 10 minutes is stuck. */
  turnCount?: number;
  /** SDK-reported context-budget summary from the worker's final
   *  result message: `in=… out=… cacheR=… cacheW=… cost=$…`.
   *  Surfaced in `check_activity` so the layered wake-context's
   *  cache+memory savings show up as concrete numbers. */
  usage?: string;
}

/**
 * Heartbeat staleness threshold. A worker that hasn't checked in for
 * this long gets `stale: true` in `check_activity` output. We do NOT
 * auto-evict — workers are explicitly allowed to run for hours and
 * the host should still see them in the registry. Stale just means
 * "the dispatcher hasn't pinged in a bit, double-check it's alive".
 */
const STALE_HEARTBEAT_MS = 90 * 1000;

/**
 * Soft TTL for FINISHED entries. We keep them around briefly so the
 * host can see "Vesper just finished 4s ago — here's what she said"
 * without having to be already waiting on the SSE stream when the
 * event fired. Pruned at the head of every read.
 */
const RECENT_TTL_MS = 2 * 60 * 1000;

/** Cap so the registry can't grow unbounded between prunes. */
const HARD_CAP = 256;

const active = new Map<string, WorkerInfo>();
const recent = new Map<string, WorkerInfo>();

function prune(nowMs: number): void {
  // NB: we deliberately do NOT auto-evict long-running workers from
  // `active` here any more (the old 30-minute TTL was wrong — workers
  // should be allowed to run for hours / overnight). Stuck-worker
  // detection is now heartbeat-based: see the `stale` flag on the
  // activity endpoint. The only `active` eviction path left is the
  // hard cap below, which only ever triggers under absurd fan-out.
  for (const [id, w] of recent) {
    const t = w.endedAtMs ?? w.startedAtMs;
    if (nowMs - t > RECENT_TTL_MS) recent.delete(id);
  }
  while (active.size > HARD_CAP) {
    const first = active.keys().next().value;
    if (!first) break;
    active.delete(first);
  }
  while (recent.size > HARD_CAP) {
    const first = recent.keys().next().value;
    if (!first) break;
    recent.delete(first);
  }
}

/** Test-only hook to clear state between assertions. */
export function _resetActivityRegistry(): void {
  active.clear();
  recent.clear();
  skipped.length = 0;
  processState = null;
}

/**
 * Ring buffer of "skipped wake" events — the dispatcher decided
 * NOT to fire a Claude turn for some reason (thread closed,
 * allowlist excluded, wake_on_cc honoured, budget exhausted,
 * dedup, rpc-suppress). Surfaced in check_activity so the host
 * sees the dispatcher's filter decisions instead of staring at
 * silence wondering "did my mail land? did it crash?"
 */
interface SkippedWake {
  agentId?: string;
  agentName: string;
  uid?: number;
  subject?: string;
  from?: string;
  reason: string;
  detail?: string;
  atMs: number;
}
const skipped: SkippedWake[] = [];
const SKIPPED_CAP = 100;       // ring buffer size
const SKIPPED_TTL_MS = 5 * 60 * 1000;  // 5 minutes — only show recent skips

/**
 * Dispatcher process health snapshot. Updated on every
 * /dispatcher/process-heartbeat post. The age of `atMs` is
 * how the host detects "dispatcher is alive" vs "dispatcher
 * is dead/hung" — a process-heartbeat older than 90 s means
 * the dispatcher process is unhealthy.
 */
interface ProcessState {
  startedAtMs: number;
  channels: number;
  coalesceQueueSize: number;
  running: number;
  maxConcurrent: number;
  atMs: number;
}
let processState: ProcessState | null = null;

/**
 * Optional injectables for the dispatcher routes. The escalation
 * handler uses `gatewayManager` + `accountManager` to forward bridge-
 * mail digests to the operator's email when no host session can be
 * resumed. Both are optional so existing callers (tests, custom
 * embeddings) keep working without them — the route degrades to
 * "system event only" when the deps aren't wired.
 */
export interface DispatcherActivityRoutesDeps {
  gatewayManager?: { routeOutbound: (agentName: string, mail: Record<string, unknown>) => Promise<unknown> };
  accountManager?: { getByName: (name: string) => Promise<{ id: string; name: string; email: string } | null> };
}

export function createDispatcherActivityRoutes(deps: DispatcherActivityRoutesDeps = {}): Router {
  const router = Router();

  /** Dispatcher → API: a worker just started. */
  router.post('/dispatcher/worker-started', requireMaster, (req, res) => {
    const body = req.body ?? {};
    if (typeof body.workerId !== 'string' || typeof body.agentName !== 'string') {
      res.status(400).json({ error: 'workerId and agentName are required' });
      return;
    }
    const info: WorkerInfo = {
      workerId: body.workerId,
      agentName: body.agentName,
      agentEmail: typeof body.agentEmail === 'string' ? body.agentEmail : undefined,
      kind: typeof body.kind === 'string' ? body.kind : 'unknown',
      trigger: body.trigger && typeof body.trigger === 'object' ? body.trigger : undefined,
      startedAtMs: Date.now(),
      lastHeartbeatMs: Date.now(),
      turnCount: 0,
    };
    prune(info.startedAtMs);
    active.set(info.workerId, info);
    // Fan out to /system/events listeners so push-based consumers (the
    // host's wait_for_email, future dashboards) don't need to poll.
    try {
      pushSystemEvent({
        type: 'worker_started',
        worker: { ...info },
      });
    } catch { /* listener failures must not block the dispatcher */ }
    res.status(201).json({ ok: true });
  });

  /** Dispatcher → API: a worker just finished (cleanly or with an error). */
  router.post('/dispatcher/worker-finished', requireMaster, (req, res) => {
    const body = req.body ?? {};
    if (typeof body.workerId !== 'string') {
      res.status(400).json({ error: 'workerId is required' });
      return;
    }
    const existing = active.get(body.workerId);
    const nowMs = Date.now();
    const info: WorkerInfo = {
      ...(existing ?? {
        workerId: body.workerId,
        agentName: typeof body.agentName === 'string' ? body.agentName : 'unknown',
        kind: 'unknown',
        startedAtMs: nowMs,
      }),
      endedAtMs: nowMs,
      ok: body.ok === false ? false : true,
      resultPreview: typeof body.resultPreview === 'string' ? body.resultPreview.slice(0, 240) : undefined,
      turnCount: typeof body.turnCount === 'number' ? body.turnCount : existing?.turnCount,
      usage: typeof body.usage === 'string' ? body.usage : existing?.usage,
    };
    active.delete(body.workerId);
    recent.set(body.workerId, info);
    prune(nowMs);
    try {
      pushSystemEvent({
        type: 'worker_finished',
        worker: { ...info },
      });
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  /**
   * Dispatcher → API: a worker is still alive, here's its last
   * tool / turn count. Sent every ~30s by the dispatcher. We use
   * these to compute the `stale` flag in the activity response — a
   * worker whose heartbeat hasn't moved in 90s is probably hung
   * (but still kept in the registry so the host can see it).
   */
  router.post('/dispatcher/worker-heartbeat', requireMaster, (req, res) => {
    const body = req.body ?? {};
    if (typeof body.workerId !== 'string') {
      res.status(400).json({ error: 'workerId is required' });
      return;
    }
    const existing = active.get(body.workerId);
    if (!existing) {
      // Heartbeat for an unknown worker — could be a race after
      // worker-finished. Ignore quietly.
      res.json({ ok: true, ignored: 'unknown worker' });
      return;
    }
    existing.lastHeartbeatMs = Date.now();
    if (typeof body.lastTool === 'string') existing.lastTool = body.lastTool;
    if (typeof body.turnCount === 'number') existing.turnCount = body.turnCount;
    // Broadcast the live worker state so the web UI can render
    // real-time activity badges ("vesper editing code", "orion
    // reading mail", etc.) — the 30 s heartbeat cadence sets
    // the badge refresh rate.
    try {
      pushSystemEvent({
        type: 'worker_heartbeat',
        worker: { ...existing },
      });
    } catch { /* listener failures must not block the dispatcher */ }
    res.json({ ok: true });
  });

  /**
   * Host → API: what's happening right now?
   *
   * Returns active workers (currently running) plus recently-finished
   * ones (within the last 2 minutes) so the host can see the state of
   * the world without having to be subscribed to SSE.
   *
   * Each active entry includes a `stale` flag derived from the most
   * recent heartbeat — true means "the dispatcher hasn't pinged this
   * worker in 90s+, it may be stuck". Workers are NOT auto-evicted on
   * staleness; long-running tasks (overnight builds, multi-hour
   * research) should stay visible in the registry until they
   * genuinely finish.
   */
  router.get('/dispatcher/activity', requireMaster, (_req, res) => {
    const nowMs = Date.now();
    prune(nowMs);
    // Trim skipped ring buffer to recent + cap.
    while (skipped.length > 0 && nowMs - skipped[0].atMs > SKIPPED_TTL_MS) skipped.shift();
    while (skipped.length > SKIPPED_CAP) skipped.shift();
    // Process health: dispatcher is "alive" if it heartbeat in
    // the last 90 s, "unhealthy" otherwise. "missing" means we've
    // never seen a heartbeat (dispatcher process not running or
    // pre-0.9.1).
    const processHealth = (() => {
      if (!processState) return { state: 'missing' as const };
      const age = nowMs - processState.atMs;
      const isAlive = age <= 90_000;
      return {
        state: isAlive ? 'alive' as const : 'unhealthy' as const,
        startedAtMs: processState.startedAtMs,
        uptimeMs: nowMs - processState.startedAtMs,
        lastHeartbeatAgeMs: age,
        channels: processState.channels,
        coalesceQueueSize: processState.coalesceQueueSize,
        running: processState.running,
        maxConcurrent: processState.maxConcurrent,
      };
    })();
    res.json({
      now: nowMs,
      dispatcher: processHealth,
      active: Array.from(active.values()).map(w => ({
        ...w,
        durationMs: nowMs - w.startedAtMs,
        stale: w.lastHeartbeatMs !== undefined && (nowMs - w.lastHeartbeatMs) > STALE_HEARTBEAT_MS,
        heartbeatAgeMs: w.lastHeartbeatMs !== undefined ? nowMs - w.lastHeartbeatMs : undefined,
      })),
      recent: Array.from(recent.values()).map(w => ({
        ...w,
        durationMs: (w.endedAtMs ?? nowMs) - w.startedAtMs,
      })),
      // Recent skipped wakes — every filter decision the dispatcher
      // made that DROPPED a wake. Surfaced so the host can see "the
      // mail landed, the dispatcher saw it, here's why it skipped"
      // instead of staring at silence.
      skipped: skipped.map(s => ({ ...s, ageMs: nowMs - s.atMs })),
    });
  });

  /**
   * Dispatcher → API: process-heartbeat. Posted every 30 s by
   * the running dispatcher with its alive-state. The host reads
   * this via /dispatcher/activity to distinguish "dispatcher
   * alive but no mail to wake on" from "dispatcher crashed."
   */
  router.post('/dispatcher/process-heartbeat', requireMaster, (req, res) => {
    const body = req.body ?? {};
    if (typeof body.startedAtMs !== 'number') {
      res.status(400).json({ error: 'startedAtMs is required' });
      return;
    }
    processState = {
      startedAtMs: body.startedAtMs,
      channels: typeof body.channels === 'number' ? body.channels : 0,
      coalesceQueueSize: typeof body.coalesceQueueSize === 'number' ? body.coalesceQueueSize : 0,
      running: typeof body.running === 'number' ? body.running : 0,
      maxConcurrent: typeof body.maxConcurrent === 'number' ? body.maxConcurrent : 0,
      atMs: Date.now(),
    };
    res.json({ ok: true });
  });

  /**
   * Dispatcher → API: a wake was SKIPPED with a reason. Pushed
   * to the ring buffer so the host can review recent filter
   * decisions in /dispatcher/activity.
   */
  /**
   * Dispatcher → API: bridge mail arrived but operator is live —
   * we skipped the headless resume to avoid competing with the
   * interactive host CLI session. Telemetry only; the operator's
   * own host hook will surface this mail on their next keystroke.
   */
  router.post('/dispatcher/bridge-skipped', requireMaster, (req, res) => {
    const body = req.body ?? {};
    pushSystemEvent({
      type: 'bridge_skipped',
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      uid: typeof body.uid === 'number' ? body.uid : undefined,
      reason: typeof body.reason === 'string' ? body.reason : 'operator-live',
    });
    res.json({ ok: true });
  });

  /**
   * Dispatcher → API: a bridge resume completed successfully. The
   * operator's session picked up the bridge mail headlessly without
   * the operator being at the keyboard. Surfaced in the web UI as a
   * subtle "(headless wake)" badge on the activity feed.
   */
  router.post('/dispatcher/bridge-resumed', requireMaster, (req, res) => {
    const body = req.body ?? {};
    pushSystemEvent({
      type: 'bridge_resumed',
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      uid: typeof body.uid === 'number' ? body.uid : undefined,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      from: typeof body.from === 'string' ? body.from : undefined,
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
      resultPreview: typeof body.resultPreview === 'string' ? body.resultPreview : undefined,
    });
    res.json({ ok: true });
  });

  /**
   * Dispatcher → API: bridge mail arrived but couldn't be resumed
   * (no fresh session, resume token expired, SDK missing). The
   * operator needs to know — they're the one who has to wake up
   * their CLI and act on it.
   *
   * Surfaced as a high-priority system event so the web UI's
   * notification badge fires loud, AND if SMS is configured for
   * the master account we forward a short digest to the operator's
   * phone. The forward is best-effort: SMS failures don't poison
   * the system event.
   */
  router.post('/dispatcher/bridge-escalation', requireMaster, async (req, res) => {
    const body = req.body ?? {};
    const event = {
      type: 'bridge_escalation',
      urgent: true,
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      uid: typeof body.uid === 'number' ? body.uid : undefined,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      from: typeof body.from === 'string' ? body.from : undefined,
      preview: typeof body.preview === 'string' ? body.preview : undefined,
      reason: typeof body.reason === 'string' ? body.reason : 'unknown',
      errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
      atMs: Date.now(),
    };
    pushSystemEvent(event);

    // Forward a digest to the operator's notification email if
    // configured. Best-effort: a send failure (no relay set up,
    // recipient bounced, transient SMTP error) doesn't poison the
    // system event response — the operator still sees the escalation
    // in the web UI. See packages/core/src/operator-prefs.ts for
    // the storage and `setup_operator_email` MCP tool for the
    // configuration path.
    let forwarded = false;
    try {
      const { getOperatorEmail } = await import('@agenticmail/core');
      const operatorEmail = getOperatorEmail();
      if (operatorEmail && deps.gatewayManager && deps.accountManager && event.agentName) {
        const bridge = await deps.accountManager.getByName(event.agentName);
        if (bridge) {
          const subjectLine = `[AgenticMail Alert] Sub-agent needs your attention — ${event.subject ?? '(no subject)'}`;
          const lines = [
            `A sub-agent mailed your ${event.agentName}@localhost bridge inbox and the dispatcher could not resume a host session to handle it on your behalf.`,
            '',
            `Reason: ${event.reason}${event.errorMessage ? ` — ${event.errorMessage.slice(0, 160)}` : ''}`,
            '',
            `From:    ${event.from ?? 'unknown'}`,
            `Subject: ${event.subject ?? '(no subject)'}`,
            `UID:     ${event.uid ?? '?'}`,
            '',
            event.preview ? `Preview:\n${event.preview.slice(0, 800)}` : '',
            '',
            `Open ${event.agentName} in the AgenticMail web UI, or run \`claude\` / \`codex\` and the next hook fire will surface this thread.`,
            '',
            `— AgenticMail (this address is set via setup_operator_email; reply does nothing)`,
          ].filter(Boolean).join('\n');
          await deps.gatewayManager.routeOutbound(bridge.name, {
            from: bridge.email,
            to: operatorEmail,
            subject: subjectLine,
            text: lines,
          });
          forwarded = true;
        }
      }
    } catch (err) {
      // Don't propagate — escalation event still fires.
      // eslint-disable-next-line no-console
      console.warn('[bridge-escalation] forward to operator email failed:', (err as Error).message);
    }

    res.json({ ok: true, escalated: true, forwarded });
  });

  router.post('/dispatcher/worker-skipped', requireMaster, (req, res) => {
    const body = req.body ?? {};
    if (typeof body.agentName !== 'string' || typeof body.reason !== 'string') {
      res.status(400).json({ error: 'agentName and reason are required' });
      return;
    }
    skipped.push({
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
      agentName: body.agentName,
      uid: typeof body.uid === 'number' ? body.uid : undefined,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      from: typeof body.from === 'string' ? body.from : undefined,
      reason: body.reason,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      atMs: Date.now(),
    });
    while (skipped.length > SKIPPED_CAP) skipped.shift();
    res.json({ ok: true });
  });

  /**
   * Dispatcher → API: a wake is queued for coalescing. Telemetry
   * only — we don't persist the queue server-side (the dispatcher
   * is the source of truth). Just bumps the registry's awareness
   * so the host doesn't see dead air.
   */
  router.post('/dispatcher/worker-queued', requireMaster, (req, res) => {
    // The body contains agent + thread + queuedCount + fireAtMs.
    // We rely on /dispatcher/activity's `skipped` ring + the
    // process-heartbeat's `coalesceQueueSize` to surface this;
    // accept the POST quietly so the dispatcher's fire-and-forget
    // works even before the API knows about this primitive.
    res.json({ ok: true, recorded: req.body ?? null });
  });

  /**
   * Host → API: tail of a worker's log file.
   *
   * Logs live at `~/.agenticmail/worker-logs/<sanitized-id>.log` and
   * are written by the dispatcher's per-worker observer (every SDK
   * message lands as a one-liner). This endpoint reads the tail so
   * the host can see what a long-running worker is actually doing —
   * the answer to "Vesper has been running 20 min, what's she
   * currently stuck on?".
   *
   * Query params:
   *   - lines (default 80, max 1000): how many trailing lines to return
   *
   * Master-key only. Worker logs may contain agent persona contents,
   * email previews, and tool args; not data we hand out to per-agent
   * tokens.
   */
  router.get('/dispatcher/worker-log/:workerId', requireMaster, (req, res) => {
    const rawId = String(req.params.workerId ?? '');
    if (!rawId) {
      res.status(400).json({ error: 'workerId is required' });
      return;
    }
    const lines = Math.min(Math.max(Number(req.query.lines ?? 80), 1), 1000);
    // Same sanitisation rule as the dispatcher uses when it picks the
    // file name. Kept in sync intentionally — must match
    // packages/claudecode/src/dispatcher.ts:sanitizeId().
    const safe = rawId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(homedir(), '.agenticmail', 'worker-logs', `${safe}.log`);
    if (!existsSync(path)) {
      res.status(404).json({ error: 'no log file for that workerId' });
      return;
    }
    try {
      // Naive tail — read whole file, slice. Worker logs are bounded
      // by the lifetime of the worker; even a 30-min worker fires
      // ~maybe 200 KB of log. Streaming would be premature here.
      const raw = readFileSync(path, 'utf-8');
      const stat = statSync(path);
      const all = raw.split(/\r?\n/);
      const tail = all.filter(Boolean).slice(-lines);
      res.json({
        workerId: rawId,
        path,
        bytes: stat.size,
        lines: tail.length,
        tail,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
