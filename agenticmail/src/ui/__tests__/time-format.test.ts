/**
 * Tests for the date/duration formatter.
 *
 * Every `now` is injected so tests don't drift across midnight or DST.
 * The relative formatter has calendar-day awareness (yesterday, weekday
 * name, etc.) so we use real Dates and assert against the locale-
 * agnostic parts of the output where we can.
 */

import { describe, it, expect } from 'vitest';
import { relativeTime, absoluteLocal, formatEmailDate, formatDuration } from '../time-format.js';

describe('relativeTime', () => {
  const now = new Date('2026-05-13T16:00:00');

  it('returns "just now" for the present moment', () => {
    expect(relativeTime(now, now)).toBe('just now');
  });

  it('returns "just now" for the very recent past (under 45s)', () => {
    const d = new Date(now.getTime() - 30_000);
    expect(relativeTime(d, now)).toBe('just now');
  });

  it('returns "a minute ago" between 45s and 90s', () => {
    const d = new Date(now.getTime() - 60_000);
    expect(relativeTime(d, now)).toBe('a minute ago');
  });

  it('returns N minutes ago between 90s and one hour', () => {
    const d = new Date(now.getTime() - 5 * 60_000);
    expect(relativeTime(d, now)).toBe('5 minutes ago');
  });

  it('returns "an hour ago" between 60 and 90 minutes', () => {
    const d = new Date(now.getTime() - 75 * 60_000);
    expect(relativeTime(d, now)).toBe('an hour ago');
  });

  it('returns N hours ago for same-day times beyond 90 minutes', () => {
    // now = 16:00, message at 09:00 same day = 7 hours
    const d = new Date('2026-05-13T09:00:00');
    expect(relativeTime(d, now)).toBe('7 hours ago');
  });

  it('returns "yesterday" for messages from one local-calendar day before', () => {
    // now = May 13 16:00, message = May 12 23:30 — clock delta is 16.5h
    // but the calendar day delta is 1, which is what humans care about.
    const d = new Date('2026-05-12T23:30:00');
    expect(relativeTime(d, now)).toBe('yesterday');
  });

  it('returns a weekday name for messages 2 to 6 days old', () => {
    const d = new Date('2026-05-09T12:00:00'); // 4 days before May 13
    // Locale-dependent but always one of the 7 weekday names.
    const out = relativeTime(d, now);
    expect(out).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/);
  });

  it('returns "Mon DD" for same-year messages older than a week', () => {
    const d = new Date('2026-03-15T10:00:00');
    const out = relativeTime(d, now);
    // Locale-dependent month, but should not contain a year.
    expect(out).not.toMatch(/2026/);
    expect(out).toMatch(/15/);
  });

  it('includes the year for messages from a different calendar year', () => {
    const d = new Date('2025-03-15T10:00:00');
    const out = relativeTime(d, now);
    expect(out).toMatch(/2025/);
  });

  it('returns "just now" for recent future timestamps (clock skew slop)', () => {
    const d = new Date(now.getTime() + 10_000);
    expect(relativeTime(d, now)).toBe('just now');
  });

  it('returns "?" for null/undefined/garbage input', () => {
    expect(relativeTime(null, now)).toBe('?');
    expect(relativeTime(undefined, now)).toBe('?');
    expect(relativeTime('not a date', now)).toBe('?');
  });

  it('accepts millisecond epoch numbers and ISO strings', () => {
    const d = new Date(now.getTime() - 5 * 60_000);
    expect(relativeTime(d.getTime(), now)).toBe('5 minutes ago');
    expect(relativeTime(d.toISOString(), now)).toBe('5 minutes ago');
  });
});

describe('absoluteLocal', () => {
  const now = new Date('2026-05-13T16:00:00');

  it('omits the year for same-year dates and includes weekday + month + time', () => {
    const d = new Date('2026-05-13T16:22:46');
    const out = absoluteLocal(d, now);
    expect(out).not.toMatch(/2026/);
    // Weekday (locale-dependent prefix) — assert it's not just a date string.
    expect(out.length).toBeGreaterThan(8);
  });

  it('includes the year for different-year dates', () => {
    const d = new Date('2025-03-15T10:00:00');
    const out = absoluteLocal(d, now);
    expect(out).toMatch(/2025/);
  });

  it('returns "?" for missing input', () => {
    expect(absoluteLocal(undefined, now)).toBe('?');
  });
});

describe('formatEmailDate', () => {
  const now = new Date('2026-05-13T16:00:00');

  it('combines relative + absolute with an em-dash separator', () => {
    const d = new Date(now.getTime() - 5 * 60_000);
    const out = formatEmailDate(d, now);
    expect(out).toMatch(/5 minutes ago/);
    expect(out).toContain('—');
  });
});

describe('formatDuration', () => {
  it('shows sub-second times with one decimal', () => {
    expect(formatDuration(920)).toBe('0.9s');
    expect(formatDuration(50)).toBe('0.1s');
  });

  it('shows whole seconds under one minute', () => {
    expect(formatDuration(4_000)).toBe('4s');
    expect(formatDuration(59_499)).toBe('59s'); // rounds down to 59
  });

  it('crosses into minutes at 60s and shows minutes + seconds in 1m to 59m', () => {
    // 59,999ms rounds to 60s, which falls into the minutes branch as 1m.
    expect(formatDuration(59_999)).toBe('1m');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(3_540_000)).toBe('59m');
  });

  it('shows hours + minutes for >= 1 hour', () => {
    // 3,700,000ms = 3,700s = 61.67min → 1h 1m
    expect(formatDuration(3_700_000)).toBe('1h 1m');
    // 3,720,000ms = 3,720s = 62min → 1h 2m
    expect(formatDuration(3_720_000)).toBe('1h 2m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('returns "?" for invalid input', () => {
    expect(formatDuration(NaN)).toBe('?');
    expect(formatDuration(-100)).toBe('?');
    expect(formatDuration(Infinity)).toBe('?');
  });
});
