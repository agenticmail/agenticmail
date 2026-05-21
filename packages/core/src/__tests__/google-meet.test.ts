import { describe, expect, it } from 'vitest';
import { parseGoogleMeetLink } from '../conversation/index.js';

describe('Google Meet link intake', () => {
  it('parses and normalizes Meet URLs and bare meeting codes', () => {
    expect(parseGoogleMeetLink('https://meet.google.com/abc-defg-hij?authuser=0')).toEqual({
      source: 'https://meet.google.com/abc-defg-hij?authuser=0',
      meetingCode: 'abc-defg-hij',
      normalizedUrl: 'https://meet.google.com/abc-defg-hij',
    });

    expect(parseGoogleMeetLink('ABC-DEFG-HIJ')).toMatchObject({
      meetingCode: 'abc-defg-hij',
      normalizedUrl: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('rejects non-Meet URLs and malformed codes', () => {
    expect(() => parseGoogleMeetLink('https://example.com/abc-defg-hij')).toThrow(/meet.google.com/);
    expect(() => parseGoogleMeetLink('abc-defg')).toThrow(/meeting code/);
  });
});
