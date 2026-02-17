import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

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
   * Searches common locations where agenticmail is installed.
   */
  private getApiEntryPath(): string {
    // Strategy 1: Resolve from the agenticmail package
    const searchDirs = [
      // Global npm install
      join(homedir(), 'node_modules', 'agenticmail'),
      // npx cache / global prefix
      ...((): string[] => {
        try {
          const prefix = execSync('npm prefix -g', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          return [
            join(prefix, 'lib', 'node_modules', 'agenticmail'),
            join(prefix, 'node_modules', 'agenticmail'),
          ];
        } catch { return []; }
      })(),
      // Homebrew on macOS
      '/opt/homebrew/lib/node_modules/agenticmail',
      '/usr/local/lib/node_modules/agenticmail',
    ];

    // Look for the @agenticmail/api dist entry
    for (const base of searchDirs) {
      // Check for the API package in node_modules
      const apiPaths = [
        join(base, 'node_modules', '@agenticmail', 'api', 'dist', 'index.js'),
        join(base, '..', '@agenticmail', 'api', 'dist', 'index.js'),
      ];
      for (const p of apiPaths) {
        if (existsSync(p)) return p;
      }
    }

    // Strategy 2: Use the data dir's known entry
    const dataDir = join(homedir(), '.agenticmail');
    const entryCache = join(dataDir, 'api-entry.path');
    if (existsSync(entryCache)) {
      const cached = readFileSync(entryCache, 'utf-8').trim();
      if (existsSync(cached)) return cached;
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
   * Generate the launchd plist content for macOS.
   */
  private generatePlist(nodePath: string, apiEntry: string, configPath: string): string {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const logDir = join(homedir(), '.agenticmail', 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${apiEntry}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTICMAIL_DATA_DIR</key>
    <string>${config.dataDir || join(homedir(), '.agenticmail')}</string>
    <key>AGENTICMAIL_MASTER_KEY</key>
    <string>${config.masterKey}</string>
    <key>STALWART_ADMIN_USER</key>
    <string>${config.stalwart.adminUser}</string>
    <key>STALWART_ADMIN_PASSWORD</key>
    <string>${config.stalwart.adminPassword}</string>
    <key>STALWART_URL</key>
    <string>${config.stalwart.url}</string>
    <key>AGENTICMAIL_API_PORT</key>
    <string>${String(config.api.port)}</string>
    <key>AGENTICMAIL_API_HOST</key>
    <string>${config.api.host}</string>
    <key>SMTP_HOST</key>
    <string>${config.smtp.host}</string>
    <key>SMTP_PORT</key>
    <string>${String(config.smtp.port)}</string>
    <key>IMAP_HOST</key>
    <string>${config.imap.host}</string>
    <key>IMAP_PORT</key>
    <string>${String(config.imap.port)}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

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
   */
  private generateSystemdUnit(nodePath: string, apiEntry: string, configPath: string): string {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const dataDir = config.dataDir || join(homedir(), '.agenticmail');

    return `[Unit]
Description=AgenticMail API Server
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
ExecStart=${nodePath} ${apiEntry}
Restart=on-failure
RestartSec=10
Environment=AGENTICMAIL_DATA_DIR=${dataDir}
Environment=AGENTICMAIL_MASTER_KEY=${config.masterKey}
Environment=STALWART_ADMIN_USER=${config.stalwart.adminUser}
Environment=STALWART_ADMIN_PASSWORD=${config.stalwart.adminPassword}
Environment=STALWART_URL=${config.stalwart.url}
Environment=AGENTICMAIL_API_PORT=${config.api.port}
Environment=AGENTICMAIL_API_HOST=${config.api.host}
Environment=SMTP_HOST=${config.smtp.host}
Environment=SMTP_PORT=${config.smtp.port}
Environment=IMAP_HOST=${config.imap.host}
Environment=IMAP_PORT=${config.imap.port}

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
}
