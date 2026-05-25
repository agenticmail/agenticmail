import { timingSafeEqual } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MeetMediaSidecarDriverMode = 'blocking' | 'managed';

export interface MeetMediaSidecarJoinRequest {
  sessionId: string;
  meetingUri: string;
  meetingCode?: string;
  participantName?: string;
  behaviorMode?: string;
  topic?: string;
  goal?: string;
  eventCallbackUrl?: string;
  eventCallbackToken?: string;
  accessToken: string;
  liveContext?: Record<string, unknown>;
}

export interface MeetMediaSidecarJoinResponse {
  success: boolean;
  status: string;
  sessionId: string;
  streamId?: string;
  participantId?: string;
  message?: string;
  driver?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MeetMediaSidecarSession {
  sessionId: string;
  streamId: string;
  status: string;
  meetingUri: string;
  meetingCode?: string;
  participantName?: string;
  behaviorMode?: string;
  topic?: string;
  goal?: string;
  eventCallbackUrl?: string;
  createdAt: string;
  updatedAt: string;
  message?: string;
  driver?: Record<string, unknown>;
}

export interface MeetMediaSidecarOptions {
  host?: string;
  port?: number;
  joinPath?: string;
  eventsPath?: string;
  controlPath?: string;
  healthPath?: string;
  sessionsPath?: string;
  sidecarToken?: string;
  driverCommand?: string;
  driverArgs?: string[];
  driverMode?: MeetMediaSidecarDriverMode;
  driverTimeoutMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'> | false;
}

export interface MeetMediaSidecarResolvedOptions {
  host: string;
  port: number;
  joinPath: string;
  eventsPath: string;
  controlPath: string;
  healthPath: string;
  sessionsPath: string;
  sidecarToken: string;
  driverCommand: string;
  driverArgs: string[];
  driverMode: MeetMediaSidecarDriverMode;
  driverTimeoutMs: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'> | false;
}

export interface MeetMediaSidecarHandle {
  server: Server;
  url: string;
  joinUrl: string;
  eventsUrl: string;
  controlUrl: string;
  healthUrl: string;
  sessionsUrl: string;
  options: MeetMediaSidecarResolvedOptions;
  sessions: Map<string, MeetMediaSidecarSession>;
  close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4999;
const DEFAULT_JOIN_PATH = '/join';
const DEFAULT_EVENTS_PATH = '/events';
const DEFAULT_CONTROL_PATH = '/control';
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_SESSIONS_PATH = '/sessions';
const DEFAULT_DRIVER_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_DRIVER_OUTPUT_BYTES = 1_000_000;

interface MeetMediaSidecarCallback {
  url: string;
  token?: string;
}

interface MeetMediaSidecarDriverContext {
  eventsUrl: string;
  controlUrl: string;
  onManagedChild?: (child: ChildProcessWithoutNullStreams) => void;
}

export interface MeetMediaSidecarControl {
  id: string;
  sessionId: string;
  action: string;
  text?: string;
  streamId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

function normalizePath(path: string | undefined, fallback: string): string {
  const trimmed = (path || fallback).trim() || fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid Meet media sidecar port: ${value}`);
  }
  return parsed;
}

function normalizeDriverMode(value: string | undefined): MeetMediaSidecarDriverMode {
  const raw = (value || 'blocking').trim();
  if (raw === 'blocking' || raw === 'managed') return raw;
  throw new Error(`Invalid Meet media driver mode: ${value}`);
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requestSidecarToken(req: IncomingMessage, url: URL): string {
  return (
    url.searchParams.get('token')?.trim()
    || String(req.headers['x-agenticmail-meet-sidecar-token'] || '').trim()
  );
}

function toHttpUrl(host: string, port: number, path: string): string {
  const printableHost = host.includes(':') ? `[${host}]` : host;
  return `http://${printableHost}:${port}${path}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('JSON object body is required'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeJoinRequest(raw: Record<string, unknown>): MeetMediaSidecarJoinRequest {
  const sessionId = asString(raw.sessionId);
  const meetingUri = asString(raw.meetingUri);
  const accessToken = asString(raw.accessToken);
  if (!sessionId) throw new Error('sessionId is required');
  if (!meetingUri) throw new Error('meetingUri is required');
  if (!accessToken) throw new Error('accessToken is required');
  return {
    sessionId,
    meetingUri,
    meetingCode: asString(raw.meetingCode) || undefined,
    participantName: asString(raw.participantName) || undefined,
    behaviorMode: asString(raw.behaviorMode) || undefined,
    topic: asString(raw.topic) || undefined,
    goal: asString(raw.goal) || undefined,
    eventCallbackUrl: asString(raw.eventCallbackUrl) || undefined,
    eventCallbackToken: asString(raw.eventCallbackToken) || undefined,
    accessToken,
    liveContext: asRecord(raw.liveContext),
  };
}

function streamIdFor(sessionId: string): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'session';
  return `meet_${clean}`;
}

function toDriverRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function runDriverCommand(
  opts: MeetMediaSidecarResolvedOptions,
  request: MeetMediaSidecarJoinRequest,
  context: MeetMediaSidecarDriverContext,
): Promise<Record<string, unknown> | undefined> {
  if (!opts.driverCommand) return undefined;
  if (opts.driverMode === 'managed') return startManagedDriverCommand(opts, request, context);
  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const child = execFile(opts.driverCommand, opts.driverArgs, {
      timeout: opts.driverTimeoutMs,
      maxBuffer: MAX_DRIVER_OUTPUT_BYTES,
      env: {
        ...process.env,
        AGENTICMAIL_MEET_SESSION_ID: request.sessionId,
        AGENTICMAIL_MEET_MEETING_URI: request.meetingUri,
        AGENTICMAIL_MEET_EVENTS_URL: `${context.eventsUrl}/${encodeURIComponent(request.sessionId)}`,
        AGENTICMAIL_MEET_CONTROL_URL: `${context.controlUrl}/${encodeURIComponent(request.sessionId)}`,
        AGENTICMAIL_MEET_SIDECAR_TOKEN: opts.sidecarToken,
        AGENTICMAIL_MEET_EVENT_CALLBACK_URL: request.eventCallbackUrl || '',
      },
    }, (err, stdout, stderr) => {
      if (err) {
        const details = stderr.trim() || stdout.trim() || err.message;
        reject(new Error(`Meet media driver failed: ${details}`));
        return;
      }
      const out = stdout.trim();
      if (!out) {
        resolve({ status: 'driver_completed' });
        return;
      }
      try {
        resolve(toDriverRecord(JSON.parse(out)) ?? { raw: out });
      } catch {
        resolve({ raw: out });
      }
    });
    child.stdin?.end(payload);
  });
}

async function startManagedDriverCommand(
  opts: MeetMediaSidecarResolvedOptions,
  request: MeetMediaSidecarJoinRequest,
  context: MeetMediaSidecarDriverContext,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(opts.driverCommand, opts.driverArgs, {
      env: {
        ...process.env,
        AGENTICMAIL_MEET_SESSION_ID: request.sessionId,
        AGENTICMAIL_MEET_MEETING_URI: request.meetingUri,
        AGENTICMAIL_MEET_EVENTS_URL: `${context.eventsUrl}/${encodeURIComponent(request.sessionId)}`,
        AGENTICMAIL_MEET_CONTROL_URL: `${context.controlUrl}/${encodeURIComponent(request.sessionId)}`,
        AGENTICMAIL_MEET_SIDECAR_TOKEN: opts.sidecarToken,
        AGENTICMAIL_MEET_EVENT_CALLBACK_URL: request.eventCallbackUrl || '',
      },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const out = chunk.toString('utf8').trim();
      if (out && opts.logger) opts.logger.log(`[meet-sidecar-driver:${request.sessionId}] ${out}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const out = chunk.toString('utf8').trim();
      if (out && opts.logger) opts.logger.warn(`[meet-sidecar-driver:${request.sessionId}] ${out}`);
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Meet media driver failed to start: ${err.message}`));
    });
    child.once('spawn', () => {
      context.onManagedChild?.(child);
      child.stdin.end(payload);
      if (settled) return;
      settled = true;
      resolve({
        status: 'driver_started',
        pid: child.pid,
        controlUrl: `${context.controlUrl}/${encodeURIComponent(request.sessionId)}`,
        eventsUrl: `${context.eventsUrl}/${encodeURIComponent(request.sessionId)}`,
      });
    });
  });
}

export function resolveMeetMediaSidecarOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MeetMediaSidecarOptions = {},
): MeetMediaSidecarResolvedOptions {
  return {
    host: overrides.host || env.AGENTICMAIL_MEET_SIDECAR_HOST || DEFAULT_HOST,
    port: overrides.port ?? parsePort(env.AGENTICMAIL_MEET_SIDECAR_PORT, DEFAULT_PORT),
    joinPath: normalizePath(overrides.joinPath || env.AGENTICMAIL_MEET_SIDECAR_JOIN_PATH, DEFAULT_JOIN_PATH),
    eventsPath: normalizePath(overrides.eventsPath || env.AGENTICMAIL_MEET_SIDECAR_EVENTS_PATH, DEFAULT_EVENTS_PATH),
    controlPath: normalizePath(overrides.controlPath || env.AGENTICMAIL_MEET_SIDECAR_CONTROL_PATH, DEFAULT_CONTROL_PATH),
    healthPath: normalizePath(overrides.healthPath || env.AGENTICMAIL_MEET_SIDECAR_HEALTH_PATH, DEFAULT_HEALTH_PATH),
    sessionsPath: normalizePath(overrides.sessionsPath || env.AGENTICMAIL_MEET_SIDECAR_SESSIONS_PATH, DEFAULT_SESSIONS_PATH),
    sidecarToken: (overrides.sidecarToken || env.AGENTICMAIL_MEET_SIDECAR_TOKEN || '').trim(),
    driverCommand: (overrides.driverCommand || env.AGENTICMAIL_MEET_MEDIA_DRIVER_COMMAND || '').trim(),
    driverArgs: overrides.driverArgs || (
      env.AGENTICMAIL_MEET_MEDIA_DRIVER_ARGS
        ? JSON.parse(env.AGENTICMAIL_MEET_MEDIA_DRIVER_ARGS)
        : []
    ),
    driverMode: normalizeDriverMode(overrides.driverMode || env.AGENTICMAIL_MEET_MEDIA_DRIVER_MODE),
    driverTimeoutMs: overrides.driverTimeoutMs ?? Number(env.AGENTICMAIL_MEET_MEDIA_DRIVER_TIMEOUT_MS || DEFAULT_DRIVER_TIMEOUT_MS),
    logger: overrides.logger === undefined ? console : overrides.logger,
  };
}

function authorize(req: IncomingMessage, requestUrl: URL, opts: MeetMediaSidecarResolvedOptions): boolean {
  if (!opts.sidecarToken) return true;
  return safeEquals(requestSidecarToken(req, requestUrl), opts.sidecarToken);
}

function handleHealth(res: ServerResponse, opts: MeetMediaSidecarResolvedOptions, handleUrl: string): void {
  writeJson(res, 200, {
    status: 'ok',
    url: handleUrl,
    joinPath: opts.joinPath,
    eventsPath: opts.eventsPath,
    controlPath: opts.controlPath,
    sessionsPath: opts.sessionsPath,
    tokenRequired: !!opts.sidecarToken,
    driverConfigured: !!opts.driverCommand,
    driverMode: opts.driverMode,
  });
}

export async function startMeetMediaSidecar(options: MeetMediaSidecarOptions = {}): Promise<MeetMediaSidecarHandle> {
  const opts = resolveMeetMediaSidecarOptionsFromEnv(process.env, options);
  if (!Array.isArray(opts.driverArgs)) throw new Error('Meet media driver args must be an array');
  if (!Number.isFinite(opts.driverTimeoutMs) || opts.driverTimeoutMs <= 0) {
    throw new Error('Meet media driver timeout must be a positive number');
  }

  const sessions = new Map<string, MeetMediaSidecarSession>();
  const callbacks = new Map<string, MeetMediaSidecarCallback>();
  const controls = new Map<string, MeetMediaSidecarControl[]>();
  const driverChildren = new Map<string, ChildProcessWithoutNullStreams>();

  const registerManagedDriver = (sessionId: string, child: ChildProcessWithoutNullStreams) => {
    const previous = driverChildren.get(sessionId);
    if (previous && previous.pid !== child.pid && !previous.killed) previous.kill('SIGTERM');
    driverChildren.set(sessionId, child);
    child.once('exit', (code, signal) => {
      if (driverChildren.get(sessionId)?.pid === child.pid) driverChildren.delete(sessionId);
      const current = sessions.get(sessionId);
      if (!current) return;
      const failed = code !== 0 && signal !== 'SIGTERM';
      sessions.set(sessionId, {
        ...current,
        status: failed ? 'failed' : 'driver_exited',
        updatedAt: new Date().toISOString(),
        message: failed
          ? `Meet media driver exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`
          : `Meet media driver exited${signal ? ` with signal ${signal}` : ''}.`,
      });
    });
  };

  const forwardEvent = async (sessionId: string, body: Record<string, unknown>) => {
    const callback = callbacks.get(sessionId);
    if (!callback) throw new Error('Meet event callback is not configured for this session');
    const payload = {
      ...body,
      sessionId,
    };
    const response = await fetch(callback.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(callback.token ? { 'X-AgenticMail-Meet-Sidecar-Token': callback.token } : {}),
      },
      body: JSON.stringify(payload),
    });
    let data: unknown = {};
    try { data = await response.json(); } catch { /* ignore */ }
    if (!response.ok) {
      const message = typeof (data as any)?.error === 'string'
        ? (data as any).error
        : `AgenticMail Meet event callback returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  };

  const server = createServer(async (req, res) => {
    const host = req.headers.host || `${opts.host}:${opts.port}`;
    const requestUrl = new URL(req.url || '/', `http://${host}`);
    try {
      if (req.method === 'GET' && requestUrl.pathname === opts.healthPath) {
        handleHealth(res, opts, healthUrl);
        return;
      }
      if (!authorize(req, requestUrl, opts)) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === opts.sessionsPath) {
        writeJson(res, 200, { sessions: [...sessions.values()] });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname.startsWith(`${opts.sessionsPath}/`)) {
        const sessionId = decodeURIComponent(requestUrl.pathname.slice(opts.sessionsPath.length + 1));
        const session = sessions.get(sessionId);
        writeJson(res, session ? 200 : 404, session ?? { error: 'session_not_found' });
        return;
      }
      if (req.method === 'POST' && (
        requestUrl.pathname === opts.eventsPath
        || requestUrl.pathname.startsWith(`${opts.eventsPath}/`)
      )) {
        const raw = await readJsonBody(req);
        const sessionId = requestUrl.pathname === opts.eventsPath
          ? asString(raw.sessionId)
          : decodeURIComponent(requestUrl.pathname.slice(opts.eventsPath.length + 1));
        if (!sessionId) throw new Error('sessionId is required');
        const callbackResult = await forwardEvent(sessionId, raw);
        const current = sessions.get(sessionId);
        if (current) {
          const status = asString(raw.status);
          sessions.set(sessionId, {
            ...current,
            status: status || current.status,
            updatedAt: new Date().toISOString(),
            message: asString(raw.message) || current.message,
          });
        }
        writeJson(res, 200, { success: true, forwarded: callbackResult });
        return;
      }
      if (requestUrl.pathname === opts.controlPath || requestUrl.pathname.startsWith(`${opts.controlPath}/`)) {
        const sessionIdFromPath = requestUrl.pathname === opts.controlPath
          ? ''
          : decodeURIComponent(requestUrl.pathname.slice(opts.controlPath.length + 1));
        if (req.method === 'GET') {
          const sessionId = sessionIdFromPath || asString(requestUrl.searchParams.get('sessionId'));
          if (!sessionId) throw new Error('sessionId is required');
          const queue = controls.get(sessionId) ?? [];
          const consume = requestUrl.searchParams.get('consume') === 'true';
          if (consume) controls.set(sessionId, []);
          writeJson(res, 200, { controls: queue, count: queue.length });
          return;
        }
        if (req.method === 'POST') {
          const raw = await readJsonBody(req);
          const sessionId = sessionIdFromPath || asString(raw.sessionId);
          const action = asString(raw.action) || (asString(raw.text) ? 'say' : '');
          if (!sessionId) throw new Error('sessionId is required');
          if (!action) throw new Error('action is required');
          const command: MeetMediaSidecarControl = {
            id: `ctrl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            action,
            text: asString(raw.text) || undefined,
            streamId: asString(raw.streamId) || undefined,
            metadata: asRecord(raw.metadata),
            createdAt: new Date().toISOString(),
          };
          const queue = controls.get(sessionId) ?? [];
          queue.push(command);
          controls.set(sessionId, queue.slice(-200));
          writeJson(res, 200, {
            success: true,
            status: 'queued',
            sessionId,
            action,
            queued: controls.get(sessionId)?.length ?? 0,
            control: command,
          });
          return;
        }
      }
      if (req.method === 'POST' && requestUrl.pathname === opts.joinPath) {
        const request = normalizeJoinRequest(await readJsonBody(req));
        const now = new Date().toISOString();
        const streamId = streamIdFor(request.sessionId);
        const session: MeetMediaSidecarSession = {
          sessionId: request.sessionId,
          streamId,
          status: 'joining',
          meetingUri: request.meetingUri,
          meetingCode: request.meetingCode,
          participantName: request.participantName,
          behaviorMode: request.behaviorMode,
          topic: request.topic,
          goal: request.goal,
          eventCallbackUrl: request.eventCallbackUrl,
          createdAt: sessions.get(request.sessionId)?.createdAt ?? now,
          updatedAt: now,
        };
        sessions.set(request.sessionId, session);
        if (request.eventCallbackUrl) {
          callbacks.set(request.sessionId, {
            url: request.eventCallbackUrl,
            token: request.eventCallbackToken,
          });
        }
        opts.logger && opts.logger.log(
          `[meet-sidecar] join requested ${request.sessionId} ${request.meetingUri}`,
        );

        let driver: Record<string, unknown> | undefined;
        try {
          driver = await runDriverCommand(opts, request, {
            eventsUrl,
            controlUrl,
            onManagedChild: (child) => registerManagedDriver(request.sessionId, child),
          });
        } catch (err) {
          sessions.set(request.sessionId, {
            ...session,
            status: 'failed',
            updatedAt: new Date().toISOString(),
            message: (err as Error).message,
          });
          throw err;
        }
        const status = asString(driver?.status) || (opts.driverCommand ? 'driver_completed' : 'accepted');
        const response: MeetMediaSidecarJoinResponse = {
          success: true,
          status,
          sessionId: request.sessionId,
          streamId: asString(driver?.streamId) || streamId,
          participantId: asString(driver?.participantId) || undefined,
          message: asString(driver?.message) || (
            opts.driverCommand
              ? opts.driverMode === 'managed'
                ? 'Meet media driver started and will report events through the sidecar.'
                : 'Meet media driver completed join handoff.'
              : 'Meet join request accepted. No media driver command is configured on this sidecar.'
          ),
          driver,
        };
        sessions.set(request.sessionId, {
          ...session,
          streamId: response.streamId || streamId,
          status: response.status,
          updatedAt: new Date().toISOString(),
          message: response.message,
          driver,
        });
        writeJson(res, 200, response);
        return;
      }
      writeJson(res, 404, { error: 'not_found' });
    } catch (err) {
      opts.logger && opts.logger.warn(
        `[meet-sidecar] request failed: ${(err as Error).message}`,
      );
      writeJson(res, 400, { error: (err as Error).message });
    }
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
  const baseUrl = toHttpUrl(opts.host, port, '');
  const joinUrl = toHttpUrl(opts.host, port, opts.joinPath);
  const eventsUrl = toHttpUrl(opts.host, port, opts.eventsPath);
  const controlUrl = toHttpUrl(opts.host, port, opts.controlPath);
  const healthUrl = toHttpUrl(opts.host, port, opts.healthPath);
  const sessionsUrl = toHttpUrl(opts.host, port, opts.sessionsPath);
  opts.logger && opts.logger.log(
    `[meet-sidecar] listening on ${baseUrl} join=${opts.joinPath} driver=${opts.driverCommand ? 'configured' : 'none'}`,
  );

  return {
    server,
    url: baseUrl,
    joinUrl,
    eventsUrl,
    controlUrl,
    healthUrl,
    sessionsUrl,
    options: { ...opts, port },
    sessions,
    close: async () => {
      for (const child of driverChildren.values()) {
        if (!child.killed) child.kill('SIGTERM');
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
