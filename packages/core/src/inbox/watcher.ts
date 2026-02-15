import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { parseEmail } from '../mail/parser.js';
import type { InboxEvent, WatcherOptions } from './types.js';

export interface InboxWatcherOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  secure?: boolean;
}

export class InboxWatcher extends EventEmitter {
  private client: ImapFlow;
  private watching = false;
  private mailbox: string;
  private autoFetch: boolean;
  private _lock: any = null;

  constructor(
    private options: InboxWatcherOptions,
    watcherOptions?: WatcherOptions,
  ) {
    super();
    this.mailbox = watcherOptions?.mailbox ?? 'INBOX';
    this.autoFetch = watcherOptions?.autoFetch ?? true;

    this.client = new ImapFlow({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      auth: {
        user: options.email,
        pass: options.password,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async start(): Promise<void> {
    if (this.watching) return;

    // Create a fresh IMAP client each time (clients cannot be reused after logout)
    this.client = new ImapFlow({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure ?? false,
      auth: {
        user: this.options.email,
        pass: this.options.password,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    });

    await this.client.connect();
    const lock = await this.client.getMailboxLock(this.mailbox);

    try {
      this.watching = true;

      this.client.on('exists', async (data) => {
        try {
          if (data.count > data.prevCount) {
            const newCount = data.count - data.prevCount;
            const start = data.count - newCount + 1;

            if (this.autoFetch) {
              for await (const msg of this.client.fetch(`${start}:${data.count}`, {
                uid: true,
                source: true,
              })) {
                if (msg.source) {
                  const parsed = await parseEmail(msg.source);
                  this.emit('new', { type: 'new' as const, uid: msg.uid, message: parsed });
                } else {
                  this.emit('new', { type: 'new' as const, uid: msg.uid });
                }
              }
            } else {
              this.emit('new', { type: 'new' as const, uid: 0 });
            }
          }
        } catch (err) {
          this.emit('error', err);
        }
      });

      this.client.on('expunge', (data) => {
        this.emit('expunge', { type: 'expunge' as const, seq: data.seq });
      });

      this.client.on('flags', (data) => {
        this.emit('flags', { type: 'flags' as const, uid: data.uid, flags: data.flags });
      });

      this.client.on('error', (err) => {
        this.emit('error', err);
      });

      this.client.on('close', () => {
        this.watching = false;
        this.emit('close');
      });

      // Lock is intentionally held to receive IDLE notifications
      this._lock = lock;
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.watching) return;
    this.watching = false;

    // Remove IMAP client listeners to prevent accumulation on restart
    this.client.removeAllListeners();

    if (this._lock) {
      try { this._lock.release(); } catch { /* ignore */ }
      this._lock = null;
    }

    try {
      await this.client.logout();
    } catch {
      // Ignore logout errors
    }
  }

  isWatching(): boolean {
    return this.watching;
  }
}
