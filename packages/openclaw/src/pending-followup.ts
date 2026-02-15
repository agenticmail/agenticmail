/**
 * Pending Email Follow-Up Scheduler
 *
 * When an outbound email is blocked by the security guard, this scheduler
 * sets up automatic follow-up reminders on an escalating schedule:
 *
 *   12 hours → 6 hours → 3 hours → 1 hour (final) → 3-day cooldown → repeat
 *
 * Reminders are delivered via OpenClaw's system event mechanism, which injects
 * them into the agent's next prompt.
 *
 * Follow-up state is persisted to disk so reminders survive process restarts.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

interface FollowUpEntry {
  pendingId: string;
  recipient: string;
  subject: string;
  /** 0-indexed step within the current cycle */
  step: number;
  /** How many full 4-step cycles have completed */
  cycle: number;
  /** ISO timestamp when the next reminder should fire */
  nextFireAt: string;
  /** ISO timestamp when this follow-up was first created */
  createdAt: string;
  /** Session key for system event delivery */
  sessionKey: string;
  /** API URL + key for status checks */
  apiUrl: string;
  apiKey: string;
}

interface PersistedState {
  version: 1;
  entries: FollowUpEntry[];
}

// ── Constants ────────────────────────────────────────────────────────

// Escalating intervals within each cycle
const STEP_DELAYS_MS = [
  12 * 3_600_000, //  0 → 12 hours
   6 * 3_600_000, //  1 →  6 hours
   3 * 3_600_000, //  2 →  3 hours
   1 * 3_600_000, //  3 →  1 hour  (final before cooldown)
];

// Cooldown after completing a full cycle
const COOLDOWN_MS = 3 * 24 * 3_600_000; // 3 days

// Heartbeat interval for checking if pending emails have been resolved
const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes

// ── Module state (singleton) ─────────────────────────────────────────

let _api: any = null;
let _stateFilePath: string = '';
const tracked = new Map<string, FollowUpEntry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── Initialization ───────────────────────────────────────────────────

/**
 * Initialize the follow-up system with the OpenClaw plugin API.
 * Must be called during plugin activation before any follow-ups are scheduled.
 */
export function initFollowUpSystem(api: any): void {
  _api = api;

  // Resolve state file path for persistence
  try {
    const stateDir = api?.runtime?.state?.resolveStateDir?.();
    if (stateDir) {
      _stateFilePath = join(stateDir, 'agenticmail-followups.json');
    }
  } catch { /* no persistence */ }

  // Restore any persisted follow-ups from a previous process
  restoreState();
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start follow-up reminders for a blocked pending email.
 *
 * @param pendingId    UUID of the pending outbound email
 * @param recipient    Who the email was addressed to (for display)
 * @param subject      Original email subject (for display)
 * @param sessionKey   OpenClaw session key for system event delivery
 * @param apiUrl       AgenticMail API base URL (for status checks)
 * @param apiKey       Agent API key (for status checks)
 */
export function scheduleFollowUp(
  pendingId: string,
  recipient: string,
  subject: string,
  sessionKey: string,
  apiUrl: string,
  apiKey: string,
): void {
  if (tracked.has(pendingId)) return;

  const entry: FollowUpEntry = {
    pendingId,
    recipient,
    subject,
    step: 0,
    cycle: 0,
    nextFireAt: new Date(Date.now() + STEP_DELAYS_MS[0]).toISOString(),
    createdAt: new Date().toISOString(),
    sessionKey,
    apiUrl,
    apiKey,
  };

  tracked.set(pendingId, entry);
  armTimer(pendingId, entry);
  startHeartbeat();
  persistState();
}

/** Cancel follow-ups for a specific pending email (e.g. approved/rejected). */
export function cancelFollowUp(pendingId: string): void {
  if (!tracked.has(pendingId)) return;
  clearTimer(pendingId);
  tracked.delete(pendingId);
  persistState();
}

/** Cancel all follow-ups (e.g. on shutdown / agent_end). */
export function cancelAllFollowUps(): void {
  for (const id of tracked.keys()) {
    clearTimer(id);
  }
  tracked.clear();
  timers.clear();
  stopHeartbeat();
  persistState();
}

/** Number of actively tracked pending emails. */
export function activeFollowUpCount(): number {
  return tracked.size;
}

/** Get summary of all active follow-ups (for diagnostics). */
export function getFollowUpSummary(): Array<{
  pendingId: string;
  recipient: string;
  subject: string;
  step: number;
  cycle: number;
  nextFireAt: string;
}> {
  return Array.from(tracked.values()).map(e => ({
    pendingId: e.pendingId,
    recipient: e.recipient,
    subject: e.subject,
    step: e.step,
    cycle: e.cycle,
    nextFireAt: e.nextFireAt,
  }));
}

// ── Timer Management ─────────────────────────────────────────────────

function armTimer(pendingId: string, entry: FollowUpEntry): void {
  clearTimer(pendingId);
  const delay = Math.max(0, new Date(entry.nextFireAt).getTime() - Date.now());
  const timer = setTimeout(() => fire(pendingId), delay);
  timer.unref();
  timers.set(pendingId, timer);
}

function clearTimer(pendingId: string): void {
  const timer = timers.get(pendingId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(pendingId);
  }
}

// ── Reminder Delivery ────────────────────────────────────────────────

async function fire(pendingId: string): Promise<void> {
  const entry = tracked.get(pendingId);
  if (!entry) return;

  // Check whether the email is still pending
  const stillPending = await checkStillPending(entry);
  if (!stillPending) {
    clearTimer(pendingId);
    tracked.delete(pendingId);
    persistState();
    return;
  }

  const { recipient, subject, step, cycle } = entry;
  const isFinal = step === STEP_DELAYS_MS.length - 1;
  const isPostCooldown = step >= STEP_DELAYS_MS.length;

  // Build the reminder message
  let message: string;
  if (isPostCooldown) {
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

  // Deliver via OpenClaw system event (injected into agent's next prompt)
  deliverReminder(message, entry.sessionKey);

  // Schedule the next follow-up
  const nextStep = isPostCooldown ? 0 : step + 1;
  const nextCycle = isPostCooldown ? cycle + 1 : cycle;
  const nextDelay = nextStep < STEP_DELAYS_MS.length ? STEP_DELAYS_MS[nextStep] : COOLDOWN_MS;

  entry.step = nextStep;
  entry.cycle = nextCycle;
  entry.nextFireAt = new Date(Date.now() + nextDelay).toISOString();

  armTimer(pendingId, entry);
  persistState();
}

function deliverReminder(text: string, sessionKey: string): void {
  try {
    if (_api?.runtime?.system?.enqueueSystemEvent && sessionKey) {
      _api.runtime.system.enqueueSystemEvent(text, { sessionKey });
    } else {
      console.warn('[agenticmail] Cannot deliver follow-up reminder: no system event API or session key');
    }
  } catch (err) {
    console.warn(`[agenticmail] Follow-up delivery error: ${(err as Error).message}`);
  }
}

// ── Status Checks ────────────────────────────────────────────────────

async function checkStillPending(entry: FollowUpEntry): Promise<boolean> {
  try {
    const res = await fetch(
      `${entry.apiUrl}/api/agenticmail/mail/pending/${encodeURIComponent(entry.pendingId)}`,
      {
        headers: { 'Authorization': `Bearer ${entry.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return false;
    const data: any = await res.json();
    return data?.status === 'pending';
  } catch {
    return true; // assume still pending on error
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────

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
      const stillPending = await checkStillPending(entry);
      if (!stillPending) {
        clearTimer(pendingId);
        tracked.delete(pendingId);
        persistState();
      }
    } catch {
      // API unreachable — skip, will retry next heartbeat
    }
  }

  if (tracked.size === 0) stopHeartbeat();
}

// ── Persistence ──────────────────────────────────────────────────────

function persistState(): void {
  if (!_stateFilePath) return;
  try {
    const state: PersistedState = {
      version: 1,
      entries: Array.from(tracked.values()),
    };
    mkdirSync(dirname(_stateFilePath), { recursive: true });
    writeFileSync(_stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[agenticmail] Failed to persist follow-up state: ${(err as Error).message}`);
  }
}

function restoreState(): void {
  if (!_stateFilePath) return;
  try {
    const raw = readFileSync(_stateFilePath, 'utf-8');
    const state: PersistedState = JSON.parse(raw);
    if (state.version !== 1 || !Array.isArray(state.entries)) return;

    for (const entry of state.entries) {
      // Skip entries whose fire time has long passed (> 1 day overdue)
      const overdue = Date.now() - new Date(entry.nextFireAt).getTime();
      if (overdue > 24 * 3_600_000) continue;

      tracked.set(entry.pendingId, entry);
      armTimer(entry.pendingId, entry);
    }

    if (tracked.size > 0) {
      startHeartbeat();
      console.log(`[agenticmail] Restored ${tracked.size} follow-up reminder(s) from disk`);
    }
  } catch {
    // No persisted state or invalid — start fresh
  }
}
