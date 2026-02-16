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
    it('creates SPF and DMARC records (MX managed by Email Routing)', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1', { serverIp: '1.2.3.4' });

      // Only SPF + DMARC are created; MX is managed by Cloudflare Email Routing
      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(2);

      // Records array includes the MX entry (informational) + SPF + DMARC
      expect(result.records).toHaveLength(3);

      // SPF record
      const spfCall = mockCf.createDnsRecord.mock.calls[0];
      expect(spfCall[1].type).toBe('TXT');
      expect(spfCall[1].content).toContain('v=spf1');

      // DMARC record
      const dmarcCall = mockCf.createDnsRecord.mock.calls[1];
      expect(dmarcCall[1].type).toBe('TXT');
      expect(dmarcCall[1].name).toBe('_dmarc.example.com');
      expect(dmarcCall[1].content).toContain('v=DMARC1');
      expect(dmarcCall[1].content).toContain('dmarc@example.com');
    });

    it('creates DKIM record when key is provided', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1', {
        dkimSelector: 'mail',
        dkimPublicKey: 'MIGfMA0GCSq...',
        serverIp: '1.2.3.4',
      });

      // SPF + DMARC + DKIM = 3 createDnsRecord calls
      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(3);
      // Records: MX (informational) + SPF + DMARC + DKIM = 4
      expect(result.records).toHaveLength(4);

      const dkimCall = mockCf.createDnsRecord.mock.calls[2];
      expect(dkimCall[1].name).toBe('mail._domainkey.example.com');
      expect(dkimCall[1].content).toContain('v=DKIM1');
      expect(dkimCall[1].content).toContain('MIGfMA0GCSq...');
    });

    it('does not create DKIM record without key', async () => {
      await dns.configureForEmail('example.com', 'zone-1', { serverIp: '1.2.3.4' });
      // Only SPF + DMARC
      expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(2);
    });

    it('returns correct record purposes', async () => {
      const result = await dns.configureForEmail('example.com', 'zone-1', { serverIp: '1.2.3.4' });
      expect(result.records[0].purpose).toContain('Email Worker');
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
