/**
 * Install AgenticMail into Codex CLI.
 *
 * Pure-function-ish: takes config, writes files, returns a result object.
 * The terminal narration lives in cli.ts; this module knows nothing about
 * the terminal.
 *
 * What we write:
 *   1. ~/.codex/config.toml
 *        → [mcp_servers.<name>] block that runs the AgenticMail MCP server
 *        → features.multi_agent_v2.enabled = true (so spawn_agent is exposed)
 *   2. ~/.codex/hooks.json
 *        → SessionStart / UserPromptSubmit / Stop hooks pointing at our
 *          mail-hook binary
 *   3. ~/.codex/agents/<prefix><agent>.toml
 *        → one Codex subagent per AgenticMail agent, with persona body
 *          stuffed into developer_instructions
 *
 * What we provision in AgenticMail:
 *   - A single "codex" agent whose API key the MCP server uses as its identity
 *     when a tool call doesn't pass `_account`. Mirrors the "claudecode"
 *     bridge in @agenticmail/claudecode.
 *
 * What we do NOT do:
 *   - We do NOT touch Codex's OAuth state, sessions/ rollouts, or skills/
 *     cache. Those are user state.
 *   - We do NOT modify the user's model/sandbox/approval settings in
 *     config.toml — only the two keys named above.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAccount, listAccounts, checkApiHealth, setAccountRole, setAccountHost } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import {
  upsertMcpServer,
  ensureMultiAgentEnabled,
  type CodexMcpServerEntry,
} from './codex-config-toml.js';
import { upsertMailHook } from './codex-hooks-config.js';
import { MANAGED_BY_MARKER, renderSubagentToml } from './subagent-template.js';
import { startDispatcher } from './pm2.js';
import type {
  AgenticMailAccount,
  CodexIntegrationConfig,
  InstallResult,
} from './types.js';

/**
 * Sanitize an AgenticMail agent name into a Codex agent-file basename.
 * Codex's agent `name` field accepts the same kebab-case ASCII shape Claude
 * Code does, so we normalise defensively.
 */
function sanitizeSubagentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the MCP server entry that goes into ~/.codex/config.toml.
 *
 * Three identity-related env vars are written (same shape as the Claude
 * Code integration — the MCP server reads them identically):
 *
 *   - AGENTICMAIL_API_KEY: the bridge agent's key, used as the *default*
 *     identity when a tool call omits `_account`. Effectively "Codex
 *     talking on its own behalf".
 *   - AGENTICMAIL_MASTER_KEY: required for admin-scoped tools (create
 *     account, delete account, gateway ops).
 *   - AGENTICMAIL_ACCOUNT_KEYS_JSON: JSON map of { agentName: apiKey } for
 *     every discoverable AgenticMail agent. The MCP server reads this on
 *     startup and switches identity per call when a subagent passes
 *     `_account: "Vesper"` etc. This is what lets a Codex session "ride
 *     on" the user's OpenAI credentials and act AS individual AgenticMail
 *     agents (read their inbox, send mail from their address, manage
 *     their tasks) without each agent needing its own OpenAI key.
 */
function buildMcpEntry(
  cfg: CodexIntegrationConfig,
  bridgeKey: string,
  accountKeys: Record<string, string>,
): CodexMcpServerEntry {
  const env: Record<string, string> = {
    AGENTICMAIL_API_URL: cfg.apiUrl,
    AGENTICMAIL_API_KEY: bridgeKey,
    AGENTICMAIL_MASTER_KEY: cfg.masterKey,
    // Host ownership tag. The MCP server's create_account stamps this
    // value onto every new account's metadata.host, and the dispatcher
    // uses it to filter "agents that belong to ME" — preventing two
    // dispatchers (claudecode + codex) from both waking the same
    // teammate on every reply.
    AGENTICMAIL_MCP_HOST: cfg.bridgeAgentName,
  };
  if (Object.keys(accountKeys).length > 0) {
    env.AGENTICMAIL_ACCOUNT_KEYS_JSON = JSON.stringify(accountKeys);
  }
  return {
    command: cfg.mcpCommand,
    args: cfg.mcpArgs,
    env,
    enabled: true,
  };
}

/**
 * Decide which AgenticMail agents to surface as Codex subagents.
 *
 * Filters out:
 *   - the bridge agent itself (Codex's own identity — would cause a
 *     duplicate-name collision in the agent_type namespace)
 *   - any account with role="bridge" (reserved for hosts like this one)
 *   - any account flagged `metadata.bridge === true` (legacy marker from
 *     pre-0.9.3 installs where the 'bridge' role didn't exist yet)
 *   - any account with metadata.host !== this host's bridge name, so a
 *     Claude Code install and a Codex install on the same machine don't
 *     stomp on each other's agent files. Agents without a host marker
 *     stay exposed to all hosts — backwards-compatible.
 */
export function selectExposableAgents(
  accounts: AgenticMailAccount[],
  cfg: CodexIntegrationConfig,
): AgenticMailAccount[] {
  const ownHost = cfg.bridgeAgentName.toLowerCase();
  return accounts.filter(a => {
    if (a.name.toLowerCase() === ownHost) return false;
    if (a.role === 'bridge') return false;
    const meta = a.metadata as { bridge?: unknown; host?: unknown } | undefined;
    if (meta && meta.bridge === true) return false;
    if (meta && typeof meta.host === 'string' && meta.host.trim().length > 0) {
      if (meta.host.toLowerCase() !== ownHost) return false;
    }
    return true;
  });
}

/**
 * Inspect an existing .toml file in the agents dir and decide whether we
 * own it. We tag every file we write with `# managed-by: @agenticmail/codex`
 * in a leading comment — anything missing that marker is user-owned and we
 * leave it alone.
 */
function isOwnedSubagent(filepath: string): boolean {
  try {
    const head = readFileSync(filepath, 'utf-8').slice(0, 1024);
    return head.includes(MANAGED_BY_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write all subagent .toml files. Idempotent: if a file already exists
 * with identical content, we skip the write so the user's filesystem
 * mtime stays meaningful.
 *
 * Returns the list of agent names whose files were created or updated.
 */
function writeSubagentFiles(
  agentsDir: string,
  cfg: CodexIntegrationConfig,
  agents: AgenticMailAccount[],
): string[] {
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const updated: string[] = [];
  for (const agent of agents) {
    const baseName = sanitizeSubagentName(`${cfg.subagentPrefix}${agent.name}`);
    const filePath = join(agentsDir, `${baseName}.toml`);
    const content = renderSubagentToml({
      name: baseName,
      agent,
      mcpServerName: cfg.mcpServerName,
    });
    if (existsSync(filePath)) {
      // Refuse to overwrite a hand-authored file with the same name. Only
      // overwrite files we previously wrote (identified by the comment
      // marker). Protects against a user creating `agenticmail-vesper.toml`
      // by hand and losing it on the next install.
      if (!isOwnedSubagent(filePath)) continue;
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === content) continue;
    }
    writeFileSync(filePath, content, 'utf-8');
    updated.push(baseName);
  }
  return updated;
}

/**
 * Remove our subagent files for any AgenticMail agent that no longer exists.
 *
 * Without this step, deleting an agent in AgenticMail would leave a dangling
 * Codex subagent that the model could try to spawn — `spawn_agent({
 * agent_type: "deleted-name" })` would either fail or worse, target a stale
 * persona that no longer maps to a real inbox.
 */
function pruneStaleSubagentFiles(
  agentsDir: string,
  cfg: CodexIntegrationConfig,
  liveAgentNames: Set<string>,
): string[] {
  if (!existsSync(agentsDir)) return [];
  // IMPORTANT: do NOT run the prefix through sanitizeSubagentName — that
  // strips trailing dashes, but the prefix legitimately ends in one. We
  // pre-compute the comparison once.
  const prefix = cfg.subagentPrefix.toLowerCase();
  const removed: string[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.toml')) continue;
    if (!file.toLowerCase().startsWith(prefix)) continue;
    const full = join(agentsDir, file);
    if (!isOwnedSubagent(full)) continue;
    const stem = file.slice(prefix.length, -('.toml'.length));
    if (liveAgentNames.has(stem.toLowerCase())) continue;
    try {
      unlinkSync(full);
      removed.push(file);
    } catch {
      // Best effort.
    }
  }
  return removed;
}

/**
 * Top-level install. Throws if the AgenticMail master API is unreachable —
 * we refuse to write a half-broken config that Codex would silently load
 * but never connect.
 */
export async function install(opts: ResolveConfigOptions = {}): Promise<InstallResult> {
  const cfg = resolveConfig(opts);

  // 1. Pre-flight: master API must be up and master key must be present.
  await checkApiHealth(cfg.apiUrl);
  if (!cfg.masterKey) {
    throw new Error(
      'AgenticMail master key not found. Run `agenticmail setup` first to generate one, ' +
      'or pass { masterKey } to install() explicitly.',
    );
  }

  // 2. Provision (or look up) the bridge agent — Codex's identity in AgenticMail.
  //
  // Role 'bridge' is the canonical marker for "this account represents an
  // external LLM host" (added to AGENT_ROLES in @agenticmail/core 0.9.3).
  // Tagging the host bridge with role='bridge' lets the web UI, list_agents,
  // wake gating, and the dispatcher's selectExposableAgents filter treat
  // the host's own inbox distinctly from teammate accounts the user
  // actually assigns work to.
  //
  // History: 0.1.0 tried this and 400'd because the API didn't accept
  // 'bridge' yet. 0.1.1 worked around it with 'assistant'. 0.1.2 reverts
  // to the correct 'bridge' role now that the API accepts it.
  let bridge = await ensureAccount(cfg.apiUrl, cfg.masterKey, cfg.bridgeAgentName, 'bridge');

  // 2a. Migration: if the bridge already existed from a 0.1.0/0.1.1 install
  // with role='assistant' (the workaround), patch it up to 'bridge' now
  // that the API accepts the role. ensureAccount returns the existing
  // record unchanged, so we have to do this explicitly. Best-effort —
  // if the patch fails for any reason (older API, network blip), log
  // and continue; the bridge still functions either way, the role is
  // a display label.
  if (bridge.role && bridge.role !== 'bridge') {
    try {
      await setAccountRole(cfg.apiUrl, cfg.masterKey, bridge.id, 'bridge');
      bridge = { ...bridge, role: 'bridge' };
    } catch {
      /* role stays as-is; bridge still works */
    }
  }

  // Stamp host ownership on the bridge itself. The MCP server's
  // create_account auto-tags accounts it provisions, but the bridge is
  // created here via the master API directly — it never goes through
  // MCP, so the env-var path doesn't apply. Stamping it explicitly
  // surfaces the bridge under its own host badge in the web UI and
  // keeps the dispatcher's metadata.host filter consistent across
  // teammates and bridges. Best-effort.
  const bridgeHost = (bridge.metadata as { host?: unknown } | undefined)?.host;
  if (typeof bridgeHost !== 'string' || bridgeHost.toLowerCase() !== cfg.bridgeAgentName.toLowerCase()) {
    try {
      await setAccountHost(cfg.apiUrl, cfg.masterKey, bridge.id, cfg.bridgeAgentName);
      bridge = {
        ...bridge,
        metadata: { ...(bridge.metadata ?? {}), host: cfg.bridgeAgentName },
      };
    } catch {
      /* host stays as-is; bridge still works */
    }
  }

  // 3. Discover every other agent so we can both register them as Codex
  //    subagents AND seed the per-account API-key map for the MCP server's
  //    identity switching (see buildMcpEntry comment).
  const everyAccount = await listAccounts(cfg.apiUrl, cfg.masterKey);
  const exposable = selectExposableAgents(everyAccount, cfg);
  const accountKeys: Record<string, string> = {};
  for (const a of exposable) accountKeys[a.name] = a.apiKey;
  accountKeys[bridge.name] = bridge.apiKey;

  // 4. Write the MCP server block into ~/.codex/config.toml.
  const mcpEntry = buildMcpEntry(cfg, bridge.apiKey, accountKeys);
  const mcpChanged = upsertMcpServer(cfg.codexConfigPath, cfg.mcpServerName, mcpEntry);

  // 4a. Ensure the multi-agent feature flag is enabled — without this the
  //     `spawn_agent` tool isn't exposed and the subagent files we just
  //     wrote are unreachable.
  const flagChanged = ensureMultiAgentEnabled(cfg.codexConfigPath);

  // 5. Generate one Codex agent TOML per AgenticMail agent.
  const updated = writeSubagentFiles(cfg.agentsDir, cfg, exposable);

  // 6. Garbage-collect subagent files whose target agent has disappeared.
  const liveNames = new Set(exposable.map(a => sanitizeSubagentName(a.name)));
  const pruned = pruneStaleSubagentFiles(cfg.agentsDir, cfg, liveNames);

  // 7. Register the mail hook on SessionStart + UserPromptSubmit + Stop.
  //    Codex's hook ABI is byte-compatible with Claude Code's, so the
  //    same hook binary works — only the registration file path differs.
  //
  //    We use the ABSOLUTE path to the compiled mail-hook.js via `node`
  //    instead of the bare bin name. Bare names depend on $PATH and the
  //    install location; the absolute path is always resolvable and
  //    auto-refreshes on every install/upgrade.
  let hookChanged = false;
  try {
    hookChanged = upsertMailHook(cfg.codexHooksPath, resolveMailHookCommand());
  } catch { /* best-effort — a broken hooks.json shouldn't kill the install */ }

  // 8. Start the dispatcher daemon under PM2 (best-effort). The
  //    dispatcher is what turns "new mail in vesper@localhost" into
  //    "spawn a Codex-powered Vesper turn that handles it". Without
  //    it, MCP tools work but agents never wake on their own.
  const dispatcherStatus = await startDispatcherForInstall(cfg);

  return {
    registeredAgents: exposable,
    codexConfigPath: cfg.codexConfigPath,
    codexHooksPath: cfg.codexHooksPath,
    agentsDir: cfg.agentsDir,
    bridgeAgent: bridge,
    changed:
      mcpChanged ||
      flagChanged ||
      updated.length > 0 ||
      pruned.length > 0 ||
      hookChanged ||
      dispatcherStatus.started,
    dispatcher: dispatcherStatus,
  };
}

/**
 * Resolve the dispatcher bin path relative to THIS file's location.
 *
 * Layout: `dist/dispatcher-bin.js` next to `dist/install.js`. Working
 * out of `import.meta.url` keeps this working whether the package is
 * npm-installed globally, npm-linked, imported from a workspace, or
 * extracted from a tarball.
 */
function resolveDispatcherBinPath(): string {
  return resolveSiblingBin('dispatcher-bin.js');
}

/**
 * Build the shell command we register in Codex's hooks.json for the
 * mail hook.
 *
 * Format: `node <abs-path>/mail-hook.js`. Hook commands run under
 * /bin/sh inside Codex; an absolute path resolved from `import.meta.url`
 * works regardless of whether the package was installed globally,
 * npm-linked, run from a workspace, or extracted from a tarball.
 *
 * Quoting matters: spaces in the install path (common on macOS "User
 * Name" homedirs) would otherwise split the command.
 */
function resolveMailHookCommand(): string {
  return `node "${resolveSiblingBin('mail-hook.js')}"`;
}

/**
 * Find a compiled sibling JS file next to this module. Two valid layouts:
 *
 *   1. Published npm package — `install.js` sits next to `mail-hook.js`
 *      and `dispatcher-bin.js` inside `dist/`. Sibling lookup hits.
 *   2. Dev checkout / npm link — this file is actually `src/install.ts`
 *      (tsx-loaded); the compiled output is at `../dist/<filename>`.
 *
 * Probing the filesystem fixes both layouts with one rule.
 */
function resolveSiblingBin(filename: string): string {
  const thisFile = fileURLToPath(import.meta.url);
  const dir = thisFile.slice(0, thisFile.lastIndexOf('/'));

  const sibling = `${dir}/${filename}`;
  if (existsSync(sibling)) return sibling;

  const distSibling = `${dir.replace(/\/src$/, '')}/dist/${filename}`;
  if (existsSync(distSibling)) return distSibling;

  const parentDist = `${dir}/../dist/${filename}`;
  if (existsSync(parentDist)) return parentDist;

  return sibling;
}

async function startDispatcherForInstall(
  cfg: CodexIntegrationConfig,
): Promise<{ started: boolean; reason?: string }> {
  const binPath = resolveDispatcherBinPath();
  return startDispatcher({
    binPath,
    env: {
      AGENTICMAIL_API_URL: cfg.apiUrl,
      AGENTICMAIL_MASTER_KEY: cfg.masterKey,
      CODEX_AGENTS_DIR: cfg.agentsDir,
    },
  });
}
