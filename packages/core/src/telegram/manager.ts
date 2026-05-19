/**
 * Telegram Manager — per-agent Telegram bot configuration + message log.
 *
 * Models the existing {@link import('../sms/manager.js').SmsManager} — the
 * closest existing channel — so the hardening bar matches:
 *   - Config lives in agent metadata under the `telegram` key.
 *   - Credential fields (`botToken`, `webhookSecret`) are encrypted at
 *     rest with the same AES-256-GCM scheme (`encryptSecret`) and
 *     redacted on every read that leaves the process.
 *   - Inbound/outbound messages are stored in a `telegram_messages` table.
 *
 * Single-tenant: there is no org / multi-tenant scoping and nothing is
 * hardcoded — every bot token, chat id and operator identity is
 * per-agent config supplied by the user.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Database } from '../storage/db.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../crypto/secrets.js';

/** Transport mode: long-poll `getUpdates`, or a registered webhook. */
export type TelegramMode = 'poll' | 'webhook';

export interface TelegramConfig {
  /** Whether the Telegram channel is active for this agent. */
  enabled: boolean;
  /** Bot API token from @BotFather. SECRET — encrypted at rest, redacted on read. */
  botToken: string;
  /** Bot @username (non-secret, for display). Captured from `getMe` at setup. */
  botUsername?: string;
  /** Numeric bot id (non-secret). Captured from `getMe` at setup. */
  botId?: number;
  /**
   * Chat ids permitted to message the agent. EMPTY = nobody (fail-closed,
   * same posture as the Fola bridge). The operator chat is always allowed.
   */
  allowedChatIds: string[];
  /** Chat that receives `ask_operator` notifications + can approve (plan §13.4). */
  operatorChatId?: string;
  /** Inbound transport. */
  mode: TelegramMode;
  /** Public webhook URL (webhook mode only). */
  webhookUrl?: string;
  /**
   * Shared secret echoed by Telegram in the
   * `X-Telegram-Bot-Api-Secret-Token` header. SECRET — encrypted at
   * rest, redacted on read. Doubles as the webhook routing key.
   */
  webhookSecret?: string;
  /** Persisted `getUpdates` offset (poll mode). */
  pollOffset?: number;
  /** When the channel was configured. */
  configuredAt: string;
}

export interface TelegramMessage {
  id: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  chatId: string;
  /** Telegram `message_id` (may be absent for a failed outbound attempt). */
  telegramMessageId?: number;
  /** Sender id (inbound only). */
  fromId?: string;
  text: string;
  status: 'received' | 'sent' | 'failed' | 'pending';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Telegram's `secret_token` charset, and our minimum entropy floor. */
export const TELEGRAM_WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]+$/;
export const TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH = 16;

/** Credential fields that must never sit in plaintext at rest. */
const TELEGRAM_SECRET_FIELDS = ['botToken', 'webhookSecret'] as const;

/**
 * Redact the credential fields of a Telegram config for any value that
 * leaves the process (API responses, logs). The bot token is collapsed
 * to `***` entirely — never partially shown — matching the SMS bar and
 * the plan §13.5 rule "no token ever in a log line or API response".
 */
export function redactTelegramConfig(config: TelegramConfig): TelegramConfig {
  return {
    ...config,
    botToken: config.botToken ? '***' : config.botToken,
    webhookSecret: config.webhookSecret ? '***' : undefined,
  };
}

/**
 * Allow-list gate for INBOUND messages. A chat may talk to the agent
 * only if it is on `allowedChatIds` OR it is the configured operator
 * chat. An empty allow-list means nobody — fail closed.
 */
export function isTelegramChatAllowed(config: TelegramConfig, chatId: string): boolean {
  const id = String(chatId ?? '').trim();
  if (!id) return false;
  if (config.operatorChatId && String(config.operatorChatId).trim() === id) return true;
  return Array.isArray(config.allowedChatIds)
    && config.allowedChatIds.some((c) => String(c).trim() === id);
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class TelegramManager {
  private initialized = false;

  /**
   * Optional master key used to encrypt Telegram credentials at rest
   * (the same AES-256-GCM scheme SMS/phone use). When absent (tests, or
   * a deployment with no master key) configs are stored as-is and reads
   * tolerate plaintext — upgrades and downgrades both stay safe.
   */
  constructor(private db: Database, private encryptionKey?: string) {
    this.ensureTable();
  }

  private ensureTable(): void {
    if (this.initialized) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS telegram_messages (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
          chat_id TEXT NOT NULL,
          telegram_message_id INTEGER,
          from_id TEXT,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT DEFAULT '{}'
        )
      `);
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_agent ON telegram_messages(agent_id)'); } catch {}
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_chat ON telegram_messages(chat_id)'); } catch {}
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_created ON telegram_messages(created_at)'); } catch {}
      this.initialized = true;
    } catch {
      // Table may already exist with a slightly different schema — fine.
      this.initialized = true;
    }
  }

  /** Encrypt the credential fields of a config before persisting. */
  private encryptConfig(config: TelegramConfig): TelegramConfig {
    if (!this.encryptionKey) return config;
    const out: TelegramConfig = { ...config };
    for (const field of TELEGRAM_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  /** Decrypt the credential fields of a config after loading. */
  private decryptConfig(config: TelegramConfig): TelegramConfig {
    if (!this.encryptionKey) return config;
    const out: TelegramConfig = { ...config };
    for (const field of TELEGRAM_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try {
          out[field] = decryptSecret(value, this.encryptionKey);
        } catch {
          // Wrong key / corrupt blob — leave the ciphertext so the
          // caller's auth check simply fails closed.
        }
      }
    }
    return out;
  }

  /** Normalize a stored/loaded config object, defaulting missing fields. */
  private normalizeConfig(raw: Record<string, unknown>): TelegramConfig {
    return {
      enabled: raw.enabled === true,
      botToken: typeof raw.botToken === 'string' ? raw.botToken : '',
      botUsername: typeof raw.botUsername === 'string' ? raw.botUsername : undefined,
      botId: typeof raw.botId === 'number' ? raw.botId : undefined,
      allowedChatIds: Array.isArray(raw.allowedChatIds)
        ? raw.allowedChatIds.map((c) => String(c).trim()).filter(Boolean)
        : [],
      operatorChatId: typeof raw.operatorChatId === 'string' && raw.operatorChatId.trim()
        ? raw.operatorChatId.trim() : undefined,
      mode: raw.mode === 'webhook' ? 'webhook' : 'poll',
      webhookUrl: typeof raw.webhookUrl === 'string' ? raw.webhookUrl : undefined,
      webhookSecret: typeof raw.webhookSecret === 'string' ? raw.webhookSecret : undefined,
      pollOffset: typeof raw.pollOffset === 'number' ? raw.pollOffset : 0,
      configuredAt: typeof raw.configuredAt === 'string' ? raw.configuredAt : new Date().toISOString(),
    };
  }

  /** Get the Telegram config from agent metadata (credentials decrypted). */
  getConfig(agentId: string): TelegramConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return null;
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (!meta.telegram || typeof meta.telegram !== 'object') return null;
      return this.decryptConfig(this.normalizeConfig(meta.telegram));
    } catch {
      return null;
    }
  }

  /** Save the Telegram config to agent metadata (credentials encrypted). */
  saveConfig(agentId: string, config: TelegramConfig): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);

    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
    meta.telegram = this.encryptConfig(config);
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  /** Remove the Telegram config from agent metadata. */
  removeConfig(agentId: string): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return;
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
    delete meta.telegram;
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  /** Persist a new poll offset without touching the rest of the config. */
  updatePollOffset(agentId: string, offset: number): void {
    const config = this.getConfig(agentId);
    if (!config) return;
    config.pollOffset = offset;
    this.saveConfig(agentId, config);
  }

  /**
   * Resolve the agent that owns a webhook secret. Used to authenticate +
   * route an inbound Telegram webhook delivery: a webhook carries no bot
   * identity, so the `X-Telegram-Bot-Api-Secret-Token` header is the
   * routing key. The comparison is constant-time, and a non-match
   * returns `null` so the route can answer with a single uniform 403
   * (no enumeration oracle — same posture as the SMS webhook).
   */
  findAgentByWebhookSecret(secret: string): { agentId: string; config: TelegramConfig } | null {
    const provided = String(secret ?? '');
    if (!provided) return null;

    const rows = this.db.prepare('SELECT id, metadata FROM agents').all() as
      { id: string; metadata: string }[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata || '{}');
        if (!meta.telegram || typeof meta.telegram !== 'object') continue;
        const config = this.decryptConfig(this.normalizeConfig(meta.telegram));
        if (!config.enabled || !config.webhookSecret) continue;
        if (safeEqual(provided, config.webhookSecret)) {
          return { agentId: row.id, config };
        }
      } catch {
        // Ignore malformed agent metadata.
      }
    }
    return null;
  }

  /** True if an inbound message with this Telegram id is already stored. */
  inboundMessageExists(agentId: string, chatId: string, telegramMessageId: number): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM telegram_messages WHERE agent_id = ? AND direction = ? AND chat_id = ? AND telegram_message_id = ? LIMIT 1',
    ).get(agentId, 'inbound', String(chatId), telegramMessageId);
    return !!row;
  }

  /** Record an inbound Telegram message. */
  recordInbound(
    agentId: string,
    input: { chatId: string; telegramMessageId: number; fromId?: string; text: string; createdAt?: string },
    metadata?: Record<string, unknown>,
  ): TelegramMessage {
    const id = `tg_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = input.createdAt || new Date().toISOString();
    this.db.prepare(
      'INSERT INTO telegram_messages (id, agent_id, direction, chat_id, telegram_message_id, from_id, text, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, agentId, 'inbound', String(input.chatId), input.telegramMessageId,
      input.fromId ?? null, input.text, 'received', createdAt, JSON.stringify(metadata ?? {}),
    );
    return {
      id, agentId, direction: 'inbound', chatId: String(input.chatId),
      telegramMessageId: input.telegramMessageId, fromId: input.fromId, text: input.text,
      status: 'received', createdAt, metadata,
    };
  }

  /** Record an outbound Telegram message attempt. */
  recordOutbound(
    agentId: string,
    input: { chatId: string; text: string; telegramMessageId?: number; status?: TelegramMessage['status'] },
    metadata?: Record<string, unknown>,
  ): TelegramMessage {
    const id = `tg_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const status = input.status ?? 'sent';
    this.db.prepare(
      'INSERT INTO telegram_messages (id, agent_id, direction, chat_id, telegram_message_id, from_id, text, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, agentId, 'outbound', String(input.chatId), input.telegramMessageId ?? null,
      null, input.text, status, createdAt, JSON.stringify(metadata ?? {}),
    );
    return {
      id, agentId, direction: 'outbound', chatId: String(input.chatId),
      telegramMessageId: input.telegramMessageId, text: input.text, status, createdAt, metadata,
    };
  }

  /** Update the status (+ optional metadata) of a stored message. */
  updateStatus(id: string, status: TelegramMessage['status'], metadata?: Record<string, unknown>): void {
    if (metadata) {
      this.db.prepare('UPDATE telegram_messages SET status = ?, metadata = ? WHERE id = ?')
        .run(status, JSON.stringify(metadata), id);
      return;
    }
    this.db.prepare('UPDATE telegram_messages SET status = ? WHERE id = ?').run(status, id);
  }

  /** List stored Telegram messages for an agent, newest first. */
  listMessages(
    agentId: string,
    opts?: { direction?: 'inbound' | 'outbound'; chatId?: string; limit?: number; offset?: number },
  ): TelegramMessage[] {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);

    let query = 'SELECT * FROM telegram_messages WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];
    if (opts?.direction === 'inbound' || opts?.direction === 'outbound') {
      query += ' AND direction = ?';
      params.push(opts.direction);
    }
    if (opts?.chatId) {
      query += ' AND chat_id = ?';
      params.push(String(opts.chatId));
    }
    query += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return (this.db.prepare(query).all(...params) as any[]).map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      direction: row.direction,
      chatId: row.chat_id,
      telegramMessageId: row.telegram_message_id ?? undefined,
      fromId: row.from_id ?? undefined,
      text: row.text,
      status: row.status,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }
}
