/**
 * Resolves a fully-populated CodexIntegrationConfig from defaults + overrides
 * + the on-disk AgenticMail config (~/.agenticmail/config.json).
 *
 * Reading the master key from disk lives here (not in install.ts) so tests
 * can supply config inline without touching the filesystem.
 *
 * # Codex vs Claude Code paths
 *
 * Claude Code keeps its global config at `~/.claude.json` (one JSON file)
 * and its hooks + settings at `~/.claude/settings.json`. Codex CLI is
 * structured differently:
 *
 *   ~/.codex/config.toml      — global config, including `[mcp_servers.*]`
 *                               and `features.multi_agent_v2.enabled`
 *   ~/.codex/hooks.json       — lifecycle hooks (separate file, not nested)
 *   ~/.codex/agents/<name>.toml — one TOML file per custom subagent
 *   ~/.codex/sessions/        — Codex's own thread rollouts (resumeThread)
 *
 * `CODEX_HOME` env var overrides `~/.codex`. We honour it the same way the
 * Codex CLI itself does in `codex-rs/core/src/config/mod.rs::resolve_codex_home`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexIntegrationConfig } from './types.js';

const AGENTICMAIL_CONFIG_PATH = join(homedir(), '.agenticmail', 'config.json');

/** Public options for resolveConfig — everything is optional and overrides defaults. */
export interface ResolveConfigOptions {
  apiUrl?: string;
  masterKey?: string;
  /** Override CODEX_HOME (defaults to env var or ~/.codex). */
  codexHome?: string;
  /** Override the agents directory inside CODEX_HOME (defaults to `<codexHome>/agents`). */
  agentsDir?: string;
  /** MCP server entry name in [mcp_servers.*]. Default: 'agenticmail'. */
  mcpServerName?: string;
  /** Name of the dedicated AgenticMail account that represents this Codex install. */
  bridgeAgentName?: string;
  /** Prefix for generated Codex subagent names. */
  subagentPrefix?: string;
  /** MCP server command + args (defaults to npx-fallback). */
  mcpCommand?: string;
  mcpArgs?: string[];
  /** Override path to AgenticMail's config.json (defaults to ~/.agenticmail/config.json). Tests use this. */
  agenticmailConfigPath?: string;
}

interface AgenticMailOnDiskConfig {
  masterKey?: string;
  api?: { port?: number; host?: string };
}

function readAgenticMailConfig(path: string): AgenticMailOnDiskConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgenticMailOnDiskConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the Codex home directory the same way the CLI does:
 *   1. Explicit override.
 *   2. $CODEX_HOME env var.
 *   3. ~/.codex.
 */
export function resolveCodexHome(override?: string): string {
  if (override) return override;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return join(homedir(), '.codex');
}

/**
 * MCP server invocation. Prefers `agenticmail-mcp` on PATH (when the user
 * has installed @agenticmail/mcp globally), falls back to `npx -y` so the
 * integration works without any prior setup.
 *
 * We don't shell out to `which` — this is called during config building and
 * must be cheap + side-effect-free. The npx fallback works everywhere.
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

export function resolveConfig(opts: ResolveConfigOptions = {}): CodexIntegrationConfig {
  const amConfigPath = opts.agenticmailConfigPath ?? AGENTICMAIL_CONFIG_PATH;
  const onDisk = readAgenticMailConfig(amConfigPath);

  const apiHost = onDisk.api?.host ?? '127.0.0.1';
  // Fallback port matches @agenticmail/core's default; should rarely be hit
  // in practice since the on-disk config.json carries the real port.
  const apiPort = onDisk.api?.port ?? 3829;
  const defaultApiUrl = `http://${apiHost}:${apiPort}`;

  const codexHome = resolveCodexHome(opts.codexHome);
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
    codexHome,
    codexConfigPath: join(codexHome, 'config.toml'),
    codexHooksPath: join(codexHome, 'hooks.json'),
    agentsDir: opts.agentsDir ?? join(codexHome, 'agents'),
    mcpServerName: opts.mcpServerName ?? 'agenticmail',
    bridgeAgentName: opts.bridgeAgentName ?? 'codex',
    subagentPrefix: opts.subagentPrefix ?? 'agenticmail-',
    mcpCommand: opts.mcpCommand ?? defaultInvocation.command,
    mcpArgs: opts.mcpArgs ?? defaultInvocation.args,
  };
}
