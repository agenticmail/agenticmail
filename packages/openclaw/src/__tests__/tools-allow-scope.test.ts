import { describe, expect, it } from 'vitest';
import { agenticmailAllowedByToolsScope } from '../../index.js';

describe('agenticmailAllowedByToolsScope', () => {
  it('allows AgenticMail hooks when no toolsAllow scope is present', () => {
    expect(agenticmailAllowedByToolsScope(undefined, {}, { cron: {} })).toBe(true);
  });

  it('disables AgenticMail hooks when a cron tool scope excludes AgenticMail', () => {
    expect(agenticmailAllowedByToolsScope({ cron: { toolsAllow: ['exec'] } })).toBe(false);
    expect(agenticmailAllowedByToolsScope({ toolsAllow: 'exec,sessions_spawn' })).toBe(false);
  });

  it('allows AgenticMail hooks when the scoped allowlist includes AgenticMail tools', () => {
    expect(agenticmailAllowedByToolsScope({ toolsAllow: ['exec', 'agenticmail_send'] })).toBe(true);
    expect(agenticmailAllowedByToolsScope({ toolsAllow: 'agenticmail_*' })).toBe(true);
    expect(agenticmailAllowedByToolsScope({ toolsAllow: ['*'] })).toBe(true);
  });

  it('uses the nearest explicit scope before broader plugin config', () => {
    expect(agenticmailAllowedByToolsScope(
      { toolsAllow: ['exec'] },
      { toolsAllow: ['agenticmail_*'] },
    )).toBe(false);
  });
});
