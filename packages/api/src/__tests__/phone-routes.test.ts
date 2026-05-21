import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ConversationSessionManager,
  createTestDatabase,
  PhoneManager,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createPhoneRoutes, createPhoneWebhookRoutes } from '../routes/phone.js';

// Webhook secret must clear the 24-char entropy floor (#43-H8).
const WEBHOOK_SECRET = 'hook-secret-abcdefghijklmnop';

/** Recompute the per-mission webhook token (#43-H7) the manager emits. */
function tokenFor(missionId: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(missionId).digest('hex');
}

const policy = {
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

const config = { masterKey: 'mk_test_key' } as AgenticMailConfig;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  return { status: res.status, body: await res.json() };
}

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function createPhoneApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createPhoneWebhookRoutes(db, config));
  app.use(createPhoneRoutes(db, config));
  return app;
}

async function setupTransport(baseUrl: string) {
  return request(baseUrl, '/phone/transport/setup', {
    method: 'POST',
    body: JSON.stringify({
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: WEBHOOK_SECRET,
      supportedRegions: ['AT', 'DE'],
    }),
  });
}

describe('phone routes', () => {
  it('configures phone transport without leaking secrets', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));

    const setup = await setupTransport(baseUrl);
    expect(setup.status).toBe(200);
    expect(setup.body.transport).toMatchObject({
      provider: '46elks',
      phoneNumber: '+43123456789',
      password: '***',
      webhookSecret: '***',
    });

    const capabilities = await request(baseUrl, '/phone/capabilities');
    expect(capabilities.body).toMatchObject({
      provider: '46elks',
      capabilities: ['call_control'],
      supportedRegions: ['AT', 'DE'],
      realtimeReady: false,
    });

    db.close();
  });

  it('reports 46elks realtime readiness only when a bridge number is configured', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));

    const setup = await request(baseUrl, '/phone/transport/setup', {
      method: 'POST',
      body: JSON.stringify({
        provider: '46elks',
        phoneNumber: '+43123456789',
        username: 'user',
        password: 'api-password-secret',
        webhookBaseUrl: 'https://agenticmail.example.com',
        webhookSecret: WEBHOOK_SECRET,
        realtimeBridgeNumber: '+46700000000',
        capabilities: ['call_control', 'realtime_media'],
        supportedRegions: ['AT', 'DE'],
      }),
    });
    expect(setup.status).toBe(200);
    expect(setup.body.nextSteps).toContain('46elks outbound calls will connect to the configured realtimeBridgeNumber.');

    const capabilities = await request(baseUrl, '/phone/capabilities');
    expect(capabilities.body).toMatchObject({
      provider: '46elks',
      realtimeBridgeNumber: '+46700000000',
      realtimeBridgeConfigured: true,
      realtimeReady: true,
    });

    db.close();
  });

  it('rejects a transport setup with a weak webhook secret', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));

    const setup = await request(baseUrl, '/phone/transport/setup', {
      method: 'POST',
      body: JSON.stringify({
        provider: '46elks',
        phoneNumber: '+43123456789',
        username: 'user',
        password: 'api-password-secret',
        webhookBaseUrl: 'https://agenticmail.example.com',
        webhookSecret: 'short',
        supportedRegions: ['AT', 'DE'],
      }),
    });
    expect(setup.status).toBe(400);
    expect(String(setup.body.error)).toMatch(/at least 24 characters/);

    db.close();
  });

  it('starts a dry-run mission and exposes status/transcript/cancel endpoints', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);

    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({
        to: '+436641234567',
        task: 'Reserve dinner',
        policy,
        dryRun: true,
      }),
    });
    expect(started.status).toBe(200);
    expect(started.body.mission.status).toBe('dialing');
    expect(started.body.providerRequest.body.voice_start).toBe('[redacted-url]');

    const missionId = started.body.mission.id;
    expect(started.body.conversationSession).toMatchObject({
      channel: 'phone',
      status: 'active',
      peer: '+436641234567',
      externalRef: missionId,
      metadata: { missionId, provider: '46elks', dryRun: true },
    });
    expect(started.body.conversationMessage).toMatchObject({
      channel: 'phone',
      direction: 'system',
      metadata: { missionId, status: 'dialing' },
    });
    const conversations = new ConversationSessionManager(db);
    expect(conversations.listMessages('agent1', started.body.conversationSession.id).map((m) => [m.direction, m.text])).toEqual([
      ['system', `Phone mission ${missionId} started for +436641234567.`],
    ]);

    const loaded = await request(baseUrl, `/calls/${missionId}`);
    expect(loaded.body.mission.id).toBe(missionId);
    expect(loaded.body.conversationSession).toMatchObject({
      id: started.body.conversationSession.id,
      status: 'active',
      externalRef: missionId,
    });

    const transcript = await request(baseUrl, `/calls/${missionId}/transcript`);
    expect(transcript.body.transcript.length).toBeGreaterThan(0);

    const cancelled = await request(baseUrl, `/calls/${missionId}/cancel`, { method: 'POST' });
    expect(cancelled.body.mission.status).toBe('cancelled');
    expect(conversations.getSession('agent1', started.body.conversationSession.id)?.status).toBe('ended');
    expect(conversations.listMessages('agent1', started.body.conversationSession.id).map((m) => m.text)).toContain(
      `Phone mission ${missionId} cancelled by operator.`,
    );
    const loadedAfterCancel = await request(baseUrl, `/calls/${missionId}`);
    expect(loadedAfterCancel.body.conversationSession).toMatchObject({
      id: started.body.conversationSession.id,
      status: 'ended',
    });

    db.close();
  });

  it('starts a mission from a safe policy preset without raw policy JSON', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);

    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({
        to: '+436641234567',
        task: 'Reserve dinner for two at 19:30',
        policyPreset: 'reservation',
        maxCostPerMission: 1.5,
        maxTimeShiftMinutes: 45,
        dryRun: true,
      }),
    });

    expect(started.status).toBe(200);
    expect(started.body.mission.policy).toMatchObject({
      policyVersion: 1,
      maxCostPerMission: 1.5,
      maxAttempts: 2,
      transcriptEnabled: true,
      recordingEnabled: false,
      alternativePolicy: { maxTimeShiftMinutes: 45 },
      confirmPolicy: {
        paymentDetails: 'never',
        contractCommitment: 'never',
        costOverLimit: 'needs_operator',
        sensitivePersonalData: 'needs_operator',
        unclearAlternative: 'needs_operator',
      },
    });
    expect(started.body.conversationSession.metadata).toMatchObject({
      policyPreset: 'reservation',
      dryRun: true,
    });

    db.close();
  });

  it('authenticates 46elks voice-start and hangup webhooks', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;
    const conversationSessionId = started.body.conversationSession.id;
    const token = tokenFor(missionId);

    // Forged token -> uniform 403.
    const forged = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=${missionId}&token=wrong`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(forged.status).toBe(403);

    // An unknown mission must return the SAME 403 + body — no 404-vs-403
    // enumeration oracle (#43-H3).
    const unknown = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=call_does-not-exist&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toEqual(forged.body);

    const voiceStart = await request(baseUrl, `/calls/webhook/46elks/voice-start?missionId=${missionId}&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(voiceStart.status).toBe(200);
    expect(voiceStart.body.play).toContain('AgenticMail');

    const hangup = await request(baseUrl, `/calls/webhook/46elks/hangup?missionId=${missionId}&token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ callid: 'call123' }),
    });
    expect(hangup.body.mission.status).toBe('failed');
    const conversations = new ConversationSessionManager(db);
    expect(conversations.getSession('agent1', conversationSessionId)?.status).toBe('failed');
    expect(conversations.listMessages('agent1', conversationSessionId).map((m) => m.text)).toContain(
      `Phone mission ${missionId} ended by 46elks hangup.`,
    );

    db.close();
  });

  it('lists and answers operator queries (ask_operator endpoints)', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;

    // The bridge records the query at runtime; seed one against the same DB.
    const manager = new PhoneManager(db as any, config.masterKey);
    const { query } = manager.addOperatorQuery(missionId, { question: 'Is 8pm acceptable?' });

    const list = await request(baseUrl, `/calls/${missionId}/operator-queries`);
    expect(list.status).toBe(200);
    expect(list.body.operatorQueries).toHaveLength(1);
    expect(list.body.operatorQueries[0].question).toBe('Is 8pm acceptable?');
    expect(list.body.callbackPending).toBe(false);

    const answer = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, 8pm is fine' }),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.alreadyAnswered).toBe(false);
    expect(answer.body.query.answer).toBe('Yes, 8pm is fine');
    expect(answer.body.callback.triggered).toBe(false); // not callback-pending

    // The list now reflects the answer.
    const list2 = await request(baseUrl, `/calls/${missionId}/operator-queries`);
    expect(list2.body.operatorQueries[0].answer).toBe('Yes, 8pm is fine');

    // An empty answer is rejected.
    const empty = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: '' }),
    });
    expect(empty.status).toBe(400);

    // An unknown query id returns 404.
    const missing = await request(baseUrl, `/calls/${missionId}/operator-queries/oq_nope/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'whatever' }),
    });
    expect(missing.status).toBe(404);

    db.close();
  });

  it('answering a callback-pending query triggers a callback dial (plan §7)', async () => {
    const db = createDb();
    const baseUrl = await listen(createPhoneApp(db));
    await setupTransport(baseUrl);
    const started = await request(baseUrl, '/calls/start', {
      method: 'POST',
      body: JSON.stringify({ to: '+436641234567', task: 'Reserve dinner', policy, dryRun: true }),
    });
    const missionId = started.body.mission.id;

    const manager = new PhoneManager(db as any, config.masterKey);
    const { query } = manager.addOperatorQuery(missionId, { question: 'Confirm the booking?' });
    manager.flagCallbackPending(missionId); // the call dropped while unanswered

    // The callback dials 46elks; the test client itself uses fetch, so the
    // stub routes 46elks calls to a fake and passes everything else through.
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: any, init: any) => (
      String(url).includes('46elks.com')
        ? new Response(JSON.stringify({ id: 'callback-call' }), { status: 200 })
        : realFetch(url, init)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const answer = await request(baseUrl, `/calls/${missionId}/operator-queries/${query.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, go ahead and confirm it' }),
    });
    vi.unstubAllGlobals();

    expect(answer.status).toBe(200);
    expect(answer.body.callback.triggered).toBe(true);
    expect(answer.body.callback.missionId).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('46elks.com'))).toBe(true);

    db.close();
  });
});
