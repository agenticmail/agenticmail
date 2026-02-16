import { describe, it, expect } from 'vitest';
import {
  normalizePhoneNumber,
  isValidPhoneNumber,
  parseGoogleVoiceSms,
  extractVerificationCode,
} from '../sms/manager.js';

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
