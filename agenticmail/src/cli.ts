#!/usr/bin/env node

import { createInterface, emitKeypressEvents } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import {
  SetupManager,
  type RelayProvider,
  type SetupConfig,
} from '@agenticmail/core';
import { interactiveShell } from './shell.js';

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
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  bgGreen: (s: string) => `\x1b[42m\x1b[30m${s}\x1b[0m`,
  bgCyan: (s: string) => `\x1b[46m\x1b[30m${s}\x1b[0m`,
};

function log(msg: string) { console.log(msg); }
function ok(msg: string) { console.log(`  ${c.green('✓')} ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red('✗')} ${msg}`); }
function info(msg: string) { console.log(`  ${c.dim(msg)}`); }

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

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private msgIdx = 0;
  private msgChangeCounter = 0;
  private category: string;
  private currentMsg: string;

  constructor(category: string, initialMsg?: string) {
    this.category = category;
    const msgs = LOADING_MESSAGES[category] ?? LOADING_MESSAGES.general;
    this.currentMsg = initialMsg ?? msgs[0];
  }

  start(): void {
    this.frameIdx = 0;
    this.msgIdx = 0;
    this.msgChangeCounter = 0;
    const msgs = LOADING_MESSAGES[this.category] ?? LOADING_MESSAGES.general;

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length];
      process.stdout.write(`\r  ${c.cyan(frame)} ${c.yellow(this.currentMsg)}\x1b[K`);
      this.frameIdx++;
      this.msgChangeCounter++;
      // Change message every ~3 seconds (30 ticks at 100ms)
      if (this.msgChangeCounter >= 30) {
        this.msgChangeCounter = 0;
        this.msgIdx = (this.msgIdx + 1) % msgs.length;
        this.currentMsg = msgs[this.msgIdx];
      }
    }, 100);
  }

  update(msg: string): void {
    this.currentMsg = msg;
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
  return {
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

// --- Track child processes for cleanup ---
let apiChild: import('node:child_process').ChildProcess | null = null;

function cleanupChild() {
  if (apiChild) {
    apiChild.kill();
    apiChild = null;
  }
}

process.on('exit', cleanupChild);
process.on('SIGINT', () => { cleanupChild(); process.exit(0); });
process.on('SIGTERM', () => { cleanupChild(); process.exit(0); });

// --- Commands ---

async function cmdSetup() {
  log('');
  log(`  ${c.bgCyan(' AgenticMail Setup ')}`);
  log('');
  log(`  ${c.bold('Welcome!')} We're going to set up everything your AI agent`);
  log(`  needs to send and receive real email.`);
  log('');
  const hasOpenClaw = existsSync(join(homedir(), '.openclaw', 'openclaw.json'));
  const totalSteps = hasOpenClaw ? 5 : 4;

  log(`  Here's what we'll do:`);
  log(`    ${c.dim('1.')} Check your system for required tools`);
  log(`    ${c.dim('2.')} Create your private account and keys`);
  log(`    ${c.dim('3.')} Start the mail server`);
  log(`    ${c.dim('4.')} Connect your email`);
  if (hasOpenClaw) log(`    ${c.dim('5.')} Configure OpenClaw integration`);
  log('');
  await pick(`  ${c.magenta('Press any key to get started...')} `, [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    'a','b','c','d','e','f','g','h','i','j','k','l','m',
    'n','o','p','q','r','s','t','u','v','w','x','y','z',
    ' ', '\r', '\n',
  ]);
  log('');

  const setup = new SetupManager();

  // Step 1: System check
  log(`  ${c.bold(`Step 1 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Checking your system')}`);
  log('');

  const deps = await setup.checkDependencies();

  const FRIENDLY: Record<string, { name: string; desc: string }> = {
    docker: { name: 'Docker', desc: 'runs the mail server' },
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
      fail(`${c.bold(f.name)} ${c.dim('— ' + f.desc + ' (will install)')}`);
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
    try {
      await setup.ensureDocker();
      spinner.succeed(`${c.bold('Docker')} — engine running`);
    } catch (err) {
      spinner.fail(`Couldn't start Docker: ${(err as Error).message}`);
      log('');
      log(`  ${c.yellow('Tip:')} Install Docker manually from ${c.cyan('https://docker.com/get-docker')}`);
      log(`  ${c.dim('Then run')} ${c.green('agenticmail setup')} ${c.dim('again.')}`);
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Start Stalwart mail server container
  const stalwart = deps.find(d => d.name === 'stalwart');
  if (!stalwart?.installed) {
    const spinner = new Spinner('stalwart');
    spinner.start();
    try {
      await setup.ensureStalwart();
      spinner.succeed(`${c.bold('Mail Server')} — up and running!`);
    } catch (err) {
      spinner.fail(`Couldn't start the mail server: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    ok(`${c.bold('Mail Server')} ${c.dim('— already running')}`);
    await new Promise(r => setTimeout(r, 300));
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

  // Start the API server first (needed to check gateway status + email config)
  const serverSpinner = new Spinner('server', 'Starting the server...');
  serverSpinner.start();

  let serverReady = false;

  // Check if server is already running (leftover from previous session)
  try {
    const probe = await fetch(`http://${result.config.api.host}:${result.config.api.port}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (probe.ok) serverReady = true;
  } catch { /* not running */ }

  if (serverReady) {
    serverSpinner.succeed(`Server already running at ${c.cyan(`http://${result.config.api.host}:${result.config.api.port}`)}`);
  } else {
    try {
      const { fork } = await import('node:child_process');
      const apiEntry = resolveApiEntry();
      const env = configToEnv(result.config);

      apiChild = fork(apiEntry, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });

      const stderrLines: string[] = [];
      apiChild.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().trim().split('\n');
        for (const line of lines) {
          stderrLines.push(line);
          if (stderrLines.length > 50) stderrLines.shift();
        }
      });
      apiChild.on('exit', (code, signal) => {
        apiChild = null;
        log('');
        fail(`Server stopped unexpectedly${signal ? ` (signal: ${signal})` : code ? ` (exit code: ${code})` : ''}`);
        if (stderrLines.length > 0) {
          log('');
          log(`  ${c.dim('Last server output:')}`);
          for (const line of stderrLines.slice(-10)) {
            log(`  ${c.dim(line)}`);
          }
        }
        log('');
        process.exit(code ?? 1);
      });

      serverReady = await waitForApi(result.config.api.host, result.config.api.port);
      if (serverReady) {
        serverSpinner.succeed(`Server running at ${c.cyan(`http://${result.config.api.host}:${result.config.api.port}`)}`);
      } else {
        serverSpinner.fail('Server did not start in time');
      }
    } catch (err) {
      serverSpinner.fail(`Could not start server: ${(err as Error).message}`);
    }
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
    const existChoice = await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);
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
    choice = await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);
  }
  log('');

  if (choice === '1' || choice === '2') {
    if (!serverReady) {
      info('You can configure email later by running: agenticmail setup');
      cleanupChild();
      printSummary(result, true);
      return;
    }

    log('');
    if (choice === '1') {
      await setupRelay(result.config);
    } else {
      await setupDomain(result.config);
    }
  } else if (!existingEmail) {
    info('No problem! You can set up email anytime by running this again.');
  }

  // Step 5: OpenClaw integration (only if detected)
  if (hasOpenClaw && serverReady) {
    log('');
    log(`  ${c.bold(`Step 5 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Configure OpenClaw integration')}`);
    log('');
    await registerWithOpenClaw(result.config);
  }

  printSummary(result, false);

  // Drop into the interactive shell with the server still running
  if (serverReady) {
    await interactiveShell({ config: result.config, onExit: cleanupChild });
  }
}

function printSummary(result: { configPath: string; config: SetupConfig }, exitAfter: boolean) {
  log('');
  log(`  ${c.bgGreen(' You\'re all set! ')}`);
  log('');
  log(`  Here are your details (save these somewhere safe):`);
  log('');
  log(`  ${c.dim('Your secret key:')}  ${c.yellow(result.config.masterKey)}`);
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

/**
 * If OpenClaw is installed, register the AgenticMail plugin automatically.
 * Writes to ~/.openclaw/openclaw.json so OpenClaw discovers AgenticMail on next start.
 */
async function registerWithOpenClaw(config: SetupConfig): Promise<void> {
  const openclawConfig = join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(openclawConfig)) return; // OpenClaw not installed

  try {
    const raw = readFileSync(openclawConfig, 'utf8');
    const ocConfig = JSON.parse(raw);

    // Check if already registered
    if (ocConfig.plugins?.entries?.agenticmail?.config?.apiKey) {
      ok(`OpenClaw integration already configured`);
      return;
    }

    // Find where @agenticmail/openclaw is installed
    let pluginPath: string | null = null;
    try {
      const resolved = import.meta.resolve('@agenticmail/openclaw');
      const resolvedPath = fileURLToPath(resolved);
      // Go up from dist/index.js to the package root
      pluginPath = dirname(dirname(resolvedPath));
    } catch { /* not resolvable via import.meta */ }

    if (!pluginPath) {
      // Walk up from this script to find node_modules/@agenticmail/openclaw
      const thisDir = dirname(fileURLToPath(import.meta.url));
      let dir = thisDir;
      for (let i = 0; i < 10; i++) {
        const candidate = join(dir, 'node_modules', '@agenticmail', 'openclaw');
        if (existsSync(join(candidate, 'package.json'))) { pluginPath = candidate; break; }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    if (!pluginPath) {
      // Check global npm prefix
      try {
        const { execSync } = await import('node:child_process');
        const prefix = execSync('npm prefix -g', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const globalCandidate = join(prefix, 'lib', 'node_modules', '@agenticmail', 'openclaw');
        if (existsSync(join(globalCandidate, 'package.json'))) pluginPath = globalCandidate;
        if (!pluginPath) {
          const globalCandidate2 = join(prefix, 'node_modules', '@agenticmail', 'openclaw');
          if (existsSync(join(globalCandidate2, 'package.json'))) pluginPath = globalCandidate2;
        }
      } catch { /* ignore */ }
    }

    if (!pluginPath) return; // @agenticmail/openclaw not installed, skip silently

    // Resolve symlinks to get the real path
    try { pluginPath = realpathSync(pluginPath); } catch { /* keep as-is */ }

    // Get an agent API key from the running server
    let apiKey = '';
    try {
      const base = `http://${config.api.host}:${config.api.port}`;
      const resp = await fetch(`${base}/api/agenticmail/accounts`, {
        headers: { 'Authorization': `Bearer ${config.masterKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const agents = data.agents || data || [];
        if (agents.length > 0) {
          apiKey = agents[0].apiKey;
        }
      }
    } catch { /* ignore */ }

    if (!apiKey) return; // No agents yet, can't configure

    // Build the plugin config
    if (!ocConfig.plugins) ocConfig.plugins = {};
    if (!ocConfig.plugins.load) ocConfig.plugins.load = {};
    if (!ocConfig.plugins.load.paths) ocConfig.plugins.load.paths = [];
    if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};

    // Add plugin path if not already present
    if (!ocConfig.plugins.load.paths.includes(pluginPath)) {
      ocConfig.plugins.load.paths.push(pluginPath);
    }

    // Add plugin entry
    ocConfig.plugins.entries.agenticmail = {
      enabled: true,
      config: {
        apiUrl: `http://${config.api.host}:${config.api.port}`,
        apiKey,
        masterKey: config.masterKey,
      },
    };

    writeFileSync(openclawConfig, JSON.stringify(ocConfig, null, 2) + '\n', 'utf8');
    ok(`OpenClaw config updated: ${c.cyan(openclawConfig)}`);
    if (pluginPath) ok(`Plugin found: ${c.cyan(pluginPath)}`);

    // Restart OpenClaw gateway so it picks up the plugin immediately
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
        execSync('openclaw gateway restart', { stdio: 'pipe', timeout: 30_000 });
        restartSpinner.succeed('OpenClaw gateway restarted');
      } catch {
        restartSpinner.fail('Gateway restart failed');
        log(`    Run manually: ${c.green('openclaw gateway restart')}`);
      }
    } else {
      info(`Restart OpenClaw to pick up the changes: ${c.green('openclaw gateway restart')}`);
    }
  } catch {
    // Don't fail setup if OpenClaw integration fails
  }
}

async function setupRelay(config: SetupConfig) {
  log('  Which email service do you use?');
  log(`    ${c.cyan('1.')} Gmail`);
  log(`    ${c.cyan('2.')} Outlook / Hotmail`);
  log(`    ${c.cyan('3.')} Something else`);
  const provChoice = await pick(`  ${c.magenta('>')} `, ['1', '2', '3']);

  let provider: RelayProvider;
  if (provChoice === '1') provider = 'gmail';
  else if (provChoice === '2') provider = 'outlook';
  else provider = 'custom';

  const email = await ask(`  ${c.cyan('Your email address:')} `);

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

  let smtpHost: string | undefined;
  let smtpPort: number | undefined;
  let imapHost: string | undefined;
  let imapPort: number | undefined;

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
  const name = agentName.trim() || 'secretary';

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
          provider, email, password,
          smtpHost, smtpPort, imapHost, imapPort,
          agentName: name,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const text = await response.text();
        // Parse error for friendly messages
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
        return;
      }

      const data = await response.json() as any;
      spinner.succeed('Email connected!');

      if (data.agent) {
        log('');
        ok(`Your AI agent ${c.bold('"' + data.agent.name + '"')} is ready!`);
        log(`    ${c.dim('Agent email:')} ${c.cyan(data.agent.subAddress)}`);
        log(`    ${c.dim('Agent key:')}   ${c.yellow(data.agent.apiKey)}`);
        log('');
        info('People can email your agent at the address above.');

        // Send welcome email to the user
        await sendWelcomeEmail(apiBase, data.agent.apiKey, email, data.agent.name, data.agent.subAddress);
      }
      return; // success — exit retry loop
    } catch (err) {
      spinner.fail(`Couldn't connect: ${(err as Error).message}`);
      return;
    }
  }
}

/**
 * Parse API error responses into user-friendly messages.
 */
function parseFriendlyError(rawText: string): { message: string; isAuthError: boolean } {
  try {
    const parsed = JSON.parse(rawText);
    const error = parsed.error || rawText;

    // Auth / password errors
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
  // Strategy 1: Walk up from CLI binary to find node_modules/@agenticmail/openclaw
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', '@agenticmail', 'openclaw');
    if (existsSync(join(candidate, 'openclaw.plugin.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Strategy 2: Relative to CLI binary (monorepo layout — dist/ or src/)
  const candidates = [
    join(thisDir, '..', '..', 'packages', 'openclaw'),
    join(thisDir, '..', 'packages', 'openclaw'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'openclaw.plugin.json'))) return p;
  }

  // Strategy 3: Check global npm prefix
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@agenticmail/openclaw/openclaw.plugin.json');
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
 * Preserves all existing settings — adds/updates plugins.entries.agenticmail
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

  const existingEntry = existing?.plugins?.entries?.agenticmail;
  if (existingEntry) {
    // Preserve user's custom settings, update keys
    pluginConfig.apiUrl = pluginConfig.apiUrl || existingEntry.config?.apiUrl;
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
        agenticmail: {
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

async function cmdOpenClaw() {
  log('');
  log(`  ${c.bgCyan(' AgenticMail for OpenClaw ')}`);
  log('');
  log(`  ${c.bold("Let's get your OpenClaw agent set up with email.")}`);
  log(`  This will:`);
  log(`    ${c.dim('1.')} Set up the mail server infrastructure`);
  log(`    ${c.dim('2.')} Create an agent email account`);
  log(`    ${c.dim('3.')} Configure the OpenClaw plugin`);
  log(`    ${c.dim('4.')} Restart the OpenClaw gateway`);
  log('');

  const setup = new SetupManager();

  // ── Step 1: Infrastructure ──────────────────────────────────────
  log(`  ${c.bold('Step 1 of 5')} ${c.dim('—')} ${c.bold('Checking infrastructure')}`);
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
        spinner.succeed(`${c.bold('Docker')} — installed and running`);
      } catch (err) {
        spinner.fail(`Couldn't install Docker: ${(err as Error).message}`);
        log('');
        log(`  ${c.yellow('Tip:')} Install Docker manually from ${c.cyan('https://docker.com/get-docker')}`);
        log(`  ${c.dim('Then run')} ${c.green('agenticmail openclaw')} ${c.dim('again.')}`);
        process.exit(1);
      }
    } else {
      ok(`${c.bold('Docker')} ${c.dim('— engine running')}`);
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
  log(`  ${c.bold('Step 2 of 5')} ${c.dim('—')} ${c.bold('Starting server')}`);
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
      const { fork } = await import('node:child_process');
      const apiEntry = resolveApiEntry();
      const env = configToEnv(config);
      apiChild = fork(apiEntry, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });

      apiChild.on('exit', () => { apiChild = null; });

      const ready = await waitForApi(apiHost, apiPort);
      if (!ready) {
        serverSpinner.fail('Server did not start in time');
        cleanupChild();
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
  log(`  ${c.bold('Step 3 of 5')} ${c.dim('—')} ${c.bold('Agent account')}`);
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

  // ── Step 4: Configure OpenClaw ──────────────────────────────────
  log(`  ${c.bold('Step 4 of 5')} ${c.dim('—')} ${c.bold('Installing plugin + configuring OpenClaw')}`);
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
      log(`  ${c.dim('plugins.entries.agenticmail:')}`);
      log(`  ${c.dim('  enabled: true')}`);
      log(`  ${c.dim('  config:')}`);
      log(`  ${c.dim(`    apiUrl: "${apiUrl}"`)}`);
      if (agentApiKey) log(`  ${c.dim(`    apiKey: "${agentApiKey}"`)}`);
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
  log(`  ${c.bold('Step 5 of 5')} ${c.dim('—')} ${c.bold('Restarting OpenClaw gateway')}`);
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
    log(`    Run manually: ${c.green('openclaw gateway restart')}`);
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
        execSync('openclaw gateway restart', { stdio: 'pipe', timeout: 30_000 });
        restartSpinner.succeed('OpenClaw gateway restarted');
        gatewayRestarted = true;
      } catch (err) {
        restartSpinner.fail('Gateway restart failed');
        log(`  ${c.yellow('⚠')} Gateway restart failed: ${(err as Error).message}`);
        log(`    Run manually: ${c.green('openclaw gateway restart')}`);
      }
    } else {
      log(`  ${c.dim('Skipped.')} Run later: ${c.green('openclaw gateway restart')}`);
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
    log(`  ${c.dim('API Key:')}     ${c.yellow(agentApiKey)}`);
  }
  log(`  ${c.dim('Master Key:')}  ${c.yellow(config.masterKey)}`);
  log(`  ${c.dim('Server:')}      ${c.cyan(apiBase)}`);
  log('');
  if (gatewayRestarted) {
    log(`  Your agent now has ${c.bold('54 email tools')} available!`);
    log(`  Try: ${c.dim('"Send an email to test@example.com"')}`);
    log('');
    log(`  ${c.bold('🎀 AgenticMail Coordination')} ${c.dim('(auto-configured)')}`);
    log(`    Your agent can now use ${c.cyan('agenticmail_call_agent')} to call other agents`);
    log(`    with structured task queues, push notifications, and auto-spawned sessions.`);
    log(`    This replaces sessions_spawn for coordinated multi-agent work.`);
  } else {
    log(`  ${c.bold('Next step:')}`);
    log(`    Restart your OpenClaw gateway, then your agent will`);
    log(`    have ${c.bold('54 email tools')} available!`);
  }
  log('');

  // Drop into the interactive shell (keeps the API server running)
  // Non-interactive mode (agent/script) skips the shell
  if (process.stdin.isTTY) {
    await interactiveShell({ config, onExit: cleanupChild });
  } else {
    // Stop the API if we started it
    if (!serverWasRunning) {
      cleanupChild();
    }
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
    log(`  ${c.dim(`          "apiKey": "${agentApiKey}",`)}`);
  }
  log(`  ${c.dim(`          "masterKey": "${masterKey}"`)}`);
  log(`  ${c.dim('        }')}`);
  log(`  ${c.dim('      }')}`);
  log(`  ${c.dim('    }')}`);
  log(`  ${c.dim('  }')}`);
  log(`  ${c.dim('}')}`);
}

async function cmdStatus() {
  log('');
  log(`  ${c.bgCyan(' AgenticMail Status ')}`);
  log('');

  const setup = new SetupManager();

  const FRIENDLY_NAMES: Record<string, string> = {
    docker: 'Container Engine',
    stalwart: 'Mail Server',
    cloudflared: 'Secure Tunnel',
  };

  const deps = await setup.checkDependencies();
  log(`  ${c.bold('Services:')}`);
  for (const dep of deps) {
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
  let apiPort = 3100;
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
}

async function cmdStart() {
  const setup = new SetupManager();

  if (!setup.isInitialized()) {
    await cmdSetup();
    return;
  }

  log('');
  log(`  ${c.bgCyan(' Starting AgenticMail ')}`);
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

  // Docker
  const dockerSpinner = new Spinner('docker', 'Making sure the engine is running...');
  dockerSpinner.start();
  try {
    await setup.ensureDocker();
    dockerSpinner.succeed('Engine is running');
  } catch (err) {
    dockerSpinner.fail(`Engine problem: ${(err as Error).message}`);
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

  // API server — check if one is already running first
  const serverSpinner = new Spinner('server', 'Launching your server...');
  serverSpinner.start();

  let alreadyRunning = false;
  try {
    const probe = await fetch(`http://${config.api.host}:${config.api.port}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (probe.ok) alreadyRunning = true;
  } catch { /* not running */ }

  if (alreadyRunning) {
    serverSpinner.succeed(`Server already running at ${c.cyan(`http://${config.api.host}:${config.api.port}`)}`);
  } else {
    try {
      const { fork } = await import('node:child_process');
      const apiEntry = resolveApiEntry();

      if (!existsSync(apiEntry)) {
        serverSpinner.fail(`Server isn't built yet. Run: ${c.bold('npm run build')}`);
        process.exit(1);
      }

      const env = configToEnv(config);
      // Suppress API stdout so it doesn't clutter the interactive prompt
      apiChild = fork(apiEntry, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });

      // Capture stderr for crash diagnostics (keep last 50 lines)
      const stderrLines: string[] = [];
      apiChild.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().trim().split('\n');
        for (const line of lines) {
          stderrLines.push(line);
          if (stderrLines.length > 50) stderrLines.shift();
        }
      });

      apiChild.on('exit', (code, signal) => {
        apiChild = null;
        log('');
        fail(`Server stopped unexpectedly${signal ? ` (signal: ${signal})` : code ? ` (exit code: ${code})` : ''}`);
        if (stderrLines.length > 0) {
          log('');
          log(`  ${c.dim('Last server output:')}`);
          for (const line of stderrLines.slice(-10)) {
            log(`  ${c.dim(line)}`);
          }
        }
        log('');
        process.exit(code ?? 1);
      });

      // Wait for server to be ready
      const ready = await waitForApi(config.api.host, config.api.port, 20_000);
      if (!ready) {
        serverSpinner.fail('Server did not start in time');
        cleanupChild();
        process.exit(1);
      }

      serverSpinner.succeed(`Server running at ${c.cyan(`http://${config.api.host}:${config.api.port}`)}`);
    } catch (err) {
      serverSpinner.fail(`Couldn't start the server: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Interactive prompt
  await interactiveShell({ config, onExit: cleanupChild });
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case 'setup':
    cmdSetup().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'start':
    cmdStart().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'status':
    cmdStatus().then(() => { process.exit(0); }).catch(err => { console.error(err); process.exit(1); });
    break;
  case 'openclaw':
    cmdOpenClaw().catch(err => { console.error(err); process.exit(1); });
    break;
  case 'help':
  case '--help':
  case '-h':
    log('');
    log(`  ${c.bgCyan(' AgenticMail ')} ${c.dim('Give your AI agent a real email address')}`);
    log('');
    log('  Commands:');
    log(`    ${c.green('agenticmail')}           Get started (setup + start)`);
    log(`    ${c.green('agenticmail setup')}     Re-run the setup wizard`);
    log(`    ${c.green('agenticmail start')}     Start the server`);
    log(`    ${c.green('agenticmail status')}    See what's running`);
    log(`    ${c.green('agenticmail openclaw')}  Set up AgenticMail for OpenClaw`);
    log('');
    process.exit(0);
  default:
    // No arguments = the main entry point
    cmdStart().catch(err => { console.error(err); process.exit(1); });
    break;
}
