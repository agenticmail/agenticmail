import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayManager } from '../gateway/manager.js';
import { createTestDatabase } from '../storage/db.js';
import type Database from 'better-sqlite3';

describe('GatewayManager', () => {
  let db: Database.Database;
  let mockStalwart: any;

  beforeEach(() => {
    db = createTestDatabase();
    mockStalwart = {
      createPrincipal: vi.fn().mockResolvedValue(undefined),
      getPrincipal: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    db.close();
  });

  function createManager(opts?: { onInboundMail?: any }) {
    return new GatewayManager({
      db,
      stalwart: mockStalwart,
      onInboundMail: opts?.onInboundMail,
    });
  }

  describe('initial state', () => {
    it('starts in "none" mode', () => {
      const mgr = createManager();
      expect(mgr.getMode()).toBe('none');
      expect(mgr.getConfig()).toEqual({ mode: 'none' });
    });

    it('returns healthy status when mode is none', () => {
      const mgr = createManager();
      const status = mgr.getStatus();
      expect(status.mode).toBe('none');
      expect(status.healthy).toBe(true);
    });
  });

  describe('config persistence', () => {
    it('persists and loads gateway config from DB', () => {
      // Insert config directly
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'relay', ?)
      `).run(JSON.stringify({
        relay: {
          provider: 'gmail',
          email: 'test@gmail.com',
          password: 'secret',
          smtpHost: 'smtp.gmail.com',
          smtpPort: 587,
          imapHost: 'imap.gmail.com',
          imapPort: 993,
        },
      }));

      // New manager should load it
      const mgr = createManager();
      expect(mgr.getMode()).toBe('relay');
      const config = mgr.getConfig();
      expect(config.relay?.provider).toBe('gmail');
      expect(config.relay?.email).toBe('test@gmail.com');
    });

    it('defaults to none when DB config is malformed', () => {
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'relay', 'not json')
      `).run();

      const mgr = createManager();
      expect(mgr.getMode()).toBe('none');
    });
  });

  describe('routeOutbound', () => {
    it('returns null when mode is none', async () => {
      const mgr = createManager();
      const result = await mgr.routeOutbound('bot1', {
        to: 'external@gmail.com',
        subject: 'test',
      });
      expect(result).toBeNull();
    });

    it('returns null for local delivery (localhost)', async () => {
      // Simulate relay mode config in DB
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'relay', ?)
      `).run(JSON.stringify({
        relay: {
          provider: 'gmail', email: 'user@gmail.com', password: 'pass',
          smtpHost: 'smtp.gmail.com', smtpPort: 587,
          imapHost: 'imap.gmail.com', imapPort: 993,
        },
      }));

      const mgr = createManager();
      const result = await mgr.routeOutbound('bot1', {
        to: 'bot2@localhost',
        subject: 'local msg',
      });
      expect(result).toBeNull();
    });

    it('throws in domain mode when accountManager is missing', async () => {
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'domain', ?)
      `).run(JSON.stringify({
        domain: {
          domain: 'mybot.com',
          cloudflareApiToken: 'tok',
          cloudflareAccountId: 'acc',
        },
      }));

      const mgr = createManager();
      // Domain mode sends via Stalwart, which requires an accountManager
      await expect(mgr.routeOutbound('bot1', {
        to: 'external@gmail.com',
        subject: 'test',
      })).rejects.toThrow('AccountManager required');
    });

    it('returns null for domain mode with local recipients', async () => {
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'domain', ?)
      `).run(JSON.stringify({
        domain: {
          domain: 'mybot.com',
          cloudflareApiToken: 'tok',
          cloudflareAccountId: 'acc',
        },
      }));

      const mgr = createManager();
      // Local recipient — no gateway routing needed
      const result = await mgr.routeOutbound('bot1', {
        to: 'other@localhost',
        subject: 'local test',
      });
      expect(result).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('reports relay status from DB config', () => {
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'relay', ?)
      `).run(JSON.stringify({
        relay: {
          provider: 'gmail', email: 'user@gmail.com', password: 'pass',
          smtpHost: 'smtp.gmail.com', smtpPort: 587,
          imapHost: 'imap.gmail.com', imapPort: 993,
        },
      }));

      const mgr = createManager();
      const status = mgr.getStatus();
      expect(status.mode).toBe('relay');
      expect(status.relay?.provider).toBe('gmail');
      expect(status.relay?.email).toBe('user@gmail.com');
      expect(status.relay?.polling).toBe(false);
      // Not healthy because relay.setup() hasn't been called
      expect(status.healthy).toBe(false);
    });

    it('reports domain status', () => {
      db.prepare(`
        INSERT INTO gateway_config (id, mode, config) VALUES ('default', 'domain', ?)
      `).run(JSON.stringify({
        domain: {
          domain: 'mybot.com',
          cloudflareApiToken: 'tok',
          cloudflareAccountId: 'acc',
        },
      }));

      const mgr = createManager();
      const status = mgr.getStatus();
      expect(status.mode).toBe('domain');
      expect(status.domain?.domain).toBe('mybot.com');
      expect(status.domain?.dnsConfigured).toBe(true);
      // Not healthy because tunnel isn't running
      expect(status.healthy).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('is safe to call in none mode', async () => {
      const mgr = createManager();
      await mgr.shutdown();
      expect(mgr.getMode()).toBe('none');
    });
  });

  describe('accessor methods', () => {
    it('returns null for cloudflare services when not in domain mode', () => {
      const mgr = createManager();
      expect(mgr.getDomainPurchaser()).toBeNull();
      expect(mgr.getDNSConfigurator()).toBeNull();
      expect(mgr.getTunnelManager()).toBeNull();
    });

    it('returns relay instance', () => {
      const mgr = createManager();
      expect(mgr.getRelay()).toBeDefined();
    });
  });

  describe('purchased_domains table', () => {
    it('gateway migration creates purchased_domains table', () => {
      const count = db.prepare(
        "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='purchased_domains'"
      ).get() as any;
      expect(count.c).toBe(1);
    });

    it('gateway migration creates gateway_config table', () => {
      const count = db.prepare(
        "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='gateway_config'"
      ).get() as any;
      expect(count.c).toBe(1);
    });
  });
});
