import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestDatabase } from '../storage/db.js';
import {
  PhoneManager,
  PhoneRateLimitError,
  PhoneWebhookAuthError,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
  type OpenClawPhoneMissionPolicy,
} from '../index.js';

// Webhook secret must clear the 24-char entropy floor (#43-H8).
const WEBHOOK_SECRET = 'hook-secret-abcdefghijklmnop';

/** Recompute the per-mission webhook token the way the manager does. */
function tokenFor(missionId: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(missionId).digest('hex');
}

const policy: OpenClawPhoneMissionPolicy = {
  policyVersion: 1,
  regionAllowlist: ['AT', 'DE'],
  maxCallDurationSeconds: 300,
  maxCostPerMission: 5,
  maxAttempts: 1,
  transcriptEnabled: true,
  recordingEnabled: false,
  confirmPolicy: {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  },
  alternativePolicy: { maxTimeShiftMinutes: 30 },
};

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function phoneConfig() {
  return buildPhoneTransportConfig({
    provider: '46elks',
    phoneNumber: '+43123456789',
    username: 'user',
    password: 'api-password-secret',
    webhookBaseUrl: 'https://agenticmail.example.com',
    webhookSecret: WEBHOOK_SECRET,
    supportedRegions: ['AT', 'DE'],
  });
}

describe('PhoneManager', () => {
  const dbs: ReturnType<typeof createTestDatabase>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    vi.unstubAllGlobals();
  });

  it('stores phone transport config and redacts secrets for output', () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db, 'mk_test_key');

    const cfg = phoneConfig();
    manager.savePhoneTransportConfig('agent1', cfg);

    const loaded = manager.getPhoneTransportConfig('agent1');
    expect(loaded).toMatchObject({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(redactPhoneTransportConfig(loaded!).password).toBe('***');
    const raw = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('agent1') as { metadata: string };
    expect(raw.metadata).not.toContain(WEBHOOK_SECRET);
    expect(raw.metadata).not.toContain('api-password-secret');
  });

  it('rejects a webhook secret below the entropy floor (#43-H8)', () => {
    expect(() => buildPhoneTransportConfig({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: 'short',
      supportedRegions: ['AT', 'DE'],
    })).toThrow(/at least 24 characters/);
  });

  it('starts a dry-run mission without calling the provider', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const result = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { dryRun: true, now: new Date('2026-05-18T20:00:00.000Z') });

    expect(result.mission.status).toBe('dialing');
    expect(result.mission.providerCallId).toBe('dryrun-call');
    expect(result.mission.metadata.attempts).toBe(1);
    expect(result.providerRequest?.url).toBe('https://api.46elks.com/a1/calls');
    expect(result.providerRequest?.body).toMatchObject({
      from: '+43123456789',
      to: '+436641234567',
      timeout: '300',
    });
    // The webhook URL must carry a per-mission token, never the raw secret.
    expect(String(result.mission.metadata.providerRequest)).not.toContain(WEBHOOK_SECRET);
  });

  it('posts a 46elks call-control request with form encoding', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: 'call123',
      status: 'created',
    }), { status: 200 }));

    const result = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.mission.providerCallId).toBe('call123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.46elks.com/a1/calls');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('user:api-password-secret').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(String(init.body));
    expect(body.get('from')).toBe('+43123456789');
    expect(body.get('to')).toBe('+436641234567');
    expect(body.get('voice_start')).toContain('/api/agenticmail/calls/webhook/46elks/voice-start');
    expect(body.get('whenhangup')).toContain('/api/agenticmail/calls/webhook/46elks/hangup');
    // The webhook URLs carry the per-mission HMAC token, not the secret.
    expect(body.get('voice_start')).toContain(`token=${tokenFor(result.mission.id)}`);
    expect(body.get('voice_start')).not.toContain(WEBHOOK_SECRET);
  });

  it('marks the mission failed when the provider request throws (fail-closed #43-H4)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const fetchMock = vi.fn(async () => { throw new Error('network down'); });

    await expect(manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { fetchFn: fetchMock as unknown as typeof fetch })).rejects.toThrow(/network down/);

    const missions = manager.listMissions('agent1');
    expect(missions).toHaveLength(1);
    expect(missions[0].status).toBe('failed');
    expect(missions[0].metadata.providerError).toBe('network down');
  });

  it('rejects forged webhooks and records valid voice-start/hangup events', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());
    const { mission } = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { dryRun: true });
    const token = tokenFor(mission.id);

    // Wrong token, raw secret, and unknown mission all fail uniformly (#43-H3).
    expect(() => manager.handleVoiceStartWebhook(mission.id, 'wrong')).toThrow(PhoneWebhookAuthError);
    expect(() => manager.handleVoiceStartWebhook(mission.id, WEBHOOK_SECRET)).toThrow(PhoneWebhookAuthError);
    expect(() => manager.handleVoiceStartWebhook('call_does-not-exist', token)).toThrow(PhoneWebhookAuthError);

    const voiceStart = manager.handleVoiceStartWebhook(mission.id, token, { callid: 'call123' });
    expect(voiceStart.mission.status).toBe('connected');
    expect(voiceStart.action.play).toContain('AgenticMail');
    const voiceStartTranscriptLength = voiceStart.mission.transcript.length;

    const duplicateVoiceStart = manager.handleVoiceStartWebhook(mission.id, token, { callid: 'call123' });
    expect(duplicateVoiceStart.mission.transcript).toHaveLength(voiceStartTranscriptLength);

    const hangup = manager.handleHangupWebhook(mission.id, token, { callid: 'call123' });
    expect(hangup.status).toBe('failed');
    expect(hangup.metadata.hangupReason).toBe('call-ended-before-conversation-runtime');
    expect(hangup.metadata.phoneWebhookEvents).toHaveLength(2);
    const hangupTranscriptLength = hangup.transcript.length;

    const duplicateHangup = manager.handleHangupWebhook(mission.id, token, { callid: 'call123' });
    expect(duplicateHangup.transcript).toHaveLength(hangupTranscriptLength);
    expect(duplicateHangup.metadata.phoneWebhookEvents).toHaveLength(2);
  });

  it('does not resurrect a terminal mission from a late voice-start (#43-H5)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());
    const { mission } = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table',
      policy,
    }, { dryRun: true });
    const token = tokenFor(mission.id);

    const cancelled = manager.cancelMission('agent1', mission.id);
    expect(cancelled.status).toBe('cancelled');

    // A voice-start arriving after cancellation must not flip it back to connected.
    const lateVoiceStart = manager.handleVoiceStartWebhook(mission.id, token, { callid: 'late' });
    expect(lateVoiceStart.mission.status).toBe('cancelled');
  });

  it('enforces the concurrency cap on active missions (#43-H1)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'c', status: 'created' }), { status: 200 }));
    // 3 active missions allowed; the 4th is refused.
    for (let i = 0; i < 3; i++) {
      await manager.startMission('agent1', { to: '+436641234567', task: 'call', policy },
        { fetchFn: fetchMock as unknown as typeof fetch });
    }
    await expect(manager.startMission('agent1', { to: '+436641234567', task: 'call', policy },
      { fetchFn: fetchMock as unknown as typeof fetch })).rejects.toThrow(PhoneRateLimitError);
  });

  it('enforces the per-minute call rate limit (#43-H1)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'c', status: 'created' }), { status: 200 }));
    // 5 calls/minute allowed. Cancel each so the concurrency cap (3)
    // doesn't trip first — the rate-limit timestamps still accrue.
    for (let i = 0; i < 5; i++) {
      const { mission } = await manager.startMission('agent1', { to: '+436641234567', task: 'call', policy },
        { fetchFn: fetchMock as unknown as typeof fetch });
      manager.cancelMission('agent1', mission.id);
    }
    await expect(manager.startMission('agent1', { to: '+436641234567', task: 'call', policy },
      { fetchFn: fetchMock as unknown as typeof fetch })).rejects.toThrow(/rate limit/i);
  });

  it('dry runs are exempt from the rate + concurrency limits', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', phoneConfig());

    // Far more dry runs than any limit — none should be refused.
    for (let i = 0; i < 12; i++) {
      const result = await manager.startMission('agent1', { to: '+436641234567', task: 'call', policy },
        { dryRun: true });
      expect(result.mission.status).toBe('dialing');
    }
  });

  it('routes 46elks realtime outbound missions to the configured websocket bridge number', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    manager.savePhoneTransportConfig('agent1', buildPhoneTransportConfig({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
      realtimeBridgeNumber: '+46700000000',
      capabilities: ['call_control', 'realtime_media'],
      supportedRegions: ['AT', 'DE'],
    }));

    const result = await manager.startMission('agent1', {
      to: '+436641234567',
      task: 'Reserve a table for two',
      policy,
    }, { dryRun: true });

    expect(result.providerRequest.body.voice_start).toBe(JSON.stringify({ connect: '+46700000000' }));
    expect(result.providerRequest.body.whenhangup).toContain('/calls/webhook/46elks/hangup');
  });

  // ─── Operator queries (ask_operator, v0.9.53) ─────────

  async function startDryRunMission(manager: PhoneManager) {
    manager.savePhoneTransportConfig('agent1', phoneConfig());
    const { mission } = await manager.startMission('agent1', {
      to: '+436641234567', task: 'Reserve a table for two', policy,
    }, { dryRun: true });
    return mission;
  }

  it('records an operator query and answers it idempotently', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRunMission(manager);

    const { query } = manager.addOperatorQuery(mission.id, {
      question: 'Is 8pm acceptable?', callContext: 'dinner booking', urgency: 'high',
    });
    expect(query.id).toMatch(/^oq_/);
    expect(query.urgency).toBe('high');
    expect(manager.getOperatorQuery(mission.id, query.id)?.answer).toBeUndefined();
    expect(manager.listOperatorQueries(mission.id)).toHaveLength(1);

    const answered = manager.answerOperatorQuery(mission.id, query.id, 'Yes, 8pm works');
    expect(answered?.alreadyAnswered).toBe(false);
    expect(answered?.query.answer).toBe('Yes, 8pm works');
    expect(answered?.query.answeredVia).toBe('api');

    // The first answer wins — a later answer does not overwrite it.
    const again = manager.answerOperatorQuery(mission.id, query.id, 'actually, no');
    expect(again?.alreadyAnswered).toBe(true);
    expect(again?.query.answer).toBe('Yes, 8pm works');
  });

  it('rejects an empty question and strips control characters from query text', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRunMission(manager);

    expect(() => manager.addOperatorQuery(mission.id, { question: '   ' }))
      .toThrow(/question is required/);

    const { query } = manager.addOperatorQuery(mission.id, { question: 'safe\u0007bell\u0000nul' });
    expect(query.question).toBe('safebellnul');
  });

  it('resolves a mission by operator-query id', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRunMission(manager);
    const { query } = manager.addOperatorQuery(mission.id, { question: 'Confirm the time?' });

    const found = manager.findMissionByOperatorQueryId(query.id);
    expect(found?.mission.id).toBe(mission.id);
    expect(found?.query.question).toBe('Confirm the time?');
    expect(manager.findMissionByOperatorQueryId('oq_does-not-exist')).toBeNull();
  });

  it('flags callback-pending and triggers a callback once the operator answers (plan §7)', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRunMission(manager);
    const { query } = manager.addOperatorQuery(mission.id, { question: 'Is 8pm acceptable?' });

    // The call dropped while the query was unanswered.
    const flagged = manager.flagCallbackPending(mission.id);
    expect(flagged?.metadata.callbackPending).toBe(true);
    expect(manager.findCallbackPendingMissions('agent1').map((m) => m.id)).toContain(mission.id);

    // No answer yet — there is nothing to call back about.
    expect(await manager.triggerCallback(mission.id)).toBeNull();

    // The operator answers — the callback now fires, re-dialing the number.
    manager.answerOperatorQuery(mission.id, query.id, 'Yes, confirmed for 8pm', { via: 'email' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'callback-call' }), { status: 200 }));
    const result = await manager.triggerCallback(mission.id, { fetchFn: fetchMock as unknown as typeof fetch });

    expect(result).not.toBeNull();
    expect(result!.callbackMission.id).not.toBe(mission.id);
    expect(result!.callbackMission.to).toBe(mission.to);
    // The continuation task carries the answer + the disconnect framing.
    expect(result!.callbackMission.task).toContain('Yes, confirmed for 8pm');
    expect(result!.callbackMission.task).toContain('cut off');

    // The flag is cleared and the callback mission is linked.
    const original = manager.getMission(mission.id)!;
    expect(original.metadata.callbackPending).toBe(false);
    expect(original.metadata.callbackMissionId).toBe(result!.callbackMission.id);

    // A second trigger is a no-op — the callback only fires once.
    expect(await manager.triggerCallback(mission.id, { fetchFn: fetchMock as unknown as typeof fetch }))
      .toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not flag callback-pending when every operator query is already answered', async () => {
    const db = createDb();
    dbs.push(db);
    const manager = new PhoneManager(db);
    const mission = await startDryRunMission(manager);
    const { query } = manager.addOperatorQuery(mission.id, { question: 'Confirm?' });
    manager.answerOperatorQuery(mission.id, query.id, 'Confirmed');

    const flagged = manager.flagCallbackPending(mission.id);
    expect(flagged?.metadata.callbackPending).toBeUndefined();
  });
});
