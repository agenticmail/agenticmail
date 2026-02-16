import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, rename, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

export type InstallProgress = (message: string) => void;

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
   * Installs Docker if not present (Homebrew on macOS, apt on Linux).
   * Starts the daemon if Docker CLI is present but daemon is stopped.
   */
  async installDocker(): Promise<void> {
    // Check if CLI is installed
    let cliInstalled = false;
    try {
      execSync('docker --version', { timeout: 5_000, stdio: 'ignore' });
      cliInstalled = true;
    } catch { /* not installed */ }

    if (cliInstalled) {
      // CLI exists — check if daemon is running
      try {
        execSync('docker info', { timeout: 10_000, stdio: 'ignore' });
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
      // macOS: install via Homebrew cask
      this.onProgress('Installing Docker via Homebrew...');
      try {
        execSync('brew --version', { timeout: 5_000, stdio: 'ignore' });
      } catch {
        throw new Error('Homebrew is required to install Docker on macOS. Install it from https://brew.sh then try again.');
      }
      execSync('brew install --cask docker', { timeout: 300_000, stdio: 'inherit' });
      this.onProgress('Docker installed. Starting Docker Desktop...');
      this.startDockerDaemon();
      await this.waitForDocker();
    } else if (os === 'linux') {
      // Linux: install via apt or official script
      this.onProgress('Installing Docker...');
      try {
        execSync('curl -fsSL https://get.docker.com | sh', { timeout: 300_000, stdio: 'inherit' });
      } catch {
        throw new Error('Failed to install Docker. Install it manually: https://docs.docker.com/get-docker/');
      }
      await this.waitForDocker();
    } else {
      throw new Error(`Automatic Docker installation not supported on ${os}. Install it manually: https://docs.docker.com/get-docker/`);
    }
  }

  /**
   * Attempt to start the Docker daemon.
   * On macOS: opens Docker Desktop app.
   * On Linux: tries systemctl.
   */
  private startDockerDaemon(): void {
    const os = platform();
    if (os === 'darwin') {
      // Try Docker Desktop app
      try { execSync('open -a Docker', { timeout: 10_000, stdio: 'ignore' }); } catch { /* may already be starting */ }
    } else if (os === 'linux') {
      try { execSync('sudo systemctl start docker', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }

  /**
   * Wait for Docker daemon to be ready (up to 3 minutes).
   * Docker Desktop can take 1-2+ minutes on first launch.
   */
  private async waitForDocker(): Promise<void> {
    this.onProgress('Waiting for Docker to start (this can take a minute)...');
    const maxWait = 180_000; // 3 minutes
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < maxWait) {
      try {
        execSync('docker info', { timeout: 5_000, stdio: 'ignore' });
        return;
      } catch { /* not ready yet */ }
      attempts++;
      if (attempts % 5 === 0) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        this.onProgress(`Still waiting for Docker to start (${elapsed}s)...`);
      }
      await new Promise(r => setTimeout(r, 3_000));
    }
    throw new Error(
      'Docker daemon did not start in time. Open Docker Desktop manually, wait for it to finish loading, then run this again.'
    );
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
      execSync('docker info', { timeout: 10_000, stdio: 'ignore' });
    } catch {
      this.onProgress('Starting Docker...');
      this.startDockerDaemon();
      await this.waitForDocker();
    }

    this.onProgress('Starting Stalwart mail server...');
    execSync(`docker compose -f "${composePath}" up -d`, {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for Stalwart to be running (up to 30s)
    const maxWait = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const output = execSync(
          'docker ps --filter name=agenticmail-stalwart --format "{{.Status}}"',
          { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString().trim();
        if (output.toLowerCase().includes('up')) {
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
      const sysPath = execSync('which cloudflared', { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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
        execSync(`tar -xzf "${tgzPath}" -C "${binDir}" cloudflared`, { timeout: 15_000, stdio: 'ignore' });
        await chmod(binPath, 0o755);
      } finally {
        // Clean up the archive
        try { execSync(`rm -f "${tgzPath}"`, { stdio: 'ignore' }); } catch { /* ignore */ }
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
