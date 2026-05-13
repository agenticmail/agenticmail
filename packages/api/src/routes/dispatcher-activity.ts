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
}

/**
 * Hard TTL for active entries. If a worker has been "running" for
 * longer than this, we drop it on next read — almost certainly the
 * dispatcher crashed mid-run and never sent the finished event.
 *
 * 30 minutes is generous; the Claude Agent SDK aborts most turns long
 * before that, and our own concurrency cap (default 10) means even a
 * stuck slot only blocks one out of ten parallel wakes.
 */
const ACTIVE_TTL_MS = 30 * 60 * 1000;

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
  for (const [id, w] of active) {
    if (nowMs - w.startedAtMs > ACTIVE_TTL_MS) active.delete(id);
  }
  for (const [id, w] of recent) {
    const t = w.endedAtMs ?? w.startedAtMs;
    if (nowMs - t > RECENT_TTL_MS) recent.delete(id);
  }
  // Hard cap on each map — drop oldest if we still over the line.
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
}

export function createDispatcherActivityRoutes(): Router {
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
   * Host → API: what's happening right now?
   *
   * Returns active workers (currently running) plus recently-finished
   * ones (within the last 2 minutes) so the host can see the state of
   * the world without having to be subscribed to SSE.
   */
  router.get('/dispatcher/activity', requireMaster, (_req, res) => {
    const nowMs = Date.now();
    prune(nowMs);
    res.json({
      now: nowMs,
      active: Array.from(active.values()).map(w => ({
        ...w,
        durationMs: nowMs - w.startedAtMs,
      })),
      recent: Array.from(recent.values()).map(w => ({
        ...w,
        durationMs: (w.endedAtMs ?? nowMs) - w.startedAtMs,
      })),
    });
  });

  return router;
}
