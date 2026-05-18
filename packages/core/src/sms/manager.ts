/**
 * SMS Manager - provider-backed SMS integration
 *
 * How it works:
 * 1. User chooses a provider for the agent phone number
 * 2. Google Voice uses email forwarding/web instructions
 * 3. 46elks uses direct API sends and inbound webhooks
 * 4. All inbound/outbound messages are stored in the SMS table
 *
 * SMS config is stored in agent metadata under the "sms" key.
 */

import type { Database } from '../storage/db.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../crypto/secrets.js';

export interface SmsConfig {
  /** Whether SMS is enabled for this agent */
  enabled: boolean;
  /** Phone number in E.164 format where possible */
  phoneNumber: string;
  /** The email address Google Voice forwards SMS to (the Gmail used for GV signup) */
  forwardingEmail?: string;
  /** App password for forwarding email (only needed if different from relay email) */
  forwardingPassword?: string;
  /** Whether the GV Gmail is the same as the relay email */
  sameAsRelay?: boolean;
  /** SMS provider */
  provider: 'google_voice' | '46elks';
  /** 46elks API username */
  username?: string;
  /** 46elks API password */
  password?: string;
  /** Provider API base URL override */
  apiUrl?: string;
  /** Secret required on inbound provider webhooks */
  webhookSecret?: string;
  /** When SMS was configured */
  configuredAt: string;
}

export interface ParsedSms {
  from: string;
  body: string;
  timestamp: string;
  raw?: string;
}

export interface SmsMessage {
  id: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  phoneNumber: string;
  body: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'received';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SendSmsInput {
  to: string;
  body: string;
  dryRun?: boolean;
}

export interface SendSmsResult {
  provider: SmsConfig['provider'];
  id?: string;
  status: string;
  from: string;
  to: string;
  body: string;
  raw?: unknown;
}

export interface InboundSmsEvent {
  provider: SmsConfig['provider'];
  id?: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  raw?: unknown;
}

export interface SmsProvider {
  id: SmsConfig['provider'];
  sendSms(config: SmsConfig, input: SendSmsInput): Promise<SendSmsResult>;
  parseInboundSms(payload: Record<string, unknown>): InboundSmsEvent | null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultApiUrl(config: SmsConfig): string {
  const url = (config.apiUrl || 'https://api.46elks.com/a1').replace(/\/+$/, '');
  // Defense-in-depth — the outbound call attaches Basic-Auth credentials,
  // so the endpoint MUST be https. The /sms/setup route already rejects
  // non-https overrides, but enforce it again at the point of use in case
  // a config was persisted before that validation existed.
  if (!/^https:\/\//i.test(url)) {
    throw new Error('46elks apiUrl must use https:// — refusing to send credentials over a non-TLS connection');
  }
  return url;
}

function basicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

export function redactSmsConfig(config: SmsConfig): SmsConfig {
  return {
    ...config,
    forwardingPassword: config.forwardingPassword ? '***' : undefined,
    password: config.password ? '***' : undefined,
    webhookSecret: config.webhookSecret ? '***' : undefined,
  };
}

class GoogleVoiceSmsProvider implements SmsProvider {
  id = 'google_voice' as const;

  async sendSms(config: SmsConfig, input: SendSmsInput): Promise<SendSmsResult> {
    const to = normalizePhoneNumber(input.to);
    const from = normalizePhoneNumber(config.phoneNumber);
    if (!to) throw new Error('Invalid recipient phone number');
    if (!from) throw new Error('Invalid configured Google Voice phone number');

    return {
      provider: this.id,
      status: 'pending',
      from,
      to,
      body: input.body,
      raw: {
        delivery: 'manual_google_voice_web',
        url: 'https://voice.google.com',
      },
    };
  }

  parseInboundSms(): InboundSmsEvent | null {
    return null;
  }
}

class FortySixElksSmsProvider implements SmsProvider {
  id = '46elks' as const;

  async sendSms(config: SmsConfig, input: SendSmsInput): Promise<SendSmsResult> {
    const username = asString(config.username);
    const password = asString(config.password);
    if (!username || !password) {
      throw new Error('46elks username and password are required');
    }

    const to = normalizePhoneNumber(input.to);
    const from = normalizePhoneNumber(config.phoneNumber);
    if (!to) throw new Error('Invalid recipient phone number');
    if (!from) throw new Error('Invalid configured 46elks phone number');

    const form = new URLSearchParams();
    form.set('to', to);
    form.set('from', from);
    form.set('message', input.body);
    if (input.dryRun) form.set('dryrun', 'yes');

    const response = await fetch(`${defaultApiUrl(config)}/sms`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth(username, password)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep raw provider response as text.
    }

    if (!response.ok) {
      const message = typeof raw === 'object' && raw && ('message' in raw || 'error' in raw)
        ? String((raw as { message?: unknown; error?: unknown }).message ?? (raw as { error?: unknown }).error)
        : text.slice(0, 200);
      throw new Error(`46elks SMS failed (${response.status}): ${message}`);
    }

    const providerId = typeof raw === 'object' && raw && 'id' in raw ? String((raw as { id?: unknown }).id) : undefined;
    const providerStatus = typeof raw === 'object' && raw && 'status' in raw ? String((raw as { status?: unknown }).status) : 'sent';

    return {
      provider: this.id,
      id: providerId,
      status: providerStatus,
      from,
      to,
      body: input.body,
      raw,
    };
  }

  parseInboundSms(payload: Record<string, unknown>): InboundSmsEvent | null {
    const direction = asString(payload.direction).toLowerCase();
    if (direction && direction !== 'incoming') return null;

    const from = normalizePhoneNumber(asString(payload.from));
    const to = normalizePhoneNumber(asString(payload.to));
    const body = asString(payload.message);
    if (!from || !to || !body) return null;

    return {
      provider: this.id,
      id: asString(payload.id) || undefined,
      from,
      to,
      body,
      timestamp: asString(payload.created) || new Date().toISOString(),
      raw: payload,
    };
  }
}

const PROVIDERS: Record<SmsConfig['provider'], SmsProvider> = {
  google_voice: new GoogleVoiceSmsProvider(),
  '46elks': new FortySixElksSmsProvider(),
};

export function getSmsProvider(provider: SmsConfig['provider']): SmsProvider {
  return PROVIDERS[provider];
}

export function mapProviderSmsStatus(status: string): SmsMessage['status'] {
  const normalized = status.toLowerCase();
  if (normalized === 'delivered') return 'delivered';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (normalized === 'created' || normalized === 'queued' || normalized === 'sent') return 'sent';
  return 'sent';
}

/** Normalize a phone number to E.164-ish format (+1XXXXXXXXXX) */
export function normalizePhoneNumber(raw: string): string | null {
  // Strip everything except digits and leading +
  const cleaned = raw.replace(/[^+\d]/g, '');
  if (!cleaned) return null;

  // Extract just digits
  const digits = cleaned.replace(/\D/g, '');

  // US numbers: 10 digits or 11 starting with 1
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // International: if already has +, keep it; otherwise reject ambiguous
  if (cleaned.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;

  // Too short or ambiguous
  if (digits.length < 10) return null;
  // Assume US if 10+ digits without +
  if (digits.length <= 11) return `+1${digits.slice(-10)}`;

  return null;
}

/** Validate a phone number (basic) */
export function isValidPhoneNumber(phone: string): boolean {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return false;
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Parse an SMS forwarded from Google Voice via email.
 * Google Voice forwards SMS with a specific format.
 *
 * Known sender addresses:
 * - voice-noreply@google.com
 * - *@txt.voice.google.com
 * - Google Voice <voice-noreply@google.com>
 */
export function parseGoogleVoiceSms(emailBody: string, emailFrom: string): ParsedSms | null {
  if (!emailBody || typeof emailBody !== 'string') return null;
  if (!emailFrom || typeof emailFrom !== 'string') return null;

  const fromLower = emailFrom.toLowerCase();
  // Extract the domain (everything after the last `@`, before any
  // trailing `>` from a display-name-wrapped address). Substring
  // matches alone are bypassable — `voice.google.com.attacker.tld`
  // would match `includes('voice.google.com')` but is NOT actually
  // from Google. CodeQL `js/incomplete-url-substring-sanitization`.
  const atIdx = fromLower.lastIndexOf('@');
  const domain = atIdx >= 0
    ? fromLower.slice(atIdx + 1).replace(/[>"'\s].*$/, '')
    : '';
  // Accept only addresses whose domain is google.com or a real
  // subdomain of google.com.
  const isGoogleDomain = domain === 'google.com' || domain.endsWith('.google.com');
  const isGoogleVoice =
    isGoogleDomain && (
      fromLower.startsWith('voice-noreply@') ||
      domain === 'txt.voice.google.com' ||
      domain === 'voice.google.com' ||
      domain.endsWith('.voice.google.com') ||
      fromLower.includes('voice')  // looser fallback inside an already-validated google.com
    );

  if (!isGoogleVoice) return null;

  // Strip HTML tags if present (Google Voice sends HTML emails)
  let text = emailBody
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();

  let from = '';

  // Pattern 1: "New text message from (XXX) XXX-XXXX" or "+1XXXXXXXXXX"
  const newMsgMatch = text.match(/new\s+(?:text\s+)?message\s+from\s+(\+?[\d\s().-]+)/i);
  if (newMsgMatch) {
    from = newMsgMatch[1];
  }

  // Pattern 2: Phone number at the start followed by colon — "+1 (234) 567-8901: Hello"
  if (!from) {
    const colonMatch = text.match(/^(\+?[\d\s().-]{10,})\s*:\s*/m);
    if (colonMatch) {
      from = colonMatch[1];
    }
  }

  // Pattern 3: Just find any phone number in the first few lines
  if (!from) {
    const firstLines = text.split('\n').slice(0, 5).join(' ');
    const phoneMatch = firstLines.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
    if (phoneMatch) from = phoneMatch[1];
  }

  // Normalize the from number
  if (from) {
    const normalized = normalizePhoneNumber(from);
    from = normalized || from.replace(/[^+\d]/g, '');
  }

  // Extract message body — skip boilerplate lines
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const boilerplatePatterns = [
    /^new\s+(text\s+)?message\s+from/i,
    /^\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\s*$/,
    /^to\s+respond\s+to\s+this/i,
    /^your\s+account$/i,
    /^google\s+voice$/i,
    /^sent\s+via\s+google\s+voice/i,
    /^you\s+received\s+this/i,
    /^to\s+stop\s+receiving/i,
    /^reply\s+to\s+this\s+email/i,
    /^https?:\/\/voice\.google\.com/i,
    /^manage\s+your\s+settings/i,
    /^google\s+llc/i,
    /^1600\s+amphitheatre/i,
  ];

  const messageLines = lines.filter(l => {
    for (const p of boilerplatePatterns) {
      if (p.test(l)) return false;
    }
    return true;
  });

  // If first line is "phone: message", remove the phone prefix
  let body = messageLines.join('\n').trim();
  const prefixMatch = body.match(/^(\+?[\d\s().-]{10,})\s*:\s*([\s\S]+)/);
  if (prefixMatch) {
    body = prefixMatch[2].trim();
  }

  if (!body) return null;

  return {
    from: from || 'unknown',
    body,
    timestamp: new Date().toISOString(),
    raw: emailBody,
  };
}

/**
 * Extract verification codes from SMS body.
 * Supports common formats: 6-digit, 4-digit, alphanumeric codes.
 */
export function extractVerificationCode(smsBody: string): string | null {
  if (!smsBody || typeof smsBody !== 'string') return null;

  const patterns = [
    // "Your code is 123456" / "verification code: 123456" / "code is: 123456"
    /(?:code|pin|otp|token|password)\s*(?:is|:)\s*(\d{4,8})/i,
    // "123456 is your code"
    /(\d{4,8})\s+is\s+your\s+(?:code|pin|otp|verification)/i,
    // G-123456 (Google style)
    /[Gg]-(\d{4,8})/,
    // "Enter 123456 to verify" / "Use 123456 to"
    /(?:enter|use)\s+(\d{4,8})\s+(?:to|for|as)/i,
    // Standalone 6-digit on its own line (common pattern)
    /^\s*(\d{6})\s*$/m,
    // "Code: ABC-123" style alphanumeric
    /(?:code|pin)\s*(?:is|:)\s*([A-Z0-9]{3,6}[-][A-Z0-9]{3,6})/i,
    // Last resort: any 6-digit sequence not part of a longer number
    /(?<!\d)(\d{6})(?!\d)/,
  ];

  for (const pattern of patterns) {
    const match = smsBody.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

/**
 * Credential fields on SmsConfig that must never sit in plaintext at rest.
 * The 46elks API password, the inbound-webhook shared secret, and the
 * Google Voice forwarding-mailbox app password are all live credentials —
 * a leaked SQLite file should not hand an attacker a working account.
 */
const SMS_SECRET_FIELDS = ['password', 'webhookSecret', 'forwardingPassword'] as const;

export class SmsManager {
  private initialized = false;

  /**
   * Optional master key used to encrypt SMS credentials at rest (same
   * AES-256-GCM scheme GatewayManager uses for relay/domain secrets).
   * When absent (e.g. tests, or a deployment with no master key) configs
   * are stored as-is and reads tolerate plaintext — so upgrades and
   * downgrades both stay safe.
   */
  constructor(private db: Database, private encryptionKey?: string) {
    this.ensureTable();
  }

  /** Encrypt the credential fields of an SMS config before persisting. */
  private encryptConfig(config: SmsConfig): SmsConfig {
    if (!this.encryptionKey) return config;
    const out: SmsConfig = { ...config };
    for (const field of SMS_SECRET_FIELDS) {
      const value = out[field];
      // Only encrypt non-empty plaintext — never double-encrypt.
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  /** Decrypt the credential fields of an SMS config after loading. */
  private decryptConfig(config: SmsConfig): SmsConfig {
    if (!this.encryptionKey) return config;
    const out: SmsConfig = { ...config };
    for (const field of SMS_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try {
          out[field] = decryptSecret(value, this.encryptionKey);
        } catch {
          // Wrong key / corrupt blob — leave the ciphertext in place
          // rather than crashing; the caller's auth check will simply
          // fail closed.
        }
      }
    }
    return out;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sms_messages (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
          phone_number TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT DEFAULT '{}'
        )
      `);
      // Create indexes separately to avoid issues if table exists but indexes don't
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sms_agent ON sms_messages(agent_id)'); } catch {}
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sms_direction ON sms_messages(direction)'); } catch {}
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_messages(created_at)'); } catch {}
      this.initialized = true;
    } catch (err) {
      // Table might already exist with slightly different schema — that's OK
      this.initialized = true;
    }
  }

  /** Get SMS config from agent metadata (credential fields decrypted). */
  getSmsConfig(agentId: string): SmsConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) return null;
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (!meta.sms || meta.sms.enabled === undefined) return null;
      return this.decryptConfig(meta.sms as SmsConfig);
    } catch {
      return null;
    }
  }

  /** Save SMS config to agent metadata (credential fields encrypted). */
  saveSmsConfig(agentId: string, config: SmsConfig): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      meta = {};
    }
    meta.sms = this.encryptConfig(config);
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  /**
   * Resolve the operator's "where do I get pinged" address from an
   * agent's SMS config. Used by the dispatcher's bridge-escalation
   * path: when sub-agents mail a bridge with no fresh host session
   * available, we email the operator a digest at this address. Their
   * phone's Gmail push notification surfaces it within seconds —
   * effectively a free, programmatic alert channel.
   *
   * Returns the configured `forwardingEmail` (the same Gmail Google
   * Voice forwards inbound SMS to, which the operator already has
   * push notifications enabled for) when SMS is configured AND
   * enabled. Returns null otherwise — caller falls through to a
   * silent log + system event.
   *
   * Why we don't try real-SMS delivery yet: Google Voice's
   * `<number>@txt.voice.google.com` email-to-SMS gateway was
   * deprecated by Google years ago. A future `carrier` field on
   * SmsConfig (Verizon vtext.com / AT&T txt.att.net / etc) will let
   * the operator opt into actual SMS, but that's a follow-up — the
   * email path already gets the operator a phone notification.
   */
  getAlertEmail(agentId: string): string | null {
    const cfg = this.getSmsConfig(agentId);
    if (!cfg || !cfg.enabled) return null;
    if (typeof cfg.forwardingEmail !== 'string' || !cfg.forwardingEmail.includes('@')) return null;
    return cfg.forwardingEmail;
  }

  /** Remove SMS config from agent metadata */
  removeSmsConfig(agentId: string): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) return;
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
    delete meta.sms;
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  /** Find the agent whose SMS config owns a phone number. */
  findAgentBySmsNumber(phoneNumber: string, provider?: SmsConfig['provider']): { agentId: string; config: SmsConfig } | null {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return null;

    const rows = this.db.prepare('SELECT id, metadata FROM agents').all() as { id: string; metadata: string }[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata || '{}');
        const cfg = meta.sms as SmsConfig | undefined;
        if (!cfg?.enabled) continue;
        if (provider && cfg.provider !== provider) continue;
        if (normalizePhoneNumber(cfg.phoneNumber) === normalized) {
          // Decrypt before returning so callers (e.g. the webhook secret
          // check) compare against the real plaintext, not ciphertext.
          return { agentId: row.id, config: this.decryptConfig(cfg) };
        }
      } catch {
        // Ignore malformed agent metadata.
      }
    }

    return null;
  }

  /** Record an inbound SMS (parsed from email or provider webhook) */
  recordInbound(agentId: string, parsed: ParsedSms, metadata?: Record<string, unknown>): SmsMessage {
    const id = `sms_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = parsed.timestamp || new Date().toISOString();

    this.db.prepare(
      'INSERT INTO sms_messages (id, agent_id, direction, phone_number, body, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, agentId, 'inbound', parsed.from, parsed.body, 'received', createdAt, JSON.stringify(metadata ?? {}));

    return { id, agentId, direction: 'inbound', phoneNumber: parsed.from, body: parsed.body, status: 'received', createdAt, metadata };
  }

  /** Record an outbound SMS attempt */
  recordOutbound(agentId: string, phoneNumber: string, body: string, status: 'pending' | 'sent' | 'failed' = 'pending', metadata?: Record<string, unknown>): SmsMessage {
    const id = `sms_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Normalize the target number
    const normalized = normalizePhoneNumber(phoneNumber) || phoneNumber;

    this.db.prepare(
      'INSERT INTO sms_messages (id, agent_id, direction, phone_number, body, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, agentId, 'outbound', normalized, body, status, now, JSON.stringify(metadata ?? {}));

    return { id, agentId, direction: 'outbound', phoneNumber: normalized, body, status, createdAt: now, metadata };
  }

  /** Update SMS status and optional provider metadata */
  updateStatus(id: string, status: SmsMessage['status'], metadata?: Record<string, unknown>): void {
    if (metadata) {
      this.db.prepare('UPDATE sms_messages SET status = ?, metadata = ? WHERE id = ?')
        .run(status, JSON.stringify(metadata), id);
      return;
    }

    this.db.prepare('UPDATE sms_messages SET status = ? WHERE id = ?').run(status, id);
  }

  /** List SMS messages for an agent */
  listMessages(agentId: string, opts?: { direction?: 'inbound' | 'outbound'; limit?: number; offset?: number }): SmsMessage[] {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);

    let query = 'SELECT * FROM sms_messages WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (opts?.direction && (opts.direction === 'inbound' || opts.direction === 'outbound')) {
      query += ' AND direction = ?';
      params.push(opts.direction);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return (this.db.prepare(query).all(...params) as any[]).map(row => ({
      id: row.id,
      agentId: row.agent_id,
      direction: row.direction,
      phoneNumber: row.phone_number,
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /** Check for recent verification codes in inbound SMS */
  checkForVerificationCode(agentId: string, minutesBack: number = 10): { code: string; from: string; body: string; receivedAt: string } | null {
    const safeMins = Math.min(Math.max(minutesBack, 1), 1440); // 1 min to 24 hours
    const cutoff = new Date(Date.now() - safeMins * 60 * 1000).toISOString();

    const messages = this.db.prepare(
      'SELECT * FROM sms_messages WHERE agent_id = ? AND direction = ? AND created_at > ? ORDER BY created_at DESC LIMIT 50'
    ).all(agentId, 'inbound', cutoff) as any[];

    for (const msg of messages) {
      const code = extractVerificationCode(msg.body);
      if (code) {
        return { code, from: msg.phone_number, body: msg.body, receivedAt: msg.created_at };
      }
    }

    return null;
  }
}

/**
 * SmsPoller — Polls for Google Voice SMS forwarded emails.
 *
 * Two modes:
 * 1. **Same email** (sameAsRelay=true): Hooks into the relay's onInboundMail callback.
 *    The relay poll already fetches emails; SmsPoller filters for GV forwarded SMS.
 * 2. **Separate email** (sameAsRelay=false): Runs its own IMAP poll against the GV Gmail
 *    using the separate credentials (forwardingEmail + forwardingPassword).
 *
 * Parsed SMS messages are stored in the sms_messages table.
 */
export class SmsPoller {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private lastSeenUid = 0;
  private firstPollDone = false;
  private consecutiveFailures = 0;
  private readonly POLL_INTERVAL_MS = 30_000;
  private readonly MAX_BACKOFF_MS = 5 * 60_000;
  private readonly CONNECT_TIMEOUT_MS = 30_000;

  /** Callback for new inbound SMS */
  onSmsReceived: ((agentId: string, sms: ParsedSms) => void | Promise<void>) | null = null;

  constructor(
    private smsManager: SmsManager,
    private agentId: string,
    private config: SmsConfig,
  ) {}

  /** Whether this poller needs its own IMAP connection (separate Gmail) */
  get needsSeparatePoll(): boolean {
    return !this.config.sameAsRelay && !!this.config.forwardingPassword;
  }

  /**
   * Process an email from the relay poll (same-email mode).
   * Called by the relay gateway's onInboundMail when it detects a GV email.
   * Returns true if the email was an SMS and was processed.
   */
  processRelayEmail(from: string, subject: string, body: string): boolean {
    const parsed = parseGoogleVoiceSms(body, from);
    if (!parsed) return false;

    // Record in SMS table
    this.smsManager.recordInbound(this.agentId, parsed);
    this.onSmsReceived?.(this.agentId, parsed);
    return true;
  }

  /**
   * Start polling the separate GV Gmail for SMS (separate-email mode).
   * Only call this if needsSeparatePoll is true.
   */
  async startPolling(): Promise<void> {
    if (!this.needsSeparatePoll) return;
    if (this.polling) return;
    this.polling = true;

    console.log(`[SmsPoller] Starting SMS poll for ${this.config.phoneNumber} via ${this.config.forwardingEmail}`);

    // Initial poll
    await this.pollOnce();

    // Schedule recurring
    this.scheduleNext();
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.polling) return;
    // Exponential backoff on failures
    const backoff = this.consecutiveFailures > 0
      ? Math.min(this.POLL_INTERVAL_MS * Math.pow(2, this.consecutiveFailures - 1), this.MAX_BACKOFF_MS)
      : this.POLL_INTERVAL_MS;
    this.pollTimer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNext();
    }, backoff);
  }

  private async pollOnce(): Promise<void> {
    if (!this.config.forwardingEmail || !this.config.forwardingPassword) return;

    // Dynamic import to avoid requiring imapflow at module load
    let ImapFlow: any;
    try {
      ImapFlow = (await import('imapflow')).ImapFlow;
    } catch {
      console.error('[SmsPoller] imapflow not available');
      return;
    }

    let simpleParser: any;
    try {
      simpleParser = (await import('mailparser')).simpleParser;
    } catch {
      console.error('[SmsPoller] mailparser not available');
      return;
    }

    const imap = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.config.forwardingEmail,
        pass: this.config.forwardingPassword,
      },
      logger: false,
      tls: { rejectUnauthorized: true },
    });

    const timeout = setTimeout(() => {
      try { imap.close(); } catch {}
    }, this.CONNECT_TIMEOUT_MS);

    try {
      await imap.connect();
      clearTimeout(timeout);

      const lock = await imap.getMailboxLock('INBOX');
      try {
        if (!this.firstPollDone) {
          const status = imap.mailbox;
          const uidNext = (status && typeof status === 'object' && 'uidNext' in status)
            ? (status as any).uidNext as number : 1;
          // On first poll, only look at last 20 messages to avoid re-processing old SMS
          this.lastSeenUid = Math.max(0, uidNext - 21);
          this.firstPollDone = true;
        }

        // Search for emails from Google Voice
        let searchResult: number[];
        try {
          searchResult = await imap.search(
            { from: 'voice-noreply@google.com', uid: `${this.lastSeenUid + 1}:*` as any },
            { uid: true } as any,
          ) as number[];
        } catch {
          // Fallback: search all new UIDs
          try {
            searchResult = await imap.search({ all: true }, { uid: true } as any) as number[];
            searchResult = searchResult.filter(uid => uid > this.lastSeenUid);
          } catch {
            return;
          }
        }

        if (!searchResult?.length) return;

        const uids = searchResult.filter(uid => uid > this.lastSeenUid);
        for (const uid of uids) {
          if (uid > this.lastSeenUid) this.lastSeenUid = uid;

          try {
            const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true } as any);
            const source = (msg as any)?.source as Buffer | undefined;
            if (!source) continue;

            const parsed = await simpleParser(source);
            const fromAddr = parsed.from?.value?.[0]?.address ?? '';
            const body = parsed.text || parsed.html || '';

            const sms = parseGoogleVoiceSms(body, fromAddr);
            if (sms) {
              this.smsManager.recordInbound(this.agentId, sms);
              this.onSmsReceived?.(this.agentId, sms);
            }
          } catch {
            // Skip individual message errors
          }
        }
      } finally {
        lock.release();
      }

      // Success
      if (this.consecutiveFailures > 0) {
        console.log(`[SmsPoller] Recovered after ${this.consecutiveFailures} failures`);
      }
      this.consecutiveFailures = 0;

      await imap.logout();
    } catch (err) {
      clearTimeout(timeout);
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SmsPoller] Poll failed (${this.consecutiveFailures}): ${msg}`);
      try { await imap.logout(); } catch {}
    }
  }
}
