import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  createTestDatabase,
  TelegramManager,
  PhoneManager,
  buildPhoneTransportConfig,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createTelegramRoutes, createTelegramWebhookRoutes } from '../routes/telegram.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmno';
const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const config = { masterKey: 'mk_test_key' } as AgenticMailConfig;
const servers: Server[] = [];

const policy = {
  policyVersion: 1,
  regionAllowlist: ['AT'],
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

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// The test's own request() helper uses fetch to reach the express
// server, so every fetch mock must pass NON-Telegram URLs through to
// the real fetch — otherwise the mock swallows the test client's call.
const realFetch = globalThis.fetch;

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function isTelegramUrl(url: unknown): boolean {
  return String(url).includes('api.telegram.org');
}

/** A fetch mock that answers Telegram Bot API calls by method name. */
function telegramFetchMock(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const defaults: Record<string, unknown> = {
    getMe: { id: 7, is_bot: true, username: 'am_bot' },
    setWebhook: true,
    deleteWebhook: true,
    sendMessage: { message_id: 999 },
    getUpdates: [],
  };
  const table = { ...defaults, ...overrides };
  return vi.fn(async (url: any, init: any) => {
    if (!isTelegramUrl(url)) return realFetch(url, init);
    const method = String(url).split('/').pop() || '';
    if (method in table) return okResponse(table[method]);
    return okResponse(true);
  });
}

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${addr.port}`;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
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

function createTelegramApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createTelegramWebhookRoutes(db, config)); // before auth — secret-header authed
  app.use((req, _res, next) => {
    (req as any).agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createTelegramRoutes(db, config));
  return app;
}

describe('telegram setup routes', () => {
  it('configures the channel and never leaks the bot token', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', telegramFetchMock());
    const baseUrl = await listen(createTelegramApp(db));

    const setup = await request(baseUrl, '/telegram/setup', {
      method: 'POST',
      body: JSON.stringify({ botToken: TOKEN, mode: 'poll', allowedChatIds: ['42', 99] }),
    });
    expect(setup.status).toBe(200);
    expect(setup.body.telegram.botToken).toBe('***');
    expect(setup.body.bot).toEqual({ id: 7, username: 'am_bot' });

    const cfg = await request(baseUrl, '/telegram/config');
    expect(cfg.body.configured).toBe(true);
    expect(cfg.body.telegram.botToken).toBe('***');
    expect(JSON.stringify(cfg.body)).not.toContain(TOKEN);
    expect(cfg.body.telegram.allowedChatIds).toEqual(['42', '99']);

    db.close();
  });

  it('rejects an invalid bot token', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => (
      isTelegramUrl(url)
        ? new Response(JSON.stringify({ ok: false, description: 'Unauthorized', error_code: 401 }), { status: 401 })
        : realFetch(url, init)
    )));
    const baseUrl = await listen(createTelegramApp(db));

    const setup = await request(baseUrl, '/telegram/setup', {
      method: 'POST',
      body: JSON.stringify({ botToken: 'bad-token', mode: 'poll' }),
    });
    expect(setup.status).toBe(400);
    expect(String(setup.body.error)).toMatch(/verify the bot token/i);

    db.close();
  });

  it('rejects a webhook setup with a non-https URL or a weak secret', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', telegramFetchMock());
    const baseUrl = await listen(createTelegramApp(db));

    const httpUrl = await request(baseUrl, '/telegram/setup', {
      method: 'POST',
      body: JSON.stringify({ botToken: TOKEN, mode: 'webhook', webhookUrl: 'http://x.example.com/wh', webhookSecret: WEBHOOK_SECRET }),
    });
    expect(httpUrl.status).toBe(400);
    expect(String(httpUrl.body.error)).toMatch(/https/);

    const weak = await request(baseUrl, '/telegram/setup', {
      method: 'POST',
      body: JSON.stringify({ botToken: TOKEN, mode: 'webhook', webhookUrl: 'https://x.example.com/wh', webhookSecret: 'short' }),
    });
    expect(weak.status).toBe(400);
    expect(String(weak.body.error)).toMatch(/at least 16/);

    db.close();
  });
});

describe('telegram send route', () => {
  it('sends a message and records it as outbound', async () => {
    const db = createDb();
    new TelegramManager(db as any, config.masterKey).saveConfig('agent1', {
      enabled: true, botToken: TOKEN, allowedChatIds: ['42'], mode: 'poll', configuredAt: new Date().toISOString(),
    });
    const fetchMock = telegramFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const baseUrl = await listen(createTelegramApp(db));

    const sent = await request(baseUrl, '/telegram/send', {
      method: 'POST',
      body: JSON.stringify({ chatId: '42', text: '**hi there**' }),
    });
    expect(sent.status).toBe(200);
    expect(sent.body.success).toBe(true);
    expect(sent.body.message.direction).toBe('outbound');

    // Markdown stripped before delivery.
    const sendCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sendMessage'));
    expect(JSON.parse((sendCall![1] as RequestInit).body as string).text).toBe('hi there');

    const messages = await request(baseUrl, '/telegram/messages?direction=outbound');
    expect(messages.body.count).toBe(1);

    db.close();
  });
});

describe('telegram webhook route', () => {
  it('rejects a missing or wrong secret token with a uniform 403', async () => {
    const db = createDb();
    new TelegramManager(db as any, config.masterKey).saveConfig('agent1', {
      enabled: true, botToken: TOKEN, allowedChatIds: ['42'], webhookSecret: WEBHOOK_SECRET,
      mode: 'webhook', configuredAt: new Date().toISOString(),
    });
    const baseUrl = await listen(createTelegramApp(db));

    const noSecret = await request(baseUrl, '/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 }, text: 'hi' } }),
    });
    expect(noSecret.status).toBe(403);

    const wrongSecret = await request(baseUrl, '/telegram/webhook', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'nope' },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 }, text: 'hi' } }),
    });
    expect(wrongSecret.status).toBe(403);
    expect(wrongSecret.body).toEqual(noSecret.body);

    db.close();
  });

  it('records an allow-listed inbound message and drops unknown chats', async () => {
    const db = createDb();
    const manager = new TelegramManager(db as any, config.masterKey);
    manager.saveConfig('agent1', {
      enabled: true, botToken: TOKEN, allowedChatIds: ['42'], webhookSecret: WEBHOOK_SECRET,
      mode: 'webhook', configuredAt: new Date().toISOString(),
    });
    const baseUrl = await listen(createTelegramApp(db));
    const hdr = { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET };

    const allowed = await request(baseUrl, '/telegram/webhook', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ update_id: 10, message: { message_id: 5, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 }, text: 'hello agent' } }),
    });
    expect(allowed.status).toBe(200);

    const unknown = await request(baseUrl, '/telegram/webhook', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ update_id: 11, message: { message_id: 6, date: 1, chat: { id: 777, type: 'private' }, from: { id: 8 }, text: 'spam' } }),
    });
    expect(unknown.body.ignored).toBe(true);

    // Duplicate delivery of the same message id is a no-op.
    await request(baseUrl, '/telegram/webhook', {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ update_id: 10, message: { message_id: 5, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 }, text: 'hello agent' } }),
    });

    expect(manager.listMessages('agent1', { direction: 'inbound' })).toHaveLength(1);
    db.close();
  });

  it('answers an open ask_operator query from the operator chat (plan §13.4)', async () => {
    const db = createDb();
    const telegram = new TelegramManager(db as any, config.masterKey);
    telegram.saveConfig('agent1', {
      enabled: true, botToken: TOKEN, allowedChatIds: [], operatorChatId: '99',
      webhookSecret: WEBHOOK_SECRET, mode: 'webhook', configuredAt: new Date().toISOString(),
    });

    // Seed a phone mission + an open operator query through PhoneManager —
    // the SAME records the operator-query endpoints and email hook use.
    const phone = new PhoneManager(db as any, config.masterKey);
    phone.savePhoneTransportConfig('agent1', buildPhoneTransportConfig({
      provider: '46elks', phoneNumber: '+43123456789', username: 'u', password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com', webhookSecret: 'hook-secret-abcdefghijklmnop',
      supportedRegions: ['AT'],
    }));
    const started = await phone.startMission('agent1', { to: '+436641234567', task: 'Reserve dinner', policy }, { dryRun: true });
    const { query } = phone.addOperatorQuery(started.mission.id, { question: 'Is 8pm acceptable?' });

    vi.stubGlobal('fetch', telegramFetchMock());
    const baseUrl = await listen(createTelegramApp(db));

    const answered = await request(baseUrl, '/telegram/webhook', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: JSON.stringify({
        update_id: 20,
        message: {
          message_id: 8, date: 1, chat: { id: 99, type: 'private' }, from: { id: 99 },
          text: `/answer ${query.id} Yes, 8pm works`,
        },
      }),
    });
    expect(answered.status).toBe(200);
    expect(answered.body.answered).toBe(true);

    expect(phone.getOperatorQuery(started.mission.id, query.id)?.answer).toBe('Yes, 8pm works');
    db.close();
  });
});

describe('telegram poll route', () => {
  it('pulls updates, records allow-listed messages and advances the offset', async () => {
    const db = createDb();
    const manager = new TelegramManager(db as any, config.masterKey);
    manager.saveConfig('agent1', {
      enabled: true, botToken: TOKEN, allowedChatIds: ['42'], mode: 'poll',
      pollOffset: 0, configuredAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', telegramFetchMock({
      getUpdates: [
        { update_id: 50, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 }, text: 'first' } },
        { update_id: 51, message: { message_id: 2, date: 1, chat: { id: 777, type: 'private' }, from: { id: 8 }, text: 'ignored' } },
      ],
    }));
    const baseUrl = await listen(createTelegramApp(db));

    const poll = await request(baseUrl, '/telegram/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    expect(poll.body.fetched).toBe(2);
    expect(poll.body.recorded).toBe(1); // chat 777 not allow-listed
    expect(poll.body.offset).toBe(52);

    expect(manager.getConfig('agent1')!.pollOffset).toBe(52);
    expect(manager.listMessages('agent1', { direction: 'inbound' })).toHaveLength(1);

    db.close();
  });
});
