/**
 * Read / write / patch ~/.codex/config.toml safely.
 *
 * Codex's config file is owned by the user — it stores model preferences,
 * MCP server registrations under `[mcp_servers.<name>]`, feature flags
 * (most importantly `features.multi_agent_v2.enabled` which gates the
 * `spawn_agent` tool), sandbox/approval policies, and more. We touch
 * EXACTLY two things:
 *
 *   - `[mcp_servers.<our-name>]` — register the AgenticMail MCP server
 *   - `features.multi_agent_v2.enabled = true` — so subagent dispatch
 *      via `spawn_agent` is exposed to the model
 *
 * Everything else in the file is preserved byte-for-byte.
 *
 * Notes on the format:
 *   - The file is TOML (not JSON). Codex's Rust core uses `toml`/`toml_edit`;
 *     we use `@iarna/toml` from npm which round-trips standard TOML cleanly
 *     but DOES NOT preserve formatting (comments, blank lines, key order).
 *     For a config file that's primarily user-edited, this is a tradeoff:
 *     we keep the data correct but the user's hand-written comments may get
 *     reflowed. This matches what every other npm TOML tool does today;
 *     `toml-edit`-style format preservation is Rust-only.
 *   - The file may not exist on a fresh install — we treat that as an empty
 *     object and create the file when we write.
 *   - We always write atomically (tmp + rename) because a partial config.toml
 *     can make Codex CLI refuse to start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import TOML from '@iarna/toml';

/**
 * Reject any config path that isn't absolute AND under either the
 * operator's home directory or the OS temp dir (the temp dir is
 * whitelisted so unit tests can write to `mkdtempSync()` paths).
 *
 * This is the trust boundary check CodeQL's `js/path-injection`
 * query was flagging: every public function in this module takes
 * a `path` parameter that ultimately flows from operator config /
 * env vars, and `dirname(path)` / `writeFileSync(path)` / etc could
 * therefore be redirected by a malicious env var (e.g. a poisoned
 * CODEX_HOME pointing at /etc/cron.d). The boundary check below
 * collapses that taint flow into a hard error before any fs op runs.
 *
 * If you genuinely need to write outside HOME/tmp (we never do today),
 * extend the allow-list explicitly rather than removing this check.
 */
function safeConfigPath(path: string): string {
  if (!path || typeof path !== 'string') {
    throw new Error('codex config path is required');
  }
  if (!isAbsolute(path)) {
    throw new Error(`refusing relative codex config path: ${path}`);
  }
  const resolved = resolve(path);
  const home = resolve(homedir());
  const tmp = resolve(tmpdir());
  const insideHome = resolved === home || resolved.startsWith(home + sep);
  const insideTmp  = resolved === tmp  || resolved.startsWith(tmp + sep);
  if (!insideHome && !insideTmp) {
    throw new Error(`refusing codex config write outside of HOME or tmp: ${path}`);
  }
  return resolved;
}

/** Shape of a single MCP server registration in Codex's config.toml. */
export interface CodexMcpServerEntry {
  /**
   * Stdio transport (default) — `command` is required; `args`, `env`,
   * `env_vars`, `cwd` are optional.
   */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];
  cwd?: string;
  /**
   * HTTP transport — when present, `command`/`args`/`env` must be absent.
   * Set `url` and optional `bearer_token_env_var` / `http_headers`.
   */
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  /** Lifecycle/behaviour. */
  enabled?: boolean;
  required?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  /**
   * Per-server default tool-approval mode. Documented values
   * (openai/codex docs/config.md):
   *
   *   "approve"  — auto-approve every tool on this server
   *   "prompt"   — show an interactive approval dialog per tool call
   *
   * Per-tool overrides go under `[mcp_servers.<name>.tools.<tool>]
   * approval_mode = "..."`. AgenticMail's installer sets this to
   * `"approve"` so dispatcher-spawned worker turns (which have no
   * interactive user to confirm prompts) can call MCP tools without
   * being silently cancelled.
   */
  default_tools_approval_mode?: string;
  supports_parallel_tool_calls?: boolean;
}

/**
 * Loose typing — Codex's config.toml has many keys we don't care about
 * (model, sandbox, history, telemetry, profiles, etc.). We only structurally
 * model the two we touch.
 */
export interface CodexConfigShape {
  mcp_servers?: Record<string, CodexMcpServerEntry>;
  features?: {
    multi_agent_v2?: { enabled?: boolean };
    [feature: string]: unknown;
  };
  [key: string]: unknown;
}

export function readCodexConfig(rawPath: string): CodexConfigShape {
  const path = safeConfigPath(rawPath);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  try {
    const parsed = TOML.parse(raw) as CodexConfigShape;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse Codex config at ${path}: ${(err as Error).message}. ` +
      `Refusing to overwrite — please fix the file by hand and retry.`,
    );
  }
}

/**
 * Atomically write Codex's config.toml. Always goes through a `.tmp` +
 * rename pair so a process kill mid-write can never leave a truncated
 * file — a partial config.toml prevents Codex CLI from starting at all.
 */
export function writeCodexConfig(rawPath: string, config: CodexConfigShape): void {
  const path = safeConfigPath(rawPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // @iarna/toml's `stringify` accepts any JS object. We've already validated
  // the shape; the only failure mode is non-serialisable values (functions,
  // BigInt, etc.) which our shape can't carry.
  const text = TOML.stringify(config as TOML.JsonMap);
  const tmp = `${path}.agenticmail-tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}

/** Insert (or replace) a single MCP server entry. Returns true if the file changed. */
export function upsertMcpServer(
  path: string,
  serverName: string,
  entry: CodexMcpServerEntry,
): boolean {
  const config = readCodexConfig(path);
  const servers = config.mcp_servers ?? {};
  const existing = servers[serverName];
  if (existing && deepEqual(existing, entry)) return false;
  servers[serverName] = entry;
  config.mcp_servers = servers;
  writeCodexConfig(path, config);
  return true;
}

/** Remove a single MCP server entry. Returns true if the file changed. */
export function removeMcpServer(rawPath: string, serverName: string): boolean {
  const path = safeConfigPath(rawPath);
  if (!existsSync(path)) return false;
  const config = readCodexConfig(path);
  if (!config.mcp_servers || !(serverName in config.mcp_servers)) return false;
  delete config.mcp_servers[serverName];
  writeCodexConfig(path, config);
  return true;
}

/**
 * Ensure `features.multi_agent_v2.enabled = true` so the `spawn_agent` tool
 * is exposed to the model. Returns true if the file changed.
 *
 * Codex DOES default this to enabled in current releases, but there is a
 * one-time TUI prompt the first time a session encounters it. Setting it
 * explicitly in config.toml skips that prompt, which matters for fresh
 * installs that are about to be used with a dispatcher daemon — we don't
 * want the daemon's first wake to land on a prompt-confirmation screen.
 */
export function ensureMultiAgentEnabled(path: string): boolean {
  const config = readCodexConfig(path);
  const features = (config.features ?? {}) as { multi_agent_v2?: { enabled?: boolean } };
  const current = features.multi_agent_v2?.enabled;
  if (current === true) return false;
  features.multi_agent_v2 = { ...(features.multi_agent_v2 ?? {}), enabled: true };
  config.features = features;
  writeCodexConfig(path, config);
  return true;
}

/** Recursive structural equality — only as deep as our entry shape needs. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(ao[ak[i]], bo[bk[i]])) return false;
    }
    return true;
  }
  return false;
}
