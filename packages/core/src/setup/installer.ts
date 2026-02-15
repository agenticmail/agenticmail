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
   * Install Docker if not present.
   * Uses Homebrew on macOS, apt on Linux.
   */
  async installDocker(): Promise<void> {
    // Check if already installed
    try {
      execSync('docker --version', { timeout: 5_000, stdio: 'ignore' });
      return;
    } catch { /* not installed */ }

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
      // Open Docker Desktop
      try {
        execSync('open -a Docker', { timeout: 10_000, stdio: 'ignore' });
      } catch { /* may already be starting */ }
      // Wait for Docker daemon to be ready
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
   * Wait for Docker daemon to be ready (up to 60s).
   */
  private async waitForDocker(): Promise<void> {
    this.onProgress('Waiting for Docker to be ready...');
    const maxWait = 60_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        execSync('docker info', { timeout: 5_000, stdio: 'ignore' });
        return;
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 3_000));
    }
    throw new Error('Docker is installed but the daemon did not start within 60s. Start Docker Desktop manually and try again.');
  }

  /**
   * Start the Stalwart mail server Docker container.
   */
  async startStalwart(composePath: string): Promise<void> {
    if (!existsSync(composePath)) {
      throw new Error(`docker-compose.yml not found at: ${composePath}`);
    }

    // Ensure Docker daemon is running
    try {
      execSync('docker info', { timeout: 10_000, stdio: 'ignore' });
    } catch {
      throw new Error('Docker is not running. Please start Docker Desktop first.');
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
    let downloadUrl: string;

    if (os === 'darwin') {
      downloadUrl = cpu === 'arm64'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64';
    } else if (os === 'linux') {
      downloadUrl = cpu === 'arm64'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    } else {
      throw new Error(`Unsupported platform: ${os}/${cpu}`);
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download cloudflared: ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpPath = binPath + '.tmp';
    await writeFile(tmpPath, buffer);
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, binPath);

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
