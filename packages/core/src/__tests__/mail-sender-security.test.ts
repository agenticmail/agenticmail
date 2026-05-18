import { describe, expect, it, vi } from 'vitest';

const { createTransport } = vi.hoisted(() => ({
  createTransport: vi.fn(() => ({
    close: vi.fn(),
    sendMail: vi.fn(),
    verify: vi.fn(),
  })),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

const { MailSender } = await import('../mail/sender.js');

describe('MailSender TLS defaults', () => {
  it('verifies TLS certificates by default', () => {
    new MailSender({
      host: 'smtp.example.com',
      port: 587,
      email: 'agent@example.com',
      password: 'secret',
    });

    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      tls: { rejectUnauthorized: true },
    }));
  });

  it('requires an explicit option to disable TLS verification', () => {
    new MailSender({
      host: 'localhost',
      port: 587,
      email: 'agent@localhost',
      password: 'secret',
      tlsRejectUnauthorized: false,
    });

    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      tls: { rejectUnauthorized: false },
    }));
  });
});
