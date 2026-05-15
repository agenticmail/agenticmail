import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => testHome };
});

import { getOperatorEmail, setOperatorEmail, operatorPrefsStoragePath } from '../operator-prefs.js';

beforeEach(() => { testHome = mkdtempSync(join(tmpdir(), 'amop-')); });
afterEach(() => { rmSync(testHome, { recursive: true, force: true }); });

describe('operator-prefs', () => {
  it('returns null when no record exists', () => {
    expect(getOperatorEmail()).toBeNull();
  });

  it('round-trips an email', () => {
    setOperatorEmail('ope@gmail.com');
    expect(getOperatorEmail()).toBe('ope@gmail.com');
  });

  it('trims surrounding whitespace', () => {
    setOperatorEmail('  ope@gmail.com  ');
    expect(getOperatorEmail()).toBe('ope@gmail.com');
  });

  it('clears with empty string', () => {
    setOperatorEmail('ope@gmail.com');
    setOperatorEmail('');
    expect(getOperatorEmail()).toBeNull();
  });

  it('clears with null', () => {
    setOperatorEmail('ope@gmail.com');
    setOperatorEmail(null);
    expect(getOperatorEmail()).toBeNull();
  });

  it('rejects an address without an @', () => {
    expect(() => setOperatorEmail('not-an-email')).toThrow(/must contain an @/);
  });

  it('survives a corrupt storage file', () => {
    setOperatorEmail('ok@example.com');
    writeFileSync(operatorPrefsStoragePath(), '{ broken json');
    expect(getOperatorEmail()).toBeNull();
    // Next save recovers cleanly.
    setOperatorEmail('recovered@example.com');
    expect(getOperatorEmail()).toBe('recovered@example.com');
  });

  it('updates rather than appends on second save', () => {
    setOperatorEmail('first@example.com');
    setOperatorEmail('second@example.com');
    expect(getOperatorEmail()).toBe('second@example.com');
  });
});
