import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  resolveVoiceHostBridgeOptionsFromEnv,
  startVoiceHostBridge,
  type VoiceHostBridgeHandle,
} from '../index.js';

interface FakeUpstream {
  url: string;
  seen: {
    authorization: string | undefined;
    requestUrl: string;
    messages: string[];
  };
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    await closers.pop()!();
  }
});

function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

function waitErrorOrClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('error', () => resolve());
    ws.once('close', () => resolve());
  });
}

async function fakeUpstream(): Promise<FakeUpstream> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const seen = {
    authorization: undefined as string | undefined,
    requestUrl: '',
    messages: [] as string[],
  };
  wss.on('connection', (ws, req) => {
    seen.authorization = req.headers.authorization;
    seen.requestUrl = req.url || '';
    ws.on('message', (data, isBinary) => {
      seen.messages.push(data.toString());
      ws.send(JSON.stringify({
        type: 'fake.upstream.echo',
        text: data.toString(),
        binary: isBinary,
      }));
    });
  });
  const port = await listen(server);
  const close = async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  };
  closers.push(close);
  return {
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    seen,
    close,
  };
}

async function startBridge(upstream: FakeUpstream, extra: Partial<Parameters<typeof startVoiceHostBridge>[0]> = {}) {
  const bridge = await startVoiceHostBridge({
    port: 0,
    provider: 'openai',
    upstreamUrl: upstream.url,
    upstreamApiKey: 'upstream-key',
    model: 'gpt-realtime-test',
    logger: false,
    ...extra,
  });
  closers.push(bridge.close);
  return bridge;
}

describe('voice host bridge', () => {
  it('proxies realtime websocket frames and authenticates to the upstream provider', async () => {
    const upstream = await fakeUpstream();
    const bridge = await startBridge(upstream);

    const client = new WebSocket(bridge.url);
    await waitOpen(client);
    client.send(JSON.stringify({ type: 'session.update' }));
    const reply = JSON.parse(await waitMessage(client));

    expect(reply).toMatchObject({
      type: 'fake.upstream.echo',
      text: '{"type":"session.update"}',
      binary: false,
    });
    expect(upstream.seen.authorization).toBe('Bearer upstream-key');
    expect(upstream.seen.requestUrl).toContain('/v1/realtime?model=gpt-realtime-test');
    expect(upstream.seen.messages).toEqual(['{"type":"session.update"}']);
    client.close();
  });

  it('serves a localhost health endpoint without exposing secrets', async () => {
    const upstream = await fakeUpstream();
    const bridge = await startBridge(upstream);

    const res = await fetch(bridge.healthUrl);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      provider: 'openai',
      model: 'gpt-realtime-test',
      url: bridge.url,
    });
    expect(JSON.stringify(body)).not.toContain('upstream-key');
  });

  it('rejects unauthenticated AgenticMail clients when a bridge token is configured', async () => {
    const upstream = await fakeUpstream();
    const bridge = await startBridge(upstream, { bridgeToken: 'bridge-secret' });

    const rejected = new WebSocket(bridge.url);
    await waitErrorOrClose(rejected);

    const accepted = new WebSocket(`${bridge.url}?token=bridge-secret`);
    await waitOpen(accepted);
    accepted.close();
  });

  it('resolves host-friendly defaults from environment variables', () => {
    const opts = resolveVoiceHostBridgeOptionsFromEnv({
      AGENTICMAIL_VOICE_HOST_BRIDGE_PROVIDER: 'grok',
      XAI_API_KEY: 'xai-key',
      AGENTICMAIL_VOICE_HOST_BRIDGE_PORT: '4999',
      AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN: 'local-token',
    });

    expect(opts.provider).toBe('xai');
    expect(opts.port).toBe(4999);
    expect(opts.upstreamUrl).toBe('wss://api.x.ai/v1/realtime');
    expect(opts.upstreamApiKey).toBe('xai-key');
    expect(opts.bridgeToken).toBe('local-token');
    expect(opts.model).toBe('grok-voice-latest');
  });

  it('allows custom no-auth upstreams for local host runtimes', async () => {
    const upstream = await fakeUpstream();
    const bridge: VoiceHostBridgeHandle = await startVoiceHostBridge({
      port: 0,
      provider: 'custom',
      upstreamUrl: upstream.url,
      upstreamApiKeyRequired: false,
      model: 'local-runtime',
      logger: false,
    });
    closers.push(bridge.close);

    const client = new WebSocket(bridge.url);
    await waitOpen(client);
    client.send('ping');
    expect(JSON.parse(await waitMessage(client))).toMatchObject({ text: 'ping' });
    expect(upstream.seen.authorization).toBeUndefined();
    expect(upstream.seen.requestUrl).toContain('model=local-runtime');
    client.close();
  });
});
