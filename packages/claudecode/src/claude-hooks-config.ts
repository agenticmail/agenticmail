/**
 * Read / write / patch ~/.claude/settings.json — the file where Claude
 * Code stores user-level configuration including the hooks registry.
 *
 * This is a DIFFERENT file from ~/.claude.json (which `claude-config.ts`
 * handles). The split is Claude Code's design:
 *
 *   ~/.claude.json            → OAuth state, MCP servers, project list
 *   ~/.claude/settings.json   → user preferences, theme, hooks
 *
 * We touch exactly two keys here, and only inside the `hooks` block:
 *
 *   hooks.UserPromptSubmit  → the AgenticMail mail-hook registration
 *
 * Everything else in the file is preserved verbatim.
 *
 * # Hook config schema (Claude Code's format)
 *
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [
 *         {
 *           "matcher": "",
 *           "hooks": [
 *             { "type": "command", "command": "agenticmail-mail-hook" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * The outer array is "rules" — each rule has a matcher and one or more
 * commands. We add our own rule with a stable identifying marker so we
 * can find and replace (or remove) it without disturbing other hooks
 * the user may have installed (e.g. a typescript-lsp hook).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** Stable identifying marker for the hook entry we own. */
const AGENTICMAIL_HOOK_MARKER = 'agenticmail-mail-hook';

interface ClaudeHookCommand {
  type: 'command';
  command: string;
}

interface ClaudeHookRule {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

interface ClaudeSettingsShape {
  hooks?: {
    UserPromptSubmit?: ClaudeHookRule[];
    PreToolUse?: ClaudeHookRule[];
    [event: string]: ClaudeHookRule[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Hook events we register the AgenticMail mail-hook on. Two events
 * because Claude Code can be in two distinct modes:
 *
 *   - **UserPromptSubmit** — fires when the user types a prompt. Catches
 *     mail in the time-between-turns case. The lightest, most natural
 *     wake point — user is interacting, the hook context lands cleanly.
 *
 *   - **PreToolUse** — fires before every tool call. Catches mail
 *     during *autonomous* runs where Claude is working for minutes
 *     or hours without a user typing (think: long agentic build,
 *     remote-control via API, scheduled run). Without this, an
 *     autonomous Claude session would never see sub-agent replies
 *     until the user came back and typed something.
 *
 *     The hook is rate-limited internally to one API check per 30s
 *     so a burst of tool calls doesn't hammer the AgenticMail server.
 */
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse'] as const;
type HookEvent = typeof HOOK_EVENTS[number];

function readSettings(path: string): ClaudeSettingsShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ClaudeSettingsShape;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse Claude Code settings at ${path}: ${(err as Error).message}. ` +
      `Refusing to overwrite — please fix the file by hand and retry.`,
    );
  }
}

function writeSettings(path: string, settings: ClaudeSettingsShape): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(settings, null, 2) + '\n';
  const tmp = `${path}.agenticmail-tmp`;
  writeFileSync(tmp, text, 'utf-8');
  // Atomic POSIX rename → never leaves a half-written settings file.
  // A corrupted settings.json doesn't log you out, but it CAN crash
  // Claude Code on startup until you fix it by hand, so we're careful.
  renameSync(tmp, path);
}

/**
 * Insert (or replace) the AgenticMail mail-hook on every relevant
 * Claude Code event. Returns `true` if the file changed.
 *
 * The `command` parameter is the shell command to execute on each
 * fire — typically just the bin name `agenticmail-mail-hook` (which
 * resolves via $PATH after npm globally installs the package), but
 * can be a full path for tests or unusual setups.
 *
 * Each event gets its own rule with an empty `matcher` (matches all),
 * and the rule is identified for upsert/remove via the
 * `AGENTICMAIL_HOOK_MARKER` substring in the command. That way users
 * can add their own UserPromptSubmit / PreToolUse hooks alongside
 * ours and we don't disturb each other.
 */
export function upsertMailHook(path: string, command: string): boolean {
  const settings = readSettings(path);
  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const event of HOOK_EVENTS) {
    if (upsertOneEvent(settings.hooks, event, command)) changed = true;
  }

  if (changed) writeSettings(path, settings);
  return changed;
}

function upsertOneEvent(
  hooks: NonNullable<ClaudeSettingsShape['hooks']>,
  event: HookEvent,
  command: string,
): boolean {
  const list = hooks[event] ?? [];

  const isOurs = (rule: ClaudeHookRule): boolean =>
    rule.hooks?.some(h => typeof h.command === 'string' && h.command.includes(AGENTICMAIL_HOOK_MARKER)) ?? false;

  const desired: ClaudeHookRule = {
    matcher: '',  // empty = match every fire of this event
    hooks: [{ type: 'command', command }],
  };

  const existingIdx = list.findIndex(isOurs);
  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    if (
      existing.matcher === desired.matcher &&
      existing.hooks.length === desired.hooks.length &&
      existing.hooks.every((h, i) => h.command === desired.hooks[i].command)
    ) {
      return false;
    }
    list[existingIdx] = desired;
  } else {
    list.push(desired);
  }
  hooks[event] = list;
  return true;
}

/**
 * Remove the AgenticMail mail-hook from every Claude Code event we
 * registered it on. Only our rules are touched — any other hooks the
 * user has installed under the same events are preserved.
 *
 * Returns `true` if the file changed.
 */
export function removeMailHook(path: string): boolean {
  if (!existsSync(path)) return false;
  const settings = readSettings(path);
  if (!settings.hooks) return false;

  let changed = false;
  for (const event of HOOK_EVENTS) {
    const list = settings.hooks[event] ?? [];
    if (list.length === 0) continue;
    const filtered = list.filter(rule =>
      !rule.hooks?.some(h => typeof h.command === 'string' && h.command.includes(AGENTICMAIL_HOOK_MARKER)),
    );
    if (filtered.length === list.length) continue; // nothing to remove for this event

    if (filtered.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = filtered;
    }
    changed = true;
  }

  // Tidy up: drop the empty hooks key if nothing's left.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) writeSettings(path, settings);
  return changed;
}

// Back-compat aliases so existing callers (install.ts, uninstall.ts)
// keep working without an import-site rename.
export const upsertUserPromptSubmitHook = upsertMailHook;
export const removeUserPromptSubmitHook = removeMailHook;
