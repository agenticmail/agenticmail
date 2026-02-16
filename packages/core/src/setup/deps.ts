import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DependencyStatus {
  name: string;
  installed: boolean;
  version?: string;
  description: string;
}

/**
 * DependencyChecker detects which external tools are available.
 * All dependencies are required — setup will auto-install any missing ones.
 */
export class DependencyChecker {
  async checkAll(): Promise<DependencyStatus[]> {
    return Promise.all([
      this.checkDocker(),
      this.checkStalwart(),
      this.checkCloudflared(),
    ]);
  }

  async checkDocker(): Promise<DependencyStatus> {
    try {
      const output = execFileSync('docker', ['--version'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const match = output.match(/Docker version ([\d.]+)/);
      return {
        name: 'docker',
        installed: true,
        version: match?.[1],
        description: 'Container runtime for Stalwart mail server',
      };
    } catch {
      return {
        name: 'docker',
        installed: false,
        description: 'Container runtime for Stalwart mail server',
      };
    }
  }

  async checkStalwart(): Promise<DependencyStatus> {
    try {
      const output = execFileSync('docker', ['ps', '--filter', 'name=agenticmail-stalwart', '--format', '{{.Status}}'],
        { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim();
      const running = output.length > 0 && output.toLowerCase().includes('up');
      return {
        name: 'stalwart',
        installed: running,
        version: running ? 'running' : undefined,
        description: 'Stalwart mail server (Docker container)',
      };
    } catch {
      return {
        name: 'stalwart',
        installed: false,
        description: 'Stalwart mail server (Docker container)',
      };
    }
  }

  async checkCloudflared(): Promise<DependencyStatus> {
    // Check our managed binary first
    const binPath = join(homedir(), '.agenticmail', 'bin', 'cloudflared');
    if (existsSync(binPath)) {
      let version: string | undefined;
      try {
        const output = execFileSync(binPath, ['--version'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const match = output.match(/cloudflared version ([\d.]+)/);
        version = match?.[1];
      } catch { /* ignore */ }
      return { name: 'cloudflared', installed: true, version, description: 'Cloudflare Tunnel for custom domain email' };
    }

    // Check system-wide (e.g. installed via Homebrew)
    try {
      const output = execFileSync('cloudflared', ['--version'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const match = output.match(/cloudflared version ([\d.]+)/);
      return { name: 'cloudflared', installed: true, version: match?.[1], description: 'Cloudflare Tunnel for custom domain email' };
    } catch {
      return { name: 'cloudflared', installed: false, description: 'Cloudflare Tunnel for custom domain email' };
    }
  }
}
