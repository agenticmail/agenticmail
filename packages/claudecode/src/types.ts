/**
 * Shared types for the @agenticmail/claudecode package.
 *
 * Kept in one file so the install / uninstall / status / discovery modules can
 * import a single source of truth without circular deps.
 */

/** An AgenticMail account as returned by `GET /api/agenticmail/accounts`. */
export interface AgenticMailAccount {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

/** Resolved configuration for everything the package does. */
export interface ClaudeCodeIntegrationConfig {
  /** AgenticMail master API URL. */
  apiUrl: string;
  /** AgenticMail master key (mk_…). */
  masterKey: string;
  /** Path to Claude Code's user-level config (typically ~/.claude.json). */
  claudeConfigPath: string;
  /**
   * Path to Claude Code's user-level settings (typically
   * ~/.claude/settings.json) where hooks are registered. Different
   * file from `claudeConfigPath` — Claude Code splits OAuth/MCP state
   * from preference/hook state, and so do we.
   */
  claudeSettingsPath: string;
  /** Directory where per-agent Claude Code subagent .md files live (typically ~/.claude/agents). */
  agentsDir: string;
  /** Key under mcpServers in Claude Code's config. */
  mcpServerName: string;
  /** Name of the dedicated AgenticMail agent that represents Claude Code. */
  bridgeAgentName: string;
  /** Prefix for generated subagent names — produces e.g. `agenticmail-fola`. */
  subagentPrefix: string;
  /**
   * Command used to invoke the AgenticMail MCP server.
   * Defaults to the globally-installed `agenticmail-mcp` bin; falls back to
   * `npx -y @agenticmail/mcp` for portability.
   */
  mcpCommand: string;
  mcpArgs: string[];
}

/** Snapshot of the installation state — used by `status`. */
export interface InstallStatus {
  state: 'installed' | 'not_installed' | 'partial';
  /** Whether the MCP server block is present in Claude Code config. */
  mcpInstalled: boolean;
  /** Bridge agent (Claude Code's identity inside AgenticMail) exists. */
  bridgeAgentExists: boolean;
  /** Subagent .md files currently present, keyed by AgenticMail agent name. */
  subagents: string[];
  /** Path to Claude Code config (so the user knows what we touched). */
  claudeConfigPath: string;
  /** Directory used for subagent .md files. */
  agentsDir: string;
  /** Free-form notes for the user (e.g. "API unreachable"). */
  notes: string[];
  /** Dispatcher PM2 status (null when PM2 isn't installed or entry absent). */
  dispatcher: {
    running: boolean;
    pid?: number;
    restartCount?: number;
    uptimeMs?: number;
  } | null;
}

/** Result returned by `install`. */
export interface InstallResult {
  /** AgenticMail agents that were turned into Claude Code subagents. */
  registeredAgents: AgenticMailAccount[];
  /** Where the MCP server block was written. */
  claudeConfigPath: string;
  /** Where the subagent .md files were written. */
  agentsDir: string;
  /** The bridge agent (Claude Code's identity inside AgenticMail). */
  bridgeAgent: AgenticMailAccount;
  /** True if the install changed any files (false on no-op re-runs). */
  changed: boolean;
  /** Dispatcher daemon launch status (best-effort; reason populated on failure). */
  dispatcher?: { started: boolean; reason?: string };
}

/** Result returned by `uninstall`. */
export interface UninstallResult {
  /** Whether anything was actually removed. */
  changed: boolean;
  /** Removed subagent .md files. */
  removedSubagents: string[];
  /** Whether the MCP server block was removed from Claude Code config. */
  mcpBlockRemoved: boolean;
  /** Whether the bridge agent was deleted (only if `--purge-bridge` was set). */
  bridgeAgentDeleted: boolean;
  /** Whether the dispatcher PM2 entry was stopped. */
  dispatcherStopped: boolean;
}
