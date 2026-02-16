import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { mkdir, chmod } from 'node:fs/promises';
import { CloudflareClient } from './cloudflare.js';

export interface TunnelConfig {
  tunnelId: string;
  tunnelToken: string;
}

export interface TunnelIngress {
  hostname: string;
  service: string;
}

/**
 * TunnelManager handles the Cloudflare Tunnel lifecycle:
 * downloading cloudflared, creating/starting tunnels, and routing ingress.
 */
export class TunnelManager {
  private process: ChildProcess | null = null;
  private running = false;
  private binPath: string;

  constructor(private cf: CloudflareClient) {
    this.binPath = join(homedir(), '.agenticmail', 'bin', 'cloudflared');
  }

  /**
   * Find or download the cloudflared binary.
   * Checks: managed binary → system-wide → download.
   */
  async install(): Promise<string> {
    if (existsSync(this.binPath)) {
      return this.binPath;
    }

    // Check if cloudflared is available system-wide (e.g. via Homebrew)
    try {
      const { execFileSync } = await import('node:child_process');
      const sysPath = execFileSync('which', ['cloudflared'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (sysPath && existsSync(sysPath)) {
        this.binPath = sysPath;
        return sysPath;
      }
    } catch { /* not found system-wide */ }

    const binDir = join(homedir(), '.agenticmail', 'bin');
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
    const { writeFile, rename } = await import('node:fs/promises');
    // Atomic install: write to temp file, then rename
    const tmpPath = this.binPath + '.tmp';
    await writeFile(tmpPath, buffer);
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, this.binPath);

    return this.binPath;
  }

  /**
   * Create a new Cloudflare Tunnel via the API.
   * If a tunnel with the same name already exists, reuse it.
   */
  async create(name: string): Promise<TunnelConfig> {
    // Check if a tunnel with this name already exists
    const existing = await this.cf.listTunnels();
    const match = existing.find(t => t.name === name && !t.deleted_at);

    let tunnelId: string;
    if (match) {
      tunnelId = match.id;
    } else {
      const tunnel = await this.cf.createTunnel(name);
      tunnelId = tunnel.id;
    }

    const token = await this.cf.getTunnelToken(tunnelId);
    return {
      tunnelId,
      tunnelToken: token,
    };
  }

  /**
   * Start the cloudflared tunnel process.
   */
  async start(tunnelToken: string): Promise<void> {
    if (this.running) return;

    const bin = await this.install();

    // Pass token via environment variable instead of command line (not visible in ps)
    this.process = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token', tunnelToken], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
    });

    // Wait for tunnel to establish connection
    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new Error('Tunnel startup timed out')); }
      }, 30_000);

      const onData = (data: Buffer) => {
        const line = data.toString();
        if (!resolved && (line.includes('Registered tunnel connection') || line.includes('Connection registered'))) {
          resolved = true;
          clearTimeout(timeout);
          this.running = true;
          resolve();
        }
      };

      this.process!.stderr?.on('data', onData);
      this.process!.stdout?.on('data', onData);

      this.process!.on('error', (err) => {
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
      });

      this.process!.on('exit', (code) => {
        this.running = false;
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`cloudflared exited with code ${code}`)); }
      });
    });
  }

  /**
   * Configure tunnel ingress rules: route mail.{domain} → SMTP, {domain} → HTTP
   */
  async createIngress(tunnelId: string, domain: string, smtpPort = 25, httpPort = 8080, apiPort = 3100): Promise<void> {
    // Use the Cloudflare API to set tunnel configuration
    // Routes /api/agenticmail/* to the API server, everything else to Stalwart
    await this.cf.createTunnelRoute(tunnelId, domain, `http://localhost:${httpPort}`, {
      apiService: `http://localhost:${apiPort}`,
    });
  }

  /**
   * Stop the running cloudflared process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      const p = this.process;
      this.process = null;
      p.kill('SIGTERM');
      // Wait for process to actually exit (with timeout)
      await Promise.race([
        new Promise<void>(resolve => p.on('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
      this.running = false;
    }
  }

  /**
   * Check if the tunnel is currently running.
   */
  status(): { running: boolean; pid?: number } {
    return {
      running: this.running,
      pid: this.process?.pid,
    };
  }

  /**
   * Check tunnel health via the Cloudflare API.
   */
  async healthCheck(tunnelId: string): Promise<{ healthy: boolean; status: string }> {
    try {
      const tunnel = await this.cf.getTunnel(tunnelId);
      return {
        healthy: tunnel.connections.length > 0,
        status: tunnel.status,
      };
    } catch {
      return { healthy: false, status: 'unknown' };
    }
  }
}
