#!/usr/bin/env node

/**
 * Cleanup script that runs on `npm uninstall @agenticmail/openclaw`.
 * Removes the agenticmail plugin entry from ~/.openclaw/openclaw.json
 * and cleans up the plugin load path so OpenClaw doesn't error on
 * a missing plugin.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const configPath = join(homedir(), '.openclaw', 'openclaw.json');

if (!existsSync(configPath)) process.exit(0);

try {
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);

  let changed = false;

  // Remove plugins.entries.agenticmail
  if (config.plugins?.entries?.agenticmail) {
    delete config.plugins.entries.agenticmail;
    changed = true;

    // Clean up empty entries object
    if (Object.keys(config.plugins.entries).length === 0) {
      delete config.plugins.entries;
    }
  }

  // Remove our path from plugins.load.paths
  if (Array.isArray(config.plugins?.load?.paths)) {
    const before = config.plugins.load.paths.length;
    config.plugins.load.paths = config.plugins.load.paths.filter(
      (p) => !p.includes('@agenticmail/openclaw')
    );
    if (config.plugins.load.paths.length !== before) changed = true;

    // Clean up empty paths array
    if (config.plugins.load.paths.length === 0) {
      delete config.plugins.load.paths;
      if (Object.keys(config.plugins.load).length === 0) {
        delete config.plugins.load;
      }
    }
  }

  if (changed) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log('[agenticmail] Cleaned up OpenClaw config:', configPath);
  }
} catch {
  // Don't fail the uninstall if cleanup fails
}
