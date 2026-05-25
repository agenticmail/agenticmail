import { randomUUID } from 'node:crypto';
import type { MatrixConfig } from './manager.js';

export const MATRIX_MESSAGE_LIMIT = 4000;

export interface MatrixApiOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface MatrixWhoami {
  userId: string;
  deviceId?: string;
}

export interface SendMatrixMessageResult {
  eventId: string;
  txnId: string;
}

export interface MatrixSyncOptions extends MatrixApiOptions {
  since?: string;
  timeoutMs?: number;
}

export interface ParsedMatrixMessage {
  roomId: string;
  eventId: string;
  sender?: string;
  text: string;
  createdAt?: string;
  metadata: Record<string, unknown>;
}

export class MatrixApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public errcode?: string,
  ) {
    super(message);
    this.name = 'MatrixApiError';
  }
}

function matrixUrl(config: Pick<MatrixConfig, 'homeserverUrl'>, path: string): string {
  const root = config.homeserverUrl.replace(/\/+$/, '');
  return `${root}${path}`;
}

async function callMatrixApi<T>(
  config: Pick<MatrixConfig, 'homeserverUrl' | 'accessToken'>,
  method: string,
  path: string,
  body?: unknown,
  options: MatrixApiOptions = {},
): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.accessToken}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(matrixUrl(config, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep raw body */ }
  if (!res.ok) {
    throw new MatrixApiError(
      typeof data?.error === 'string' ? data.error : `Matrix API request failed with HTTP ${res.status}`,
      res.status,
      typeof data?.errcode === 'string' ? data.errcode : undefined,
    );
  }
  return data as T;
}

export async function getMatrixWhoami(
  config: Pick<MatrixConfig, 'homeserverUrl' | 'accessToken'>,
  options: MatrixApiOptions = {},
): Promise<MatrixWhoami> {
  const data = await callMatrixApi<{ user_id?: string; device_id?: string }>(
    config,
    'GET',
    '/_matrix/client/v3/account/whoami',
    undefined,
    options,
  );
  if (!data.user_id) throw new MatrixApiError('Matrix whoami response did not include user_id');
  return { userId: data.user_id, deviceId: data.device_id };
}

export async function sendMatrixMessage(
  config: MatrixConfig,
  roomId: string,
  text: string,
  options: MatrixApiOptions & { txnId?: string } = {},
): Promise<SendMatrixMessageResult> {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!roomId.trim()) throw new Error('roomId is required');
  if (!body) throw new Error('text is required');
  const txnId = options.txnId ?? `agt_${randomUUID()}`;
  const path = [
    '/_matrix/client/v3/rooms',
    encodeURIComponent(roomId),
    'send',
    encodeURIComponent('m.room.message'),
    encodeURIComponent(txnId),
  ].join('/');
  const data = await callMatrixApi<{ event_id?: string }>(
    config,
    'PUT',
    path,
    { msgtype: 'm.text', body: body.slice(0, MATRIX_MESSAGE_LIMIT) },
    options,
  );
  if (!data.event_id) throw new MatrixApiError('Matrix send response did not include event_id');
  return { eventId: data.event_id, txnId };
}

export async function getMatrixSync(
  config: MatrixConfig,
  options: MatrixSyncOptions = {},
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams();
  query.set('timeout', String(Math.max(options.timeoutMs ?? 0, 0)));
  if (options.since) query.set('since', options.since);
  return callMatrixApi<Record<string, unknown>>(
    config,
    'GET',
    `/_matrix/client/v3/sync?${query.toString()}`,
    undefined,
    { fetchFn: options.fetchFn, timeoutMs: (options.timeoutMs ?? 0) + 10_000 },
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseMatrixSyncMessages(
  sync: Record<string, unknown>,
  opts: { ownUserId?: string; allowedRoomIds?: string[] } = {},
): ParsedMatrixMessage[] {
  const joined = objectValue(objectValue(objectValue(sync.rooms).join));
  const allowed = new Set((opts.allowedRoomIds ?? []).map((id) => String(id).trim()).filter(Boolean));
  const out: ParsedMatrixMessage[] = [];
  for (const [roomId, roomRaw] of Object.entries(joined)) {
    if (allowed.size > 0 && !allowed.has(roomId)) continue;
    const events = objectValue(objectValue(roomRaw).timeline).events;
    if (!Array.isArray(events)) continue;
    for (const rawEvent of events) {
      const event = objectValue(rawEvent);
      if (event.type !== 'm.room.message') continue;
      const sender = typeof event.sender === 'string' ? event.sender : undefined;
      if (opts.ownUserId && sender === opts.ownUserId) continue;
      const content = objectValue(event.content);
      if (content.msgtype !== 'm.text') continue;
      const text = typeof content.body === 'string' ? content.body : '';
      const eventId = typeof event.event_id === 'string' ? event.event_id : '';
      if (!text.trim() || !eventId) continue;
      const ts = typeof event.origin_server_ts === 'number' ? new Date(event.origin_server_ts).toISOString() : undefined;
      out.push({
        roomId,
        eventId,
        sender,
        text,
        createdAt: ts,
        metadata: {
          originServerTs: event.origin_server_ts,
          unsigned: objectValue(event.unsigned),
        },
      });
    }
  }
  return out;
}
