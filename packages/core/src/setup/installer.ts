import { execFileSync, execSync, spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

export type InstallProgress = (message: string) => void;

/**
 * Run a command and show a rolling window of output (max 20 lines).
 * Cleans up previous lines so the terminal stays tidy.
 * Returns a promise that resolves when the command finishes.
 */
function runWithRollingOutput(
  command: string,
  args: string[],
  opts: { timeout?: number; maxLines?: number; inheritStdin?: boolean } = {},
): Promise<{ exitCode: number; fullOutput: string }> {
  const maxLines = opts.maxLines ?? 20;
  const timeout = opts.timeout ?? 300_000;

  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, {
      stdio: [opts.inheritStdin ? 'inherit' : 'ignore', 'pipe', 'pipe'],
      timeout,
    });

    const lines: string[] = [];
    let displayedCount = 0;
    let fullOutput = '';

    const processData = (data: Buffer) => {
      const text = data.toString();
      fullOutput += text;
      const newLines = text.split('\n');

      for (const line of newLines) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        lines.push(trimmed);

        // Clear previously displayed lines
        if (displayedCount > 0) {
          const toClear = Math.min(displayedCount, maxLines);
          process.stdout.write(`\x1b[${toClear}A`); // Move up
          for (let i = 0; i < toClear; i++) {
            process.stdout.write('\x1b[2K\n'); // Clear each line
          }
          process.stdout.write(`\x1b[${toClear}A`); // Move back up
        }

        // Show last N lines
        const visible = lines.slice(-maxLines);
        for (const vLine of visible) {
          process.stdout.write(`  \x1b[90m${vLine.slice(0, 100)}\x1b[0m\n`);
        }
        displayedCount = visible.length;
      }
    };

    child.stdout?.on('data', processData);
    child.stderr?.on('data', processData);

    child.on('close', (code) => {
      // Clear the rolling output completely
      if (displayedCount > 0) {
        process.stdout.write(`\x1b[${displayedCount}A`);
        for (let i = 0; i < displayedCount; i++) {
          process.stdout.write('\x1b[2K\n');
        }
        process.stdout.write(`\x1b[${displayedCount}A`);
      }
      resolve({ exitCode: code ?? 1, fullOutput });
    });

    child.on('error', (err) => {
      if (displayedCount > 0) {
        process.stdout.write(`\x1b[${displayedCount}A`);
        for (let i = 0; i < displayedCount; i++) {
          process.stdout.write('\x1b[2K\n');
        }
        process.stdout.write(`\x1b[${displayedCount}A`);
      }
      reject(err);
    });
  });
}

/**
 * Run a shell command string with rolling output.
 */
function runShellWithRollingOutput(
  cmd: string,
  opts: { timeout?: number; maxLines?: number } = {},
): Promise<{ exitCode: number; fullOutput: string }> {
  const maxLines = opts.maxLines ?? 20;
  const timeout = opts.timeout ?? 300_000;

  return new Promise((resolve, reject) => {
    const child = spawnChild('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    const lines: string[] = [];
    let displayedCount = 0;
    let fullOutput = '';

    const processData = (data: Buffer) => {
      const text = data.toString();
      fullOutput += text;
      const newLines = text.split('\n');

      for (const line of newLines) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        lines.push(trimmed);

        if (displayedCount > 0) {
          const toClear = Math.min(displayedCount, maxLines);
          process.stdout.write(`\x1b[${toClear}A`);
          for (let i = 0; i < toClear; i++) {
            process.stdout.write('\x1b[2K\n');
          }
          process.stdout.write(`\x1b[${toClear}A`);
        }

        const visible = lines.slice(-maxLines);
        for (const vLine of visible) {
          process.stdout.write(`  \x1b[90m${vLine.slice(0, 100)}\x1b[0m\n`);
        }
        displayedCount = visible.length;
      }
    };

    child.stdout?.on('data', processData);
    child.stderr?.on('data', processData);

    child.on('close', (code) => {
      if (displayedCount > 0) {
        process.stdout.write(`\x1b[${displayedCount}A`);
        for (let i = 0; i < displayedCount; i++) {
          process.stdout.write('\x1b[2K\n');
        }
        process.stdout.write(`\x1b[${displayedCount}A`);
      }
      resolve({ exitCode: code ?? 1, fullOutput });
    });

    child.on('error', (err) => {
      if (displayedCount > 0) {
        process.stdout.write(`\x1b[${displayedCount}A`);
        for (let i = 0; i < displayedCount; i++) {
          process.stdout.write('\x1b[2K\n');
        }
        process.stdout.write(`\x1b[${displayedCount}A`);
      }
      reject(err);
    });
  });
}

/**
 * DependencyInstaller handles installing all external dependencies.
 * Everything is auto-installed — no optional deps.
 */
export class DependencyInstaller {
  private onProgress: InstallProgress;

  constructor(onProgress?: InstallProgress) {
    this.onProgress = onProgress ?? (() => {});
  }

  /**
   * Ensure Docker is installed AND the daemon is running.
   * macOS: Downloads official DMG and runs Docker's CLI installer (no Homebrew needed).
   * Linux: Uses Docker's official convenience script (https://get.docker.com).
   * Starts the daemon if Docker CLI is present but daemon is stopped.
   */
  async installDocker(): Promise<void> {
    // Check if CLI is installed
    let cliInstalled = false;
    try {
      execFileSync('docker', ['--version'], { timeout: 5_000, stdio: 'ignore' });
      cliInstalled = true;
    } catch { /* not installed */ }

    if (cliInstalled) {
      // CLI exists — check if daemon is running
      try {
        execFileSync('docker', ['info'], { timeout: 10_000, stdio: 'ignore' });
        return; // both CLI and daemon are good
      } catch {
        // Daemon not running — start it
        this.onProgress('Docker found but not running — starting it now...');
        this.startDockerDaemon();
        await this.waitForDocker();
        return;
      }
    }

    const os = platform();

    if (os === 'darwin') {
      await this.installDockerMac();
    } else if (os === 'linux') {
      await this.installDockerLinux();
    } else {
      throw new Error(`Automatic Docker installation not supported on ${os}. Install it manually: https://docs.docker.com/get-docker/`);
    }
  }

  /**
   * Install Docker Desktop on macOS using the official DMG installer.
   * Downloads the DMG, mounts it, runs the silent CLI installer, then starts Docker Desktop.
   * This is Docker's recommended command-line installation method.
   */
  private async installDockerMac(): Promise<void> {
    const cpu = arch();
    const archName = cpu === 'arm64' ? 'arm64' : 'amd64';
    const dmgUrl = `https://desktop.docker.com/mac/main/${archName}/Docker.dmg`;
    const dmgPath = '/tmp/Docker.dmg';

    // Step 1: Download the DMG
    this.onProgress('__progress__:5:Downloading Docker Desktop...');
    const dlResult = await runWithRollingOutput('curl', [
      '-fSL', '--progress-bar', '-o', dmgPath, dmgUrl,
    ], { timeout: 600_000 }); // 10 min for slow connections
    if (dlResult.exitCode !== 0) {
      throw new Error('Failed to download Docker Desktop. Check your internet connection and try again.');
    }

    // Step 2: Mount the DMG
    this.onProgress('__progress__:40:Installing Docker Desktop...');
    try {
      // Detach any previous mount first (ignore errors)
      try { execSync('hdiutil detach /Volumes/Docker 2>/dev/null', { timeout: 10_000, stdio: 'ignore' }); } catch { /* ignore */ }
      execSync(`hdiutil attach "${dmgPath}" -nobrowse -quiet`, { timeout: 30_000, stdio: 'ignore' });
    } catch {
      throw new Error('Failed to mount Docker DMG. The download may be corrupted — try again.');
    }

    // Step 3: Run Docker's CLI installer with --accept-license
    this.onProgress('__progress__:55:Running Docker installer...');
    const user = process.env.USER || execSync('whoami', { timeout: 5_000 }).toString().trim();
    try {
      const installResult = await runWithRollingOutput(
        '/Volumes/Docker/Docker.app/Contents/MacOS/install',
        ['--accept-license', `--user=${user}`],
        { timeout: 120_000 },
      );
      if (installResult.exitCode !== 0) {
        // Some installs return non-zero but succeed — check if Docker.app exists
        if (!existsSync('/Applications/Docker.app')) {
          throw new Error('Installer exited with errors');
        }
      }
    } catch (err) {
      // Fallback: try cp approach if the installer binary fails
      if (!existsSync('/Applications/Docker.app')) {
        this.onProgress('__progress__:60:Trying alternative install method...');
        try {
          execSync('cp -R "/Volumes/Docker/Docker.app" /Applications/', { timeout: 60_000, stdio: 'ignore' });
        } catch {
          throw new Error('Failed to install Docker Desktop. Try dragging Docker.app to Applications manually.');
        }
      }
    }

    // Step 4: Unmount and clean up
    try { execSync('hdiutil detach /Volumes/Docker -quiet', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await unlink(dmgPath); } catch { /* ignore */ }

    // Step 5: Start Docker Desktop
    this.onProgress('__progress__:70:Starting Docker Desktop...');
    this.startDockerDaemon();
    await this.waitForDocker();
  }

  /**
   * Install Docker Engine on Linux using Docker's official convenience script.
   * Also adds the current user to the docker group for rootless usage.
   */
  private async installDockerLinux(): Promise<void> {
    this.onProgress('__progress__:5:Installing Docker Engine...');

    // Download and run the official install script
    const dlResult = await runShellWithRollingOutput(
      'curl -fsSL https://get.docker.com -o /tmp/install-docker.sh && sudo sh /tmp/install-docker.sh',
      { timeout: 300_000 },
    );
    if (dlResult.exitCode !== 0) {
      throw new Error(
        'Failed to install Docker Engine. You may need sudo privileges.\n' +
        'Manual install: https://docs.docker.com/engine/install/',
      );
    }

    // Add current user to docker group (avoids needing sudo for docker commands)
    const user = process.env.USER || process.env.LOGNAME || '';
    if (user && user !== 'root') {
      this.onProgress('__progress__:80:Adding user to docker group...');
      try {
        execSync(`sudo usermod -aG docker ${user}`, { timeout: 10_000, stdio: 'ignore' });
      } catch { /* non-fatal — they can run with sudo */ }
    }

    // Clean up install script
    try { await unlink('/tmp/install-docker.sh'); } catch { /* ignore */ }

    // Ensure the daemon is started
    this.onProgress('__progress__:85:Starting Docker service...');
    try {
      execSync('sudo systemctl enable --now docker', { timeout: 15_000, stdio: 'ignore' });
    } catch {
      // Fallback for non-systemd
      try { execSync('sudo service docker start', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
    }

    await this.waitForDocker();
  }

  /**
   * Attempt to start the Docker daemon using multiple strategies.
   * On macOS: tries Docker Desktop app, then docker CLI commands.
   * On Linux: tries systemctl, then dockerd direct, then snap.
   */
  private startDockerDaemon(strategy?: string): void {
    const os = platform();
    if (os === 'darwin') {
      switch (strategy) {
        case 'cli':
          // Try starting via docker CLI (Docker Desktop may respond to this)
          try { execSync('docker context use default 2>/dev/null; docker info', { timeout: 5_000, stdio: 'ignore' }); } catch { /* ignore */ }
          break;
        case 'reopen':
          // Force-kill and reopen Docker Desktop
          try { execSync('osascript -e \'quit app "Docker"\'', { timeout: 5_000, stdio: 'ignore' }); } catch { /* ignore */ }
          // Small delay for process cleanup
          try { execFileSync('sleep', ['2'], { timeout: 5_000, stdio: 'ignore' }); } catch { /* ignore */ }
          try { execFileSync('open', ['-a', 'Docker'], { timeout: 10_000, stdio: 'ignore' }); } catch { /* ignore */ }
          break;
        case 'background':
          // Try launching Docker.app directly via its binary
          try {
            const appBin = '/Applications/Docker.app/Contents/MacOS/Docker';
            if (existsSync(appBin)) {
              execSync(`"${appBin}" &`, { timeout: 5_000, stdio: 'ignore', shell: 'sh' });
            }
          } catch { /* ignore */ }
          break;
        default:
          // Default: open Docker Desktop app
          try { execFileSync('open', ['-a', 'Docker'], { timeout: 10_000, stdio: 'ignore' }); } catch { /* may already be starting */ }
      }
    } else if (os === 'linux') {
      switch (strategy) {
        case 'snap':
          try { execFileSync('sudo', ['snap', 'start', 'docker'], { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
          break;
        case 'service':
          try { execFileSync('sudo', ['service', 'docker', 'start'], { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
          break;
        default:
          try { execFileSync('sudo', ['systemctl', 'start', 'docker'], { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Wait for Docker daemon to be ready, with automatic retry strategies.
   * Tries multiple approaches to start Docker if the first one fails.
   * Reports progress as a percentage (0-100).
   */
  private async waitForDocker(): Promise<void> {
    const os = platform();
    const strategies = os === 'darwin'
      ? ['default', 'cli', 'reopen', 'background']
      : ['default', 'service', 'snap'];

    const totalTime = 240_000; // 4 minutes total budget
    const perStrategyTime = Math.floor(totalTime / strategies.length);
    const start = Date.now();
    let strategyIdx = 0;

    this.onProgress('__progress__:0:Starting Docker...');

    while (Date.now() - start < totalTime) {
      // Check if Docker is ready
      try {
        execFileSync('docker', ['info'], { timeout: 5_000, stdio: 'ignore' });
        this.onProgress('__progress__:100:Docker is ready!');
        return;
      } catch { /* not ready yet */ }

      const elapsed = Date.now() - start;
      const pct = Math.min(95, Math.round((elapsed / totalTime) * 100));

      // Switch to next strategy if current one has had enough time
      const currentStrategyElapsed = elapsed - (strategyIdx * perStrategyTime);
      if (currentStrategyElapsed >= perStrategyTime && strategyIdx < strategies.length - 1) {
        strategyIdx++;
        const strategy = strategies[strategyIdx];
        const msgs: Record<string, string> = {
          cli: 'Trying Docker CLI...',
          reopen: 'Restarting Docker Desktop...',
          background: 'Trying direct launch...',
          service: 'Trying service command...',
          snap: 'Trying snap...',
        };
        this.onProgress(`__progress__:${pct}:${msgs[strategy] || 'Trying another approach...'}`);
        this.startDockerDaemon(strategy);
      } else {
        // Regular progress update
        const msgs = [
          'Starting Docker...',
          'Waiting for Docker engine...',
          'Docker is loading...',
          'Almost there...',
          'Still starting up...',
          'First launch takes a bit longer...',
          'Hang tight...',
        ];
        const msgIdx = Math.floor(elapsed / 10_000) % msgs.length;
        this.onProgress(`__progress__:${pct}:${msgs[msgIdx]}`);
      }

      await new Promise(r => setTimeout(r, 3_000));
    }

    throw new Error('DOCKER_MANUAL_START');
  }

  /**
   * Start the Stalwart mail server Docker container.
   */
  async startStalwart(composePath: string): Promise<void> {
    if (!existsSync(composePath)) {
      throw new Error(`docker-compose.yml not found at: ${composePath}`);
    }

    // Ensure Docker daemon is running — start it if needed
    try {
      execFileSync('docker', ['info'], { timeout: 10_000, stdio: 'ignore' });
    } catch {
      this.onProgress('Starting Docker...');
      this.startDockerDaemon();
      await this.waitForDocker();
    }

    this.onProgress('__progress__:10:Pulling mail server image...');
    const composeResult = await runWithRollingOutput('docker', ['compose', '-f', composePath, 'up', '-d'], { timeout: 120_000 });
    if (composeResult.exitCode !== 0) {
      throw new Error('Failed to start mail server container. Check Docker is running.');
    }

    this.onProgress('__progress__:60:Waiting for mail server to start...');

    // Wait for Stalwart to be running (up to 30s)
    const maxWait = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const pct = 60 + Math.round((Date.now() - start) / maxWait * 35);
      this.onProgress(`__progress__:${Math.min(95, pct)}:Starting mail server...`);
      try {
        const output = execFileSync('docker', ['ps', '--filter', 'name=agenticmail-stalwart', '--format', '{{.Status}}'],
          { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString().trim();
        if (output.toLowerCase().includes('up')) {
          this.onProgress('__progress__:100:Mail server ready!');
          return;
        }
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 2_000));
    }

    throw new Error('Stalwart container failed to start. Run `docker compose up -d` manually to see errors.');
  }

  /**
   * Download and install cloudflared to ~/.agenticmail/bin/cloudflared.
   * Returns the path to the installed binary.
   */
  async installCloudflared(): Promise<string> {
    const binDir = join(homedir(), '.agenticmail', 'bin');
    const binPath = join(binDir, 'cloudflared');

    if (existsSync(binPath)) {
      return binPath;
    }

    // Also check if system-wide cloudflared exists
    try {
      const sysPath = execFileSync('which', ['cloudflared'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (sysPath && existsSync(sysPath)) return sysPath;
    } catch { /* not found system-wide */ }

    this.onProgress('Downloading cloudflared...');
    await mkdir(binDir, { recursive: true });

    const os = platform();
    const cpu = arch();
    const archName = cpu === 'arm64' ? 'arm64' : 'amd64';

    // macOS uses .tgz archives, Linux uses raw binaries
    const isTgz = os === 'darwin';
    const ext = isTgz ? '.tgz' : '';
    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${archName}${ext}`;

    if (os !== 'darwin' && os !== 'linux') {
      throw new Error(`Unsupported platform: ${os}/${cpu}`);
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download cloudflared: ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (isTgz) {
      // macOS: extract binary from .tgz archive
      const tgzPath = join(binDir, 'cloudflared.tgz');
      await writeFile(tgzPath, buffer);
      try {
        execFileSync('tar', ['-xzf', tgzPath, '-C', binDir, 'cloudflared'], { timeout: 15_000, stdio: 'ignore' });
        await chmod(binPath, 0o755);
      } finally {
        // Clean up the archive
        try { await unlink(tgzPath); } catch { /* ignore */ }
      }
    } else {
      // Linux: raw binary
      const tmpPath = binPath + '.tmp';
      await writeFile(tmpPath, buffer);
      await chmod(tmpPath, 0o755);
      await rename(tmpPath, binPath);
    }

    if (!existsSync(binPath)) {
      throw new Error('cloudflared download succeeded but binary not found after extraction');
    }

    this.onProgress('cloudflared installed');
    return binPath;
  }

  /**
   * Install all dependencies. Checks each one and installs if missing.
   */
  async installAll(composePath: string): Promise<void> {
    await this.installDocker();
    await this.startStalwart(composePath);
    await this.installCloudflared();
  }
}
