/**
 * Uninstall AgenticMail from Claude Code.
 *
 * Reverses everything install() did, in the opposite order, with one
 * deliberate exception: we keep the bridge agent in AgenticMail by default.
 *
 * Why?  The bridge agent owns an inbox, may have ongoing conversations, and
 * may be referenced from other agents' contact lists. Silently deleting it
 * during a Claude Code uninstall is destructive in a way users would not
 * expect. Pass { purgeBridgeAgent: true } if you really want it gone.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deleteAccount, getAccountByName } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { removeMcpServer } from './claude-config.js';
import { removeUserPromptSubmitHook } from './claude-hooks-config.js';
import { MANAGED_BY_MARKER } from './subagent-template.js';
import { stopDispatcher } from './pm2.js';
import type { UninstallResult } from './types.js';

export interface UninstallOptions extends ResolveConfigOptions {
  /**
   * Also delete the bridge agent from AgenticMail. Default false — see header
   * comment. Setting this to true is irreversible (the agent's API key, inbox
   * folder layout, and contact references will all be invalidated).
   */
  purgeBridgeAgent?: boolean;
}

/**
 * Walk the agents dir, remove every .md we own, return their names.
 *
 * The prefix is taken verbatim (lower-cased) — we deliberately do NOT pass
 * it through the basename sanitizer, which strips trailing dashes and
 * would otherwise cause the matcher to swallow files with similar names.
 */
function removeOwnedSubagents(agentsDir: string, prefix: string): string[] {
  if (!existsSync(agentsDir)) return [];
  const safePrefix = prefix.toLowerCase();
  const removed: string[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    if (!file.toLowerCase().startsWith(safePrefix)) continue;
    const full = join(agentsDir, file);
    let head: string;
    try { head = readFileSync(full, 'utf-8').slice(0, 1024); } catch { continue; }
    if (!head.includes(MANAGED_BY_MARKER)) continue; // user-owned, hands off
    try { unlinkSync(full); removed.push(file); } catch { /* best effort */ }
  }
  return removed;
}

export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const cfg = resolveConfig(opts);

  const mcpBlockRemoved = removeMcpServer(cfg.claudeConfigPath, cfg.mcpServerName);
  const removedSubagents = removeOwnedSubagents(cfg.agentsDir, cfg.subagentPrefix);
  // Pull the mail-hook out of settings.json too — fires on both
  // UserPromptSubmit (user turns) and PreToolUse (autonomous work).
  let hookRemoved = false;
  try { hookRemoved = removeUserPromptSubmitHook(cfg.claudeSettingsPath); }
  catch { /* best-effort */ }

  // Stop the dispatcher daemon if it's running. We do this BEFORE deleting
  // the bridge agent so the dispatcher doesn't see a transient
  // account-disappeared event mid-shutdown.
  const dispatcherStopped = stopDispatcher().stopped;

  let bridgeAgentDeleted = false;
  if (opts.purgeBridgeAgent && cfg.masterKey) {
    try {
      const bridge = await getAccountByName(cfg.apiUrl, cfg.masterKey, cfg.bridgeAgentName);
      if (bridge) {
        await deleteAccount(cfg.apiUrl, cfg.masterKey, bridge.id);
        bridgeAgentDeleted = true;
      }
    } catch {
      // We tried — leave the bridge dangling rather than fail the whole uninstall.
      // The user can clean it up by hand via `agenticmail` (the shell).
    }
  }

  return {
    changed: mcpBlockRemoved || removedSubagents.length > 0 || bridgeAgentDeleted || dispatcherStopped || hookRemoved,
    removedSubagents,
    mcpBlockRemoved,
    bridgeAgentDeleted,
    dispatcherStopped,
  };
}
