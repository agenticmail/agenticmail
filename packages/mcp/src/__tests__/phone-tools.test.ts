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

  it('checks realtime conversation start gates through the API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      plan: { ok: true, channel: 'phone', mode: 'duplex_audio', missing: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('realtime_conversation_plan', {
      channel: 'phone',
      policyProvided: true,
    }));

    expect(result.plan).toEqual({ ok: true, channel: 'phone', mode: 'duplex_audio', missing: [] });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/conversation/realtime/plan', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        channel: 'phone',
        policyProvided: true,
      }),
    }));
  });

  it('starts and sends conversation sessions through the API', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/conversation/sessions/start')) {
        return jsonResponse({ success: true, session: { id: 'conv_1' } });
      }
      return jsonResponse({ success: true, message: { id: 'cmsg_1' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const started = JSON.parse(await handleToolCall('conversation_start', {
      channel: 'telegram',
      chatId: '42',
      initialMessage: 'hi',
    }));
    const sent = JSON.parse(await handleToolCall('conversation_send', {
      sessionId: 'conv_1',
      text: 'next',
    }));

    expect(started.session.id).toBe('conv_1');
    expect(sent.message.id).toBe('cmsg_1');
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/conversation/sessions/start', expect.objectContaining({
      method: 'POST',
    }));
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/conversation/sessions/conv_1/messages', expect.objectContaining({
      method: 'POST',
    }));
  });
});
