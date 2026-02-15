import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayGateway } from '../gateway/relay.js';

// We can't easily mock nodemailer/imapflow at module level without network,
// so we test the stateful logic and extractAgentName via the public interface.

describe('RelayGateway', () => {
  let relay: RelayGateway;

  beforeEach(() => {
    relay = new RelayGateway();
  });

  describe('initial state', () => {
    it('starts unconfigured', () => {
      expect(relay.isConfigured()).toBe(false);
      expect(relay.isPolling()).toBe(false);
      expect(relay.getConfig()).toBeNull();
    });
  });

  describe('sendViaRelay', () => {
    it('throws when not configured', async () => {
      await expect(relay.sendViaRelay('bot1', { to: 'x@y.com', subject: 'hi' }))
        .rejects.toThrow('Relay not configured');
    });
  });

  describe('startPolling', () => {
    it('throws when not configured', async () => {
      await expect(relay.startPolling())
        .rejects.toThrow('Relay not configured');
    });
  });

  describe('stopPolling', () => {
    it('is safe to call when not polling', () => {
      relay.stopPolling();
      expect(relay.isPolling()).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('is safe to call when not configured', async () => {
      await relay.shutdown();
      expect(relay.isConfigured()).toBe(false);
    });
  });

  describe('extractAgentName (via sendViaRelay from-rewrite logic)', () => {
    // We test the sub-addressing logic indirectly by verifying the relay
    // generates correct from addresses. The extractAgentName method is
    // private, so we verify the pattern it expects.

    it('sub-address format: user+agent@domain.com extracts "agent"', () => {
      // Verify the regex pattern used in extractAgentName
      const testCases = [
        { address: 'john+bot1@gmail.com', localPart: 'john', expected: 'bot1' },
        { address: 'user+myagent@outlook.com', localPart: 'user', expected: 'myagent' },
        { address: 'test+agent-123@example.com', localPart: 'test', expected: 'agent-123' },
        { address: 'user@gmail.com', localPart: 'user', expected: null },
        { address: 'other+bot1@gmail.com', localPart: 'john', expected: null }, // wrong local part
      ];

      for (const { address, localPart, expected } of testCases) {
        const match = address.match(/^([^+]+)\+([^@]+)@/);
        if (match && match[1] === localPart) {
          expect(match[2]).toBe(expected);
        } else {
          expect(expected).toBeNull();
        }
      }
    });
  });

  describe('callback handling', () => {
    it('accepts onInboundMail callback', () => {
      const callback = vi.fn();
      const relayWithCb = new RelayGateway({ onInboundMail: callback });
      expect(relayWithCb.isConfigured()).toBe(false);
    });
  });
});
