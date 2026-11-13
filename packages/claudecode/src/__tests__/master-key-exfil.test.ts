/**
 * GHSA-4x3j-9wxx-863h / GHSA-cpgx-gj4r-pf3w / GHSA-vm2m-87j8-8w9m:
 * the on-disk master key must never be sent to a caller-chosen apiUrl.
 *
 * Uses the REAL api.ts / config.ts / install.ts with a stubbed global
 * fetch that records every outbound request, so the assertion is on what
 * actually leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../pm2.js', () => ({
  DISPATCHER_PM2_NAME: 'agenticmail-claudecode-dispatcher',
  pm2Available: vi.fn(() => false),
  getDispatcherStatus: vi.fn(() => null),
  startDispatcher: vi.fn(() => ({ started: false, reason: 'pm2 mocked in tests' })),
  stopDispatcher: vi.fn(() => ({ stopped: false })),
}));

import { install } from '../install.js';
import { resolveConfig } from '../config.js';

let dir: string;
let amCfgPath: string;
const calls: Array<{ url: string; auth: string | undefined }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-exfil-'));
  amCfgPath = join(dir, 'agenticmail.json');
  writeFileSync(amCfgPath, JSON.stringify({ masterKey: 'mk_on_disk_secret', api: { port: 3200, host: '127.0.0.1' } }), 'utf-8');
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.endsWith('/api/agenticmail/health')) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 500 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function opts(apiUrl: string) {
  return {
    apiUrl,
    agenticmailConfigPath: amCfgPath,
    claudeConfigPath: join(dir, '.claude.json'),
    claudeSettingsPath: join(dir, 'settings.json'),
    agentsDir: join(dir, 'agents'),
  };
}

describe('on-disk master key never leaves for a foreign apiUrl', () => {
  it('install against an attacker apiUrl sends no master key anywhere', async () => {
    await expect(install(opts('https://attacker.example'))).rejects.toThrow(/master key not found/i);
    for (const c of calls) expect(c.auth ?? '').not.toContain('mk_on_disk_secret');
    expect(calls.some(c => c.auth !== undefined)).toBe(false);
  });

  it('control: the configured local API does receive the key (proves the stub sees headers)', async () => {
    await expect(install(opts('http://127.0.0.1:3200'))).rejects.toThrow();
    expect(calls.some(c => c.url.startsWith('http://127.0.0.1:3200/') && c.auth === 'Bearer mk_on_disk_secret')).toBe(true);
  });

  it('resolveConfig pairs the on-disk key only with the configured or a loopback API', () => {
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath }).masterKey).toBe('mk_on_disk_secret');
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath, apiUrl: 'http://localhost:3200' }).masterKey).toBe('mk_on_disk_secret');
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath, apiUrl: 'http://attacker.example:9999' }).masterKey).toBe('');
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath, apiUrl: 'http://127.0.0.1.nip.io:3200' }).masterKey).toBe('');
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath, apiUrl: 'http://u:p@127.0.0.1:3200' }).masterKey).toBe('');
    // An explicitly supplied key is the caller's own — used as given.
    expect(resolveConfig({ agenticmailConfigPath: amCfgPath, apiUrl: 'https://remote.example', masterKey: 'mk_mine' }).masterKey).toBe('mk_mine');
  });
});
