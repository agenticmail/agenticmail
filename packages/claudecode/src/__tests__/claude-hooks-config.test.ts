/**
 * Tests for the ~/.claude/settings.json hook upsert / remove helpers.
 *
 * Each test runs against a real on-disk temp file so we exercise the
 * atomic write path too. The helpers must:
 *   - Register the AgenticMail mail-hook on BOTH UserPromptSubmit
 *     and PreToolUse events.
 *   - Preserve any other hooks the user has installed on those events.
 *   - Be idempotent — re-running with the same command is a no-op.
 *   - Cleanly remove ONLY our entries on uninstall.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertMailHook, removeMailHook } from '../claude-hooks-config.js';

let tmp = '';
let settingsPath = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agenticmail-hooks-test-'));
  settingsPath = join(tmp, 'settings.json');
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function readJson(): any {
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

describe('upsertMailHook', () => {
  it('creates settings.json with the hook registered on both events', () => {
    const changed = upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks).toBeDefined();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('agenticmail-mail-hook');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('agenticmail-mail-hook');
  });

  it('is idempotent — re-upsert with same command does nothing', () => {
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const changed = upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    expect(changed).toBe(false);
  });

  it('updates the command if it changes (user installs from a different path)', () => {
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const changed = upsertMailHook(settingsPath, '/usr/local/bin/agenticmail-mail-hook');
    expect(changed).toBe(true);
    expect(readJson().hooks.UserPromptSubmit[0].hooks[0].command).toBe('/usr/local/bin/agenticmail-mail-hook');
    expect(readJson().hooks.PreToolUse[0].hooks[0].command).toBe('/usr/local/bin/agenticmail-mail-hook');
  });

  it('preserves user-owned hooks alongside ours', () => {
    // User has their own typescript-lsp PreToolUse hook.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'typescript-check' }] },
        ],
      },
    }));
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const s = readJson();
    // Both hooks coexist.
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse.some((r: any) => r.hooks[0].command === 'typescript-check')).toBe(true);
    expect(s.hooks.PreToolUse.some((r: any) => r.hooks[0].command === 'agenticmail-mail-hook')).toBe(true);
  });

  it('preserves unrelated top-level settings keys', () => {
    writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      model: 'sonnet',
      hooks: {},
    }));
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const s = readJson();
    expect(s.theme).toBe('dark');
    expect(s.model).toBe('sonnet');
  });

  it('throws on a corrupted settings.json rather than silently overwriting', () => {
    writeFileSync(settingsPath, 'not valid json {{{');
    expect(() => upsertMailHook(settingsPath, 'agenticmail-mail-hook'))
      .toThrow(/Could not parse/);
  });
});

describe('removeMailHook', () => {
  it('removes our hook from both events and cleans up empty branches', () => {
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const changed = removeMailHook(settingsPath);
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks).toBeUndefined();
  });

  it('preserves other UserPromptSubmit / PreToolUse hooks the user installed', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'other-hook' }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'typescript-check' }] },
        ],
      },
    }));
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    removeMailHook(settingsPath);
    const s = readJson();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-hook');
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('typescript-check');
  });

  it('returns false when the file does not exist', () => {
    expect(removeMailHook(settingsPath)).toBe(false);
  });

  it('returns false when our hook was never installed', () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    expect(removeMailHook(settingsPath)).toBe(false);
  });

  it('is identifying by marker substring (full path or bin name both work)', () => {
    // Old install used a full path; new uninstall sees the marker
    // substring in any form and removes correctly.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: '/Users/ope/.npm/global/bin/agenticmail-mail-hook' }] },
        ],
      },
    }));
    expect(removeMailHook(settingsPath)).toBe(true);
    expect(readJson().hooks).toBeUndefined();
  });
});
