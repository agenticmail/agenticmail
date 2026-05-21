import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  PhoneManager,
  createTestDatabase,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createRealtimeConversationRoutes } from '../routes/realtime-conversation.js';

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

function createDb(metadata = '{}') {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', metadata);
  return db;
}

function createApp(db: ReturnType<typeof createTestDatabase>, config: AgenticMailConfig): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).agent = { id: 'agent1', email: 'ralf@example.com' };
    next();
  });
  app.use(createRealtimeConversationRoutes(db, config));
  return app;
}

describe('realtime conversation routes', () => {
  it('lists channel capabilities and runtime start plans for the agent', async () => {
    const db = createDb();
    const baseUrl = await listen(createApp(db, { masterKey: 'mk' } as AgenticMailConfig));

    const result = await request(baseUrl, '/conversation/realtime/capabilities');

    expect(result.status).toBe(200);
    expect(result.body.capabilities.map((cap: any) => cap.channel)).toEqual([
      'phone',
      'telegram',
      'matrix',
      'whatsapp',
      'google_meet',
    ]);
    expect(result.body.startPlans.phone.missing).toEqual(expect.arrayContaining([
      'Phone call transport configuration',
      'OpenAI Realtime API key',
      'per-mission policy',
    ]));
    expect(result.body.startPlans.whatsapp.missing).toContain('WhatsApp adapter implementation');

    db.close();
  });

  it('allows phone realtime when the runtime and mission policy gate are present', async () => {
    const db = createDb();
    const config = { masterKey: 'mk', openaiApiKey: 'sk-test' } as AgenticMailConfig;
    const phoneManager = new PhoneManager(db as any, config.masterKey);
    phoneManager.savePhoneTransportConfig('agent1', {
      provider: '46elks',
      phoneNumber: '+43123456789',
      username: 'user',
      password: 'api-password-secret',
      webhookBaseUrl: 'https://agenticmail.example.com',
      webhookSecret: 'hook-secret-abcdefghijklmnop',
      apiUrl: 'https://api.46elks.com/a1',
      capabilities: ['call_control', 'realtime_media'],
      supportedRegions: ['AT', 'DE', 'EU'],
      configuredAt: new Date().toISOString(),
    });
    const baseUrl = await listen(createApp(db, config));

    const result = await request(baseUrl, '/conversation/realtime/plan', {
      method: 'POST',
      body: JSON.stringify({ channel: 'phone', policyProvided: true }),
    });

    expect(result.status).toBe(200);
    expect(result.body.plan).toMatchObject({ ok: true, channel: 'phone', mode: 'duplex_audio' });

    db.close();
  });

  it('models Telegram as near-realtime text when a linked chat exists', async () => {
    const db = createDb(JSON.stringify({
      telegram: {
        enabled: true,
        botToken: '123:secret',
        operatorChatId: '42',
        allowedChatIds: [],
        mode: 'poll',
        configuredAt: new Date().toISOString(),
      },
    }));
    const baseUrl = await listen(createApp(db, { masterKey: 'mk' } as AgenticMailConfig));

    const result = await request(baseUrl, '/conversation/realtime/plan', {
      method: 'POST',
      body: JSON.stringify({ channel: 'telegram' }),
    });

    expect(result.status).toBe(200);
    expect(result.body.plan).toMatchObject({
      ok: true,
      channel: 'telegram',
      mode: 'near_realtime_text',
    });

    db.close();
  });
});
