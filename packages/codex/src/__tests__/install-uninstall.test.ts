/**
 * End-to-end-ish tests for install / uninstall / status that stub the
 * AgenticMail API with `vi.fn()` instead of actually hitting the server.
 *
 * Filesystem effects ARE real — we write into a tempdir and verify the
 * resulting files. The whole point of the package is "write files into
 * the user's Codex home without blowing up adjacent state", so that's
 * where the test coverage focuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';

// Hoist the API mocks so the vi.mock factory runs before the imports below
// can resolve to the real module.
const apiMocks = vi.hoisted(() => ({
  AgenticMailApiError: function AgenticMailApiError(this: any, status: number, message: string) {
    Error.call(this, message);
    this.status = status;
    this.message = message;
    this.name = 'AgenticMailApiError';
  },
  checkApiHealth: vi.fn(),
  listAccounts: vi.fn(),
  getAccountByName: vi.fn(),
  ensureAccount: vi.fn(),
  deleteAccount: vi.fn(),
}));
vi.mock('../api.js', () => apiMocks);

// PM2 isn't installed in CI; the install path tries to start the dispatcher
// via `pm2`, which takes ~400ms even when it fails. Stub it out.
vi.mock('../pm2.js', () => ({
  DISPATCHER_PM2_NAME: 'agenticmail-codex-dispatcher',
  pm2Available: vi.fn(() => false),
  getDispatcherStatus: vi.fn(() => null),
  startDispatcher: vi.fn(() => ({ started: false, reason: 'pm2 mocked in tests' })),
  stopDispatcher: vi.fn(() => ({ stopped: false })),
}));

import * as api from '../api.js';
import { install } from '../install.js';
import { uninstall } from '../uninstall.js';
import { status } from '../status.js';
import { MANAGED_BY_MARKER } from '../subagent-template.js';

let dir: string;
let amCfgPath: string;
let codexHome: string;
let codexCfgPath: string;
let codexHooksPath: string;
let agentsDir: string;

const BRIDGE = { id: 'bridge-id', name: 'codex', email: 'codex@localhost', apiKey: 'ak_bridge' };
const VESPER = { id: 'vesper-id', name: 'Vesper', email: 'vesper@localhost', apiKey: 'ak_vesper', role: 'researcher', metadata: { ownerName: 'Ope' } };
const ORION = { id: 'orion-id', name: 'orion', email: 'orion@localhost', apiKey: 'ak_orion', role: 'developer' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcx-iu-'));
  amCfgPath = join(dir, 'agenticmail.json');
  codexHome = join(dir, 'codex-home');
  codexCfgPath = join(codexHome, 'config.toml');
  codexHooksPath = join(codexHome, 'hooks.json');
  agentsDir = join(codexHome, 'agents');
  writeFileSync(amCfgPath, JSON.stringify({ masterKey: 'mk_test', api: { port: 3200, host: '127.0.0.1' } }), 'utf-8');

  vi.mocked(api.checkApiHealth).mockResolvedValue({ ok: true, version: 'test' });
  vi.mocked(api.deleteAccount).mockResolvedValue(undefined);
  vi.mocked(api.ensureAccount).mockResolvedValue(BRIDGE as any);
  vi.mocked(api.listAccounts).mockResolvedValue([BRIDGE, VESPER, ORION] as any);
  vi.mocked(api.getAccountByName).mockImplementation(async (_u, _k, name) => {
    if (name === 'codex') return BRIDGE as any;
    if (name.toLowerCase() === 'vesper') return VESPER as any;
    return null;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const baseOpts = () => ({
  agenticmailConfigPath: amCfgPath,
  codexHome,
  agentsDir,
});

describe('install', () => {
  it('provisions the bridge agent with role="assistant" — NOT "bridge"', async () => {
    // Regression for 0.1.0: install.ts called ensureAccount(..., 'bridge')
    // which 400'd against the API's role validator
    // ({secretary, assistant, researcher, writer, custom}). The bridge-ness
    // of the codex account is encoded via name match, not role.
    await install(baseOpts());
    expect(api.ensureAccount).toHaveBeenCalledTimes(1);
    expect(api.ensureAccount).toHaveBeenCalledWith(
      expect.any(String),  // apiUrl
      expect.any(String),  // masterKey
      'codex',             // bridge agent name
      'assistant',         // role — must be one of the API's allowed values
    );
  });

  it('writes the MCP server block, hooks, and one .toml per exposable agent', async () => {
    const result = await install(baseOpts());
    expect(result.changed).toBe(true);
    expect(result.bridgeAgent.name).toBe('codex');

    // config.toml
    const cfg = TOML.parse(readFileSync(codexCfgPath, 'utf-8')) as {
      mcp_servers: { agenticmail: { command: string; env: Record<string, string> } };
      features?: { multi_agent_v2?: { enabled?: boolean } };
    };
    expect(cfg.mcp_servers.agenticmail.command).toBe('npx');
    expect(cfg.mcp_servers.agenticmail.env.AGENTICMAIL_API_KEY).toBe('ak_bridge');
    expect(cfg.mcp_servers.agenticmail.env.AGENTICMAIL_MASTER_KEY).toBe('mk_test');
    expect(cfg.features?.multi_agent_v2?.enabled).toBe(true);

    // hooks.json
    const hooks = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.hooks.Stop).toHaveLength(1);

    // agent files
    const files = readdirSync(agentsDir);
    expect(files).toContain('agenticmail-vesper.toml');
    expect(files).toContain('agenticmail-orion.toml');
    expect(files).not.toContain('agenticmail-codex.toml'); // bridge excluded

    // The file is valid TOML and carries our marker.
    const text = readFileSync(join(agentsDir, 'agenticmail-vesper.toml'), 'utf-8');
    expect(text).toContain(MANAGED_BY_MARKER);
    const parsed = TOML.parse(text) as { name: string; description: string; developer_instructions: string };
    expect(parsed.name).toBe('agenticmail-vesper');
    expect(parsed.developer_instructions).toContain('Vesper');
  });

  it('seeds AGENTICMAIL_ACCOUNT_KEYS_JSON with every exposable agent (+ the bridge)', async () => {
    await install(baseOpts());
    const cfg = TOML.parse(readFileSync(codexCfgPath, 'utf-8')) as {
      mcp_servers: { agenticmail: { env: Record<string, string> } };
    };
    const raw = cfg.mcp_servers.agenticmail.env.AGENTICMAIL_ACCOUNT_KEYS_JSON;
    expect(typeof raw).toBe('string');
    const keys = JSON.parse(raw);
    expect(keys.Vesper).toBe('ak_vesper');
    expect(keys.orion).toBe('ak_orion');
    expect(keys.codex).toBe('ak_bridge');
  });

  it('is idempotent — second run with no changes makes no file writes', async () => {
    await install(baseOpts());
    const second = await install(baseOpts());
    expect(second.changed).toBe(false);
  });

  it('prunes a stale subagent file when its target agent disappears', async () => {
    await install(baseOpts());
    expect(readdirSync(agentsDir)).toContain('agenticmail-orion.toml');

    vi.mocked(api.listAccounts).mockResolvedValue([BRIDGE, VESPER] as any);
    const result = await install(baseOpts());
    expect(result.changed).toBe(true);
    expect(readdirSync(agentsDir)).not.toContain('agenticmail-orion.toml');
    expect(readdirSync(agentsDir)).toContain('agenticmail-vesper.toml');
  });

  it('refuses to overwrite a user-authored .toml with the same name', async () => {
    mkdirSync(agentsDir, { recursive: true });
    const userFile = join(agentsDir, 'agenticmail-vesper.toml');
    writeFileSync(userFile, `name = "agenticmail-vesper"\ndescription = "User owns this."\ndeveloper_instructions = "..."\n`, 'utf-8');
    await install(baseOpts());
    const content = readFileSync(userFile, 'utf-8');
    expect(content).toContain('User owns this.');
    // managed-by marker is NOT present in this hand-written file.
    expect(content).not.toContain(MANAGED_BY_MARKER);
  });

  it('preserves unrelated keys in config.toml', async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(codexCfgPath, `model = "gpt-5"\nsandbox_mode = "workspace-write"\n\n[mcp_servers.github]\ncommand = "github-mcp"\n`, 'utf-8');
    await install(baseOpts());
    const cfg = TOML.parse(readFileSync(codexCfgPath, 'utf-8')) as {
      model?: string;
      sandbox_mode?: string;
      mcp_servers?: Record<string, { command: string }>;
    };
    expect(cfg.model).toBe('gpt-5');
    expect(cfg.sandbox_mode).toBe('workspace-write');
    expect(cfg.mcp_servers?.github?.command).toBe('github-mcp');
    expect(cfg.mcp_servers?.agenticmail?.command).toBe('npx');
  });

  it("preserves other users' hooks", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(codexHooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'my-custom-hook.sh' }] },
        ],
      },
    }), 'utf-8');
    await install(baseOpts());
    const hooks = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
    const cmds = hooks.hooks.UserPromptSubmit.map((r: { hooks: { command: string }[] }) => r.hooks[0].command);
    expect(cmds).toContain('my-custom-hook.sh');
    expect(cmds.some((c: string) => c.includes('mail-hook') || c.includes('codex-mail-hook'))).toBe(true);
  });
});

describe('uninstall', () => {
  it('removes only the agenticmail block + owned .toml files', async () => {
    await install(baseOpts());

    // Add an unrelated MCP server.
    const cfg = TOML.parse(readFileSync(codexCfgPath, 'utf-8')) as { mcp_servers: Record<string, unknown> };
    cfg.mcp_servers.other = { command: 'keep' };
    writeFileSync(codexCfgPath, TOML.stringify(cfg as TOML.JsonMap), 'utf-8');

    // Add a hand-authored .toml.
    const userFile = join(agentsDir, 'my-custom.toml');
    writeFileSync(userFile, `name = "my-custom"\ndescription = "Keep me."\ndeveloper_instructions = "I'm not theirs."\n`, 'utf-8');

    const result = await uninstall(baseOpts());
    expect(result.changed).toBe(true);
    expect(result.mcpBlockRemoved).toBe(true);
    expect(result.removedSubagents.length).toBeGreaterThan(0);

    const after = TOML.parse(readFileSync(codexCfgPath, 'utf-8')) as { mcp_servers: Record<string, { command: string }> };
    expect(after.mcp_servers.agenticmail).toBeUndefined();
    expect(after.mcp_servers.other?.command).toBe('keep');

    // Our files gone, user's stays.
    expect(readdirSync(agentsDir)).not.toContain('agenticmail-vesper.toml');
    expect(readdirSync(agentsDir)).toContain('my-custom.toml');
  });

  it('keeps the bridge by default', async () => {
    await install(baseOpts());
    const result = await uninstall(baseOpts());
    expect(result.bridgeAgentDeleted).toBe(false);
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it('purges the bridge when explicitly requested', async () => {
    await install(baseOpts());
    const result = await uninstall({ ...baseOpts(), purgeBridgeAgent: true });
    expect(result.bridgeAgentDeleted).toBe(true);
    expect(api.deleteAccount).toHaveBeenCalled();
  });

  it('removes hook entries from hooks.json', async () => {
    await install(baseOpts());
    await uninstall(baseOpts());
    const hooks = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
    // All entries we added are gone; key is dropped when empty.
    expect(hooks.hooks).toBeUndefined();
  });
});

describe('status', () => {
  it('reports installed state after install', async () => {
    await install(baseOpts());
    const s = await status(baseOpts());
    expect(s.state).toBe('installed');
    expect(s.mcpInstalled).toBe(true);
    expect(s.multiAgentEnabled).toBe(true);
    expect(s.bridgeAgentExists).toBe(true);
    expect(s.subagents.length).toBeGreaterThan(0);
  });

  it('reports not_installed on a clean slate', async () => {
    vi.mocked(api.getAccountByName).mockResolvedValue(null);
    const s = await status(baseOpts());
    expect(s.state).toBe('not_installed');
    expect(s.mcpInstalled).toBe(false);
    expect(s.bridgeAgentExists).toBe(false);
  });
});
