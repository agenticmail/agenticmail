#!/usr/bin/env node

/**
 * Cleanup script that runs on `npm uninstall agenticmail`.
 *
 * 1. Unloads & removes the launchd / systemd auto-start service
 * 2. Stops & removes the agenticmail-stalwart Docker container
 * 3. Cleans agenticmail entries from OpenClaw config
 * 4. Removes ~/.agenticmail data directory
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const home = homedir();
const os = platform();

function log(msg) { console.log(`[agenticmail] ${msg}`); }
function tryExec(cmd, opts = {}) { try { execSync(cmd, { timeout: 15_000, stdio: 'ignore', ...opts }); } catch { /* ignore */ } }

// ── 1. Unload auto-start service ─────────────────────────────────

if (os === 'darwin') {
  const plist = join(home, 'Library', 'LaunchAgents', 'com.agenticmail.server.plist');
  if (existsSync(plist)) {
    log('Unloading launchd service...');
    tryExec(`launchctl bootout gui/$(id -u) "${plist}"`);
    try { unlinkSync(plist); } catch { /* ignore */ }
  }
} else if (os === 'linux') {
  const unit = 'agenticmail.service';
  tryExec(`systemctl --user stop ${unit}`);
  tryExec(`systemctl --user disable ${unit}`);
  const unitPath = join(home, '.config', 'systemd', 'user', unit);
  if (existsSync(unitPath)) {
    try { unlinkSync(unitPath); } catch { /* ignore */ }
    tryExec('systemctl --user daemon-reload');
  }
}

// ── 2. Stop Docker container ──────────────────────────────────────

try {
  const ps = execFileSync('docker', ['ps', '-a', '--filter', 'name=agenticmail-stalwart', '--format', '{{.Names}}'],
    { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (ps.includes('agenticmail-stalwart')) {
    log('Stopping mail server container...');
    tryExec('docker rm -f agenticmail-stalwart');
  }
} catch { /* docker not available — skip */ }

// ── 3. Clean OpenClaw config ──────────────────────────────────────

const openclawConfig = join(home, '.openclaw', 'openclaw.json');
if (existsSync(openclawConfig)) {
  try {
    const raw = readFileSync(openclawConfig, 'utf-8');
    const config = JSON.parse(raw);
    let changed = false;

    // Remove plugins.entries.agenticmail
    if (config.plugins?.entries?.agenticmail) {
      delete config.plugins.entries.agenticmail;
      changed = true;
      if (Object.keys(config.plugins.entries).length === 0) delete config.plugins.entries;
    }

    // Remove our path from plugins.load.paths
    if (Array.isArray(config.plugins?.load?.paths)) {
      const before = config.plugins.load.paths.length;
      config.plugins.load.paths = config.plugins.load.paths.filter(
        (p) => !p.includes('@agenticmail')
      );
      if (config.plugins.load.paths.length !== before) changed = true;
      if (config.plugins.load.paths.length === 0) {
        delete config.plugins.load.paths;
        if (config.plugins.load && Object.keys(config.plugins.load).length === 0) delete config.plugins.load;
      }
    }

    if (changed) {
      writeFileSync(openclawConfig, JSON.stringify(config, null, 2) + '\n');
      log('Cleaned OpenClaw config');
    }
  } catch { /* don't fail uninstall */ }
}

// ── 4. Remove ~/.agenticmail ──────────────────────────────────────

const dataDir = join(home, '.agenticmail');
if (existsSync(dataDir)) {
  // Safety: verify it's not a symlink pointing outside home (symlink attack prevention)
  try {
    const stat = lstatSync(dataDir);
    if (stat.isSymbolicLink()) {
      const realPath = realpathSync(dataDir);
      if (!realPath.startsWith(home)) {
        log(`WARNING: ~/.agenticmail is a symlink to ${realPath} (outside home dir) — skipping removal`);
      } else {
        log('Removing ~/.agenticmail/ (symlink) ...');
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } else {
      log('Removing ~/.agenticmail/ ...');
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* stat failed — skip */ }
}

log('Uninstall complete.');
