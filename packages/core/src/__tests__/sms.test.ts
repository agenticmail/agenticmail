import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  normalizePhoneNumber,
  isValidPhoneNumber,
  parseGoogleVoiceSms,
  extractVerificationCode,
  getSmsProvider,
  mapProviderSmsStatus,
  redactSmsConfig,
} from '../sms/manager.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizePhoneNumber', () => {
  it('normalizes 10-digit US number', () => {
    expect(normalizePhoneNumber('2125551234')).toBe('+12125551234');
  });

  it('normalizes formatted US number', () => {
    expect(normalizePhoneNumber('(212) 555-1234')).toBe('+12125551234');
  });

  it('normalizes +1 prefix', () => {
    expect(normalizePhoneNumber('+12125551234')).toBe('+12125551234');
  });

  it('keeps international E.164 numbers', () => {
    expect(normalizePhoneNumber('+46701234567')).toBe('+46701234567');
  });

  it('normalizes 11-digit with leading 1', () => {
    expect(normalizePhoneNumber('12125551234')).toBe('+12125551234');
  });

  it('normalizes dots and dashes', () => {
    expect(normalizePhoneNumber('212.555.1234')).toBe('+12125551234');
    expect(normalizePhoneNumber('212-555-1234')).toBe('+12125551234');
  });

  it('rejects too short', () => {
    expect(normalizePhoneNumber('12345')).toBeNull();
    expect(normalizePhoneNumber('')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(normalizePhoneNumber('abcdef')).toBeNull();
  });
});

describe('SMS providers', () => {
  it('redacts provider secrets from SMS config', () => {
    expect(redactSmsConfig({
      enabled: true,
      provider: '46elks',
      phoneNumber: '+46701234567',
      username: 'u',
      password: 'p',
      webhookSecret: 's',
      configuredAt: '2026-05-18T00:00:00.000Z',
    })).toMatchObject({
      provider: '46elks',
      username: 'u',
      password: '***',
      webhookSecret: '***',
    });
  });

  it('parses inbound 46elks webhook payloads', () => {
    const event = getSmsProvider('46elks').parseInboundSms({
      id: 'sms123',
      direction: 'incoming',
      from: '+46709999999',
      to: '+46701234567',
      message: 'Your code is 123456',
      created: '2026-05-18T10:00:00.000Z',
    });

    expect(event).toMatchObject({
      provider: '46elks',
      id: 'sms123',
      from: '+46709999999',
      to: '+46701234567',
      body: 'Your code is 123456',
    });
  });

  it('sends 46elks SMS with basic auth and form encoding', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: 'sms123',
      status: 'created',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getSmsProvider('46elks').sendSms({
      enabled: true,
      provider: '46elks',
      phoneNumber: '+46701234567',
      username: 'api-user',
      password: 'api-pass',
      configuredAt: '2026-05-18T00:00:00.000Z',
    }, {
      to: '+46709999999',
      body: 'Hello',
    });

    expect(result).toMatchObject({ provider: '46elks', id: 'sms123', status: 'created' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.46elks.com/a1/sms');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('api-user:api-pass').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(String(init.body)).toBe('to=%2B46709999999&from=%2B46701234567&message=Hello');
  });

  it('maps provider SMS status to internal status', () => {
    expect(mapProviderSmsStatus('delivered')).toBe('delivered');
    expect(mapProviderSmsStatus('created')).toBe('sent');
    expect(mapProviderSmsStatus('failed')).toBe('failed');
  });
});

describe('isValidPhoneNumber', () => {
  it('accepts valid numbers', () => {
    expect(isValidPhoneNumber('+12125551234')).toBe(true);
    expect(isValidPhoneNumber('(336) 276-3915')).toBe(true);
    expect(isValidPhoneNumber('2125551234')).toBe(true);
  });

  it('rejects invalid', () => {
    expect(isValidPhoneNumber('123')).toBe(false);
    expect(isValidPhoneNumber('')).toBe(false);
    expect(isValidPhoneNumber('hello')).toBe(false);
  });
});

describe('extractVerificationCode', () => {
  it('extracts "Your code is 123456"', () => {
    expect(extractVerificationCode('Your verification code is 123456')).toBe('123456');
  });

  it('extracts "code: 789012"', () => {
    expect(extractVerificationCode('Your code: 789012')).toBe('789012');
  });

  it('extracts "123456 is your code"', () => {
    expect(extractVerificationCode('123456 is your verification code')).toBe('123456');
  });

  it('extracts Google G-code', () => {
    expect(extractVerificationCode('G-412539 is your Google verification code')).toBe('412539');
  });

  it('extracts "Enter 123456 to verify"', () => {
    expect(extractVerificationCode('Enter 567890 to verify your account')).toBe('567890');
  });

  it('extracts standalone 6-digit', () => {
    expect(extractVerificationCode('Here is your code\n654321\nDo not share')).toBe('654321');
  });

  it('extracts 4-digit pin', () => {
    expect(extractVerificationCode('Your pin is 4567')).toBe('4567');
  });

  it('returns null for no code', () => {
    expect(extractVerificationCode('Hello, how are you?')).toBeNull();
  });

  it('handles null/empty input', () => {
    expect(extractVerificationCode('')).toBeNull();
    expect(extractVerificationCode(null as any)).toBeNull();
  });
});

describe('parseGoogleVoiceSms', () => {
  it('returns null for non-Google-Voice emails', () => {
    expect(parseGoogleVoiceSms('Hello world', 'friend@example.com')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseGoogleVoiceSms('', 'voice-noreply@google.com')).toBeNull();
    expect(parseGoogleVoiceSms(null as any, 'test')).toBeNull();
  });

  it('parses "New text message from" format', () => {
    const result = parseGoogleVoiceSms(
      'New text message from +12125551234\n\nHey, are you coming tonight?',
      'voice-noreply@google.com'
    );
    expect(result).not.toBeNull();
    expect(result!.from).toBe('+12125551234');
    expect(result!.body).toContain('Hey, are you coming tonight?');
  });

  it('parses "phone: message" format', () => {
    const result = parseGoogleVoiceSms(
      '+12125551234: Your Uber code is 4521',
      'voice-noreply@google.com'
    );
    expect(result).not.toBeNull();
    expect(result!.body).toContain('4521');
  });

  it('strips HTML tags', () => {
    const result = parseGoogleVoiceSms(
      '<div>New text message from +12125551234</div><br><p>Hello from HTML</p>',
      'voice-noreply@google.com'
    );
    expect(result).not.toBeNull();
    expect(result!.body).not.toContain('<');
    expect(result!.body).toContain('Hello from HTML');
  });

  it('strips Google Voice boilerplate', () => {
    const result = parseGoogleVoiceSms(
      'New text message from +12125551234\n\nActual message\n\nTo respond to this text message, reply to this email\nGoogle Voice\nGoogle LLC\n1600 Amphitheatre',
      'voice-noreply@google.com'
    );
    expect(result).not.toBeNull();
    expect(result!.body).toBe('Actual message');
    expect(result!.body).not.toContain('Google LLC');
    expect(result!.body).not.toContain('1600 Amphitheatre');
  });

  it('accepts @txt.voice.google.com sender', () => {
    const result = parseGoogleVoiceSms(
      '+12125551234: Test message',
      '12125551234@txt.voice.google.com'
    );
    expect(result).not.toBeNull();
    expect(result!.body).toContain('Test message');
  });
});
