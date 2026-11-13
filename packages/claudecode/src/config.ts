/**
 * Resolves a fully-populated ClaudeCodeIntegrationConfig from defaults +
 * overrides + the on-disk AgenticMail config (~/.agenticmail/config.json).
 *
 * Reading the master key from disk lives here (not in install.ts) so tests
 * can supply config inline without touching the filesystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeCodeIntegrationConfig } from './types.js';

const AGENTICMAIL_CONFIG_PATH = join(homedir(), '.agenticmail', 'config.json');

/** Public options for resolveConfig — everything is optional and overrides defaults. */
export interface ResolveConfigOptions {
  apiUrl?: string;
  masterKey?: string;
  claudeConfigPath?: string;
  claudeSettingsPath?: string;
  agentsDir?: string;
  mcpServerName?: string;
  bridgeAgentName?: string;
  subagentPrefix?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  /**
   * Override path to AgenticMail's config.json (defaults to
   * ~/.agenticmail/config.json). Mainly useful in tests.
   */
  agenticmailConfigPath?: string;
}

interface AgenticMailOnDiskConfig {
  masterKey?: string;
  api?: { port?: number; host?: string };
}

/**
 * Look up AgenticMail's on-disk config and pull out the bits we need
 * (master key, default API URL). Missing file is fine — the caller can
 * still pass everything explicitly.
 */
function readAgenticMailConfig(path: string): AgenticMailOnDiskConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgenticMailOnDiskConfig;
  } catch {
    return {};
  }
}

/**
 * Pick the MCP server invocation command.
 *
 * Preference:
 *   1. Explicit override.
 *   2. `agenticmail-mcp` on PATH (installed globally via `npm install -g @agenticmail/mcp`).
 *      → command="agenticmail-mcp", args=[]
 *   3. Fallback: `npx -y @agenticmail/mcp`.
 *      → command="npx", args=["-y", "@agenticmail/mcp"]
 *
 * We do NOT shell out to `which` here because the resolver is called during
 * config building, which must be cheap and side-effect-free. The npx fallback
 * works everywhere; agenticmail-mcp on PATH is a perf optimisation users get
 * for free once they `npm install -g @agenticmail/mcp`.
 */
function defaultMcpInvocation(): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', '@agenticmail/mcp'] };
}

/**
 * True when `apiUrl` points at the configured AgenticMail API or at a
 * loopback address. Anything unparsable is treated as foreign.
 */
export function isConfiguredOrLoopbackApi(apiUrl: string, configuredApiUrl: string): boolean {
  let u: URL;
  try { u = new URL(apiUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  try {
    const c = new URL(configuredApiUrl);
    if (u.protocol === c.protocol && u.host.toLowerCase() === c.host.toLowerCase()) return true;
  } catch { /* fall through to the loopback test */ }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function resolveConfig(opts: ResolveConfigOptions = {}): ClaudeCodeIntegrationConfig {
  const amConfigPath = opts.agenticmailConfigPath ?? AGENTICMAIL_CONFIG_PATH;
  const onDisk = readAgenticMailConfig(amConfigPath);

  const apiHost = onDisk.api?.host ?? '127.0.0.1';
  // Fallback port matches @agenticmail/core's default. Should rarely be
  // hit in practice — if AgenticMail is set up, its config.json carries
  // the real port. See the comment in core's config.ts for why 3829.
  const apiPort = onDisk.api?.port ?? 3829;
  const defaultApiUrl = `http://${apiHost}:${apiPort}`;

  const defaultInvocation = defaultMcpInvocation();

  const apiUrl = opts.apiUrl ?? defaultApiUrl;
  // The on-disk master key is only ever paired with the configured local
  // API (or a loopback URL). A caller-chosen remote apiUrl must bring its
  // own key — otherwise anything that can influence apiUrl could make us
  // send our master key to a host it controls as a Bearer token.
  const masterKey = opts.masterKey
    ?? (isConfiguredOrLoopbackApi(apiUrl, defaultApiUrl) ? onDisk.masterKey : undefined)
    ?? '';

  return {
    apiUrl,
    masterKey,
    claudeConfigPath: opts.claudeConfigPath ?? join(homedir(), '.claude.json'),
    claudeSettingsPath: opts.claudeSettingsPath ?? join(homedir(), '.claude', 'settings.json'),
    agentsDir: opts.agentsDir ?? join(homedir(), '.claude', 'agents'),
    mcpServerName: opts.mcpServerName ?? 'agenticmail',
    bridgeAgentName: opts.bridgeAgentName ?? 'claudecode',
    subagentPrefix: opts.subagentPrefix ?? 'agenticmail-',
    mcpCommand: opts.mcpCommand ?? defaultInvocation.command,
    mcpArgs: opts.mcpArgs ?? defaultInvocation.args,
  };
}
