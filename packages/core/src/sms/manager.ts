/**
 * SMS Manager - Google Voice SMS integration
 *
 * How it works:
 * 1. User sets up Google Voice with SMS-to-email forwarding
 * 2. Incoming SMS arrives at Google Voice -> forwarded to email -> lands in agent inbox
 * 3. Agent parses forwarded SMS from email body
 * 4. Outgoing SMS sent via Google Voice web interface (browser automation)
 *
 * SMS config is stored in agent metadata under the "sms" key.
 */

import type { Database } from 'better-sqlite3';

export interface SmsConfig {
  /** Whether SMS is enabled for this agent */
  enabled: boolean;
  /** Google Voice phone number (e.g. +12125551234) */
  phoneNumber: string;
  /** The email address Google Voice forwards SMS to (the Gmail used for GV signup) */
  forwardingEmail: string;
  /** App password for forwarding email (only needed if different from relay email) */
  forwardingPassword?: string;
  /** Whether the GV Gmail is the same as the relay email */
  sameAsRelay?: boolean;
  /** Provider (currently only google_voice) */
  provider: 'google_voice';
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
  const isGoogleVoice =
    fromLower.includes('voice-noreply@google.com') ||
    fromLower.includes('@txt.voice.google.com') ||
    fromLower.includes('voice.google.com') ||
    fromLower.includes('google.com/voice') ||
    (fromLower.includes('google') && fromLower.includes('voice'));

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

export class SmsManager {
  private initialized = false;

  constructor(private db: Database) {
    this.ensureTable();
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

  /** Get SMS config from agent metadata */
  getSmsConfig(agentId: string): SmsConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) return null;
    try {
      const meta = JSON.parse(row.metadata || '{}');
      return meta.sms && meta.sms.enabled !== undefined ? meta.sms : null;
    } catch {
      return null;
    }
  }

  /** Save SMS config to agent metadata */
  saveSmsConfig(agentId: string, config: SmsConfig): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata || '{}');
    } catch {
      meta = {};
    }
    meta.sms = config;
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
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

  /** Record an inbound SMS (parsed from email) */
  recordInbound(agentId: string, parsed: ParsedSms): SmsMessage {
    const id = `sms_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = parsed.timestamp || new Date().toISOString();

    this.db.prepare(
      'INSERT INTO sms_messages (id, agent_id, direction, phone_number, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, agentId, 'inbound', parsed.from, parsed.body, 'received', createdAt);

    return { id, agentId, direction: 'inbound', phoneNumber: parsed.from, body: parsed.body, status: 'received', createdAt };
  }

  /** Record an outbound SMS attempt */
  recordOutbound(agentId: string, phoneNumber: string, body: string, status: 'pending' | 'sent' | 'failed' = 'pending'): SmsMessage {
    const id = `sms_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Normalize the target number
    const normalized = normalizePhoneNumber(phoneNumber) || phoneNumber;

    this.db.prepare(
      'INSERT INTO sms_messages (id, agent_id, direction, phone_number, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, agentId, 'outbound', normalized, body, status, now);

    return { id, agentId, direction: 'outbound', phoneNumber: normalized, body, status, createdAt: now };
  }

  /** Update SMS status */
  updateStatus(id: string, status: SmsMessage['status']): void {
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
