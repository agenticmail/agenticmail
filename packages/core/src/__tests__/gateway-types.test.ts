import { describe, it, expect } from 'vitest';
import { RELAY_PRESETS } from '../gateway/types.js';

describe('RELAY_PRESETS', () => {
  it('has gmail preset with correct hosts', () => {
    expect(RELAY_PRESETS.gmail).toEqual({
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      imapHost: 'imap.gmail.com',
      imapPort: 993,
    });
  });

  it('has outlook preset with correct hosts', () => {
    expect(RELAY_PRESETS.outlook).toEqual({
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      imapHost: 'outlook.office365.com',
      imapPort: 993,
    });
  });

  it('uses port 587 for SMTP (submission with STARTTLS)', () => {
    expect(RELAY_PRESETS.gmail.smtpPort).toBe(587);
    expect(RELAY_PRESETS.outlook.smtpPort).toBe(587);
  });

  it('uses port 993 for IMAP (implicit TLS)', () => {
    expect(RELAY_PRESETS.gmail.imapPort).toBe(993);
    expect(RELAY_PRESETS.outlook.imapPort).toBe(993);
  });
});
