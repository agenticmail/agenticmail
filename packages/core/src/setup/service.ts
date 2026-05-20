import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createRequire } from 'node:module';

const PLIST_LABEL = 'com.agenticmail.server';
const SYSTEMD_UNIT = 'agenticmail.service';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: 'launchd' | 'systemd' | 'unsupported';
  servicePath: string | null;
}

/**
 * ServiceManager handles auto-start on boot for the AgenticMail API server.
 * - macOS: LaunchAgent plist (user-level, no sudo needed)
 * - Linux: systemd user service (user-level, no sudo needed)
 */
export class ServiceManager {
  private os = platform();

  /**
   * Get the path to the service file.
   */
  private getServicePath(): string {
    if (this.os === 'darwin') {
      return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
    } else {
      return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
    }
  }

  /**
   * Find the Node.js binary path.
   */
  private getNodePath(): string {
    try {
      return execFileSync('which', ['node'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return process.execPath;
    }
  }

  /**
   * Find the API server entry point.
   *
   * Issue #26 — Robust path resolution.
   *
   * The original implementation hard-coded `node_modules/agenticmail` (the
   * old unscoped package name). After the rename to `@agenticmail/cli`, that
   * directory no longer exists, so the resolver fell back to the stale
   * `~/.agenticmail/api-entry.path` cache and the launchd plist kept pointing
   * at a deleted path — causing the boot crash loop reported in #26.
   *
   * We now prefer `require.resolve('@agenticmail/api')` so the resolution
   * follows the actual installed location regardless of npm prefix, the
   * scoped vs unscoped package name, or the package manager (npm global,
   * pnpm, yarn global, local node_modules). Cached paths are always
   * validated against the filesystem before being returned.
   */
  private getApiEntryPath(): string {
    // Strategy 1 (preferred): require.resolve from this module's location.
    // This walks the standard Node module-resolution chain and naturally
    // finds @agenticmail/api whether we're installed inside @agenticmail/cli,
    // a hoisted root node_modules, a pnpm store, or a yarn workspace.
    try {
      const req = createRequire(import.meta.url);
      const resolved = req.resolve('@agenticmail/api');
      if (existsSync(resolved)) return resolved;
    } catch { /* not resolvable from here */ }

    // Strategy 2: search common install layouts for BOTH the scoped (new)
    // and unscoped (old) parent package names. Scoped first — that's the
    // canonical layout post-rename.
    const parentPackages = [
      join('@agenticmail', 'cli'), // current scoped package
      'agenticmail',               // legacy unscoped package
    ];
    const baseDirs: string[] = [
      // user-local install
      join(homedir(), 'node_modules'),
    ];
    try {
      const prefix = execSync('npm prefix -g', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      baseDirs.push(join(prefix, 'lib', 'node_modules'));
      baseDirs.push(join(prefix, 'node_modules'));
    } catch { /* npm not on PATH */ }
    // Common global locations
    baseDirs.push('/opt/homebrew/lib/node_modules');
    baseDirs.push('/usr/local/lib/node_modules');

    for (const base of baseDirs) {
      // Sibling layout: <base>/@agenticmail/api/dist/index.js (hoisted)
      const sibling = join(base, '@agenticmail', 'api', 'dist', 'index.js');
      if (existsSync(sibling)) return sibling;
      for (const parent of parentPackages) {
        const nested = join(base, parent, 'node_modules', '@agenticmail', 'api', 'dist', 'index.js');
        if (existsSync(nested)) return nested;
      }
    }

    // Strategy 3: validated cache fallback. Only return it if the path on
    // disk still exists — stale caches were the entire crash mode in #26.
    const dataDir = join(homedir(), '.agenticmail');
    const entryCache = join(dataDir, 'api-entry.path');
    if (existsSync(entryCache)) {
      const cached = readFileSync(entryCache, 'utf-8').trim();
      if (cached && existsSync(cached)) return cached;
    }

    throw new Error('Could not find @agenticmail/api entry point. Run `agenticmail start` first to populate the cache.');
  }

  /**
   * Cache the API entry path so the service can find it later.
   */
  cacheApiEntryPath(entryPath: string): void {
    const dataDir = join(homedir(), '.agenticmail');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'api-entry.path'), entryPath);
  }

  /**
   * Get the current package version.
   *
   * Issue #26 — resolve the CLI package.json via require.resolve so the
   * version reflects the *currently installed* @agenticmail/cli, not a
   * leftover unscoped `agenticmail` package directory.
   */
  private getVersion(): string {
    // Strategy 1: resolve @agenticmail/cli/package.json directly.
    try {
      const req = createRequire(import.meta.url);
      const pkgJson = req.resolve('@agenticmail/cli/package.json');
      if (existsSync(pkgJson)) {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
    } catch { /* not resolvable */ }

    // Strategy 2: derive from the resolved API entry's nearest package.json.
    try {
      const apiEntry = this.getApiEntryPath();
      // dist/index.js -> ../../package.json (api package)
      const apiPkg = join(apiEntry, '..', '..', 'package.json');
      if (existsSync(apiPkg)) {
        const pkg = JSON.parse(readFileSync(apiPkg, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
    } catch { /* ignore */ }

    // Strategy 3: scan known install locations for a CLI package.json
    // covering both the new scoped name and the legacy unscoped name.
    const candidates: string[] = [
      join(homedir(), 'node_modules', '@agenticmail', 'cli', 'package.json'),
      join(homedir(), 'node_modules', 'agenticmail', 'package.json'),
      join(homedir(), '.agenticmail', 'package-version.json'),
    ];
    try {
      const prefix = execSync('npm prefix -g', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      candidates.push(join(prefix, 'lib', 'node_modules', '@agenticmail', 'cli', 'package.json'));
      candidates.push(join(prefix, 'lib', 'node_modules', 'agenticmail', 'package.json'));
    } catch { /* ignore */ }

    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          const pkg = JSON.parse(readFileSync(p, 'utf-8'));
          if (pkg.version) return pkg.version;
        }
      } catch { /* skip malformed */ }
    }
    return 'unknown';
  }

  /**
   * Generate a wrapper script that waits for Docker before starting the API.
   * This ensures AgenticMail doesn't fail on boot when Docker is still loading.
   */
  private generateStartScript(nodePath: string, apiEntry: string): string {
    const scriptPath = join(homedir(), '.agenticmail', 'bin', 'start-server.sh');
    const scriptDir = join(homedir(), '.agenticmail', 'bin');
    if (!existsSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });

    const script = [
      '#!/bin/bash',
      '# AgenticMail auto-start script',
      '# Waits for Docker to be ready, then starts the API server.',
      '',
      'LOG_DIR="$HOME/.agenticmail/logs"',
      'mkdir -p "$LOG_DIR"',
      '',
      'log() {',
      '  echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] $1" >> "$LOG_DIR/startup.log"',
      '}',
      '',
      'log "AgenticMail starting..."',
      '',
      '# v0.9.84 — source ~/.agenticmail/.env before exec so the API process',
      '# inherits AGENTICMAIL_MASTER_KEY, AGENTICMAIL_INBOUND_SECRET, the',
      '# Stalwart admin creds, and SMTP/IMAP/data-dir overrides. Without',
      '# this, launchd\'s child ran with only HOME / PATH / DATA_DIR (the',
      '# plist EnvironmentVariables block), so the API silently fell back',
      '# to a fresh-random INBOUND_SECRET on every boot and could not',
      '# decrypt master-key-protected secrets at all.',
      'ENV_FILE="$HOME/.agenticmail/.env"',
      'if [ -f "$ENV_FILE" ]; then',
      '  log "Sourcing $ENV_FILE"',
      '  set -a   # mark all sourced vars for export',
      '  # shellcheck disable=SC1090',
      '  . "$ENV_FILE"',
      '  set +a',
      'else',
      '  log "WARNING: $ENV_FILE not found — API will run with default config (no master key)."',
      'fi',
      '',
      '# Wait for Docker daemon (up to 10 minutes — Docker Desktop can be very slow on first boot)',
      'MAX_WAIT=600',
      'WAITED=0',
      'while ! docker info >/dev/null 2>&1; do',
      '  if [ $WAITED -ge $MAX_WAIT ]; then',
      '    log "ERROR: Docker did not start after ${MAX_WAIT}s. Exiting."',
      '    exit 1',
      '  fi',
      '  sleep 5',
      '  WAITED=$((WAITED + 5))',
      '  log "Waiting for Docker... (${WAITED}s)"',
      'done',
      'log "Docker is ready (waited ${WAITED}s)"',
      '',
      '# Wait for Stalwart container (up to 60s)',
      'MAX_STALWART=60',
      'WAITED=0',
      'while ! docker ps --filter "name=agenticmail-stalwart" --format "{{.Status}}" 2>/dev/null | grep -qi "up"; do',
      '  if [ $WAITED -ge $MAX_STALWART ]; then',
      '    log "WARNING: Stalwart not running. Attempting to start..."',
      '    COMPOSE="$HOME/.agenticmail/docker-compose.yml"',
      '    if [ -f "$COMPOSE" ]; then',
      '      docker compose -f "$COMPOSE" up -d 2>>"$LOG_DIR/startup.log"',
      '      sleep 5',
      '    fi',
      '    break',
      '  fi',
      '  sleep 3',
      '  WAITED=$((WAITED + 3))',
      'done',
      'log "Stalwart check complete"',
      '',
      '# Start the API server',
      `log "Starting API server: ${nodePath} ${apiEntry}"`,
      `exec "${nodePath}" "${apiEntry}"`,
    ].join('\n') + '\n';
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }

  /**
   * Generate the launchd plist content for macOS.
   * More robust than OpenClaw's plist:
   * - Wrapper script waits for Docker + Stalwart before starting
   * - KeepAlive: true (unconditional — always restart, not just on crash)
   * - SoftResourceLimits for file descriptors (email servers need many)
   * - StartInterval as backup heartbeat (checks every 5 min)
   * - Service version tracking in env vars
   */
  private generatePlist(nodePath: string, apiEntry: string, configPath: string): string {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const logDir = join(homedir(), '.agenticmail', 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const version = this.getVersion();
    const startScript = this.generateStartScript(nodePath, apiEntry);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>Comment</key>
  <string>AgenticMail API Server (v${version})</string>

  <key>ProgramArguments</key>
  <array>
    <string>${startScript}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>AGENTICMAIL_DATA_DIR</key>
    <string>${config.dataDir || join(homedir(), '.agenticmail')}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AGENTICMAIL_SERVICE_VERSION</key>
    <string>${version}</string>
    <key>AGENTICMAIL_SERVICE_LABEL</key>
    <string>${PLIST_LABEL}</string>
  </dict>

  <!-- Start when user logs in -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Always keep running — restart unconditionally if it ever stops -->
  <key>KeepAlive</key>
  <true/>

  <!-- Minimum 15s between restarts to avoid rapid crash loops -->
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <!-- File descriptor limits — email servers need many open connections -->
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>16384</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${logDir}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/server.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>`;
  }

  /**
   * Generate the systemd user service content for Linux.
   * More robust than basic services:
   * - Wrapper script waits for Docker + Stalwart
   * - Restart=always (unconditional)
   * - WatchdogSec for health monitoring
   * - File descriptor limits
   * - Proper dependency ordering
   */
  private generateSystemdUnit(nodePath: string, apiEntry: string, configPath: string): string {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const dataDir = config.dataDir || join(homedir(), '.agenticmail');
    const version = this.getVersion();
    const startScript = this.generateStartScript(nodePath, apiEntry);

    return `[Unit]
Description=AgenticMail API Server (v${version})
After=network-online.target docker.service
Wants=network-online.target docker.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${startScript}
Restart=always
RestartSec=15
TimeoutStartSec=660
LimitNOFILE=8192
Environment=HOME=${homedir()}
Environment=AGENTICMAIL_DATA_DIR=${dataDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
Environment=AGENTICMAIL_SERVICE_VERSION=${version}

[Install]
WantedBy=default.target
`;
  }

  /**
   * Install the auto-start service.
   */
  install(): { installed: boolean; message: string } {
    const configPath = join(homedir(), '.agenticmail', 'config.json');
    if (!existsSync(configPath)) {
      return { installed: false, message: 'Config not found. Run agenticmail setup first.' };
    }

    const nodePath = this.getNodePath();
    let apiEntry: string;
    try {
      apiEntry = this.getApiEntryPath();
    } catch (err) {
      return { installed: false, message: (err as Error).message };
    }

    const servicePath = this.getServicePath();

    if (this.os === 'darwin') {
      // macOS: LaunchAgent
      const dir = join(homedir(), 'Library', 'LaunchAgents');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Unload existing if present
      if (existsSync(servicePath)) {
        try { execFileSync('launchctl', ['unload', servicePath], { timeout: 10_000, stdio: 'ignore' }); } catch { /* ignore */ }
      }

      const plist = this.generatePlist(nodePath, apiEntry, configPath);
      writeFileSync(servicePath, plist);
      chmodSync(servicePath, 0o600);

      // Load the service
      try {
        execFileSync('launchctl', ['load', servicePath], { timeout: 10_000, stdio: 'ignore' });
      } catch (err) {
        return { installed: false, message: `Failed to load service: ${(err as Error).message}` };
      }

      return { installed: true, message: `Service installed at ${servicePath}` };

    } else if (this.os === 'linux') {
      // Linux: systemd user service
      const dir = join(homedir(), '.config', 'systemd', 'user');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const unit = this.generateSystemdUnit(nodePath, apiEntry, configPath);
      writeFileSync(servicePath, unit);
      chmodSync(servicePath, 0o600);

      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000, stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'enable', SYSTEMD_UNIT], { timeout: 10_000, stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'start', SYSTEMD_UNIT], { timeout: 10_000, stdio: 'ignore' });
        // Enable linger so user services run without login
        try { execFileSync('loginctl', ['enable-linger'], { timeout: 10_000, stdio: 'ignore' }); } catch { /* may need sudo */ }
      } catch (err) {
        return { installed: false, message: `Failed to enable service: ${(err as Error).message}` };
      }

      return { installed: true, message: `Service installed at ${servicePath}` };

    } else {
      return { installed: false, message: `Auto-start not supported on ${this.os}` };
    }
  }

  /**
   * Uninstall the auto-start service.
   */
  uninstall(): { removed: boolean; message: string } {
    const servicePath = this.getServicePath();

    if (!existsSync(servicePath)) {
      return { removed: false, message: 'Service is not installed.' };
    }

    if (this.os === 'darwin') {
      try { execFileSync('launchctl', ['unload', servicePath], { timeout: 10_000, stdio: 'ignore' }); } catch { /* ignore */ }
      try { unlinkSync(servicePath); } catch { /* ignore */ }
      return { removed: true, message: 'Service removed.' };

    } else if (this.os === 'linux') {
      try {
        execFileSync('systemctl', ['--user', 'stop', SYSTEMD_UNIT], { timeout: 10_000, stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'disable', SYSTEMD_UNIT], { timeout: 10_000, stdio: 'ignore' });
      } catch { /* ignore */ }
      try { unlinkSync(servicePath); } catch { /* ignore */ }
      try { execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000, stdio: 'ignore' }); } catch { /* ignore */ }
      return { removed: true, message: 'Service removed.' };

    } else {
      return { removed: false, message: `Not supported on ${this.os}` };
    }
  }

  /**
   * Get the current service status.
   */
  status(): ServiceStatus {
    const servicePath = this.getServicePath();
    const plat = this.os === 'darwin' ? 'launchd' as const : this.os === 'linux' ? 'systemd' as const : 'unsupported' as const;
    const installed = existsSync(servicePath);

    let running = false;
    if (installed) {
      if (this.os === 'darwin') {
        try {
          const output = execSync(`launchctl list | grep ${PLIST_LABEL}`, { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          // Format: PID\tStatus\tLabel — if PID is not "-", it's running
          const pid = output.trim().split('\t')[0];
          running = pid !== '-' && pid !== '' && !isNaN(parseInt(pid));
        } catch { /* not loaded */ }
      } else if (this.os === 'linux') {
        try {
          execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { timeout: 5_000, stdio: 'ignore' });
          running = true;
        } catch { /* not active */ }
      }
    }

    return { installed, running, platform: plat, servicePath: installed ? servicePath : null };
  }

  /**
   * Reinstall the service (useful after config changes or updates).
   */
  reinstall(): { installed: boolean; message: string } {
    this.uninstall();
    return this.install();
  }

  /**
   * Issue #26 — Detect a stale service installation.
   *
   * Background: when a user upgrades from the old unscoped `agenticmail`
   * package to the new `@agenticmail/cli` scoped package, the old
   * ~/Library/LaunchAgents/com.agenticmail.server.plist and
   * ~/.agenticmail/bin/start-server.sh files keep pointing at
   * /opt/homebrew/lib/node_modules/agenticmail/... — a path that no longer
   * exists post-rename. The result is a launchd crash loop.
   *
   * `needsRepair()` returns a non-null reason whenever:
   *  - the service file exists but the start-server.sh it launches is
   *    missing or references a node_modules path that no longer resolves;
   *  - the embedded service version drifts from the running CLI version
   *    (so service files get refreshed on every upgrade — including
   *    in-place version bumps that don't change the install path);
   *  - the cached API entry path no longer exists on disk.
   *
   * Returns null when everything checks out — callers should treat that as
   * "no action needed".
   *
   * Platform-aware: only inspects launchd artefacts on darwin and systemd
   * artefacts on linux. Returns null on unsupported platforms so this can
   * be called unconditionally from the CLI's start path.
   */
  needsRepair(): { reason: string } | null {
    if (this.os !== 'darwin' && this.os !== 'linux') return null;

    const servicePath = this.getServicePath();
    if (!existsSync(servicePath)) return null; // nothing installed → nothing to repair

    let serviceContent = '';
    try { serviceContent = readFileSync(servicePath, 'utf-8'); }
    catch { return { reason: 'Service file unreadable' }; }

    // 1) Validate the start-server.sh referenced by the service file.
    const startScript = join(homedir(), '.agenticmail', 'bin', 'start-server.sh');
    if (serviceContent.includes(startScript)) {
      if (!existsSync(startScript)) {
        return { reason: 'start-server.sh is missing' };
      }
      let scriptContent = '';
      try { scriptContent = readFileSync(startScript, 'utf-8'); }
      catch { return { reason: 'start-server.sh unreadable' }; }

      // Pull every absolute path the script tries to exec / log and verify
      // the @agenticmail/api entry it points at still exists. We match on
      // the dist/index.js suffix common to both layouts.
      const apiPathMatch = scriptContent.match(/(\/[^"\s]+@agenticmail\/api\/dist\/index\.js)/);
      if (apiPathMatch) {
        const referenced = apiPathMatch[1];
        if (!existsSync(referenced)) {
          return { reason: `start-server.sh references missing path: ${referenced}` };
        }
      }
      // Catch the old unscoped layout explicitly — these always need repair.
      if (/node_modules\/agenticmail\/(?!.*@agenticmail\/cli)/.test(scriptContent)) {
        const stale = /(\S*node_modules\/agenticmail\/\S*)/.exec(scriptContent)?.[1];
        if (stale && !existsSync(stale)) {
          return { reason: `start-server.sh references legacy unscoped path: ${stale}` };
        }
      }
    } else {
      // Service file exists but doesn't reference our wrapper script — the
      // installer always writes one, so absence means a hand-edited or
      // pre-#26 file. Repair to bring it in line.
      return { reason: 'Service file does not reference the wrapper script' };
    }

    // 2) Version drift — keep the embedded version in sync with the CLI.
    const currentVersion = this.getVersion();
    if (currentVersion !== 'unknown') {
      // Both plist and systemd unit embed `v${version}` in the description
      // and AGENTICMAIL_SERVICE_VERSION env var. A simple substring check
      // works for both formats.
      if (!serviceContent.includes(`v${currentVersion}`) ||
          !serviceContent.includes(`AGENTICMAIL_SERVICE_VERSION`) ||
          !serviceContent.includes(currentVersion)) {
        return { reason: `Service version drift (current CLI is v${currentVersion})` };
      }
    }

    // 3) Cached API entry pointer is stale.
    const entryCache = join(homedir(), '.agenticmail', 'api-entry.path');
    if (existsSync(entryCache)) {
      try {
        const cached = readFileSync(entryCache, 'utf-8').trim();
        if (cached && !existsSync(cached)) {
          return { reason: `Cached API entry path no longer exists: ${cached}` };
        }
      } catch { /* ignore */ }
    }

    return null;
  }
}
