/**
 * formatEndOfCallDigest — pure-formatter unit tests.
 *
 * The notifyCallEnded side-effect path is exercised end-to-end by the
 * realtime-voice integration tests; here we focus on the digest text
 * shape so future tweaks (added headlines, longer turn budgets, etc.)
 * are protected against regressions.
 */
import { describe, expect, it } from 'vitest';
import { formatEndOfCallDigest, type FormatEndOfCallInput } from '../notifications/end-of-call.js';

function base(input: Partial<FormatEndOfCallInput> = {}): FormatEndOfCallInput {
  return {
    missionId: 'call_abc123',
    to: '+13105550100',
    task: 'Cancel my 3pm dentist appointment for Tuesday',
    reason: 'agent-requested',
    endedByTimeBudget: false,
    pendingToolCalls: 0,
    callbackArmed: false,
    transcript: [],
    ...input,
  };
}

describe('formatEndOfCallDigest — headline classification', () => {
  it('agent-requested → "agent wrapped up"', () => {
    expect(formatEndOfCallDigest(base({ reason: 'agent-requested' }))).toContain('✅ Call ended — agent wrapped up');
  });

  it('time-budget end wins even when the bridge tag is agent-requested', () => {
    const out = formatEndOfCallDigest(base({ reason: 'agent-requested', endedByTimeBudget: true }));
    expect(out).toContain('⏰ Call ended — time budget reached');
    expect(out).not.toContain('agent wrapped up');
  });

  it('carrier bye (twilio-bye / elks-bye) → "other party hung up"', () => {
    expect(formatEndOfCallDigest(base({ reason: 'twilio-bye' }))).toContain('📞 Call ended — other party hung up');
    expect(formatEndOfCallDigest(base({ reason: 'elks-bye' }))).toContain('📞 Call ended — other party hung up');
  });

  it('openai-closed → "voice runtime disconnected"', () => {
    expect(formatEndOfCallDigest(base({ reason: 'openai-closed' }))).toContain('⚠️ Call ended — voice runtime disconnected');
  });

  it('unknown reason → generic "Call ended"', () => {
    const out = formatEndOfCallDigest(base({ reason: 'something-else' }));
    expect(out).toMatch(/^📞 Call ended\n/);
  });
});

describe('formatEndOfCallDigest — interleaved transcript', () => {
  it('shows last N exchanges in chronological order with both sides labelled', () => {
    const transcript = [
      { source: 'system' as const, at: '1', text: 'Realtime voice bridge connected.' },
      { source: 'agent' as const, at: '2', text: 'Hi, this is Alice calling for Ope.' },
      { source: 'provider' as const, at: '3', text: 'Sure, can I get the patient name?' },
      { source: 'agent' as const, at: '4', text: 'Opeyemi Olatunji, appointment was at 3pm Tuesday.' },
      { source: 'provider' as const, at: '5', text: 'Confirmed, cancelled. Anything else?' },
      { source: 'agent' as const, at: '6', text: 'No, that\'s all. Thanks!' },
    ];
    const out = formatEndOfCallDigest(base({ transcript, reason: 'agent-requested' }));
    // System lines are dropped; agent + provider preserved.
    expect(out).not.toContain('Realtime voice bridge connected');
    // Both speakers labelled.
    expect(out).toContain('• Agent: Hi, this is Alice calling for Ope.');
    expect(out).toContain('• Other party: Sure, can I get the patient name?');
    expect(out).toContain('• Other party: Confirmed, cancelled. Anything else?');
    // Order preserved (provider after agent on turn 3).
    const agentIdx = out.indexOf('• Agent: Hi,');
    const providerIdx = out.indexOf('• Other party: Sure');
    expect(providerIdx).toBeGreaterThan(agentIdx);
  });

  it('honours the turnBudget option', () => {
    const transcript = [
      { source: 'agent' as const, at: '1', text: 'a1' },
      { source: 'provider' as const, at: '2', text: 'p1' },
      { source: 'agent' as const, at: '3', text: 'a2' },
      { source: 'provider' as const, at: '4', text: 'p2' },
      { source: 'agent' as const, at: '5', text: 'a3' },
    ];
    const out = formatEndOfCallDigest(base({ transcript }), { turnBudget: 2 });
    expect(out).toContain('Last 2 exchange(s):');
    expect(out).toContain('• Other party: p2');
    expect(out).toContain('• Agent: a3');
    expect(out).not.toContain('• Agent: a1');
  });

  it('truncates long turns to perTurnChars', () => {
    const longText = 'x'.repeat(500);
    const out = formatEndOfCallDigest(base({
      transcript: [{ source: 'agent' as const, at: '1', text: longText }],
    }), { perTurnChars: 50 });
    expect(out).toContain('…');
    // Bullet line under cap (label "• Agent: " plus truncated body plus ellipsis).
    const line = out.split('\n').find((l) => l.startsWith('• Agent:'))!;
    expect(line.length).toBeLessThanOrEqual('• Agent: '.length + 50 + 1);
  });
});

describe('formatEndOfCallDigest — markers + footer', () => {
  it('includes the callback-armed marker when a callback was scheduled', () => {
    const out = formatEndOfCallDigest(base({ callbackArmed: true }));
    expect(out).toContain('🔁 A callback was scheduled');
  });

  it('includes the pending-tool-calls warning when there are pending calls and no callback armed', () => {
    const out = formatEndOfCallDigest(base({ pendingToolCalls: 1, callbackArmed: false }));
    expect(out).toContain('⚠️ The call dropped while 1 tool call(s)');
  });

  it('does NOT show pending-tool-calls warning when a callback was armed (the callback is the resolution)', () => {
    const out = formatEndOfCallDigest(base({ pendingToolCalls: 1, callbackArmed: true }));
    expect(out).not.toContain('still in flight');
    expect(out).toContain('🔁 A callback was scheduled');
  });

  it('always ends with the mission footer', () => {
    const out = formatEndOfCallDigest(base());
    expect(out.trim().endsWith('Mission: call_abc123')).toBe(true);
  });
});
