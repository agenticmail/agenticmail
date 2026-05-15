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
  it('registers on UserPromptSubmit, Stop, and SessionStart — not PreToolUse', () => {
    // We register on three events. UserPromptSubmit catches the
    // interactive case. Stop is the autonomous-mode awareness fix
    // (long headless runs where no user prompts fire) and returns
    // `decision: 'block'` + `reason`. SessionStart fires on startup
    // + resume + AUTO-COMPACT — it's how we re-inject the
    // AgenticMail capabilities blurb when Claude's context gets
    // wiped mid-session. PreToolUse is intentionally NOT in the
    // set; its schema rejects additionalContext (that's what
    // produced the noisy `PreToolUse:tool-name hook error` in
    // 0.8.22).
    const changed = upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks).toBeDefined();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('agenticmail-mail-hook');
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('agenticmail-mail-hook');
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('agenticmail-mail-hook');
    expect(s.hooks.PreToolUse).toBeUndefined();
  });

  it('accepts an absolute-path mail-hook command (0.8.25+ shape)', () => {
    // 0.8.25 stopped registering the bare `agenticmail-mail-hook` bin
    // name (it failed silently when the npm global bin dir wasn't on
    // $PATH) and switched to an absolute `node "..../mail-hook.js"`
    // form. The marker matcher must recognise this so upsert is
    // idempotent on a 0.8.25-shaped install.
    const cmd = 'node "/usr/local/lib/node_modules/@agenticmail/claudecode/dist/mail-hook.js"';
    upsertMailHook(settingsPath, cmd);
    const changed = upsertMailHook(settingsPath, cmd);
    expect(changed).toBe(false);
    const s = readJson();
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe(cmd);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(cmd);
  });

  it('heals a 0.8.24-shaped install by upgrading the bare-name command to absolute path', () => {
    // Simulate an existing 0.8.24 install where the hook is registered
    // by bare bin name (which is what produced the `command not found`
    // errors when npm global bin wasn't on $PATH). Upsert with the new
    // absolute-path form should REPLACE the bare entry, not duplicate.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-mail-hook' }] },
        ],
      },
    }));
    const newCmd = 'node "/abs/path/mail-hook.js"';
    const changed = upsertMailHook(settingsPath, newCmd);
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe(newCmd);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(newCmd);
  });

  it('heals a 0.8.22-style install by removing the leftover PreToolUse entry', () => {
    // Simulate an existing 0.8.22 install with PreToolUse registered.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-mail-hook' }] },
        ],
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-mail-hook' }] },
        ],
      },
    }));
    const changed = upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    // The UserPromptSubmit entry is identical so no-op there; the
    // PreToolUse entry should get cleaned up → file changed.
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.PreToolUse).toBeUndefined();
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
  });

  it('preserves user-owned hooks alongside ours', () => {
    // User has their own typescript-lsp PreToolUse hook and a custom
    // UserPromptSubmit hook. Both must survive AgenticMail install.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'typescript-check' }] },
        ],
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'my-custom-prompt-hook' }] },
        ],
      },
    }));
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const s = readJson();
    // User's PreToolUse hook still there, untouched.
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('typescript-check');
    // User's UserPromptSubmit hook coexists with ours.
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit.some((r: any) => r.hooks[0].command === 'my-custom-prompt-hook')).toBe(true);
    expect(s.hooks.UserPromptSubmit.some((r: any) => r.hooks[0].command === 'agenticmail-mail-hook')).toBe(true);
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
  it('removes our hook and cleans up empty branches', () => {
    upsertMailHook(settingsPath, 'agenticmail-mail-hook');
    const changed = removeMailHook(settingsPath);
    expect(changed).toBe(true);
    const s = readJson();
    expect(s.hooks).toBeUndefined();
  });

  it('cleans up a legacy PreToolUse entry from a 0.8.22 install', () => {
    // Simulate a leftover 0.8.22-shape install that current install
    // would have healed. Uninstall must also strip it.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-mail-hook' }] },
        ],
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-mail-hook' }] },
        ],
      },
    }));
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
