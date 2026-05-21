import { randomUUID } from 'node:crypto';
import type { Database } from '../storage/db.js';
import {
  isRealtimeConversationChannel,
  type RealtimeConversationChannel,
} from './realtime.js';

export type ConversationSessionStatus = 'active' | 'ended' | 'failed';
export type ConversationMessageDirection = 'inbound' | 'outbound' | 'system';

export interface ConversationSession {
  id: string;
  agentId: string;
  channel: RealtimeConversationChannel;
  status: ConversationSessionStatus;
  peer: string;
  subject?: string;
  goal?: string;
  externalRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  agentId: string;
  channel: RealtimeConversationChannel;
  direction: ConversationMessageDirection;
  text: string;
  externalMessageId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateConversationSessionInput {
  agentId: string;
  channel: string;
  peer: string;
  subject?: string;
  goal?: string;
  externalRef?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface RecordConversationMessageInput {
  sessionId: string;
  agentId: string;
  channel: RealtimeConversationChannel;
  direction: ConversationMessageDirection;
  text: string;
  externalMessageId?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
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

function rowToSession(row: any): ConversationSession {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    status: row.status,
    peer: row.peer,
    subject: row.subject ?? undefined,
    goal: row.goal ?? undefined,
    externalRef: row.external_ref ?? undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function rowToMessage(row: any): ConversationMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    channel: row.channel,
    direction: row.direction,
    text: row.text,
    externalMessageId: row.external_message_id ?? undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class ConversationSessionManager {
  private initialized = false;

  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'ended', 'failed')),
        peer TEXT NOT NULL,
        subject TEXT,
        goal TEXT,
        external_ref TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound', 'system')),
        text TEXT NOT NULL,
        external_message_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_sessions_agent ON conversation_sessions(agent_id, status, updated_at)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_sessions_peer ON conversation_sessions(agent_id, channel, peer, status)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_messages_session ON conversation_messages(session_id, created_at)'); } catch {}
    this.initialized = true;
  }

  createSession(input: CreateConversationSessionInput): ConversationSession {
    if (!input.agentId) throw new Error('agentId is required');
    if (!isRealtimeConversationChannel(input.channel)) {
      throw new Error(`Unsupported realtime conversation channel: ${input.channel || '(missing)'}`);
    }
    const peer = trimString(input.peer);
    if (!peer) throw new Error('peer is required');

    const now = (input.now ?? new Date()).toISOString();
    const session: ConversationSession = {
      id: `conv_${randomUUID()}`,
      agentId: input.agentId,
      channel: input.channel,
      status: 'active',
      peer,
      subject: trimString(input.subject) || undefined,
      goal: trimString(input.goal) || undefined,
      externalRef: trimString(input.externalRef) || undefined,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO conversation_sessions
        (id, agent_id, channel, status, peer, subject, goal, external_ref, metadata, created_at, updated_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.agentId, session.channel, session.status, session.peer,
      session.subject ?? null, session.goal ?? null, session.externalRef ?? null,
      JSON.stringify(session.metadata), session.createdAt, session.updatedAt, null,
    );
    return session;
  }

  getSession(agentId: string, id: string): ConversationSession | null {
    const row = this.db.prepare(
      'SELECT * FROM conversation_sessions WHERE agent_id = ? AND id = ?',
    ).get(agentId, id);
    return row ? rowToSession(row) : null;
  }

  listSessions(
    agentId: string,
    opts: { status?: ConversationSessionStatus; channel?: RealtimeConversationChannel; limit?: number; offset?: number } = {},
  ): ConversationSession[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: Array<string | number> = [agentId];
    let sql = 'SELECT * FROM conversation_sessions WHERE agent_id = ?';
    if (opts.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    if (opts.channel) {
      sql += ' AND channel = ?';
      params.push(opts.channel);
    }
    sql += ' ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToSession);
  }

  findActiveSessionByPeer(
    agentId: string,
    channel: RealtimeConversationChannel,
    peer: string,
  ): ConversationSession | null {
    const row = this.db.prepare(`
      SELECT * FROM conversation_sessions
      WHERE agent_id = ? AND channel = ? AND peer = ? AND status = 'active'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(agentId, channel, String(peer));
    return row ? rowToSession(row) : null;
  }

  recordMessage(input: RecordConversationMessageInput): ConversationMessage {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!input.sessionId) throw new Error('sessionId is required');
    if (!input.agentId) throw new Error('agentId is required');
    if (!text.trim()) throw new Error('text is required');
    const session = this.getSession(input.agentId, input.sessionId);
    if (!session) throw new Error('conversation session not found');
    if (session.status !== 'active') throw new Error('conversation session is not active');
    if (session.channel !== input.channel) throw new Error('message channel does not match session channel');

    const createdAt = (input.now ?? new Date()).toISOString();
    const message: ConversationMessage = {
      id: `cmsg_${randomUUID()}`,
      sessionId: input.sessionId,
      agentId: input.agentId,
      channel: input.channel,
      direction: input.direction,
      text,
      externalMessageId: trimString(input.externalMessageId) || undefined,
      metadata: input.metadata ?? {},
      createdAt,
    };
    this.db.prepare(`
      INSERT INTO conversation_messages
        (id, session_id, agent_id, channel, direction, text, external_message_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id, message.sessionId, message.agentId, message.channel, message.direction,
      message.text, message.externalMessageId ?? null, JSON.stringify(message.metadata), message.createdAt,
    );
    this.db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?')
      .run(createdAt, input.sessionId);
    return message;
  }

  listMessages(agentId: string, sessionId: string): ConversationMessage[] {
    const session = this.getSession(agentId, sessionId);
    if (!session) throw new Error('conversation session not found');
    return (this.db.prepare(
      'SELECT * FROM conversation_messages WHERE agent_id = ? AND session_id = ? ORDER BY created_at ASC, id ASC',
    ).all(agentId, sessionId) as any[]).map(rowToMessage);
  }

  endSession(
    agentId: string,
    id: string,
    status: ConversationSessionStatus = 'ended',
    now = new Date(),
  ): ConversationSession {
    if (status === 'active') throw new Error('endSession status must be ended or failed');
    const session = this.getSession(agentId, id);
    if (!session) throw new Error('conversation session not found');
    const endedAt = now.toISOString();
    this.db.prepare(
      'UPDATE conversation_sessions SET status = ?, updated_at = ?, ended_at = ? WHERE agent_id = ? AND id = ?',
    ).run(status, endedAt, endedAt, agentId, id);
    return this.getSession(agentId, id)!;
  }
}
