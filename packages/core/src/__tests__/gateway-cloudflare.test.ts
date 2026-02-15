import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareClient } from '../gateway/cloudflare.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function cfResponse<T>(result: T, success = true) {
  const body = { success, errors: success ? [] : [{ code: 1000, message: 'test error' }], messages: [], result };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('CloudflareClient', () => {
  let client: CloudflareClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new CloudflareClient('test-token', 'test-account-id');
  });

  describe('zones', () => {
    it('listZones calls GET /zones', async () => {
      const zones = [{ id: 'z1', name: 'example.com', status: 'active', name_servers: ['ns1', 'ns2'] }];
      mockFetch.mockResolvedValueOnce(cfResponse(zones));

      const result = await client.listZones();
      expect(result).toEqual(zones);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/zones',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('getZone returns zone for matching domain', async () => {
      const zone = { id: 'z1', name: 'example.com', status: 'active', name_servers: [] };
      mockFetch.mockResolvedValueOnce(cfResponse([zone]));

      const result = await client.getZone('example.com');
      expect(result).toEqual(zone);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones?name=example.com'),
        expect.any(Object),
      );
    });

    it('getZone returns null when no zone found', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));
      const result = await client.getZone('unknown.com');
      expect(result).toBeNull();
    });

    it('createZone posts zone with account id', async () => {
      const zone = { id: 'z2', name: 'new.com', status: 'pending', name_servers: [] };
      mockFetch.mockResolvedValueOnce(cfResponse(zone));

      const result = await client.createZone('new.com');
      expect(result).toEqual(zone);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/zones',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"test-account-id"'),
        }),
      );
    });
  });

  describe('DNS records', () => {
    it('listDnsRecords fetches records for zone', async () => {
      const records = [{ id: 'r1', type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 1 }];
      mockFetch.mockResolvedValueOnce(cfResponse(records));

      const result = await client.listDnsRecords('zone-123');
      expect(result).toEqual(records);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones/zone-123/dns_records'),
        expect.any(Object),
      );
    });

    it('createDnsRecord posts record with defaults', async () => {
      const record = { id: 'r1', type: 'MX', name: 'ex.com', content: 'mail.ex.com', ttl: 1 };
      mockFetch.mockResolvedValueOnce(cfResponse(record));

      await client.createDnsRecord('z1', { type: 'MX', name: 'ex.com', content: 'mail.ex.com', priority: 10 });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.ttl).toBe(1);
      expect(body.proxied).toBe(false);
      expect(body.priority).toBe(10);
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

    it('checkAvailability returns domain info', async () => {
      const domain = { name: 'test.com', available: true, premium: false, price: 9.99 };
      mockFetch.mockResolvedValueOnce(cfResponse(domain));

      const result = await client.checkAvailability('test.com');
      expect(result.available).toBe(true);
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
      const tunnel = { id: 't1', name: 'my-tunnel', status: 'active', created_at: '', connections: [] };
      mockFetch.mockResolvedValueOnce(cfResponse(tunnel));

      const result = await client.createTunnel('my-tunnel');
      expect(result.name).toBe('my-tunnel');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tunnel_secret).toBeTruthy();
    });

    it('getTunnelToken returns token string', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse('eyJhIjoiYiJ9'));
      const token = await client.getTunnelToken('t1');
      expect(token).toBe('eyJhIjoiYiJ9');
    });

    it('createTunnelRoute sets ingress config', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null));
      await client.createTunnelRoute('t1', 'example.com', 'http://localhost:8080');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.config.ingress).toHaveLength(2);
      expect(body.config.ingress[0].hostname).toBe('example.com');
      expect(body.config.ingress[1].service).toBe('http_status:404');
    });

    it('deleteTunnel issues DELETE', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null));
      await client.deleteTunnel('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/cfd_tunnel/t1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on API failure', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse(null, false));
      await expect(client.listZones()).rejects.toThrow('Cloudflare API error: test error');
    });
  });

  describe('auth headers', () => {
    it('sends Bearer token in Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(cfResponse([]));
      await client.listZones();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});
