import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ConversationSessionManager,
  createTestDatabase,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createConversationSessionRoutes } from '../routes/conversation-sessions.js';
import { createTelegramWebhookRoutes } from '../routes/telegram.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmno';
const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const config = { masterKey: 'mk_test_key', openaiApiKey: 'sk_test' } as AgenticMailConfig;
const servers: Server[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function okTelegram(messageId = 1000): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
}

function telegramFetchMock(): ReturnType<typeof vi.fn> {
  let nextId = 1000;
  return vi.fn(async (url: any, init: any) => {
    if (!String(url).includes('api.telegram.org')) return realFetch(url, init);
    return okTelegram(nextId++);
  });
}

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', JSON.stringify({
    telegram: {
      enabled: true,
      botToken: TOKEN,
      operatorChatId: '42',
      allowedChatIds: ['42'],
      mode: 'webhook',
      webhookSecret: WEBHOOK_SECRET,
      configuredAt: new Date().toISOString(),
    },
  }));
  return db;
}

function createApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createTelegramWebhookRoutes(db, config));
  app.use((req, _res, next) => {
    (req as any).agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createConversationSessionRoutes(db, config));
  return app;
}

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
}

describe('conversation session routes', () => {
  it('starts a Telegram live session, sends turns, and records inbound webhook messages', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', telegramFetchMock());
    const baseUrl = await listen(createApp(db));

    const started = await request(baseUrl, '/conversation/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'telegram',
        chatId: '42',
        goal: 'Coordinate dinner reservation',
        initialMessage: 'I am checking the reservation.',
        tenantId: 'tenant_at',
        hostIntegration: 'openclaw',
        hostSessionId: 'oc_session_1',
        behaviorMode: 'operator_directed',
        policyScope: { preset: 'reservation' },
        budgetScope: { maxCostPerMission: 1.5 },
      }),
    });
    expect(started.status).toBe(200);
    expect(started.body.session).toMatchObject({
      channel: 'telegram',
      status: 'active',
      peer: '42',
      metadata: {
        transport: 'telegram',
        liveContext: {
          tenantId: 'tenant_at',
          hostIntegration: 'openclaw',
          hostSessionId: 'oc_session_1',
          behaviorMode: 'operator_directed',
          policyScope: { preset: 'reservation' },
          budgetScope: { maxCostPerMission: 1.5 },
        },
      },
    });

    const sessionId = started.body.session.id;
    const sent = await request(baseUrl, `/conversation/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Second turn.' }),
    });
    expect(sent.status).toBe(200);
    expect(sent.body.message.text).toBe('Second turn.');

    const inbound = await request(baseUrl, '/telegram/webhook', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: JSON.stringify({
        update_id: 20,
        message: {
          message_id: 77,
          chat: { id: 42, type: 'private' },
          from: { id: 42, first_name: 'Benedikt' },
          text: 'Works for me.',
          date: 1_700_000_000,
        },
      }),
    });
    expect(inbound.status).toBe(200);

    const messages = await request(baseUrl, `/conversation/sessions/${sessionId}/messages`);
    expect(messages.body.messages.map((m: any) => [m.direction, m.text])).toEqual([
      ['outbound', 'I am checking the reservation.'],
      ['outbound', 'Second turn.'],
      ['inbound', 'Works for me.'],
    ]);

    const context = await request(baseUrl, `/conversation/sessions/${sessionId}/context?messageLimit=2`);
    expect(context.status).toBe(200);
    expect(context.body.session.id).toBe(sessionId);
    expect(context.body.totalMessages).toBe(3);
    expect(context.body.messages.map((m: any) => [m.direction, m.text])).toEqual([
      ['outbound', 'Second turn.'],
      ['inbound', 'Works for me.'],
    ]);

    db.close();
  });

  it('rejects planned channels through the live-session start endpoint', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));

    const result = await request(baseUrl, '/conversation/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ channel: 'google_meet', peer: 'meet.example', operatorApproved: true }),
    });

    expect(result.status).toBe(400);
    expect(result.body.plan.missing).toContain('Google Meet adapter implementation');

    db.close();
  });

  it('records channel-neutral transcript turns without requiring transport send config', async () => {
    const db = createDb();
    const manager = new ConversationSessionManager(db);
    const matrix = manager.createSession({
      agentId: 'agent1',
      channel: 'matrix',
      peer: '!room:example.org',
      goal: 'Coordinate a realtime text thread',
    });
    const meet = manager.createSession({
      agentId: 'agent1',
      channel: 'google_meet',
      peer: 'meet.example/abc-defg-hij',
      subject: 'Planning call',
    });
    const baseUrl = await listen(createApp(db));

    const matrixTurn = await request(baseUrl, `/conversation/sessions/${matrix.id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({
        direction: 'inbound',
        text: 'Matrix event arrived.',
        externalMessageId: '$event1',
        metadata: { sender: '@benedikt:example.org' },
      }),
    });
    expect(matrixTurn.status).toBe(200);
    expect(matrixTurn.body.message).toMatchObject({
      sessionId: matrix.id,
      channel: 'matrix',
      direction: 'inbound',
      text: 'Matrix event arrived.',
      externalMessageId: '$event1',
      metadata: { sender: '@benedikt:example.org' },
    });

    const meetTurn = await request(baseUrl, `/conversation/sessions/${meet.id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ direction: 'system', text: 'Meet bot joined the waiting room.' }),
    });
    expect(meetTurn.status).toBe(200);
    expect(meetTurn.body.message).toMatchObject({
      sessionId: meet.id,
      channel: 'google_meet',
      direction: 'system',
    });

    const matrixMessages = await request(baseUrl, `/conversation/sessions/${matrix.id}/messages`);
    expect(matrixMessages.body.messages.map((m: any) => [m.direction, m.text])).toEqual([
      ['inbound', 'Matrix event arrived.'],
    ]);

    const sendAttempt = await request(baseUrl, `/conversation/sessions/${matrix.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Try to send through Matrix.' }),
    });
    expect(sendAttempt.status).toBe(400);
    expect(sendAttempt.body.error).toMatch(/Matrix not configured or disabled/);

    const empty = await request(baseUrl, `/conversation/sessions/${matrix.id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ direction: 'inbound', text: '   ' }),
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('text is required');

    manager.endSession('agent1', matrix.id);
    const inactive = await request(baseUrl, `/conversation/sessions/${matrix.id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ direction: 'inbound', text: 'Too late.' }),
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error).toMatch(/not active/);

    db.close();
  });

  it('lists and ends sessions', async () => {
    const db = createDb();
    const manager = new ConversationSessionManager(db);
    const session = manager.createSession({
      agentId: 'agent1',
      channel: 'telegram',
      peer: '42',
    });
    const baseUrl = await listen(createApp(db));

    const listed = await request(baseUrl, '/conversation/sessions?status=active');
    expect(listed.body.sessions.map((row: any) => row.id)).toContain(session.id);

    const ended = await request(baseUrl, `/conversation/sessions/${session.id}/end`, { method: 'POST' });
    expect(ended.body.session.status).toBe('ended');

    db.close();
  });
});
