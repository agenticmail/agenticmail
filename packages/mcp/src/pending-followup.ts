/**
 * Pending Email Follow-Up Scheduler
 *
 * When an outbound email is blocked by the security guard, this scheduler
 * sets up automatic follow-up reminders on an exponential backoff schedule:
 *
 *   12 hours → 6 hours → 3 hours → 1 hour (final) → 3-day cooldown → repeat
 *
 * The agent is reminded to follow up with the owner on each interval.
 * If the pending email is approved/rejected before the next reminder,
 * the follow-up is automatically cancelled.
 */

export interface FollowUpNotification {
  pendingId: string;
  recipient: string;
  subject: string;
  /** Which attempt within the current cycle (1-based) */
  attempt: number;
  /** True on the 4th reminder (1-hour), before the 3-day cooldown */
  isFinalBeforeCooldown: boolean;
  /** Human-readable reminder message for the agent */
  message: string;
}

interface TrackedPending {
  pendingId: string;
  recipient: string;
  subject: string;
  /** Async function that returns true if the email is still pending */
  checkFn: () => Promise<boolean>;
  /** 0-indexed step within the current cycle */
  step: number;
  /** How many full 4-step cycles have completed */
  cycle: number;
  timer: ReturnType<typeof setTimeout>;
}

// Escalating intervals within each cycle
const STEP_DELAYS_MS = [
  12 * 3_600_000, //  0 → 12 hours
   6 * 3_600_000, //  1 →  6 hours
   3 * 3_600_000, //  2 →  3 hours
   1 * 3_600_000, //  3 →  1 hour  (final before cooldown)
];

// Cooldown after completing a full cycle
const COOLDOWN_MS = 3 * 24 * 3_600_000; // 3 days

// How often the heartbeat runs to detect externally-resolved emails
// (e.g. owner approved via email reply while the agent process was idle).
const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes

// ── Module state (singleton) ──────────────────────────────────────────

const tracked = new Map<string, TrackedPending>();
const queue: FollowUpNotification[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Start follow-up reminders for a blocked pending email.
 *
 * @param pendingId  UUID of the pending outbound email
 * @param recipient  Who the email was addressed to (for display)
 * @param subject    Original email subject (for display)
 * @param checkFn    Returns `true` if the email is still pending.
 *                   Called before each reminder to avoid stale follow-ups.
 */
export function scheduleFollowUp(
  pendingId: string,
  recipient: string,
  subject: string,
  checkFn: () => Promise<boolean>,
): void {
  if (tracked.has(pendingId)) return; // no double-scheduling
  arm(pendingId, recipient, subject, checkFn, 0, 0);
  startHeartbeat();
}

/**
 * Drain all queued follow-up notifications.
 * Returns the notifications and clears the internal queue.
 * Call this before returning a tool response to inject reminders.
 */
export function drainFollowUps(): FollowUpNotification[] {
  if (queue.length === 0) return [];
  const items = [...queue];
  queue.length = 0;
  return items;
}

/** Cancel follow-ups for a specific pending email (e.g. approved/rejected). */
export function cancelFollowUp(pendingId: string): void {
  const entry = tracked.get(pendingId);
  if (entry) {
    clearTimeout(entry.timer);
    tracked.delete(pendingId);
  }
}

/** Cancel all follow-ups (e.g. on shutdown / agent_end). */
export function cancelAllFollowUps(): void {
  for (const entry of tracked.values()) clearTimeout(entry.timer);
  tracked.clear();
  queue.length = 0;
  stopHeartbeat();
}

/** Number of actively tracked pending emails. */
export function activeFollowUpCount(): number {
  return tracked.size;
}

// ── Internals ─────────────────────────────────────────────────────────

function arm(
  pendingId: string,
  recipient: string,
  subject: string,
  checkFn: () => Promise<boolean>,
  step: number,
  cycle: number,
): void {
  const delayMs = step < STEP_DELAYS_MS.length
    ? STEP_DELAYS_MS[step]
    : COOLDOWN_MS;

  const timer = setTimeout(() => fire(pendingId), delayMs);
  timer.unref(); // don't keep the process alive

  tracked.set(pendingId, { pendingId, recipient, subject, checkFn, step, cycle, timer });
}

async function fire(pendingId: string): Promise<void> {
  const entry = tracked.get(pendingId);
  if (!entry) return;

  // Check whether the email is still pending
  try {
    const stillPending = await entry.checkFn();
    if (!stillPending) {
      tracked.delete(pendingId);
      return;
    }
  } catch {
    // API error — assume still pending and deliver the reminder anyway
  }

  const { recipient, subject, step, cycle, checkFn } = entry;
  const isFinal = step === STEP_DELAYS_MS.length - 1;
  const isPostCooldown = step >= STEP_DELAYS_MS.length;

  // Build the reminder message
  let message: string;
  if (isPostCooldown) {
    // Waking up after a 3-day cooldown — start a new cycle
    const totalDays = 3 * (cycle + 1);
    message = [
      `[FOLLOW-UP REMINDER — cycle ${cycle + 2}]`,
      `Your blocked email to ${recipient} (subject: "${subject}") has been pending for over ${totalDays} days.`,
      `Starting a new follow-up cycle. Please remind your owner that this email still needs their review.`,
      `Pending ID: ${pendingId}`,
    ].join('\n');
  } else if (isFinal) {
    message = [
      `[FINAL FOLLOW-UP]`,
      `Your blocked email to ${recipient} (subject: "${subject}") is STILL pending approval.`,
      `This is the last reminder before a 3-day cooldown. Please urgently remind your owner.`,
      `Let them know you will not follow up again for 3 days unless they respond.`,
      `Pending ID: ${pendingId}`,
    ].join('\n');
  } else {
    const nextDelayH = STEP_DELAYS_MS[step + 1] / 3_600_000;
    message = [
      `[FOLLOW-UP REMINDER ${step + 1}/${STEP_DELAYS_MS.length}]`,
      `Your blocked email to ${recipient} (subject: "${subject}") is still pending owner approval.`,
      `Please follow up with your owner — ask if they've reviewed the notification email.`,
      `Next reminder in ${nextDelayH} hour${nextDelayH !== 1 ? 's' : ''}.`,
      `Pending ID: ${pendingId}`,
    ].join('\n');
  }

  queue.push({
    pendingId,
    recipient,
    subject,
    attempt: isPostCooldown ? 1 : step + 1,
    isFinalBeforeCooldown: isFinal,
    message,
  });

  // Schedule the next follow-up
  if (isPostCooldown) {
    arm(pendingId, recipient, subject, checkFn, 0, cycle + 1);
  } else {
    arm(pendingId, recipient, subject, checkFn, step + 1, cycle);
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────
// Periodically polls checkFn for every tracked email so that externally-
// resolved emails (e.g. owner approved via email reply) are discovered
// quickly rather than waiting for the next scheduled reminder fire.

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function heartbeat(): Promise<void> {
  if (tracked.size === 0) {
    stopHeartbeat();
    return;
  }

  for (const [pendingId, entry] of tracked) {
    try {
      const stillPending = await entry.checkFn();
      if (!stillPending) {
        clearTimeout(entry.timer);
        tracked.delete(pendingId);
      }
    } catch {
      // API unreachable — skip, will retry next heartbeat
    }
  }

  // Stop the heartbeat if nothing left to track
  if (tracked.size === 0) stopHeartbeat();
}
