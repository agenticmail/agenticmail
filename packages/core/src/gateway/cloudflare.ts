import type {
  CloudflareApiResponse,
  CloudflareZone,
  CloudflareDnsRecord,
  CloudflareTunnel,
  CloudflareDomainAvailability,
} from './types.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareClient {
  private token: string;
  private accountId: string;

  constructor(token: string, accountId: string) {
    this.token = token;
    this.accountId = accountId;
  }

  // --- Zone methods ---

  async listZones(): Promise<CloudflareZone[]> {
    const resp = await this.request<CloudflareZone[]>('GET', '/zones');
    return resp.result;
  }

  async getZone(domain: string): Promise<CloudflareZone | null> {
    const resp = await this.request<CloudflareZone[]>('GET', `/zones?name=${encodeURIComponent(domain)}`);
    return resp.result[0] ?? null;
  }

  async createZone(domain: string): Promise<CloudflareZone> {
    const resp = await this.request<CloudflareZone>('POST', '/zones', {
      name: domain,
      account: { id: this.accountId },
      type: 'full',
    });
    return resp.result;
  }

  // --- DNS methods ---

  async listDnsRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    const resp = await this.request<CloudflareDnsRecord[]>('GET', `/zones/${zoneId}/dns_records`);
    return resp.result;
  }

  async createDnsRecord(zoneId: string, record: {
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    proxied?: boolean;
  }): Promise<CloudflareDnsRecord> {
    const resp = await this.request<CloudflareDnsRecord>('POST', `/zones/${zoneId}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1, // 1 = auto
      priority: record.priority,
      proxied: record.proxied ?? false,
    });
    return resp.result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  }

  // --- Registrar methods ---

  async searchDomains(query: string): Promise<CloudflareDomainAvailability[]> {
    const resp = await this.request<CloudflareDomainAvailability[]>(
      'GET',
      `/accounts/${this.accountId}/registrar/domains?query=${encodeURIComponent(query)}`,
    );
    return resp.result;
  }

  async checkAvailability(domain: string): Promise<CloudflareDomainAvailability> {
    const resp = await this.request<any>(
      'GET',
      `/accounts/${this.accountId}/registrar/domains/${encodeURIComponent(domain)}`,
    );
    const result = resp.result ?? {};

    // Cloudflare Registrar GET endpoint returns different shapes:
    // - For registered domains (yours): { name, status, ... }
    // - For not-yet-registered domains: { name, supported_tld }
    // We detect availability by checking if the domain has registration fields
    const hasRegistration = !!(result.current_registrar || result.registry_statuses || result.locked);
    const isYours = result.current_registrar === 'Cloudflare' || result.current_registrar === 'cloudflare';

    // If the domain has registration data and it's not ours, it's taken
    // If it only has supported_tld, we need to do a whois check
    let available = false;
    if (result.supported_tld && !hasRegistration) {
      // Supported TLD but no registration info — likely available
      // Do a whois check to confirm
      try {
        const { execSync } = await import('node:child_process');
        const whoisOutput = execSync(`whois ${domain}`, { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().toLowerCase();
        available = whoisOutput.includes('domain not found') ||
                    whoisOutput.includes('no match') ||
                    whoisOutput.includes('not found') ||
                    whoisOutput.includes('no data found') ||
                    whoisOutput.includes('status: free') ||
                    whoisOutput.includes('no entries found');
      } catch {
        // whois failed, assume unavailable
        available = false;
      }
    }

    return {
      name: result.name ?? domain,
      available,
      premium: result.premium ?? false,
      price: result.price,
    };
  }

  async purchaseDomain(domain: string, autoRenew = true): Promise<{ domain: string; status: string }> {
    const resp = await this.request<{ domain: string; status: string }>(
      'POST',
      `/accounts/${this.accountId}/registrar/domains`,
      {
        name: domain,
        auto_renew: autoRenew,
      },
    );
    return resp.result;
  }

  async listRegisteredDomains(): Promise<Array<{ domain: string; status: string }>> {
    const resp = await this.request<Array<{ domain: string; status: string }>>(
      'GET',
      `/accounts/${this.accountId}/registrar/domains`,
    );
    return resp.result;
  }

  // --- Tunnel methods ---

  async createTunnel(name: string): Promise<CloudflareTunnel> {
    const resp = await this.request<CloudflareTunnel>(
      'POST',
      `/accounts/${this.accountId}/cfd_tunnel`,
      {
        name,
        tunnel_secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      },
    );
    return resp.result;
  }

  async getTunnel(tunnelId: string): Promise<CloudflareTunnel> {
    const resp = await this.request<CloudflareTunnel>(
      'GET',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`,
    );
    return resp.result;
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const resp = await this.request<string>(
      'GET',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    return resp.result;
  }

  async createTunnelRoute(tunnelId: string, hostname: string, service: string, options?: { apiService?: string }): Promise<void> {
    const ingress: Array<Record<string, string>> = [];

    // Route /api/agenticmail/* to the AgenticMail API server (separate port)
    if (options?.apiService) {
      ingress.push({ hostname, path: 'api/agenticmail/.*', service: options.apiService });
    }

    // Route everything else to the primary service (e.g. Stalwart)
    ingress.push({ hostname, service });
    ingress.push({ service: 'http_status:404' }); // catch-all

    await this.request(
      'PUT',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { config: { ingress } },
    );
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`,
    );
  }

  // --- Email Routing methods ---

  /** Enable Email Routing on a zone */
  async enableEmailRouting(zoneId: string): Promise<void> {
    await this.request('POST', `/zones/${zoneId}/email/routing/enable`);
  }

  /** Disable Email Routing on a zone (unlocks managed MX/SPF records for deletion) */
  async disableEmailRouting(zoneId: string): Promise<void> {
    await this.request('POST', `/zones/${zoneId}/email/routing/disable`);
  }

  /** Get Email Routing status for a zone */
  async getEmailRoutingStatus(zoneId: string): Promise<{ enabled: boolean; status: string }> {
    const resp = await this.request<{ enabled: boolean; status: string }>(
      'GET',
      `/zones/${zoneId}/email/routing`,
    );
    return resp.result;
  }

  /** Set catch-all rule to forward to a Worker */
  async setCatchAllWorkerRule(zoneId: string, workerName: string): Promise<void> {
    await this.request(
      'PUT',
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      {
        enabled: true,
        actions: [{ type: 'worker', value: [workerName] }],
        matchers: [{ type: 'all' }],
        name: 'AgenticMail catch-all → Worker',
      },
    );
  }

  // --- Workers methods ---

  /** Deploy an Email Worker script (ES module format) */
  async deployEmailWorker(scriptName: string, scriptContent: string, envVars: Record<string, string> = {}): Promise<void> {
    const url = `${CF_API_BASE}/accounts/${this.accountId}/workers/scripts/${scriptName}`;

    // Build metadata with environment variable bindings
    const bindings = Object.entries(envVars).map(([name, text]) => ({
      type: 'plain_text',
      name,
      text,
    }));

    const metadata = JSON.stringify({
      main_module: 'index.js',
      compatibility_date: '2024-01-01',
      bindings,
    });

    // Workers API requires multipart form upload for module format
    const boundary = '----AgenticMailWorkerBoundary' + Date.now();
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="metadata"; filename="metadata.json"',
      'Content-Type: application/json',
      '',
      metadata,
      `--${boundary}`,
      'Content-Disposition: form-data; name="index.js"; filename="index.js"',
      'Content-Type: application/javascript+module',
      '',
      scriptContent,
      `--${boundary}--`,
    ].join('\r\n');

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Cloudflare Workers API returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!data.success) {
      const errors = data.errors?.map((e: any) => e.message).join(', ') ?? 'Unknown error';
      throw new Error(`Cloudflare Workers API error: ${errors}`);
    }
  }

  /** Delete a Worker script */
  async deleteWorker(scriptName: string): Promise<void> {
    await this.request('DELETE', `/accounts/${this.accountId}/workers/scripts/${scriptName}`);
  }

  async listTunnels(): Promise<CloudflareTunnel[]> {
    const resp = await this.request<CloudflareTunnel[]>(
      'GET',
      `/accounts/${this.accountId}/cfd_tunnel`,
    );
    return resp.result;
  }

  // --- Internal ---

  private async request<T>(method: string, path: string, body?: unknown): Promise<CloudflareApiResponse<T>> {
    const url = `${CF_API_BASE}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data: CloudflareApiResponse<T>;
    try {
      data = JSON.parse(text) as CloudflareApiResponse<T>;
    } catch {
      throw new Error(`Cloudflare API returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
    }

    if (!data.success) {
      const errors = data.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
      throw new Error(`Cloudflare API error: ${errors}`);
    }

    return data;
  }
}
