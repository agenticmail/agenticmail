import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createTestDatabase } from '@agenticmail/core';
import { createRealtimeVoiceServer, REALTIME_WS_PATH } from '../realtime-ws.js';

/**
 * Exercises the realtime-voice WebSocket *glue* — upgrade path
 * matching, the hello/mission-resolution gate, and fail-closed
 * teardown. The full OpenAI ↔ 46elks bridge needs live credentials and
 * is covered at the unit level by the core RealtimeVoiceBridge tests;
 * here we only verify that the server accepts the right path and
 * rejects everything it cannot authorise.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(): Promise<{ port: number }> {
  const db = createTestDatabase();
  const realtime = createRealtimeVoiceServer(db as any, { masterKey: 'mk', openaiApiKey: '' } as any);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (!realtime.tryHandleUpgrade(req, socket, head)) socket.destroy();
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return { port: addr.port };
}

/** Resolve once the client connection has either opened or failed. */
function settle(ws: WebSocket): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('closed'));
    ws.once('unexpected-response', () => resolve('closed'));
  });
}

describe('realtime voice WebSocket server', () => {
  it('rejects an upgrade on a non-matching path', async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agenticmail/not-realtime`);
    expect(await settle(ws)).toBe('closed');
    ws.terminate();
  });

  it('accepts an upgrade on the realtime path', async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_WS_PATH}?token=secret`);
    expect(await settle(ws)).toBe('open');
    ws.terminate();
  });

  it('closes the connection when the first frame is not a hello', async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_WS_PATH}?token=secret`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'audio', data: 'aGVsbG8=' }));
    await once(ws, 'close');
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('closes the connection when the hello matches no phone mission', async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_WS_PATH}?token=secret`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'hello', callid: 'unknown-call', from: '+46766861234', to: '+12125550100' }));
    await once(ws, 'close');
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
