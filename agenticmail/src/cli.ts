#!/usr/bin/env node

import { createInterface, emitKeypressEvents } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
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
    this.progressPct = -1;
    const msgs = LOADING_MESSAGES[this.category] ?? LOADING_MESSAGES.general;

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length];
      if (this.progressPct >= 0) {
        // Progress bar mode (pink)
        const barWidth = 20;
        const filled = Math.round((this.progressPct / 100) * barWidth);
        const empty = barWidth - filled;
        const bar = c.pink('█'.repeat(filled)) + c.dim('░'.repeat(empty));
        const pctStr = c.pink(`${this.progressPct}%`);
        process.stdout.write(`\r  ${c.pink(frame)} ${bar} ${pctStr} ${c.dim(this.currentMsg)}\x1b[K`);
      } else {
        process.stdout.write(`\r  ${c.cyan(frame)} ${c.yellow(this.currentMsg)}\x1b[K`);
      }
      this.frameIdx++;
      this.msgChangeCounter++;
      // Change message every ~3 seconds (30 ticks at 100ms)
      if (this.msgChangeCounter >= 30 && this.progressPct < 0) {
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
      this.currentMsg = match[2];
    } else {
      this.currentMsg = msg;
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

// --- Background server management ---
const PID_FILE = join(homedir(), '.agenticmail', 'server.pid');

/**
 * Start the API server as a detached background process.
 * Returns true if the server is reachable (already running or just started).
 */
async function startApiServer(config: SetupConfig): Promise<boolean> {
  const host = config.api.host;
  const port = config.api.port;

  // Check if already running
  try {
    const probe = await fetch(`http://${host}:${port}/api/agenticmail/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (probe.ok) return true;
  } catch { /* not running */ }

  const { spawn } = await import('node:child_process');
  const apiEntry = resolveApiEntry();
  const env = configToEnv(config);

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

  return waitForApi(host, port);
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

async function cmdSetup() {
  log('');
  log(`  ${c.bgCyan(' AgenticMail Setup ')}`);
  log('');
  log(`  ${c.bold('Welcome!')} We're going to set up everything your AI agent`);
  log(`  needs to send and receive real email.`);
  log('');
  const hasOpenClaw = existsSync(join(homedir(), '.openclaw', 'openclaw.json'));
  const totalSteps = hasOpenClaw ? 6 : 5;

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
    // Create a new SetupManager with progress callback wired to the spinner
    const dockerSetup = new SetupManager((msg: string) => spinner.update(msg));
    try {
      await dockerSetup.ensureDocker();
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
    const stalwartSetup = new SetupManager((msg: string) => spinner.update(msg));
    try {
      await stalwartSetup.ensureStalwart();
      spinner.succeed(`${c.bold('Mail Server')} — up and running!`);
    } catch (err) {
      spinner.fail(`Couldn't start the mail server: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    // Stalwart is running — verify our credentials work (may be stale after reinstall)
    try {
      const authCheck = await fetch(`${result.config.stalwart.url}/api/principal`, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${result.config.stalwart.adminUser}:${result.config.stalwart.adminPassword}`).toString('base64'),
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (authCheck.status === 401) {
        // Credentials mismatch — container has old password (leftover volume after reinstall)
        const spinner = new Spinner('stalwart', 'Resetting mail server (stale credentials)...');
        spinner.start();
        try {
          const { execFileSync } = await import('node:child_process');
          // Remove container and its anonymous volumes
          execFileSync('docker', ['rm', '-f', 'agenticmail-stalwart'], { timeout: 15_000, stdio: 'ignore' });
          // Find and remove the named volume (project name varies)
          try {
            const volumes = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'name=stalwart-data'],
              { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            for (const vol of volumes.split('\n').filter(Boolean)) {
              execFileSync('docker', ['volume', 'rm', vol], { timeout: 10_000, stdio: 'ignore' });
            }
          } catch { /* volume may not exist */ }
          // Re-create with new credentials
          await setup.ensureStalwart();
          spinner.succeed(`${c.bold('Mail Server')} — recreated with fresh credentials`);
        } catch (err) {
          spinner.fail(`Couldn't reset mail server: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        ok(`${c.bold('Mail Server')} ${c.dim('— already running')}`);
      }
    } catch {
      // Can't reach Stalwart API — might be starting up, proceed anyway
      ok(`${c.bold('Mail Server')} ${c.dim('— already running')}`);
    }
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
      printSummary(result, true);
      return;
    }

    log('');
    let emailOk = false;
    if (choice === '1') {
      emailOk = await setupRelay(result.config);
    } else {
      await setupDomain(result.config);
      emailOk = true; // domain setup throws on failure
    }

    // Verify an agent exists before proceeding
    if (!emailOk) {
      log('');
      info('Email setup did not complete. Run ' + c.green('npx agenticmail setup') + ' again to retry.');
      printSummary(result, true);
      return;
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

    const wantSms = await ask(`  ${c.bold('Set up phone number access?')} ${c.dim('(y/N)')} `);
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

  // Step 6: OpenClaw integration (only if detected)
  if (hasOpenClaw && serverReady) {
    log('');
    log(`  ${c.bold(`Step 6 of ${totalSteps}`)} ${c.dim('—')} ${c.bold('Configure OpenClaw integration')}`);
    log('');
    await registerWithOpenClaw(result.config);
  }

  printSummary(result, false);

  // Drop into the interactive shell — server keeps running in background after exit
  if (serverReady) {
    await interactiveShell({ config: result.config, onExit: () => {} });
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
    const existingEntry = existing.plugins?.entries?.agenticmail;
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

async function setupRelay(config: SetupConfig): Promise<boolean> {
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
        return false;
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
      return true; // success — exit retry loop
    } catch (err) {
      spinner.fail(`Couldn't connect: ${(err as Error).message}`);
      return false;
    }
  }
  return false;
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
    const wantSms = await ask(`  ${c.bold('Set up phone number access?')} ${c.dim('(y/N)')} `);
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
                const gvPass = await ask(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
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
                    const gvPass = await ask(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
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
              const gvPass = await ask(`  ${c.green(c.bold('App password for'))} ${c.bold(gvEmail.trim())}: `);
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
    log(`  ${c.dim('API Key:')}     ${c.yellow(agentApiKey)}`);
  }
  log(`  ${c.dim('Master Key:')}  ${c.yellow(config.masterKey)}`);
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
    log(`  Your agent now has ${c.bold('63 email + SMS tools')} available!`);
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
    log(`    have ${c.bold('63 email + SMS tools')} available!`);
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

  // Interactive prompt — server keeps running in background after exit
  await interactiveShell({ config, onExit: () => {} });
}

async function cmdStop() {
  log('');
  const stopped = stopApiServer();
  if (stopped) {
    ok('AgenticMail server stopped');
  } else {
    info('Server is not running');
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

  // Latest version
  let latestVersion = 'unknown';
  try {
    latestVersion = execSync('npm view agenticmail version', { encoding: 'utf-8', timeout: 15000 }).trim();
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

  // Global or local?
  let isGlobal = false;
  try {
    const list = execSync(`npm list -g agenticmail 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 });
    if (list.includes('agenticmail@')) isGlobal = true;
  } catch {}

  const scope = isGlobal ? '-g' : '';
  const installCmd = pm === 'bun'
    ? `bun add ${scope} agenticmail@latest`.trim()
    : `${pm} install ${scope} agenticmail@latest`.trim();

  info(`Running: ${c.dim(installCmd)}`);
  try {
    execSync(installCmd, { stdio: 'inherit', timeout: 120000 });
    ok(`Updated to agenticmail@${latestVersion}`);
  } catch (err) {
    fail(`Update failed: ${(err as Error).message}`);
    info(`Try: ${c.green('npm install -g agenticmail@latest')}`);
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

switch (command) {
  case 'setup':
    cmdSetup().catch(err => { console.error(err); process.exit(1); });
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
  case 'update':
    cmdUpdate().catch(err => { console.error(err); process.exit(1); });
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
    log(`    ${c.green('agenticmail stop')}      Stop the server`);
    log(`    ${c.green('agenticmail status')}    See what's running`);
    log(`    ${c.green('agenticmail openclaw')}  Set up AgenticMail for OpenClaw`);
    log(`    ${c.green('agenticmail update')}    Update to the latest version`);
    log('');
    process.exit(0);
  default:
    // No arguments = the main entry point
    cmdStart().catch(err => { console.error(err); process.exit(1); });
    break;
}
