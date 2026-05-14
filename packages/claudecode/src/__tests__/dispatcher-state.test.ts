/**
 * Tests for ~/.agenticmail/dispatcher-state.json persistence.
 *
 * Each test gets its own tmpdir state path so they can run in parallel
 * without stomping on each other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatcherState } from '../dispatcher-state.js';

describe('DispatcherState', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatcher-state-'));
    path = join(dir, 'state.json');
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns undefined for unknown accounts on a fresh store', () => {
    const s = new DispatcherState({ path });
    expect(s.getCursor('does-not-exist')).toBeUndefined();
  });

  it('markSeen advances lastSeenUid monotonically and tracks recent UIDs', () => {
    const s = new DispatcherState({ path });
    s.markSeen('agent-1', 10);
    s.markSeen('agent-1', 11);
    s.markSeen('agent-1', 9);  // older — must NOT lower lastSeenUid
    const cursor = s.getCursor('agent-1')!;
    expect(cursor.lastSeenUid).toBe(11);
    // All three UIDs are remembered for IDLE-replay dedup.
    expect(cursor.seenUids.sort((a, b) => a - b)).toEqual([9, 10, 11]);
  });

  it('flushNow writes the state file atomically and survives a reload', () => {
    const a = new DispatcherState({ path });
    a.markSeen('agent-1', 42);
    a.markSeen('agent-2', 100);
    a.flushNow();
    expect(existsSync(path)).toBe(true);

    const b = new DispatcherState({ path });
    expect(b.getCursor('agent-1')?.lastSeenUid).toBe(42);
    expect(b.getCursor('agent-2')?.lastSeenUid).toBe(100);
    expect(b.getCursor('agent-2')?.seenUids).toContain(100);
  });

  it('corrupt JSON on disk falls back to an empty store instead of throwing', () => {
    // Write garbage to the path before instantiating.
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, '{not valid json');
    expect(() => new DispatcherState({ path })).not.toThrow();
    const s = new DispatcherState({ path });
    expect(s.knownAccounts()).toEqual([]);
  });

  it('drops malformed cursor entries during load (defensive)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    // version is correct, but one entry has the wrong shape.
    fs.writeFileSync(path, JSON.stringify({
      version: 1,
      savedAtMs: 0,
      accounts: {
        ok: { lastSeenUid: 5, seenUids: [3, 4, 5] },
        broken: { not: 'a cursor' },
      },
    }));
    const s = new DispatcherState({ path });
    expect(s.getCursor('ok')?.lastSeenUid).toBe(5);
    expect(s.getCursor('broken')).toBeUndefined();
  });

  it('forget(accountId) removes the cursor and persists on next flush', () => {
    const s = new DispatcherState({ path });
    s.markSeen('agent-1', 5);
    s.markSeen('agent-2', 9);
    s.flushNow();
    s.forget('agent-1');
    s.flushNow();

    const reloaded = new DispatcherState({ path });
    expect(reloaded.getCursor('agent-1')).toBeUndefined();
    expect(reloaded.getCursor('agent-2')?.lastSeenUid).toBe(9);
  });

  it('caps seenUids history to keep the file small', () => {
    const s = new DispatcherState({ path });
    for (let uid = 1; uid <= 400; uid++) s.markSeen('agent-1', uid);
    s.flushNow();
    const json = JSON.parse(readFileSync(path, 'utf8'));
    // Cap is internal (SEEN_UIDS_CAP=256) — assert <= 300 as a safety net.
    expect(json.accounts['agent-1'].seenUids.length).toBeLessThanOrEqual(300);
    // The newest UIDs MUST be in the kept window — that's the whole
    // point of the bound (we'd rather drop ancient UIDs than recent).
    const kept = json.accounts['agent-1'].seenUids;
    expect(kept).toContain(400);
    expect(kept).toContain(399);
    // lastSeenUid is still the global maximum regardless of bounding.
    expect(json.accounts['agent-1'].lastSeenUid).toBe(400);
  });
});
