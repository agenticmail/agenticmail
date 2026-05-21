import { describe, expect, it } from 'vitest';
import {
  buildPhoneMissionPolicy,
  classifyPhoneNumberRisk,
  inferPhoneRegion,
  isPhoneRegionAllowed,
  validatePhoneMissionPolicy,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
  type OpenClawPhoneMissionPolicy,
  type PhoneTransportProfile,
} from '../phone/index.js';

const policy: OpenClawPhoneMissionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['AT', 'DE'],
  maxCallDurationSeconds: 900,
  maxCostPerMission: 10,
  maxAttempts: 2,
  transcriptEnabled: true,
  recordingEnabled: false,
  confirmPolicy: {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  },
  alternativePolicy: {
    maxTimeShiftMinutes: 30,
  },
};

const transport: PhoneTransportProfile = {
  provider: '46elks',
  phoneNumber: '+43123456789',
  capabilities: ['sms', 'call_control'],
  supportedRegions: ['AT', 'DE'],
};

describe('phone mission policy validation', () => {
  it('builds safe preset policies for host tools without custom JSON', () => {
    const built = buildPhoneMissionPolicy({
      preset: 'reservation',
      regionAllowlist: ['AT', 'DE', 'EU'],
      maxCallDurationSeconds: 1200,
      maxCostPerMission: 1.5,
      maxTimeShiftMinutes: 45,
      voiceRuntime: 'openai',
      voice: 'cedar',
    });

    expect(validatePhoneMissionPolicy(built).ok).toBe(true);
    expect(built).toMatchObject({
      policyVersion: 1,
      regionAllowlist: ['AT', 'DE', 'EU'],
      maxCallDurationSeconds: 1200,
      maxCostPerMission: 1.5,
      maxAttempts: 2,
      transcriptEnabled: true,
      recordingEnabled: false,
      confirmPolicy: {
        paymentDetails: 'never',
        contractCommitment: 'never',
        costOverLimit: 'needs_operator',
        sensitivePersonalData: 'needs_operator',
        unclearAlternative: 'needs_operator',
      },
      alternativePolicy: { maxTimeShiftMinutes: 45 },
      voiceRuntime: 'openai',
      voice: 'cedar',
    });
  });

  it('rejects invalid safe-policy overrides instead of silently defaulting them', () => {
    expect(() => buildPhoneMissionPolicy({
      regionAllowlist: ['Mars' as any],
    })).toThrow(/regionAllowlist/);
    expect(() => buildPhoneMissionPolicy({
      maxCostPerMission: -1,
    })).toThrow(/maxCostPerMission/);
  });

  it('accepts a complete OpenClaw-provided mission policy', () => {
    const result = validatePhoneMissionPolicy(policy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.confirmPolicy.paymentDetails).toBe('never');
      expect(result.policy.alternativePolicy.maxTimeShiftMinutes).toBe(30);
    }
  });

  it('fails closed for missing or newer policy versions', () => {
    expect(validatePhoneMissionPolicy(null).ok).toBe(false);

    const result = validatePhoneMissionPolicy({ ...policy, policyVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('unsupported-policy-version');
    }
  });

  it('rejects unsafe confirm policies', () => {
    const result = validatePhoneMissionPolicy({
      ...policy,
      confirmPolicy: {
        ...policy.confirmPolicy,
        paymentDetails: 'allowed',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('unsafe-confirm-policy');
    }
  });
});

describe('phone transport validation', () => {
  it('requires call_control to start phone missions', () => {
    const result = validatePhoneTransportProfile({
      ...transport,
      capabilities: ['sms'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('missing-call-control');
    }
  });

  it('infers target regions and allows EU umbrella policies', () => {
    expect(inferPhoneRegion('+436641234567')).toBe('AT');
    expect(inferPhoneRegion('+491711234567')).toBe('DE');
    expect(inferPhoneRegion('+46701234567')).toBe('EU');
    expect(inferPhoneRegion('+12125551234')).toBe('WORLD');
    expect(isPhoneRegionAllowed('AT', ['EU'])).toBe(true);
    expect(isPhoneRegionAllowed('WORLD', ['EU'])).toBe(false);
  });
});

describe('phone mission start validation', () => {
  it('normalizes a valid mission start request', () => {
    const result = validatePhoneMissionStart({
      to: '+43 664 1234567',
      task: 'Reserve dinner at 19:30',
      policy,
      voiceRuntimeRef: 'openclaw:voice-default',
    }, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mission.to).toBe('+436641234567');
      expect(result.mission.targetRegion).toBe('AT');
      expect(result.mission.transport.provider).toBe('46elks');
      expect(result.mission.voiceRuntimeRef).toBe('openclaw:voice-default');
    }
  });

  it('rejects targets outside the mission policy region allowlist', () => {
    const result = validatePhoneMissionStart({
      to: '+46701234567',
      task: 'Call Sweden',
      policy,
    }, { ...transport, supportedRegions: ['EU'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('region-not-allowed');
    }
  });

  it('blocks premium or special-rate numbers unless explicitly allowed', () => {
    expect(classifyPhoneNumberRisk('+491900123456')).toBe('premium_or_special');

    const blocked = validatePhoneMissionStart({
      to: '+491900123456',
      task: 'Call premium line',
      policy,
    }, transport);

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.issues.map((item) => item.code)).toContain('premium-number-blocked');
    }
  });

  it('requires recording support when mission policy enables recording', () => {
    const result = validatePhoneMissionStart({
      to: '+436641234567',
      task: 'Record this call',
      policy: { ...policy, recordingEnabled: true },
    }, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('recording-unsupported');
    }
  });
});

describe('phone mission server-side hardening', () => {
  it('clamps caller-supplied policy limits down to the server caps (#42-H1/#43-H2)', () => {
    const result = validatePhoneMissionPolicy({
      ...policy,
      maxCallDurationSeconds: 999_999,
      maxCostPerMission: 1e9,
      maxAttempts: 100_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The caller asked for absurd "limits"; the server cap wins.
      // (v0.9.82 raised the duration ceiling from 3600 to 7200 — see
      // PHONE_SERVER_MAX_CALL_DURATION_SECONDS in mission.ts for the rationale.)
      expect(result.policy.maxCallDurationSeconds).toBe(7200);
      expect(result.policy.maxCostPerMission).toBe(5);
      expect(result.policy.maxAttempts).toBe(3);
    }
  });

  it('keeps a caller policy that is stricter than the server cap', () => {
    const result = validatePhoneMissionPolicy({
      ...policy,
      maxCallDurationSeconds: 120,
      maxCostPerMission: 1,
      maxAttempts: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // A stricter caller limit is honoured — clamping only lowers.
      expect(result.policy.maxCallDurationSeconds).toBe(120);
      expect(result.policy.maxCostPerMission).toBe(1);
      expect(result.policy.maxAttempts).toBe(1);
    }
  });

  it('rejects an over-long task and strips control characters (#42-H2)', () => {
    const tooLong = validatePhoneMissionStart({
      to: '+436641234567',
      task: 'x'.repeat(2001),
      policy,
    }, transport);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.issues.map((item) => item.code)).toContain('task-too-long');
    }

    const controlLaced = validatePhoneMissionStart({
      to: '+436641234567',
      task: 'Reserve\u0000 a\u0007 table',
      policy,
    }, transport);
    expect(controlLaced.ok).toBe(true);
    if (controlLaced.ok) {
      expect(controlLaced.mission.task).toBe('Reserve a table');
    }
  });
});
