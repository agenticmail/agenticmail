/**
 * Operator preferences — small per-installation knobs that don't fit
 * cleanly in the bootstrap-managed `~/.agenticmail/config.json`.
 *
 * Currently just `operatorEmail` for bridge-escalation alerts. The
 * intent is a tiny mutable surface the host agent (claudecode /
 * codex) can update via MCP without touching the read-only-after-
 * bootstrap config blob.
 *
 * # Storage
 *
 * `~/.agenticmail/operator-prefs.json`:
 *
 * ```json
 * { "version": 1, "operatorEmail": "ope@gmail.com" }
 * ```
 *
 * Atomic writes (tmp + rename), tolerant of missing / corrupt
 * files (returns null and lets the caller decide). Lazy path
 * resolution so tests can override `homedir()` per-test.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface OnDiskShape {
  version: 1;
  operatorEmail?: string;
}

function dir(): string { return join(homedir(), '.agenticmail'); }
function path(): string { return join(dir(), 'operator-prefs.json'); }

function readFile(): OnDiskShape {
  if (!existsSync(path())) return { version: 1 };
  try {
    const raw = readFileSync(path(), 'utf-8');
    if (!raw.trim()) return { version: 1 };
    const parsed = JSON.parse(raw) as Partial<OnDiskShape>;
    return { version: 1, operatorEmail: typeof parsed.operatorEmail === 'string' ? parsed.operatorEmail : undefined };
  } catch {
    // Corrupt — overwrite on next save.
    return { version: 1 };
  }
}

function writeFile(shape: OnDiskShape): void {
  const d = dir();
  const p = path();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const tmp = `${p}.agenticmail-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8');
  renameSync(tmp, p);
}

/** Returns the operator's escalation email, or null if not set. */
export function getOperatorEmail(): string | null {
  const shape = readFile();
  const email = shape.operatorEmail;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.includes('@') ? trimmed : null;
}

/**
 * Set (or clear) the operator's escalation email. Pass `null` /
 * empty string to clear. Returns the canonical stored value (trimmed,
 * lowercased local-part preserved as-is per RFC 5321).
 */
export function setOperatorEmail(email: string | null): string | null {
  const shape = readFile();
  if (!email || !email.trim()) {
    delete shape.operatorEmail;
    writeFile(shape);
    return null;
  }
  const trimmed = email.trim();
  if (!trimmed.includes('@')) {
    throw new Error('operator email must contain an @');
  }
  shape.operatorEmail = trimmed;
  writeFile(shape);
  return trimmed;
}

/** Exposed for tests + diagnostic CLI commands. */
export function operatorPrefsStoragePath(): string {
  return path();
}
