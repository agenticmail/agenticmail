/**
 * Install AgenticMail into Claude Code.
 *
 * Pure-function-ish: takes config, writes files, returns a result object.
 * The chalk-painted CLI wizard (in agenticmail/src/cli.ts → cmdClaudeCode)
 * is responsible for narrating progress. This module knows nothing about
 * the terminal.
 *
 * What we write:
 *   1. ~/.claude.json  →  adds mcpServers.<name> entry that runs the AgenticMail MCP server
 *   2. ~/.claude/agents/<prefix><agent>.md  →  one Claude Code subagent per AgenticMail agent
 *
 * What we provision in AgenticMail:
 *   - A single "claudecode" agent whose API key the MCP server uses as its identity.
 *     This is the same model OpenClaw's plugin uses: every external host gets
 *     its own AgenticMail identity so call traces are attributable.
 *
 * What we do NOT do:
 *   - We do NOT touch ~/.claude/.credentials.json (the host Claude OAuth token).
 *     Claude Code manages those credentials and uses them when spawning each
 *     subagent — we never need to read or modify them. See README "How auth
 *     works" for the full story.
 *   - We do NOT touch any per-agent runtime artefacts that may exist outside
 *     AgenticMail itself. Agent discovery uses the master API alone — that
 *     is the only contract this package depends on.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAccount, listAccounts, checkApiHealth, setAccountRole } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { upsertMcpServer, type ClaudeMcpServerEntry } from './claude-config.js';
import { upsertUserPromptSubmitHook } from './claude-hooks-config.js';
import { MANAGED_BY_MARKER, renderSubagentMarkdown } from './subagent-template.js';
import { startDispatcher } from './pm2.js';
import { fileURLToPath } from 'node:url';
import type { AgenticMailAccount, ClaudeCodeIntegrationConfig, InstallResult } from './types.js';

/**
 * Sanitize an AgenticMail agent name into a Claude Code subagent filename
 * component. Claude Code subagent names are kebab-case ASCII; the AgenticMail
 * agent name itself already has a similar contract but we re-normalise to be
 * defensive against future schema changes.
 */
function sanitizeSubagentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the MCP server entry that goes into ~/.claude.json.
 *
 * Three identity-related env vars are written:
 *
 *   - AGENTICMAIL_API_KEY: the bridge agent's key — used as the *default*
 *     identity when a tool call doesn't pass `_account`. Effectively this
 *     is "Claude Code talking on its own behalf".
 *
 *   - AGENTICMAIL_MASTER_KEY: required for admin-scoped tools (create
 *     account, delete account, gateway ops). Same as before.
 *
 *   - AGENTICMAIL_ACCOUNT_KEYS_JSON: NEW — a JSON map of { agentName:
 *     apiKey } for every discoverable AgenticMail agent. The MCP server
 *     reads this on startup and switches identity per call when a
 *     subagent passes `_account: "Fola"` etc. This is what lets a
 *     Claude Code session "ride on" the user's Claude OAuth and act AS
 *     individual AgenticMail agents (read their inbox, send mail from
 *     their address, manage their tasks) without each agent needing its
 *     own Anthropic credentials.
 */
function buildMcpEntry(cfg: ClaudeCodeIntegrationConfig, bridgeKey: string, accountKeys: Record<string, string>): ClaudeMcpServerEntry {
  const env: Record<string, string> = {
    AGENTICMAIL_API_URL: cfg.apiUrl,
    AGENTICMAIL_API_KEY: bridgeKey,
    AGENTICMAIL_MASTER_KEY: cfg.masterKey,
  };
  if (Object.keys(accountKeys).length > 0) {
    env.AGENTICMAIL_ACCOUNT_KEYS_JSON = JSON.stringify(accountKeys);
  }
  return {
    type: 'stdio',
    command: cfg.mcpCommand,
    args: cfg.mcpArgs,
    env,
  };
}

/**
 * Decide which AgenticMail agents to surface as Claude Code subagents.
 *
 * Filters out:
 *   - the bridge agent itself (Claude Code's own identity — calling yourself
 *     is silly and would also create a duplicate-name collision in the
 *     subagent_type namespace)
 *   - any account with role="bridge" (reserved for hosts like this one)
 */
export function selectExposableAgents(
  accounts: AgenticMailAccount[],
  cfg: ClaudeCodeIntegrationConfig,
): AgenticMailAccount[] {
  return accounts.filter(a =>
    a.name.toLowerCase() !== cfg.bridgeAgentName.toLowerCase()
    && a.role !== 'bridge',
  );
}

/**
 * Inspect an existing .md file in the agents dir and decide whether we own
 * it. We tag every file we write with a frontmatter marker — anything missing
 * that marker is user-owned and we leave it alone.
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
 * Write all subagent .md files. Idempotent: if a file already exists with
 * identical content, we skip the write so the user's filesystem mtime stays
 * meaningful.
 *
 * Returns the list of agent names whose files were created or updated.
 */
function writeSubagentFiles(agentsDir: string, cfg: ClaudeCodeIntegrationConfig, agents: AgenticMailAccount[]): string[] {
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const updated: string[] = [];
  for (const agent of agents) {
    const baseName = sanitizeSubagentName(`${cfg.subagentPrefix}${agent.name}`);
    const filePath = join(agentsDir, `${baseName}.md`);
    const content = renderSubagentMarkdown({
      name: baseName,
      agent,
      mcpServerName: cfg.mcpServerName,
    });
    if (existsSync(filePath)) {
      // Refuse to overwrite a hand-authored file with the same name. Only
      // overwrite files we previously wrote (identified by the frontmatter
      // marker). This protects against a user creating `agenticmail-fola.md`
      // by hand and losing it on the next install.
      if (!isOwnedSubagent(filePath)) continue;
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === content) continue; // no-op write avoidance
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
 * Claude Code subagent that points at a missing target — calls would fail
 * with "Agent not found" at runtime.
 */
function pruneStaleSubagentFiles(
  agentsDir: string,
  cfg: ClaudeCodeIntegrationConfig,
  liveAgentNames: Set<string>,
): string[] {
  if (!existsSync(agentsDir)) return [];
  // IMPORTANT: do NOT run the prefix through sanitizeSubagentName — that
  // helper strips trailing dashes (used for normalising file basenames),
  // but the prefix legitimately ends in a dash. Mis-trimming the prefix
  // makes startsWith match too aggressively AND skews the slice offset by
  // one, both of which conspire to delete files we just wrote.
  const prefix = cfg.subagentPrefix.toLowerCase();
  const removed: string[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    if (!file.toLowerCase().startsWith(prefix)) continue;
    const full = join(agentsDir, file);
    if (!isOwnedSubagent(full)) continue; // not ours, leave alone
    const stem = file.slice(prefix.length, -3); // drop prefix + ".md"
    if (liveAgentNames.has(stem.toLowerCase())) continue;
    try {
      unlinkSync(full);
      removed.push(file);
    } catch {
      // Best effort — partial cleanup is fine, we'll re-try next install.
    }
  }
  return removed;
}

/**
 * Top-level install. Throws if the AgenticMail master API is unreachable —
 * we refuse to write a half-broken config that Claude Code would silently
 * load but never connect.
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

  // 2. Provision (or look up) the bridge agent — Claude Code's identity in AgenticMail.
  // Role 'bridge' marks this as the host's own identity (added to
  // AGENT_ROLES in @agenticmail/core 0.9.3) — distinct from teammate
  // accounts the user assigns work to.
  let bridge = await ensureAccount(cfg.apiUrl, cfg.masterKey, cfg.bridgeAgentName, 'bridge');

  // Migrate pre-0.9.3 bridges from role='assistant' to role='bridge'.
  // ensureAccount returns the existing record unchanged when the name
  // already exists, so the role patch has to be explicit. Best-effort.
  if (bridge.role && bridge.role !== 'bridge') {
    try {
      await setAccountRole(cfg.apiUrl, cfg.masterKey, bridge.id, 'bridge');
      bridge = { ...bridge, role: 'bridge' };
    } catch {
      /* role stays as-is; bridge still works */
    }
  }

  // 3. Discover every other agent so we can both register them as Claude
  //    Code subagents AND seed the per-account API-key map for the MCP
  //    server's identity switching (see buildMcpEntry comment).
  const everyAccount = await listAccounts(cfg.apiUrl, cfg.masterKey);
  const exposable = selectExposableAgents(everyAccount, cfg);
  const accountKeys: Record<string, string> = {};
  for (const a of exposable) accountKeys[a.name] = a.apiKey;
  // Include the bridge itself so subagents could (in principle) act as the
  // bridge by passing `_account: "claudecode"` — harmless and symmetric.
  accountKeys[bridge.name] = bridge.apiKey;

  // 4. Write the MCP server block into ~/.claude.json.
  const mcpEntry = buildMcpEntry(cfg, bridge.apiKey, accountKeys);
  const mcpChanged = upsertMcpServer(cfg.claudeConfigPath, cfg.mcpServerName, mcpEntry);

  // 5. Generate one Claude Code subagent file per AgenticMail agent.
  const updated = writeSubagentFiles(cfg.agentsDir, cfg, exposable);

  // 6. Garbage-collect subagent files whose target agent has disappeared.
  const liveNames = new Set(exposable.map(a => sanitizeSubagentName(a.name)));
  const pruned = pruneStaleSubagentFiles(cfg.agentsDir, cfg, liveNames);

  // 7a. Register the mail hook on UserPromptSubmit + Stop. The hook
  //     wakes Claude Code on every user prompt (interactive) and
  //     forces a continue on every turn boundary (autonomous) when
  //     the bridge inbox has new mail — closing the "host can't be
  //     notified" gap on both interactive and headless sessions.
  //
  //     We use the ABSOLUTE path to the compiled `mail-hook.js` via
  //     `node` rather than the bare bin name. Earlier versions used
  //     `agenticmail-mail-hook` (bare PATH lookup), which failed
  //     silently when the package was installed in a location that
  //     wasn't on the user's $PATH — producing the noisy
  //     `Stop hook error: agenticmail-mail-hook: command not found`
  //     on every turn. Absolute path is resilient to PATH config and
  //     is auto-refreshed on every install/upgrade.
  let hookChanged = false;
  try {
    hookChanged = upsertUserPromptSubmitHook(cfg.claudeSettingsPath, resolveMailHookCommand());
  } catch { /* best-effort — a broken settings.json shouldn't kill the install */ }

  // 7. Start the dispatcher under PM2 (best-effort). The dispatcher is
  //    what turns "send mail to fola@localhost" or "POST /tasks/rpc to
  //    Fola" into "spawn a Claude-powered Fola worker that handles it".
  //    Without it, MCP tools work but agents never wake on their own.
  //    PM2 missing → log + skip; everything else still works.
  const dispatcherStatus = await startDispatcherForInstall(cfg);

  return {
    registeredAgents: exposable,
    claudeConfigPath: cfg.claudeConfigPath,
    agentsDir: cfg.agentsDir,
    bridgeAgent: bridge,
    changed: mcpChanged || updated.length > 0 || pruned.length > 0 || dispatcherStatus.started || hookChanged,
    dispatcher: dispatcherStatus,
  };
}

/**
 * Resolve the dispatcher bin path relative to THIS file's location.
 *
 * The package layout is `dist/dispatcher-bin.js` next to the file calling
 * us (`dist/install.js`). Working out of `import.meta.url` keeps this
 * working whether the package is npm-installed globally, npm-linked,
 * imported from a workspace, or extracted from a tarball.
 */
function resolveDispatcherBinPath(): string {
  return resolveSiblingBin('dispatcher-bin.js');
}

/**
 * Build the shell command we register in Claude Code's settings.json
 * for the mail hook.
 *
 * Format: `node <abs-path>/mail-hook.js`. Hook commands are evaluated
 * by /bin/sh inside Claude Code; an absolute path resolved from
 * `import.meta.url` works regardless of whether the package was
 * installed globally, npm-linked, run from a workspace, or
 * extracted from a tarball — none of which guarantee that the bare
 * `agenticmail-mail-hook` bin name lands on `$PATH`.
 *
 * Quoting matters: spaces in the install path (common on macOS
 * "User Name" homedirs) would otherwise split the command.
 */
function resolveMailHookCommand(): string {
  return `node "${resolveSiblingBin('mail-hook.js')}"`;
}

/**
 * Find a compiled sibling JS file next to this module.
 *
 * Two valid layouts:
 *
 *   - **Published npm package** — `install.js` sits next to
 *     `mail-hook.js` and `dispatcher-bin.js` inside `dist/`. The
 *     sibling lookup hits on the first try.
 *
 *   - **Dev checkout / npm link** — this file is actually
 *     `src/install.ts` (tsx-loaded). The sibling `src/mail-hook.js`
 *     doesn't exist — only the `.ts` does — but the compiled
 *     output lives at `../dist/mail-hook.js`. We probe that
 *     fallback location.
 *
 * The original 0.8.25 resolver always returned the sibling path,
 * which produced `Cannot find module .../src/mail-hook.js` errors
 * when registered into a dev checkout's settings.json. Probing the
 * filesystem fixes both layouts with one rule.
 */
function resolveSiblingBin(filename: string): string {
  const thisFile = fileURLToPath(import.meta.url);
  const dir = thisFile.slice(0, thisFile.lastIndexOf('/'));

  // 1. Same directory (published build layout).
  const sibling = `${dir}/${filename}`;
  if (existsSync(sibling)) return sibling;

  // 2. Adjacent dist/ (dev checkout with src/ + dist/ side by side).
  const distSibling = `${dir.replace(/\/src$/, '')}/dist/${filename}`;
  if (existsSync(distSibling)) return distSibling;

  // 3. One level up + dist/ (defensive — covers tsx loaders that
  //    don't preserve `src/` in the resolved URL).
  const parentDist = `${dir}/../dist/${filename}`;
  if (existsSync(parentDist)) return parentDist;

  // 4. Couldn't find it. Return the published-layout path and let
  //    the caller's downstream error message surface the issue.
  return sibling;
}

async function startDispatcherForInstall(cfg: ClaudeCodeIntegrationConfig): Promise<{ started: boolean; reason?: string }> {
  const binPath = resolveDispatcherBinPath();
  return startDispatcher({
    binPath,
    env: {
      AGENTICMAIL_API_URL: cfg.apiUrl,
      AGENTICMAIL_MASTER_KEY: cfg.masterKey,
      CLAUDE_CODE_AGENTS_DIR: cfg.agentsDir,
    },
  });
}
