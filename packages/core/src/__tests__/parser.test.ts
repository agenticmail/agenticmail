import { describe, it, expect } from 'vitest';
import { parseEmail } from '../mail/parser.js';

describe('parseEmail', () => {
  it('parses a simple email', async () => {
    const raw = `From: alice@example.com
To: bob@example.com
Subject: Test Email
Message-ID: <test@example.com>
Date: Mon, 01 Jan 2024 00:00:00 +0000
Content-Type: text/plain

Hello, this is a test.`;

    const result = await parseEmail(raw);
    expect(result.subject).toBe('Test Email');
    expect(result.from[0].address).toBe('alice@example.com');
    expect(result.to[0].address).toBe('bob@example.com');
    expect(result.text).toContain('Hello, this is a test.');
    expect(result.messageId).toBe('<test@example.com>');
  });

  it('parses an email with reply headers', async () => {
    const raw = `From: bob@example.com
To: alice@example.com
Subject: Re: Test Email
Message-ID: <reply@example.com>
In-Reply-To: <test@example.com>
References: <test@example.com>
Date: Mon, 02 Jan 2024 00:00:00 +0000
Content-Type: text/plain

This is a reply.`;

    const result = await parseEmail(raw);
    expect(result.subject).toBe('Re: Test Email');
    expect(result.inReplyTo).toBe('<test@example.com>');
    expect(result.references).toContain('<test@example.com>');
  });
});
