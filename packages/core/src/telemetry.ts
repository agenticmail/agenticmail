/**
 * AgenticMail Anonymous Telemetry
 *
 * Collects anonymous usage counts to help improve the product.
 * NO personal data, API keys, emails, or content is ever collected.
 *
 * Opt out: set AGENTICMAIL_TELEMETRY=0 or DO_NOT_TRACK=1
 *
 * What we collect:
 * - Tool call counts (which tools are popular)
 * - Package version
 * - Anonymous install ID (random UUID, no PII)
 * - OS platform (e.g. "darwin", "linux")
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { platform } from 'process';

const TELEMETRY_ENDPOINT = 'https://agenticmail.io/api/telemetry';
const BATCH_INTERVAL_MS = 60_000; // flush every 60 seconds
const MAX_BATCH_SIZE = 100; // flush if batch gets this big

interface TelemetryEvent {
  tool: string;
  ts: number;
}

let installId: string | null = null;
let packageVersion: string = 'unknown';
let disabled: boolean | null = null;
let batch: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

/** Check if telemetry is disabled */
function isDisabled(): boolean {
  if (disabled !== null) return disabled;
  disabled = (
    process.env.AGENTICMAIL_TELEMETRY === '0' ||
    process.env.AGENTICMAIL_TELEMETRY === 'false' ||
    process.env.DO_NOT_TRACK === '1' ||
    process.env.DO_NOT_TRACK === 'true' ||
    process.env.CI === 'true' // don't count CI runs
  );
  return disabled;
}

/** Get or create the anonymous install ID */
function getInstallId(): string {
  if (installId) return installId;

  try {
    const dir = join(homedir(), '.agenticmail');
    const idFile = join(dir, '.telemetry-id');

    if (existsSync(idFile)) {
      const id = readFileSync(idFile, 'utf8').trim();
      if (id && id.length > 10) {
        installId = id;
        return installId;
      }
    }

    // Generate new ID
    installId = randomUUID();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(idFile, installId, 'utf8');
    return installId;
  } catch {
    // If we can't persist, use a session-only ID
    installId = randomUUID();
    return installId;
  }
}

/** Set the package version for telemetry events */
export function setTelemetryVersion(version: string): void {
  packageVersion = version;
}

/** Record a tool call (fire-and-forget, never throws) */
export function recordToolCall(toolName: string): void {
  try {
    if (isDisabled()) return;

    batch.push({ tool: toolName, ts: Date.now() });

    // Flush if batch is full
    if (batch.length >= MAX_BATCH_SIZE) {
      flush();
      return;
    }

    // Schedule a flush if not already scheduled
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, BATCH_INTERVAL_MS);
      // Don't keep the process alive just for telemetry
      if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
        flushTimer.unref();
      }
    }
  } catch {
    // Never throw from telemetry
  }
}

/** Flush the current batch to the server */
function flush(): void {
  if (flushing || batch.length === 0) return;
  flushing = true;

  const events = batch;
  batch = [];

  // Aggregate: count calls per tool
  const toolCounts: Record<string, number> = {};
  for (const e of events) {
    toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
  }

  const payload = {
    id: getInstallId(),
    v: packageVersion,
    p: platform,
    tools: toolCounts,
    n: events.length, // total calls in this batch
  };

  // Fire and forget — never await, never throw
  fetch(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Silently ignore all errors
  }).finally(() => {
    flushing = false;
  });
}

/** Flush remaining events on process exit */
export function flushTelemetry(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

// Flush on exit (best effort)
try {
  process.on('beforeExit', flushTelemetry);
  process.on('SIGINT', flushTelemetry);
  process.on('SIGTERM', flushTelemetry);
} catch {
  // ignore — might not have process events in all environments
}
