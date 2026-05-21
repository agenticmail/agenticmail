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

import { PhoneManager, TelegramManager, sendTelegramMessage, type AgenticMailConfig, type PhoneCallMission, type PhoneScheduledCallback } from '@agenticmail/core';
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
  // TelegramManager too — used to DM the operator when a scheduled
  // callback wakes and dials. Same long-lived discipline as
  // phoneManager. (`getConfig` is best-effort: no telegram setup ⇒
  // the notification is skipped.)
  const telegramManager = new TelegramManager(db as any, config.masterKey);

  // Guard against overlapping ticks: a slow dial could otherwise let
  // the next tick start before this one finishes, and parallel dials
  // would compete for the same `status: pending → dialing` transition.
  let inFlight = false;

  const handle = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // v0.9.92 — sweep stale operator queries first. Cheap: a single
      // LIKE-filtered scan of missions that have any operatorQueries
      // metadata at all. Auto-closes queries whose mission already
      // terminated, or whose ask was over an hour ago. Deterministic;
      // no LLM involved.
      try {
        const swept = phoneManager.sweepStaleOperatorQueries({});
        if (swept.closed > 0) {
          // Use the console here — the API server has no structured
          // logger and this is intentionally low-volume.
          // eslint-disable-next-line no-console
          console.log(`[callback-scheduler] swept ${swept.closed} stale operator query(ies) across ${swept.missionsTouched} mission(s)`);
        }
      } catch (err) {
        onError(err as Error, '<sweeper>');
      }

      const due = phoneManager.findDueScheduledCallbacks(new Date().toISOString(), maxPerTick);
      for (const mission of due) {
        try {
          const result = await phoneManager.triggerScheduledCallback(mission.id);
          // Notify the operator over Telegram (best-effort). The agent
          // arranged this re-dial possibly hours ago; surfacing the
          // dial keeps the human in the loop without them having to
          // watch the web UI. Skipped silently if the agent has no
          // Telegram config — same discipline as the operator-query
          // notifier in realtime-ws.ts.
          if (result?.callbackMission) {
            void notifyScheduledCallbackFired(telegramManager, mission, result.callbackMission.id)
              .catch((err) => onError(err as Error, mission.id));
          }
        } catch (err) {
          // Dial failures are LOGGED but do not stop the loop — the
          // manager already wrote the failure back to the mission
          // (status: 'pending' + lastError), so the next tick retries.
          // Surface the failure to the operator via Telegram too so
          // they aren't waiting on a callback that never happens.
          void notifyScheduledCallbackFailed(telegramManager, mission, (err as Error).message)
            .catch((notifyErr) => onError(notifyErr as Error, mission.id));
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

/**
 * Send a Telegram DM to the agent's configured operator chat when a
 * scheduled callback wakes and successfully dials. Lets the human
 * know "your agent just rang +1 555 0100 back as you both agreed" in
 * real time. Best-effort: no telegram config / no operator chat ⇒
 * the notification is silently skipped (the dial still happened).
 */
async function notifyScheduledCallbackFired(
  telegramManager: TelegramManager,
  parentMission: PhoneCallMission,
  callbackMissionId: string,
): Promise<void> {
  const cfg = telegramManager.getConfig(parentMission.agentId);
  if (!cfg?.enabled || !cfg.operatorChatId || !cfg.botToken) return;

  const sc = parentMission.metadata.scheduledCallback as PhoneScheduledCallback | undefined;
  const lines = [
    '📞 Scheduled callback firing now',
    '',
    `Your voice agent just woke up and dialed ${parentMission.to} — the auto-callback you arranged on the prior call (mission ${parentMission.id}).`,
  ];
  if (sc?.reason) lines.push('', `Reason: ${truncate(sc.reason, 240)}`);
  if (sc?.agentSummary) lines.push('', `Agent's notes for this call:`, truncate(sc.agentSummary, 480));
  lines.push('', `Live mission: ${callbackMissionId}`);

  await sendTelegramMessage(cfg.botToken, cfg.operatorChatId, lines.join('\n'));
}

/** Notify the operator that a scheduled callback's dial failed. */
async function notifyScheduledCallbackFailed(
  telegramManager: TelegramManager,
  parentMission: PhoneCallMission,
  errorMessage: string,
): Promise<void> {
  const cfg = telegramManager.getConfig(parentMission.agentId);
  if (!cfg?.enabled || !cfg.operatorChatId || !cfg.botToken) return;

  const lines = [
    '⚠️ Scheduled callback failed to dial',
    '',
    `The auto-callback to ${parentMission.to} (mission ${parentMission.id}) couldn't go through.`,
    '',
    `Error: ${truncate(errorMessage, 240)}`,
    '',
    'The scheduler will retry on the next tick.',
  ];
  await sendTelegramMessage(cfg.botToken, cfg.operatorChatId, lines.join('\n'));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
