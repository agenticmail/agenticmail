import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ConversationSessionManager,
  createTestDatabase,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createGoogleMeetRoutes } from '../routes/google-meet.js';

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
  app.use(createGoogleMeetRoutes(db, config));
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

describe('Google Meet routes', () => {
  it('stores setup redacted and exposes readiness', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db));

    const setup = await request(baseUrl, '/meet/setup', {
      method: 'POST',
      body: JSON.stringify({
        accessToken: 'ya29.test-token',
        participantName: 'AgenticMail Assistant',
        allowedDomains: ['example.com'],
        defaultBehaviorMode: 'answer_when_asked',
        mediaApiDeveloperPreview: true,
        mediaSidecarUrl: 'http://127.0.0.1:4999/meet',
        consentPolicyAccepted: true,
        verify: false,
      }),
    });

    expect(setup.status).toBe(200);
    expect(setup.body.googleMeet.accessToken).toBe('***');
    expect(setup.body.readiness).toMatchObject({
      configured: true,
      canCreateSpaces: true,
      canReadArtifacts: true,
      canUseLiveMedia: true,
      missing: [],
    });

    const configRead = await request(baseUrl, '/meet/config');
    expect(configRead.body.googleMeet).toMatchObject({
      accessToken: '***',
      participantName: 'AgenticMail Assistant',
      allowedDomains: ['example.com'],
    });

    db.close();
  });

  it('creates and reads Meet spaces through the REST API', async () => {
    const db = createDb();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      if (!String(url).includes('meet.googleapis.com')) return realFetch(url, init);
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        name: 'spaces/abc-defg-hij',
        meetingUri: 'https://meet.google.com/abc-defg-hij',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const baseUrl = await listen(createApp(db));

    await request(baseUrl, '/meet/setup', {
      method: 'POST',
      body: JSON.stringify({ accessToken: 'ya29.test-token', verify: false }),
    });
    const created = await request(baseUrl, '/meet/spaces/create', {
      method: 'POST',
      body: JSON.stringify({ accessType: 'TRUSTED' }),
    });
    const read = await request(baseUrl, '/meet/spaces/abc-defg-hij');

    expect(created.status).toBe(200);
    expect(created.body.space.meetingUri).toBe('https://meet.google.com/abc-defg-hij');
    expect(read.status).toBe(200);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'https://meet.googleapis.com/v2/spaces'],
      ['GET', 'https://meet.googleapis.com/v2/spaces/abc-defg-hij'],
    ]);

    db.close();
  });

  it('imports Meet transcript entries into a google_meet conversation session', async () => {
    const db = createDb();
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'google_meet',
      peer: 'https://meet.google.com/abc-defg-hij',
      externalRef: 'abc-defg-hij',
      subject: 'Project Alpha review',
    });
    const baseUrl = await listen(createApp(db));

    const imported = await request(baseUrl, '/meet/artifacts/import', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        entries: [
          {
            name: 'conferenceRecords/cr1/transcripts/t1/entries/e1',
            participant: 'conferenceRecords/cr1/participants/p1',
            text: 'We approved the pricing change.',
            languageCode: 'en-US',
            startTime: '2026-05-25T15:00:00Z',
          },
          {
            name: 'conferenceRecords/cr1/transcripts/t1/entries/e1',
            text: 'duplicate',
          },
        ],
      }),
    });

    expect(imported.status).toBe(200);
    expect(imported.body.importedCount).toBe(1);
    expect(imported.body.skipped).toBe(1);
    const messages = conversations.listMessages('agent1', session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: 'google_meet',
      direction: 'inbound',
      text: 'We approved the pricing change.',
      externalMessageId: 'conferenceRecords/cr1/transcripts/t1/entries/e1',
      metadata: {
        kind: 'google_meet_transcript_entry',
        languageCode: 'en-US',
      },
    });

    db.close();
  });

  it('hands a google_meet session to the configured live media sidecar', async () => {
    const db = createDb();
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'google_meet',
      peer: 'https://meet.google.com/abc-defg-hij',
      externalRef: 'abc-defg-hij',
      subject: 'Project Alpha review',
      metadata: {
        meetLink: 'https://meet.google.com/abc-defg-hij',
        meetingCode: 'abc-defg-hij',
        liveContext: { behaviorMode: 'answer_when_asked', hostIntegration: 'openclaw' },
      },
    });
    const sidecarCalls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      if (String(url).startsWith('http://127.0.0.1:4999')) {
        sidecarCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true, status: 'joining', streamId: 'stream_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(url, init);
    }));
    const baseUrl = await listen(createApp(db));

    await request(baseUrl, '/meet/setup', {
      method: 'POST',
      body: JSON.stringify({
        accessToken: 'ya29.test-token',
        mediaApiDeveloperPreview: true,
        mediaSidecarUrl: 'http://127.0.0.1:4999',
        participantName: 'AgenticMail Assistant',
        consentPolicyAccepted: true,
        verify: false,
      }),
    });
    const joined = await request(baseUrl, '/meet/live/join', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    });

    expect(joined.status).toBe(200);
    expect(joined.body.result).toMatchObject({ status: 'joining', streamId: 'stream_1' });
    expect(sidecarCalls[0]).toMatchObject({
      url: 'http://127.0.0.1:4999/join',
      body: {
        sessionId: session.id,
        meetingUri: 'https://meet.google.com/abc-defg-hij',
        meetingCode: 'abc-defg-hij',
        participantName: 'AgenticMail Assistant',
        behaviorMode: 'answer_when_asked',
        accessToken: 'ya29.test-token',
      },
    });
    const messages = conversations.listMessages('agent1', session.id);
    expect(messages[0]).toMatchObject({
      direction: 'system',
      metadata: {
        kind: 'google_meet_live_join',
        streamId: 'stream_1',
      },
    });

    db.close();
  });
});
