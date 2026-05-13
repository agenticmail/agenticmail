/**
 * Human-friendly date and duration formatting for the interactive shell.
 *
 * # Why this exists
 *
 * IMAP and the master API hand us dates as ISO 8601 strings or epoch
 * milliseconds — `2026-05-13T16:22:46.000Z`. That's correct for the
 * wire but unreadable in an inbox. A human scanning their email wants
 * three things at once:
 *
 *   1. **A relative anchor** — "5 minutes ago", "yesterday", "last week"
 *   2. **An absolute time** — "Tue, May 13, 4:22 PM"
 *   3. **Local timezone** — never UTC, never the sender's TZ
 *
 * The shell used to call `new Date(msg.date).toLocaleString()` which
 * gives only #2 in a clunky format ("5/13/2026, 4:22:46 PM"). This
 * module replaces that with a sensible blend of all three.
 *
 * # Pure functions, no side effects
 *
 * Every function takes a date input and an optional `now` reference
 * (defaulting to `new Date()` at call time). That makes the formatter
 * trivial to unit test and predictable across time-of-day boundaries.
 *
 * # Calendar awareness
 *
 * The relative formatter cares about calendar boundaries (today,
 * yesterday, this week) not just absolute time deltas. A message sent
 * 2 minutes ago and a message sent 25 hours ago both need clear
 * labels, but the second one wants the word "yesterday" or a weekday
 * name, not "25 hours ago".
 */

/**
 * Input shapes we accept. We deliberately tolerate everything the IMAP
 * stack hands us so callers don't have to pre-coerce.
 */
type DateInput = string | number | Date | null | undefined;

/** Parse anything into a Date, returning null for unparseable input. */
function toDate(input: DateInput): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Are these two Dates the same calendar day in local time? */
function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Days between `a` and `b` on the local calendar (negative if a < b). */
function localDayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da.getTime() - db.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * "5 minutes ago" / "yesterday" / "last Tuesday" / "Mar 15".
 *
 * Granularity tiers, in order:
 *
 *   <  45s          → "just now"
 *   <  90s          → "a minute ago"
 *   <  60m          → "N minutes ago"
 *   <  90m          → "an hour ago"
 *   <  24h same day → "N hours ago"
 *   yesterday       → "yesterday"
 *   < 7 days        → weekday name ("Tuesday")
 *   same year       → "Mar 15"
 *   else            → "Mar 15, 2025"
 *
 * For dates in the FUTURE (mail clocks drift; some senders send mail
 * from machines a few seconds ahead of us) we just say "just now" up
 * to a 30-second slop, then fall through to the absolute formatter.
 */
export function relativeTime(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input);
  if (!d) return '?';
  const deltaMs = now.getTime() - d.getTime();

  // Clock skew slop — pretend recent future timestamps are "just now".
  if (deltaMs < 0) {
    if (-deltaMs < 30_000) return 'just now';
    // Real future timestamp (scheduled mail) — fall through to absolute.
  }

  const absMs = Math.abs(deltaMs);
  const sec = absMs / 1000;
  const min = sec / 60;
  const hr = min / 60;

  if (deltaMs >= 0 && deltaMs < 45_000) return 'just now';
  if (deltaMs >= 0 && deltaMs < 90_000) return 'a minute ago';
  if (deltaMs >= 0 && min < 60) return `${Math.round(min)} minutes ago`;
  if (deltaMs >= 0 && min < 90) return 'an hour ago';
  if (deltaMs >= 0 && sameLocalDay(d, now) && hr < 24) return `${Math.round(hr)} hours ago`;

  const days = localDayDiff(now, d);
  if (days === 1) return 'yesterday';
  if (days > 1 && days < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }

  // Same calendar year → "Mar 15", different year → "Mar 15, 2025".
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * "Tue, May 13, 4:22 PM" in the user's local timezone.
 *
 * We always show the weekday because an inbox is a stack of timestamps
 * and the weekday makes a relative anchor for "did this happen before
 * the meeting on Tuesday or after?" that the date alone doesn't give.
 *
 * Format pieces are locale-aware (`toLocaleString` with explicit
 * options), so a user in London gets `13 May 2026, 16:22`, a user in
 * New York gets `May 13, 2026, 4:22 PM`. The year is only shown when
 * the message is from a different calendar year than today.
 */
export function absoluteLocal(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input);
  if (!d) return '?';
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (!sameYear) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

/**
 * The combined form used in email headers:
 *
 *   "5 minutes ago — Tue, May 13, 4:22 PM"
 *
 * The relative half gives instant scannability; the absolute half
 * gives precision when the user wants it. Both are local-time.
 */
export function formatEmailDate(input: DateInput, now: Date = new Date()): string {
  const d = toDate(input);
  if (!d) return '?';
  const rel = relativeTime(d, now);
  const abs = absoluteLocal(d, now);
  // When the relative anchor and absolute string overlap heavily
  // ("yesterday — Tue, May 12, ...") we still keep both — readers
  // scan for either depending on which axis they care about.
  return `${rel} — ${abs}`;
}

/**
 * Short duration in human form. Used by the dispatcher-activity
 * MCP tool and any future "X has been running for Y" displays.
 *
 *    920ms  → "0.9s"
 *      4s   → "4s"
 *     65s   → "1m 5s"
 *    600s   → "10m"
 *   3700s   → "1h 2m"
 *
 * Numbers stay terse; the goal is to fit in one column of a table.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}
