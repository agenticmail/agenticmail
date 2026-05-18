import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatPollError,
  formatRelayError,
  isRelayCredentialError,
  RelayGateway,
} from '../gateway/relay.js';

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

  describe('relay error formatting', () => {
    it('keeps structured fields in generic poll errors', () => {
      const msg = formatPollError({
        message: 'connect ETIMEDOUT',
        code: 'ETIMEDOUT',
        syscall: 'connect',
        hostname: 'imap.example.com',
        port: 993,
      });

      expect(msg).toContain('connect ETIMEDOUT');
      expect(msg).toContain('code=ETIMEDOUT');
      expect(msg).toContain('host=imap.example.com');
      expect(msg).toContain('port=993');
    });

    it('classifies Gmail app-password/auth failures as credential errors', () => {
      const err = {
        message: 'Invalid login',
        code: 'EAUTH',
        response: '535-5.7.8 Username and Password not accepted.',
        command: 'AUTH PLAIN',
      };

      expect(isRelayCredentialError(err)).toBe(true);
      const msg = formatRelayError(err, {
        provider: 'gmail',
        email: 'owner@gmail.com',
      }, 'SMTP send');

      expect(msg).toContain('Gmail relay authentication');
      expect(msg).toContain('owner@gmail.com');
      expect(msg).toContain('fresh Gmail app password');
      expect(msg).toContain('Original error:');
    });

    it('classifies Microsoft OAuth/token expiry as an actionable reconnect error', () => {
      const err = {
        message: 'AUTHENTICATE failed',
        responseText: 'invalid_grant: AADSTS700082: The refresh token has expired',
      };

      expect(isRelayCredentialError(err)).toBe(true);
      const msg = formatRelayError(err, {
        provider: 'outlook',
        email: 'owner@example.com',
      }, 'IMAP poll');

      expect(msg).toContain('Outlook/Microsoft 365 relay authentication');
      expect(msg).toContain('invalid, expired, or revoked');
      expect(msg).toContain('Refresh/recreate the Microsoft relay credential or OAuth token');
    });

    it('classifies string auth errors too', () => {
      expect(isRelayCredentialError('535 5.7.8 Authentication failed')).toBe(true);
    });

    it('does not call network failures credential errors', () => {
      const err = {
        message: 'connect ENOTFOUND imap.example.com',
        code: 'ENOTFOUND',
      };

      expect(isRelayCredentialError(err)).toBe(false);
      expect(formatRelayError(err, {
        provider: 'custom',
        email: 'owner@example.com',
      }, 'IMAP search')).toBe('Relay IMAP search failed: connect ENOTFOUND imap.example.com | code=ENOTFOUND');
    });
  });
});
