import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareClient } from '../gateway/cloudflare.js';

describe('CloudflareClient', () => {
  let client: CloudflareClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  const cfResponse = (data: any) =>
    new Response(JSON.stringify({ success: true, result: data }), {
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    client = new CloudflareClient('test-token', 'acc-1');
  });

  describe('zones', () => {
    it('listZones calls GET /zones', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([{ id: 'z1', name: 'example.com' }]));

      const zones = await client.listZones();
      expect(zones).toHaveLength(1);
      expect(zones[0].id).toBe('z1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('getZone returns zone for matching domain', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([{ id: 'z1', name: 'example.com' }]));

      const zone = await client.getZone('example.com');
      expect(zone?.id).toBe('z1');
    });

    it('getZone returns null when no zone found', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));

      const zone = await client.getZone('missing.com');
      expect(zone).toBeNull();
    });

    it('createZone posts zone with account id', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse({ id: 'z2', name: 'new.com' }));

      const zone = await client.createZone('new.com');
      expect(zone.id).toBe('z2');
    });
  });

  describe('DNS records', () => {
    it('listDnsRecords fetches records for zone', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([{ id: 'r1', type: 'A' }]));

      const records = await client.listDnsRecords('z1');
      expect(records).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones/z1/dns_records'),
        expect.any(Object),
      );
    });

    it('createDnsRecord posts record with defaults', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse({ id: 'r2' }));

      await client.createDnsRecord('z1', { type: 'A', name: 'test.com', content: '1.2.3.4' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('A');
    });

    it('deleteDnsRecord issues DELETE', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null));
      await client.deleteDnsRecord('z1', 'r1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones/z1/dns_records/r1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('registrar', () => {
    it('searchDomains encodes query', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));
      await client.searchDomains('my bot');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('query=my%20bot'),
        expect.any(Object),
      );
    });

    it('checkAvailability returns domain info with registration data marked unavailable', async () => {
      // Domain with registration data → unavailable
      const domain = { name: 'test.com', current_registrar: 'SomeRegistrar', premium: false, price: 9.99 };
      mockFetch.mockResolvedValueOnce(cfResponse(domain));

      const result = await client.checkAvailability('test.com');
      expect(result.available).toBe(false);
      expect(result.price).toBe(9.99);
    });

    it('purchaseDomain posts with auto_renew', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse({ domain: 'test.com', status: 'pending' }));

      const result = await client.purchaseDomain('test.com', false);
      expect(result.status).toBe('pending');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.auto_renew).toBe(false);
    });
  });

  describe('tunnels', () => {
    it('createTunnel posts with secret', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse({ id: 't1', name: 'my-tunnel' }));

      const tunnel = await client.createTunnel('my-tunnel');
      expect(tunnel.id).toBe('t1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('my-tunnel');
      expect(body.tunnel_secret).toBeDefined();
    });

    it('getTunnelToken returns token string', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse('token-abc'));

      const token = await client.getTunnelToken('t1');
      expect(token).toBe('token-abc');
    });

    it('createTunnelRoute sets ingress config', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(undefined));
      await client.createTunnelRoute('t1', 'example.com', 'http://localhost:8080');
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('cfd_tunnel/t1/configurations');
      expect(opts.method).toBe('PUT');
    });

    it('deleteTunnel issues DELETE', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null));
      await client.deleteTunnel('t1');
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('cfd_tunnel/t1');
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws on API failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'Unauthorized' }] }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );

      await expect(client.listZones()).rejects.toThrow();
    });
  });

  describe('auth headers', () => {
    it('sends token in Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));
      await client.listZones();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token');
    });
  });
});
