import { describe, expect, it } from 'vitest';
import {
  formatUnreadInboxContext,
  resolveInboxInjectionConfig,
  sanitizeInboxPreview,
} from '../inbox-injection.js';

describe('resolveInboxInjectionConfig', () => {
  it('uses safe summary defaults', () => {
    expect(resolveInboxInjectionConfig(undefined)).toEqual({
      mode: 'summary',
      maxItems: 5,
      includePreview: false,
    });
  });

  it('accepts configured mode, max items, and preview flag', () => {
    expect(resolveInboxInjectionConfig({
      inboxInjectionMode: 'required',
      inboxInjectionMaxItems: '12',
      inboxInjectionIncludePreview: true,
    })).toEqual({
      mode: 'required',
      maxItems: 12,
      includePreview: true,
    });
  });

  it('clamps item count and ignores invalid modes', () => {
    expect(resolveInboxInjectionConfig({
      inboxInjectionMode: 'always',
      inboxInjectionMaxItems: 100,
    })).toEqual({
      mode: 'summary',
      maxItems: 25,
      includePreview: false,
    });
  });
});

describe('formatUnreadInboxContext', () => {
  const summaries = [{
    uid: 42,
    from: 'agent@localhost',
    subject: 'Status',
    tag: 'agent' as const,
  }];

  it('does not emit message body previews by default', () => {
    const lines = formatUnreadInboxContext(2, summaries, {
      mode: 'summary',
      maxItems: 5,
      includePreview: false,
    });

    expect(lines.join('\n')).toContain('You have 2 unread email(s)');
    expect(lines.join('\n')).toContain('Use agenticmail_read when an unread email is relevant');
    expect(lines.join('\n')).not.toContain('ACTION REQUIRED');
  });

  it('supports count-only mode without summaries', () => {
    const lines = formatUnreadInboxContext(3, summaries, {
      mode: 'count',
      maxItems: 5,
      includePreview: false,
    });

    expect(lines.join('\n')).toContain('You have 3 unread email(s)');
    expect(lines.join('\n')).not.toContain('UID 42');
    expect(lines.join('\n')).not.toContain('ACTION REQUIRED');
  });

  it('keeps explicit required mode available', () => {
    const lines = formatUnreadInboxContext(1, summaries, {
      mode: 'required',
      maxItems: 5,
      includePreview: false,
    });

    expect(lines.join('\n')).toContain('ACTION REQUIRED');
    expect(lines.join('\n')).toContain('Read each unread email');
  });
});

describe('sanitizeInboxPreview', () => {
  it('normalizes whitespace and caps previews', () => {
    const preview = sanitizeInboxPreview(`one\n${'two '.repeat(80)}`);

    expect(preview).toMatch(/^one two/);
    expect(preview?.length).toBeLessThanOrEqual(200);
  });
});
