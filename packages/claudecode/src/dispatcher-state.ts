/**
 * Dispatcher state persistence — per-agent cursors that survive a
 * restart so the dispatcher can resume where it left off.
 *
 * Why this exists
 * ───────────────
 * Before 0.9.8 the dispatcher kept all of its routing memory in RAM:
 *
 *   - `channel.seenUids` (Set<number>)  — UIDs already woken on, for dedup
 *   - `channel.seenTaskIds` (Set<string>) — task ids already spawned
 *   - in-flight wake-budget counts
 *
 * On every restart (PM2 reload, host reboot, a crash absorbed by the
 * uncaughtException guard) ALL of that state was lost. The visible
 * symptoms:
 *
 *   1. Mail that arrived WHILE the dispatcher was down was silently
 *      dropped — the SSE channel only fires for IDLE notifications
 *      received in real time, with no `since=<uid>` replay.
 *   2. Tasks assigned during downtime were never claimed.
 *   3. After restart, if IMAP IDLE re-delivered a UID that we'd
 *      already processed pre-crash, we'd wake on it AGAIN because
 *      `seenUids` was empty.
 *
 * The fix is a tiny JSON file at `~/.agenticmail/dispatcher-state.json`:
 *
 *   {
 *     "version": 1,
 *     "savedAtMs": 1778765912030,
 *     "accounts": {
 *       "<agentId>": {
 *         "lastSeenUid": 142,
 *         "seenUids": [138, 139, 140, 141, 142]
 *       }
 *     }
 *   }
 *
 * On startup we load it once. The dispatcher seeds each channel's
 * `seenUids` from `seenUids[]` (so IMAP IDLE replays of old UIDs
 * stay deduped) and uses `lastSeenUid` to drive the catch-up scan
 * (any UID strictly greater than this is unprocessed mail that
 * arrived during downtime).
 *
 * Writes are debounced — the dispatcher calls `markSeen(...)` on every
 * wake decision, but actual flush-to-disk is throttled to every 2 s
 * (or on shutdown / before catch-up to be safe). Atomic write via
 * `<file>.tmp` + rename so a crash mid-flush never produces a
 * partial file.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const STATE_VERSION = 1;
/** Bounded — we don't need a UID history any longer than this. */
const SEEN_UIDS_CAP = 256;
/** Debounce window for disk writes; reduces fsync churn under burst. */
const FLUSH_INTERVAL_MS = 2_000;

export interface AccountCursor {
  /** Largest UID we ever decided to process (woken on OR explicitly skipped) */
  lastSeenUid: number;
  /** Recent UIDs (bounded) used to dedup IMAP IDLE replays after restart. */
  seenUids: number[];
}

interface StateFile {
  version: number;
  savedAtMs: number;
  accounts: Record<string, AccountCursor>;
}

/** Build a fresh empty state. NEVER share an object literal across
 *  instances — shallow-spreading would alias the inner `accounts`
 *  map, causing one DispatcherState's mutations to leak into the next. */
function emptyState(): StateFile {
  return { version: STATE_VERSION, savedAtMs: 0, accounts: {} };
}

export function defaultStatePath(): string {
  return join(homedir(), '.agenticmail', 'dispatcher-state.json');
}

export class DispatcherState {
  private readonly path: string;
  private state: StateFile = emptyState();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts?: { path?: string }) {
    this.path = opts?.path ?? defaultStatePath();
    this.load();
  }

  /** Read the state file from disk. Missing / corrupt → empty state. */
  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed && typeof parsed === 'object' && parsed.version === STATE_VERSION) {
        // Defensive: filter out malformed account entries rather than
        // tripping on them on every restart.
        const accounts: Record<string, AccountCursor> = {};
        for (const [id, cursor] of Object.entries(parsed.accounts ?? {})) {
          if (
            cursor &&
            typeof cursor === 'object' &&
            typeof (cursor as AccountCursor).lastSeenUid === 'number' &&
            Array.isArray((cursor as AccountCursor).seenUids)
          ) {
            const c = cursor as AccountCursor;
            accounts[id] = {
              lastSeenUid: c.lastSeenUid,
              seenUids: c.seenUids.filter(u => Number.isFinite(u) && u > 0).slice(-SEEN_UIDS_CAP),
            };
          }
        }
        this.state = { version: STATE_VERSION, savedAtMs: parsed.savedAtMs ?? 0, accounts };
      }
    } catch {
      // Corrupt / unreadable — start fresh. Better than crashing the
      // whole dispatcher on a malformed state file.
      this.state = emptyState();
    }
  }

  /** Read the cursor for one account. Missing → undefined. */
  getCursor(accountId: string): AccountCursor | undefined {
    return this.state.accounts[accountId];
  }

  /** All known account ids in the persisted state. */
  knownAccounts(): string[] {
    return Object.keys(this.state.accounts);
  }

  /**
   * Record that the dispatcher routed UID `uid` for `accountId`.
   * Updates lastSeenUid (monotonic max) and appends to seenUids with
   * bounding. Marks state dirty + schedules a debounced flush.
   */
  markSeen(accountId: string, uid: number): void {
    if (!Number.isFinite(uid) || uid <= 0) return;
    let cur = this.state.accounts[accountId];
    if (!cur) {
      cur = { lastSeenUid: 0, seenUids: [] };
      this.state.accounts[accountId] = cur;
    }
    if (uid > cur.lastSeenUid) cur.lastSeenUid = uid;
    if (!cur.seenUids.includes(uid)) {
      cur.seenUids.push(uid);
      if (cur.seenUids.length > SEEN_UIDS_CAP) {
        cur.seenUids = cur.seenUids.slice(-SEEN_UIDS_CAP);
      }
    }
    this.scheduleFlush();
  }

  /** Drop the cursor for an account that vanished. */
  forget(accountId: string): void {
    if (this.state.accounts[accountId]) {
      delete this.state.accounts[accountId];
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try { this.flushNow(); } catch { /* swallow — next mark will retry */ }
    }, FLUSH_INTERVAL_MS);
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Synchronously write state to disk via atomic rename. Safe to call
   * from a shutdown handler — finishes before the process exits.
   */
  flushNow(): void {
    if (!this.dirty) return;
    const dir = dirname(this.path);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const out: StateFile = { ...this.state, savedAtMs: Date.now(), version: STATE_VERSION };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  /** Cancel the debounce timer (used during shutdown). */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
