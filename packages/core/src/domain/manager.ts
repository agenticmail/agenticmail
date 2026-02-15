import type Database from 'better-sqlite3';
import { StalwartAdmin } from '../stalwart/admin.js';
import type { DomainInfo, DomainRow, DomainSetupResult, DnsRecord } from './types.js';

function rowToDomain(row: DomainRow): DomainInfo {
  return {
    domain: row.domain,
    stalwartPrincipal: row.stalwart_principal,
    dkimSelector: row.dkim_selector ?? undefined,
    dkimPublicKey: row.dkim_public_key ?? undefined,
    verified: row.verified === 1,
    createdAt: row.created_at,
  };
}

export class DomainManager {
  constructor(
    private db: Database.Database,
    private stalwart: StalwartAdmin,
  ) {}

  async setup(domain: string): Promise<DomainSetupResult> {
    // Check if domain already exists
    const existing = await this.get(domain);
    if (existing) {
      throw new Error(`Domain "${domain}" is already configured`);
    }

    const principalName = `domain:${domain}`;
    const dkimSelector = `agenticmail${Date.now()}`;

    // Create domain principal in Stalwart
    await this.stalwart.createPrincipal({
      type: 'domain',
      name: domain,
      description: `AgenticMail domain: ${domain}`,
    });

    // Generate DNS records
    const dnsRecords = this.generateDnsRecords(domain, dkimSelector);

    // Store in SQLite
    const stmt = this.db.prepare(`
      INSERT INTO domains (domain, stalwart_principal, dkim_selector)
      VALUES (?, ?, ?)
    `);
    stmt.run(domain, principalName, dkimSelector);

    return { domain, dnsRecords };
  }

  private generateDnsRecords(domain: string, selector: string): DnsRecord[] {
    return [
      {
        type: 'MX',
        name: domain,
        value: `10 mail.${domain}`,
        purpose: 'Mail delivery',
      },
      {
        type: 'TXT',
        name: domain,
        value: `v=spf1 mx a ~all`,
        purpose: 'SPF — Sender Policy Framework',
      },
      {
        type: 'TXT',
        name: `_dmarc.${domain}`,
        value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
        purpose: 'DMARC — Domain-based Message Authentication',
      },
      {
        type: 'TXT',
        name: `${selector}._domainkey.${domain}`,
        value: 'v=DKIM1; k=rsa; p=<DKIM_PUBLIC_KEY>',
        purpose: 'DKIM — DomainKeys Identified Mail (replace <DKIM_PUBLIC_KEY> with actual key)',
      },
    ];
  }

  async get(domain: string): Promise<DomainInfo | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE domain = ?');
    const row = stmt.get(domain) as DomainRow | undefined;
    return row ? rowToDomain(row) : null;
  }

  async list(): Promise<DomainInfo[]> {
    const stmt = this.db.prepare('SELECT * FROM domains ORDER BY created_at DESC');
    const rows = stmt.all() as DomainRow[];
    return rows.map(rowToDomain);
  }

  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    const info = await this.get(domain);
    if (!info) throw new Error(`Domain not found: ${domain}`);
    return this.generateDnsRecords(domain, info.dkimSelector ?? 'agenticmail');
  }

  async verify(domain: string): Promise<boolean> {
    // Basic DNS verification — checks if MX records exist
    try {
      const { promises: dns } = await import('node:dns');
      const mxRecords = await dns.resolveMx(domain);
      const verified = mxRecords.length > 0;

      if (verified) {
        const stmt = this.db.prepare('UPDATE domains SET verified = 1 WHERE domain = ?');
        stmt.run(domain);
      }

      return verified;
    } catch {
      return false;
    }
  }

  async delete(domain: string): Promise<boolean> {
    const info = await this.get(domain);
    if (!info) return false;

    try {
      await this.stalwart.deletePrincipal(domain);
    } catch {
      // May already be gone
    }

    const stmt = this.db.prepare('DELETE FROM domains WHERE domain = ?');
    const result = stmt.run(domain);
    return result.changes > 0;
  }
}
