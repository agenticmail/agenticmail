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

  const masterKey = opts.masterKey ?? onDisk.masterKey ?? '';

  return {
    apiUrl: opts.apiUrl ?? defaultApiUrl,
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
