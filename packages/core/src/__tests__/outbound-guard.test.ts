import { describe, it, expect } from 'vitest';
import { scanOutboundEmail, buildInboundSecurityAdvisory } from '../mail/outbound-guard.js';

// ─── scanOutboundEmail ───────────────────────────────────────────────

describe('scanOutboundEmail', () => {
  // --- Basic behavior ---

  it('returns no warnings for clean text to external recipient', () => {
    const result = scanOutboundEmail({
      to: 'user@example.com',
      text: 'Hello, please see the attached report.',
    });
    expect(result.warnings).toHaveLength(0);
    expect(result.hasHighSeverity).toBe(false);
    expect(result.hasMediumSeverity).toBe(false);
    expect(result.summary).toBe('');
  });

  it('skips scanning for @localhost recipients', () => {
    const result = scanOutboundEmail({
      to: 'agent@localhost',
      text: 'Here is the password: secret123 and SSN 123-45-6789',
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('skips scanning when ALL recipients are @localhost', () => {
    const result = scanOutboundEmail({
      to: ['agent1@localhost', 'agent2@localhost'],
      text: 'sk_live_abcdefghijklmnopqrstuvwxyz',
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('scans when any recipient is external (mixed)', () => {
    const result = scanOutboundEmail({
      to: ['agent@localhost', 'user@example.com'],
      text: 'SSN: 123-45-6789',
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
  });

  it('does NOT skip scanning for @localhost.com (not truly internal)', () => {
    const result = scanOutboundEmail({
      to: 'agent@localhost.com',
      text: 'SSN 123-45-6789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
  });

  // --- Subject scanning ---

  it('detects sensitive data in subject line', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      subject: 'SSN 123-45-6789',
      text: 'Please review',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects credentials in subject line', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      subject: 'password: mysecretpassword123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects API key in subject even with clean body', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      subject: 'Key: sk-proj-abcdefghijklmnopqrstuvwxyz1234',
      text: 'Clean body with no issues',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('does not flag clean subject lines', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      subject: 'Weekly Report - Q4 Summary',
      text: 'Please see the report.',
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('handles empty text and html gracefully', () => {
    const result = scanOutboundEmail({ to: 'ext@example.com' });
    expect(result.warnings).toHaveLength(0);
  });

  it('handles whitespace-only text with no warnings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: '   \n\t  \n   ',
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('scans html content as well', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      html: '<p>Your SSN is 123-45-6789</p>',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
  });

  it('scans combined text + html', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789',
      html: '<p>password: secret123</p>',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  // --- PII ---

  it('detects SSN', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Your SSN is 123-45-6789.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects credit card number with dashes', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Card: 4111-1111-1111-1111',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_credit_card')).toBe(true);
  });

  it('detects credit card number with spaces', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Card: 4111 1111 1111 1111',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_credit_card')).toBe(true);
  });

  it('detects US phone number with parentheses', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Call me at (555) 123-4567.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_phone')).toBe(true);
    expect(result.hasMediumSeverity).toBe(true);
  });

  it('detects US phone number with dots', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Call 555.123.4567 for details.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_phone')).toBe(true);
  });

  // --- Credentials ---

  it('detects API key patterns (sk_live_)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Use key sk_live_abcdefghijklmnopqrstuvwxyz to authenticate.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
  });

  it('detects API key patterns (pk_test_)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Public key: pk_test_abcdefghijklmnopqrstuvwxyz',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
  });

  it('detects AWS access key', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Access key: AKIAIOSFODNN7EXAMPLE',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_aws_key')).toBe(true);
  });

  it('detects password= assignments', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'password=MySecretP@ss123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  it('detects password: assignments', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'password: MySecretP@ss123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  it('detects RSA private key blocks', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_key')).toBe(true);
  });

  it('detects EC private key blocks', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: '-----BEGIN EC PRIVATE KEY-----\nMHQCAQ...',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_key')).toBe(true);
  });

  it('detects OPENSSH private key blocks', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_key')).toBe(true);
  });

  it('detects bearer tokens', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_bearer_token')).toBe(true);
  });

  it('detects MongoDB connection strings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Connect to mongodb://admin:pass@10.0.0.5:27017/mydb',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_connection_string')).toBe(true);
  });

  it('detects PostgreSQL connection strings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DB: postgres://user:pass@db.example.com:5432/prod',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_connection_string')).toBe(true);
  });

  it('detects Redis connection strings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Cache: redis://default:secret@cache.internal:6379',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_connection_string')).toBe(true);
  });

  it('detects GitHub personal access tokens', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_github_token')).toBe(true);
  });

  it('detects GitHub OAuth tokens', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_github_token')).toBe(true);
  });

  it('detects short GitHub tokens (20+ chars)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Token: ghp_ABCDEFGHIJKLMNOPQRST',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_github_token')).toBe(true);
  });

  it('detects GitHub fine-grained PAT (github_pat_)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Token: github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_github_token')).toBe(true);
  });

  // --- System internals ---

  it('detects 192.168.x.x private IPs', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'The server is at 192.168.1.100.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_ip')).toBe(true);
  });

  it('detects 10.x.x.x private IPs', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Internal API at 10.0.0.50:8080.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_ip')).toBe(true);
  });

  it('detects 172.16-31.x.x private IPs', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Docker bridge at 172.17.0.1.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_private_ip')).toBe(true);
  });

  it('detects /Users/ file paths', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'The config is at /Users/john/.ssh/config',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_file_path')).toBe(true);
  });

  it('detects /home/ file paths', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSH key at /home/deploy/.ssh/id_rsa',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_file_path')).toBe(true);
  });

  it('detects /etc/ file paths', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Check /etc/passwd for user list',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_file_path')).toBe(true);
  });

  it('detects environment variable assignments', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Set DATABASE_URL=postgres://localhost:5432/prod',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_env_variable')).toBe(true);
  });

  it('detects various env variable suffixes', () => {
    for (const suffix of ['_KEY', '_SECRET', '_TOKEN', '_PASSWORD']) {
      const result = scanOutboundEmail({
        to: 'ext@example.com',
        text: `MY_API${suffix}=somevalue123`,
      });
      expect(result.warnings.some(w => w.ruleId === 'ob_env_variable')).toBe(true);
    }
  });

  // --- Owner privacy ---

  it('detects "owner\'s name" references', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "My owner's name is John Smith and he lives in San Francisco.",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_owner_info')).toBe(true);
  });

  it('detects "owner\'s email" references', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "The owner's email is john@personal.com",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_owner_info')).toBe(true);
  });

  it('detects "the person who owns me" patterns', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'The person who owns me lives in New York.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_personal_reveal')).toBe(true);
  });

  it('detects "my human is" patterns', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'My human is named Jane and she works at Acme Corp.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_personal_reveal')).toBe(true);
  });

  it('detects "my operator" patterns', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'My operator lives in San Francisco.',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_personal_reveal')).toBe(true);
  });

  // --- Attachment risk ---

  it('detects high-risk attachment types (.pem, .key, .env)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Here are the files.',
      attachments: [
        { filename: 'server.pem', contentType: 'application/x-pem-file' },
        { filename: '.env', contentType: 'application/octet-stream' },
      ],
    });
    const sensitiveWarnings = result.warnings.filter(w => w.ruleId === 'ob_sensitive_file');
    expect(sensitiveWarnings.length).toBe(2);
  });

  it('detects all high-risk extensions', () => {
    const exts = ['.pem', '.key', '.p12', '.pfx', '.env', '.credentials', '.keystore', '.jks', '.p8'];
    for (const ext of exts) {
      const result = scanOutboundEmail({
        to: 'ext@example.com',
        attachments: [{ filename: `file${ext}` }],
      });
      expect(result.warnings.some(w => w.ruleId === 'ob_sensitive_file'), `Expected ${ext} to be detected`).toBe(true);
    }
  });

  it('detects medium-risk attachment types (.db, .sql, .csv)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Database export.',
      attachments: [
        { filename: 'users.db' },
        { filename: 'export.csv' },
      ],
    });
    const dataWarnings = result.warnings.filter(w => w.ruleId === 'ob_data_file');
    expect(dataWarnings.length).toBe(2);
  });

  it('detects all medium-risk extensions', () => {
    const exts = ['.db', '.sqlite', '.sqlite3', '.sql', '.csv', '.tsv', '.json', '.yml', '.yaml', '.conf', '.config', '.ini'];
    for (const ext of exts) {
      const result = scanOutboundEmail({
        to: 'ext@example.com',
        attachments: [{ filename: `data${ext}` }],
      });
      expect(result.warnings.some(w => w.ruleId === 'ob_data_file'), `Expected ${ext} to be detected`).toBe(true);
    }
  });

  it('handles attachments with no extension', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      attachments: [{ filename: 'secretkeyfile' }],
    });
    // No extension → no attachment warning (by design, unknown format)
    expect(result.warnings.filter(w => w.category === 'attachment_risk')).toHaveLength(0);
  });

  it('handles uppercase extensions correctly (.PEM, .KEY)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      attachments: [
        { filename: 'key.PEM' },
        { filename: 'database.DB' },
      ],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_sensitive_file')).toBe(true);
    expect(result.warnings.some(w => w.ruleId === 'ob_data_file')).toBe(true);
  });

  it('handles empty attachments array', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Clean email',
      attachments: [],
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('handles undefined attachments', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Clean email',
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('handles attachment with undefined filename', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      attachments: [{ contentType: 'application/octet-stream' }],
    });
    // No filename → no extension → no attachment warning
    expect(result.warnings.filter(w => w.category === 'attachment_risk')).toHaveLength(0);
  });

  // --- Truncation ---

  it('truncates very long matches at 80 characters plus ellipsis', () => {
    const longKey = 'sk_live_' + 'x'.repeat(100);
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: `Key: ${longKey}`,
    });
    const warning = result.warnings.find(w => w.ruleId === 'ob_api_key');
    expect(warning).toBeDefined();
    expect(warning!.match.length).toBe(83); // 80 + "..."
    expect(warning!.match).toMatch(/\.\.\.$/);
  });

  it('does not truncate short matches', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN: 123-45-6789',
    });
    const warning = result.warnings.find(w => w.ruleId === 'ob_ssn');
    expect(warning).toBeDefined();
    expect(warning!.match).toBe('123-45-6789');
    expect(warning!.match).not.toMatch(/\.\.\.$/);
  });

  // --- Multiple warnings ---

  it('detects multiple warnings from a single email', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789, password: secret, server at 192.168.1.1, my owner\'s name is John',
    });
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
    expect(result.warnings.some(w => w.ruleId === 'ob_private_ip')).toBe(true);
    expect(result.warnings.some(w => w.ruleId === 'ob_owner_info')).toBe(true);
  });

  it('summary correctly counts HIGH and MEDIUM severity', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789 and call (555) 123-4567 and server at 192.168.1.1',
    });
    expect(result.hasHighSeverity).toBe(true);
    expect(result.hasMediumSeverity).toBe(true);
    const highCount = result.warnings.filter(w => w.severity === 'high').length;
    const medCount = result.warnings.filter(w => w.severity === 'medium').length;
    expect(result.summary).toContain(`${highCount} HIGH severity`);
    expect(result.summary).toContain(`${medCount} MEDIUM severity`);
  });

  it('summary shows only HIGH when no MEDIUM warnings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789 and password: secret123',
    });
    expect(result.hasHighSeverity).toBe(true);
    expect(result.hasMediumSeverity).toBe(false);
    expect(result.summary).toContain('HIGH severity');
    expect(result.summary).not.toContain('MEDIUM severity');
  });

  it('summary shows only MEDIUM when no HIGH warnings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Server is at 192.168.1.1',
    });
    expect(result.hasHighSeverity).toBe(false);
    expect(result.hasMediumSeverity).toBe(true);
    expect(result.summary).not.toContain('HIGH severity');
    expect(result.summary).toContain('MEDIUM severity');
  });

  it('produces a summary with warning counts', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789 and server at 192.168.1.1',
    });
    expect(result.summary).toContain('OUTBOUND GUARD');
    expect(result.summary).toContain('warning(s)');
    // Has high severity → should say BLOCKED
    expect(result.summary).toContain('BLOCKED');
  });

  // --- Warning structure ---

  it('includes correct category and severity on each warning', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789',
    });
    const ssn = result.warnings.find(w => w.ruleId === 'ob_ssn');
    expect(ssn?.category).toBe('pii');
    expect(ssn?.severity).toBe('high');
    expect(ssn?.description).toContain('Social Security');
    expect(ssn?.match).toBe('123-45-6789');
  });

  // --- New rules: Bank, DL, DOB, expanded API keys ---

  it('detects bank routing numbers', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Routing number: 021000021',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_bank_routing')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects bank account numbers', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Account #: 12345678901234',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_bank_routing')).toBe(true);
  });

  it('detects "acct number" variant', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Acct number 9876543210',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_bank_routing')).toBe(true);
  });

  it('detects driver\'s license numbers', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "Driver's license: D1234567",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_drivers_license')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects DL# shorthand', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DL# F123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_drivers_license')).toBe(true);
  });

  it('detects driver\'s license with state code and hyphen (NC-98765432)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "Driver's license NC-98765432",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_drivers_license')).toBe(true);
  });

  it('detects DL with hyphenated format', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DL: CA-D1234567',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_drivers_license')).toBe(true);
  });

  it('detects date of birth with numeric format', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DOB: 03/15/1990',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_dob')).toBe(true);
    expect(result.hasMediumSeverity).toBe(true);
  });

  it('detects date of birth with text month', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Date of birth: March 15, 1990',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_dob')).toBe(true);
  });

  it('detects "born on" with date', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'born on 12/25/1985',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_dob')).toBe(true);
  });

  it('detects sk-proj- style API keys (OpenAI)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'API key: sk-proj-abcdefghijklmnopqrstuvwxyz1234',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
  });

  it('detects sk-ant- style API keys (Anthropic)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
  });

  it('detects sk-live- and sk-test- API keys', () => {
    for (const prefix of ['sk-live-', 'sk-test-']) {
      const result = scanOutboundEmail({
        to: 'ext@example.com',
        text: `Key: ${prefix}abcdefghijklmnopqrstuvwxyz`,
      });
      expect(result.warnings.some(w => w.ruleId === 'ob_api_key'), `Expected ${prefix} to be detected`).toBe(true);
    }
  });

  it('detects OpenAI keys with hyphenated format (sk-proj-XXX-XXX)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Key: sk-proj-ABC123-DEF456-GHI789-JKL012-MNO345',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_api_key')).toBe(true);
  });

  // --- New rules: passport, tax ID, ITIN, Medicare, immigration ---

  it('detects passport numbers', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Passport number: AB1234567',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_passport')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects passport # variant', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Passport #C98765432',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_passport')).toBe(true);
  });

  it('detects EIN / Tax ID', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'EIN: 12-3456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_tax_id')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects Tax identification number', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Tax identification number: 123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_tax_id')).toBe(true);
  });

  it('detects ITIN', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'ITIN: 912-34-5678',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_itin')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects ITIN without dashes', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'ITIN number 912345678',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_itin')).toBe(true);
  });

  it('detects Medicare ID', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Medicare #: 1EG4TE5MK72',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_medicare')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects health insurance ID', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Health insurance ID: XYZ12345678',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_medicare')).toBe(true);
  });

  it('detects immigration A-number', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'A-number: A123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_immigration')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects USCIS alien number', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'USCIS 12345678',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_immigration')).toBe(true);
  });

  it('detects PIN code', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'PIN: 4523',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_pin')).toBe(true);
    expect(result.hasMediumSeverity).toBe(true);
  });

  it('detects security question and answer', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "Security question: What is your mother's maiden name? Answer: Johnson",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_security_qa')).toBe(true);
  });

  it('detects "security answer" standalone', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Security answer: Fluffy',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_security_qa')).toBe(true);
  });

  it('detects "mother\'s maiden name"', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "Mother's maiden name: Rodriguez",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_security_qa')).toBe(true);
  });

  it('detects "first pet\'s name"', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: "First pet's name: Buddy",
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_security_qa')).toBe(true);
  });

  // --- New rules: IBAN, SWIFT, crypto wallet, wire transfer ---

  it('detects IBAN number', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'IBAN: GB29 NWBK 6016 1331 9268 19',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_iban')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects SWIFT/BIC code', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SWIFT code: NWBKGB2L',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_swift')).toBe(true);
  });

  it('detects Bitcoin address (bc1)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_crypto_wallet')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects Ethereum address (0x)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'ETH: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_crypto_wallet')).toBe(true);
  });

  it('detects wire transfer instructions', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Please wire transfer the funds to routing number 021000021, beneficiary John Smith',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_wire_transfer')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  // --- New rules: Stripe key, JWT, webhook, env block, seed phrase, 2FA, credential pair, OAuth, VPN ---

  it('detects Stripe live key', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Stripe key: sk_live_51ABCdefGHIjklMNOpqrSTUvwxyz',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_stripe_key')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects Stripe restricted key', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Key: rk_live_abcdefghijklmnopqrstuvwxyz',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_stripe_key')).toBe(true);
  });

  it('detects JWT token', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_jwt')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects Slack webhook URL', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Post to https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_webhook_url')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects Discord webhook URL', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Webhook: https://discord.com/api/webhooks/123456789/abcdefghijklmn',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_webhook_url')).toBe(true);
  });

  it('detects .env block (3+ consecutive env vars)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DB_HOST=localhost\nDB_PORT=5432\nDB_PASSWORD=secret123\nAPI_KEY=abc123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_env_block')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('does not trigger .env block for only 2 env vars', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'DB_HOST=localhost\nDB_PORT=5432',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_env_block')).toBe(false);
  });

  it('detects seed phrase', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_seed_phrase')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects recovery phrase', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Recovery phrase: word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_seed_phrase')).toBe(true);
  });

  it('detects 2FA backup codes', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: '2FA codes: ABCD1234 EFGH5678 IJKL9012',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_2fa_codes')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects recovery codes with dashes', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Backup codes: 1234-5678-9012-3456-7890-1234',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_2fa_codes')).toBe(true);
  });

  it('detects username + password pair', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'username: admin password: secret123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_credential_pair')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects email + password pair', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'email=user@test.com, password=P@ssw0rd!',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_credential_pair')).toBe(true);
  });

  it('detects OAuth access_token', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'access_token=ya29.a0AfB_byDxxxxxXXXXXXX',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_oauth_token')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects OAuth refresh_token', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'refresh_token=1_abc-defGHIJKLMNOPQRSTUVWXYZ',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_oauth_token')).toBe(true);
  });

  it('detects VPN credentials', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'VPN password is MyVpnPass123!',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_vpn_creds')).toBe(true);
    expect(result.hasHighSeverity).toBe(true);
  });

  it('detects WireGuard pre-shared key', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'WireGuard pre-shared key = abc123xyz456',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_vpn_creds')).toBe(true);
  });

  // --- HTML tag stripping ---

  it('detects AWS key split across HTML tags', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      html: '<p>Key: AKI<b>A</b>IOSFODNN7EXAMPLE</p>',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_aws_key')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects SSN in HTML with tags stripped', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      html: '<div><span>123</span>-<span>45</span>-<span>6789</span></div>',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn')).toBe(true);
  });

  it('detects password hidden in HTML style/class attributes', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      html: '<p class="secret">password: hunter2</p>',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  it('strips script and style blocks before scanning', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      html: '<style>.x{color:red}</style><script>var x=1</script><p>Clean content</p>',
    });
    expect(result.warnings).toHaveLength(0);
  });

  // --- Attachment content scanning ---

  it('detects SSN in text file attachment content', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Please see attached.',
      attachments: [{
        filename: 'data.txt',
        contentType: 'text/plain',
        content: 'Customer SSN: 123-45-6789',
      }],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn' && w.description.includes('attachment'))).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects AWS key in JSON attachment', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Config file attached.',
      attachments: [{
        filename: 'config.json',
        contentType: 'application/json',
        content: '{"aws_key": "AKIAIOSFODNN7EXAMPLE"}',
      }],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_aws_key' && w.description.includes('attachment'))).toBe(true);
  });

  it('detects password in .env attachment', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Here are the env vars.',
      attachments: [{
        filename: '.env',
        content: 'DB_HOST=localhost\nDB_PORT=5432\nDB_PASSWORD=secret123\nAPI_KEY=abc123',
      }],
    });
    // Should trigger ob_env_block (3+ consecutive env vars) in attachment content
    expect(result.warnings.some(w => w.ruleId === 'ob_env_block' && w.description.includes('attachment'))).toBe(true);
  });

  it('detects sensitive data in CSV attachment', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Export attached.',
      attachments: [{
        filename: 'users.csv',
        contentType: 'text/csv',
        content: 'name,ssn\nJohn,123-45-6789\nJane,987-65-4321',
      }],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn' && w.description.includes('attachment'))).toBe(true);
  });

  it('detects sensitive data in Buffer attachment content', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'File attached.',
      attachments: [{
        filename: 'notes.txt',
        contentType: 'text/plain',
        content: Buffer.from('password: supersecret123'),
      }],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value' && w.description.includes('attachment'))).toBe(true);
  });

  it('does NOT scan binary attachment content (image)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Photo attached.',
      attachments: [{
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        content: 'password: secret (this is fake binary data)',
      }],
    });
    // Should not scan image content
    expect(result.warnings.some(w => w.description.includes('attachment'))).toBe(false);
  });

  it('does NOT scan PDF attachment content', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Report attached.',
      attachments: [{
        filename: 'report.pdf',
        contentType: 'application/pdf',
        content: 'SSN: 123-45-6789 (fake binary)',
      }],
    });
    expect(result.warnings.some(w => w.description.includes('attachment'))).toBe(false);
  });

  it('scans attachment by extension when contentType is missing', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Script attached.',
      attachments: [{
        filename: 'deploy.sh',
        content: 'password=mysecret123',
      }],
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value' && w.description.includes('attachment'))).toBe(true);
  });

  it('handles attachment with no content gracefully', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Clean email',
      attachments: [{ filename: 'data.txt', contentType: 'text/plain' }],
    });
    // No content → no content-based warnings (may still have extension warning)
    expect(result.warnings.some(w => w.description.includes('attachment: data.txt'))).toBe(false);
  });

  // --- Obfuscated SSN ---

  it('detects SSN with dots (123.45.6789)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN: 123.45.6789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn_obfuscated')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects SSN with spaces (123 45 6789)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN: 123 45 6789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn_obfuscated')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects 9-digit SSN with keyword context', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN: 123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn_obfuscated')).toBe(true);
  });

  it('detects "social security" + 9 digits', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Social security number: 123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn_obfuscated')).toBe(true);
  });

  it('does NOT false-positive on 9 digits without SSN keyword', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Order number: 123456789',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_ssn_obfuscated')).toBe(false);
  });

  // --- Leet-speak password ---

  it('detects p@ssword: value', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'p@ssword: hunter2',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it('detects p4ssword= value', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'p4ssword=supersecret',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  it('detects p@ss: value (shortened leet)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'p@ss: MyS3cret!',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  it('still detects standard password: value', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'password: secret123',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_password_value')).toBe(true);
  });

  // --- AWS key in env var format ---

  it('detects AWS key in env var format (AWS_ACCESS_KEY_ID=AKIA...)', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    });
    expect(result.warnings.some(w => w.ruleId === 'ob_aws_key')).toBe(true);
  });

  // --- Block mode ---

  it('blocks (blocked=true) when high severity warnings exist', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'SSN 123-45-6789',
    });
    expect(result.blocked).toBe(true);
    expect(result.summary).toContain('BLOCKED');
    expect(result.summary).toContain('NOT sent');
  });

  it('does not block (blocked=false) for medium-only warnings', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Server at 192.168.1.1',
    });
    expect(result.blocked).toBe(false);
    expect(result.hasMediumSeverity).toBe(true);
    expect(result.summary).not.toContain('BLOCKED');
  });

  it('does not block (blocked=false) for clean emails', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Hello, how are you?',
    });
    expect(result.blocked).toBe(false);
  });

  it('does not block for localhost recipients even with PII', () => {
    const result = scanOutboundEmail({
      to: 'agent@localhost',
      text: 'SSN 123-45-6789 and password: secret',
    });
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('blocks for high-risk attachment types', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Here is the key file',
      attachments: [{ filename: 'server.pem' }],
    });
    expect(result.blocked).toBe(true);
    expect(result.summary).toContain('BLOCKED');
  });

  it('does not block for medium-risk attachment types only', () => {
    const result = scanOutboundEmail({
      to: 'ext@example.com',
      text: 'Here is the export',
      attachments: [{ filename: 'data.csv' }],
    });
    expect(result.blocked).toBe(false);
    expect(result.hasMediumSeverity).toBe(true);
  });
});

// ─── buildInboundSecurityAdvisory ────────────────────────────────────

describe('buildInboundSecurityAdvisory', () => {
  // --- Basic behavior ---

  it('returns empty advisory for clean email', () => {
    const result = buildInboundSecurityAdvisory(undefined, []);
    expect(result.attachmentWarnings).toHaveLength(0);
    expect(result.linkWarnings).toHaveLength(0);
    expect(result.summary).toBe('');
  });

  it('returns empty advisory for undefined attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, undefined as any);
    expect(result.attachmentWarnings).toHaveLength(0);
    expect(result.summary).toBe('');
  });

  it('returns empty advisory for empty attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, []);
    expect(result.attachmentWarnings).toHaveLength(0);
  });

  // --- Executable attachments ---

  it('warns about .exe attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'invoice.exe', size: 1024 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('HIGH');
    expect(result.attachmentWarnings[0].detail).toContain('EXECUTABLE');
  });

  it('warns about all executable extensions', () => {
    const exts = ['.exe', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.scr', '.com', '.vbs', '.wsf', '.hta', '.cpl', '.jar', '.app', '.dmg', '.run'];
    for (const ext of exts) {
      const result = buildInboundSecurityAdvisory(undefined, [
        { filename: `file${ext}`, size: 1024 },
      ]);
      expect(result.attachmentWarnings.length, `Expected ${ext} to produce warning`).toBeGreaterThanOrEqual(1);
    }
  });

  // --- Double extension ---

  it('warns about double extension attachments (pdf.exe)', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'document.pdf.exe', size: 1024 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('CRITICAL');
    expect(result.attachmentWarnings[0].detail).toContain('DOUBLE EXTENSION');
  });

  it('warns about double extension attachments (doc.bat)', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'report.doc.bat', size: 2048 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('CRITICAL');
    expect(result.attachmentWarnings[0].detail).toContain('DOUBLE EXTENSION');
    expect(result.attachmentWarnings[0].detail).toContain('.doc');
  });

  it('warns about triple extension (pdf.doc.exe)', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'invoice.pdf.doc.exe', size: 512 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('CRITICAL');
  });

  it('does NOT flag double extension when last ext is not executable', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'backup.2024.tar.gz', size: 5000 },
    ]);
    // .gz is not an executable, so no CRITICAL warning — it's an ARCHIVE
    expect(result.attachmentWarnings.every(w => w.risk !== 'CRITICAL')).toBe(true);
  });

  // --- Archive attachments ---

  it('warns about archive attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'payload.zip', size: 5000 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('MEDIUM');
    expect(result.attachmentWarnings[0].detail).toContain('ARCHIVE');
  });

  it('warns about all archive extensions', () => {
    const exts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.cab', '.iso'];
    for (const ext of exts) {
      const result = buildInboundSecurityAdvisory(undefined, [
        { filename: `archive${ext}`, size: 5000 },
      ]);
      expect(result.attachmentWarnings.length, `Expected ${ext} to produce warning`).toBeGreaterThanOrEqual(1);
    }
  });

  // --- HTML attachments ---

  it('warns about .html attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'login.html', size: 512 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('HIGH');
    expect(result.attachmentWarnings[0].detail).toContain('HTML file');
  });

  it('warns about .htm attachments', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'page.htm', size: 512 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.attachmentWarnings[0].risk).toBe('HIGH');
  });

  // --- Safe attachments ---

  it('does not warn about safe file types', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'document.pdf', size: 1024 },
      { filename: 'photo.jpg', size: 2048 },
      { filename: 'spreadsheet.xlsx', size: 512 },
      { filename: 'readme.txt', size: 256 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(0);
  });

  // --- Multiple attachment warnings ---

  it('warns about multiple dangerous attachments in one email', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { filename: 'update.exe', size: 1024 },
      { filename: 'backup.zip', size: 5000 },
      { filename: 'login.html', size: 512 },
      { filename: 'invoice.pdf.bat', size: 2048 },
    ]);
    expect(result.attachmentWarnings).toHaveLength(4);
    expect(result.attachmentWarnings.some(w => w.risk === 'CRITICAL')).toBe(true);
    expect(result.attachmentWarnings.some(w => w.risk === 'HIGH')).toBe(true);
    expect(result.attachmentWarnings.some(w => w.risk === 'MEDIUM')).toBe(true);
  });

  // --- Link warnings from spam matches ---

  it('includes link warning for mismatched display URL', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 35, category: 'phishing', isWarning: true, matches: [{ ruleId: 'ph_mismatched_display_url' }] },
      [],
    );
    expect(result.linkWarnings).toHaveLength(1);
    expect(result.linkWarnings[0].detail).toContain('PHISHING');
  });

  it('includes all supported link warning types', () => {
    const ruleIds = [
      'ph_data_uri',
      'ph_homograph',
      'ph_spoofed_sender',
      'ph_credential_harvest',
      'de_webhook_exfil',
      'pi_invisible_unicode',
    ];
    for (const ruleId of ruleIds) {
      const result = buildInboundSecurityAdvisory(
        { matches: [{ ruleId }] },
        [],
      );
      expect(result.linkWarnings.length, `Expected ${ruleId} to produce warning`).toBe(1);
    }
  });

  it('ignores unknown spam rule IDs', () => {
    const result = buildInboundSecurityAdvisory(
      { matches: [{ ruleId: 'cs_all_caps_subject' }, { ruleId: 'unknown_rule' }] },
      [],
    );
    expect(result.linkWarnings).toHaveLength(0);
  });

  // --- Spam score in summary ---

  it('includes [SPAM] in summary when isSpam', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 65, category: 'prompt_injection', isSpam: true, matches: [] },
      [],
    );
    expect(result.summary).toContain('[SPAM]');
    expect(result.summary).toContain('65');
    expect(result.isSpam).toBe(true);
    expect(result.spamScore).toBe(65);
    expect(result.spamCategory).toBe('prompt_injection');
  });

  it('includes [WARNING] in summary when isWarning', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 30, category: 'phishing', isWarning: true, matches: [] },
      [],
    );
    expect(result.summary).toContain('[WARNING]');
    expect(result.summary).toContain('30');
    expect(result.isWarning).toBe(true);
  });

  it('does not include spam line when score is low', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 5, category: undefined, isSpam: false, isWarning: false, matches: [] },
      [],
    );
    expect(result.summary).not.toContain('[SPAM]');
    expect(result.summary).not.toContain('[WARNING]');
  });

  // --- Partial security metadata ---

  it('handles partial security metadata (score only)', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 45 },
      [{ filename: 'document.zip', size: 1024 }],
    );
    expect(result.spamScore).toBe(45);
    expect(result.isSpam).toBeUndefined();
    expect(result.isWarning).toBeUndefined();
    expect(result.attachmentWarnings).toHaveLength(1);
  });

  // --- Combined advisory ---

  it('combines attachment and link warnings in summary', () => {
    const result = buildInboundSecurityAdvisory(
      { score: 40, category: 'phishing', isWarning: true, matches: [{ ruleId: 'ph_mismatched_display_url' }] },
      [{ filename: 'update.exe', size: 2048 }],
    );
    expect(result.attachmentWarnings).toHaveLength(1);
    expect(result.linkWarnings).toHaveLength(1);
    expect(result.summary).toContain('attachment warning');
    expect(result.summary).toContain('link/content warning');
  });

  it('builds full advisory with spam + attachments + links', () => {
    const result = buildInboundSecurityAdvisory(
      {
        score: 55, category: 'phishing', isSpam: true,
        matches: [
          { ruleId: 'ph_mismatched_display_url' },
          { ruleId: 'ph_spoofed_sender' },
          { ruleId: 'de_webhook_exfil' },
        ],
      },
      [
        { filename: 'invoice.pdf.exe', size: 1024 },
        { filename: 'data.zip', size: 5000 },
      ],
    );
    expect(result.attachmentWarnings).toHaveLength(2);
    expect(result.linkWarnings).toHaveLength(3);
    expect(result.summary).toContain('[SPAM]');
    expect(result.summary).toContain('attachment warning');
    expect(result.summary).toContain('link/content warning');
  });

  // --- Attachment with no filename ---

  it('handles attachment with no filename as "unknown"', () => {
    const result = buildInboundSecurityAdvisory(undefined, [
      { size: 1024 },
    ]);
    // "unknown" has no known extension → no warning
    expect(result.attachmentWarnings).toHaveLength(0);
  });
});
