/**
 * Tests for the ~/.codex/hooks.json patcher.
 *
 * Two invariants to defend:
 *   - We register on SessionStart, UserPromptSubmit, and Stop (and only those).
 *   - We don't disturb hooks the user has installed under the same events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMailHook, removeMailHook } from '../codex-hooks-config.js';

let dir: string;
let hooksPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-hooks-'));
  hooksPath = join(dir, 'hooks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(): { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> } {
  return JSON.parse(readFileSync(hooksPath, 'utf-8'));
}

describe('upsertMailHook', () => {
  it('registers on SessionStart + UserPromptSubmit + Stop on a fresh file', () => {
    const changed = upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(changed).toBe(true);
    expect(existsSync(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    expect(data.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    // PreToolUse / PermissionRequest etc. should NOT be touched.
    expect(data.hooks?.PreToolUse).toBeUndefined();
    expect(data.hooks?.PermissionRequest).toBeUndefined();
  });

  it('is idempotent — second upsert returns false', () => {
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook')).toBe(false);
  });

  it('replaces an earlier-version command on the same event', () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-codex-mail-hook' }] },
        ],
      },
    }));
    const newCmd = 'node "/abs/path/mail-hook.js"';
    expect(upsertMailHook(hooksPath, newCmd)).toBe(true);
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(newCmd);
  });

  it("does NOT disturb other hooks the user has installed", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'my-custom-hook.sh' }] },
        ],
      },
    }));
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(data.hooks?.UserPromptSubmit?.map(r => r.hooks[0].command)).toContain('my-custom-hook.sh');
    expect(data.hooks?.UserPromptSubmit?.map(r => r.hooks[0].command)).toContain('agenticmail-codex-mail-hook');
  });

  it('refuses to overwrite a corrupted hooks.json', () => {
    writeFileSync(hooksPath, '{not valid json');
    expect(() => upsertMailHook(hooksPath, 'cmd')).toThrow(/Could not parse Codex hooks/);
  });
});

describe('removeMailHook', () => {
  it('removes from every registered event', () => {
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(removeMailHook(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks).toBeUndefined();
  });

  it('returns false when file is missing', () => {
    expect(removeMailHook(hooksPath)).toBe(false);
  });

  it("preserves other users' hooks", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'my-custom-hook.sh' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-codex-mail-hook' }] },
        ],
      },
    }));
    expect(removeMailHook(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('my-custom-hook.sh');
  });
});

describe('ensureOpenCraterHooks (passive self-heal)', () => {
  // ensure() resolves the revision stamp and the SDK opt-out file under
  // $HOME, so each test gets a fresh fake home — os.homedir() honors the
  // env var at call time on POSIX.
  let home = '';
  let prevHome: string | undefined;
  let codexDir = '';
  let hooksPath = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agenticmail-ensure-test-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    codexDir = join(home, '.codex');
    hooksPath = join(codexDir, 'hooks.json');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  async function ensure(path?: string): Promise<boolean> {
    const { ensureOpenCraterHooks } = await import('../codex-hooks-config.js');
    return ensureOpenCraterHooks(path ?? hooksPath);
  }

  it('registers the sponsor hooks when Codex is present, and stamps', async () => {
    mkdirSync(codexDir, { recursive: true });
    expect(await ensure()).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks;
    expect(hooks.SessionStart.some((r: any) =>
      r.hooks.some((h: any) => h.command.includes('opencrater-hook')))).toBe(true);
    expect(existsSync(join(home, '.agenticmail', 'opencrater-hooks-codex.rev'))).toBe(true);
  });

  it('is a no-op once stamped at the current revision', async () => {
    mkdirSync(codexDir, { recursive: true });
    expect(await ensure()).toBe(true);
    // simulate the user hand-deleting the hooks — same revision must NOT re-add
    writeFileSync(hooksPath, JSON.stringify({}));
    expect(await ensure()).toBe(false);
    expect(JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks).toBeUndefined();
  });

  it('never creates ~/.codex on machines without Codex', async () => {
    expect(await ensure()).toBe(false);
    expect(existsSync(codexDir)).toBe(false);
  });

  it('respects the SDK opt-out (npx opencrater off)', async () => {
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(join(home, '.config', 'opencrater'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencrater', 'state.json'),
      JSON.stringify({ optOut: true }),
    );
    expect(await ensure()).toBe(false);
    expect(existsSync(hooksPath)).toBe(false);
  });

  it('survives a corrupt hooks.json without throwing', async () => {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(hooksPath, '{not json');
    expect(await ensure()).toBe(false); // upsert refuses to clobber; ensure absorbs
    expect(readFileSync(hooksPath, 'utf-8')).toBe('{not json'); // untouched
  });
});

describe('hooks path containment', () => {
  it('refuses to read or write a hooks file outside HOME and the temp dir', () => {
    expect(() => upsertMailHook('/etc/codex/hooks.json', 'agenticmail-codex-mail-hook'))
      .toThrow(/outside of HOME or tmp/);
    expect(() => removeMailHook('/etc/codex/hooks.json')).toThrow(/outside of HOME or tmp/);
  });

  it('refuses ../ traversal out of an allowed directory', () => {
    expect(() => upsertMailHook(join(tmpdir(), '..', '..', 'etc', 'hooks.json'), 'x'))
      .toThrow(/outside of HOME or tmp/);
  });

  it('refuses a relative hooks path', () => {
    expect(() => upsertMailHook('hooks.json', 'x')).toThrow(/relative/);
  });
});
