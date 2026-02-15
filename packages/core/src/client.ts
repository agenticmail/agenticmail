import { MailSender, type MailSenderOptions } from './mail/sender.js';
import { MailReceiver, type MailReceiverOptions } from './mail/receiver.js';
import { InboxWatcher, type InboxWatcherOptions } from './inbox/watcher.js';
import { parseEmail } from './mail/parser.js';
import type { SendMailOptions, SendResult, EmailEnvelope, ParsedEmail, SearchCriteria } from './mail/types.js';
import type { WatcherOptions } from './inbox/types.js';

export interface AgenticMailClientOptions {
  agentId: string;
  apiKey: string;
  email?: string;
  password?: string;
  smtp?: { host: string; port: number };
  imap?: { host: string; port: number };
  apiUrl?: string;
}

export class AgenticMailClient {
  private sender: MailSender | null = null;
  private receiver: MailReceiver | null = null;
  private options: AgenticMailClientOptions;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(options: AgenticMailClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  private async _connect(): Promise<void> {
    if (this.connected) return;

    // If email/password are provided, connect directly via SMTP/IMAP
    if (this.options.email && this.options.password) {
      this.sender = new MailSender({
        host: this.options.smtp?.host ?? 'localhost',
        port: this.options.smtp?.port ?? 587,
        email: this.options.email,
        password: this.options.password,
      });

      this.receiver = new MailReceiver({
        host: this.options.imap?.host ?? 'localhost',
        port: this.options.imap?.port ?? 143,
        email: this.options.email,
        password: this.options.password,
      });

      try {
        await this.receiver.connect();
      } catch (err) {
        this.sender.close();
        this.sender = null;
        this.receiver = null;
        throw err;
      }
      this.connected = true;
      return;
    }

    // Otherwise, use the API to get credentials
    if (this.options.apiUrl) {
      const res = await fetch(`${this.options.apiUrl}/api/agenticmail/accounts/me`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Failed to get account info: ${res.status}`);
      const data = (await res.json()) as any;

      if (!data.email || !data.password) {
        throw new Error('API returned incomplete account credentials (missing email or password)');
      }

      this.sender = new MailSender({
        host: data.smtp?.host ?? 'localhost',
        port: data.smtp?.port ?? 587,
        email: data.email,
        password: data.password,
      });

      this.receiver = new MailReceiver({
        host: data.imap?.host ?? 'localhost',
        port: data.imap?.port ?? 143,
        email: data.email,
        password: data.password,
      });

      try {
        await this.receiver.connect();
      } catch (err) {
        this.sender.close();
        this.sender = null;
        this.receiver = null;
        throw err;
      }
      this.connected = true;
      return;
    }

    throw new Error('Either email+password or apiUrl must be provided');
  }

  async disconnect(): Promise<void> {
    try {
      if (this.sender) {
        this.sender.close();
      }
    } catch { /* ignore */ }
    this.sender = null;

    try {
      if (this.receiver) {
        await this.receiver.disconnect();
      }
    } catch { /* ignore */ }
    this.receiver = null;

    this.connected = false;
  }

  async send(mail: SendMailOptions): Promise<SendResult> {
    if (!this.sender) throw new Error('Not connected. Call connect() first.');
    return this.sender.send(mail);
  }

  async inbox(options?: { limit?: number; offset?: number }): Promise<EmailEnvelope[]> {
    if (!this.receiver) throw new Error('Not connected. Call connect() first.');
    return this.receiver.listEnvelopes('INBOX', options);
  }

  async read(uid: number): Promise<ParsedEmail> {
    if (!this.receiver) throw new Error('Not connected. Call connect() first.');
    const raw = await this.receiver.fetchMessage(uid);
    return parseEmail(raw);
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    if (!this.receiver) throw new Error('Not connected. Call connect() first.');
    return this.receiver.search(criteria);
  }

  async markSeen(uid: number): Promise<void> {
    if (!this.receiver) throw new Error('Not connected. Call connect() first.');
    return this.receiver.markSeen(uid);
  }

  async deleteMessage(uid: number): Promise<void> {
    if (!this.receiver) throw new Error('Not connected. Call connect() first.');
    return this.receiver.deleteMessage(uid);
  }

  watch(options?: WatcherOptions): InboxWatcher {
    if (!this.options.email || !this.options.password) {
      throw new Error('Direct SMTP/IMAP credentials required for watching');
    }

    return new InboxWatcher(
      {
        host: this.options.imap?.host ?? 'localhost',
        port: this.options.imap?.port ?? 143,
        email: this.options.email,
        password: this.options.password,
      },
      options,
    );
  }
}
