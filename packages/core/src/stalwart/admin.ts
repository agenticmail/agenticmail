import type { StalwartPrincipal, StalwartListResponse, StalwartPrincipalResponse } from './types.js';

/** Escape a string for safe interpolation into a TOML double-quoted value. */
function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Validate a domain name format (basic RFC 1035 check). */
function isValidDomain(domain: string): boolean {
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(domain);
}

export interface StalwartAdminOptions {
  url: string;
  adminUser: string;
  adminPassword: string;
}

export class StalwartAdmin {
  private baseUrl: string;
  private authHeader: string;

  constructor(private options: StalwartAdminOptions) {
    this.baseUrl = options.url.replace(/\/$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${options.adminUser}:${options.adminPassword}`).toString('base64');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stalwart API error ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const json = await response.json() as any;
      // Stalwart may return 200 with an error body (e.g., domain not found)
      if (json.error) {
        throw new Error(`Stalwart API error: ${json.error} (${json.item ?? json.details ?? ''})`);
      }
      return json as T;
    }
    return undefined as unknown as T;
  }

  async createPrincipal(principal: StalwartPrincipal): Promise<void> {
    await this.request('POST', '/principal', principal);
  }

  async getPrincipal(name: string): Promise<StalwartPrincipal> {
    const res = await this.request<StalwartPrincipalResponse>('GET', `/principal/${encodeURIComponent(name)}`);
    if (!res?.data) throw new Error(`Principal "${name}" not found or returned empty data`);
    return res.data;
  }

  async updatePrincipal(name: string, changes: Partial<StalwartPrincipal>): Promise<void> {
    // Stalwart PATCH expects an array of change operations, not a flat object
    const ops: Array<{ action: string; field: string; value: unknown }> = [];
    for (const [field, value] of Object.entries(changes)) {
      if (Array.isArray(value)) {
        // For array fields (emails, roles, secrets), set the whole array
        ops.push({ action: 'set', field, value });
      } else {
        ops.push({ action: 'set', field, value });
      }
    }
    await this.request('PATCH', `/principal/${encodeURIComponent(name)}`, ops);
  }

  /** Add an email alias to a principal without removing existing ones */
  async addEmailAlias(name: string, email: string): Promise<void> {
    await this.request('PATCH', `/principal/${encodeURIComponent(name)}`, [
      { action: 'addItem', field: 'emails', value: email },
    ]);
  }

  async deletePrincipal(name: string): Promise<void> {
    await this.request('DELETE', `/principal/${encodeURIComponent(name)}`);
  }

  async listPrincipals(type?: string): Promise<string[]> {
    const query = type ? `?type=${type}` : '';
    const res = await this.request<StalwartListResponse>('GET', `/principal${query}`);
    return res?.data?.items ?? [];
  }

  /** Ensure a domain exists in Stalwart (create if missing). */
  async ensureDomain(domain: string): Promise<void> {
    try {
      await this.getPrincipal(domain);
    } catch (err) {
      // Only create if the error indicates the domain wasn't found
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found') || msg.includes('notFound') || msg.includes('404')) {
        await this.request('POST', '/principal', { type: 'domain', name: domain });
      } else {
        throw err; // Re-throw network/auth errors
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  // --- Settings API ---

  /** Get a Stalwart setting value. */
  async getSetting(key: string): Promise<string | undefined> {
    const res = await this.request<{ data: { total: number; items: Record<string, string> } }>(
      'GET', `/settings/list?prefix=${encodeURIComponent(key)}`,
    );
    return res?.data?.items?.[key];
  }

  /** Get all settings under a prefix. */
  async getSettings(prefix: string): Promise<Record<string, string>> {
    const res = await this.request<{ data: { total: number; items: Record<string, string> } }>(
      'GET', `/settings/list?prefix=${encodeURIComponent(prefix)}`,
    );
    return res?.data?.items ?? {};
  }

  // --- Configuration ---

  /**
   * Set a Stalwart configuration value via stalwart-cli.
   * Note: stalwart-cli may return a 500 error even when the operation succeeds.
   * We verify by listing the config afterwards.
   */
  private cliArgs(): string[] {
    const creds = `${this.options.adminUser}:${this.options.adminPassword}`;
    return ['exec', 'agenticmail-stalwart', 'stalwart-cli', '-u', 'http://localhost:8080', '-c', creds];
  }

  async updateSetting(key: string, value: string): Promise<void> {
    const { execFileSync } = await import('node:child_process');
    const cli = this.cliArgs();

    // Delete first (ignore errors — may not exist yet)
    try {
      execFileSync('docker', [...cli, 'server', 'delete-config', key],
        { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch { /* may not exist yet */ }

    // Add the new value (stalwart-cli may return 500 but still succeed)
    try {
      execFileSync('docker', [...cli, 'server', 'add-config', key, value],
        { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // Verify it was set by listing the config prefix
      const output = execFileSync('docker', [...cli, 'server', 'list-config', key],
        { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString();

      if (!output.includes(value)) {
        throw new Error(`Failed to set config ${key}=${value}`);
      }
    }
  }

  /**
   * Set the server hostname used in SMTP EHLO greetings.
   * Critical for email deliverability — must match the sending domain.
   */
  async setHostname(domain: string): Promise<void> {
    if (!isValidDomain(domain)) {
      throw new Error(`Invalid domain format: "${domain}"`);
    }

    const { readFileSync, writeFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    // Stalwart's server.hostname is in config.toml (not overridable via CLI/API).
    // The config is mounted read-only from the host, so we modify the host file.
    // Caller is responsible for restarting the container after all config changes.
    const configPath = join(homedir(), '.agenticmail', 'stalwart.toml');
    try {
      let config = readFileSync(configPath, 'utf-8');
      config = config.replace(/^hostname\s*=\s*"[^"]*"/m, `hostname = "${escapeTomlString(domain)}"`);
      writeFileSync(configPath, config);
      console.log(`[Stalwart] Updated hostname to "${domain}" in stalwart.toml`);
    } catch (err) {
      throw new Error(`Failed to set config server.hostname=${domain}`);
    }
  }

  // --- DKIM ---

  /** Path to the host-side stalwart.toml (mounted read-only into container) */
  private get configPath(): string {
    const { homedir } = require('node:os');
    const { join } = require('node:path');
    return join(homedir(), '.agenticmail', 'stalwart.toml');
  }

  /** Path to host-side DKIM key directory */
  private get dkimDir(): string {
    const { homedir } = require('node:os');
    const { join } = require('node:path');
    return join(homedir(), '.agenticmail');
  }

  /**
   * Create/reuse a DKIM signing key for a domain.
   * Uses stalwart-cli to generate the key and store config in Stalwart's DB.
   * Returns the public key (base64, no headers) for DNS TXT record.
   */
  async createDkimSignature(domain: string, selector = 'agenticmail'): Promise<{ signatureId: string; publicKey: string }> {
    const { execFileSync } = await import('node:child_process');

    const signatureId = `agenticmail-${domain.replace(/\./g, '-')}`;
    const cli = this.cliArgs();

    // Check if signature already exists in DB
    const existing = await this.getSettings(`signature.${signatureId}`);
    if (existing['private-key'] && existing['domain']) {
      console.log(`[DKIM] Reusing existing signature "${signatureId}" from Stalwart DB`);
    } else {
      // Delete any partial config first
      try {
        execFileSync('docker', [...cli, 'server', 'delete-config', `signature.${signatureId}`], {
          timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* may not exist */ }

      // Use stalwart-cli dkim create — generates key and stores in DB
      console.log(`[DKIM] Creating RSA signature for ${domain} via stalwart-cli`);
      try {
        execFileSync('docker', [...cli, 'dkim', 'create', 'rsa', domain, signatureId, selector], {
          timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        throw new Error(`Failed to create DKIM signature: ${(err as Error).message}`);
      }
    }

    // Set auth.dkim.sign rule if not already set
    const signRule = await this.getSettings('auth.dkim.sign');
    if (!Object.keys(signRule).length) {
      console.log(`[DKIM] Configuring DKIM signing rule`);
      const rules: [string, string][] = [
        ['auth.dkim.sign.0000.if', `listener != 'smtp'`],
        ['auth.dkim.sign.0000.then', `['${signatureId}']`],
        ['auth.dkim.sign.0001.else', 'false'],
      ];
      for (const [key, value] of rules) {
        execFileSync('docker', [...cli, 'server', 'add-config', key, value], {
          timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    }

    // Get the public key via stalwart-cli
    let publicKey: string;
    try {
      const output = execFileSync('docker', [...cli, 'dkim', 'get-public-key', signatureId], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      // Output format: Public DKIM key for signature ...: "BASE64KEY"
      const match = output.match(/"([A-Za-z0-9+/=]+)"/);
      if (!match) throw new Error(`Unexpected output: ${output}`);
      publicKey = match[1];
    } catch (err) {
      throw new Error(`Failed to get DKIM public key: ${(err as Error).message}`);
    }

    // Reload config (no restart needed — DB config is hot-reloadable)
    try {
      execFileSync('docker', [...cli, 'server', 'reload-config'], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* best effort */ }

    console.log(`[DKIM] DKIM signature "${signatureId}" ready for ${domain}`);
    return { signatureId, publicKey };
  }

  /**
   * Restart the Stalwart Docker container and wait for it to be ready.
   */
  private async restartContainer(): Promise<void> {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('docker', ['restart', 'agenticmail-stalwart'], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      for (let i = 0; i < 15; i++) {
        try {
          const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
          if (res.ok) return;
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 1_000));
      }
    } catch { /* restart best-effort */ }
  }

  /**
   * Check if a DKIM signature exists for a domain (checks Stalwart DB).
   */
  async hasDkimSignature(domain: string): Promise<boolean> {
    const signatureId = `agenticmail-${domain.replace(/\./g, '-')}`;
    const existing = await this.getSettings(`signature.${signatureId}`);
    return !!(existing['private-key'] && existing['domain']);
  }

  /**
   * Configure Gmail SMTP as outbound relay (smarthost).
   * Routes all non-local mail through smtp.gmail.com using app password auth.
   * This bypasses the need for a PTR record on the sending IP.
   */
  async configureOutboundRelay(config: {
    smtpHost: string;
    smtpPort: number;
    username: string;
    password: string;
    routeName?: string;
  }): Promise<void> {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    const routeName = config.routeName ?? 'gmail';
    const tomlPath = join(homedir(), '.agenticmail', 'stalwart.toml');

    // Read existing TOML
    let toml = readFileSync(tomlPath, 'utf-8');

    // Remove any existing relay route and strategy sections (to avoid duplicates)
    toml = toml.replace(/\n\[queue\.route\.gmail\][\s\S]*?(?=\n\[|$)/, '');
    toml = toml.replace(/\n\[queue\.strategy\][\s\S]*?(?=\n\[|$)/, '');

    // Append relay route config (escape all user-supplied values to prevent TOML injection)
    const safeRouteName = routeName.replace(/[^a-zA-Z0-9_-]/g, '');
    toml += `

[queue.route.${safeRouteName}]
description = "Gmail SMTP relay for outbound delivery"
type = "relay"
address = "${escapeTomlString(config.smtpHost)}"
port = ${Number(config.smtpPort) || 465}
protocol = "smtp"
tls.implicit = true
auth.username = "${escapeTomlString(config.username)}"
auth.secret = "${escapeTomlString(config.password)}"

[queue.strategy]
route = [ { if = "is_local_domain('', rcpt_domain)", then = "'local'" },
           { else = "'${safeRouteName}'" } ]
`;

    writeFileSync(tomlPath, toml, 'utf-8');

    // Restart Stalwart to pick up new config
    await this.restartContainer();
  }
}
