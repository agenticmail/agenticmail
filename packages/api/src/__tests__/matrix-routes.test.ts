import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ConversationSessionManager,
  createTestDatabase,
  MatrixManager,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createMatrixRoutes } from '../routes/matrix.js';
import { createConversationSessionRoutes } from '../routes/conversation-sessions.js';

const config = { masterKey: 'mk_test_key' } as AgenticMailConfig;
const servers: Server[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

function createApp(db: ReturnType<typeof createTestDatabase>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createMatrixRoutes(db, config));
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

function matrixFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: any, init: any) => {
    const href = String(url);
    if (!href.startsWith('https://matrix.example.org')) return realFetch(url, init);
    if (href.endsWith('/_matrix/client/v3/account/whoami')) {
      return new Response(JSON.stringify({ user_id: '@agent:example.org', device_id: 'DEVICE' }), { status: 200 });
    }
    if (href.includes('/send/m.room.message/')) {
      return new Response(JSON.stringify({ event_id: '$sent1' }), { status: 200 });
    }
    if (href.includes('/_matrix/client/v3/sync')) {
      return new Response(JSON.stringify({
        next_batch: 's2',
        rooms: {
          join: {
            '!room:example.org': {
              timeline: {
                events: [{
                  type: 'm.room.message',
                  event_id: '$in1',
                  sender: '@benedikt:example.org',
                  origin_server_ts: 1_700_000_000_000,
                  content: { msgtype: 'm.text', body: 'Inbound Matrix turn.' },
                }],
              },
            },
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected Matrix URL' }), { status: 404 });
  });
}

describe('matrix routes', () => {
  it('sets up Matrix, starts a session, sends, polls, and mirrors transcript turns', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', matrixFetchMock());
    const baseUrl = await listen(createApp(db));

    const setup = await request(baseUrl, '/matrix/setup', {
      method: 'POST',
      body: JSON.stringify({
        homeserverUrl: 'https://matrix.example.org',
        accessToken: 'mx-token-secret',
        allowedRoomIds: ['!room:example.org'],
      }),
    });
    expect(setup.status).toBe(200);
    expect(setup.body.matrix).toMatchObject({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: '***',
      userId: '@agent:example.org',
      allowedRoomIds: ['!room:example.org'],
    });

    const started = await request(baseUrl, '/conversation/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'matrix',
        roomId: '!room:example.org',
        goal: 'Coordinate over Matrix',
        initialMessage: 'Hello Matrix.',
      }),
    });
    expect(started.status).toBe(200);
    expect(started.body.session).toMatchObject({
      channel: 'matrix',
      peer: '!room:example.org',
      status: 'active',
    });
    expect(started.body.message).toMatchObject({
      channel: 'matrix',
      direction: 'outbound',
      text: 'Hello Matrix.',
      externalMessageId: '$sent1',
    });

    const poll = await request(baseUrl, '/matrix/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ recorded: 1, mirrored: 1, nextBatch: 's2' });

    const context = await request(baseUrl, `/conversation/sessions/${started.body.session.id}/context`);
    expect(context.body.messages.map((m: any) => [m.direction, m.text])).toEqual([
      ['outbound', 'Hello Matrix.'],
      ['inbound', 'Inbound Matrix turn.'],
    ]);

    const manager = new MatrixManager(db, config.masterKey);
    expect(manager.getConfig('agent1')?.syncToken).toBe('s2');
    db.close();
  });

  it('keeps unlinked Matrix rooms fail-closed', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', matrixFetchMock());
    const baseUrl = await listen(createApp(db));
    await request(baseUrl, '/matrix/setup', {
      method: 'POST',
      body: JSON.stringify({
        homeserverUrl: 'https://matrix.example.org',
        accessToken: 'mx-token-secret',
        allowedRoomIds: ['!room:example.org'],
      }),
    });

    const started = await request(baseUrl, '/conversation/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ channel: 'matrix', roomId: '!other:example.org' }),
    });
    expect(started.status).toBe(400);
    expect(started.body.plan.missing).toContain('user opt-in');

    const send = await request(baseUrl, '/matrix/send', {
      method: 'POST',
      body: JSON.stringify({ roomId: '!other:example.org', text: 'nope' }),
    });
    expect(send.status).toBe(403);

    db.close();
  });

  it('records transcript ingestion for Matrix sessions independently of transport send', async () => {
    const db = createDb();
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'matrix',
      peer: '!room:example.org',
    });
    const baseUrl = await listen(createApp(db));

    const transcript = await request(baseUrl, `/conversation/sessions/${session.id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({
        direction: 'inbound',
        text: 'Observed via external bridge.',
        externalMessageId: '$external',
      }),
    });
    expect(transcript.status).toBe(200);
    expect(transcript.body.message).toMatchObject({
      channel: 'matrix',
      direction: 'inbound',
      externalMessageId: '$external',
    });

    db.close();
  });
});
