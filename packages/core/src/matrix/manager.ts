import type { Database } from '../storage/db.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../crypto/secrets.js';

export interface MatrixConfig {
  enabled: boolean;
  homeserverUrl: string;
  accessToken: string;
  userId?: string;
  deviceId?: string;
  allowedRoomIds: string[];
  operatorRoomId?: string;
  syncToken?: string;
  configuredAt: string;
}

export interface MatrixMessage {
  id: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  roomId: string;
  eventId?: string;
  sender?: string;
  text: string;
  status: 'received' | 'sent' | 'failed';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const MATRIX_SECRET_FIELDS = ['accessToken'] as const;

function parseJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function normalizeHomeserverUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!raw) throw new Error('homeserverUrl is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('homeserverUrl must be a valid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('homeserverUrl must use https:// unless it is localhost');
  }
  return url.toString().replace(/\/+$/, '');
}

function rowToMessage(row: any): MatrixMessage {
  return {
    id: row.id,
    agentId: row.agent_id,
    direction: row.direction,
    roomId: row.room_id,
    eventId: row.event_id ?? undefined,
    sender: row.sender ?? undefined,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    metadata: row.metadata ? parseJson(row.metadata) : undefined,
  };
}

export function redactMatrixConfig(config: MatrixConfig): MatrixConfig {
  return {
    ...config,
    accessToken: config.accessToken ? '***' : config.accessToken,
  };
}

export function isMatrixRoomAllowed(config: MatrixConfig, roomId: string): boolean {
  const id = String(roomId ?? '').trim();
  if (!id) return false;
  if (config.operatorRoomId && config.operatorRoomId.trim() === id) return true;
  return config.allowedRoomIds.some((room) => room.trim() === id);
}

export function buildMatrixConfig(input: {
  homeserverUrl?: unknown;
  accessToken?: unknown;
  userId?: unknown;
  deviceId?: unknown;
  allowedRoomIds?: unknown;
  operatorRoomId?: unknown;
  syncToken?: unknown;
  enabled?: unknown;
  configuredAt?: unknown;
}): MatrixConfig {
  const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : '';
  if (!accessToken) throw new Error('accessToken is required');
  return {
    enabled: input.enabled === false ? false : true,
    homeserverUrl: normalizeHomeserverUrl(input.homeserverUrl),
    accessToken,
    userId: typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : undefined,
    deviceId: typeof input.deviceId === 'string' && input.deviceId.trim() ? input.deviceId.trim() : undefined,
    allowedRoomIds: normalizeList(input.allowedRoomIds),
    operatorRoomId: typeof input.operatorRoomId === 'string' && input.operatorRoomId.trim()
      ? input.operatorRoomId.trim()
      : undefined,
    syncToken: typeof input.syncToken === 'string' && input.syncToken.trim() ? input.syncToken.trim() : undefined,
    configuredAt: typeof input.configuredAt === 'string' ? input.configuredAt : new Date().toISOString(),
  };
}

export class MatrixManager {
  private initialized = false;

  constructor(private db: Database, private encryptionKey?: string) {
    this.ensureTable();
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matrix_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        room_id TEXT NOT NULL,
        event_id TEXT,
        sender TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}'
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_matrix_agent ON matrix_messages(agent_id)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_matrix_room ON matrix_messages(agent_id, room_id)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_matrix_event ON matrix_messages(agent_id, room_id, event_id)'); } catch {}
    this.initialized = true;
  }

  private encryptConfig(config: MatrixConfig): MatrixConfig {
    if (!this.encryptionKey) return config;
    const out: MatrixConfig = { ...config };
    for (const field of MATRIX_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  private decryptConfig(config: MatrixConfig): MatrixConfig {
    if (!this.encryptionKey) return config;
    const out: MatrixConfig = { ...config };
    for (const field of MATRIX_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try { out[field] = decryptSecret(value, this.encryptionKey); } catch { /* fail closed */ }
      }
    }
    return out;
  }

  private normalizeConfig(raw: Record<string, unknown>): MatrixConfig {
    return buildMatrixConfig({
      enabled: raw.enabled,
      homeserverUrl: raw.homeserverUrl,
      accessToken: raw.accessToken,
      userId: raw.userId,
      deviceId: raw.deviceId,
      allowedRoomIds: raw.allowedRoomIds,
      operatorRoomId: raw.operatorRoomId,
      syncToken: raw.syncToken,
      configuredAt: raw.configuredAt,
    });
  }

  getConfig(agentId: string): MatrixConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return null;
    const meta = parseJson(row.metadata);
    if (!meta.matrix || typeof meta.matrix !== 'object' || Array.isArray(meta.matrix)) return null;
    try {
      return this.decryptConfig(this.normalizeConfig(meta.matrix as Record<string, unknown>));
    } catch {
      return null;
    }
  }

  saveConfig(agentId: string, config: MatrixConfig): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);
    const meta = parseJson(row.metadata);
    meta.matrix = this.encryptConfig(config);
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  updateSyncToken(agentId: string, syncToken: string): void {
    const cfg = this.getConfig(agentId);
    if (!cfg) return;
    cfg.syncToken = syncToken;
    this.saveConfig(agentId, cfg);
  }

  removeConfig(agentId: string): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return;
    const meta = parseJson(row.metadata);
    delete meta.matrix;
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  inboundMessageExists(agentId: string, roomId: string, eventId: string): boolean {
    if (!eventId) return false;
    const row = this.db.prepare(
      'SELECT 1 FROM matrix_messages WHERE agent_id = ? AND direction = ? AND room_id = ? AND event_id = ? LIMIT 1',
    ).get(agentId, 'inbound', roomId, eventId);
    return !!row;
  }

  recordInbound(
    agentId: string,
    input: { roomId: string; eventId: string; sender?: string; text: string; createdAt?: string },
    metadata?: Record<string, unknown>,
  ): MatrixMessage {
    const id = `mx_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = input.createdAt || new Date().toISOString();
    this.db.prepare(
      'INSERT INTO matrix_messages (id, agent_id, direction, room_id, event_id, sender, text, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, agentId, 'inbound', input.roomId, input.eventId, input.sender ?? null,
      input.text, 'received', createdAt, JSON.stringify(metadata ?? {}),
    );
    return {
      id, agentId, direction: 'inbound', roomId: input.roomId, eventId: input.eventId,
      sender: input.sender, text: input.text, status: 'received', createdAt, metadata,
    };
  }

  recordOutbound(
    agentId: string,
    input: { roomId: string; text: string; eventId?: string; status?: MatrixMessage['status'] },
    metadata?: Record<string, unknown>,
  ): MatrixMessage {
    const id = `mx_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const status = input.status ?? 'sent';
    this.db.prepare(
      'INSERT INTO matrix_messages (id, agent_id, direction, room_id, event_id, sender, text, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, agentId, 'outbound', input.roomId, input.eventId ?? null, null,
      input.text, status, createdAt, JSON.stringify(metadata ?? {}),
    );
    return {
      id, agentId, direction: 'outbound', roomId: input.roomId, eventId: input.eventId,
      text: input.text, status, createdAt, metadata,
    };
  }

  listMessages(
    agentId: string,
    opts: { direction?: 'inbound' | 'outbound'; roomId?: string; limit?: number; offset?: number } = {},
  ): MatrixMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: (string | number)[] = [agentId];
    let sql = 'SELECT * FROM matrix_messages WHERE agent_id = ?';
    if (opts.direction === 'inbound' || opts.direction === 'outbound') {
      sql += ' AND direction = ?';
      params.push(opts.direction);
    }
    if (opts.roomId) {
      sql += ' AND room_id = ?';
      params.push(opts.roomId);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToMessage);
  }
}
