import { promises as dns } from 'node:dns';
import { CloudflareClient } from './cloudflare.js';

export interface DnsSetupResult {
  records: Array<{
    type: string;
    name: string;
    content: string;
    purpose: string;
  }>;
  removed: Array<{
    type: string;
    name: string;
    content: string;
    reason: string;
  }>;
}

/**
 * DNSConfigurator automatically creates MX, SPF, DKIM, and DMARC
 * DNS records for a domain using the Cloudflare API.
 * Replaces conflicting records (old MX, SPF, A records) to ensure clean setup.
 */
export class DNSConfigurator {
  constructor(private cf: CloudflareClient) {}

  /**
   * Configure all DNS records required for email on a domain.
   * Replaces existing MX and SPF records that conflict with AgenticMail.
   */
  /**
   * Detect the server's public IPv4 address for SPF records.
   */
  async detectPublicIp(): Promise<string | null> {
    try {
      const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return (await response.text()).trim();
    } catch { /* ignore */ }
    try {
      const response = await fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return (await response.text()).trim();
    } catch { /* ignore */ }
    return null;
  }

  async configureForEmail(
    domain: string,
    zoneId: string,
    options?: { dkimSelector?: string; dkimPublicKey?: string; serverIp?: string },
  ): Promise<DnsSetupResult> {
    const records: DnsSetupResult['records'] = [];
    const removed: DnsSetupResult['removed'] = [];

    // Note: We do NOT disable Cloudflare Email Routing here.
    // Email Routing is required for inbound mail (catch-all → Worker → AgenticMail).
    // Its managed MX records (_dc-mx.*) are preserved; only foreign MX records are removed.

    // Fetch existing records
    const existing = await this.cf.listDnsRecords(zoneId);

    // Cloudflare TXT records may have literal quotes wrapping the content
    const normalize = (s: string) => s.replace(/^["']|["']$/g, '');
    const findRecords = (type: string, name: string, contentPrefix?: string) =>
      existing.filter((r: any) =>
        r.type === type && r.name === name &&
        (!contentPrefix || normalize(r.content ?? '').startsWith(contentPrefix))
      );

    // --- MX records: remove conflicting non-Cloudflare MX records ---
    // Cloudflare Email Routing manages its own MX records (_dc-mx.*.domain).
    // We must NOT create our own MX record — it conflicts with Email Routing
    // and causes it to be marked as "misconfigured" / disabled.
    const existingMx = findRecords('MX', domain);
    const cfEmailRoutingMx = existingMx.filter((r: any) => (r.content ?? '').startsWith('_dc-mx.'));
    const foreignMx = existingMx.filter((r: any) => !(r.content ?? '').startsWith('_dc-mx.'));

    for (const mx of foreignMx) {
      try {
        await this.cf.deleteDnsRecord(zoneId, mx.id);
        removed.push({ type: 'MX', name: domain, content: mx.content, reason: 'Conflicts with Cloudflare Email Routing' });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('Email Routing')) {
          throw new Error(
            `Cannot modify MX records — Cloudflare Email Routing is active on ${domain}. ` +
            `Either add "Zone Settings > Edit" permission to your API token (so AgenticMail can auto-disable it), ` +
            `or manually disable Email Routing at: https://dash.cloudflare.com > ${domain} > Email > Email Routing > Disable`
          );
        }
        throw err;
      }
    }
    // MX is managed by Cloudflare Email Routing (enabled in a later step)
    records.push({ type: 'MX', name: domain, content: 'Managed by Cloudflare Email Routing', purpose: 'Inbound mail → Email Worker → AgenticMail' });

    // --- SPF record: include server IP + Cloudflare ---
    const serverIp = options?.serverIp ?? await this.detectPublicIp();
    const ipClause = serverIp ? `ip4:${serverIp} ` : '';
    const ourSpf = `v=spf1 ${ipClause}include:_spf.mx.cloudflare.net mx ~all`;

    const existingSpf = findRecords('TXT', domain, 'v=spf1');
    const alreadyHasOurSpf = existingSpf.some((r: any) => normalize(r.content) === ourSpf);

    if (!alreadyHasOurSpf) {
      // Remove all old SPF records
      for (const spf of existingSpf) {
        await this.cf.deleteDnsRecord(zoneId, spf.id);
        removed.push({ type: 'TXT', name: domain, content: spf.content, reason: 'Replaced by AgenticMail SPF' });
      }

      await this.cf.createDnsRecord(zoneId, {
        type: 'TXT',
        name: domain,
        content: ourSpf,
      });
    }
    records.push({ type: 'TXT', name: domain, content: ourSpf, purpose: 'SPF — Sender Policy Framework' });

    // --- DMARC record ---
    const existingDmarc = findRecords('TXT', `_dmarc.${domain}`, 'v=DMARC1');
    if (existingDmarc.length === 0) {
      await this.cf.createDnsRecord(zoneId, {
        type: 'TXT',
        name: `_dmarc.${domain}`,
        content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
      });
    }
    records.push({
      type: 'TXT',
      name: `_dmarc.${domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
      purpose: 'DMARC — Domain-based Message Authentication',
    });

    // --- DKIM record (if key provided) ---
    if (options?.dkimSelector && options?.dkimPublicKey) {
      const dkimName = `${options.dkimSelector}._domainkey.${domain}`;
      const ourDkim = `v=DKIM1; k=rsa; p=${options.dkimPublicKey}`;
      const existingDkim = findRecords('TXT', dkimName, 'v=DKIM1');
      const alreadyCorrect = existingDkim.some((r: any) => normalize(r.content) === ourDkim);

      if (!alreadyCorrect) {
        // Remove any outdated DKIM records (key mismatch from previous setup)
        for (const rec of existingDkim) {
          await this.cf.deleteDnsRecord(zoneId, rec.id);
          removed.push({ type: 'TXT', name: dkimName, content: rec.content, reason: 'Replaced by current DKIM key' });
        }
        await this.cf.createDnsRecord(zoneId, {
          type: 'TXT',
          name: dkimName,
          content: ourDkim,
        });
      }
      records.push({
        type: 'TXT',
        name: dkimName,
        content: ourDkim,
        purpose: 'DKIM — DomainKeys Identified Mail',
      });
    }

    return { records, removed };
  }

  /**
   * Configure DNS records to point the domain at a Cloudflare Tunnel.
   * Removes conflicting A/AAAA records for the root domain first.
   */
  async configureForTunnel(domain: string, zoneId: string, tunnelId: string): Promise<DnsSetupResult['removed']> {
    const removed: DnsSetupResult['removed'] = [];
    const existing = await this.cf.listDnsRecords(zoneId);
    const tunnelTarget = `${tunnelId}.cfargotunnel.com`;

    // Remove A/AAAA records for root domain that would conflict with our CNAME
    const conflicting = existing.filter((r: any) =>
      (r.type === 'A' || r.type === 'AAAA') && r.name === domain
    );
    for (const rec of conflicting) {
      await this.cf.deleteDnsRecord(zoneId, rec.id);
      removed.push({ type: rec.type, name: domain, content: rec.content, reason: 'Conflicts with tunnel CNAME' });
    }

    // Remove existing CNAME for root if it points somewhere else
    const existingCname = existing.filter((r: any) =>
      r.type === 'CNAME' && r.name === domain && r.content !== tunnelTarget
    );
    for (const rec of existingCname) {
      await this.cf.deleteDnsRecord(zoneId, rec.id);
      removed.push({ type: 'CNAME', name: domain, content: rec.content, reason: 'Replaced by tunnel CNAME' });
    }

    // Create CNAME for root domain → tunnel (if not already there)
    const hasRootCname = existing.some((r: any) =>
      r.type === 'CNAME' && r.name === domain && r.content === tunnelTarget
    );
    if (!hasRootCname) {
      await this.cf.createDnsRecord(zoneId, {
        type: 'CNAME',
        name: domain,
        content: tunnelTarget,
        proxied: true,
      });
    }

    // Create CNAME for mail subdomain → tunnel (if not already there)
    const mailName = `mail.${domain}`;
    const hasMailCname = existing.some((r: any) =>
      r.type === 'CNAME' && r.name === mailName && r.content === tunnelTarget
    );
    if (!hasMailCname) {
      // Remove any conflicting mail.* records first
      const mailConflicts = existing.filter((r: any) =>
        (r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME') && r.name === mailName
      );
      for (const rec of mailConflicts) {
        await this.cf.deleteDnsRecord(zoneId, rec.id);
        removed.push({ type: rec.type, name: mailName, content: rec.content, reason: 'Replaced by mail tunnel CNAME' });
      }

      await this.cf.createDnsRecord(zoneId, {
        type: 'CNAME',
        name: mailName,
        content: tunnelTarget,
        proxied: true,
      });
    }

    return removed;
  }

  /**
   * Verify DNS propagation by resolving MX and TXT records.
   */
  async verify(domain: string): Promise<{
    mx: boolean;
    spf: boolean;
    dmarc: boolean;
  }> {
    const result = { mx: false, spf: false, dmarc: false };

    try {
      const mxRecords = await dns.resolveMx(domain);
      result.mx = mxRecords.length > 0;
    } catch { /* not propagated yet */ }

    try {
      const txtRecords = await dns.resolveTxt(domain);
      const flat = txtRecords.map((r) => r.join(''));
      result.spf = flat.some((r) => r.startsWith('v=spf1'));
    } catch { /* not propagated yet */ }

    try {
      const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
      const flat = dmarcRecords.map((r) => r.join(''));
      result.dmarc = flat.some((r) => r.startsWith('v=DMARC1'));
    } catch { /* not propagated yet */ }

    return result;
  }
}
