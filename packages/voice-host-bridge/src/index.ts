import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

export type VoiceHostBridgeProvider = 'openai' | 'grok' | 'xai' | 'custom' | string;

export interface VoiceHostBridgeOptions {
  host?: string;
  port?: number;
  path?: string;
  healthPath?: string;
  provider?: VoiceHostBridgeProvider;
  upstreamUrl?: string;
  upstreamApiKey?: string;
  upstreamApiKeyRequired?: boolean;
  model?: string;
  bridgeToken?: string;
  maxBufferedMessages?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'> | false;
}

export interface VoiceHostBridgeResolvedOptions {
  host: string;
  port: number;
  path: string;
  healthPath: string;
  provider: string;
  upstreamUrl: string;
  upstreamApiKey: string;
  upstreamApiKeyRequired: boolean;
  model: string;
  bridgeToken: string;
  maxBufferedMessages: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'> | false;
}

export interface VoiceHostBridgeHandle {
  server: Server;
  wsServer: WebSocketServer;
  url: string;
  healthUrl: string;
  options: VoiceHostBridgeResolvedOptions;
  close: () => Promise<void>;
}

interface QueuedMessage {
  data: RawData;
  isBinary: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3999;
const DEFAULT_PATH = '/realtime';
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_BUFFERED_MESSAGES = 200;

function normalizeProvider(value: string | undefined): string {
  const provider = (value || 'openai').trim().toLowerCase();
  if (provider === 'x-ai') return 'xai';
  if (provider === 'grok') return 'xai';
  return provider || 'openai';
}

function defaultUpstreamUrl(provider: string): string {
  if (provider === 'xai') return 'wss://api.x.ai/v1/realtime';
  return 'wss://api.openai.com/v1/realtime';
}

function defaultModel(provider: string): string {
  if (provider === 'xai') return 'grok-voice-latest';
  if (provider === 'custom') return 'host-owned';
  return 'gpt-realtime';
}

function normalizePath(path: string | undefined, fallback: string): string {
  const trimmed = (path || fallback).trim() || fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid voice host bridge port: ${value}`);
  }
  return parsed;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearer(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function requestToken(req: IncomingMessage, url: URL): string {
  return (
    url.searchParams.get('token')?.trim()
    || extractBearer(req.headers.authorization)
    || String(req.headers['x-agenticmail-voice-host-bridge-token'] || '').trim()
  );
}

function rejectUpgrade(socket: Duplex, code: number, message: string): void {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function closeSocket(ws: WebSocket, code = 1000, reason = 'closed'): void {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  const safeReason = Buffer.byteLength(reason) > 120 ? `${reason.slice(0, 117)}...` : reason;
  try {
    ws.close(code, safeReason);
  } catch {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    closeSocket(ws, 1011, 'send failed');
  }
}

function appendModel(url: string, model: string): string {
  const u = new URL(url);
  if (model.trim()) u.searchParams.set('model', model.trim());
  return u.toString();
}

function toHttpUrl(host: string, port: number, path: string): string {
  const printableHost = host.includes(':') ? `[${host}]` : host;
  return `http://${printableHost}:${port}${path}`;
}

function toWsUrl(host: string, port: number, path: string): string {
  const printableHost = host.includes(':') ? `[${host}]` : host;
  return `ws://${printableHost}:${port}${path}`;
}

export function resolveVoiceHostBridgeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: VoiceHostBridgeOptions = {},
): VoiceHostBridgeResolvedOptions {
  const provider = normalizeProvider(
    overrides.provider
    || env.AGENTICMAIL_VOICE_HOST_BRIDGE_PROVIDER
    || env.VOICE_HOST_BRIDGE_PROVIDER,
  );
  const upstreamUrl = (
    overrides.upstreamUrl
    || env.AGENTICMAIL_VOICE_HOST_BRIDGE_UPSTREAM_URL
    || env.VOICE_HOST_BRIDGE_UPSTREAM_URL
    || defaultUpstreamUrl(provider)
  ).trim();
  const upstreamApiKey = (
    overrides.upstreamApiKey
    || env.AGENTICMAIL_VOICE_HOST_BRIDGE_UPSTREAM_KEY
    || env.VOICE_HOST_BRIDGE_UPSTREAM_KEY
    || (provider === 'xai' ? env.XAI_API_KEY : '')
    || (provider === 'openai' ? env.OPENAI_API_KEY : '')
    || ''
  ).trim();
  const upstreamAuthMode = env.AGENTICMAIL_VOICE_HOST_BRIDGE_UPSTREAM_AUTH || env.VOICE_HOST_BRIDGE_UPSTREAM_AUTH;
  const upstreamApiKeyRequired =
    overrides.upstreamApiKeyRequired ?? (upstreamAuthMode !== 'none' && provider !== 'custom');

  return {
    host: overrides.host || env.AGENTICMAIL_VOICE_HOST_BRIDGE_HOST || env.VOICE_HOST_BRIDGE_HOST || DEFAULT_HOST,
    port: overrides.port ?? parsePort(
      env.AGENTICMAIL_VOICE_HOST_BRIDGE_PORT || env.VOICE_HOST_BRIDGE_PORT,
      DEFAULT_PORT,
    ),
    path: normalizePath(
      overrides.path || env.AGENTICMAIL_VOICE_HOST_BRIDGE_PATH || env.VOICE_HOST_BRIDGE_PATH,
      DEFAULT_PATH,
    ),
    healthPath: normalizePath(
      overrides.healthPath || env.AGENTICMAIL_VOICE_HOST_BRIDGE_HEALTH_PATH || env.VOICE_HOST_BRIDGE_HEALTH_PATH,
      DEFAULT_HEALTH_PATH,
    ),
    provider,
    upstreamUrl,
    upstreamApiKey,
    upstreamApiKeyRequired,
    model: (
      overrides.model
      || env.AGENTICMAIL_VOICE_HOST_BRIDGE_MODEL
      || env.VOICE_HOST_BRIDGE_MODEL
      || defaultModel(provider)
    ).trim(),
    bridgeToken: (
      overrides.bridgeToken
      || env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN
      || env.VOICE_HOST_BRIDGE_TOKEN
      || ''
    ).trim(),
    maxBufferedMessages: overrides.maxBufferedMessages ?? DEFAULT_BUFFERED_MESSAGES,
    logger: overrides.logger === undefined ? console : overrides.logger,
  };
}

function handleHealth(res: ServerResponse, opts: VoiceHostBridgeResolvedOptions, url: string): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    status: 'ok',
    provider: opts.provider,
    model: opts.model,
    url,
    upstream: new URL(opts.upstreamUrl).origin,
  }));
}

function bridgeConnection(client: WebSocket, opts: VoiceHostBridgeResolvedOptions, upstreams: Set<WebSocket>): void {
  const headers: Record<string, string> = {};
  if (opts.upstreamApiKey) headers.Authorization = `Bearer ${opts.upstreamApiKey}`;

  const upstream = new WebSocket(appendModel(opts.upstreamUrl, opts.model), { headers });
  upstreams.add(upstream);
  let upstreamOpen = false;
  let closed = false;
  const pending: QueuedMessage[] = [];

  const closeBoth = (code = 1000, reason = 'closed') => {
    if (closed) return;
    closed = true;
    closeSocket(client, code, reason);
    closeSocket(upstream, code, reason);
  };

  client.on('message', (data, isBinary) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (pending.length >= opts.maxBufferedMessages) {
      sendJson(client, {
        type: 'agenticmail.bridge.error',
        code: 'upstream_connect_timeout',
        message: 'voice host bridge upstream is not ready',
      });
      closeBoth(1011, 'upstream not ready');
      return;
    }
    pending.push({ data, isBinary });
  });

  upstream.on('open', () => {
    upstreamOpen = true;
    while (pending.length && upstream.readyState === WebSocket.OPEN) {
      const msg = pending.shift()!;
      upstream.send(msg.data, { binary: msg.isBinary });
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  upstream.on('error', (err) => {
    opts.logger && opts.logger.warn(`[voice-host-bridge] upstream error: ${(err as Error).message}`);
    sendJson(client, {
      type: 'agenticmail.bridge.error',
      code: 'upstream_error',
      message: (err as Error).message,
    });
    closeBoth(1011, 'upstream error');
  });

  client.on('error', (err) => {
    opts.logger && opts.logger.warn(`[voice-host-bridge] client error: ${(err as Error).message}`);
    closeBoth(1011, 'client error');
  });

  upstream.on('close', (code, reason) => {
    upstreams.delete(upstream);
    closeSocket(client, code || 1000, reason.toString() || 'upstream closed');
  });

  client.on('close', (code, reason) => {
    closeSocket(upstream, code || 1000, reason.toString() || 'client closed');
  });
}

export async function startVoiceHostBridge(options: VoiceHostBridgeOptions = {}): Promise<VoiceHostBridgeHandle> {
  const opts = resolveVoiceHostBridgeOptionsFromEnv(process.env, options);
  if (!opts.upstreamUrl) throw new Error('Voice host bridge upstream URL is required.');
  if (opts.upstreamApiKeyRequired && !opts.upstreamApiKey) {
    const keyName = opts.provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(
      `Voice host bridge upstream key is required for provider "${opts.provider}". `
      + `Set ${keyName} or AGENTICMAIL_VOICE_HOST_BRIDGE_UPSTREAM_KEY.`,
    );
  }

  const clients = new Set<WebSocket>();
  const upstreams = new Set<WebSocket>();
  const server = createServer((req, res) => {
    const host = req.headers.host || `${opts.host}:${opts.port}`;
    const requestUrl = new URL(req.url || '/', `http://${host}`);
    if (req.method === 'GET' && requestUrl.pathname === opts.healthPath) {
      handleHealth(res, opts, url);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const wsServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host || `${opts.host}:${opts.port}`;
    const requestUrl = new URL(req.url || '/', `http://${host}`);
    if (requestUrl.pathname !== opts.path) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (opts.bridgeToken && !safeEquals(requestToken(req, requestUrl), opts.bridgeToken)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (client) => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      bridgeConnection(client, opts, upstreams);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, opts.host);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = toWsUrl(opts.host, port, opts.path);
  const healthUrl = toHttpUrl(opts.host, port, opts.healthPath);
  opts.logger && opts.logger.log(
    `[voice-host-bridge] listening on ${url} provider=${opts.provider} model=${opts.model}`,
  );

  return {
    server,
    wsServer,
    url,
    healthUrl,
    options: { ...opts, port },
    close: async () => {
      for (const ws of clients) closeSocket(ws, 1001, 'bridge shutting down');
      for (const ws of upstreams) closeSocket(ws, 1001, 'bridge shutting down');
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
