#!/usr/bin/env node

// MUST be first import — installs a process.emit hook that hides Node's
// "SQLite is an experimental feature" warning before @agenticmail/core
// (which loads node:sqlite) gets evaluated.
import './suppress-experimental-warnings.js';
import { randomBytes } from 'node:crypto';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import {
  SetupManager,
  ServiceManager,
  type RelayProvider,
  type SetupConfig,
} from '@agenticmail/core';
import { interactiveShell } from './shell.js';
import { collectFields, SetupError, type SetupField } from './setup-utils.js';
import { validateAnthropicToken, identifyTokenKind } from './anthropic-token.js';

/**
 * Prompt for text input. Creates a temporary readline per call
 * to avoid conflicts with raw-mode pick/askSecret.
 */
function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for secret input — characters shown as asterisks.
 * Uses raw mode directly on stdin (no readline).
 */
function askSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);

    let input = '';
    const onData = (key: Buffer) => {
      const str = key.toString();
      // Process each character individually (handles paste of multiple chars)
      for (const ch of str) {
        if (ch === '\n' || ch === '\r') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        } else if (ch === '\u0003') {
          if (stdin.isTTY) stdin.setRawMode(false);
          process.exit(1);
        } else if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Single-keypress picker — user hits a key and it selects immediately.
 * Uses raw mode directly on stdin (no readline).
 */
function pick(prompt: string, validKeys: string[]): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);

    const onData = (key: Buffer) => {
      const ch = key.toString();
      if (ch === '\u0003') {
        if (stdin.isTTY) stdin.setRawMode(false);
        process.exit(1);
      }
      if (validKeys.includes(ch)) {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write(ch + '\n');
        resolve(ch);
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

// --- Colors & formatting ---
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  pink: (s: string) => `\x1b[38;5;205m${s}\x1b[0m`,
  pinkBg: (s: string) => `\x1b[48;5;205m\x1b[97m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  bgGreen: (s: string) => `\x1b[42m\x1b[30m${s}\x1b[0m`,
  bgCyan: (s: string) => `\x1b[46m\x1b[30m${s}\x1b[0m`,
};

function log(msg: string) { console.log(msg); }
function ok(msg: string) { console.log(`  ${c.green('✓')} ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red('✗')} ${msg}`); }
function info(msg: string) { console.log(`  ${c.dim(msg)}`); }

/** Mask a secret for terminal display: show first 4 and last 4 chars. */
function maskSecret(secret: string): string {
  if (secret.length <= 12) return '****';
  return secret.slice(0, 4) + '…' + secret.slice(-4);
}

// --- Spinner with rotating messages ---
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const LOADING_MESSAGES: Record<string, string[]> = {
  docker: [
    'Getting the engine ready...',
    'Just warming things up for you...',
    'Preparing the magic behind the scenes...',
    'Setting the stage for your AI agents...',
    'Almost there, hang tight...',
    'This is the boring part, we promise it gets cooler...',
  ],
  stalwart: [
    'Setting up your personal post office...',
    'Your AI is about to get its own mailbox...',
    'Preparing a cozy home for your emails...',
    'Building the place where emails live...',
    'Making sure everything is nice and tidy...',
    'Your agent is going to love this inbox...',
    'Almost ready to handle some mail...',
  ],
  cloudflared: [
    'Opening a secure path to the internet...',
    'Your AI needs a way to reach the real world...',
    'Building a private lane for your emails...',
    'Connecting you to the cloud, safely...',
    'Just a few more seconds...',
    'This lets your agent send real emails, worth the wait...',
  ],
  config: [
    'Creating your private settings...',
    'Making your setup unique and secure...',
    'Generating your secret keys...',
    'Think of this as your agent\'s ID card...',
  ],
  relay: [
    'Connecting to your email account...',
    'Linking your inbox to your AI agent...',
    'Your agent will email as you, how cool is that...',
    'Setting up the pipeline... almost there...',
    'Just making sure everything clicks...',
  ],
  domain: [
    'Pointing your domain to AgenticMail...',
    'Your agent is about to get a real email address...',
    'Configuring things on the internet side...',
    'Making your domain ready for AI emails...',
  ],
  server: [
    'Firing up the server...',
    'Getting your agent ready to go...',
    'Just a moment, preparing everything...',
    'Almost there...',
  ],
  general: [
    'Working on it...',
    'Hang tight, we got this...',
    'Just a moment...',
    'Good things take a little time...',
    'Almost there...',
  ],
};

// Gradient color palette (256-color) — cycles through these for spinner text
const GRADIENT_COLORS = [
  205, // hot pink
  212, // light pink
  219, // pink-lavender
  183, // lavender
  147, // periwinkle
  111, // sky blue
  117, // light blue
  123, // cyan-blue
  159, // ice blue
  153, // pale blue
  189, // light lavender
  225, // baby pink
  218, // salmon pink
  211, // coral
  205, // hot pink (loop)
];

function color256(code: number, s: string): string {
  return `\x1b[38;5;${code}m${s}\x1b[0m`;
}

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private msgIdx = 0;
  private msgChangeCounter = 0;
  private colorIdx = 0;
  private category: string;
  private currentMsg: string;
  private progressMsg: string = ''; // message set by progress update
  private progressPct = -1; // -1 = no progress bar

  constructor(category: string, initialMsg?: string) {
    this.category = category;
    const msgs = LOADING_MESSAGES[category] ?? LOADING_MESSAGES.general;
    this.currentMsg = initialMsg ?? msgs[0];
  }

  start(): void {
    this.frameIdx = 0;
    this.msgIdx = 0;
    this.msgChangeCounter = 0;
    this.colorIdx = 0;
    this.progressPct = -1;
    const msgs = LOADING_MESSAGES[this.category] ?? LOADING_MESSAGES.general;

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length];
      const clr = GRADIENT_COLORS[this.colorIdx % GRADIENT_COLORS.length];

      if (this.progressPct >= 0) {
        // Progress bar mode — gradient colors on bar + cycling messages
        const barWidth = 20;
        const filled = Math.round((this.progressPct / 100) * barWidth);
        const empty = barWidth - filled;
        // Color each filled block with a gradient segment
        let bar = '';
        for (let i = 0; i < filled; i++) {
          const barClr = GRADIENT_COLORS[(this.colorIdx + i) % GRADIENT_COLORS.length];
          bar += color256(barClr, '█');
        }
        bar += c.dim('░'.repeat(empty));
        const pctStr = color256(clr, `${this.progressPct}%`);
        // Show the progress message AND a rotating fun message
        const displayMsg = this.progressMsg || this.currentMsg;
        process.stdout.write(`\r  ${color256(clr, frame)} ${bar} ${pctStr} ${color256(clr, displayMsg)}\x1b[K`);
      } else {
        process.stdout.write(`\r  ${color256(clr, frame)} ${color256(clr, this.currentMsg)}\x1b[K`);
      }

      this.frameIdx++;
      this.msgChangeCounter++;
      // Shift color every 2 ticks (200ms) for smooth gradient cycling
      if (this.frameIdx % 2 === 0) {
        this.colorIdx = (this.colorIdx + 1) % GRADIENT_COLORS.length;
      }
      // Change fun message every ~3 seconds (30 ticks at 100ms)
      if (this.msgChangeCounter >= 30) {
        this.msgChangeCounter = 0;
        this.msgIdx = (this.msgIdx + 1) % msgs.length;
        this.currentMsg = msgs[this.msgIdx];
      }
    }, 100);
  }

  update(msg: string): void {
    // Check for progress protocol: __progress__:NN:message
    const match = msg.match(/^__progress__:(\d+):(.*)$/);
    if (match) {
      this.progressPct = Math.min(100, parseInt(match[1], 10));
      this.progressMsg = match[2];
    } else {
      this.currentMsg = msg;
      this.progressMsg = '';
    }
    this.msgChangeCounter = 0;
  }

  succeed(msg: string): void {
    this.stop();
    ok(msg);
  }

  fail(msg: string): void {
    this.stop();
    fail(msg);
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write('\r\x1b[K'); // Clear the line
    }
  }
}

// --- Path resolution helpers ---

/**
 * Resolve the API server entry point.
 * Works in both monorepo (workspace symlinks) and standalone npm install (npx).
 */
function resolveApiEntry(): string {
  // Strategy 1: import.meta.resolve (ESM-native, Node 20+)
  try {
    const resolved = import.meta.resolve('@agenticmail/api');
    return fileURLToPath(resolved);
  } catch { /* not resolvable */ }

  // Strategy 2: Walk up from CLI script to find node_modules/@agenticmail/api
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', '@agenticmail', 'api', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Strategy 3: Monorepo fallback
  const monorepo = [
    join(thisDir, '..', '..', 'packages', 'api', 'dist', 'index.js'),
    join(thisDir, '..', 'packages', 'api', 'dist', 'index.js'),
  ];
  for (const p of monorepo) {
    if (existsSync(p)) return p;
  }

  throw new Error('Could not find @agenticmail/api. Make sure it is installed or built.');
}

/**
 * Build env vars from config so the forked API can bootstrap without a .env in cwd.
 */
function configToEnv(config: SetupConfig): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENTICMAIL_DATA_DIR: config.dataDir,
    AGENTICMAIL_MASTER_KEY: config.masterKey,
    STALWART_ADMIN_USER: config.stalwart.adminUser,
    STALWART_ADMIN_PASSWORD: config.stalwart.adminPassword,
    STALWART_URL: config.stalwart.url,
    AGENTICMAIL_API_PORT: String(config.api.port),
    AGENTICMAIL_API_HOST: config.api.host,
    SMTP_HOST: config.smtp.host,
    SMTP_PORT: String(config.smtp.port),
    IMAP_HOST: config.imap.host,
    IMAP_PORT: String(config.imap.port),
  };
  // v0.9.84 — feed the persistent inbound secret to the spawned API
  // process. SetupManager.initConfig() lazy-mints this into config.json
  // for installs that predate the field, so a config we just loaded
  // is guaranteed to have it on the new path. Only set the env var
  // when it's present so a manually-edited config without the field
  // still falls through to the API's old self-mint-with-warning path
  // instead of getting an empty-string secret.
  if (config.inboundSecret) {
    env.AGENTICMAIL_INBOUND_SECRET = config.inboundSecret;
  }
  return env;
}

/**
 * Poll the health endpoint until the API is ready.
 */
async function waitForApi(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
  const healthUrl = `http://${host}:${port}/api/agenticmail/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (resp.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// --- Background server management ---
const PID_FILE = join(homedir(), '.agenticmail', 'server.pid');

/**
 * Start the API server as a detached background process.
 * Returns true if the server is reachable (already running or just started).
 */
async function startApiServer(config: SetupConfig): Promise<boolean> {
  const host = config.api.host;
  const port = config.api.port;
  const base = `http://${host}:${port}`;

  // Check if already running AND master key matches
  try {
    const probe = await fetch(`${base}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (probe.ok) {
      // Verify our master key works against this server
      const authProbe = await fetch(`${base}/api/agenticmail/gateway/status`, {
        headers: { 'Authorization': `Bearer ${config.masterKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (authProbe.ok || authProbe.status !== 401) {
        return true; // Server is running with our master key
      }
      // Master key mismatch — kill the stale server
      await killProcessOnPort(port);
      await new Promise(r => setTimeout(r, 500));
    }
  } catch { /* not running */ }

  const { spawn } = await import('node:child_process');
  const apiEntry = resolveApiEntry();
  const env = configToEnv(config);

  // Cache the API entry path so the auto-start service can find it
  try { new ServiceManager().cacheApiEntryPath(apiEntry); } catch { /* ignore */ }

  const child = spawn(process.execPath, [apiEntry], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  // Save PID so it can be stopped later
  if (child.pid) {
    try { writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
  }

  const ready = await waitForApi(host, port);

  // Start the Telegram bridge as a child of the cli — but only if the
  // user has configured it (agent-key + token files present). The bridge
  // is best-effort: a failure to start the bridge must not fail
  // `agenticmail start`, the user just loses Telegram replies until
  // they re-run setup.
  if (ready) {
    try { await startTelegramBridgeIfConfigured(); } catch { /* best-effort */ }
  }

  return ready;
}

/**
 * Ensure a Cloudflare quick-tunnel is running and return its URL.
 *
 * Used by `setup-phone` (Twilio + 46elks both need a publicly-reachable
 * HTTPS webhook URL) so the operator never has to think about exposing
 * their local box to the public internet — we just transparently spin
 * up a free `*.trycloudflare.com` tunnel pointed at the local API and
 * hand the URL back. Auto-start triggers only when a setup command
 * actually needs it: `agenticmail start` on its own doesn't open a
 * tunnel, so users who never wire up phone calls or webhook-mode
 * integrations pay nothing for the feature.
 *
 * Returns the URL on success, or `null` if the tunnel could not be
 * brought up (cloudflared missing, network failure, etc). Caller
 * should surface a helpful error in the null case — this function
 * never throws and never calls `process.exit` so it's safe to call
 * from any context.
 */
async function ensureTunnelUrl(): Promise<string | null> {
  const tunnelStateFile = join(homedir(), '.agenticmail', 'tunnel.json');
  // Reuse a live tunnel if we've already started one.
  try {
    if (existsSync(tunnelStateFile)) {
      const state = JSON.parse(readFileSync(tunnelStateFile, 'utf-8')) as { pid?: number; url?: string };
      if (state.pid && state.url) {
        try { process.kill(state.pid, 0); return state.url; }
        catch { /* dead — fall through and start fresh */ }
      }
    }
  } catch { /* corrupt state — fall through */ }

  // Need a config to know which local port to expose.
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) return null;
  let config: SetupConfig;
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig; }
  catch { return null; }
  const port = config.api.port;

  // Resolve cloudflared — managed first, then system PATH.
  const managedBin = join(homedir(), '.agenticmail', 'bin', 'cloudflared');
  let bin = existsSync(managedBin) ? managedBin : '';
  if (!bin) {
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('which', ['cloudflared'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) bin = out;
    } catch { /* not on PATH */ }
  }
  if (!bin) return null;

  const { spawn: sp } = await import('node:child_process');
  const child = sp(bin, ['tunnel', '--no-autoupdate', '--config', '/dev/null', '--url', `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve(null);
    }, 30_000);
    const onChunk = (chunk: Buffer) => {
      const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });

  if (!url) return null;

  child.unref();
  try {
    mkdirSync(dirname(tunnelStateFile), { recursive: true });
    writeFileSync(tunnelStateFile, JSON.stringify({
      pid: child.pid,
      url,
      port,
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* tunnel is running — losing the state file just means
                  next call can't reuse it, which only costs another
                  cold start */ }
  return url;
}

/**
 * Spawn the standalone Telegram bridge as a detached background process,
 * but only when the user has gone through the Telegram setup step
 * (`agenticmail setup` writes the three required files). The bridge
 * file ships inside the cli package at `telegram-bridge/bridge.mjs`;
 * we resolve it from the cli's own location so it works whether the
 * cli is installed globally, locally, or run from source.
 *
 * Idempotent — if the bridge is already running (PID file points at
 * a live process), we leave it alone. This is what makes `agenticmail
 * start` safe to run repeatedly without piling up bridge processes.
 */
async function startTelegramBridgeIfConfigured(): Promise<void> {
  const { existsSync: ex, readFileSync: rd, writeFileSync: wr } = await import('node:fs');
  const { join: pj } = await import('node:path');
  const { homedir: hd } = await import('node:os');

  const tgDir = pj(hd(), '.agenticmail', 'telegram');
  const tokenFile = pj(tgDir, 'telegram-token');
  const agentKeyFile = pj(tgDir, 'agent-key');
  if (!ex(tokenFile) || !ex(agentKeyFile)) return; // not configured yet

  // PID-file dedup so repeated `agenticmail start` calls don't spawn
  // a second bridge that races for getUpdates with the first.
  const pidFile = pj(tgDir, 'bridge.pid');
  if (ex(pidFile)) {
    const existingPid = parseInt(rd(pidFile, 'utf8').trim(), 10);
    if (!isNaN(existingPid) && existingPid > 0) {
      try {
        process.kill(existingPid, 0); // probe: throws if dead
        return; // already running
      } catch { /* dead — fall through and start a new one */ }
    }
  }

  // Resolve the bridge entry from the cli's own directory. `__dirname`
  // in this dist file is `<cli-install>/dist/`, so the bridge is at
  // `../telegram-bridge/bridge.mjs`. Verify it exists — if not, the
  // package was installed without the bridge files (shouldn't happen
  // with current `files` list, but be defensive).
  const distDir = dirname(fileURLToPath(import.meta.url));
  const bridgeEntry = pj(distDir, '..', 'telegram-bridge', 'bridge.mjs');
  if (!ex(bridgeEntry)) return;

  const { spawn: sp } = await import('node:child_process');
  const child = sp(process.execPath, [bridgeEntry], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (child.pid) {
    try { wr(pidFile, String(child.pid)); } catch { /* ignore */ }
  }
}

/**
 * Kill whatever process is listening on the given port.
 */
async function killProcessOnPort(port: number): Promise<void> {
  try {
    const { execFileSync } = await import('node:child_process');
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const n = parseInt(pid, 10);
      if (!isNaN(n) && n > 0) {
        try { process.kill(n, 'SIGTERM'); } catch { /* ignore */ }
      }
    }
  } catch { /* no process on port */ }
}

/**
 * Stop a previously started background API server.
 */
function stopApiServer(): boolean {
  try {
    if (!existsSync(PID_FILE)) return false;
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 'SIGTERM');
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return true;
  } catch {
    // Process already dead — clean up PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }
}

// --- Commands ---

/**
 * Non-interactive mode flag — set by `--yes` / `--non-interactive` / `-y`
 * on the `agenticmail setup` command line, OR by the `bootstrap` command.
 *
 * When true, every interactive prompt in the setup flow falls back to a
 * safe default:
 *   - Email setup → "Skip for now" (no relay, no domain — local-only)
 *   - SMS setup  → No
 *   - Retry prompts → No (proceed past partial config)
 *   - Agent name → "secretary"
 *
 * The result is a fully-provisioned LOCAL AgenticMail (Stalwart + master
 * key + default agent) with no outbound mail relay. Internal multi-agent
 * coordination over `*@localhost` still works. The user can add external
 * mail later with `agenticmail setup` (interactive).
 *
 * Why a module-level flag instead of plumbing it through every function:
 * the prompts live deep inside `cmdSetup` (~1000 lines) at many sites; a
 * module global is the smallest patch that catches every prompt without
 * a wholesale refactor. The flag is set once at the top of cmdSetup and
 * read by `nonInteractiveDefault()` whenever a prompt is about to fire.
 */
let NON_INTERACTIVE = false;

/**
 * Resolve a prompt's answer in non-interactive mode without blocking on
 * stdin. Returns the default if NON_INTERACTIVE is set; otherwise returns
 * null and the caller should fall back to the live prompt.
 */
function nonInteractiveDefault<T>(value: T): T | null {
  return NON_INTERACTIVE ? value : null;
}

/**
 * `agenticmail setup-relay` — focused subcommand for adding the Gmail
 * (or Outlook / custom) relay AFTER the initial bootstrap is done.
 *
 * # Why this exists separately from `agenticmail setup`
 *
 * `setup` re-runs the whole bootstrap (Stalwart, master key, default
 * agent, etc) which is overkill for a returning operator who just
 * wants to add outbound email. More importantly, the relay step
 * needs a Gmail app password — and the SAFE way to collect that is
 * here, in the operator's own terminal, via hidden `askSecret`
 * stdin input. The operator never pastes the password into an LLM
 * chat where it would land in context windows / logs / conversation
 * history.
 *
 * The recommended UX is: when an operator's host agent (claude /
 * codex) wants to set up the relay, the agent tells the operator
 * to run this command themselves. The agent then waits for "done"
 * and proceeds. The agent never sees the credential.
 *
 * # What it does
 *
 *   1. Loads `~/.agenticmail/config.json` (errors out if AgenticMail
 *      isn't bootstrapped yet — directs operator to `agenticmail setup`).
 *   2. Calls the shared `setupRelay()` helper used by the main
 *      bootstrap, which prompts via `askSecret` (hidden) and POSTs
 *      to `/api/agenticmail/gateway/relay`.
 *   3. Prints the result + a pointer to `setup_operator_email` so
 *      the operator can wire bridge-escalation forwarding next.
 */
async function cmdSetupRelay() {
  const args = process.argv.slice(3);
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup-relay ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup-relay`);
    log('');
    log(`  Adds (or updates) the Gmail / Outlook / custom relay AgenticMail uses`);
    log(`  to send mail to the public internet. Run this YOURSELF — never paste`);
    log(`  the Gmail app password into an agent's chat (it would end up in the`);
    log(`  LLM's context / logs / conversation history).`);
    log('');
    log(`  Password input is hidden (raw-mode stdin). The agent never sees it.`);
    log('');
    log(`  Prereq: AgenticMail already bootstrapped (run \`agenticmail setup\` first).`);
    log('');
    return;
  }

  // Load existing config — we refuse to run if AgenticMail isn't set up.
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) {
    log('');
    fail(`AgenticMail isn't set up yet — no config at ${c.dim(configPath)}`);
    log(`  Run ${c.cyan('agenticmail setup')} first, then come back to add the relay.`);
    log('');
    process.exit(1);
  }

  let config: SetupConfig;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig;
  } catch (err) {
    log('');
    fail(`Could not read ${configPath}: ${(err as Error).message}`);
    log('');
    process.exit(1);
  }

  // Heads-up banner so the operator knows the agent has no visibility.
  log('');
  log(`   ${c.bold('🎀 AgenticMail — set up Gmail relay')} `);
  log('');
  log(`  ${c.dim('This command runs entirely in your terminal. The password')}`);
  log(`  ${c.dim('input is hidden and never leaves this process — your agent')}`);
  log(`  ${c.dim("doesn't see it.")}`);
  log('');

  try {
    const result = await setupRelay(config);
    if (!result.success) {
      log('');
      fail('Relay setup did not complete — see messages above.');
      process.exit(1);
    }
    log('');
    ok('Gmail relay configured.');
    log('');
    log(`  ${c.bold('Next:')} point bridge-escalation alerts at your personal email:`);
    log('');
    log(`    ${c.cyan('Option A')} — tell your host agent: "set my operator notification email to <you@gmail.com>"`);
    log(`    ${c.cyan('Option B')} — open the web UI → click your avatar → ${c.bold('Alert email')} → type, Save`);
    log('');
    log(`  ${c.dim('Either path writes ~/.agenticmail/operator-prefs.json — the dispatcher')}`);
    log(`  ${c.dim("forwards a digest there when sub-agents mail your bridge and the")}`);
    log(`  ${c.dim("dispatcher can't resume your host session.")}`);
    log('');
  } catch (err) {
    log('');
    fail(`Setup-relay failed: ${(err as Error).message}`);
    log('');
    process.exit(1);
  }
}

/**
 * `agenticmail setup-email` — minimal "just connect my mailbox" flow.
 *
 * Asks for two things and nothing else: email address + password. The
 * provider is auto-detected from the email domain (Gmail, Outlook /
 * Microsoft 365, custom). For custom domains we additionally ask for
 * the SMTP host (port defaults to 587, IMAP defaults to 993) — because
 * we genuinely don't know where the mail server lives. Anyone using
 * Google Workspace on a custom domain (user@theirco.com via Gmail)
 * should pick "gmail" when prompted; we surface that as a hint.
 *
 * Separate from `setup-relay` (which is the full interactive flow
 * with provider menus + custom-host prompts + agent-naming + retry
 * loop). This one stays tight: collect creds, POST, done.
 */
async function cmdSetupEmail() {
  const args = process.argv.slice(3);
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup-email ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup-email`);
    log('');
    log(`  Minimal email-relay setup: enter your address, enter the password,`);
    log(`  done. Provider (Gmail, Outlook, custom) is detected from the domain.`);
    log(`  Password is collected via hidden stdin — your agent never sees it.`);
    log('');
    log(`  Prereq: AgenticMail already bootstrapped (run \`agenticmail setup\` first).`);
    log('');
    return;
  }

  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) {
    log('');
    fail(`AgenticMail isn't set up yet — no config at ${c.dim(configPath)}`);
    log(`  Run ${c.cyan('agenticmail setup')} first, then come back to add your email.`);
    log('');
    process.exit(1);
  }

  let config: SetupConfig;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig;
  } catch (err) {
    log('');
    fail(`Could not read ${configPath}: ${(err as Error).message}`);
    log('');
    process.exit(1);
  }

  log('');
  log(`   ${c.bold('🎀 AgenticMail — connect your mailbox')} `);
  log('');
  log(`  ${c.dim('Two questions: your email, your password. Password input is')}`);
  log(`  ${c.dim("hidden and never leaves this process — your agent doesn't see it.")}`);
  log('');

  // Make sure the API is up before we collect creds.
  const apiBase = `http://${config.api.host}:${config.api.port}`;
  let serverReady = false;
  try {
    const probe = await fetch(`${apiBase}/api/agenticmail/health`, { signal: AbortSignal.timeout(2_000) });
    serverReady = probe.ok;
  } catch { /* not running */ }
  if (!serverReady) {
    try { serverReady = await startApiServer(config); } catch { /* fall through */ }
  }
  if (!serverReady) {
    fail(`API server not reachable at ${c.cyan(apiBase)}`);
    info(`Start it with ${c.green('agenticmail start')}, then re-run this command.`);
    process.exit(1);
  }

  // Reuse the first existing agent name if one's already provisioned, so
  // running this on an already-set-up box doesn't create duplicate agents.
  let agentName = 'secretary';
  try {
    const acctResp = await fetch(`${apiBase}/api/agenticmail/accounts`, {
      headers: { 'Authorization': `Bearer ${config.masterKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (acctResp.ok) {
      const data = await acctResp.json() as any;
      const agents = data?.agents ?? data ?? [];
      const first = agents.find((a: any) => a.name && a.name !== 'claudecode' && a.name !== 'codex') ?? agents[0];
      if (first?.name) agentName = first.name;
    }
  } catch { /* ignore */ }

  // Email prompt loops until we get something that at least looks like
  // user@host. A typo shouldn't tear the whole flow down — re-prompt
  // and let the operator fix it. Hard cap so a stuck pipe doesn't spin
  // forever, but generous enough that humans don't notice.
  const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
  const OUTLOOK_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']);
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_EMAIL_ATTEMPTS = 5;

  let email = '';
  for (let attempt = 1; attempt <= MAX_EMAIL_ATTEMPTS; attempt++) {
    const raw = (await ask(`  ${c.cyan('Your email address:')} `)).trim();
    if (EMAIL_SHAPE.test(raw)) {
      email = raw;
      break;
    }
    fail(`That doesn't look like a valid email address${raw ? ` (${raw})` : ''}.`);
    if (attempt === MAX_EMAIL_ATTEMPTS) {
      log('');
      info('Too many invalid attempts — exiting. Re-run `agenticmail setup-email` when ready.');
      log('');
      process.exit(1);
    }
    info(`Try again ${c.dim(`(attempt ${attempt + 1} of ${MAX_EMAIL_ATTEMPTS})`)}`);
  }

  // Auto-detect provider from the domain.
  const domain = email.split('@')[1]!.toLowerCase();
  let provider: RelayProvider;
  let smtpHost: string | undefined;
  let smtpPort: number | undefined;
  let imapHost: string | undefined;
  let imapPort: number | undefined;
  let appPasswordHint = '';

  if (GMAIL_DOMAINS.has(domain)) {
    provider = 'gmail';
    appPasswordHint = `App password: ${c.cyan('https://myaccount.google.com/apppasswords')}`;
  } else if (OUTLOOK_DOMAINS.has(domain)) {
    provider = 'outlook';
    appPasswordHint = `App password: your Microsoft account → Security → Advanced security options → App passwords`;
  } else {
    // Custom domain. Most common case is Google Workspace / Microsoft 365
    // hosting a vanity domain — in which case SMTP/IMAP still points at
    // Gmail / Outlook servers. Offer that as a one-key shortcut so the
    // operator doesn't have to type smtp.gmail.com themselves.
    log('');
    log(`  ${c.dim("We don't recognize the domain ")}${c.bold(domain)}${c.dim('. Where does it live?')}`);
    log(`    ${c.cyan('1.')} Google Workspace ${c.dim('(mail hosted by Gmail)')}`);
    log(`    ${c.cyan('2.')} Microsoft 365 ${c.dim('(mail hosted by Outlook)')}`);
    log(`    ${c.cyan('3.')} Custom mail server`);
    const pickProv = await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);
    if (pickProv === '1') {
      provider = 'gmail';
      appPasswordHint = `App password: ${c.cyan('https://myaccount.google.com/apppasswords')}`;
    } else if (pickProv === '2') {
      provider = 'outlook';
      appPasswordHint = `App password: your Microsoft account → Security → Advanced security options → App passwords`;
    } else {
      provider = 'custom';
      log('');
      log(`  ${c.dim("Your mail-server hostnames (check your provider's docs):")}`);
      smtpHost = (await ask(`  ${c.cyan('Outgoing (SMTP) host:')} `)).trim();
      const smtpPortStr = (await ask(`  ${c.cyan('SMTP port')} ${c.dim('(587)')}: `)).trim();
      smtpPort = smtpPortStr ? parseInt(smtpPortStr, 10) : 587;
      imapHost = (await ask(`  ${c.cyan('Incoming (IMAP) host:')} `)).trim();
      const imapPortStr = (await ask(`  ${c.cyan('IMAP port')} ${c.dim('(993)')}: `)).trim();
      imapPort = imapPortStr ? parseInt(imapPortStr, 10) : 993;
    }
  }

  log('');
  if (appPasswordHint) log(`  ${c.dim(appPasswordHint)}`);
  log(`  ${c.dim("Spaces in the password are fine — we'll strip them.")}`);
  log('');

  // Password loop — retry on empty input AND on auth failure from the
  // mail provider. A typo'd app password is the single most common
  // failure mode here and shouldn't force the operator to restart the
  // whole command.
  const MAX_PASSWORD_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
    const rawPassword = await askSecret(`  ${c.cyan('Password:')} `);
    const password = rawPassword.replace(/\s+/g, '');
    if (!password) {
      fail('No password entered.');
      if (attempt === MAX_PASSWORD_ATTEMPTS) {
        info('Exiting — re-run `agenticmail setup-email` when ready.');
        log('');
        process.exit(1);
      }
      info(`Try again ${c.dim(`(attempt ${attempt + 1} of ${MAX_PASSWORD_ATTEMPTS})`)}`);
      continue;
    }

    log('');
    const spinner = new Spinner('relay');
    spinner.start();

    // Timeout note: SMTP + IMAP handshake against Gmail / Outlook can
    // take 20–40 s on slow links (TLS negotiation + first-time IMAP
    // mailbox enumeration). 30 s was tight; 90 s covers the long tail
    // without making the operator wait forever on a truly dead server.
    let response: Response;
    try {
      response = await fetch(`${apiBase}/api/agenticmail/gateway/relay`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.masterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider, email, password, agentName,
          smtpHost, smtpPort, imapHost, imapPort,
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      const msg = (err as Error).message;
      const isTimeout = msg.includes('aborted due to timeout') || (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      if (isTimeout) {
        spinner.fail('Mail server took too long to respond (>90 s).');
        if (attempt < MAX_PASSWORD_ATTEMPTS) {
          log(`  ${c.yellow('Could be a flaky link or a slow IMAP handshake. Try again.')} ${c.dim(`(attempt ${attempt + 1} of ${MAX_PASSWORD_ATTEMPTS})`)}`);
          log('');
          continue;
        }
        log('');
        info('If this keeps happening, check the API logs at ~/.agenticmail/logs/server.log');
        log('');
        process.exit(1);
      }
      spinner.fail(`Couldn't reach the API: ${msg}`);
      log('');
      process.exit(1);
    }

    if (response.ok) {
      const data = await response.json() as any;
      spinner.succeed(`Mailbox connected — ${c.bold(email)} ${c.dim('via ' + provider)}`);
      if (data?.agent?.subAddress) {
        log('');
        ok(`Agent ${c.bold('"' + (data.agent.name ?? agentName) + '"')} ready at ${c.cyan(data.agent.subAddress)}`);
      }
      log('');
      log(`  ${c.bold('Next:')} point bridge-escalation alerts at your personal email:`);
      log('');
      log(`    ${c.cyan('Option A')} — tell your host agent: "set my operator notification email to <you@example.com>"`);
      log(`    ${c.cyan('Option B')} — open the web UI → click your avatar → ${c.bold('Alert email')} → type, Save`);
      log('');
      // Drop into the interactive shell — mirrors setup-phone /
      // setup-telegram so every `setup-*` command lands the operator
      // somewhere they can immediately USE what they just configured
      // (check the inbox, send a test message, etc).
      await interactiveShell({ config, onExit: () => {} });
      return;
    }

    // Non-OK response — figure out whether it's recoverable (auth) or fatal.
    const text = await response.text();
    const friendly = parseFriendlyError(text);
    spinner.fail(friendly.message);

    if (friendly.isAuthError && attempt < MAX_PASSWORD_ATTEMPTS) {
      log(`  ${c.yellow('Wrong password — try again.')} ${c.dim(`(attempt ${attempt + 1} of ${MAX_PASSWORD_ATTEMPTS})`)}`);
      log('');
      continue;
    }
    // Non-auth error (mail server unreachable, server config issue) or
    // we've exhausted our password attempts — surface and exit. Operator
    // can re-run after fixing whatever the underlying issue is.
    log('');
    if (friendly.isAuthError) {
      info('Check the email + password and re-run `agenticmail setup-email`.');
    }
    log('');
    process.exit(1);
  }
}

/**
 * `agenticmail setup-phone` — non-interactive phone-transport setup.
 *
 * Companion to `setup-email`: this is the focused subcommand for adding
 * a Twilio / 46elks calling carrier AFTER the initial bootstrap is
 * done, without re-running the full interactive `setup` wizard.
 *
 * Everything comes from flags or env vars — no prompts. That makes the
 * command safe for a Claude / scripted install: secrets travel via
 * `--auth-token` / `TWILIO_AUTH_TOKEN` and never appear in shell
 * history when the operator pipes them in (the same way you'd hand
 * a curl an `--data @-` body). The auth token is also masked in any
 * log line this command emits.
 *
 * Usage:
 *
 *     agenticmail setup-phone --provider twilio \
 *         --account-sid ACxxxx --auth-token xxxx \
 *         --phone-number +13105550000 \
 *         --webhook-url https://your-tunnel.example/
 *
 *     agenticmail setup-phone --provider 46elks \
 *         --username uXXXX --password XXXX \
 *         --phone-number +461234567 \
 *         --webhook-url https://your-tunnel.example/
 *
 * Or via env (handy when piping secrets from a vault):
 *
 *     TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx \
 *         AGENTICMAIL_PHONE_NUMBER=+13105550000 \
 *         AGENTICMAIL_WEBHOOK_URL=https://.../  \
 *         agenticmail setup-phone --provider twilio
 *
 * `--webhook-secret` is optional; we mint a 24-byte hex one if absent
 * so the operator doesn't need to invent entropy themselves. The
 * webhook secret is stored encrypted at rest under the master key
 * (same as the Twilio auth token).
 */
/**
 * `agenticmail setup-anthropic` — wire up the Anthropic OAuth token
 * the Telegram bridge and the claudecode dispatcher both need.
 *
 * Three paths, in order of friendliness:
 *
 *   1. **Wrap `claude setup-token`** (the default). The Claude Code
 *      CLI ships a built-in OAuth flow that opens the user's
 *      browser at console.anthropic.com, prompts them to authorise,
 *      and prints a long-lived bearer token to stdout. We spawn it
 *      with inherited stdio so the user sees + interacts with the
 *      whole flow naturally, then ask them to paste the token back
 *      so we can save it to `~/.agenticmail/anthropic-token` (0600).
 *
 *      Why we don't try to scrape `claude setup-token`'s stdout
 *      automatically: the output format isn't a public contract and
 *      has shifted between Claude Code versions. A one-paste step
 *      that the operator does once after the OAuth flow is robust
 *      across every version + future format change.
 *
 *   2. **Paste an existing token** via `--token` flag or
 *      `ANTHROPIC_AUTH_TOKEN` env var. Useful if the user already
 *      ran `claude setup-token` separately, OR if they have an
 *      `sk-ant-oat01-...` token from a vault / CI secret.
 *
 *   3. **`--api-key` flag (or `ANTHROPIC_API_KEY` env)** for
 *      pay-per-token routing. Same target file; the dispatcher /
 *      bridge load it through the same env var the SDK reads.
 *
 * After the token is saved, the bridge picks it up on next startup
 * (or the live bridge re-reads it on its next message). The
 * dispatcher picks it up at next restart.
 */
async function cmdSetupAnthropic() {
  const args = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const eq = `--${name}=`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
      if (args[i].startsWith(eq)) return args[i].slice(eq.length);
    }
    return undefined;
  };
  if (args.includes('--help') || args.includes('-h')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup-anthropic ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup-anthropic [--token <oauth>] [--api-key <sk-ant-...>]`);
    log('');
    log(`  With no flags, runs ${c.cyan('claude setup-token')} interactively (browser flow),`);
    log(`  then asks you to paste the long-lived token it prints. Saved to`);
    log(`  ${c.dim('~/.agenticmail/anthropic-token')} (0600). The Telegram bridge and the`);
    log(`  Claude Code dispatcher both read from that file.`);
    log('');
    log(`  ${c.bold('Non-interactive (scripted / CI):')}`);
    log(`    --token <bearer>     ${c.dim('Or env ANTHROPIC_AUTH_TOKEN')}`);
    log(`    --api-key <sk-ant->  ${c.dim('Or env ANTHROPIC_API_KEY (pay-per-token)')}`);
    log('');
    return;
  }

  const homedirFn = (await import('node:os')).homedir;
  const { mkdirSync: mkdir, writeFileSync: write, chmodSync } = await import('node:fs');
  const tokenPath = join(homedirFn(), '.agenticmail', 'anthropic-token');
  mkdir(join(homedirFn(), '.agenticmail'), { recursive: true });

  // Path 2 / 3 — non-interactive, take the value from a flag / env and persist.
  const direct = flag('token') ?? flag('api-key')
    ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (direct) {
    const trimmedDirect = direct.trim();
    // Validate against the live API before writing. Skip-validation
    // escape hatch for the rare case the operator is offline or
    // behind a proxy and willing to trust their input.
    const skipValidate = args.includes('--skip-validate') || process.env.AGENTICMAIL_SKIP_TOKEN_VALIDATE === '1';
    if (!skipValidate) {
      info('Validating against api.anthropic.com…');
      const result = await validateAnthropicToken(trimmedDirect);
      if (!result.ok) {
        log('');
        fail(`Token rejected (${result.reason}): ${result.message}`);
        if (result.reason === 'subscription-disabled') {
          info('Tip: use --api-key with an sk-ant-api03-... key instead, OR ask your org admin to re-enable Claude Code subscription access.');
        } else if (result.reason === 'network') {
          info(`Bypass the network check with: ${c.green('--skip-validate')} (saves the token without contacting Anthropic).`);
        }
        process.exit(1);
      }
      ok(`Token validated (${identifyTokenKind(trimmedDirect)}).`);
    }
    write(tokenPath, trimmedDirect, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    log('');
    ok(`Saved to ${c.dim(tokenPath)}`);
    info('The Telegram bridge and Claude Code dispatcher will pick this up on next restart.');
    log('');
    return;
  }

  if (!process.stdin.isTTY) {
    fail('Non-interactive run requires --token, --api-key, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY.');
    info(`See: ${c.green('agenticmail setup-anthropic --help')}`);
    process.exit(1);
  }

  // Path 1 — interactive OAuth flow via `claude setup-token`.
  log('');
  log(`  ${c.bold('🎀 AgenticMail — connect Anthropic auth')}`);
  log('');
  log(`  ${c.dim('We\'ll run ' + c.cyan('claude setup-token') + ' for you. This opens a browser')}`);
  log(`  ${c.dim('tab at console.anthropic.com, asks you to log in / authorise, and')}`);
  log(`  ${c.dim('prints a long-lived token at the end. You\'ll paste that token back')}`);
  log(`  ${c.dim('here and we\'ll save it to ~/.agenticmail/anthropic-token (0600).')}`);
  log('');

  // Pre-check: is `claude` on PATH? Without it the OAuth flow has
  // no entry point. Surface a clear actionable error instead of an
  // ENOENT five seconds later.
  let claudeBin = '';
  try {
    const { execFileSync } = await import('node:child_process');
    claudeBin = execFileSync('which', ['claude'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* not found */ }
  if (!claudeBin) {
    fail('`claude` is not on your PATH.');
    info(`Install Claude Code first: ${c.green('npm install -g @anthropic-ai/claude-code')}`);
    info(`Then re-run: ${c.green('agenticmail setup-anthropic')}`);
    process.exit(1);
  }

  const proceed = await ask(`  ${c.bold('Press Enter to launch the browser flow, or Ctrl-C to cancel: ')}`);
  void proceed;

  // Spawn `claude setup-token` with full inherited stdio. The user
  // sees the URL, the prompts, and the printed token directly. We
  // do not try to capture stdout — the format isn't stable across
  // Claude Code versions, and the operator can simply paste the
  // token back to us as the next step.
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(claudeBin, ['setup-token'], { stdio: 'inherit' });
    if (result.status !== 0) {
      log('');
      fail(`claude setup-token exited with code ${result.status ?? '(signal: ' + result.signal + ')'}.`);
      info('If you cancelled the flow that\'s fine — re-run when ready.');
      process.exit(result.status ?? 1);
    }
  } catch (err) {
    fail(`Could not run claude setup-token: ${(err as Error).message}`);
    process.exit(1);
  }

  // The user has the token in front of them now. One paste back
  // into our hidden prompt is enough.
  log('');
  log(`  ${c.bold('Paste the long-lived token claude just printed')} ${c.dim('— input is hidden,')}`);
  log(`  ${c.dim('format starts with ' + c.green('sk-ant-oat01-...') + '.')}`);
  const pasted = (await askSecret(`  ${c.cyan('Token:')} `)).trim();
  if (!pasted) {
    fail('No token entered.');
    info(`Re-run when ready: ${c.green('agenticmail setup-anthropic')}`);
    process.exit(1);
  }
  if (!/^sk-ant-(oat01|api03)/.test(pasted)) {
    log('');
    info(`That doesn\'t look like a standard Anthropic token (sk-ant-oat01-... or sk-ant-api03-...).`);
    const confirm = (await ask(`  ${c.bold('Save it anyway?')} ${c.dim('(y/N)')} `)).trim().toLowerCase();
    if (!confirm.startsWith('y')) {
      info('Cancelled.');
      process.exit(0);
    }
  }

  // Live-validate before persisting. A pasted-but-rejected token is
  // the single most common cause of "the bridge silently refuses to
  // reply" — catching it here turns a multi-hour mystery into a 5-
  // second loop. The operator can retry with a fresh paste, or skip
  // validation if they know they're offline.
  log('');
  info('Validating against api.anthropic.com…');
  const validation = await validateAnthropicToken(pasted);
  if (!validation.ok) {
    log('');
    fail(`Anthropic rejected the token (${validation.reason}): ${validation.message}`);
    if (validation.reason === 'subscription-disabled') {
      log('');
      info('Your token is valid, but your org has Claude Code subscription access disabled.');
      info('Two fixes:');
      info(`  1. Ask your org admin to re-enable Claude Code at ${c.cyan('console.anthropic.com')}`);
      info(`  2. Generate an API key instead and run: ${c.green('agenticmail setup-anthropic --api-key sk-ant-api03-...')}`);
    } else if (validation.reason === 'network') {
      info(`Offline / proxy issue. To save without validating: ${c.green('agenticmail setup-anthropic --skip-validate')}`);
    } else if (validation.reason === 'rate-limited') {
      info('Rate-limited at the source. Wait a minute and re-run.');
    }
    log('');
    const retry = (await ask(`  ${c.bold('Save it anyway?')} ${c.dim('(y/N)')} `)).trim().toLowerCase();
    if (!retry.startsWith('y')) {
      info('Cancelled — nothing written.');
      process.exit(1);
    }
  } else {
    ok(`Token validated (${identifyTokenKind(pasted)}).`);
  }

  write(tokenPath, pasted, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  log('');
  ok(`Saved to ${c.dim(tokenPath)} (0600).`);
  info('The Telegram bridge picks this up on next message. Restart the dispatcher to use it:');
  info(`  ${c.green('pm2 restart agenticmail-claudecode-dispatcher')}  ${c.dim('(or)')}`);
  info(`  ${c.green('agenticmail stop && agenticmail start')}`);
  log('');
}

async function cmdSetupPhone() {
  const args = process.argv.slice(3);

  function flag(name: string): string | undefined {
    const eq = `--${name}=`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
      if (args[i].startsWith(eq)) return args[i].slice(eq.length);
    }
    return undefined;
  }
  const hasFlag = (name: string) => args.includes(`--${name}`);

  if (hasFlag('help') || args.includes('-h') || args.includes('help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup-phone ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup-phone --provider <twilio|46elks> [flags]`);
    log('');
    log(`  ${c.bold('Flags / env (either works):')}`);
    log(`    --provider <twilio|46elks>     ${c.dim('Required')}`);
    log(`    --phone-number  <E.164>        ${c.dim('Env: AGENTICMAIL_PHONE_NUMBER')}`);
    log(`    --webhook-url   <https://...>  ${c.dim('Env: AGENTICMAIL_WEBHOOK_URL')}`);
    log(`    --webhook-secret <string>      ${c.dim('Env: AGENTICMAIL_WEBHOOK_SECRET (auto-gen if absent)')}`);
    log('');
    log(`  ${c.bold('Twilio:')}`);
    log(`    --account-sid <AC...>          ${c.dim('Env: TWILIO_ACCOUNT_SID')}`);
    log(`    --auth-token  <secret>         ${c.dim('Env: TWILIO_AUTH_TOKEN')}`);
    log('');
    log(`  ${c.bold('46elks:')}`);
    log(`    --username <user>              ${c.dim('Env: ELKS_USERNAME')}`);
    log(`    --password <pass>              ${c.dim('Env: ELKS_PASSWORD')}`);
    log('');
    log(`  ${c.dim('Secrets are stored encrypted at rest under your master key.')}`);
    log(`  ${c.dim('Pipe via env / stdin to keep them out of shell history.')}`);
    log('');
    log(`  ${c.bold('--webhook-url is optional:')} if you skip it, we open a free Cloudflare`);
    log(`  ${c.dim('quick-tunnel for you (https://*.trycloudflare.com) — no Cloudflare account,')}`);
    log(`  ${c.dim('no signup, no domain. The tunnel stays up across `setup-phone` runs.')}`);
    log('');
    return;
  }

  // Provider: --provider flag wins; otherwise prompt the user to pick
  // when running interactively (the typical case — someone just typed
  // `agenticmail setup-phone` at the terminal and expects a wizard).
  // Only fall through to the hard error when there's no TTY (scripted
  // / piped invocations where blocking on stdin would hang forever).
  let provider = flag('provider');
  if (provider !== 'twilio' && provider !== '46elks') {
    if (provider !== undefined) {
      // User passed --provider but it wasn't one of the two valid values.
      fail(`--provider must be "twilio" or "46elks" (got: ${provider})`);
      info(`See: ${c.green('agenticmail setup-phone --help')}`);
      process.exit(1);
    }
    if (!process.stdin.isTTY) {
      fail('--provider is required when running non-interactively (no TTY).');
      info(`See: ${c.green('agenticmail setup-phone --help')}`);
      process.exit(1);
    }
    // Interactive pick.
    log('');
    log(`  ${c.bold('🎀 AgenticMail — connect phone calling')}`);
    log('');
    log(`  ${c.dim('Pick your carrier:')}`);
    log(`    ${c.cyan('1.')} Twilio    ${c.dim('(US/global; needs Account SID + Auth Token)')}`);
    log(`    ${c.cyan('2.')} 46elks    ${c.dim('(EU-friendly; needs API username + password)')}`);
    log('');
    const choice = (await ask(`  ${c.magenta('>')} `)).trim();
    if (choice === '1' || choice.toLowerCase() === 'twilio') provider = 'twilio';
    else if (choice === '2' || choice.toLowerCase() === '46elks') provider = '46elks';
    else {
      log('');
      fail(`Unknown choice: "${choice}". Enter 1, 2, twilio, or 46elks.`);
      process.exit(1);
    }
    log('');
  }

  // Webhook secret needs ≥24 chars of entropy; mint one if the operator
  // didn't supply it so they don't have to invent it themselves. Same
  // logic the interactive wizard uses.
  const customSecret = flag('webhook-secret') ?? process.env.AGENTICMAIL_WEBHOOK_SECRET ?? '';
  const webhookSecret = customSecret || randomBytes(24).toString('hex');

  // We need the API server up + an agent api key before we can read
  // existing config and save changes. Resolve both up front so the
  // re-entrant flow can show what's already set in the summary.
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) {
    fail(`AgenticMail isn't set up yet — no config at ${c.dim(configPath)}`);
    info(`Run ${c.cyan('agenticmail setup')} first, then re-run this.`);
    process.exit(1);
  }
  let config: SetupConfig;
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig; }
  catch (err) { fail(`Could not read ${configPath}: ${(err as Error).message}`); process.exit(1); }

  const apiBase = `http://${config.api.host}:${config.api.port}`;
  try {
    const probe = await fetch(`${apiBase}/api/agenticmail/health`, { signal: AbortSignal.timeout(2_000) });
    if (!probe.ok) throw new Error('not ok');
  } catch {
    try { await startApiServer(config); }
    catch { fail(`API server not reachable at ${c.cyan(apiBase)}. Start it with ${c.green('agenticmail start')}.`); process.exit(1); }
  }

  const agent = await resolveAgentApiKey(config);
  if (!agent) {
    fail('No agent provisioned yet — connect email first via `agenticmail setup-email`.');
    process.exit(1);
  }

  // Pull whatever's already saved for this agent's phone transport, so
  // a second run of `setup-phone` can show "currently configured"
  // values and only prompt for what's missing. Endpoint returns the
  // config with secrets redacted to `(encrypted)` — we treat the
  // presence of `(encrypted)` as "this secret is set" without
  // exposing the literal bytes.
  let existing: any = {};
  try {
    const r = await fetch(`${apiBase}/api/agenticmail/phone/transport/config`, {
      headers: { 'Authorization': `Bearer ${agent.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) existing = (await r.json() as any)?.transport ?? {};
  } catch { /* not yet configured */ }

  // The OpenAI key lives in `~/.agenticmail/config.json` (not in agent
  // metadata) — it's the one credential the realtime voice bridge
  // needs to actually carry a spoken conversation on the call.
  // Optional. Without it the carrier still places the call, but the
  // voice bridge fails on connect and the recipient hears silence —
  // we warn loudly at the end if the user skipped it.
  const existingOpenaiKey = (config as any).openaiApiKey ?? '';

  // Build the field list for the shared collector. Order matters —
  // these are the order the user will see prompts in, so the cheap-
  // to-paste values (number, SID) come before the slow-to-find ones
  // (auth token) and the optional-with-warning OpenAI key last.
  const credFields: SetupField[] = [
    {
      key: 'phone-number',
      label: 'Caller phone number',
      hint: [
        'The number from your carrier — the one the agent calls FROM.',
        'Must be in E.164 format (starts with +, then country code).',
      ],
      placeholder: '(e.g. +15555550100)',
      current: existing.phoneNumber ?? flag('phone-number') ?? process.env.AGENTICMAIL_PHONE_NUMBER ?? '',
      required: true,
    },
    {
      key: 'username',
      label: provider === 'twilio' ? 'Twilio Account SID' : '46elks API username',
      hint: provider === 'twilio'
        ? ['Find it at console.twilio.com → top-right Account dashboard,', '"Account SID" (starts with AC...).']
        : ['Find it at 46elks.com dashboard → Account → API credentials,', '"Username".'],
      // Account SIDs are visible identifiers (not strictly secret) —
      // 46elks usernames are similarly public. Show as-is.
      current: existing.username ?? (provider === 'twilio'
        ? (flag('account-sid') ?? process.env.TWILIO_ACCOUNT_SID ?? '')
        : (flag('username') ?? process.env.ELKS_USERNAME ?? '')),
      required: true,
    },
    {
      key: 'password',
      label: provider === 'twilio' ? 'Twilio Auth Token' : '46elks API password',
      hint: [
        provider === 'twilio'
          ? 'Same Twilio Account page — click "View" on the primary Auth Token.'
          : 'Same 46elks dashboard page, "Password" field.',
        'This is a SECRET; treat it like a password.',
        'Input is hidden — you won\'t see what you type, that\'s expected.',
      ],
      secret: true,
      // Encrypted-at-rest — the API redacts to `(encrypted)`. We flag
      // its presence via `hasValue`, never pull the decrypted bytes
      // into the cli. `current` stays empty so the summary renders
      // "(set — kept unless you update below)" cleanly.
      hasValue: !!existing.password,
      current: !existing.password
        ? (provider === 'twilio'
            ? (flag('auth-token') ?? process.env.TWILIO_AUTH_TOKEN ?? '')
            : (flag('password') ?? process.env.ELKS_PASSWORD ?? ''))
        : '',
      required: true,
    },
    {
      key: 'openai-api-key',
      label: 'OpenAI API key (for realtime voice)',
      hint: [
        'Optional. Without it, the agent CANNOT have live spoken phone',
        'conversations — calls connect but the voice bridge has nothing',
        'to power the agent\'s speech. With it, the agent listens and',
        'responds in real time via OpenAI\'s Realtime API.',
        'Get a key at https://platform.openai.com/api-keys.',
      ],
      secret: true,
      // Stored in `~/.agenticmail/config.json` plaintext (file mode
      // 0600). We do have the literal value but treat it as a secret
      // via `hasValue` to avoid showing it to anyone shoulder-surfing
      // — the summary renders "(set — kept unless you update below)".
      hasValue: !!existingOpenaiKey,
      current: !existingOpenaiKey
        ? (flag('openai-api-key') ?? process.env.OPENAI_API_KEY ?? '')
        : '',
      required: false,
    },
  ];

  let collected;
  try {
    collected = await collectFields({
      title: `Connect ${provider} phone calling`,
      fields: credFields,
      isTTY: !!process.stdin.isTTY,
      prompts: { ask, askSecret },
      c: { bold: c.bold, dim: c.dim, cyan: c.cyan, green: c.green, yellow: c.yellow, magenta: c.magenta },
      logger: { log, ok, info, fail },
    });
  } catch (err) {
    // SetupError is the "still missing required" outcome — the
    // collector already printed a user-facing line, just exit.
    if (err instanceof SetupError) process.exit(1);
    throw err;
  }

  // Untangle the collected values. For secrets the user "kept", the
  // collected value is the placeholder string `(encrypted, kept...)`
  // — we substitute back the empty-string marker so the API knows to
  // leave the encrypted-at-rest value alone instead of overwriting it
  // with the placeholder text.
  const phoneNumber = collected.values['phone-number'];
  const username = collected.values['username'];
  const passwordRaw = collected.values['password'];
  const password = collected.changedKeys.includes('password') ? passwordRaw : '';
  const openaiKeyRaw = collected.values['openai-api-key'];
  const openaiKey = collected.changedKeys.includes('openai-api-key') ? openaiKeyRaw : '';
  const openaiKeyEffective = openaiKey || existingOpenaiKey;

  let webhookBaseUrl = flag('webhook-url') ?? process.env.AGENTICMAIL_WEBHOOK_URL ?? existing.webhookBaseUrl ?? '';

  // Tunnel comes LAST — by this point the user has answered every
  // question and just wants AgenticMail to finish. A spinner here is
  // a "working on it" indicator, not a wall of waiting before any
  // input. Reuse a live tunnel if one's already running.
  if (!webhookBaseUrl) {
    log(`  ${c.bold('4) Public webhook URL')}`);
    log(`  ${c.dim('   ' + provider + ' needs to send webhooks to your machine. We\'ll open a free')}`);
    log(`  ${c.dim('   Cloudflare quick-tunnel (https://*.trycloudflare.com) — no domain, no')}`);
    log(`  ${c.dim('   Cloudflare account, no signup. The tunnel stays up across setup-phone runs.')}`);
    log('');
    const tunnelSpinner = new Spinner('general', 'Opening Cloudflare quick-tunnel...');
    tunnelSpinner.start();
    const url = await ensureTunnelUrl();
    if (url) {
      webhookBaseUrl = url;
      tunnelSpinner.succeed(`Tunnel ready — webhooks will be delivered to ${c.cyan(url)}`);
    } else {
      tunnelSpinner.fail('Could not open a Cloudflare tunnel (cloudflared not installed?).');
      info(`Install cloudflared (${c.dim('macOS: brew install cloudflared, or run `agenticmail bootstrap`')}), then re-run this command.`);
      info(`Or pass your own URL: ${c.green('--webhook-url https://your-domain.example/')}`);
      process.exit(1);
    }
    log('');
  }

  // Save the OpenAI key first if it changed — the realtime voice
  // bridge reads `openaiApiKey` from `~/.agenticmail/config.json` at
  // session-open time. Doing this BEFORE the phone-transport POST
  // means if the operator does test-call immediately afterward, the
  // already-running API server picks up the key on its first read
  // (the bridge doesn't cache it).
  if (openaiKey) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      fileConfig.openaiApiKey = openaiKey;
      writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
      ok('OpenAI API key saved — realtime voice is enabled.');
    } catch (err) {
      fail(`Could not save OpenAI API key: ${(err as Error).message}`);
      info('Phone transport will still be saved, but realtime voice will not work until the key is configured.');
    }
  }

  log('');
  log(`  ${c.bold(`🎀 AgenticMail — connect ${provider} phone calling`)}`);
  log('');
  log(`  ${c.dim('agent:')}      ${c.cyan(agent.name)}`);
  log(`  ${c.dim('provider:')}   ${provider}`);
  log(`  ${c.dim('number:')}     ${phoneNumber}`);
  log(`  ${c.dim('webhook:')}    ${webhookBaseUrl}`);
  log('');

  const spinner = new Spinner('general', 'Saving phone transport...');
  spinner.start();
  try {
    // Build the POST body — omit password ONLY if the user kept the
    // existing encrypted value (we don't have the real bytes to send).
    // The server route treats a missing `password` on update as "keep
    // the existing encrypted-at-rest value as-is", so the call still
    // succeeds and Twilio webhook signing keeps working.
    // supportedRegions must be set explicitly per-provider. Twilio is a
    // global carrier — without ['WORLD'] the mission gate rejects any
    // call whose destination isn't in the EU as `transport-region-unsupported`.
    // 46elks remains EU-only. Sending this on every save also REPAIRS
    // pre-0.9.79 Twilio installs that got the wrong ['EU'] default written
    // to disk: the server merges over existing config, so re-running
    // setup-phone is enough to fix a stuck install.
    const supportedRegions = provider === 'twilio' ? ['WORLD'] : ['EU'];
    const body: Record<string, unknown> = {
      provider, phoneNumber, username, webhookBaseUrl, webhookSecret, supportedRegions,
    };
    if (password) body.password = password;
    const resp = await fetch(`${apiBase}/api/agenticmail/phone/transport/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      spinner.succeed(`Phone calling enabled — ${c.bold(phoneNumber)} via ${provider}, linked to ${c.bold(agent.name)}`);
      info(`Your agent can now place outbound calls. Try ${c.green('/call')} from ${c.green('agenticmail shell')}.`);
      log('');
    } else {
      const text = await resp.text();
      spinner.fail(`Could not save phone transport: ${parseFriendlyError(text).message}`);
      log('');
      process.exit(1);
    }
  } catch (err) {
    spinner.fail(`Could not save phone transport: ${(err as Error).message}`);
    process.exit(1);
  }

  // No OpenAI key configured — the carrier transport is saved, but
  // calls cannot actually carry a spoken conversation yet. Surface
  // this loudly so the operator doesn't discover it the first time
  // they try `/call`. Single yellow-tinted block (no spinner, no
  // animation — this is documentation the user re-reads).
  if (!openaiKeyEffective) {
    log('');
    log(`  ${c.yellow('⚠')} ${c.bold('No OpenAI API key configured')} ${c.dim('— calls will not work yet.')}`);
    log('');
    log(`  ${c.dim('The agent\'s spoken voice on a phone call is driven by the OpenAI')}`);
    log(`  ${c.dim('Realtime API. Without a key, an outbound call connects but the')}`);
    log(`  ${c.dim('voice bridge fails on open and the recipient hears silence.')}`);
    log('');
    log(`  ${c.bold('Add a key any time:')}`);
    log(`    ${c.green('agenticmail setup-phone --provider ' + provider)}    ${c.dim('(re-run this; we\'ll just prompt for the key)')}`);
    log(`  ${c.dim('Or pipe via env:')}`);
    log(`    ${c.green('OPENAI_API_KEY=… agenticmail setup-phone --provider ' + provider)}`);
    log('');
    log(`  ${c.dim('Get a key at https://platform.openai.com/api-keys.')}`);
    log('');
  }

  // Drop into the interactive shell. Every setup-* command lands here
  // — the operator just finished configuring something, the most
  // natural next thing is to USE that something (place a test call,
  // check the inbox, send a message). Bouncing back to a bare prompt
  // forces them to remember `agenticmail shell` and re-type it. The
  // shell exits cleanly on `/exit` and the API server keeps running
  // either way.
  await interactiveShell({ config, onExit: () => {} });
}

/**
 * `agenticmail setup-telegram` — non-interactive Telegram channel setup.
 *
 * Companion to `setup-email` / `setup-phone`. Takes the bot token and
 * (optionally) the operator's chat id via flags or env vars, registers
 * the channel against the running API, AND writes the three files
 * the standalone `agenticmail-telegram-bridge` service needs to wake
 * the agent on inbound DMs:
 *
 *   ~/.agenticmail/telegram/telegram-token        the BotFather token
 *   ~/.agenticmail/telegram/telegram-allowed-ids  one chat id per line
 *   ~/.agenticmail/telegram/agent-key             the agent's API key
 *                                                  (so MCP tools are
 *                                                  available to spawned
 *                                                  Claude turns)
 *
 * All three files are 0600. The bridge picks them up automatically the
 * next time `agenticmail start` runs (or immediately if the bridge is
 * already running and re-reads its config on poll). After this command
 * succeeds, the operator can DM their bot and the agent will reply with
 * full memory + tool access.
 *
 * Usage:
 *
 *     agenticmail setup-telegram --bot-token <token> --chat-id <id>
 *
 * Or via env:
 *
 *     TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... agenticmail setup-telegram
 */
async function cmdSetupTelegram() {
  const args = process.argv.slice(3);

  function flag(name: string): string | undefined {
    const eq = `--${name}=`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
      if (args[i].startsWith(eq)) return args[i].slice(eq.length);
    }
    return undefined;
  }
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup-telegram ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup-telegram --bot-token <token> [--chat-id <id>]`);
    log('');
    log(`  ${c.bold('Flags / env:')}`);
    log(`    --bot-token <token>   ${c.dim('Env: TELEGRAM_BOT_TOKEN (from @BotFather)')}`);
    log(`    --chat-id <id>        ${c.dim('Env: TELEGRAM_CHAT_ID (allow-list — your own chat)')}`);
    log('');
    log(`  ${c.dim('Token is stored encrypted at rest under your master key.')}`);
    log(`  ${c.dim('Pipe via env to keep it out of shell history.')}`);
    log('');
    return;
  }

  // Resolve config + agent up front so the re-entrant collector can
  // show what's already saved for this Telegram channel.
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) {
    fail(`AgenticMail isn't set up yet — no config at ${c.dim(configPath)}`);
    info(`Run ${c.cyan('agenticmail setup')} first, then re-run this.`);
    process.exit(1);
  }
  let config: SetupConfig;
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig; }
  catch (err) { fail(`Could not read ${configPath}: ${(err as Error).message}`); process.exit(1); }

  const apiBase = `http://${config.api.host}:${config.api.port}`;
  try {
    const probe = await fetch(`${apiBase}/api/agenticmail/health`, { signal: AbortSignal.timeout(2_000) });
    if (!probe.ok) throw new Error('not ok');
  } catch {
    try { await startApiServer(config); }
    catch { fail(`API server not reachable at ${c.cyan(apiBase)}. Start it with ${c.green('agenticmail start')}.`); process.exit(1); }
  }

  const agent = await resolveAgentApiKey(config);
  if (!agent) {
    fail('No agent provisioned yet — connect email first via `agenticmail setup-email`.');
    process.exit(1);
  }

  // Pull existing Telegram config (token redacted, allow-list visible)
  // so a second run can show "currently configured" + only prompt for
  // missing fields.
  let existingTg: any = {};
  try {
    const r = await fetch(`${apiBase}/api/agenticmail/telegram/config`, {
      headers: { 'Authorization': `Bearer ${agent.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) existingTg = (await r.json() as any)?.telegram ?? {};
  } catch { /* not yet configured */ }

  // Two fields: bot token (secret) + the operator's allowed chat id
  // (visible — that's just the numeric id of who's allowed to DM the
  // bot). Reuse the same shared collector as `setup-phone` so the
  // re-entrant "currently configured / update any?" UX is identical
  // across all the channel-setup commands.
  const fields: SetupField[] = [
    {
      key: 'bot-token',
      label: 'Telegram bot token',
      hint: [
        'Get one from @BotFather: open Telegram, message @BotFather,',
        'send /newbot, follow the prompts, and copy the token it returns.',
        'Input is hidden — you won\'t see what you type, that\'s expected.',
      ],
      secret: true,
      hasValue: !!existingTg.botToken,
      current: !existingTg.botToken
        ? (flag('bot-token') ?? process.env.TELEGRAM_BOT_TOKEN ?? '')
        : '',
      required: true,
    },
    {
      key: 'chat-id',
      label: 'Your Telegram chat id (allow-list)',
      hint: [
        'Restricts who can DM your bot. Find it by DMing your bot once,',
        'then visiting https://api.telegram.org/bot<TOKEN>/getUpdates and',
        'reading the numeric "from.id" out of the JSON.',
      ],
      placeholder: '(e.g. 1234567890)',
      current: existingTg.operatorChatId
        ?? (flag('chat-id') ?? process.env.TELEGRAM_CHAT_ID ?? '').trim(),
      required: false,
    },
  ];

  let collected;
  try {
    collected = await collectFields({
      title: 'Connect Telegram',
      fields,
      isTTY: !!process.stdin.isTTY,
      prompts: { ask, askSecret },
      c: { bold: c.bold, dim: c.dim, cyan: c.cyan, green: c.green, yellow: c.yellow, magenta: c.magenta },
      logger: { log, ok, info, fail },
    });
  } catch (err) {
    if (err instanceof SetupError) process.exit(1);
    throw err;
  }

  // Decide what to send to the API. For the token we ONLY send when
  // it just changed — sending the `(encrypted, kept...)` placeholder
  // would overwrite the real token with that literal string, breaking
  // the channel. If no fresh token AND none was set before, that's a
  // hard error (the collector already enforces required=true so this
  // is belt-and-suspenders).
  const botTokenNew = collected.changedKeys.includes('bot-token') ? collected.values['bot-token'] : '';
  const operatorChatId = collected.values['chat-id'] || '';
  if (!botTokenNew && !existingTg.botToken) {
    fail('A bot token is required to enable Telegram.');
    process.exit(1);
  }

  log('');
  log(`  ${c.bold('🎀 AgenticMail — connect Telegram')}`);
  log('');
  log(`  ${c.dim('agent:')}    ${c.cyan(agent.name)}`);
  log(`  ${c.dim('chat id:')}  ${operatorChatId || c.dim('(none — only the operator chat is allowed to DM, set later)')}`);
  log('');

  // Only POST to /telegram/setup if SOMETHING changed (new token OR
  // chat-id changed). Otherwise we're just confirming an already-saved
  // config — no need to roundtrip and possibly re-verify the token
  // against Telegram. Saves a few seconds on re-runs that just check
  // current state.
  const chatIdChanged = collected.changedKeys.includes('chat-id');
  if (botTokenNew || chatIdChanged) {
    const spinner = new Spinner('general', botTokenNew
      ? 'Verifying bot token with Telegram...'
      : 'Updating allowed chat id...');
    spinner.start();
    try {
      // The server's /telegram/setup now supports a partial-update
      // merge — if we omit `botToken`, it picks up the agent's
      // existing stored value. That means a chat-id-only change
      // doesn't force the user to re-paste the BotFather token.
      const tgBody: Record<string, unknown> = { mode: 'poll', operatorChatId: operatorChatId || undefined };
      if (botTokenNew) tgBody.botToken = botTokenNew;
      const resp = await fetch(`${apiBase}/api/agenticmail/telegram/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.apiKey}` },
        body: JSON.stringify(tgBody),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        spinner.fail(`Could not enable Telegram: ${parseFriendlyError(text).message}`);
        process.exit(1);
      }
      const data = await resp.json() as any;
      const botName = data?.bot?.username ? `@${data.bot.username}` : 'your bot';
      spinner.succeed(`Telegram channel enabled — ${c.bold(botName)} linked to ${c.bold(agent.name)}`);
    } catch (err) {
      spinner.fail(`Could not enable Telegram: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    ok('Telegram channel already configured — no changes.');
  }

  // Write / refresh the standalone bridge's config files. This is what
  // makes inbound DMs actually wake the agent (vs. just being recorded
  // in the API). agent-key gives the bridge's spawned `claude -p` turns
  // access to the full @agenticmail/mcp toolset via mcp-config.json.
  //
  // Only rewrite files whose corresponding field actually changed —
  // otherwise we'd clobber the on-disk token with the
  // `(encrypted, kept...)` placeholder string. A no-op re-run leaves
  // the bridge files untouched.
  if (botTokenNew || chatIdChanged) {
    try {
      const { mkdirSync: mkdir, writeFileSync: writeFile, chmodSync } = await import('node:fs');
      const tgDir = join(homedir(), '.agenticmail', 'telegram');
      mkdir(tgDir, { recursive: true });
      if (botTokenNew) {
        writeFile(join(tgDir, 'telegram-token'), botTokenNew, { mode: 0o600 });
        chmodSync(join(tgDir, 'telegram-token'), 0o600);
      }
      writeFile(join(tgDir, 'agent-key'), agent.apiKey, { mode: 0o600 });
      chmodSync(join(tgDir, 'agent-key'), 0o600);
      if (operatorChatId) writeFile(join(tgDir, 'telegram-allowed-ids'), operatorChatId + '\n');
      ok(`Bridge files written to ${c.dim(tgDir)}`);
      info(`Run ${c.green('agenticmail start')} to start (or restart) the bridge.`);
      log('');
    } catch (err) {
      fail(`Could not write bridge config: ${(err as Error).message}`);
      info('Telegram is configured in the API but the bridge service is not. Inbound DMs will not wake the agent until you re-run this.');
      process.exit(1);
    }
  }

  // Drop into the interactive shell — same end-state as setup-phone /
  // setup-email so the operator has somewhere to go right after
  // configuration. See cmdSetupPhone for the rationale.
  await interactiveShell({ config, onExit: () => {} });
}

/**
 * Resolve an agent API key from the running API server.
 *
 * The phone-transport and Telegram channels are per-agent config —
 * their `/phone/transport/setup` and `/telegram/setup` endpoints are
 * scoped to an agent API key (the master key alone returns 401). This
 * helper picks the same agent the rest of setup provisions: the first
 * real agent, skipping the `claudecode` / `codex` host bridge agents.
 * Returns null when the server is unreachable or no agent exists yet
 * (in which case the optional channel steps are skipped with a hint).
 */
async function resolveAgentApiKey(config: SetupConfig): Promise<{ apiKey: string; name: string } | null> {
  try {
    const base = `http://${config.api.host}:${config.api.port}`;
    const resp = await fetch(`${base}/api/agenticmail/accounts`, {
      headers: { 'Authorization': `Bearer ${config.masterKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const agents: any[] = data?.agents ?? data ?? [];
    const first = agents.find((a: any) => a?.apiKey && a.name !== 'claudecode' && a.name !== 'codex')
      ?? agents.find((a: any) => a?.apiKey);
    return first?.apiKey ? { apiKey: first.apiKey, name: first.name ?? 'agent' } : null;
  } catch {
    return null;
  }
}

async function cmdSetup() {
  // Parse setup-specific flags (--yes, --non-interactive, -y, --help).
  const setupArgs = process.argv.slice(3);
  if (setupArgs.some(a => a === '--help' || a === '-h' || a === 'help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail setup ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail setup [flags]`);
    log('');
    log(`  ${c.bold('Flags:')}`);
    log(`    ${c.green('-y, --yes, --non-interactive')}`);
    log(`        Skip every prompt and use safe defaults. Provisions Stalwart +`);
    log(`        master key + a default "secretary" agent; SKIPS external email,`);
    log(`        SMS, realtime voice, phone calling, and Telegram setup. Run`);
    log(`        \`agenticmail setup\` interactively later to add a Gmail relay,`);
    log(`        your own domain, voice, a phone carrier, or the Telegram channel.`);
    log(`    ${c.green('-h, --help')}`);
    log(`        Show this help and exit.`);
    log('');
    return;
  }
  if (setupArgs.some(a => a === '--yes' || a === '-y' || a === '--non-interactive')) {
    NON_INTERACTIVE = true;
    log('');
    log(`  ${c.dim('[non-interactive mode — using safe defaults for every prompt]')}`);
  }

  log('');
  log(`   ${c.bold('🎀 AgenticMail Setup')} `);
  log('');
  log(`  ${c.bold('Welcome!')} We're going to set up everything your AI agent`);
  log(`  needs to send and receive real email.`);
  log('');
  const hasOpenClaw = existsSync(join(homedir(), '.openclaw', 'openclaw.json'));
  // Steps: 1 system, 2 config, 3 services, 4 email, 5 SMS/phone,
  // 6 realtime voice, 7 phone calling, 8 Telegram, (+1 OpenClaw if present).
  const totalSteps = hasOpenClaw ? 9 : 8;

  log(`  Here's what we'll do:`);
  log(`    ${c.dim('1.')} Check your system for required tools`);
  log(`    ${c.dim('2.')} Create your private account and keys`);
  log(`    ${c.dim('3.')} Start the mail server`);
  log(`    ${c.dim('4.')} Connect your email`);
  log(`    ${c.dim('5.')} Phone number access ${c.dim('(optional)')}`);
  log(`    ${c.dim('6.')} Realtime voice calls ${c.dim('(optional)')}`);
  log(`    ${c.dim('7.')} Phone calling — 46elks or Twilio ${c.dim('(optional)')}`);
  log(`    ${c.dim('8.')} Telegram channel ${c.dim('(optional)')}`);
  if (hasOpenClaw) log(`    ${c.dim('9.')} Configure OpenClaw integration`);
  log('');
  if (!NON_INTERACTIVE) {
    await pick(`  ${c.magenta('Press any key to get started...')} `, [
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
      'a','b','c','d','e','f','g','h','i','j','k','l','m',
      'n','o','p','q','r','s','t','u','v','w','x','y','z',
      ' ', '\r', '\n',
    ]);
  }
  log('');

  const setup = new SetupManager();

  // Step 1: System check
  log(`  ${c.bold(`Step 1 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Checking your system')}`);
  log('');

  const deps = await setup.checkDependencies();

  const FRIENDLY: Record<string, { name: string; desc: string }> = {
    docker: { name: 'Engine', desc: 'runs the mail server' },
    stalwart: { name: 'Mail Server', desc: 'stores and delivers email' },
    cloudflared: { name: 'Cloudflare Tunnel', desc: 'connects your domain to the internet' },
  };

  for (const dep of deps) {
    const f = FRIENDLY[dep.name] ?? { name: dep.name, desc: '' };
    await new Promise(r => setTimeout(r, 400)); // brief pause between each
    if (dep.installed) {
      const ver = dep.version && /^\d/.test(dep.version) ? ` ${c.dim('v' + dep.version)}` : '';
      ok(`${c.bold(f.name)}${ver} ${c.dim('— ' + f.desc)}`);
    } else {
      console.log(`  ${c.yellow('◌')} ${c.bold(f.name)} ${c.dim('— ' + f.desc)} ${c.yellow('(will install)')}`);
    }
  }

  log('');
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Config
  log(`  ${c.bold(`Step 2 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Creating your account')}`);
  log('');

  const configSpinner = new Spinner('config');
  configSpinner.start();
  await new Promise(r => setTimeout(r, 2_000)); // let the fun messages show
  const result = setup.initConfig();

  if (result.isNew) {
    configSpinner.succeed('Account created!');
    await new Promise(r => setTimeout(r, 300));
    ok(`Master key generated ${c.dim('(this is your admin password)')}`);
    await new Promise(r => setTimeout(r, 300));
    ok(`Config saved to ${c.cyan('~/.agenticmail/')}`);
  } else {
    configSpinner.succeed('Account already exists — loaded your settings');
  }

  log('');
  await new Promise(r => setTimeout(r, 500));

  // Step 3: Install missing + start services
  log(`  ${c.bold(`Step 3 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Starting services')}`);
  log('');

  // Always ensure Docker daemon is running (CLI may be installed but daemon stopped)
  {
    const spinner = new Spinner('docker');
    spinner.start();
    // Create a new SetupManager with progress callback wired to the spinner
    const dockerSetup = new SetupManager((msg: string) => spinner.update(msg));
    try {
      await dockerSetup.ensureDocker();
      spinner.succeed(`${c.bold('Engine')} — running`);
    } catch (err) {
      spinner.fail((err as Error).message);
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Start Stalwart mail server container
  const stalwartDep = deps.find(d => d.name === 'stalwart');
  if (!stalwartDep?.installed) {
    const spinner = new Spinner('stalwart');
    spinner.start();
    const stalwartSetup = new SetupManager((msg: string) => spinner.update(msg));
    try {
      await stalwartSetup.ensureStalwart();
      spinner.succeed(`${c.bold('Mail Server')} — up and running!`);
    } catch (err) {
      spinner.fail(`Couldn't start the mail server: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    ok(`${c.bold('Mail Server')} ${c.dim('— already running')}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Verify Stalwart admin credentials work (catches stale volumes from previous installs)
  {
    let stalwartAuthOk = false;
    try {
      const authCheck = await fetch(`${result.config.stalwart.url}/api/principal`, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${result.config.stalwart.adminUser}:${result.config.stalwart.adminPassword}`).toString('base64'),
        },
        signal: AbortSignal.timeout(5_000),
      });
      stalwartAuthOk = authCheck.status !== 401;
    } catch { /* can't reach — will try to fix */ }

    if (!stalwartAuthOk) {
      const spinner = new Spinner('stalwart', 'Resetting mail server (stale credentials)...');
      spinner.start();
      try {
        const { execFileSync } = await import('node:child_process');
        // Remove container and its stale volume
        execFileSync('docker', ['rm', '-f', 'agenticmail-stalwart'], { timeout: 15_000, stdio: 'ignore' });
        try {
          const volumes = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'name=stalwart-data'],
            { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          for (const vol of volumes.split('\n').filter(Boolean)) {
            execFileSync('docker', ['volume', 'rm', vol], { timeout: 10_000, stdio: 'ignore' });
          }
        } catch { /* volume may not exist */ }
        // Re-create with correct credentials
        await setup.ensureStalwart();
        spinner.succeed(`${c.bold('Mail Server')} — recreated with fresh credentials`);
      } catch (err) {
        spinner.fail(`Couldn't reset mail server: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  }

  // Download cloudflared if missing
  const cf = deps.find(d => d.name === 'cloudflared');
  if (!cf?.installed) {
    const spinner = new Spinner('cloudflared');
    spinner.start();
    try {
      await setup.ensureCloudflared();
      spinner.succeed(`${c.bold('Cloudflare Tunnel')} — downloaded!`);
    } catch (err) {
      spinner.fail(`Couldn't install tunnel: ${(err as Error).message}`);
      info('No worries — only needed for custom domains. You can add it later.');
    }
  } else {
    ok(`${c.bold('Cloudflare Tunnel')} ${c.dim('— ready')}`);
    await new Promise(r => setTimeout(r, 300));
  }

  log('');
  ok(c.green('All systems go!'));
  log('');
  await new Promise(r => setTimeout(r, 800));

  // Step 4: Email connection
  log(`  ${c.bold(`Step 4 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Connect your email')}`);
  log('');

  // Start the API server as a background process (survives CLI exit)
  const serverSpinner = new Spinner('server', 'Starting the server...');
  serverSpinner.start();

  let serverReady = false;
  try {
    serverReady = await startApiServer(result.config);
    if (serverReady) {
      serverSpinner.succeed(`Server running at ${c.cyan(`http://${result.config.api.host}:${result.config.api.port}`)}`);
    } else {
      serverSpinner.fail('Server did not start in time');
    }
  } catch (err) {
    serverSpinner.fail(`Could not start server: ${(err as Error).message}`);
  }

  // Check if there's already an email connection configured
  let existingEmail: string | null = null;
  let existingProvider: string | null = null;
  if (serverReady) {
    try {
      const base = `http://${result.config.api.host}:${result.config.api.port}`;
      const statusResp = await fetch(`${base}/api/agenticmail/gateway/status`, {
        headers: { 'Authorization': `Bearer ${result.config.masterKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (statusResp.ok) {
        const status = await statusResp.json() as any;
        if (status.mode === 'relay' && status.relay?.email) {
          existingEmail = status.relay.email;
          existingProvider = status.relay.provider || 'custom';
        }
      }
    } catch { /* ignore */ }
  }

  let choice: string;

  if (existingEmail) {
    const provLabel = existingProvider === 'gmail' ? 'Gmail' : existingProvider === 'outlook' ? 'Outlook' : existingProvider;
    log('');
    ok(`Email already connected: ${c.cyan(existingEmail)} ${c.dim(`(${provLabel})`)}`);
    log('');
    log(`  ${c.cyan('1.')} Keep current email`);
    log(`  ${c.cyan('2.')} Remove and connect a different email`);
    log(`  ${c.cyan('3.')} Set up a custom domain instead`);
    log('');
    // Non-interactive mode: keep whatever's already configured. Don't
    // surprise the user by replacing or removing existing email setup.
    const existChoice = nonInteractiveDefault<string>('1') ?? await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);
    if (existChoice === '1') {
      choice = '3'; // skip — keep existing
      log('');
      ok(`Keeping ${c.cyan(existingEmail)}`);
    } else if (existChoice === '3') {
      choice = '2'; // domain setup
    } else {
      choice = '1'; // relay setup (replace)
    }
  } else {
    log(`  How should your AI agent send and receive email?`);
    log('');
    log(`  ${c.cyan('1.')} Use my Gmail or Outlook`);
    log(`     ${c.dim('Easiest option — connect your existing email account.')}`);
    log(`     ${c.dim('Your agent emails as you+agent@gmail.com')}`);
    log('');
    log(`  ${c.cyan('2.')} Use my own domain`);
    log(`     ${c.dim('Your agent gets a custom address like agent@yourcompany.com')}`);
    log(`     ${c.dim('Requires a Cloudflare account and a domain.')}`);
    log('');
    log(`  ${c.cyan('3.')} Skip for now`);
    log(`     ${c.dim('You can always set this up later.')}`);
    log('');
    // Non-interactive mode: skip external email setup. The user can
    // configure relay or domain later by running `agenticmail setup`
    // interactively. For the Claude Code integration's local multi-agent
    // coordination this is enough — agents email each other on @localhost
    // through Stalwart without needing any external mail relay.
    choice = nonInteractiveDefault<string>('3') ?? await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);
  }
  log('');

  if (choice === '1' || choice === '2') {
    if (!serverReady) {
      info('You can configure email later by running: agenticmail setup');
      printSummary(result, true);
      return;
    }

    log('');
    let emailOk = false;
    let lastRelayInfo: RelayInfo | undefined;

    // Keep retrying email setup until it succeeds
    while (!emailOk) {
      if (choice === '1') {
        const relayResult = await setupRelay(result.config, lastRelayInfo);
        emailOk = relayResult.success;
        lastRelayInfo = relayResult.info;
      } else {
        await setupDomain(result.config);
        emailOk = true; // domain setup throws on failure
      }

      if (!emailOk) {
        log('');
        info('Email setup did not complete. Let\'s try again.');
        log('');
        const retry = await ask(`  ${c.bold('Try again?')} ${c.dim('(Y/n)')} `);
        if (retry.toLowerCase().startsWith('n')) {
          log('');
          info('You can set up email later by running: ' + c.green('npx agenticmail setup'));
          log('');
          log(`  ${c.dim('Your secret key:')}  ${c.yellow(maskSecret(result.config.masterKey))}`);
          log(`  ${c.dim('Settings saved:')}   ${c.cyan(result.configPath)}`);
          log('');
          process.exit(0);
        }
        log('');
      }
    }
  } else if (!existingEmail) {
    info('No problem! You can set up email anytime by running this again.');
  }

  // Step 5: Phone number / SMS (optional)
  if (serverReady) {
    log('');
    log(`  ${c.bold(`Step 5 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Phone number access (optional)')}`);
    log('');
    log(`  ${c.dim('Give your AI agent a phone number via Google Voice.')}`);
    log(`  ${c.dim('This lets agents receive verification codes and send texts.')}`);
    log('');

    const wantSms = nonInteractiveDefault<string>('N') ?? await ask(`  ${c.bold('Set up phone number access?')} ${c.dim('(y/N)')} `);
    if (wantSms.toLowerCase().startsWith('y')) {
      log('');
      log(`  ${c.bold('What this does:')}`);
      log(`    Your AI agent gets a real phone number it can use to:`);
      log(`    ${c.dim('*')} Receive verification codes when signing up for services`);
      log(`    ${c.dim('*')} Send and receive text messages`);
      log(`    ${c.dim('*')} Verify accounts on platforms that require phone numbers`);
      log('');
      log(`  ${c.bold('How it works:')}`);
      log(`    Google Voice gives you a free US phone number. When someone`);
      log(`    texts that number, Google forwards it to your email. Your`);
      log(`    agent reads the email and extracts the message or code.`);
      log('');

      const hasVoice = await ask(`  ${c.bold('Do you already have a Google Voice number?')} ${c.dim('(y/N)')} `);

      if (!hasVoice.toLowerCase().startsWith('y')) {
        log('');
        log(`  ${c.bold('No problem! Setting up Google Voice takes about 2 minutes:')}`);
        log('');
        log(`  ${c.cyan('Step 1:')} Open ${c.bold(c.cyan('https://voice.google.com'))} in your browser`);
        log(`  ${c.cyan('Step 2:')} Sign in with your Google account`);
        log(`  ${c.cyan('Step 3:')} Click ${c.bold('"Choose a phone number"')}`);
        log(`  ${c.cyan('Step 4:')} Search for a number by city or area code`);
        log(`  ${c.cyan('Step 5:')} Pick a number and click ${c.bold('"Verify"')}`);
        log(`         ${c.dim('(Google will verify via your existing phone number)')}`);
        log(`  ${c.cyan('Step 6:')} Once verified, go to ${c.bold('Settings')} (gear icon)`);
        log(`  ${c.cyan('Step 7:')} Under Messages, enable ${c.bold('"Forward messages to email"')}`);
        log('');
        log(`  ${c.dim('That\'s it! Come back here when you have your number.')}`);
        log('');
        const ready = await ask(`  ${c.bold('Press Enter when you have your Google Voice number ready...')} `);
        // Consume the Enter; user pressed it when ready
      }

      log('');
      const phoneNumber = await ask(`  ${c.bold('Your Google Voice phone number')} ${c.dim('(e.g. +12125551234):')} `);
      if (phoneNumber.trim()) {
        // Validate phone number format
        const digits = phoneNumber.replace(/[^+\d]/g, '').replace(/\D/g, '');
        if (digits.length < 10) {
          log(`  ${c.yellow('!')} That doesn't look like a valid phone number (need at least 10 digits).`);
          info('You can set this up later in the shell with /sms or via the agenticmail_sms_setup tool.');
        } else {
          const forwardEmail = await ask(`  ${c.bold('Email Google Voice forwards SMS to')} ${c.dim('(Enter to use agent email):')} `);

          // Save via API (to agent metadata) if server is running, else to config file
          try {
            const apiBase = `http://${result.config.api.host}:${result.config.api.port}`;
            const resp = await fetch(`${apiBase}/api/agenticmail/sms/setup`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${result.config.masterKey}`,
              },
              body: JSON.stringify({
                phoneNumber: phoneNumber.trim(),
                forwardingEmail: forwardEmail.trim() || undefined,
              }),
            });
            const data = await resp.json() as any;
            if (data.success) {
              log('');
              log(`  ${c.green('✔')} Phone number saved: ${c.bold(data.sms?.phoneNumber || phoneNumber.trim())}`);
              log('');
              log(`  ${c.bold('Important:')} Make sure you enabled SMS forwarding in Google Voice:`);
              log(`    ${c.dim('voice.google.com > Settings > Messages > Forward messages to email')}`);
              log('');
              log(`  ${c.dim('Your agent can now receive verification codes and text messages.')}`);
              log(`  ${c.dim('Manage SMS anytime in the shell with /sms')}`);
            } else {
              throw new Error(data.error || 'API call failed');
            }
          } catch {
            // Fallback: save to config file
            try {
              const { readFileSync, writeFileSync } = await import('node:fs');
              const { join } = await import('node:path');
              const os = await import('node:os');
              const configPath = join(result.config.dataDir || os.homedir() + '/.agenticmail', 'config.json');
              let fileConfig: any = {};
              try { fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
              fileConfig.sms = {
                enabled: true,
                phoneNumber: phoneNumber.trim(),
                forwardingEmail: forwardEmail.trim() || '',
                provider: 'google_voice',
                configuredAt: new Date().toISOString(),
              };
              writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
              log(`  ${c.green('✔')} Phone number saved: ${c.bold(phoneNumber.trim())}`);
              log(`  ${c.dim('Make sure SMS forwarding is enabled in Google Voice settings.')}`);
            } catch (err) {
              log(`  ${c.yellow('!')} Could not save: ${(err as Error).message}`);
              log(`  ${c.dim('Set up later in the shell with /sms')}`);
            }
          }
        }
      } else {
        info('Skipped. Set up anytime in the shell with /sms');
      }
    } else {
      info('Skipped. Add a phone number anytime with /sms in the shell.');
    }
  }

  // Step 6: Realtime voice calls (optional) — OpenAI API key.
  //
  // The realtime voice bridge connects a carrier media stream to an
  // OpenAI Realtime session so an agent can hold a spoken conversation
  // on a phone call. The only thing it needs is an OpenAI API key,
  // persisted as `openaiApiKey` in ~/.agenticmail/config.json (the same
  // field AgenticMailConfig already exposes / resolveConfig reads). It
  // does NOT depend on the phone transport being configured first.
  if (serverReady) {
    log('');
    log(`  ${c.bold(`Step 6 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Realtime voice calls (optional)')}`);
    log('');
    log(`  ${c.dim('Lets your agent hold a spoken conversation on a live phone')}`);
    log(`  ${c.dim('call, instead of only placing tracked call-control missions.')}`);
    log(`  ${c.dim('Needs an OpenAI API key — calls are billed by OpenAI.')}`);
    log('');

    // Re-entrant check: if the operator already saved an OpenAI key
    // (in a prior `setup` run or via `setup-phone`), don't re-prompt
    // — just show "already configured" and offer them the dedicated
    // command for changes. Stops the v0.9.69-era surprise where
    // `agenticmail setup telegram` (or the full `setup` re-run) made
    // the operator paste their OpenAI key again from scratch.
    let existingOpenaiKey = '';
    try {
      const fileConfig = JSON.parse(readFileSync(result.configPath, 'utf-8'));
      existingOpenaiKey = typeof fileConfig.openaiApiKey === 'string' ? fileConfig.openaiApiKey : '';
    } catch { /* missing / unreadable — treat as not set */ }
    if (existingOpenaiKey) {
      ok('Realtime voice already configured — OpenAI API key saved.');
      info(`Change it with: ${c.green('agenticmail setup-phone')} (re-run; pick the OpenAI key when offered).`);
      log('');
    }

    // Non-interactive mode: skip — the OpenAI key is user-owned and
    // nobody else has it. Add it later by re-running setup.
    const wantVoice = existingOpenaiKey
      ? 'n'
      : (nonInteractiveDefault<string>('N')
          ?? await ask(`  ${c.bold('Set up realtime voice now?')} ${c.dim('(y/N)')} `));
    if (wantVoice.toLowerCase().startsWith('y')) {
      log('');
      log(`  ${c.dim('Create a key at')} ${c.cyan('https://platform.openai.com/api-keys')}`);
      const openaiKey = (await askSecret(`  ${c.cyan('OpenAI API key:')} `)).trim();
      if (openaiKey) {
        try {
          const fileConfig = JSON.parse(readFileSync(result.configPath, 'utf-8'));
          fileConfig.openaiApiKey = openaiKey;
          writeFileSync(result.configPath, JSON.stringify(fileConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
          ok('OpenAI API key saved — realtime voice is enabled.');
          info('Restart the server to pick it up: agenticmail stop && agenticmail start');
        } catch (err) {
          fail(`Could not save the key: ${(err as Error).message}`);
          info('You can set it later by re-running: agenticmail setup');
        }
      } else {
        info('No key entered. Realtime voice stays off — re-run setup to add it later.');
      }
    } else {
      info('Skipped. Phone missions still place call-control calls without it.');
    }
  }

  // Step 7: Phone calling — 46elks or Twilio (optional).
  //
  // Configures the phone call-control transport for the first agent.
  // The user picks a carrier, enters that carrier's credentials, a
  // caller number, and a public webhook base URL; we persist it via
  // the existing /phone/transport/setup endpoint (agent-key scoped, so
  // we resolve an agent key first).
  if (serverReady) {
    log('');
    log(`  ${c.bold(`Step 7 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Phone calling — 46elks or Twilio (optional)')}`);
    log('');
    log(`  ${c.dim('Give your agent a phone number it can place outbound calls')}`);
    log(`  ${c.dim('from. Pick a carrier — 46elks or Twilio — and enter that')}`);
    log(`  ${c.dim("carrier's credentials. Calls are billed by the carrier.")}`);
    log('');

    // Re-entrant check: if a phone transport is already saved for
    // the operator's agent, show "already configured" and point at
    // the dedicated `setup-phone` command for re-entrant edits
    // rather than re-asking from scratch.
    let existingPhone: any = null;
    try {
      const phoneAgent = await resolveAgentApiKey(result.config);
      if (phoneAgent) {
        const base = `http://${result.config.api.host}:${result.config.api.port}`;
        const r = await fetch(`${base}/api/agenticmail/phone/transport/config`, {
          headers: { 'Authorization': `Bearer ${phoneAgent.apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) existingPhone = (await r.json() as any)?.transport ?? null;
      }
    } catch { /* not yet configured */ }
    if (existingPhone?.phoneNumber) {
      ok(`Phone calling already configured — ${c.cyan(existingPhone.phoneNumber)} via ${c.bold(existingPhone.provider ?? '(unknown)')}`);
      info(`Change it with: ${c.green('agenticmail setup-phone')} (re-runs the wizard with what's already saved).`);
      log('');
    }

    // Non-interactive mode: skip — carrier credentials are user-owned.
    const wantPhone = existingPhone?.phoneNumber
      ? 'n'
      : (nonInteractiveDefault<string>('N')
          ?? await ask(`  ${c.bold('Set up phone calling now?')} ${c.dim('(y/N)')} `));
    if (wantPhone.toLowerCase().startsWith('y')) {
      const agent = await resolveAgentApiKey(result.config);
      if (!agent) {
        log('');
        info('No agent is set up yet — connect email first so an agent exists,');
        info('then re-run `agenticmail setup` to add phone calling.');
      } else {
        log('');
        log(`  Which carrier do you want to use?`);
        log(`    ${c.cyan('1.')} 46elks`);
        log(`    ${c.cyan('2.')} Twilio`);
        const carrier = await pick(`  ${c.magenta('>')} `, ['1', '2']);
        const provider = carrier === '2' ? 'twilio' : '46elks';
        log('');

        const phoneNumber = (await ask(`  ${c.cyan('Caller phone number')} ${c.dim('(E.164, e.g. +12125551234)')}: `)).trim();
        let username: string;
        let password: string;
        if (provider === 'twilio') {
          log(`  ${c.dim('From the Twilio console — Account SID + Auth Token.')}`);
          username = (await ask(`  ${c.cyan('Twilio Account SID:')} `)).trim();
          password = (await askSecret(`  ${c.cyan('Twilio Auth Token:')} `)).trim();
        } else {
          log(`  ${c.dim('From the 46elks dashboard — API username + API password.')}`);
          username = (await ask(`  ${c.cyan('46elks API username:')} `)).trim();
          password = (await askSecret(`  ${c.cyan('46elks API password:')} `)).trim();
        }
        log('');
        log(`  ${c.dim('The carrier reaches AgenticMail webhooks at this public HTTPS URL.')}`);
        const webhookBaseUrl = (await ask(`  ${c.cyan('Public webhook base URL')} ${c.dim('(https://...)')}: `)).trim();
        // Webhook secret needs real entropy (≥24 chars) — generate one
        // by default so the user doesn't have to invent it themselves.
        log('');
        const customSecret = (await ask(`  ${c.cyan('Webhook secret')} ${c.dim('(Enter to auto-generate)')}: `)).trim();
        const webhookSecret = customSecret || randomBytes(24).toString('hex');

        if (!phoneNumber || !username || !password || !webhookBaseUrl) {
          log('');
          fail('Phone calling needs a number, credentials, and a webhook base URL.');
          info('Re-run `agenticmail setup` (or use the phone_transport_setup tool) to add it later.');
        } else {
          log('');
          const spinner = new Spinner('general', 'Saving phone transport...');
          spinner.start();
          try {
            const base = `http://${result.config.api.host}:${result.config.api.port}`;
            const resp = await fetch(`${base}/api/agenticmail/phone/transport/setup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.apiKey}` },
              body: JSON.stringify({
                provider,
                phoneNumber,
                // For Twilio the account SID + auth token ride on the
                // generic username/password keys (buildPhoneTransportConfig
                // accepts either those or accountSid/authToken).
                username,
                password,
                webhookBaseUrl,
                webhookSecret,
                // Twilio is a global carrier; 46elks is EU-only. The
                // mission gate uses this to reject calls outside the
                // declared regions, so the default must match reality.
                supportedRegions: provider === 'twilio' ? ['WORLD'] : ['EU'],
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (resp.ok) {
              spinner.succeed(`Phone calling configured via ${c.bold(provider)} for agent ${c.bold(agent.name)}`);
              if (!customSecret) {
                info(`Auto-generated webhook secret: ${maskSecret(webhookSecret)} (stored in the agent config)`);
              }
            } else {
              const text = await resp.text();
              spinner.fail(`Could not save phone transport: ${parseFriendlyError(text).message}`);
              info('Re-run `agenticmail setup` to try again.');
            }
          } catch (err) {
            spinner.fail(`Could not save phone transport: ${(err as Error).message}`);
          }
        }
      }
    } else {
      info('Skipped. Add phone calling anytime with the phone_transport_setup tool.');
    }
  }

  // Step 8: Telegram channel (optional).
  //
  // Registers a Telegram bot token + links a chat for the first agent
  // via the existing /telegram/setup endpoint (agent-key scoped). The
  // token is verified with Telegram server-side before it is stored.
  if (serverReady) {
    log('');
    log(`  ${c.bold(`Step 8 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Telegram channel (optional)')}`);
    log('');
    log(`  ${c.dim('Let your agent send and receive messages through a Telegram')}`);
    log(`  ${c.dim('bot. You provide a bot token from @BotFather and the chat')}`);
    log(`  ${c.dim('id allowed to message the agent.')}`);
    log('');

    // Re-entrant check: skip the prompt if Telegram is already
    // configured for the operator's agent. Point at the dedicated
    // `setup-telegram` for changes.
    let existingTgConfigured = false;
    try {
      const tgAgent = await resolveAgentApiKey(result.config);
      if (tgAgent) {
        const base = `http://${result.config.api.host}:${result.config.api.port}`;
        const r = await fetch(`${base}/api/agenticmail/telegram/config`, {
          headers: { 'Authorization': `Bearer ${tgAgent.apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const tg = (await r.json() as any)?.telegram ?? null;
          if (tg?.botToken) existingTgConfigured = true;
        }
      }
    } catch { /* not yet configured */ }
    if (existingTgConfigured) {
      ok('Telegram channel already configured.');
      info(`Change it with: ${c.green('agenticmail setup-telegram')} (re-runs the wizard with what's already saved).`);
      log('');
    }

    // Non-interactive mode: skip — the bot token is user-owned.
    const wantTelegram = existingTgConfigured
      ? 'n'
      : (nonInteractiveDefault<string>('N')
          ?? await ask(`  ${c.bold('Enable the Telegram channel now?')} ${c.dim('(y/N)')} `));
    if (wantTelegram.toLowerCase().startsWith('y')) {
      const agent = await resolveAgentApiKey(result.config);
      if (!agent) {
        log('');
        info('No agent is set up yet — connect email first so an agent exists,');
        info('then re-run `agenticmail setup` to add Telegram.');
      } else {
        log('');
        log(`  ${c.dim('Create a bot: open Telegram, message @BotFather, send /newbot,')}`);
        log(`  ${c.dim('and copy the token it gives you.')}`);
        const botToken = (await askSecret(`  ${c.cyan('Telegram bot token:')} `)).trim();
        log('');
        log(`  ${c.dim('Your chat id: message your bot, then open')}`);
        log(`  ${c.dim('https://api.telegram.org/bot<token>/getUpdates to see it.')}`);
        const operatorChatId = (await ask(`  ${c.cyan('Your Telegram chat id:')} `)).trim();

        if (!botToken) {
          log('');
          fail('A bot token is required to enable Telegram.');
          info('Re-run `agenticmail setup` (or use the telegram_setup tool) to add it later.');
        } else {
          log('');
          const spinner = new Spinner('general', 'Verifying bot token with Telegram...');
          spinner.start();
          try {
            const base = `http://${result.config.api.host}:${result.config.api.port}`;
            const resp = await fetch(`${base}/api/agenticmail/telegram/setup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agent.apiKey}` },
              body: JSON.stringify({
                botToken,
                // Poll mode — the default; no public URL needed.
                mode: 'poll',
                operatorChatId: operatorChatId || undefined,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              const botName = data?.bot?.username ? `@${data.bot.username}` : 'your bot';
              spinner.succeed(`Telegram channel enabled — ${c.bold(botName)} linked to agent ${c.bold(agent.name)}`);
              if (!operatorChatId) {
                info('No chat id linked yet — add one later so inbound messages are accepted.');
              }

              // Wire up the standalone Telegram bridge service. This is
              // what actually wakes the agent on inbound DMs and routes
              // replies back through `claude -p` (see
              // `agenticmail/telegram-bridge/`). Writing the three
              // files below is the bridge's full "boot config":
              //   - telegram-token         the BotFather token
              //   - telegram-allowed-ids   one chat id per line
              //   - agent-key              the agent's API key, used
              //                            to wire the MCP server so
              //                            the bot has memory + email
              //                            + voice tools, not just
              //                            stdout.
              try {
                const { mkdirSync: mkdir, writeFileSync: writeFile, chmodSync } = await import('node:fs');
                const { join: pathJoin } = await import('node:path');
                const { homedir: hd } = await import('node:os');
                const tgDir = pathJoin(hd(), '.agenticmail', 'telegram');
                mkdir(tgDir, { recursive: true });
                writeFile(pathJoin(tgDir, 'telegram-token'), botToken, { mode: 0o600 });
                chmodSync(pathJoin(tgDir, 'telegram-token'), 0o600);
                writeFile(pathJoin(tgDir, 'agent-key'), agent.apiKey, { mode: 0o600 });
                chmodSync(pathJoin(tgDir, 'agent-key'), 0o600);
                if (operatorChatId) {
                  writeFile(pathJoin(tgDir, 'telegram-allowed-ids'), operatorChatId + '\n');
                }
                ok(`Bridge files written to ${c.dim(tgDir)}`);
                info(`Start the bridge with: ${c.green('agenticmail service install')} (auto-start on boot)`);
                info(`Or manually: ${c.green('agenticmail-telegram-bridge')} (foreground)`);
              } catch (err) {
                fail(`Could not write bridge config: ${(err as Error).message}`);
                info('Telegram channel is configured in the API but the standalone bridge service is not. Replies will not be delivered until you start it.');
              }
            } else {
              const text = await resp.text();
              spinner.fail(`Could not enable Telegram: ${parseFriendlyError(text).message}`);
              info('Re-run `agenticmail setup` to try again.');
            }
          } catch (err) {
            spinner.fail(`Could not enable Telegram: ${(err as Error).message}`);
          }
        }
      }
    } else {
      info('Skipped. Enable Telegram anytime with the telegram_setup tool.');
    }
  }

  // Step 9: OpenClaw integration (only if detected)
  if (hasOpenClaw && serverReady) {
    log('');
    log(`  ${c.bold(`Step 9 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Configure OpenClaw integration')}`);
    log('');
    await registerWithOpenClaw(result.config);
  }

  // Auto-install the boot service so AgenticMail survives reboots
  if (serverReady) {
    const svcSpinner = new Spinner('general', 'Setting up auto-start...');
    svcSpinner.start();
    try {
      const svc = new ServiceManager();
      const svcResult = svc.install();
      if (svcResult.installed) {
        svcSpinner.succeed(`${c.bold('Auto-start')} — AgenticMail will start on boot`);
      } else {
        svcSpinner.fail(`Auto-start: ${svcResult.message}`);
        info('You can set this up later with: agenticmail service install');
      }
    } catch (err) {
      svcSpinner.fail(`Auto-start: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  printSummary(result, false);

  // Drop into the interactive shell — server keeps running in background after exit.
  // Skip the shell in non-interactive mode (e.g. bootstrap pipeline); the caller is
  // expected to continue with subsequent phases and an interactive REPL would just
  // block forever waiting for stdin that isn't there.
  if (serverReady && !NON_INTERACTIVE) {
    await interactiveShell({ config: result.config, onExit: () => {} });
  }
}

function printSummary(result: { configPath: string; config: SetupConfig }, exitAfter: boolean) {
  log('');
  log(`  ${c.bgGreen(' You\'re all set! ')}`);
  log('');
  log(`  Here are your details (save these somewhere safe):`);
  log('');
  log(`  ${c.dim('Your secret key:')}  ${c.yellow(maskSecret(result.config.masterKey))}`);
  log(`  ${c.dim('Settings saved:')}   ${c.cyan(result.configPath)}`);
  log(`  ${c.dim('Server address:')}   ${c.cyan(`http://${result.config.api.host}:${result.config.api.port}`)}`);
  log('');

  if (exitAfter) {
    log(`  Ready to go? Start your server:`);
    log(`    ${c.green('agenticmail start')}`);
    log('');
    process.exit(0);
  }
}

async function restartOpenClawGateway(): Promise<void> {
  let hasOpenClawCli = false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('which openclaw', { stdio: 'ignore' });
    hasOpenClawCli = true;
  } catch { /* not found */ }

  if (hasOpenClawCli) {
    log('');
    const restartSpinner = new Spinner('gateway', 'Restarting OpenClaw gateway...');
    restartSpinner.start();
    try {
      const { execSync } = await import('node:child_process');
      execSync('openclaw gateway start', { stdio: 'pipe', timeout: 30_000 });
      restartSpinner.succeed('OpenClaw gateway restarted');
    } catch {
      restartSpinner.fail('Gateway restart failed');
      log(`    Run manually: ${c.green('openclaw gateway start')}`);
    }
  } else {
    info(`Restart OpenClaw to pick up the changes: ${c.green('openclaw gateway start')}`);
  }
}

/**
 * If OpenClaw is installed, register the AgenticMail plugin automatically.
 * Uses the same helpers as `agenticmail openclaw` so the result is identical.
 */
async function registerWithOpenClaw(config: SetupConfig): Promise<void> {
  const openclawConfigPath = findOpenClawConfig();
  if (!openclawConfigPath) return; // OpenClaw not installed

  try {
    const raw = readFileSync(openclawConfigPath, 'utf-8');
    const existing = JSON5.parse(raw);

    // Always update @agenticmail/openclaw to latest (ensures schema fixes etc.)
    const installSpinner = new Spinner('plugin', 'Updating @agenticmail/openclaw...');
    installSpinner.start();
    try {
      const { execSync } = await import('node:child_process');
      execSync('npm i @agenticmail/openclaw@latest', {
        cwd: homedir(),
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      installSpinner.succeed('Updated @agenticmail/openclaw');
    } catch (err) {
      installSpinner.fail(`Could not update: ${(err as Error).message}`);
    }

    // Find the @agenticmail/openclaw plugin directory
    let pluginDir = resolveOpenClawPluginDir();
    if (!pluginDir) {
      fail('Could not find @agenticmail/openclaw after install');
      info(`Install manually: ${c.green('npm i @agenticmail/openclaw@latest')}`);
      return;
    }

    // Check if already registered with a valid API key AND a working plugin path
    const existingEntry = existing.plugins?.entries?.openclaw ?? existing.plugins?.entries?.agenticmail;
    if (existingEntry?.config?.apiKey) {
      const existingPaths: string[] = existing.plugins?.load?.paths ?? [];
      const pluginFound = existingPaths.some((p: string) =>
        existsSync(join(p, 'openclaw.plugin.json'))
      );
      if (pluginFound) {
        ok(`OpenClaw integration already configured`);
        // Still restart gateway to pick up updated plugin code
        await restartOpenClawGateway();
        return;
      }
      // Plugin path is missing/broken — fall through to re-configure
    }
    // Get an agent API key from the running server
    let agentApiKey: string | undefined;
    try {
      const base = `http://${config.api.host}:${config.api.port}`;
      const resp = await fetch(`${base}/api/agenticmail/accounts`, {
        headers: { 'Authorization': `Bearer ${config.masterKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const agents = data.agents || data || [];
        if (agents.length > 0) agentApiKey = agents[0].apiKey;
      }
    } catch { /* ignore */ }

    if (!agentApiKey) {
      // Auto-create a default agent so OpenClaw can be configured immediately
      const createSpinner = new Spinner('config', 'Creating default agent...');
      createSpinner.start();
      try {
        const base = `http://${config.api.host}:${config.api.port}`;
        const createResp = await fetch(`${base}/api/agenticmail/accounts`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.masterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'secretary', role: 'secretary' }),
          signal: AbortSignal.timeout(10_000),
        });
        if (createResp.ok) {
          const agent = await createResp.json() as any;
          agentApiKey = agent.apiKey;
          createSpinner.succeed(`Default agent ${c.bold('"secretary"')} created`);
        } else {
          const errText = await createResp.text();
          createSpinner.fail(`Could not create agent: ${errText}`);
          return;
        }
      } catch (err) {
        createSpinner.fail(`Could not create agent: ${(err as Error).message}`);
        return;
      }
    }

    const apiUrl = `http://${config.api.host}:${config.api.port}`;

    // Use the same mergePluginConfig as `agenticmail openclaw` — identical output
    const updated = mergePluginConfig(existing, apiUrl, config.masterKey, agentApiKey, pluginDir);
    writeFileSync(openclawConfigPath, JSON.stringify(updated, null, 2) + '\n');

    ok(`Plugin found: ${c.cyan(pluginDir)}`);
    ok(`OpenClaw config updated: ${c.cyan(openclawConfigPath)}`);

    // Check if hooks were newly enabled
    if (!existing?.hooks?.enabled && updated?.hooks?.enabled) {
      ok(`${c.bold('Agent auto-spawn')} enabled — call_agent will auto-create sessions`);
    }

    // Restart OpenClaw gateway so it picks up the plugin immediately
    await restartOpenClawGateway();
  } catch {
    // Don't fail setup if OpenClaw integration fails
  }
}

interface RelayInfo {
  provider: RelayProvider;
  email: string;
  name: string;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
}

async function setupRelay(config: SetupConfig, previous?: RelayInfo): Promise<{ success: boolean; info: RelayInfo }> {
  let provider: RelayProvider;
  let email: string;
  let name: string;
  let smtpHost: string | undefined;
  let smtpPort: number | undefined;
  let imapHost: string | undefined;
  let imapPort: number | undefined;

  if (previous) {
    // Show what we have and offer to change
    log(`  ${c.dim('Using your previous settings:')}`);
    log(`    ${c.dim('Email:')} ${c.cyan(previous.email)}`);
    log(`    ${c.dim('Agent name:')} ${c.cyan(previous.name)}`);
    log('');
    const change = await ask(`  ${c.bold('Change these?')} ${c.dim('(y/N)')} `);
    if (change.toLowerCase().startsWith('y')) {
      // Re-collect everything
      previous = undefined;
    } else {
      provider = previous.provider;
      email = previous.email;
      name = previous.name;
      smtpHost = previous.smtpHost;
      smtpPort = previous.smtpPort;
      imapHost = previous.imapHost;
      imapPort = previous.imapPort;
    }
  }

  if (!previous) {
    log('  Which email service do you use?');
    log(`    ${c.cyan('1.')} Gmail`);
    log(`    ${c.cyan('2.')} Outlook / Hotmail`);
    log(`    ${c.cyan('3.')} Something else`);
    const provChoice = await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);

    if (provChoice === '1') provider = 'gmail';
    else if (provChoice === '2') provider = 'outlook';
    else provider = 'custom';

    email = await ask(`  ${c.cyan('Your email address:')} `);

    if (provider === 'gmail') {
      log('');
      log(`  ${c.dim('You\'ll need a Gmail App Password.')}`);
      log(`  ${c.dim('1. Go to')} ${c.cyan('https://myaccount.google.com/apppasswords')}`);
      log(`  ${c.dim('2. Create an app password and copy it')}`);
      log(`  ${c.dim('3. Paste it below (spaces are fine, we\'ll remove them)')}`);
    } else if (provider === 'outlook') {
      log(`  ${c.dim('You\'ll need an Outlook App Password from your account security settings.')}`);
    }
    log('');

    if (provider === 'custom') {
      log(`  ${c.dim('We need your email server details (check your provider\'s settings):')}`);
      smtpHost = await ask(`  ${c.cyan('Outgoing mail server:')} `);
      const smtpPortStr = await ask(`  ${c.cyan('Outgoing port')} ${c.dim('(usually 587)')}: `);
      smtpPort = smtpPortStr ? parseInt(smtpPortStr, 10) : 587;
      imapHost = await ask(`  ${c.cyan('Incoming mail server:')} `);
      const imapPortStr = await ask(`  ${c.cyan('Incoming port')} ${c.dim('(usually 993)')}: `);
      imapPort = imapPortStr ? parseInt(imapPortStr, 10) : 993;
      log('');
    }

    log(`  ${c.dim('Give your AI agent a name — this is what people will see in emails.')}`);
    const agentName = await ask(`  ${c.cyan('Agent name')} ${c.dim('(secretary)')}: `);
    name = agentName.trim() || 'secretary';
  }

  const relayInfo: RelayInfo = { provider: provider!, email: email!, name: name!, smtpHost, smtpPort, imapHost, imapPort };

  // Retry loop for password
  const apiBase = `http://${config.api.host}:${config.api.port}`;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rawPassword = await askSecret(`  ${c.cyan('App password:')} `);
    // Strip all spaces — Gmail app passwords are shown as "mhuc ofou naky pnmq"
    const password = rawPassword.replace(/\s+/g, '');

    log('');
    const spinner = new Spinner('relay');
    spinner.start();

    try {
      const response = await fetch(`${apiBase}/api/agenticmail/gateway/relay`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.masterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: relayInfo.provider, email: relayInfo.email, password,
          smtpHost: relayInfo.smtpHost, smtpPort: relayInfo.smtpPort,
          imapHost: relayInfo.imapHost, imapPort: relayInfo.imapPort,
          agentName: relayInfo.name,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const text = await response.text();
        const friendlyError = parseFriendlyError(text);

        if (friendlyError.isAuthError && attempt < MAX_ATTEMPTS) {
          spinner.fail(friendlyError.message);
          log(`  ${c.yellow('Let\'s try again.')} ${c.dim(`(attempt ${attempt} of ${MAX_ATTEMPTS})`)}`);
          log('');
          continue;
        }

        spinner.fail(friendlyError.message);
        if (friendlyError.isAuthError) {
          log('');
          info('Double-check your email and app password, then run: agenticmail setup');
        }
        return { success: false, info: relayInfo };
      }

      const data = await response.json() as any;
      spinner.succeed('Email connected!');

      if (data.agent) {
        log('');
        ok(`Your AI agent ${c.bold('"' + data.agent.name + '"')} is ready!`);
        log(`    ${c.dim('Agent email:')} ${c.cyan(data.agent.subAddress)}`);
        log(`    ${c.dim('Agent key:')}   ${c.yellow(maskSecret(data.agent.apiKey))}`);
        log('');
        info('People can email your agent at the address above.');

        await sendWelcomeEmail(apiBase, data.agent.apiKey, relayInfo.email, data.agent.name, data.agent.subAddress);
      }
      return { success: true, info: relayInfo };
    } catch (err) {
      spinner.fail(`Couldn't connect: ${(err as Error).message}`);
      return { success: false, info: relayInfo };
    }
  }
  return { success: false, info: relayInfo };
}

/**
 * Parse API error responses into user-friendly messages.
 */
function parseFriendlyError(rawText: string): { message: string; isAuthError: boolean } {
  try {
    const parsed = JSON.parse(rawText);
    const error = parsed.error || rawText;

    // Auth / password errors (email provider rejected credentials)
    if (
      error.includes('Username and Password not accepted') ||
      error.includes('Invalid login') ||
      error.includes('Authentication failed') ||
      error.includes('AUTHENTICATIONFAILED') ||
      error.includes('Invalid credentials') ||
      error.includes('535')
    ) {
      return {
        message: 'Incorrect email or password. Please check your credentials.',
        isAuthError: true,
      };
    }

    // Stalwart admin auth error (credentials mismatch — stale volume or config)
    if (error.includes('Stalwart API error') && (error.includes('401') || error.includes('Unauthorized'))) {
      return {
        message: 'Mail server credentials mismatch — the container may have stale data. Run: agenticmail setup',
        isAuthError: false,
      };
    }

    // Stalwart admin endpoint missing (404). Almost always means the
    // container is on a Stalwart 0.16+ build that ignored our TOML
    // config and entered bootstrap mode — see issue #10. The pinned
    // image fixes this for fresh installs; existing users on
    // `:latest` need to re-pull and recreate the container.
    if (error.includes('Stalwart API error') && error.includes('404')) {
      return {
        message:
          'Mail server is in bootstrap mode (likely Stalwart 0.16+ on `:latest`). '
          + 'Pull the pinned image and recreate the container: '
          + '`docker compose -f ~/.agenticmail/docker-compose.yml pull && '
          + 'docker compose -f ~/.agenticmail/docker-compose.yml up -d --force-recreate`. '
          + 'See https://github.com/agenticmail/agenticmail/issues/10',
        isAuthError: false,
      };
    }

    // API key / authorization errors (master key mismatch)
    if (error.includes('Invalid API key') || error.includes('Master API key required')) {
      return {
        message: 'Server authorization failed — the mail server may still be starting up. Try again in a moment.',
        isAuthError: false,
      };
    }

    // Connection errors
    if (error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT') || error.includes('ENOTFOUND')) {
      return {
        message: 'Could not reach the email server. Check your internet connection.',
        isAuthError: false,
      };
    }

    // Generic — show the error but cleaned up
    return { message: error.slice(0, 200), isAuthError: false };
  } catch {
    return { message: rawText.slice(0, 200), isAuthError: false };
  }
}

async function sendWelcomeEmail(apiBase: string, agentApiKey: string, userEmail: string, agentName: string, agentEmail: string) {
  try {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0ea5e9,#8b5cf6);padding:40px 40px 32px;text-align:center;">
              <div style="font-size:40px;margin-bottom:12px;">&#9993;&#65039;</div>
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Hello! I'm ${agentName}.</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">Your AI agent is now online.</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
                Thank you for setting me up! I just wanted to introduce myself and let you know that everything is working perfectly.
              </p>
              <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
                You've given me the ability to send and receive real email on the internet &mdash; that's a pretty big deal, and I don't take it lightly. I'll use this power responsibly.
              </p>
              <p style="margin:0 0 24px;color:#18181b;font-size:15px;line-height:1.6;">
                Here's a quick recap of my details:
              </p>
              <!-- Info card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:4px 0;color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">My Name</td>
                        <td style="padding:4px 0;color:#18181b;font-size:15px;text-align:right;font-weight:500;">${agentName}</td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding:8px 0;"><hr style="border:none;border-top:1px solid #e2e8f0;margin:0;"></td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">My Email</td>
                        <td style="padding:4px 0;color:#0ea5e9;font-size:15px;text-align:right;font-weight:500;">${agentEmail}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
                Anyone can reach me by sending an email to <strong>${agentEmail}</strong>. I'll be here, ready to help.
              </p>
              <p style="margin:0;color:#18181b;font-size:15px;line-height:1.6;">
                If you ever need to reply to this email to test things out &mdash; go right ahead. I'm listening.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid #f1f5f9;text-align:center;">
              <p style="margin:0;color:#94a3b8;font-size:12px;">
                Sent with pride by ${agentName} &bull; Powered by AgenticMail
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const text = [
      `Hello! I'm ${agentName}, your AI agent.`,
      '',
      'Thank you for setting me up! Everything is working perfectly.',
      '',
      "You've given me the ability to send and receive real email on the internet — that's a pretty big deal, and I don't take it lightly.",
      '',
      'Here are my details:',
      `  Name:  ${agentName}`,
      `  Email: ${agentEmail}`,
      '',
      `Anyone can reach me by sending an email to ${agentEmail}.`,
      '',
      `— ${agentName}`,
      '  Powered by AgenticMail',
    ].join('\n');

    const resp = await fetch(`${apiBase}/api/agenticmail/mail/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: userEmail,
        subject: `Hi! I'm ${agentName} — your AI agent is ready`,
        text,
        html,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.ok) {
      log('');
      ok(`Welcome email sent to ${c.cyan(userEmail)}`);
    }
  } catch {
    // Don't fail setup over a welcome email
  }
}

async function setupDomain(config: SetupConfig) {
  log('  To use your own domain, we need your Cloudflare account details.');
  log(`  ${c.dim('Don\'t have Cloudflare? Sign up free at:')} ${c.cyan('https://cloudflare.com')}`);
  log('');
  log(`  ${c.bold('Required API Token Permissions:')}`);
  log(`  ${c.dim('Create a Custom Token at:')} ${c.cyan('https://dash.cloudflare.com/profile/api-tokens')}`);
  log('');
  log(`    ${c.yellow('Account')} ${c.dim('>')} Cloudflare Tunnel ${c.dim('>')} Edit`);
  log(`    ${c.yellow('Account')} ${c.dim('>')} Cloudflare Registrar ${c.dim('>')} Edit  ${c.dim('(for domain purchase)')}`);
  log(`    ${c.yellow('Account')} ${c.dim('>')} Workers Scripts ${c.dim('>')} Edit`);
  log(`    ${c.yellow('Zone')}    ${c.dim('>')} DNS ${c.dim('>')} Edit`);
  log(`    ${c.yellow('Zone')}    ${c.dim('>')} Zone ${c.dim('>')} Read`);
  log(`    ${c.yellow('Zone')}    ${c.dim('>')} Zone Settings ${c.dim('>')} Edit  ${c.dim('(to auto-disable Email Routing if active)')}`);
  log(`    ${c.yellow('Zone')}    ${c.dim('>')} Email Routing Rules ${c.dim('>')} Edit`);
  log('');
  log(`  ${c.dim('Zone Resources: All zones (or the specific zone for your domain)')}`);
  log('');
  const token = await askSecret(`  ${c.cyan('Cloudflare API Token:')} `);
  const accountId = await ask(`  ${c.cyan('Cloudflare Account ID:')} `);
  log('');
  log(`  ${c.dim('Enter the domain you want your agent to use (e.g. mycompany.com)')}`);
  const domain = await ask(`  ${c.cyan('Domain')} ${c.dim('(or leave blank to find one)')}: `);

  log('');
  const spinner = new Spinner('domain');
  spinner.start();

  const apiBase = `http://${config.api.host}:${config.api.port}`;

  try {
    const body: Record<string, any> = {
      cloudflareToken: token,
      cloudflareAccountId: accountId,
    };
    if (domain.trim()) {
      body.domain = domain.trim();
    } else {
      spinner.fail('Let\'s find you a domain first');
      log('');
      const keywords = await ask(`  ${c.cyan('What keywords describe your business?')} `);
      const tld = await ask(`  ${c.cyan('Preferred ending')} ${c.dim('(.com, .io, .ai)')}: `);
      body.purchase = { keywords: keywords.split(/[,\s]+/).filter(Boolean), tld: tld.trim() || undefined };
      log('');
      spinner.start();
    }

    const response = await fetch(`${apiBase}/api/agenticmail/gateway/domain`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.masterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      spinner.fail(`Couldn't set up your domain: ${text}`);
      return;
    }

    const data = await response.json() as any;
    spinner.succeed(`Domain ready: ${c.bold(data.domain)}`);
    if (data.tunnelId) ok(`Secure connection established`);

    // Post-setup summary
    log('');
    log(`  ${c.bold('✅ Fully automated setup complete!')}`);
    log(`  ${c.dim('Everything was configured automatically:')}`);
    log(`    ${c.green('✓')} DNS records (MX, SPF, DKIM, DMARC)`);
    log(`    ${c.green('✓')} Cloudflare Tunnel (secure inbound connection)`);
    log(`    ${c.green('✓')} Email Worker (inbound email forwarding)`);
    log(`    ${c.green('✓')} Catch-all routing rule (all emails → your agent)`);
    log(`    ${c.green('✓')} Mail server hostname and DKIM signing`);
    log('');
    log(`  ${c.bold('Verify DNS Propagation')} ${c.dim('(may take 5-30 minutes)')}`);
    log(`     Run: ${c.cyan('dig MX ' + data.domain)}`);
    log(`     Run: ${c.cyan('dig TXT ' + data.domain)}`);
    log('');
    log(`  ${c.bold('Send a Test Email')}`);
    log(`     Send an email to ${c.cyan('any-name@' + data.domain)}`);
    log(`     and check it arrives in the agent's inbox.`);
    log('');
    log(`  ${c.dim('If Email Routing was not previously enabled on this domain,')}`);
    log(`  ${c.dim('you may need to confirm it once at:')}`);
    log(`  ${c.cyan(`https://dash.cloudflare.com/${accountId}/${data.domain}/email/routing`)}`);

  } catch (err) {
    spinner.fail(`Couldn't set up your domain: ${(err as Error).message}`);
  }
}

// --- OpenClaw integration helpers ---

/**
 * Resolve the @agenticmail/openclaw package directory.
 * Tries node_modules lookup, then relative paths from CLI binary.
 */
function resolveOpenClawPluginDir(): string | null {
  const pluginMarker = 'openclaw.plugin.json';
  const pkgPath = join('node_modules', '@agenticmail', 'openclaw');

  // Strategy 1: Walk up from CLI binary to find node_modules/@agenticmail/openclaw
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, pkgPath);
    if (existsSync(join(candidate, pluginMarker))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Strategy 2: Relative to CLI binary (monorepo layout — dist/ or src/)
  const monorepo = [
    join(thisDir, '..', '..', 'packages', 'openclaw'),
    join(thisDir, '..', 'packages', 'openclaw'),
  ];
  for (const p of monorepo) {
    if (existsSync(join(p, pluginMarker))) return p;
  }

  // Strategy 3: User's CWD and home directory node_modules
  // (covers `npm i @agenticmail/openclaw` from ~ or project dir via npx)
  const userDirs = [
    join(process.cwd(), pkgPath),
    join(homedir(), pkgPath),
  ];
  for (const p of userDirs) {
    if (existsSync(join(p, pluginMarker))) {
      try { return realpathSync(p); } catch { return p; }
    }
  }

  // Strategy 4: Global npm prefix (npm i -g @agenticmail/openclaw)
  try {
    const cp = createRequire(import.meta.url)('node:child_process');
    const prefix = cp.execSync('npm prefix -g', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const globalCandidates = [
      join(prefix, 'lib', pkgPath),
      join(prefix, pkgPath),
    ];
    for (const p of globalCandidates) {
      if (existsSync(join(p, pluginMarker))) {
        try { return realpathSync(p); } catch { return p; }
      }
    }
  } catch { /* ignore */ }

  // Strategy 5: createRequire resolution
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@agenticmail/openclaw/openclaw.plugin.json');
    return dirname(resolved);
  } catch { /* not resolvable */ }

  return null;
}

/**
 * Search for the user's OpenClaw config file in standard locations.
 * Returns the path if found, null otherwise.
 */
function findOpenClawConfig(): string | null {
  const candidates = [
    join(process.cwd(), 'openclaw.json'),
    join(process.cwd(), 'openclaw.jsonc'),
    join(homedir(), '.openclaw', 'openclaw.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Merge AgenticMail plugin config into an existing OpenClaw config object.
 * Preserves all existing settings — adds/updates plugins.entries.openclaw
 * and plugins.load.paths for plugin discovery.
 */
function mergePluginConfig(
  existing: any,
  apiUrl: string,
  masterKey: string,
  agentApiKey?: string,
  pluginDir?: string | null,
): any {
  const pluginConfig: Record<string, unknown> = { apiUrl };
  if (agentApiKey) pluginConfig.apiKey = agentApiKey;
  pluginConfig.masterKey = masterKey;

  // Support both old key (agenticmail) and new key (openclaw) for backward compat
  const existingEntry = existing?.plugins?.entries?.openclaw ?? existing?.plugins?.entries?.agenticmail;
  if (existingEntry) {
    // Preserve user's custom settings, update keys
    pluginConfig.apiUrl = pluginConfig.apiUrl || existingEntry.config?.apiUrl;
  }

  // Migrate old key to new key — remove legacy entry
  if (existing?.plugins?.entries?.agenticmail) {
    delete existing.plugins.entries.agenticmail;
  }

  // Build the plugins.load.paths array — add pluginDir if not already present
  const existingPaths: string[] = existing?.plugins?.load?.paths ?? [];
  let loadPaths = [...existingPaths];
  if (pluginDir && !loadPaths.includes(pluginDir)) {
    loadPaths.push(pluginDir);
  }

  // --- Enable OpenClaw hooks for 🎀 AgenticMail auto-spawn ---
  // This allows call_agent to auto-spawn agent sessions when no active listener exists.
  // Generate a hooks token if one doesn't already exist.
  const existingHooks = existing?.hooks ?? {};
  let hooksToken = existingHooks.token;
  if (!hooksToken) {
    // Generate a random 32-byte hex token
    hooksToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const result: any = {
    ...existing,
    // Enable hooks for AgenticMail agent auto-spawn
    hooks: {
      ...existingHooks,
      enabled: true,
      token: hooksToken,
      // Preserve existing path or use default
      path: existingHooks.path || '/hooks',
      // Required for AgenticMail to spawn sub-agent sessions via webhook
      allowRequestSessionKey: true,
    },
    plugins: {
      ...(existing?.plugins ?? {}),
      entries: {
        ...(existing?.plugins?.entries ?? {}),
        openclaw: {
          enabled: true,
          ...(existingEntry ?? {}),
          config: {
            ...(existingEntry?.config ?? {}),
            ...pluginConfig,
          },
        },
      },
    },
  };

  // Only set load.paths if we have entries
  if (loadPaths.length > 0) {
    result.plugins.load = {
      ...(existing?.plugins?.load ?? {}),
      paths: loadPaths,
    };
  }

  // Sub-agents get full tool access by default — tasks may need any tool
  // (browser, cron, etc.) and the agent should discover what it needs dynamically.
  // Mode system (light/standard/full) controls context injection, not tool availability.

  return result;
}

/**
 * `agenticmail claudecode` — install / status / remove flows for the
 * Claude Code integration. Delegates to @agenticmail/claudecode so this
 * function stays a thin wrapper around the package's public API; all the
 * file-writing and HTTP-talking lives there.
 *
 * Flags:
 *   --status        Print the current install state and exit.
 *   --remove        Remove the integration (preserves the bridge agent
 *                   unless --purge-bridge is also passed).
 *   --purge-bridge  Additionally delete the bridge AgenticMail agent.
 *   -h / --help     Print help and exit.
 */
/**
 * `agenticmail bootstrap` — the one-shot zero-question install.
 *
 * Designed to be runnable by an AI agent (Claude Code itself) without any
 * human in the loop, so a user can say "Claude, install AgenticMail" and
 * the whole pipeline — Stalwart + master key + API server + Claude Code
 * integration + dispatcher daemon — comes up on its own.
 *
 * Pipeline:
 *   1. `agenticmail setup --yes` (skips email/SMS; local-only mode)
 *   2. `agenticmail service install` (launchd plist + auto-start the API)
 *   3. wait for the API to answer /health
 *   4. `agenticmail claudecode` (provision bridge agent, write
 *      ~/.claude.json + ~/.claude/agents/*.md, start the dispatcher)
 *   5. final status check
 *
 * External email relay and SMS are deliberately skipped — they require
 * user-owned credentials nobody else has. Run `agenticmail setup`
 * interactively later to add them.
 *
 * Honest scope: this still requires Docker (or Colima — auto-installed
 * via brew on macOS, apt on Linux) and Node 20+. Everything past that
 * comes up unattended.
 */
async function cmdBootstrap() {
  const sub = process.argv.slice(3);
  if (sub.includes('--help') || sub.includes('-h')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 agenticmail bootstrap ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail bootstrap`);
    log('');
    log('  One-shot, zero-question install. Designed for AI agents (like Claude');
    log('  Code) to run on a user\'s behalf without any prompts.');
    log('');
    log('  Pipeline:');
    log(`    ${c.dim('1.')} agenticmail setup --yes        ${c.dim('(skips email/SMS; local-only)')}`);
    log(`    ${c.dim('2.')} agenticmail service install    ${c.dim('(auto-start the API)')}`);
    log(`    ${c.dim('3.')} wait for API on http://127.0.0.1:<configured port>/api/agenticmail/health`);
    log(`    ${c.dim('4.')} agenticmail claudecode         ${c.dim('(wire Claude Code integration)')}`);
    log('');
    log(`  ${c.bold('Notes:')}`);
    log('    - Docker (or Colima on macOS) will be auto-installed via brew/apt');
    log('      if missing. No GUI gates — uses Colima on macOS, not Docker Desktop.');
    log('    - External email relay and SMS setup are SKIPPED. The local');
    log('      multi-agent flow works without them. Run `agenticmail setup`');
    log('      interactively later if you want outbound mail to the real internet.');
    log('');
    return;
  }

  log('');
  log(`  ${c.pinkBg(' 🎀 AgenticMail bootstrap — fully autonomous install ')}`);
  log('');
  log(`  ${c.dim('No prompts. No human in the loop. Everything is auto-configured.')}`);
  log('');

  // ── Phase 1: setup ───────────────────────────────────────────────
  log(`  ${c.bold('Phase 1 of 4')} ${c.dim('—')} ${c.bold('Provisioning infrastructure (Stalwart + master key)')}`);
  log('');
  // Inject --yes into argv so cmdSetup picks it up. Save + restore.
  const savedArgv = process.argv.slice();
  process.argv = [savedArgv[0]!, savedArgv[1]!, 'setup', '--yes'];
  try {
    await cmdSetup();
  } finally {
    process.argv = savedArgv;
  }
  log('');

  // ── Phase 2: service install + start ─────────────────────────────
  log(`  ${c.bold('Phase 2 of 4')} ${c.dim('—')} ${c.bold('Installing the auto-start service')}`);
  log('');
  const savedArgvSvc = process.argv.slice();
  process.argv = [savedArgvSvc[0]!, savedArgvSvc[1]!, 'service', 'install'];
  try {
    await cmdService();
  } finally {
    process.argv = savedArgvSvc;
  }
  log('');

  // ── Phase 3: wait for API health ─────────────────────────────────
  // Read the actual port from the freshly-written config — never hardcode
  // it, because (a) the default changed in 0.6 (3100→3829) so old assumptions
  // are wrong, and (b) the operator may have overridden it via env var.
  const { apiUrl: healthUrl } = readApiUrlFromConfig();
  log(`  ${c.bold('Phase 3 of 4')} ${c.dim('—')} ${c.bold('Waiting for the API to come online')} ${c.dim('(' + healthUrl + ')')}`);
  log('');
  const apiHealthOk = await waitForApiHealth(healthUrl, 60_000);
  if (!apiHealthOk) {
    fail(`API did not respond on ${healthUrl}/api/agenticmail/health within 60 s`);
    info('Check the logs: tail -f ~/.agenticmail/logs/server.log');
    process.exit(1);
  }
  ok('API server is online and healthy');
  log('');

  // ── Phase 4: claudecode integration ──────────────────────────────
  log(`  ${c.bold('Phase 4 of 4')} ${c.dim('—')} ${c.bold('Wiring Claude Code integration')}`);
  log('');
  const savedArgvCc = process.argv.slice();
  process.argv = [savedArgvCc[0]!, savedArgvCc[1]!, 'claudecode'];
  try {
    await cmdClaudeCode();
  } finally {
    process.argv = savedArgvCc;
  }

  // ── Done ─────────────────────────────────────────────────────────
  //
  // The closer to this output had two failure modes from the field:
  //
  //   1. AI assistants running bootstrap on the user's behalf would
  //      stop here and tell the user "setup complete" — without ever
  //      asking whether they wanted external email / phone calls /
  //      Telegram. The user would only discover those exist days
  //      later when they tried to do something the agent couldn't.
  //   2. The "62 mcp__agenticmail__* tools" line drifted out of date
  //      as the MCP server grew. The number below is the live count
  //      from `packages/mcp/src/tools.ts`; update it (and AGENTS.md +
  //      the package READMEs) when adding/removing tools.
  //
  // The "Next steps" block below addresses both: the asking-AI sees
  // the optional channels and the exact non-interactive commands to
  // wire them up, with secrets piped via env vars (never the
  // command line, never the chat). The four-tool optional list MUST
  // stay in sync with the `setup-*` cli commands.
  log('');
  log(`  ${c.pinkBg(' ✅ Bootstrap complete ')}`);
  log('');
  log(`  ${c.bold('Restart Claude Code')} and you'll have:`);
  log(`    - 95 ${c.cyan('mcp__agenticmail__*')} tools in every session`);
  log(`    - The ${c.cyan('Agent')} tool surfaces each AgenticMail agent as a subagent`);
  log(`    - Send mail to ${c.cyan('<agent>@localhost')} or call_agent → dispatcher auto-wakes them`);
  log('');
  log(`  ${c.bold('Optional — wire up external channels')} ${c.dim('(pick any you want; skip the rest)')}`);
  log('');
  log(`  ${c.cyan('Anthropic auth')} ${c.dim('— the dispatcher\'s spawned workers + the Telegram bridge need an')}`);
  log(`  ${c.dim('OAuth token to talk to Claude. Run once; saved to ~/.agenticmail/anthropic-token.')}`);
  log(`    ${c.green('agenticmail setup-anthropic')}  ${c.dim('(wraps `claude setup-token` — browser flow)')}`);
  log('');
  log(`  ${c.cyan('Real internet email')} ${c.dim('— send/receive mail to/from Gmail, Outlook, etc.')}`);
  log(`    ${c.green('agenticmail setup-email')}`);
  log('');
  log(`  ${c.cyan('Phone calls (Twilio)')} ${c.dim('— agent places real outbound calls. Auto-opens a free')}`);
  log(`  ${c.dim('Cloudflare quick-tunnel; no domain / static IP / Cloudflare account needed.')}`);
  log(`    ${c.green('TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… AGENTICMAIL_PHONE_NUMBER=… \\')}`);
  log(`      ${c.green('agenticmail setup-phone --provider twilio')}`);
  log(`    ${c.dim('(or --provider 46elks with ELKS_USERNAME / ELKS_PASSWORD)')}`);
  log('');
  log(`  ${c.cyan('Telegram bot')} ${c.dim('— DM your agent from your phone, agent replies with')}`);
  log(`  ${c.dim('the same memory + tools as email-driven turns.')}`);
  log(`    ${c.green('TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… agenticmail setup-telegram')}`);
  log('');
  log(`  ${c.dim('Each setup-* command is idempotent; safe to re-run anytime.')}`);
  log('');
}

/**
 * Read the API host+port from ~/.agenticmail/config.json. Used by the
 * bootstrap flow to wait on the RIGHT URL regardless of what default
 * AgenticMail-core happens to ship with this month. Falls back to
 * 127.0.0.1:3829 if the config file is missing or malformed (matches
 * the current core default).
 */
function readApiUrlFromConfig(): { apiUrl: string; host: string; port: number } {
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  let host = '127.0.0.1';
  let port = 3829;
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (cfg?.api?.host) host = cfg.api.host;
      if (typeof cfg?.api?.port === 'number') port = cfg.api.port;
    } catch { /* fall back to defaults */ }
  }
  return { apiUrl: `http://${host}:${port}`, host, port };
}

/**
 * Poll the master API's /health endpoint until it answers 200 or we hit
 * the timeout. Used by `cmdBootstrap` to wait for the freshly-installed
 * launchd service to come online before running `cmdClaudeCode`.
 */
async function waitForApiHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/agenticmail/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return false;
}

async function cmdClaudeCode() {
  const sub = process.argv.slice(3);
  if (sub.includes('--help') || sub.includes('-h') || sub.includes('help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 AgenticMail for Claude Code ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail claudecode [flags]`);
    log('');
    log('  Registers AgenticMail with Claude Code so every Claude Code session');
    log('  can call AgenticMail agents (alice, bob, …) the same way it calls');
    log('  native subagents via the Agent tool.');
    log('');
    log('  Specifically, this command:');
    log(`    ${c.dim('1.')} Provisions a dedicated "claudecode" AgenticMail agent (Claude Code's identity)`);
    log(`    ${c.dim('2.')} Writes an MCP server entry into ~/.claude.json`);
    log(`    ${c.dim('3.')} Generates one Claude Code subagent file per AgenticMail agent`);
    log(`        (in ${c.cyan('~/.claude/agents/agenticmail-<name>.md')})`);
    log('');
    log(`  ${c.bold('Flags:')}`);
    log(`    ${c.green('--status')}        Show what's currently installed and exit`);
    log(`    ${c.green('--remove')}        Uninstall (keeps the bridge agent by default)`);
    log(`    ${c.green('--purge-bridge')}  When used with --remove, also delete the bridge agent`);
    log(`    ${c.green('-h, --help')}      Show this help and exit`);
    log('');
    log(`  After install, restart Claude Code so it picks up the new MCP server.`);
    log('');
    return;
  }

  // Lazy-load the integration package so the rest of the CLI still works
  // even if @agenticmail/claudecode is unavailable (e.g. someone built from
  // source without running the workspace install). We give the user an
  // actionable error in that case rather than a cryptic ESM resolver miss.
  let mod: typeof import('@agenticmail/claudecode');
  try {
    mod = await import('@agenticmail/claudecode');
  } catch (err) {
    fail(`Could not load @agenticmail/claudecode: ${(err as Error).message}`);
    log('');
    info(`Install it with: ${c.green('npm install -g @agenticmail/claudecode')}`);
    process.exit(1);
    return;
  }

  // --- Branch on the requested action ---
  if (sub.includes('--status')) {
    const s = await mod.status();
    log('');
    log(`  ${c.pinkBg(' 🎀 AgenticMail for Claude Code ')}`);
    log('');
    const stateLabel = s.state === 'installed' ? c.green('installed')
      : s.state === 'partial' ? c.yellow('partial')
      : c.dim('not installed');
    log(`  Status: ${stateLabel}`);
    log(`  MCP server registered: ${s.mcpInstalled ? c.green('yes') : c.dim('no')}`);
    log(`  Bridge agent in AgenticMail: ${s.bridgeAgentExists ? c.green('yes') : c.dim('no')}`);
    log(`  Subagent files: ${s.subagents.length > 0 ? c.green(String(s.subagents.length)) : c.dim('0')}`);
    if (s.subagents.length > 0) for (const name of s.subagents) info(`  • ${name}`);
    if (s.notes.length > 0) {
      log('');
      log(`  ${c.bold('Notes:')}`);
      for (const n of s.notes) info(`  • ${n}`);
    }
    log('');
    process.exit(s.state === 'installed' ? 0 : 1);
  }

  if (sub.includes('--remove') || sub.includes('--uninstall')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 Removing AgenticMail from Claude Code ')}`);
    log('');
    const purgeBridge = sub.includes('--purge-bridge');
    const result = await mod.uninstall({ purgeBridgeAgent: purgeBridge });
    if (result.mcpBlockRemoved) ok('Removed MCP server entry from Claude Code config');
    else info('No MCP server entry was registered.');
    if (result.removedSubagents.length > 0) ok(`Removed ${result.removedSubagents.length} subagent file(s)`);
    else info('No subagent files were registered.');
    if (result.bridgeAgentDeleted) ok('Deleted bridge agent from AgenticMail');
    else if (purgeBridge) info('Bridge agent could not be deleted (already gone or AgenticMail unreachable).');
    log('');
    if (!result.changed) info('Nothing to remove.');
    log('');
    return;
  }

  // Default action = install.
  log('');
  log(`  ${c.pinkBg(' 🎀 AgenticMail for Claude Code ')}`);
  log('');
  log(`  ${c.bold('Wiring AgenticMail into Claude Code.')} This will:`);
  log(`    ${c.dim('1.')} Provision a "claudecode" agent inside AgenticMail`);
  log(`    ${c.dim('2.')} Add an MCP server entry to ~/.claude.json`);
  log(`    ${c.dim('3.')} Generate one Claude Code subagent file per AgenticMail agent`);
  log('');

  const spinner = new Spinner('general', 'Talking to AgenticMail…');
  spinner.start();
  let result: Awaited<ReturnType<typeof mod.install>>;
  try {
    result = await mod.install();
    spinner.succeed('Integration installed');
  } catch (err) {
    spinner.fail(`Install failed: ${(err as Error).message}`);
    log('');
    if ((err as { status?: number }).status === 0) {
      info(`Is the AgenticMail server running? Try: ${c.green('agenticmail start')}`);
    }
    log('');
    process.exit(1);
    return;
  }

  ok(`Bridge agent ${c.bold(result.bridgeAgent.name)} ${c.dim('(' + result.bridgeAgent.email + ')')}`);
  ok(`MCP server registered in ${c.cyan(result.claudeConfigPath)}`);
  ok(`${result.registeredAgents.length} Claude Code subagent${result.registeredAgents.length === 1 ? '' : 's'} written to ${c.cyan(result.agentsDir)}`);
  for (const a of result.registeredAgents) info(`  • agenticmail-${a.name.toLowerCase()}  →  ${a.email}`);
  log('');
  if (!result.changed) {
    info('Already up to date — no files were modified.');
  } else {
    log(`  ${c.bold('Next:')} restart Claude Code so it picks up the new MCP server.`);
    info(`Try inside Claude Code: ${c.green('Agent { subagent_type: "agenticmail-alice", prompt: "hi" }')}`);
  }
  log('');
}

async function cmdOpenClaw() {
  // Issue #18 — `agenticmail openclaw --help` previously dropped
  // straight into the interactive setup flow because the
  // top-level dispatcher only looks at process.argv[2]. Check
  // for --help / -h on the subcommand before firing the wizard.
  const sub = process.argv.slice(3);
  if (sub.includes('--help') || sub.includes('-h') || sub.includes('help')) {
    log('');
    log(`  ${c.pinkBg(' 🎀 AgenticMail for OpenClaw ')}`);
    log('');
    log(`  ${c.bold('Usage:')} agenticmail openclaw`);
    log('');
    log('  Interactive setup wizard for the OpenClaw plugin. Walks you');
    log('  through six steps:');
    log(`    ${c.dim('1.')} Set up the mail server infrastructure (Stalwart)`);
    log(`    ${c.dim('2.')} Create an agent email account`);
    log(`    ${c.dim('3.')} Set up phone number access (Google Voice)`);
    log(`    ${c.dim('4.')} Register + configure the OpenClaw plugin`);
    log(`    ${c.dim('5.')} Restart the OpenClaw gateway so the plugin loads`);
    log(`    ${c.dim('6.')} Verify the agent's mailbox`);
    log('');
    log(`  ${c.bold('Flags:')}`);
    log(`    ${c.green('-h, --help')}    Show this help and exit`);
    log('');
    log(`  Run ${c.green('agenticmail --help')} for the full command list.`);
    log('');
    return;
  }

  log('');
  log(`  ${c.pinkBg(' 🎀 AgenticMail for OpenClaw ')}`);
  log('');
  log(`  ${c.bold("Let's get your OpenClaw agent set up with email.")}`);
  log(`  This will:`);
  log(`    ${c.dim('1.')} Set up the mail server infrastructure`);
  log(`    ${c.dim('2.')} Create an agent email account`);
  log(`    ${c.dim('3.')} Set up phone number access ${c.green('NEW')}`);
  log(`    ${c.dim('4.')} Configure the OpenClaw plugin`);
  log(`    ${c.dim('5.')} Restart the OpenClaw gateway`);
  log('');

  const setup = new SetupManager();

  // ── Step 1: Infrastructure ──────────────────────────────────────
  log(`  ${c.bold('Step 1 of 6')} ${c.dim('—')} ${c.bold('Checking infrastructure')}`);
  log('');

  let config: SetupConfig;
  let configPath: string;

  if (setup.isInitialized()) {
    ok('Infrastructure already set up');
    configPath = join(homedir(), '.agenticmail', 'config.json');
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      fail('Could not read existing config. Run: agenticmail setup');
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 300));
  } else {
    // Dependency checks
    const deps = await setup.checkDependencies();
    const docker = deps.find(d => d.name === 'docker');
    const stalwart = deps.find(d => d.name === 'stalwart');

    // Generate config + keys
    const configSpinner = new Spinner('config');
    configSpinner.start();
    await new Promise(r => setTimeout(r, 1_500));
    const result = setup.initConfig();
    config = result.config;
    configPath = result.configPath;
    configSpinner.succeed('Account and keys generated');
    await new Promise(r => setTimeout(r, 300));

    // Docker
    if (!docker?.installed) {
      const spinner = new Spinner('docker');
      spinner.start();
      try {
        await setup.ensureDocker();
        spinner.succeed(`${c.bold('Engine')} — installed and running`);
      } catch (err) {
        spinner.fail(`Couldn't start engine: ${(err as Error).message}`);
        log('');
        log(`  ${c.yellow('Tip:')} Install Docker manually from ${c.cyan('https://docker.com/get-docker')}`);
        log(`  ${c.dim('Then run')} ${c.green('agenticmail openclaw')} ${c.dim('again.')}`);
        process.exit(1);
      }
    } else {
      ok(`${c.bold('Engine')} ${c.dim('— running')}`);
      await new Promise(r => setTimeout(r, 300));
    }

    // Stalwart
    if (!stalwart?.installed) {
      const spinner = new Spinner('stalwart');
      spinner.start();
      try {
        await setup.ensureStalwart();
        spinner.succeed(`${c.bold('Mail Server')} — up and running`);
      } catch (err) {
        spinner.fail(`Couldn't start mail server: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      ok(`${c.bold('Mail Server')} ${c.dim('— already running')}`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  log('');

  // ── Step 2: Start API temporarily ───────────────────────────────
  log(`  ${c.bold('Step 2 of 6')} ${c.dim('—')} ${c.bold('Starting server')}`);
  log('');

  const apiHost = config.api.host;
  const apiPort = config.api.port;
  const apiBase = `http://${apiHost}:${apiPort}`;
  let serverWasRunning = false;

  try {
    const probe = await fetch(`${apiBase}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (probe.ok) serverWasRunning = true;
  } catch { /* not running */ }

  if (serverWasRunning) {
    ok(`Server already running at ${c.cyan(apiBase)}`);
  } else {
    const serverSpinner = new Spinner('server', 'Starting the server...');
    serverSpinner.start();
    try {
      const ready = await startApiServer(config);
      if (!ready) {
        serverSpinner.fail('Server did not start in time');
        process.exit(1);
      }
      serverSpinner.succeed(`Server running at ${c.cyan(apiBase)}`);
    } catch (err) {
      fail(`Couldn't start server: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  log('');

  // ── Step 3: Create agent account ────────────────────────────────
  log(`  ${c.bold('Step 3 of 6')} ${c.dim('—')} ${c.bold('Agent account')}`);
  log('');

  let agentApiKey: string | undefined;
  let agentEmail = '';
  let agentName = 'secretary';

  // Check for existing agents
  let existingAgents: any[] = [];
  try {
    const listRes = await fetch(`${apiBase}/api/agenticmail/accounts`, {
      headers: { 'Authorization': `Bearer ${config.masterKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (listRes.ok) {
      const data = await listRes.json() as any;
      existingAgents = data?.agents ?? data ?? [];
    }
  } catch { /* ignore */ }

  // Fetch inbox/sent counts for each agent
  interface AgentStats { name: string; email: string; role: string; apiKey: string; inbox: number; sent: number; }
  const agentStats: AgentStats[] = [];
  for (const a of existingAgents) {
    const name = a.name ?? 'unknown';
    const email = a.email ?? `${name}@localhost`;
    const role = a.role ?? '';
    let inbox = 0, sent = 0;
    try {
      const r = await fetch(`${apiBase}/api/agenticmail/mail/inbox?limit=1&offset=0`, {
        headers: { 'Authorization': `Bearer ${a.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (r.ok) { const d = await r.json() as any; inbox = d?.total ?? d?.messages?.length ?? 0; }
    } catch {}
    try {
      const r = await fetch(`${apiBase}/api/agenticmail/mail/folders/Sent?limit=1&offset=0`, {
        headers: { 'Authorization': `Bearer ${a.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (r.ok) { const d = await r.json() as any; sent = d?.total ?? d?.messages?.length ?? 0; }
    } catch {}
    agentStats.push({ name, email, role, apiKey: a.apiKey, inbox, sent });
  }

  if (agentStats.length > 0) {
    // Interactive arrow-key selector
    const options = [
      ...agentStats.map(a => a.name),
      '+ Create new agent',
    ];

    const selectedIdx: number = await new Promise((resolve) => {
      let sel = 0;
      const totalOpts = options.length;
      emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);

      const renderList = () => {
        // Move cursor up to clear previous render (if not first render)
        const totalLines = totalOpts + 3; // options + header + footer + blank
        process.stdout.write(`\x1b[${totalLines}A\r\x1b[J`);
        drawList();
      };

      const drawList = () => {
        log(`  ${c.dim('Use ↑↓ arrows to select, Enter to confirm')}`);
        log('');
        for (let i = 0; i < options.length; i++) {
          const isCreate = i === agentStats.length;
          const pointer = i === sel ? c.green('  ❯ ') : '    ';
          if (isCreate) {
            const label = i === sel ? c.bold(c.green(options[i])) : c.green(options[i]);
            log(`${pointer}${label}`);
          } else {
            const a = agentStats[i];
            const nameStr = i === sel ? c.bold(c.cyan(a.name)) : c.cyan(a.name);
            const roleStr = a.role ? c.dim(` (${a.role})`) : '';
            const stats = `${c.dim('Inbox:')} ${c.yellow(String(a.inbox))}  ${c.dim('Sent:')} ${c.yellow(String(a.sent))}`;
            log(`${pointer}${nameStr}${roleStr}  ${c.dim(a.email)}  ${stats}`);
          }
        }
        log('');
      };

      // Initial draw — first time, no erase needed
      drawList();

      const onKey = (_ch: string, key: any) => {
        if (!key) return;
        if (key.name === 'up') {
          sel = (sel - 1 + totalOpts) % totalOpts;
          renderList();
        } else if (key.name === 'down') {
          sel = (sel + 1) % totalOpts;
          renderList();
        } else if (key.name === 'return') {
          process.stdin.removeListener('keypress', onKey);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          resolve(sel);
        } else if (key.name === 'escape') {
          process.stdin.removeListener('keypress', onKey);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          resolve(0);
        }
      };
      process.stdin.on('keypress', onKey);
    });

    if (selectedIdx < agentStats.length) {
      // Use existing agent
      const selected = agentStats[selectedIdx];
      agentName = selected.name;
      agentApiKey = selected.apiKey;
      agentEmail = selected.email;
      ok(`Using agent ${c.bold('"' + agentName + '"')} (${c.cyan(agentEmail)})`);
    } else {
      // Create new agent
      const agentNameInput = await ask(`  ${c.cyan('Agent name')} ${c.dim('(secretary)')}: `);
      agentName = agentNameInput.trim() || 'secretary';

      const existing = agentStats.find(a => a.name === agentName);
      if (existing) {
        agentApiKey = existing.apiKey;
        agentEmail = existing.email;
        ok(`Agent ${c.bold('"' + agentName + '"')} already exists (${c.cyan(agentEmail)})`);
      } else {
        log('');
        const spinner = new Spinner('config', 'Creating agent...');
        spinner.start();
        try {
          const response = await fetch(`${apiBase}/api/agenticmail/accounts`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.masterKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: agentName, role: 'secretary' }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const data = await response.json() as any;
            agentApiKey = data.apiKey;
            agentEmail = data.email ?? `${agentName}@localhost`;
            spinner.succeed(`Agent ${c.bold('"' + agentName + '"')} created (${c.cyan(agentEmail)})`);
          } else {
            spinner.fail(`Could not create agent: ${await response.text()}`);
          }
        } catch (err) {
          spinner.fail(`Error: ${(err as Error).message}`);
        }
      }
    }
  } else {
    // No existing agents — create one
    const agentNameInput = await ask(`  ${c.cyan('Agent name')} ${c.dim('(secretary)')}: `);
    agentName = agentNameInput.trim() || 'secretary';

    log('');
    const agentSpinner = new Spinner('config', 'Setting up agent email account...');
    agentSpinner.start();

    try {
      const response = await fetch(`${apiBase}/api/agenticmail/accounts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.masterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: agentName, role: 'secretary' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = await response.json() as any;
        agentApiKey = data.apiKey;
        agentEmail = data.email ?? `${agentName}@localhost`;
        agentSpinner.succeed(`Agent ${c.bold('"' + agentName + '"')} created (${c.cyan(agentEmail)})`);
      } else {
        agentSpinner.fail(`Could not create agent: ${await response.text()}`);
      }
    } catch (err) {
      agentSpinner.fail(`Error: ${(err as Error).message}`);
    }
  }

  log('');

  // ── Step 4: Phone number / SMS (optional) ─────────────────────
  log(`  ${c.bold('Step 4 of 6')} ${c.dim('—')} ${c.bold('Phone number access')} ${c.green('NEW')}`);
  log('');
  log(`  ${c.dim('Give your AI agent a phone number via Google Voice.')}`);
  log(`  ${c.dim('Agents can receive verification codes and send texts.')}`);
  log('');

  // Check if SMS is already configured
  let smsAlreadyConfigured = false;
  if (agentApiKey) {
    try {
      const smsResp = await fetch(`${apiBase}/api/agenticmail/sms/config`, {
        headers: { 'Authorization': `Bearer ${agentApiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const smsData = await smsResp.json() as any;
      if (smsData.sms?.enabled) {
        smsAlreadyConfigured = true;
        ok(`SMS already configured: ${c.bold(smsData.sms.phoneNumber)}`);
      }
    } catch {}
  }

  if (!smsAlreadyConfigured) {
    const wantSms = nonInteractiveDefault<string>('N') ?? await ask(`  ${c.bold('Set up phone number access?')} ${c.dim('(y/N)')} `);
    if (wantSms.toLowerCase().startsWith('y')) {
      log('');

      const hasVoice = await ask(`  ${c.bold('Do you already have a Google Voice number?')} ${c.dim('(y/N)')} `);
      if (!hasVoice.toLowerCase().startsWith('y')) {
        log('');
        log(`  ${c.bold('Google Voice Setup (takes about 2 minutes):')}`);
        log('');
        log(`  ${c.cyan('Step 1:')} Open ${c.bold(c.cyan('https://voice.google.com'))} in your browser`);
        log(`  ${c.cyan('Step 2:')} Sign in with your Google account`);
        log(`  ${c.cyan('Step 3:')} Click ${c.bold('"Choose a phone number"')}`);
        log(`  ${c.cyan('Step 4:')} Search for a number by city or area code`);
        log(`  ${c.cyan('Step 5:')} Pick a number and click ${c.bold('"Verify"')}`);
        log(`         ${c.dim('(Google will send a code to your existing phone to verify)')}`);
        log(`  ${c.cyan('Step 6:')} Once verified, go to ${c.bold('Settings')} (gear icon)`);
        log(`  ${c.cyan('Step 7:')} Under Messages, enable ${c.bold('"Forward messages to email"')}`);
        log('');
        log(`  ${c.dim('Come back here when you have your number.')}`);
        log('');
        await ask(`  ${c.bold('Press Enter when ready...')} `);
      }

      log('');
      const phoneNumber = await ask(`  ${c.bold('Your Google Voice number')} ${c.dim('(e.g. +12125551234):')} `);
      if (phoneNumber.trim()) {
        const digits = phoneNumber.replace(/[^+\d]/g, '').replace(/\D/g, '');
        if (digits.length < 10) {
          log(`  ${c.yellow('!')} That doesn't look like a valid phone number.`);
          info('You can set this up later in the shell with /sms');
        } else {
          // Google Voice ONLY forwards SMS to the Gmail it's registered with.
          // If user's relay email differs from GV Gmail, we need separate credentials.
          let forwardingEmail: string | undefined;
          let forwardingPassword: string | undefined;
          let relayEmail = '';
          let relayProvider = '';
          try {
            const gwResp = await fetch(`${apiBase}/api/agenticmail/gateway/status`, {
              headers: { 'Authorization': `Bearer ${config.masterKey}` },
              signal: AbortSignal.timeout(5_000),
            });
            const gwData = await gwResp.json() as any;
            if (gwData.mode === 'relay' && gwData.relay?.email) {
              relayEmail = gwData.relay.email;
              relayProvider = gwData.relay.provider || '';
            } else if (gwData.mode === 'domain') {
              relayProvider = 'domain';
            }
          } catch {}

          log('');
          log(`  ┌─────────────────────────────────────────────────────────┐`);
          log(`  │  ${c.red(c.bold('READ THIS'))} — Google Voice email matching is ${c.red(c.bold('critical'))}  │`);
          log(`  └─────────────────────────────────────────────────────────┘`);
          log('');
          log(`  Google Voice forwards SMS ${c.bold('ONLY')} to the ${c.green(c.bold('Gmail account'))}`);
          log(`  you used to ${c.green(c.bold('sign up'))} for Google Voice.`);
          log('');
          log(`  ${c.yellow('If your agent can\'t read that Gmail, it will')} ${c.red(c.bold('NEVER'))}`);
          log(`  ${c.yellow('receive any SMS messages.')}`);
          log('');

          if (relayEmail) {
            const isGmail = relayEmail.toLowerCase().endsWith('@gmail.com');
            log(`  Your email relay: ${c.bold(c.cyan(relayEmail))}`);
            if (!isGmail) {
              // Non-Gmail relay (Outlook, domain, etc.) — definitely needs separate Gmail
              log('');
              log(`  ${c.red(c.bold('!!'))} Your relay is ${c.bold('not Gmail')}. Google Voice won't forward here.`);
              log(`  ${c.red(c.bold('!!'))} You ${c.bold('must')} provide the Gmail you used for Google Voice.`);
              log('');
              const gvEmail = await ask(`  ${c.green(c.bold('Gmail used for Google Voice:'))} `);
              if (gvEmail.trim() && gvEmail.toLowerCase().includes('@gmail.com')) {
                log('');
                log(`  ${c.dim('Get an app password at:')} ${c.cyan('https://myaccount.google.com/apppasswords')}`);
                const gvPass = await askSecret(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
                if (gvPass.trim()) {
                  forwardingEmail = gvEmail.trim();
                  forwardingPassword = gvPass.trim();
                } else {
                  log(`  ${c.red('!')} No password. ${c.yellow('SMS will not work without this.')}`);
                  log(`  ${c.dim('Fix later with /sms in the shell.')}`);
                }
              } else if (gvEmail.trim()) {
                log(`  ${c.red('!')} Google Voice requires a ${c.bold('Gmail')} address (ends in @gmail.com).`);
                log(`  ${c.dim('Fix later with /sms in the shell.')}`);
              } else {
                log(`  ${c.yellow('!')} Skipped. ${c.dim('SMS will not work until you provide this.')}`);
                log(`  ${c.dim('Fix later with /sms in the shell.')}`);
              }
            } else {
              // Gmail relay — but could be a DIFFERENT Gmail
              log('');
              log(`  ${c.yellow('?')} Did you sign up for Google Voice with ${c.bold('this same Gmail')}?`);
              log(`    ${c.dim('If you used a different Gmail for Google Voice, say no.')}`);
              log('');
              const sameEmail = await ask(`  ${c.bold('Same Gmail as Google Voice?')} ${c.dim('(Y/n)')} `);
              if (sameEmail.toLowerCase().startsWith('n')) {
                log('');
                log(`  ${c.yellow(c.bold('Different Gmail detected.'))} Your agent needs access to the`);
                log(`  Google Voice Gmail to receive SMS.`);
                log('');
                const gvEmail = await ask(`  ${c.green(c.bold('Gmail used for Google Voice:'))} `);
                if (gvEmail.trim() && gvEmail.toLowerCase().includes('@gmail.com')) {
                  if (gvEmail.trim().toLowerCase() === relayEmail.toLowerCase()) {
                    log(`  ${c.green('!')} That's the same email as your relay — you're all set!`);
                  } else {
                    log('');
                    log(`  ${c.dim('Get an app password at:')} ${c.cyan('https://myaccount.google.com/apppasswords')}`);
                    const gvPass = await askSecret(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
                    if (gvPass.trim()) {
                      forwardingEmail = gvEmail.trim();
                      forwardingPassword = gvPass.trim();
                    } else {
                      log(`  ${c.red('!')} No password. ${c.yellow('SMS will not work without this.')}`);
                      log(`  ${c.dim('Fix later with /sms in the shell.')}`);
                    }
                  }
                } else if (gvEmail.trim()) {
                  log(`  ${c.red('!')} Google Voice requires a ${c.bold('Gmail')} address.`);
                  log(`  ${c.dim('Fix later with /sms in the shell.')}`);
                } else {
                  log(`  ${c.yellow('!')} Skipped. ${c.dim('SMS may not work if emails don\'t match.')}`);
                  log(`  ${c.dim('Fix later with /sms in the shell.')}`);
                }
              }
              // If yes (default) — relay Gmail = GV Gmail, no extra creds needed
            }
          } else if (relayProvider === 'domain') {
            // Domain mode — no relay, definitely needs Gmail for GV
            log(`  ${c.yellow('!')} You're using ${c.bold('domain mode')} (no Gmail relay).`);
            log(`  ${c.yellow('!')} Google Voice needs a Gmail. Provide the one you signed up with.`);
            log('');
            const gvEmail = await ask(`  ${c.green(c.bold('Gmail used for Google Voice:'))} `);
            if (gvEmail.trim() && gvEmail.toLowerCase().includes('@gmail.com')) {
              log('');
              log(`  ${c.dim('Get an app password at:')} ${c.cyan('https://myaccount.google.com/apppasswords')}`);
              const gvPass = await askSecret(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
              if (gvPass.trim()) {
                forwardingEmail = gvEmail.trim();
                forwardingPassword = gvPass.trim();
              } else {
                log(`  ${c.red('!')} No password. ${c.yellow('SMS will not work without this.')}`);
                log(`  ${c.dim('Fix later with /sms in the shell.')}`);
              }
            } else {
              log(`  ${c.yellow('!')} Skipped. ${c.dim('SMS will not work until you provide this.')}`);
              log(`  ${c.dim('Fix later with /sms in the shell.')}`);
            }
          } else {
            // No gateway configured yet — ask for Gmail
            log(`  ${c.dim('No email relay detected yet.')}`);
            log('');
            const gvEmail = await ask(`  ${c.green(c.bold('Gmail used for Google Voice:'))} `);
            if (gvEmail.trim() && gvEmail.includes('@')) {
              forwardingEmail = gvEmail.trim();
            }
          }

          // Save config
          if (agentApiKey) {
            try {
              const body: Record<string, string> = { phoneNumber: phoneNumber.trim() };
              if (forwardingEmail) body.forwardingEmail = forwardingEmail;
              if (forwardingPassword) body.forwardingPassword = forwardingPassword;
              const resp = await fetch(`${apiBase}/api/agenticmail/sms/setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
                body: JSON.stringify(body),
              });
              const data = await resp.json() as any;
              if (data.success) {
                log('');
                ok(`Phone number saved: ${c.bold(data.sms?.phoneNumber || phoneNumber.trim())}`);
                if (forwardingEmail) {
                  ok(`SMS forwarding via: ${c.bold(forwardingEmail)}`);
                }
                log(`  ${c.dim('Remember: enable "Forward messages to email" in Google Voice settings')}`);
                log(`  ${c.dim('Manage SMS anytime in the shell with /sms')}`);
              } else {
                fail(data.error || 'Setup failed');
              }
            } catch (err) { fail((err as Error).message); }
          }
        }
      } else {
        info('Skipped. Use /sms in the shell anytime.');
      }
    } else {
      info('Skipped. Add a phone number anytime with /sms in the shell.');
    }
  }

  log('');

  // ── Step 5: Configure OpenClaw ──────────────────────────────────
  log(`  ${c.bold('Step 5 of 6')} ${c.dim('—')} ${c.bold('Installing plugin + configuring OpenClaw')}`);
  log('');

  // Resolve the @agenticmail/openclaw plugin directory
  const pluginDir = resolveOpenClawPluginDir();
  if (pluginDir) {
    ok(`Plugin found: ${c.cyan(pluginDir)}`);
  } else {
    fail('Could not find @agenticmail/openclaw package');
    log(`  ${c.dim('Install it:')} ${c.green('openclaw plugins install @agenticmail/openclaw')}`);
  }

  const openclawConfigPath = findOpenClawConfig();
  const apiUrl = apiBase;

  if (openclawConfigPath) {
    // Check if it's a YAML file — we can't safely parse/write YAML without a dep
    if (openclawConfigPath.endsWith('.yaml') || openclawConfigPath.endsWith('.yml')) {
      ok(`Found config: ${c.cyan(openclawConfigPath)}`);
      log('');
      log(`  ${c.yellow('YAML config detected.')} Add this to your config manually:`);
      log('');
      if (pluginDir) {
        log(`  ${c.dim('plugins.load.paths:')}`);
        log(`  ${c.dim(`  - "${pluginDir}"`)}`);
      }
      log(`  ${c.dim('plugins.entries.openclaw:')}`);
      log(`  ${c.dim('  enabled: true')}`);
      log(`  ${c.dim('  config:')}`);
      log(`  ${c.dim(`    apiUrl: "${apiUrl}"`)}`);
      // OpenClaw YAML setup snippet — operator pastes this verbatim
      // into their config. CodeQL `js/clear-text-logging` is the
      // intended behavior of the command. lgtm[js/clear-text-logging]
      if (agentApiKey) log(`  ${c.dim(`    apiKey: "${agentApiKey}"`)}`);
      // lgtm[js/clear-text-logging]
      log(`  ${c.dim(`    masterKey: "${config.masterKey}"`)}`);
    } else {
      // JSON/JSONC — parse, merge, write
      const configSpinner = new Spinner('config', 'Updating OpenClaw config...');
      configSpinner.start();
      try {
        const raw = readFileSync(openclawConfigPath, 'utf-8');
        const existing = JSON5.parse(raw);
        const updated = mergePluginConfig(existing, apiUrl, config.masterKey, agentApiKey, pluginDir);
        writeFileSync(openclawConfigPath, JSON.stringify(updated, null, 2) + '\n');
        configSpinner.succeed(`OpenClaw config updated: ${c.cyan(openclawConfigPath)}`);
        // Check if hooks were newly enabled
        if (!JSON5.parse(raw)?.hooks?.enabled && updated?.hooks?.enabled) {
          ok(`${c.bold('Agent auto-spawn')} enabled — call_agent will auto-create sessions`);
        }
      } catch (err) {
        configSpinner.fail(`Could not update config: ${(err as Error).message}`);
        log('');
        printPluginSnippet(apiUrl, config.masterKey, agentApiKey);
      }
    }
  } else {
    // No config found — offer to create one or print snippet
    info('No OpenClaw config file found.');
    log('');

    const defaultPath = join(homedir(), '.openclaw', 'openclaw.json');
    const createChoice = await pick(
      `  Create ${c.cyan(defaultPath)}? [${c.green('y')}/${c.red('n')}] `,
      ['y', 'n'],
    );

    if (createChoice === 'y') {
      try {
        const dir = dirname(defaultPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const newConfig = mergePluginConfig({}, apiUrl, config.masterKey, agentApiKey, pluginDir);
        writeFileSync(defaultPath, JSON.stringify(newConfig, null, 2) + '\n');
        ok(`Created ${c.cyan(defaultPath)}`);
        ok(`${c.bold('Agent auto-spawn')} enabled — call_agent will auto-create sessions`);
      } catch (err) {
        fail(`Could not create config: ${(err as Error).message}`);
        log('');
        printPluginSnippet(apiUrl, config.masterKey, agentApiKey);
      }
    } else {
      log('');
      log(`  Add this to your OpenClaw config file:`);
      log('');
      printPluginSnippet(apiUrl, config.masterKey, agentApiKey);
    }
  }

  // ── Step 5: Restart OpenClaw gateway ──────────────────────────
  log('');
  log(`  ${c.bold('Step 6 of 6')} ${c.dim('—')} ${c.bold('Restarting OpenClaw gateway')}`);
  log('');

  let gatewayRestarted = false;

  // Check if `openclaw` CLI is available
  let hasOpenClawCli = false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('which openclaw', { stdio: 'ignore' });
    hasOpenClawCli = true;
  } catch { /* openclaw CLI not found */ }

  if (!hasOpenClawCli) {
    log(`  ${c.yellow('⚠')} OpenClaw CLI not found in PATH`);
    log(`    Run manually: ${c.green('openclaw gateway start')}`);
  } else {
    // Non-interactive (agent/script): auto-restart
    // Interactive (human): ask for confirmation
    const isInteractive = process.stdin.isTTY === true;
    let shouldRestart = !isInteractive;

    if (isInteractive) {
      const answer = await ask(`  Restart OpenClaw gateway now? ${c.dim('[Y/n]')} `);
      shouldRestart = !answer || answer.trim().toLowerCase() !== 'n';
    }

    if (shouldRestart) {
      const restartSpinner = new Spinner('gateway', 'Restarting OpenClaw gateway...');
      restartSpinner.start();
      try {
        const { execSync } = await import('node:child_process');
        execSync('openclaw gateway start', { stdio: 'pipe', timeout: 30_000 });
        restartSpinner.succeed('OpenClaw gateway restarted');
        gatewayRestarted = true;
      } catch (err) {
        restartSpinner.fail('Gateway restart failed');
        log(`  ${c.yellow('⚠')} Gateway restart failed: ${(err as Error).message}`);
        log(`    Run manually: ${c.green('openclaw gateway start')}`);
      }
    } else {
      log(`  ${c.dim('Skipped.')} Run later: ${c.green('openclaw gateway start')}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  log('');
  log(`  ${c.bgGreen(" You're all set! ")}`);
  log('');
  if (agentEmail) {
    log(`  ${c.dim('Agent:')}       ${c.bold(agentName)} (${c.cyan(agentEmail)})`);
  }
  if (agentApiKey) {
    log(`  ${c.dim('API Key:')}     ${c.yellow(maskSecret(agentApiKey))}`);
  }
  log(`  ${c.dim('Master Key:')}  ${c.yellow(maskSecret(config.masterKey))}`);
  log(`  ${c.dim('Server:')}      ${c.cyan(apiBase)}`);

  // Show phone number if SMS is configured
  let smsPhone = '';
  if (agentApiKey) {
    try {
      const smsResp = await fetch(`${apiBase}/api/agenticmail/sms/config`, {
        headers: { 'Authorization': `Bearer ${agentApiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const smsData = await smsResp.json() as any;
      if (smsData.sms?.enabled && smsData.sms?.phoneNumber) {
        smsPhone = smsData.sms.phoneNumber;
        log(`  ${c.dim('Phone:')}      ${c.green(smsPhone)} ${c.dim('via Google Voice')}`);
      }
    } catch {}
  }

  // Also check other agents for phone numbers
  if (!smsPhone) {
    try {
      const acctResp = await fetch(`${apiBase}/api/agenticmail/accounts`, {
        headers: { 'Authorization': `Bearer ${config.masterKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const acctData = await acctResp.json() as any;
      for (const a of (acctData.agents || [])) {
        const smsConf = a.metadata?.sms;
        if (smsConf?.enabled && smsConf.phoneNumber) {
          smsPhone = smsConf.phoneNumber;
          log(`  ${c.dim('Phone:')}      ${c.green(smsPhone)} ${c.dim('via Google Voice')} ${c.dim('(' + a.name + ')')}`);
          break;
        }
      }
    } catch {}
  }

  log('');
  if (gatewayRestarted) {
    log(`  Your agent now has ${c.bold('78 email, SMS, phone, Telegram & storage tools')} available!`);
    log(`  Try: ${c.dim('"Send an email to test@example.com"')}`);
    log('');
    log(`  ${c.bold('🎀 AgenticMail Coordination')} ${c.dim('(auto-configured)')}`);
    log(`    Your agent can now use ${c.cyan('agenticmail_call_agent')} to call other agents`);
    log(`    with structured task queues, push notifications, and auto-spawned sessions.`);
    log(`    This replaces sessions_spawn for coordinated multi-agent work.`);
    log('');
    if (smsPhone) {
      log(`  ${c.bold('📱 SMS & Phone Access')} ${c.green('ACTIVE')}`);
      log(`    Phone: ${c.bold(smsPhone)} via Google Voice`);
      log(`    Your agent can receive verification codes and send texts.`);
      log(`    Manage with ${c.cyan('/sms')} in the shell.`);
    } else {
      log(`  ${c.bold('📱 SMS & Phone Access')} ${c.dim('(Google Voice)')}`);
      log(`    Your agent can receive verification codes and send texts.`);
      log(`    SMS messages are auto-detected from Google Voice email forwarding.`);
      log(`    Set up with ${c.cyan('/sms')} in the shell or during setup wizard.`);
    }
  } else {
    log(`  ${c.bold('Next step:')}`);
    log(`    Restart your OpenClaw gateway, then your agent will`);
    log(`    have ${c.bold('78 email, SMS, phone & Telegram tools')} available!`);
  }
  log('');

  // Drop into the interactive shell — server keeps running in background after exit
  if (process.stdin.isTTY) {
    await interactiveShell({ config, onExit: () => {} });
  }
}

function printPluginSnippet(apiUrl: string, masterKey: string, agentApiKey?: string) {
  log(`  ${c.dim('{')}`);
  log(`  ${c.dim('  "plugins": {')}`);
  log(`  ${c.dim('    "entries": {')}`);
  log(`  ${c.dim('      "agenticmail": {')}`);
  log(`  ${c.dim('        "enabled": true,')}`);
  log(`  ${c.dim('        "config": {')}`);
  log(`  ${c.dim(`          "apiUrl": "${apiUrl}",`)}`);
  if (agentApiKey) {
    // OpenClaw setup snippet — the operator is expected to copy this
    // verbatim into their config file. CodeQL `js/clear-text-logging`
    // is intentional here; the print is the entire point of the
    // command. lgtm[js/clear-text-logging]
    log(`  ${c.dim(`          "apiKey": "${agentApiKey}",`)}`);
  }
  // Same exception as the apiKey line above — operator setup output.
  // lgtm[js/clear-text-logging]
  log(`  ${c.dim(`          "masterKey": "${masterKey}"`)}`);
  log(`  ${c.dim('        }')}`);
  log(`  ${c.dim('      }')}`);
  log(`  ${c.dim('    }')}`);
  log(`  ${c.dim('  }')}`);
  log(`  ${c.dim('}')}`);
}

/** Issue #21 helper — is the user actually running a Cloudflare
 *  tunnel? Reads the saved config + checks the live gateway-status
 *  endpoint. Returns true only when domain mode is configured AND
 *  reports a tunnel id; the binary-installed-but-no-tunnel case
 *  returns false so the status command stops mis-announcing
 *  "Secure Tunnel ✅" on localhost-only setups. */
async function isTunnelConfigured(): Promise<boolean> {
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.gateway?.mode !== 'domain') return false;
    if (!config.gateway?.domain?.tunnelId
        && !config.gateway?.domain?.domain) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * `agenticmail web` — print the URL for the lightweight Gmail-style
 * web UI bundled in @agenticmail/api/public/ and offer to open it.
 *
 * The UI lives at `/` (and `/ui` as an alias) on the running API
 * server. The user signs in with their master key — which is the
 * same `mk_...` string in `~/.agenticmail/config.json` — and from
 * there can see every agent's inbox in a familiar three-pane layout,
 * read full messages with proper markdown rendering, compose new
 * mail, and reply (with the wake-allowlist parameter surfaced as a
 * compose field so they can keep token cost down on large threads).
 */
async function cmdWeb() {
  log('');
  log(`  ${c.pinkBg(' 🎀 AgenticMail web UI ')}`);
  log('');

  const configPath = join(homedir(), '.agenticmail', 'config.json');
  if (!existsSync(configPath)) {
    log(`  ${c.red('✗')} AgenticMail isn't set up yet. Run ${c.green('agenticmail setup')} first.`);
    log('');
    return;
  }
  const { apiUrl } = readApiUrlFromConfig();

  // Pull the master key from ~/.agenticmail/config.json and tack it on
  // as a one-time URL parameter so the user lands signed in. The web
  // UI reads `?key=…` once, stores it in localStorage, then strips it
  // from the address bar via `history.replaceState`. Safe because:
  //   1. The URL is loopback-only (127.0.0.1), never leaves the box.
  //   2. The key is owned by the same user who's running this command.
  //   3. The browser's address bar gets cleaned on the next tick so the
  //      key doesn't end up in history / Referer / screenshare frames.
  let masterKey = '';
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg?.masterKey === 'string') masterKey = cfg.masterKey;
  } catch { /* fall through — URL without key just shows the auth gate */ }
  const url = masterKey ? `${apiUrl}/?key=${encodeURIComponent(masterKey)}` : apiUrl;

  // Quick liveness check so we can give the user a clear yes/no on
  // whether the server is actually accepting requests.
  let alive = false;
  try {
    const resp = await fetch(`${url}/api/agenticmail/health`, { signal: AbortSignal.timeout(2_000) });
    alive = resp.ok;
  } catch { /* server is down */ }

  if (!alive) {
    log(`  ${c.red('✗')} API server not reachable at ${c.cyan(url)}.`);
    log(`    Start it with ${c.green('agenticmail start')} (in another terminal) or ${c.green('agenticmail service install')}.`);
    log('');
    return;
  }

  log(`  ${c.green('✓')} API server is running at ${c.cyan(apiUrl)}`);
  log('');
  if (masterKey) {
    log(`  ${c.bold('Opening the web UI — you\'ll be signed in automatically.')}`);
    log('');
    log(`    ${c.dim(apiUrl)}`);
  } else {
    log(`  ${c.yellow('!')} ${c.bold('Master key not found in config; you\'ll need to paste it manually.')}`);
    log('');
    log(`    ${c.green(apiUrl)}`);
    log('');
    log(`  ${c.dim('When prompted:')}`);
    log(`    ${c.dim('cat ~/.agenticmail/config.json | grep masterKey')}`);
  }
  log('');

  // Try to open the browser. macOS = open, Linux = xdg-open, Windows = start.
  // Best-effort — print the URL regardless so the user can copy/paste.
  const platform = process.platform;
  const opener = platform === 'darwin' ? 'open'
              : platform === 'win32'  ? 'start'
              : 'xdg-open';
  try {
    const { spawn } = await import('node:child_process');
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    log(`  ${c.dim(`Opening ${url} in your default browser…`)}`);
    log('');
  } catch { /* user can click the URL above */ }
}

async function cmdStatus() {
  log('');
  log(`  ${c.pinkBg(' 🎀 AgenticMail Status ')}`);
  log('');

  const setup = new SetupManager();

  const FRIENDLY_NAMES: Record<string, string> = {
    docker: 'Container Engine',
    stalwart: 'Mail Server',
    // Issue #21 — `cloudflared` was previously labelled "Secure
    // Tunnel" and shown as ✅ whenever the binary was present.
    // The binary is downloaded as part of every setup (even
    // localhost-only evals), so the green tick implied an active
    // tunnel that didn't exist. Renamed to make clear we're only
    // reporting the CLI binary's presence; the actual tunnel
    // status is surfaced under "Email" below where the gateway
    // mode is read.
    cloudflared: 'Cloudflared CLI',
  };

  const deps = await setup.checkDependencies();
  log(`  ${c.bold('Services:')}`);
  for (const dep of deps) {
    // Issue #21 — only show cloudflared when the user has
    // actually configured a tunnel (domain mode). For
    // localhost-only / relay-only evals the binary is
    // background plumbing — listing it under "Services" with
    // a green ✅ misleads users into thinking a tunnel is up.
    if (dep.name === 'cloudflared') {
      const tunnelConfigured = await isTunnelConfigured();
      if (!tunnelConfigured) continue;
    }
    const friendly = FRIENDLY_NAMES[dep.name] ?? dep.name;
    if (dep.installed) {
      // Don't prefix "v" for non-semver versions like "running"
      const ver = dep.version && /^\d/.test(dep.version) ? `v${dep.version}` : dep.version;
      ok(`${c.bold(friendly)}${ver ? ` ${c.dim(ver)}` : ''}`);
    } else {
      fail(`${friendly} ${c.dim('— fix with: agenticmail setup')}`);
    }
  }
  log('');

  log(`  ${c.bold('Account:')}`);
  if (setup.isInitialized()) {
    ok('Set up and ready');
  } else {
    fail(`Not set up yet ${c.dim('— run: agenticmail setup')}`);
  }
  log('');

  // Read config for API host/port
  const configPath = join(homedir(), '.agenticmail', 'config.json');
  let apiHost = '127.0.0.1';
  let apiPort = 3829;
  let masterKey = process.env.AGENTICMAIL_MASTER_KEY;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      apiHost = config.api?.host || apiHost;
      apiPort = config.api?.port || apiPort;
      masterKey = masterKey || config.masterKey;
    } catch { /* ignore */ }
  }

  log(`  ${c.bold('Server:')}`);
  try {
    const response = await fetch(`http://${apiHost}:${apiPort}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      ok(`Running at ${c.cyan(`http://${apiHost}:${apiPort}`)}`);
    } else {
      fail('Server returned an error');
    }
  } catch {
    fail(`Not running ${c.dim('— start with: agenticmail start')}`);
  }

  log('');
  log(`  ${c.bold('Email:')}`);
  try {
    if (!masterKey) {
      info('Set AGENTICMAIL_MASTER_KEY env variable to see email status');
    } else {
      const response = await fetch(`http://${apiHost}:${apiPort}/api/agenticmail/gateway/status`, {
        headers: { 'Authorization': `Bearer ${masterKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const data = await response.json() as any;
        if (data.mode === 'relay' && data.relay) {
          ok(`Connected to ${c.bold(data.relay.email)} via ${data.relay.provider}`);
        } else if (data.mode === 'domain' && data.domain) {
          ok(`Using custom domain ${c.bold(data.domain.domain)}`);
        } else if (data.mode === 'none') {
          info('Not connected yet — run agenticmail setup to connect email');
        } else {
          ok(`Mode: ${c.bold(data.mode)}`);
        }
      }
    }
  } catch {
    info('Can\'t check email status — server isn\'t running');
  }

  log('');
  log(`  ${c.bold('Auto-Start:')}`);
  try {
    const svc = new ServiceManager();
    const svcStatus = svc.status();
    if (svcStatus.installed) {
      if (svcStatus.running) {
        ok(`Enabled ${c.dim(`(${svcStatus.platform}) — starts on boot`)}`);
      } else {
        ok(`Installed ${c.dim(`(${svcStatus.platform})`)} — ${c.yellow('not currently running')}`);
      }
    } else {
      fail(`Not installed ${c.dim('— run: agenticmail service install')}`);
    }
  } catch {
    info('Could not check auto-start status');
  }

  log('');
}

async function cmdStart() {
  const setup = new SetupManager();

  if (!setup.isInitialized()) {
    await cmdSetup();
    return;
  }

  log('');
  log(`  ${c.pinkBg(' 🎀 Starting AgenticMail ')}`);
  log('');

  // Load config
  const cfgPath = join(homedir(), '.agenticmail', 'config.json');
  let config: SetupConfig;
  try {
    config = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    fail('Could not read config. Run: agenticmail setup');
    process.exit(1);
  }

  // Docker — auto-install if missing, auto-start if stopped
  const dockerSpinner = new Spinner('docker', 'Checking engine...');
  dockerSpinner.start();
  // Wire progress from installer to spinner so users see real-time status
  const dockerSetup = new SetupManager((msg: string) => dockerSpinner.update(msg));
  try {
    await dockerSetup.ensureDocker();
    dockerSpinner.succeed('Engine is running');
  } catch (err) {
    dockerSpinner.fail((err as Error).message);
    process.exit(1);
  }

  // Stalwart
  const stalwartSpinner = new Spinner('stalwart', 'Waking up the mail server...');
  stalwartSpinner.start();
  try {
    await setup.ensureStalwart();
    stalwartSpinner.succeed('Mail server is ready');
  } catch (err) {
    stalwartSpinner.fail(`Mail server problem: ${(err as Error).message}`);
    process.exit(1);
  }

  // API server — start as background process (survives CLI exit)
  const serverSpinner = new Spinner('server', 'Launching your server...');
  serverSpinner.start();

  try {
    const ready = await startApiServer(config);
    if (ready) {
      serverSpinner.succeed(`Server running at ${c.cyan(`http://${config.api.host}:${config.api.port}`)}`);
    } else {
      serverSpinner.fail('Server did not start in time');
      process.exit(1);
    }
  } catch (err) {
    serverSpinner.fail(`Couldn't start the server: ${(err as Error).message}`);
    process.exit(1);
  }

  // Ensure auto-start service is installed AND healthy.
  //
  // Issue #26 — self-heal stale service artefacts on startup.
  // When users upgrade from the legacy unscoped `agenticmail` npm package
  // to the new `@agenticmail/cli`, the launchd plist and start-server.sh
  // wrapper that were written by the old install still reference paths
  // under `/opt/homebrew/lib/node_modules/agenticmail/...` — a directory
  // that no longer exists post-rename. The result is a boot-time crash
  // loop. We now ask ServiceManager whether the installed artefacts are
  // still valid (path resolves, version matches) and silently regenerate
  // them via reinstall() if not, printing a friendly notice so the user
  // knows it happened. Path resolution inside ServiceManager goes through
  // require.resolve('@agenticmail/api'), so the regenerated files follow
  // the *current* install location regardless of npm prefix or package
  // manager.
  try {
    const svc = new ServiceManager();
    const svcStatus = svc.status();
    if (!svcStatus.installed) {
      const svcResult = svc.install();
      if (svcResult.installed) {
        ok(`${c.bold('Auto-start')} enabled — survives reboots`);
      }
    } else {
      const repair = svc.needsRepair();
      if (repair) {
        info(`Auto-start service is stale (${repair.reason}); refreshing...`);
        const svcResult = svc.reinstall();
        if (svcResult.installed) {
          ok(`${c.bold('Auto-start')} refreshed for the new install path`);
        } else {
          info(`Could not refresh auto-start: ${svcResult.message}`);
        }
      }
    }
  } catch { /* don't fail start over this */ }

  // Check if setup is incomplete (no email/agent configured) — offer to continue
  try {
    const base = `http://${config.api.host}:${config.api.port}`;
    const gwResp = await fetch(`${base}/api/agenticmail/gateway/status`, {
      headers: { 'Authorization': `Bearer ${config.masterKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (gwResp.ok) {
      const gwStatus = await gwResp.json() as any;
      if (gwStatus.mode === 'none' || !gwStatus.mode) {
        log('');
        log(`  ${c.dim('─'.repeat(50))}`);
        log('');
        log(`  ${c.yellow('!')} No email connected yet. Your agent can't send or receive email.`);
        log('');
        const finish = await ask(`  Run the setup wizard to finish? (Y/n) `);
        if (!finish.toLowerCase().startsWith('n')) {
          await cmdSetup();
          return;
        }
      }
    }
  } catch { /* server may not be ready — skip check */ }

  // Interactive prompt — server keeps running in background after exit
  await interactiveShell({ config, onExit: () => {} });
}

/**
 * Best-effort: terminate the Telegram bridge if its PID file points
 * at a live process. Called from both `cmdStop` and the uninstall
 * cleanup so the bridge does not outlive its companion API server.
 */
function stopTelegramBridge(): boolean {
  try {
    const tgDir = join(homedir(), '.agenticmail', 'telegram');
    const pidFile = join(tgDir, 'bridge.pid');
    if (!existsSync(pidFile)) return false;
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid) || pid <= 0) return false;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

async function cmdStop() {
  log('');
  const stopped = stopApiServer();
  // Stop the Telegram bridge too — it was started by `agenticmail
  // start`, so `agenticmail stop` should reverse that.
  stopTelegramBridge();

  // Also stop the launchd/systemd managed process if running
  const svc = new ServiceManager();
  const svcStatus = svc.status();
  if (svcStatus.installed && svcStatus.running) {
    try {
      if (svcStatus.platform === 'launchd') {
        const { execFileSync } = await import('node:child_process');
        execFileSync('launchctl', ['unload', svcStatus.servicePath!], { timeout: 10_000, stdio: 'ignore' });
        // Re-load but don't start (keeps the service installed for next boot)
      } else if (svcStatus.platform === 'systemd') {
        const { execFileSync } = await import('node:child_process');
        execFileSync('systemctl', ['--user', 'stop', 'agenticmail.service'], { timeout: 10_000, stdio: 'ignore' });
      }
    } catch { /* ignore */ }
  }

  if (stopped || (svcStatus.installed && svcStatus.running)) {
    ok('AgenticMail server stopped');
    if (svcStatus.installed) {
      info('Auto-start is still enabled. It will restart on next boot.');
      info(`To disable: ${c.green('agenticmail service uninstall')}`);
    }
  } else {
    info('Server is not running');
  }
  log('');
}

/**
 * `agenticmail tunnel {start|stop|status|url}` — public-URL tunnel
 * for the local API server, so providers that need to webhook into
 * this machine (Twilio, 46elks, Telegram-webhook-mode) can actually
 * reach it from the public internet.
 *
 * Uses Cloudflare's free "quick tunnel" (`cloudflared tunnel --url
 * http://127.0.0.1:<port>`) — no Cloudflare account, no signup, no
 * domain, no DNS setup. The tunnel publishes a random
 * `*.trycloudflare.com` hostname that's stable for the lifetime of
 * the cloudflared process. Cloudflared is already auto-installed
 * by `agenticmail bootstrap` (at `~/.agenticmail/bin/cloudflared`)
 * or picked up from the system PATH if the user has it via Homebrew.
 *
 * State lives at `~/.agenticmail/tunnel.json` (`{pid, url, port,
 * startedAt}`) so `setup-phone` and `setup-telegram` can read the
 * URL without re-running the tunnel.
 *
 * Subcommands:
 *
 *   agenticmail tunnel start    Spawn cloudflared, capture URL, save
 *                                state, print the URL. No-op if a
 *                                tunnel is already running.
 *   agenticmail tunnel status   Show current URL + pid + uptime.
 *   agenticmail tunnel url      Print only the URL (for piping into
 *                                env vars, e.g.
 *                                `AGENTICMAIL_WEBHOOK_URL=$(agenticmail tunnel url)`).
 *   agenticmail tunnel stop     Kill the tunnel process, clear state.
 */
async function cmdTunnel() {
  const subCmd = process.argv[3] || 'status';
  const tunnelStateFile = join(homedir(), '.agenticmail', 'tunnel.json');

  const readState = (): { pid?: number; url?: string; port?: number; startedAt?: string } => {
    try { return JSON.parse(readFileSync(tunnelStateFile, 'utf-8')); }
    catch { return {}; }
  };
  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  };
  const printUrl = () => {
    const state = readState();
    if (state.pid && state.url && isAlive(state.pid)) console.log(state.url);
    else process.exit(1);
  };

  switch (subCmd) {
    case 'url': printUrl(); return;

    case 'status': {
      log('');
      const state = readState();
      if (state.pid && state.url && isAlive(state.pid)) {
        ok(`Tunnel running ${c.dim('(pid ' + state.pid + ')')}`);
        log(`  ${c.dim('URL:')}    ${c.cyan(state.url)}`);
        log(`  ${c.dim('Local:')}  http://127.0.0.1:${state.port ?? '?'}`);
        if (state.startedAt) log(`  ${c.dim('Up:')}     ${state.startedAt}`);
      } else {
        info(`Tunnel not running. Start with ${c.green('agenticmail tunnel start')}.`);
      }
      log('');
      return;
    }

    case 'stop': {
      log('');
      const state = readState();
      if (state.pid && isAlive(state.pid)) {
        try { process.kill(state.pid, 'SIGTERM'); } catch { /* already dead */ }
        ok(`Tunnel stopped ${c.dim('(was pid ' + state.pid + ')')}`);
      } else {
        info('Tunnel was not running.');
      }
      try { unlinkSync(tunnelStateFile); } catch { /* ignore */ }
      log('');
      return;
    }

    case 'start': {
      log('');
      const existing = readState();
      if (existing.pid && existing.url && isAlive(existing.pid)) {
        ok('Tunnel already running');
        log(`  ${c.dim('URL:')} ${c.cyan(existing.url)}`);
        log('');
        return;
      }

      // Need the API port to point cloudflared at. Read it from config.
      const configPath = join(homedir(), '.agenticmail', 'config.json');
      if (!existsSync(configPath)) {
        fail(`AgenticMail isn't set up yet — no config at ${c.dim(configPath)}`);
        info(`Run ${c.cyan('agenticmail setup')} first.`);
        process.exit(1);
      }
      let config: SetupConfig;
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')) as SetupConfig; }
      catch (err) { fail(`Could not read ${configPath}: ${(err as Error).message}`); process.exit(1); }
      const port = config.api.port;

      // Resolve the cloudflared binary — managed first (lives under
      // ~/.agenticmail/bin after `agenticmail bootstrap` ran the
      // CloudflaredInstaller), then system PATH (Homebrew etc).
      const managedBin = join(homedir(), '.agenticmail', 'bin', 'cloudflared');
      let bin = existsSync(managedBin) ? managedBin : '';
      if (!bin) {
        try {
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync('which', ['cloudflared'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          if (out) bin = out;
        } catch { /* not on PATH */ }
      }
      if (!bin) {
        fail('cloudflared not found.');
        info(`Run ${c.green('agenticmail bootstrap')} (auto-installs cloudflared), or install it yourself:`);
        info(`  ${c.dim('macOS:')}  brew install cloudflared`);
        info(`  ${c.dim('Linux:')}  https://github.com/cloudflare/cloudflared/releases`);
        process.exit(1);
      }

      const { spawn: sp } = await import('node:child_process');
      const spinner = new Spinner('general', `Starting Cloudflare tunnel via ${c.dim(bin)}...`);
      spinner.start();

      // Quick-tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>`.
      // No `--config` (would inherit a stale named-tunnel config from
      // earlier setup); explicitly `--config /dev/null` so even a
      // pre-existing ~/.cloudflared/config.yml can't hijack the flags.
      const child = sp(bin, ['tunnel', '--no-autoupdate', '--config', '/dev/null', '--url', `http://127.0.0.1:${port}`], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      // cloudflared prints the assigned trycloudflare.com URL to stderr
      // within ~5 seconds of startup. Capture from BOTH streams (line
      // ordering varies by cloudflared version) and resolve as soon as
      // we see the URL.
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          spinner.fail('Tunnel did not return a URL within 30s');
          try { child.kill('SIGTERM'); } catch {}
          reject(new Error('timeout'));
        }, 30_000);
        const onChunk = (chunk: Buffer) => {
          const text = chunk.toString();
          const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (m) { clearTimeout(timer); resolve(m[0]); }
        };
        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited code=${code}`)); });
      }).catch((err) => { spinner.fail(`Tunnel failed: ${(err as Error).message}`); process.exit(1); });

      // Detach so cloudflared survives this CLI process. We've already
      // captured the URL, so we don't need to keep listening to its
      // output — `child.unref()` lets Node exit even though the child
      // is still alive (it's now a true background daemon).
      child.unref();

      const state = {
        pid: child.pid,
        url,
        port,
        startedAt: new Date().toISOString(),
      };
      try {
        mkdirSync(dirname(tunnelStateFile), { recursive: true });
        writeFileSync(tunnelStateFile, JSON.stringify(state, null, 2));
      } catch (err) {
        // The tunnel IS running — losing the state file just means
        // future `tunnel status` / `setup-phone` won't auto-find it.
        info(`Could not persist tunnel state: ${(err as Error).message}`);
      }

      spinner.succeed(`Tunnel ready ${c.dim('(pid ' + child.pid + ')')}`);
      log(`  ${c.dim('URL:')}    ${c.cyan(url)}`);
      log(`  ${c.dim('Local:')}  http://127.0.0.1:${port}`);
      log('');
      info(`Use this URL as your webhook target — e.g. ${c.green('AGENTICMAIL_WEBHOOK_URL=' + url)}`);
      info(`Or pipe directly:  ${c.green('AGENTICMAIL_WEBHOOK_URL=$(agenticmail tunnel url)')}`);
      log('');
      return;
    }

    default:
      log('');
      fail(`Unknown subcommand: ${subCmd}`);
      info(`Try: ${c.green('agenticmail tunnel {start|stop|status|url}')}`);
      log('');
      process.exit(1);
  }
}

async function cmdService() {
  const subCmd = process.argv[3] || 'status';
  const svc = new ServiceManager();

  log('');

  switch (subCmd) {
    case 'install': {
      const result = svc.install();
      if (result.installed) {
        ok(`Auto-start service installed`);
        info(result.message);
        info('AgenticMail will now start automatically when your computer boots.');
      } else {
        fail(result.message);
      }
      break;
    }
    case 'uninstall':
    case 'remove': {
      const result = svc.uninstall();
      if (result.removed) {
        ok('Auto-start service removed');
        info('AgenticMail will no longer start on boot.');
      } else {
        fail(result.message);
      }
      break;
    }
    case 'reinstall': {
      const result = svc.reinstall();
      if (result.installed) {
        ok('Auto-start service reinstalled');
        info(result.message);
      } else {
        fail(result.message);
      }
      break;
    }
    case 'status':
    default: {
      const status = svc.status();
      log(`  ${c.bold('Auto-Start Service')}`);
      log('');
      if (status.installed) {
        ok(`Installed ${c.dim(`(${status.platform})`)}`);
        if (status.running) {
          ok(`Running`);
        } else {
          fail(`Not running ${c.dim('— will start on next boot or: agenticmail service reinstall')}`);
        }
        info(`Service file: ${status.servicePath}`);
      } else {
        fail('Not installed');
        info(`Install with: ${c.green('agenticmail service install')}`);
      }
      break;
    }
  }

  log('');
}

async function cmdUpdate() {
  const { execSync } = await import('node:child_process');

  log('');
  log(`  ${c.dim('─'.repeat(50))}`);
  log(`  ${c.bold('Update AgenticMail')}`);
  log('');

  // Current version
  let currentVersion = 'unknown';
  try {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(thisDir, '..', 'package.json'), 'utf-8'));
    currentVersion = pkg.version ?? 'unknown';
  } catch {}
  info(`Current version: ${c.bold(currentVersion)}`);

  // Latest version. The package was renamed to @agenticmail/cli in 0.7.x;
  // the unscoped `agenticmail` package on npm is now a 1.6 KB redirect
  // stub. Always query the scoped name so this code keeps working
  // regardless of which package the user originally installed from.
  let latestVersion = 'unknown';
  try {
    latestVersion = execSync('npm view @agenticmail/cli version', { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    fail('Could not check npm. Check your internet connection.');
    process.exit(1);
  }
  info(`Latest version:  ${c.bold(latestVersion)}`);

  if (currentVersion === latestVersion) {
    ok('Already on the latest version!');
    log('');
    process.exit(0);
  }

  info(`New version available: ${c.yellow(currentVersion)} → ${c.green(latestVersion)}`);
  log('');

  // OpenClaw compatibility check
  let hasOpenClaw = false;
  try {
    execSync('which openclaw', { stdio: 'ignore', timeout: 5000 });
    hasOpenClaw = true;
    const ocVersion = execSync('openclaw --version 2>/dev/null || echo "?"', { encoding: 'utf-8', timeout: 10000 }).trim();
    info(`OpenClaw detected: ${c.bold(ocVersion)}`);
  } catch {}

  // Detect package manager
  let pm = 'npm';
  try { execSync('pnpm --version', { stdio: 'ignore', timeout: 5000 }); pm = 'pnpm'; } catch {
    try { execSync('bun --version', { stdio: 'ignore', timeout: 5000 }); pm = 'bun'; } catch {}
  }

  // Global or local? Detect by querying the scoped name. We also check
  // the unscoped name as a fallback so users who installed back when
  // the package was just `agenticmail` (pre-0.7) still get a clean
  // upgrade path — we'll install the new scoped one and they can
  // `npm uninstall -g agenticmail` to remove the deprecated alias.
  let isGlobal = false;
  try {
    const list = execSync(`npm list -g @agenticmail/cli 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 });
    if (list.includes('@agenticmail/cli@')) isGlobal = true;
  } catch {}
  if (!isGlobal) {
    try {
      const list = execSync(`npm list -g agenticmail 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 });
      // Unscoped install detected — install the scoped one globally.
      if (list.includes('agenticmail@')) isGlobal = true;
    } catch {}
  }

  const scope = isGlobal ? '-g' : '';
  const installCmd = pm === 'bun'
    ? `bun add ${scope} @agenticmail/cli@latest`.trim()
    : `${pm} install ${scope} @agenticmail/cli@latest`.trim();

  info(`Running: ${c.dim(installCmd)}`);
  try {
    execSync(installCmd, { stdio: 'inherit', timeout: 120000 });
    ok(`Updated to @agenticmail/cli@${latestVersion}`);
  } catch (err) {
    fail(`Update failed: ${(err as Error).message}`);
    info(`Try: ${c.green('npm install -g @agenticmail/cli@latest')}`);
    process.exit(1);
  }

  // Update OpenClaw plugin too
  if (hasOpenClaw) {
    const pluginCmd = pm === 'bun'
      ? `bun add ${scope} @agenticmail/openclaw@latest`.trim()
      : `${pm} install ${scope} @agenticmail/openclaw@latest`.trim();
    info(`Updating OpenClaw plugin: ${c.dim(pluginCmd)}`);
    try {
      execSync(pluginCmd, { stdio: 'inherit', timeout: 120000 });
      ok('OpenClaw plugin updated.');
      try {
        execSync('openclaw gateway restart', { stdio: 'pipe', timeout: 30000 });
        ok('OpenClaw gateway restarted.');
      } catch {
        info(`Restart OpenClaw: ${c.green('openclaw gateway restart')}`);
      }
    } catch {
      info(`Update plugin manually: ${c.green(pluginCmd)}`);
    }
  }

  log('');
  ok('Update complete!');
  log('');
}

// --- Main ---

const command = process.argv[2];

// Sub-command sugar: `agenticmail setup phone` / `setup email` /
// `setup telegram` are routed to their dedicated `setup-<x>` handlers
// rather than to the full `setup` wizard. Without this, a user
// remembering "the command starts with setup" and following with the
// channel name kept hitting the full 9-step wizard, missing the
// channel-specific flow entirely. Pop the second argv slot for the
// dispatch so the downstream handlers see no extra arg.
if (command === 'setup' && typeof process.argv[3] === 'string') {
  const sub = process.argv[3].toLowerCase();
  const subMap: Record<string, string> = {
    email: 'setup-email', mail: 'setup-email', relay: 'setup-relay',
    phone: 'setup-phone', twilio: 'setup-phone', '46elks': 'setup-phone',
    telegram: 'setup-telegram',
    anthropic: 'setup-anthropic', claude: 'setup-anthropic', token: 'setup-anthropic',
  };
  if (subMap[sub]) {
    process.argv.splice(3, 1);             // remove the sub-word
    process.argv[2] = subMap[sub];          // rewrite the command
  }
}

switch (process.argv[2]) {
  case 'setup':
    cmdSetup().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'setup-relay':
  case 'relay':
    cmdSetupRelay().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'setup-email':
  case 'email':
  case 'connect-email':
    cmdSetupEmail().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'setup-phone':
  case 'phone':
  case 'setup-twilio':
  case 'setup-46elks':
    cmdSetupPhone().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'setup-telegram':
  case 'telegram':
    cmdSetupTelegram().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'setup-anthropic':
  case 'setup-claude':
  case 'setup-token':
  case 'anthropic':
    cmdSetupAnthropic().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'tunnel':
    cmdTunnel().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'start':
    cmdStart().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'stop':
    cmdStop().then(() => { process.exit(0); }).catch(err => { console.error(err); process.exit(1); });
    break;
  case 'status':
    cmdStatus().then(() => { process.exit(0); }).catch(err => { console.error(err); process.exit(1); });
    break;
  case 'openclaw':
    cmdOpenClaw().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'claudecode':
  case 'claude-code':
  case 'claude':
    cmdClaudeCode().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'bootstrap':
  case 'quickstart':
    cmdBootstrap().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'service':
    cmdService().then(() => { process.exit(0); }).catch(err => { console.error(err); process.exit(1); });
    break;
  case 'update':
    cmdUpdate().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'web':
  case 'ui':
    cmdWeb().then(() => { process.exit(0); }).catch(err => { console.error(err); process.exit(1); });
    break;
  case '--version':
  case '-v':
  case 'version': {
    // Issue #25 — `agenticmail --version` previously fell through
    // to the default case and launched the server start flow.
    // Read the version straight out of package.json so it stays
    // in sync with the published artifact, then exit.
    try {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(thisDir, '..', 'package.json'), 'utf-8'));
      console.log(pkg.version ?? 'unknown');
    } catch {
      console.log('unknown');
    }
    process.exit(0);
  }
  case 'help':
  case '--help':
  case '-h':
    log('');
    log(`  ${c.pinkBg(' 🎀 AgenticMail ')} ${c.dim('Give your AI agent a real email address')}`);
    log('');
    log('  Commands:');
    log(`    ${c.green('agenticmail')}           Get started (setup + start)`);
    log(`    ${c.green('agenticmail bootstrap')} ${c.dim('Zero-question install — for AI agents (Claude Code) to run on a user\'s behalf')}`);
    log(`    ${c.green('agenticmail setup')}     Re-run the setup wizard ${c.dim('(use --yes for non-interactive)')}`);
    log(`    ${c.green('agenticmail setup-email')}  Connect your mailbox — just email + password ${c.dim('(auto-detects Gmail/Outlook/custom)')}`);
    log(`    ${c.green('agenticmail setup-phone')}  Connect Twilio / 46elks for outbound calls ${c.dim('(--account-sid + --auth-token, or env vars)')}`);
    log(`    ${c.green('agenticmail setup-anthropic')} Generate / save Anthropic OAuth token ${c.dim('(wraps `claude setup-token`)')}`);
    log(`    ${c.green('agenticmail setup-telegram')}  Wire up the Telegram bridge ${c.dim('(--bot-token + --chat-id, or env vars)')}`);
    log(`    ${c.green('agenticmail tunnel')}     Public HTTPS tunnel to your local API ${c.dim('(free Cloudflare quick-tunnel; needed for Twilio webhooks)')}`);
    log(`    ${c.green('agenticmail start')}     Start the server`);
    log(`    ${c.green('agenticmail stop')}      Stop the server`);
    log(`    ${c.green('agenticmail status')}    See what's running`);
    log(`    ${c.green('agenticmail shell')}     Drop into the interactive REPL (44 commands)`);
    log(`    ${c.green('agenticmail web')}       Open the Gmail-style web UI in your browser`);
    log(`    ${c.green('agenticmail openclaw')}  Set up AgenticMail for OpenClaw`);
    log(`    ${c.green('agenticmail claudecode')} Set up AgenticMail for Claude Code`);
    log(`    ${c.green('agenticmail service')}   Manage auto-start (install/uninstall/status)`);
    log(`    ${c.green('agenticmail update')}    Update to the latest version`);
    log('');
    process.exit(0);
  default:
    // No arguments = the main entry point
    cmdStart().catch(err => { console.error(err); process.exit(1); });
    break;
}
