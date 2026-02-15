import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DNSConfigurator } from '../gateway/dns-setup.js';

describe('DNSConfigurator', () => {
  let mockCf: any;
  let dns: DNSConfigurator;

  beforeEach(() => {
    mockCf = {
      createDnsRecord: vi.fn().mockResolvedValue({ id: 'rec-1' }),
      listDnsRecords: vi.fn().mockResolvedValue([]),
    };
    dns = new DNSConfigurator(mockCf);
  });

  describe('configureForEmail', () => {
    it('creates MX, SPF, and DMARC records', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1');

      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(3);
      expect(result.records).toHaveLength(3);

      // MX record
      const mxCall = mockCf.createDnsRecord.mock.calls[0];
      expect(mxCall[0]).toBe('zone-1');
      expect(mxCall[1].type).toBe('MX');
      expect(mxCall[1].priority).toBe(10);

      // SPF record
      const spfCall = mockCf.createDnsRecord.mock.calls[1];
      expect(spfCall[1].type).toBe('TXT');
      expect(spfCall[1].content).toContain('v=spf1');

      // DMARC record
      const dmarcCall = mockCf.createDnsRecord.mock.calls[2];
      expect(dmarcCall[1].type).toBe('TXT');
      expect(dmarcCall[1].name).toBe('_dmarc.example.com');
      expect(dmarcCall[1].content).toContain('v=DMARC1');
      expect(dmarcCall[1].content).toContain('dmarc@example.com');
    });

    it('creates DKIM record when key is provided', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1', {
        dkimSelector: 'mail',
        dkimPublicKey: 'MIGfMA0GCSq...',
      });

      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(4);
      expect(result.records).toHaveLength(4);

      const dkimCall = mockCf.createDnsRecord.mock.calls[3];
      expect(dkimCall[1].name).toBe('mail._domainkey.example.com');
      expect(dkimCall[1].content).toContain('v=DKIM1');
      expect(dkimCall[1].content).toContain('MIGfMA0GCSq...');
    });

    it('does not create DKIM record without key', async () => {
      await dns.configureForEmail('example.com', 'zone-1');
      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(3);
    });

    it('returns correct record purposes', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1');
      expect(result.records[0].purpose).toBe('Mail delivery');
      expect(result.records[1].purpose).toContain('SPF');
      expect(result.records[2].purpose).toContain('DMARC');
    });
  });

  describe('configureForTunnel', () => {
    it('creates CNAME records for root and mail subdomain', async () => {
      await dns.configureForTunnel('example.com', 'zone-1', 'tunnel-abc');

      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(2);

      // Root CNAME
      const rootCall = mockCf.createDnsRecord.mock.calls[0];
      expect(rootCall[1].type).toBe('CNAME');
      expect(rootCall[1].name).toBe('example.com');
      expect(rootCall[1].content).toBe('tunnel-abc.cfargotunnel.com');
      expect(rootCall[1].proxied).toBe(true);

      // Mail CNAME
      const mailCall = mockCf.createDnsRecord.mock.calls[1];
      expect(mailCall[1].name).toBe('mail.example.com');
      expect(mailCall[1].content).toBe('tunnel-abc.cfargotunnel.com');
    });
  });
});
