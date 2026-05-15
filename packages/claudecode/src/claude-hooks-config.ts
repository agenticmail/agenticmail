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

/**
 * Identify a hook command as ours. We accept BOTH historical forms so
 * upgrades from any prior version converge to the current shape:
 *
 *   - `agenticmail-mail-hook`            — bare bin name (0.8.22-0.8.24)
 *   - `node "...mail-hook.js"`           — absolute path (0.8.25+)
 *
 * The absolute-path form fixes the `command not found` errors that
 * fired on every Stop / UserPromptSubmit hook when the npm global bin
 * dir wasn't on the user's $PATH. The marker matches either substring
 * so old installs auto-heal to the new shape on the next upsert.
 */
function isAgenticMailHookCommand(command: string): boolean {
  if (typeof command !== 'string') return false;
  return command.includes('agenticmail-mail-hook') || command.includes('mail-hook.js');
}

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
    Stop?: ClaudeHookRule[];
    PreToolUse?: ClaudeHookRule[];
    SessionStart?: ClaudeHookRule[];
    [event: string]: ClaudeHookRule[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Hook events the AgenticMail mail-hook is registered on.
 *
 * Three events, each with a schema-correct output shape:
 *
 *   - **SessionStart** — fires on `startup`, `resume`, AND `compact`.
 *     Output uses `hookSpecificOutput.additionalContext` to inject
 *     the AgenticMail capabilities blurb so the model knows the
 *     toolbelt is available BEFORE it sees any user prompt.
 *     Critically also fires after auto-compaction — session_id
 *     stays the same across compact, so a "once per session_id"
 *     dedup elsewhere would silently swallow the re-inject the
 *     model needs after its context was wiped. SessionStart fires
 *     explicitly, so we re-emit cleanly.
 *
 *   - **UserPromptSubmit** — fires on every user prompt in the
 *     interactive REPL. Output uses
 *     `hookSpecificOutput.additionalContext` to inject a
 *     "you have new bridge mail" preamble before Claude reasons
 *     about the user's prompt. Catches the interactive case.
 *     Also serves as a FALLBACK channel for the capabilities
 *     blurb in case SessionStart didn't fire (older Claude Code
 *     builds, edge cases) — dedup'd per session_id so it's a
 *     no-op once SessionStart has already done its job.
 *
 *   - **Stop** — fires when Claude was about to end a turn. Output
 *     uses `decision: 'block'` + `reason` to force Claude to
 *     continue when there's unread bridge mail. This is the
 *     **autonomous-mode awareness** mechanism — long-running
 *     Claude Code sessions (headless or remotely-controlled)
 *     where `UserPromptSubmit` never fires now still wake on
 *     teammate replies at every natural turn boundary.
 *
 * All three event types are supported by Claude Code's hook system
 * and use the supported output schema for that event — no
 * "PreToolUse:Read hook error" spam like 0.8.22.
 *
 * # Why HOOK_EVENTS_TO_REMOVE is a superset
 *
 * Anyone who installed 0.8.22 has a leftover `PreToolUse` entry in
 * their settings.json — `removeMailHook` walks a removal superset
 * that includes historical events so upgrades clean themselves up
 * automatically.
 */
const HOOK_EVENTS_TO_REGISTER = ['UserPromptSubmit', 'Stop', 'SessionStart'] as const;
const HOOK_EVENTS_TO_REMOVE = ['UserPromptSubmit', 'Stop', 'PreToolUse', 'SessionStart'] as const;
type HookEvent =
  | typeof HOOK_EVENTS_TO_REGISTER[number]
  | typeof HOOK_EVENTS_TO_REMOVE[number];

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

  // Add to the supported event(s).
  for (const event of HOOK_EVENTS_TO_REGISTER) {
    if (upsertOneEvent(settings.hooks, event, command)) changed = true;
  }

  // Clean up any historical event registrations that aren't in the
  // current supported set — this is what heals existing 0.8.22
  // installs when the user upgrades, removing their broken PreToolUse
  // entry without forcing a manual uninstall+reinstall.
  for (const event of HOOK_EVENTS_TO_REMOVE) {
    if ((HOOK_EVENTS_TO_REGISTER as readonly string[]).includes(event)) continue;
    if (removeOneEvent(settings.hooks, event)) changed = true;
  }

  if (changed) writeSettings(path, settings);
  return changed;
}

function removeOneEvent(
  hooks: NonNullable<ClaudeSettingsShape['hooks']>,
  event: HookEvent,
): boolean {
  const list = hooks[event] ?? [];
  if (list.length === 0) return false;
  const filtered = list.filter(rule =>
    !rule.hooks?.some(h => isAgenticMailHookCommand(h.command)),
  );
  if (filtered.length === list.length) return false;
  if (filtered.length === 0) delete hooks[event];
  else hooks[event] = filtered;
  return true;
}

function upsertOneEvent(
  hooks: NonNullable<ClaudeSettingsShape['hooks']>,
  event: HookEvent,
  command: string,
): boolean {
  const list = hooks[event] ?? [];

  const isOurs = (rule: ClaudeHookRule): boolean =>
    rule.hooks?.some(h => isAgenticMailHookCommand(h.command)) ?? false;

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
  for (const event of HOOK_EVENTS_TO_REMOVE) {
    if (removeOneEvent(settings.hooks, event)) changed = true;
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
