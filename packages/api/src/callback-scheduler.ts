/**
 * Scheduled-callback tick loop.
 *
 * The voice agent's `schedule_callback` tool records a request on the
 * mission's metadata (`scheduledCallback`); this loop dials any
 * request whose `at` has arrived. Independent of (and complementary
 * to) the legacy operator-query callback path in
 * `phoneManager.flagCallbackPending` / `triggerCallback`.
 *
 * Why a tick loop and not a per-call setTimeout:
 *   - Callback times can be hours / days out; a setTimeout would die
 *     across server restarts.
 *   - The DB is the source of truth — a tick scan resumes correctly
 *     after a crash with no special cold-start logic.
 *   - Concurrency control falls naturally out of `status: pending →
 *     dialing` in `triggerScheduledCallback`; a parallel tick can't
 *     double-dial.
 *
 * The loop is deliberately CHEAP: one indexed-LIKE prepared statement
 * + an in-memory time filter (see {@link findDueScheduledCallbacks}).
 * For installs with < ~10k missions this is well under 5ms per tick.
 * Past that scale, promoting `scheduled_callback_at` to its own
 * indexed column is the next step.
 */

import { PhoneManager, type AgenticMailConfig } from '@agenticmail/core';
import type { getDatabase } from '@agenticmail/core';

type Db = ReturnType<typeof getDatabase>;

/** Default tick interval — 30s. Tight enough that an agent saying "call back
 *  in 1 minute" actually rings within ~30-60s; loose enough that the loop
 *  isn't a measurable load. */
export const DEFAULT_CALLBACK_TICK_MS = 30_000;

/** Max scheduled callbacks fired in one tick. Caps blast radius if a
 *  backlog builds (server was down for hours, every overdue callback
 *  becomes due at once). The remainder ride into the next tick. */
export const MAX_CALLBACKS_PER_TICK = 8;

export interface CallbackSchedulerOptions {
  /** How often to scan for due callbacks. Defaults to {@link DEFAULT_CALLBACK_TICK_MS}. */
  intervalMs?: number;
  /** Cap per tick. Defaults to {@link MAX_CALLBACKS_PER_TICK}. */
  maxPerTick?: number;
  /** Injectable error sink (defaults to console.error). Tests use this. */
  onError?: (err: Error, missionId: string) => void;
}

/**
 * Start the callback scheduler. Returns a stop function. Safe to call
 * once; multiple instances would race on `status: pending → dialing`,
 * which the manager handles correctly but would still double the load.
 */
export function startCallbackScheduler(
  db: Db,
  config: AgenticMailConfig,
  options: CallbackSchedulerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_CALLBACK_TICK_MS;
  const maxPerTick = options.maxPerTick ?? MAX_CALLBACKS_PER_TICK;
  const onError = options.onError ?? ((err, missionId) => {
    console.error(`[callback-scheduler] mission=${missionId}: ${err.message}`);
  });

  // One PhoneManager instance held across ticks. The manager is
  // stateless w.r.t. the DB connection (prepares statements lazily),
  // so a long-lived instance is safe.
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  // Guard against overlapping ticks: a slow dial could otherwise let
  // the next tick start before this one finishes, and parallel dials
  // would compete for the same `status: pending → dialing` transition.
  let inFlight = false;

  const handle = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const due = phoneManager.findDueScheduledCallbacks(new Date().toISOString(), maxPerTick);
      for (const mission of due) {
        try {
          await phoneManager.triggerScheduledCallback(mission.id);
        } catch (err) {
          // Dial failures are LOGGED but do not stop the loop — the
          // manager already wrote the failure back to the mission
          // (status: 'pending' + lastError), so the next tick retries.
          onError(err as Error, mission.id);
        }
      }
    } catch (err) {
      onError(err as Error, '<scheduler>');
    } finally {
      inFlight = false;
    }
  }, intervalMs);

  // Don't keep the process alive just for the scheduler — if everything
  // else has shut down the loop should let the process exit cleanly.
  // (Node's `unref()` on a Timeout is the canonical way to mark it as
  // non-blocking for process lifetime.)
  if (typeof (handle as any).unref === 'function') {
    (handle as any).unref();
  }

  return () => {
    try { clearInterval(handle); } catch { /* idempotent */ }
  };
}
