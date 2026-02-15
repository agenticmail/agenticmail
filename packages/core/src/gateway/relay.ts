import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Transporter } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import type { RelayConfig } from './types.js';
import type { SendMailOptions, SendResult } from '../mail/types.js';
import type { SendResultWithRaw } from '../mail/sender.js';
import { debug } from '../debug.js';

export interface RelayGatewayOptions {
  onInboundMail?: (agentName: string, parsed: InboundEmail) => void | Promise<void>;
  /** Fallback agent name for emails without sub-addressing */
  defaultAgentName?: string;
}

export interface InboundEmail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentType: string;
    size: number;
    content: Buffer;
  }>;
}

/**
 * RelayGateway handles sending/receiving email through an existing
 * Gmail/Outlook account using sub-addressing (user+agent@gmail.com).
 */
export class RelayGateway {
  private smtpTransport: Transporter | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private config: RelayConfig | null = null;
  private onInboundMail: RelayGatewayOptions['onInboundMail'];
  private defaultAgentName: string | null;
  private _pollInProgress = false;

  /** Track highest UID seen so we only process new messages after first poll */
  private lastSeenUid = 0;
  private firstPollDone = false;

  /** Callback invoked when lastSeenUid advances (for persistence) */
  onUidAdvance: ((uid: number) => void) | null = null;

  /** Map sent messageId → agentName for In-Reply-To based routing */
  private sentMessageIds = new Map<string, string>();

  /** Robustness: consecutive failure tracking + backoff */
  private consecutiveFailures = 0;
  private pollIntervalMs = 30_000;
  private readonly MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes max
  private readonly CONNECT_TIMEOUT_MS = 30_000;  // 30s connection timeout

  constructor(options?: RelayGatewayOptions) {
    this.onInboundMail = options?.onInboundMail;
    this.defaultAgentName = options?.defaultAgentName ?? null;
  }

  async setup(config: RelayConfig): Promise<void> {
    if (!config.email || !config.email.includes('@')) {
      throw new Error('Invalid relay email address: must contain @');
    }

    // Close existing transport if re-configuring
    if (this.smtpTransport) {
      try { this.smtpTransport.close(); } catch { /* ignore */ }
      this.smtpTransport = null;
    }

    this.config = config;
    this.lastSeenUid = 0;
    this.firstPollDone = false;

    // Validate SMTP connection
    this.smtpTransport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: config.email,
        pass: config.password,
      },
    });

    await this.smtpTransport.verify();

    // Validate IMAP connection
    const imap = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapPort === 993,
      auth: {
        user: config.email,
        pass: config.password,
      },
      logger: false,
    });

    await imap.connect();
    await imap.logout();
  }

  /**
   * Send an email through the relay SMTP server.
   * Rewrites the From address to use sub-addressing: relay+agentName@gmail.com
   */
  async sendViaRelay(agentName: string, mail: SendMailOptions): Promise<SendResultWithRaw> {
    if (!this.config || !this.smtpTransport) {
      throw new Error('Relay not configured. Call setup() first.');
    }

    const atIdx = this.config.email.lastIndexOf('@');
    const localPart = this.config.email.slice(0, atIdx);
    const domain = this.config.email.slice(atIdx + 1);
    const relayFrom = `${localPart}+${agentName}@${domain}`;

    const displayName = mail.fromName || agentName;
    const mailOpts: any = {
      from: `${displayName} <${relayFrom}>`,
      to: Array.isArray(mail.to) ? mail.to.join(', ') : mail.to,
      cc: mail.cc ? (Array.isArray(mail.cc) ? mail.cc.join(', ') : mail.cc) : undefined,
      bcc: mail.bcc ? (Array.isArray(mail.bcc) ? mail.bcc.join(', ') : mail.bcc) : undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      replyTo: relayFrom,
      inReplyTo: mail.inReplyTo,
      references: mail.references?.join(' '),
      headers: mail.headers,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        encoding: a.encoding,
      })),
    };

    // Build raw RFC822 message for Sent folder copy
    const composer = new MailComposer(mailOpts);
    const raw = await composer.compile().build();

    const result = await this.smtpTransport.sendMail(mailOpts);

    // Track sent messageId for In-Reply-To based routing of replies
    if (result.messageId) {
      this.sentMessageIds.set(result.messageId, agentName);
      // Cap stored IDs at 10000 to prevent unbounded growth
      if (this.sentMessageIds.size > 10000) {
        const firstKey = this.sentMessageIds.keys().next().value;
        if (firstKey) this.sentMessageIds.delete(firstKey);
      }
    }

    return {
      messageId: result.messageId,
      envelope: {
        from: relayFrom,
        to: Array.isArray(result.envelope.to) ? result.envelope.to : [result.envelope.to as string],
      },
      raw,
    };
  }

  /**
   * Start polling the relay IMAP account for new emails.
   * Routes inbound mail to the correct agent based on sub-addressing or In-Reply-To.
   *
   * Robust design:
   * - Uses setTimeout (not setInterval) so backoff works naturally
   * - Exponential backoff on consecutive failures (30s → 1m → 2m → 5m cap)
   * - Always reschedules — polling never permanently stops
   * - Connection timeout prevents hung connections
   * - Detailed failure logging with recovery info
   */
  async startPolling(intervalMs = 30_000): Promise<void> {
    if (this.polling) return;
    if (!this.config) throw new Error('Relay not configured. Call setup() first.');

    this.polling = true;
    this.pollIntervalMs = intervalMs;
    this.consecutiveFailures = 0;

    // Do first poll immediately
    await this.pollOnce();

    // Schedule next poll
    this.scheduleNextPoll();
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Calculate next poll delay with exponential backoff on failures */
  private getNextPollDelay(): number {
    if (this.consecutiveFailures === 0) return this.pollIntervalMs;
    // Exponential backoff: interval * 2^(failures-1), capped at MAX_BACKOFF_MS
    const backoff = Math.min(
      this.pollIntervalMs * Math.pow(2, this.consecutiveFailures - 1),
      this.MAX_BACKOFF_MS,
    );
    return backoff;
  }

  /** Schedule the next poll with appropriate delay */
  private scheduleNextPoll(): void {
    if (!this.polling) return;
    const delay = this.getNextPollDelay();
    if (this.consecutiveFailures > 0) {
      console.log(`[RelayGateway] Next poll in ${Math.round(delay / 1000)}s (${this.consecutiveFailures} consecutive failure${this.consecutiveFailures !== 1 ? 's' : ''})`);
    }
    this.pollTimer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNextPoll();
    }, delay);
  }

  private async pollOnce(): Promise<void> {
    if (!this.config || !this.onInboundMail) return;
    if (this._pollInProgress) return;
    this._pollInProgress = true;
    try {
      await this._doPoll();
      // Success — reset failure counter
      if (this.consecutiveFailures > 0) {
        console.log(`[RelayGateway] Poll recovered after ${this.consecutiveFailures} failure${this.consecutiveFailures !== 1 ? 's' : ''}`);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RelayGateway] Poll failed (attempt ${this.consecutiveFailures}): ${msg}`);
      if (this.consecutiveFailures >= 5 && this.consecutiveFailures % 5 === 0) {
        console.error(`[RelayGateway] ${this.consecutiveFailures} consecutive failures — check IMAP credentials and connectivity (${this.config?.imapHost}:${this.config?.imapPort})`);
      }
    } finally {
      this._pollInProgress = false;
    }
  }

  private async _doPoll(): Promise<void> {
    if (!this.config || !this.onInboundMail) return;

    const imap = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapPort === 993,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
      tls: { rejectUnauthorized: true },
    });

    // Connection timeout — prevents hung connections from blocking polling forever
    const timeoutTimer = setTimeout(() => {
      try { imap.close(); } catch { /* ignore */ }
    }, this.CONNECT_TIMEOUT_MS);

    try {
      await imap.connect();
      clearTimeout(timeoutTimer);

      let lock;
      try {
        lock = await imap.getMailboxLock('INBOX');
      } catch (lockErr) {
        try { await imap.logout(); } catch { /* ignore */ }
        throw new Error(`Could not lock INBOX: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`);
      }

      try {
        if (!this.firstPollDone) {
          const status = imap.mailbox;
          const uidNext = (status && typeof status === 'object' && 'uidNext' in status)
            ? (status as any).uidNext as number
            : 1;
          this.lastSeenUid = Math.max(0, uidNext - 51);
          this.firstPollDone = true;
          debug('RelayGateway', `First poll: scanning recent messages (UID ${this.lastSeenUid + 1}+, uidNext=${uidNext})`);
        }

        // Search for ALL messages returning UIDs (not sequence numbers)
        // Gmail auto-marks self-sent replies as read, so we search all, not just unseen
        let searchResult: number[];
        try {
          searchResult = await imap.search({ all: true }, { uid: true } as any) as number[];
        } catch (searchErr) {
          console.error('[RelayGateway] IMAP search failed:', searchErr instanceof Error ? searchErr.message : searchErr);
          return; // Don't throw — let polling continue with next cycle
        }

        if (!searchResult || !Array.isArray(searchResult) || searchResult.length === 0) {
          return;
        }

        // Filter to only new messages (UID > lastSeenUid)
        const uids = searchResult.filter(uid => uid > this.lastSeenUid);
        if (uids.length === 0) return;

        for (const uid of uids) {
          // Always advance lastSeenUid regardless of success/failure
          // so we never get stuck reprocessing the same message
          if (uid > this.lastSeenUid) {
            this.lastSeenUid = uid;
            this.onUidAdvance?.(uid);
          }

          try {
            const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true } as any);
            if (!msg) continue;
            const source = (msg as any).source as Buffer | undefined;
            if (!source) continue;

            let parsed;
            try {
              parsed = await simpleParser(source);
            } catch {
              continue;
            }

            // Skip emails sent FROM our relay (outbound messages / sent copies)
            const fromAddr = parsed.from?.value?.[0]?.address ?? '';
            if (this.isOurRelaySender(fromAddr)) continue;

            // Extract agent name using multiple strategies
            const toField = parsed.to;
            const toObj = Array.isArray(toField) ? toField[0] : toField;
            const agentName = this.extractAgentName(toObj, parsed) ?? this.defaultAgentName;

            if (!agentName) continue;

            const inbound: InboundEmail = {
              messageId: parsed.messageId ?? '',
              from: fromAddr,
              to: toObj?.value?.[0]?.address ?? '',
              subject: parsed.subject ?? '',
              text: parsed.text,
              html: parsed.html || undefined,
              date: parsed.date ?? new Date(),
              inReplyTo: parsed.inReplyTo,
              references: parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : undefined,
              attachments: parsed.attachments?.length ? parsed.attachments.map(a => ({
                filename: a.filename ?? 'unnamed',
                contentType: a.contentType,
                size: a.size,
                content: a.content,
              })) : undefined,
            };

            try {
              await this.onInboundMail(agentName, inbound);
              await imap.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true } as any);
              debug('RelayGateway', `Processed and marked seen: UID ${uid} → agent "${agentName}"`);
            } catch (err) {
              console.error(`[RelayGateway] Error delivering UID ${uid} to agent "${agentName}": ${(err as Error).message}`);
            }
          } catch (fetchErr) {
            console.error(`[RelayGateway] Error fetching UID ${uid}: ${(fetchErr as Error).message}`);
          }
        }
      } finally {
        try { lock.release(); } catch { /* ignore */ }
      }

      try { await imap.logout(); } catch { /* ignore */ }
    } catch (err) {
      clearTimeout(timeoutTimer);
      try { await imap.logout(); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Check if an email address is one of our relay sender addresses (user+agent@domain).
   */
  private isOurRelaySender(address: string): boolean {
    if (!this.config) return false;
    const atIdx = this.config.email.lastIndexOf('@');
    const localPart = this.config.email.slice(0, atIdx);
    const domain = this.config.email.slice(atIdx + 1);
    // Check if address matches our relay pattern: localPart+something@domain
    const pattern = new RegExp(`^${escapeRegex(localPart)}\\+[^@]+@${escapeRegex(domain)}$`, 'i');
    return pattern.test(address);
  }

  /**
   * Extract agent name from email using multiple strategies:
   * 1. Sub-address in To/CC/Delivered-To/X-Original-To headers
   * 2. In-Reply-To matching against sent message IDs
   * 3. References chain matching against sent message IDs
   */
  private extractAgentName(to: AddressObject | undefined, parsed: any): string | null {
    // Strategy 1: Check sub-addressing in all relevant address headers
    const allAddresses: string[] = [];

    // To addresses
    if (to?.value) {
      for (const addr of to.value) {
        if (addr.address) allAddresses.push(addr.address);
      }
    }

    // CC addresses
    const cc = parsed.cc;
    if (cc) {
      const ccObj = Array.isArray(cc) ? cc : [cc];
      for (const obj of ccObj) {
        if (obj?.value) {
          for (const addr of obj.value) {
            if (addr.address) allAddresses.push(addr.address);
          }
        }
      }
    }

    // Delivered-To header (Gmail preserves sub-address here for external senders)
    const headers = parsed.headers;
    const deliveredTo = headers?.get?.('delivered-to');
    if (deliveredTo) {
      allAddresses.push(typeof deliveredTo === 'string' ? deliveredTo : String(deliveredTo));
    }

    // X-Original-To header
    const xOrigTo = headers?.get?.('x-original-to');
    if (xOrigTo) {
      allAddresses.push(typeof xOrigTo === 'string' ? xOrigTo : String(xOrigTo));
    }

    // Check all addresses for sub-addressing pattern
    for (const addr of allAddresses) {
      const match = addr.match(/^([^+]+)\+([^@]+)@/);
      if (match && this.config) {
        const atIdx = this.config.email.lastIndexOf('@');
        const localPart = this.config.email.slice(0, atIdx);
        if (match[1].toLowerCase() === localPart.toLowerCase()) {
          return match[2];
        }
      }
    }

    // Strategy 2: Check In-Reply-To against sent message IDs
    const inReplyTo = parsed.inReplyTo;
    if (inReplyTo && this.sentMessageIds.has(inReplyTo)) {
      return this.sentMessageIds.get(inReplyTo)!;
    }

    // Strategy 3: Check References chain against sent message IDs (most recent first)
    const refs = parsed.references;
    if (refs) {
      const refList = Array.isArray(refs) ? refs : [refs];
      // Check from most recent to oldest
      for (let i = refList.length - 1; i >= 0; i--) {
        if (this.sentMessageIds.has(refList[i])) {
          return this.sentMessageIds.get(refList[i])!;
        }
      }
    }

    return null;
  }

  /**
   * Register a sent message ID for reply tracking.
   * Called externally when messages are sent via relay from GatewayManager.
   */
  trackSentMessage(messageId: string, agentName: string): void {
    this.sentMessageIds.set(messageId, agentName);
    if (this.sentMessageIds.size > 10000) {
      const firstKey = this.sentMessageIds.keys().next().value;
      if (firstKey) this.sentMessageIds.delete(firstKey);
    }
  }

  /**
   * Restore lastSeenUid from persistent storage (used on resume after restart).
   * If the restored UID is > 0, also marks firstPollDone to skip the initial window scan.
   */
  setLastSeenUid(uid: number): void {
    this.lastSeenUid = uid;
    if (uid > 0) this.firstPollDone = true;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  isPolling(): boolean {
    return this.polling;
  }

  getConfig(): RelayConfig | null {
    return this.config;
  }

  /**
   * Search the relay IMAP account (Gmail/Outlook) for emails matching criteria.
   * Returns parsed envelope data so results can be merged with local search.
   */
  async searchRelay(criteria: {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    since?: Date;
    before?: Date;
    seen?: boolean;
  }, maxResults = 50): Promise<RelaySearchResult[]> {
    if (!this.config) throw new Error('Relay not configured');

    const imap = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapPort === 993,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
    });

    const connectTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('IMAP search connection timed out')), this.CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([imap.connect(), connectTimeout]);
      const lock = await imap.getMailboxLock('INBOX');

      try {
        const query: any = {};
        if (criteria.from) query.from = criteria.from;
        if (criteria.to) query.to = criteria.to;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.text) query.body = criteria.text;
        if (criteria.since) query.since = criteria.since;
        if (criteria.before) query.before = criteria.before;
        if (criteria.seen !== undefined) query.seen = criteria.seen;

        // If no criteria given, don't return everything
        if (Object.keys(query).length === 0) return [];

        const uids = await imap.search(query, { uid: true } as any) as number[];
        if (!uids?.length) return [];

        // Fetch envelopes for the most recent results (limit to maxResults)
        const recentUids = uids.slice(-maxResults);
        const results: RelaySearchResult[] = [];

        for (const uid of recentUids) {
          try {
            const msg = await imap.fetchOne(String(uid), {
              uid: true,
              envelope: true,
              flags: true,
            }, { uid: true } as any);

            if (!msg) continue;
            const envelope = (msg as any).envelope;
            if (!envelope) continue;
            results.push({
              uid,
              source: 'relay',
              account: this.config!.email,
              messageId: envelope.messageId ?? '',
              subject: envelope.subject ?? '',
              from: (envelope.from ?? []).map((a: any) => ({ name: a.name, address: a.address ?? '' })),
              to: (envelope.to ?? []).map((a: any) => ({ name: a.name, address: a.address ?? '' })),
              date: envelope.date ?? new Date(),
              flags: (msg as any).flags ? [...(msg as any).flags] : [],
            });
          } catch {
            // Skip individual message fetch errors
          }
        }

        return results.reverse(); // newest first
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error('[RelayGateway] Relay search failed:', err instanceof Error ? err.message : err);
      return []; // Return empty on failure rather than crashing
    } finally {
      try { await imap.logout(); } catch { /* ignore */ }
    }
  }

  /**
   * Fetch a full email from the relay account by UID and return it as an InboundEmail.
   * Used to import a specific email from Gmail/Outlook into the local inbox.
   */
  async fetchRelayMessage(uid: number): Promise<InboundEmail | null> {
    if (!this.config) throw new Error('Relay not configured');

    const imap = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapPort === 993,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
    });

    const connectTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('IMAP fetch connection timed out')), this.CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([imap.connect(), connectTimeout]);
      const lock = await imap.getMailboxLock('INBOX');

      try {
        const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true } as any);
        if (!msg) return null;
        const source = (msg as any).source as Buffer | undefined;
        if (!source) return null;

        const parsed = await simpleParser(source);

        return {
          messageId: parsed.messageId ?? '',
          from: parsed.from?.value?.[0]?.address ?? '',
          to: (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [])
            .flatMap(t => t.value).map(a => a.address ?? '').filter(Boolean).join(', '),
          subject: parsed.subject ?? '',
          text: parsed.text,
          html: parsed.html || undefined,
          date: parsed.date ?? new Date(),
          inReplyTo: parsed.inReplyTo,
          references: parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
            : undefined,
          attachments: parsed.attachments?.length ? parsed.attachments.map(a => ({
            filename: a.filename ?? 'unnamed',
            contentType: a.contentType,
            size: a.size,
            content: a.content,
          })) : undefined,
        };
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error('[RelayGateway] Fetch relay message failed:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      try { await imap.logout(); } catch { /* ignore */ }
    }
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    if (this.smtpTransport) {
      this.smtpTransport.close();
      this.smtpTransport = null;
    }
  }
}

export interface RelaySearchResult {
  uid: number;
  source: 'relay';
  account: string;
  messageId: string;
  subject: string;
  from: Array<{ name?: string; address: string }>;
  to: Array<{ name?: string; address: string }>;
  date: Date;
  flags: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
