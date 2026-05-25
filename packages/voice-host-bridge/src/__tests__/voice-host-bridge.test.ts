import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  resolveVoiceHostBridgeOptionsFromEnv,
  startVoiceHostBridge,
  type VoiceHostBridgeHandle,
} from '../index.js';
import {
  resolveMeetMediaSidecarOptionsFromEnv,
  startMeetMediaSidecar,
} from '../meet-sidecar.js';

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

describe('Meet media sidecar', () => {
  it('accepts authenticated join handoffs and stores redacted session status', async () => {
    const sidecar = await startMeetMediaSidecar({
      port: 0,
      sidecarToken: 'sidecar-secret',
      logger: false,
    });
    closers.push(sidecar.close);

    const rejected = await fetch(sidecar.joinUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'conv_1',
        meetingUri: 'https://meet.google.com/abc-defg-hij',
        accessToken: 'ya29.test-token',
      }),
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(sidecar.joinUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret',
      },
      body: JSON.stringify({
        sessionId: 'conv_1',
        meetingUri: 'https://meet.google.com/abc-defg-hij',
        meetingCode: 'abc-defg-hij',
        participantName: 'AgenticMail Assistant',
        behaviorMode: 'answer_when_asked',
        accessToken: 'ya29.test-token',
      }),
    });
    const body = await accepted.json() as Record<string, unknown>;

    expect(accepted.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: 'accepted',
      sessionId: 'conv_1',
      streamId: 'meet_conv_1',
    });

    const sessionRes = await fetch(`${sidecar.sessionsUrl}/conv_1`, {
      headers: { 'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret' },
    });
    const session = await sessionRes.json() as Record<string, unknown>;
    expect(session).toMatchObject({
      sessionId: 'conv_1',
      meetingCode: 'abc-defg-hij',
      status: 'accepted',
    });
    expect(JSON.stringify(session)).not.toContain('ya29.test-token');
  });

  it('can delegate join handoffs to a configured driver command', async () => {
    const driverScript = [
      'let input = "";',
      'process.stdin.on("data", chunk => input += chunk);',
      'process.stdin.on("end", () => {',
      '  const req = JSON.parse(input);',
      '  process.stdout.write(JSON.stringify({',
      '    status: "joining",',
      '    streamId: "driver_" + req.sessionId,',
      '    participantId: "participant_1",',
      '    message: "driver accepted"',
      '  }));',
      '});',
    ].join('');
    const sidecar = await startMeetMediaSidecar({
      port: 0,
      driverCommand: process.execPath,
      driverArgs: ['-e', driverScript],
      logger: false,
    });
    closers.push(sidecar.close);

    const res = await fetch(sidecar.joinUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'conv_driver',
        meetingUri: 'https://meet.google.com/abc-defg-hij',
        accessToken: 'ya29.test-token',
      }),
    });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: 'joining',
      streamId: 'driver_conv_driver',
      participantId: 'participant_1',
    });
  });

  it('forwards local driver events to the AgenticMail callback with the callback token', async () => {
    const callbackServer = createServer();
    const callbackBodies: Array<{ headers: Record<string, any>; body: any }> = [];
    callbackServer.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        callbackBodies.push({
          headers: req.headers as Record<string, any>,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, recordedCount: 1 }));
      });
    });
    const callbackPort = await listen(callbackServer);
    closers.push(async () => {
      await new Promise<void>((resolve, reject) => callbackServer.close((err) => (err ? reject(err) : resolve())));
    });
    const sidecar = await startMeetMediaSidecar({
      port: 0,
      sidecarToken: 'sidecar-secret',
      logger: false,
    });
    closers.push(sidecar.close);

    await fetch(sidecar.joinUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret',
      },
      body: JSON.stringify({
        sessionId: 'conv_1',
        meetingUri: 'https://meet.google.com/abc-defg-hij',
        accessToken: 'ya29.test-token',
        eventCallbackUrl: `http://127.0.0.1:${callbackPort}/api/agenticmail/meet/live/events`,
        eventCallbackToken: 'callback-secret',
      }),
    });
    const eventRes = await fetch(`${sidecar.eventsUrl}/conv_1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret',
      },
      body: JSON.stringify({
        type: 'transcript.final',
        eventId: 'event-1',
        text: 'Live transcript text',
      }),
    });
    const eventBody = await eventRes.json() as Record<string, unknown>;

    expect(eventRes.status).toBe(200);
    expect(eventBody).toMatchObject({ success: true, forwarded: { recordedCount: 1 } });
    expect(callbackBodies[0]).toMatchObject({
      headers: {
        'x-agenticmail-meet-sidecar-token': 'callback-secret',
      },
      body: {
        sessionId: 'conv_1',
        type: 'transcript.final',
        eventId: 'event-1',
        text: 'Live transcript text',
      },
    });
  });

  it('queues live controls for a local Meet driver and consumes them once', async () => {
    const sidecar = await startMeetMediaSidecar({
      port: 0,
      sidecarToken: 'sidecar-secret',
      logger: false,
    });
    closers.push(sidecar.close);

    const queued = await fetch(`${sidecar.controlUrl}/conv_1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret',
      },
      body: JSON.stringify({
        action: 'say',
        text: 'Answer the pricing question.',
        streamId: 'stream_1',
        metadata: { priority: 'operator' },
      }),
    });
    const queuedBody = await queued.json() as Record<string, unknown>;

    expect(queued.status).toBe(200);
    expect(queuedBody).toMatchObject({
      success: true,
      status: 'queued',
      sessionId: 'conv_1',
      action: 'say',
      queued: 1,
      control: {
        sessionId: 'conv_1',
        action: 'say',
        text: 'Answer the pricing question.',
        streamId: 'stream_1',
        metadata: { priority: 'operator' },
      },
    });

    const consumed = await fetch(`${sidecar.controlUrl}/conv_1?consume=true`, {
      headers: { 'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret' },
    });
    const consumedBody = await consumed.json() as Record<string, unknown>;
    expect(consumed.status).toBe(200);
    expect(consumedBody).toMatchObject({ count: 1 });
    expect(consumedBody.controls).toEqual([
      expect.objectContaining({
        sessionId: 'conv_1',
        action: 'say',
        text: 'Answer the pricing question.',
      }),
    ]);

    const empty = await fetch(`${sidecar.controlUrl}/conv_1?consume=true`, {
      headers: { 'X-AgenticMail-Meet-Sidecar-Token': 'sidecar-secret' },
    });
    const emptyBody = await empty.json() as Record<string, unknown>;
    expect(empty.status).toBe(200);
    expect(emptyBody).toMatchObject({ controls: [], count: 0 });
  });

  it('resolves Meet sidecar defaults from environment variables', () => {
    const opts = resolveMeetMediaSidecarOptionsFromEnv({
      AGENTICMAIL_MEET_SIDECAR_PORT: '4999',
      AGENTICMAIL_MEET_SIDECAR_TOKEN: 'sidecar-secret',
      AGENTICMAIL_MEET_MEDIA_DRIVER_COMMAND: 'driver-bin',
      AGENTICMAIL_MEET_MEDIA_DRIVER_ARGS: '["--listen-only"]',
    });

    expect(opts.port).toBe(4999);
    expect(opts.sidecarToken).toBe('sidecar-secret');
    expect(opts.driverCommand).toBe('driver-bin');
    expect(opts.driverArgs).toEqual(['--listen-only']);
  });
});
