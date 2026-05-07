import { describe, expect, it } from 'vitest';
import { classifyEmailRoute } from '../mail/route-classifier.js';
import type { ParsedEmail } from '../mail/types.js';

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    messageId: 'm1',
    subject: 'Project update',
    from: [{ address: 'sender@example.com' }],
    to: [{ address: 'agent@localhost' }],
    date: new Date('2026-05-07T00:00:00Z'),
    text: 'Here is the latest update.',
    attachments: [],
    headers: new Map(),
    ...overrides,
  };
}

describe('classifyEmailRoute', () => {
  it('routes spam to ignore_spam', () => {
    const route = classifyEmailRoute({
      email: email(),
      spam: { score: 45, isSpam: true, isWarning: false, topCategory: 'phishing' },
    });

    expect(route.routeClass).toBe('ignore_spam');
    expect(route.action).toBe('ignore');
    expect(route.gateRequired).toBe(false);
  });

  it('respects human/private mailbox policy', () => {
    const route = classifyEmailRoute({
      email: email(),
      account: { metadata: { emailRoutePolicy: 'private' } },
    });

    expect(route.routeClass).toBe('human_private');
    expect(route.action).toBe('notify');
    expect(route.gateRequired).toBe(true);
  });

  it('routes newsletters to ignore_newsletter', () => {
    const route = classifyEmailRoute({
      email: email({
        headers: new Map([['List-Unsubscribe', '<mailto:unsubscribe@example.com>']]),
      }),
    });

    expect(route.routeClass).toBe('ignore_newsletter');
    expect(route.action).toBe('ignore');
  });

  it('routes automated notifications to archive_automated', () => {
    const route = classifyEmailRoute({
      email: email({
        subject: 'Build notification',
        from: [{ address: 'no-reply@example.com' }],
      }),
    });

    expect(route.routeClass).toBe('archive_automated');
    expect(route.action).toBe('archive');
  });

  it('routes internal instructions to agent_instruction', () => {
    const route = classifyEmailRoute({
      email: email({
        subject: 'Task',
        from: [{ address: 'coordinator@localhost' }],
        text: 'Please research this and send a summary.',
      }),
    });

    expect(route.routeClass).toBe('agent_instruction');
    expect(route.action).toBe('create_task');
    expect(route.gateRequired).toBe(true);
  });

  it('routes commercial urgency to deal_escalation', () => {
    const route = classifyEmailRoute({
      email: email({
        subject: 'Contract deadline',
        text: 'We need pricing and a signed proposal by Friday.',
      }),
    });

    expect(route.routeClass).toBe('deal_escalation');
    expect(route.action).toBe('escalate');
    expect(route.gateRequired).toBe(true);
  });

  it('defaults regular mail to project_update', () => {
    const route = classifyEmailRoute({ email: email() });

    expect(route.routeClass).toBe('project_update');
    expect(route.action).toBe('notify');
    expect(route.gateRequired).toBe(false);
  });
});
