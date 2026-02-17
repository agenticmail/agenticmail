import { execFileSync, execSync, spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';

export type InstallProgress = (message: string) => void;

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
 * Run a command silently — all output suppressed.
 * Only returns exit code and captured output (for error diagnosis).
 * Does NOT write anything to stdout/stderr.
 */
function runSilent(
  command: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ exitCode: number; fullOutput: string }> {
  const timeout = opts.timeout ?? 300_000;
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    let fullOutput = '';
    child.stdout?.on('data', (d: Buffer) => { fullOutput += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { fullOutput += d.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, fullOutput }));
    child.on('error', reject);
  });
}

/**
 * Check if Homebrew is available.
 */
function hasHomebrew(): boolean {
  try {
    execFileSync('brew', ['--version'], { timeout: 5_000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Check if a command exists in PATH.
 */
function hasCommand(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { timeout: 5_000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * DependencyInstaller handles installing all external dependencies.
 * Uses Colima + Docker CLI on macOS (no Docker Desktop GUI).
 * Uses Docker Engine directly on Linux.
 */
export class DependencyInstaller {
  private onProgress: InstallProgress;

  constructor(onProgress?: InstallProgress) {
    this.onProgress = onProgress ?? (() => {});
  }

  /**
   * Ensure Docker is installed AND the daemon is running.
   *
   * Flow:
   *   1. docker info works? → done
   *   2. docker CLI + colima exist but not running? → colima start
   *   3. Nothing installed? → install via brew (colima + docker) or Docker Engine (Linux)
   */
  async installDocker(): Promise<void> {
    if (this.isDockerReady()) return;

    const os = platform();
    if (os === 'darwin') {
      await this.installDockerMac();
    } else if (os === 'linux') {
      await this.installDockerLinux();
    } else if (os === 'win32') {
      await this.installDockerWindows();
    } else {
      throw new Error(
        `Docker auto-install isn't supported on ${os} yet. ` +
        `Install it from https://docs.docker.com/get-docker/ and try again.`,
      );
    }
  }

  /** Check if `docker info` succeeds (CLI + daemon both working). */
  private isDockerReady(): boolean {
    try {
      execFileSync('docker', ['info'], { timeout: 10_000, stdio: 'ignore' });
      return true;
    } catch { return false; }
  }

  /**
   * macOS: Install Docker via Colima (CLI-only, no GUI, no license dialogs).
   * Installs colima + docker + docker-compose via Homebrew, then starts Colima.
   */
  private async installDockerMac(): Promise<void> {
    // If colima is installed and docker CLI exists, just start colima
    if (hasCommand('colima') && hasCommand('docker')) {
      this.onProgress('__progress__:10:Starting container engine...');
      await this.startColima();
      return;
    }

    // Need to install — requires Homebrew
    if (!hasHomebrew()) {
      throw new Error(
        'Homebrew is required to install Docker on macOS.\n' +
        'Install it from https://brew.sh and try again.',
      );
    }

    // Install colima + docker + docker-compose
    this.onProgress('__progress__:5:Installing container engine...');

    const brewResult = await runSilent(
      'brew', ['install', 'colima', 'docker', 'docker-compose'],
      { timeout: 600_000 },
    );

    if (brewResult.exitCode !== 0) {
      throw new Error(
        'Failed to install Docker via Homebrew.\n' +
        'Try running manually: brew install colima docker docker-compose\n' +
        brewResult.fullOutput.slice(-500),
      );
    }

    if (!hasCommand('colima') || !hasCommand('docker')) {
      throw new Error(
        'Installation completed but colima/docker not found in PATH.\n' +
        'Try running manually: brew install colima docker docker-compose',
      );
    }

    // Link docker-compose as a Docker CLI plugin so `docker compose` works
    this.linkComposePlugin();

    // Start Colima
    this.onProgress('__progress__:50:Starting container engine...');
    await this.startColima();
  }

  /**
   * Link docker-compose as a Docker CLI plugin so `docker compose` (v2 syntax) works.
   * Brew installs docker-compose as a standalone binary, but many tools expect
   * the `docker compose` subcommand.
   */
  private linkComposePlugin(): void {
    try {
      const composeBin = execFileSync('which', ['docker-compose'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!composeBin) return;

      const pluginDir = join(homedir(), '.docker', 'cli-plugins');
      const pluginPath = join(pluginDir, 'docker-compose');

      if (existsSync(pluginPath)) return; // already linked

      try { mkdirSync(pluginDir, { recursive: true }); } catch { /* ignore */ }
      try { symlinkSync(composeBin, pluginPath); } catch { /* ignore */ }
    } catch { /* non-fatal */ }
  }

  /**
   * Start Colima and wait for Docker to be ready.
   */
  private async startColima(): Promise<void> {
    // Check if already running
    if (this.isDockerReady()) {
      this.onProgress('__progress__:100:Engine is ready!');
      return;
    }

    // Start colima with reasonable defaults for a mail server
    const startResult = await runSilent(
      'colima', ['start', '--cpu', '2', '--memory', '2', '--disk', '10'],
      { timeout: 300_000 },
    );

    if (startResult.exitCode !== 0) {
      throw new Error(
        'Failed to start Colima. Try running manually: colima start\n' +
        startResult.fullOutput.slice(-500),
      );
    }

    // Wait for Docker daemon to be ready
    const totalTime = 60_000; // 1 minute should be plenty for Colima
    const start = Date.now();

    while (Date.now() - start < totalTime) {
      if (this.isDockerReady()) {
        this.onProgress('__progress__:100:Engine is ready!');
        return;
      }

      const elapsed = Date.now() - start;
      const pct = Math.min(95, 50 + Math.round((elapsed / totalTime) * 50));
      this.onProgress(`__progress__:${pct}:Waiting for engine...`);
      await new Promise(r => setTimeout(r, 2_000));
    }

    throw new Error(
      'Docker engine did not start in time. Try running manually: colima start',
    );
  }

  /**
   * Install Docker Engine on Linux using Docker's official convenience script.
   * Also adds the current user to the docker group for rootless usage.
   */
  private async installDockerLinux(): Promise<void> {
    // If docker CLI exists but daemon not running, try starting it
    if (hasCommand('docker')) {
      this.onProgress('__progress__:10:Starting Docker service...');
      try {
        execSync('sudo systemctl start docker', { timeout: 15_000, stdio: 'ignore' });
      } catch {
        try { execSync('sudo service docker start', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
      }
      await this.waitForDockerLinux();
      return;
    }

    this.onProgress('__progress__:5:Installing Docker Engine...');

    // Download Docker install script to private tmp dir (not world-writable /tmp)
    const tmpDir = join(homedir(), '.agenticmail', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const scriptPath = join(tmpDir, 'install-docker.sh');

    const dlResult = await runShellWithRollingOutput(
      `curl -fsSL https://get.docker.com -o "${scriptPath}" && sudo sh "${scriptPath}"`,
      { timeout: 300_000 },
    );
    if (dlResult.exitCode !== 0) {
      throw new Error(
        'Failed to install Docker Engine. You may need sudo privileges.\n' +
        'Manual install: https://docs.docker.com/engine/install/',
      );
    }

    // Add current user to docker group (validate username to prevent injection)
    const user = process.env.USER || process.env.LOGNAME || '';
    if (user && user !== 'root' && /^[a-zA-Z0-9._-]+$/.test(user)) {
      this.onProgress('__progress__:80:Adding user to docker group...');
      try {
        execFileSync('sudo', ['usermod', '-aG', 'docker', user], { timeout: 10_000, stdio: 'ignore' });
      } catch { /* non-fatal */ }
    }

    try { await unlink(scriptPath); } catch { /* ignore */ }

    this.onProgress('__progress__:85:Starting Docker service...');
    try {
      execSync('sudo systemctl enable --now docker', { timeout: 15_000, stdio: 'ignore' });
    } catch {
      try { execSync('sudo service docker start', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
    }

    await this.waitForDockerLinux();
  }

  /**
   * Wait for Docker daemon on Linux.
   */
  private async waitForDockerLinux(): Promise<void> {
    const totalTime = 60_000;
    const start = Date.now();

    while (Date.now() - start < totalTime) {
      if (this.isDockerReady()) {
        this.onProgress('__progress__:100:Docker is ready!');
        return;
      }
      const elapsed = Date.now() - start;
      const pct = Math.min(95, Math.round((elapsed / totalTime) * 100));
      this.onProgress(`__progress__:${pct}:Waiting for Docker...`);
      await new Promise(r => setTimeout(r, 2_000));
    }

    throw new Error('Docker did not start. Try: sudo systemctl start docker');
  }

  /**
   * Windows: Install Docker via WSL2 + Docker Engine, or guide user to Docker Desktop.
   * Prefers WSL2 with Docker Engine (no GUI needed).
   */
  private async installDockerWindows(): Promise<void> {
    // If docker CLI exists, try to use it
    if (hasCommand('docker')) {
      if (this.isDockerReady()) {
        this.onProgress('__progress__:100:Engine is ready!');
        return;
      }
      // Docker installed but not running — try starting Docker Desktop service
      this.onProgress('__progress__:10:Starting Docker...');
      try {
        execSync('net start com.docker.service', { timeout: 30_000, stdio: 'ignore' });
      } catch { /* ignore */ }
      // Also try starting Docker Desktop if installed
      try {
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const dockerExe = join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe');
        if (existsSync(dockerExe)) {
          execSync(`start "" "${dockerExe}"`, { timeout: 10_000, stdio: 'ignore', shell: 'cmd.exe' });
        }
      } catch { /* ignore */ }

      await this.waitForDockerWindows();
      return;
    }

    // Check if WSL2 is available
    let hasWsl = false;
    try {
      const wslResult = execSync('wsl --status', { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      hasWsl = wslResult.length > 0;
    } catch { /* no WSL */ }

    if (hasWsl) {
      // Try installing Docker Engine inside WSL
      this.onProgress('__progress__:5:Installing Docker Engine in WSL...');
      try {
        const wslResult = await runSilent(
          'wsl', ['-e', 'sh', '-c', 'curl -fsSL https://get.docker.com | sh'],
          { timeout: 300_000 },
        );
        if (wslResult.exitCode === 0) {
          // Start Docker in WSL
          try { execSync('wsl -e sudo service docker start', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
          await this.waitForDockerWindows();
          return;
        }
      } catch { /* fall through */ }
    }

    // Check if winget is available for Docker Desktop install
    let hasWinget = false;
    try {
      execSync('winget --version', { timeout: 5_000, stdio: 'ignore' });
      hasWinget = true;
    } catch { /* no winget */ }

    if (hasWinget) {
      this.onProgress('__progress__:5:Installing Docker Desktop...');
      const wingetResult = await runSilent(
        'winget', ['install', '-e', '--id', 'Docker.DockerDesktop', '--accept-source-agreements', '--accept-package-agreements'],
        { timeout: 600_000 },
      );
      if (wingetResult.exitCode === 0) {
        this.onProgress('__progress__:70:Docker Desktop installed. Starting...');
        try {
          const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
          const dockerExe = join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe');
          if (existsSync(dockerExe)) {
            execSync(`start "" "${dockerExe}"`, { timeout: 10_000, stdio: 'ignore', shell: 'cmd.exe' });
          }
        } catch { /* ignore */ }
        await this.waitForDockerWindows();
        return;
      }
    }

    throw new Error(
      'Could not auto-install Docker on Windows.\n' +
      'Please install Docker Desktop from https://docs.docker.com/desktop/install/windows-install/\n' +
      'Or install WSL2 and Docker Engine: wsl --install && wsl -e sh -c "curl -fsSL https://get.docker.com | sh"',
    );
  }

  /**
   * Wait for Docker daemon on Windows.
   */
  private async waitForDockerWindows(): Promise<void> {
    const totalTime = 120_000; // 2 minutes — Docker Desktop on Windows can be slow
    const start = Date.now();

    while (Date.now() - start < totalTime) {
      if (this.isDockerReady()) {
        this.onProgress('__progress__:100:Docker is ready!');
        return;
      }
      const elapsed = Date.now() - start;
      const pct = Math.min(95, Math.round((elapsed / totalTime) * 100));
      this.onProgress(`__progress__:${pct}:Waiting for Docker...`);
      await new Promise(r => setTimeout(r, 3_000));
    }

    throw new Error(
      'Docker did not start in time.\n' +
      'Make sure Docker Desktop is running, then try again.',
    );
  }

  /**
   * Start the Stalwart mail server Docker container.
   */
  async startStalwart(composePath: string): Promise<void> {
    if (!existsSync(composePath)) {
      throw new Error(`docker-compose.yml not found at: ${composePath}`);
    }

    // Ensure Docker daemon is running
    if (!this.isDockerReady()) {
      this.onProgress('Starting Docker...');
      const os = platform();
      if (os === 'darwin') {
        await this.startColima();
      } else if (os === 'win32') {
        await this.waitForDockerWindows();
      } else {
        try {
          execSync('sudo systemctl start docker', { timeout: 15_000, stdio: 'ignore' });
        } catch {
          try { execSync('sudo service docker start', { timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
        }
        await this.waitForDockerLinux();
      }
    }

    this.onProgress('__progress__:10:Pulling mail server image...');

    // Link compose plugin if needed (for `docker compose` to work)
    if (platform() === 'darwin') this.linkComposePlugin();

    // Try `docker compose` first (v2 plugin), fallback to `docker-compose` (standalone)
    let composeResult = await runSilent('docker', ['compose', '-f', composePath, 'up', '-d'], { timeout: 120_000 });
    if (composeResult.exitCode !== 0 && hasCommand('docker-compose')) {
      composeResult = await runSilent('docker-compose', ['-f', composePath, 'up', '-d'], { timeout: 120_000 });
    }
    if (composeResult.exitCode !== 0) {
      throw new Error('Failed to start mail server container. Check Docker is running.');
    }

    this.onProgress('__progress__:60:Waiting for mail server to start...');

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
    const os = platform();
    const binDir = join(homedir(), '.agenticmail', 'bin');
    const binName = os === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binPath = join(binDir, binName);

    if (existsSync(binPath)) {
      return binPath;
    }

    // Also check if system-wide cloudflared exists
    try {
      const whichCmd = os === 'win32' ? 'where' : 'which';
      const sysPath = execFileSync(whichCmd, ['cloudflared'], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
      if (sysPath && existsSync(sysPath)) return sysPath;
    } catch { /* not found */ }

    this.onProgress('Downloading cloudflared...');
    await mkdir(binDir, { recursive: true });

    const cpu = arch();
    const archName = cpu === 'arm64' ? 'arm64' : 'amd64';

    let downloadUrl: string;
    if (os === 'darwin') {
      downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${archName}.tgz`;
    } else if (os === 'linux') {
      downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${archName}`;
    } else if (os === 'win32') {
      downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${archName}.exe`;
    } else {
      throw new Error(`Unsupported platform: ${os}/${cpu}`);
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download cloudflared: ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (os === 'darwin') {
      // macOS: extract from .tgz
      const tgzPath = join(binDir, 'cloudflared.tgz');
      await writeFile(tgzPath, buffer);
      try {
        execFileSync('tar', ['-xzf', tgzPath, '-C', binDir, 'cloudflared'], { timeout: 15_000, stdio: 'ignore' });
        await chmod(binPath, 0o755);
      } finally {
        try { await unlink(tgzPath); } catch { /* ignore */ }
      }
    } else {
      // Linux: raw binary, Windows: .exe — just write directly
      const tmpPath = binPath + '.tmp';
      await writeFile(tmpPath, buffer);
      if (os !== 'win32') await chmod(tmpPath, 0o755);
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
