import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DomainPurchaser } from '../gateway/domain-purchase.js';

describe('DomainPurchaser', () => {
  let mockCf: any;
  let purchaser: DomainPurchaser;

  beforeEach(() => {
    mockCf = {
      checkAvailability: vi.fn(),
      purchaseDomain: vi.fn(),
      listRegisteredDomains: vi.fn(),
    };
    purchaser = new DomainPurchaser(mockCf);
  });

  describe('searchAvailable', () => {
    it('checks each keyword with each TLD', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: true, premium: false });

      const results = await purchaser.searchAvailable(['mybot'], ['.com', '.io']);
      expect(results).toHaveLength(2);
      expect(results[0].domain).toBe('mybot.com');
      expect(results[1].domain).toBe('mybot.io');
      expect(mockCf.checkAvailability).toHaveBeenCalledTimes(2);
    });

    it('uses default TLDs when none provided', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: false, premium: false });

      const results = await purchaser.searchAvailable(['test']);
      expect(results).toHaveLength(4); // .com, .net, .io, .dev
      expect(results.map((r: any) => r.domain)).toEqual([
        'test.com', 'test.net', 'test.io', 'test.dev',
      ]);
    });

    it('skips TLD append if keyword already contains a dot', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: true, premium: false });

      const results = await purchaser.searchAvailable(['mybot.xyz'], ['.com']);
      expect(results[0].domain).toBe('mybot.xyz');
    });

    it('marks failed checks as unavailable', async () => {
      mockCf.checkAvailability.mockRejectedValue(new Error('lookup failed'));

      const results = await purchaser.searchAvailable(['fail'], ['.com']);
      expect(results).toHaveLength(1);
      expect(results[0].available).toBe(false);
      expect(results[0].premium).toBe(false);
    });

    it('includes price when available', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: true, premium: false, price: 9.99 });

      const results = await purchaser.searchAvailable(['cheap'], ['.com']);
      expect(results[0].price).toBe(9.99);
    });

    it('handles multiple keywords', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: true, premium: false });

      const results = await purchaser.searchAvailable(['bot1', 'bot2'], ['.com']);
      expect(results).toHaveLength(2);
      expect(results[0].domain).toBe('bot1.com');
      expect(results[1].domain).toBe('bot2.com');
    });
  });

  describe('purchase', () => {
    it('always throws because Cloudflare API does not support programmatic purchases', async () => {
      await expect(purchaser.purchase('mybot.com')).rejects.toThrow('Cloudflare API does not support domain purchases');
    });

    it('throws regardless of autoRenew option', async () => {
      await expect(purchaser.purchase('mybot.com', false)).rejects.toThrow('Cloudflare API does not support domain purchases');
    });
  });

  describe('getStatus', () => {
    it('returns not_registered when available', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: true });
      const result = await purchaser.getStatus('free.com');
      expect(result.status).toBe('not_registered');
    });

    it('returns registered when not available', async () => {
      mockCf.checkAvailability.mockResolvedValue({ available: false });
      const result = await purchaser.getStatus('taken.com');
      expect(result.status).toBe('registered');
    });
  });

  describe('listRegistered', () => {
    it('delegates to cloudflare client', async () => {
      const domains = [{ domain: 'a.com', status: 'active' }];
      mockCf.listRegisteredDomains.mockResolvedValue(domains);

      const result = await purchaser.listRegistered();
      expect(result).toEqual(domains);
    });
  });
});
