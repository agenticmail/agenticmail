import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const missionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['AT', 'DE', 'EU'],
  maxCallDurationSeconds: 600,
  maxCostPerMission: 5,
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MCP phone tool dispatch', () => {
  let handleToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    vi.resetModules();
    process.env.AGENTICMAIL_API_URL = 'http://api.test';
    process.env.AGENTICMAIL_API_KEY = 'ak_test';
    ({ handleToolCall } = await import('../tools.js'));
  }, 15_000);

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts phone missions through the call-control API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, mission: { id: 'phn_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('call_phone', {
      to: '+43123456789',
      task: 'Reserve a table for two at 19:30.',
      policy: missionPolicy,
      dryRun: true,
    }));

    expect(result).toEqual({ success: true, mission: { id: 'phn_1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/calls/start', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer ak_test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: '+43123456789',
        task: 'Reserve a table for two at 19:30.',
        policy: missionPolicy,
        dryRun: true,
      }),
    }));
  });

  it('reads one phone mission by id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ mission: { id: 'phn_1', status: 'dialing' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('call_status', { id: 'phn_1' }));

    expect(result).toEqual({ mission: { id: 'phn_1', status: 'dialing' } });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/calls/phn_1', expect.objectContaining({
      method: 'GET',
    }));
  });
});
