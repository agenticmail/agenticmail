import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TunnelManager } from '../gateway/tunnel.js';

describe('TunnelManager', () => {
  let mockCf: any;
  let tunnel: TunnelManager;

  beforeEach(() => {
    mockCf = {
      createTunnel: vi.fn(),
      getTunnelToken: vi.fn(),
      createTunnelRoute: vi.fn(),
      getTunnel: vi.fn(),
      listTunnels: vi.fn().mockResolvedValue([]),
    };
    tunnel = new TunnelManager(mockCf);
  });

  describe('create', () => {
    it('creates tunnel and fetches token', async () => {
      mockCf.createTunnel.mockResolvedValue({ id: 't1', name: 'my-tunnel', status: 'active', created_at: '', connections: [] });
      mockCf.getTunnelToken.mockResolvedValue('token-abc');

      const config = await tunnel.create('my-tunnel');
      expect(config.tunnelId).toBe('t1');
      expect(config.tunnelToken).toBe('token-abc');
      expect(mockCf.createTunnel).toHaveBeenCalledWith('my-tunnel');
      expect(mockCf.getTunnelToken).toHaveBeenCalledWith('t1');
    });
  });

  describe('status', () => {
    it('returns not running initially', () => {
      const s = tunnel.status();
      expect(s.running).toBe(false);
      expect(s.pid).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('handles stop when not running', () => {
      // Should not throw
      tunnel.stop();
      expect(tunnel.status().running).toBe(false);
    });
  });

  describe('createIngress', () => {
    it('delegates to cloudflare client', async () => {
      mockCf.createTunnelRoute.mockResolvedValue(undefined);
      await tunnel.createIngress('t1', 'example.com');
      expect(mockCf.createTunnelRoute).toHaveBeenCalledWith('t1', 'example.com', 'http://localhost:8080');
    });

    it('uses custom http port', async () => {
      mockCf.createTunnelRoute.mockResolvedValue(undefined);
      await tunnel.createIngress('t1', 'example.com', 25, 9090);
      expect(mockCf.createTunnelRoute).toHaveBeenCalledWith('t1', 'example.com', 'http://localhost:9090');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when tunnel has connections', async () => {
      mockCf.getTunnel.mockResolvedValue({ id: 't1', connections: [{ id: 'c1' }], status: 'active' });
      const health = await tunnel.healthCheck('t1');
      expect(health.healthy).toBe(true);
      expect(health.status).toBe('active');
    });

    it('returns unhealthy when no connections', async () => {
      mockCf.getTunnel.mockResolvedValue({ id: 't1', connections: [], status: 'inactive' });
      const health = await tunnel.healthCheck('t1');
      expect(health.healthy).toBe(false);
    });

    it('returns unhealthy on error', async () => {
      mockCf.getTunnel.mockRejectedValue(new Error('not found'));
      const health = await tunnel.healthCheck('t1');
      expect(health.healthy).toBe(false);
      expect(health.status).toBe('unknown');
    });
  });
});
