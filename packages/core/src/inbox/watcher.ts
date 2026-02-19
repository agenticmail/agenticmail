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
  /** Enable automatic reconnect with exponential backoff on disconnect (default: false) */
  autoReconnect?: boolean;
  /** Max reconnect attempts before giving up (default: Infinity) */
  maxReconnectAttempts?: number;
}

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_FACTOR = 2;

export class InboxWatcher extends EventEmitter {
  private client: ImapFlow;
  private watching = false;
  private mailbox: string;
  private autoFetch: boolean;
  private _lock: any = null;
  private _stopped = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = RECONNECT_INITIAL_MS;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts: number;
  private _autoReconnect: boolean;

  constructor(
    private options: InboxWatcherOptions,
    watcherOptions?: WatcherOptions,
  ) {
    super();
    this.mailbox = watcherOptions?.mailbox ?? 'INBOX';
    this.autoFetch = watcherOptions?.autoFetch ?? true;
    this._autoReconnect = options.autoReconnect ?? false;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;

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
    this._stopped = false;

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
      this._reconnectDelay = RECONNECT_INITIAL_MS;
      this._reconnectAttempts = 0;

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
        this._scheduleReconnect();
      });

      // Lock is intentionally held to receive IDLE notifications
      this._lock = lock;
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  /** Schedule a reconnect attempt with exponential backoff */
  private _scheduleReconnect(): void {
    if (this._stopped || !this._autoReconnect) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.emit('reconnect_failed', { attempts: this._reconnectAttempts });
      return;
    }

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
    this._reconnectAttempts++;

    this.emit('reconnecting', { attempt: this._reconnectAttempts, delayMs: delay });

    this._reconnectTimer = setTimeout(async () => {
      if (this._stopped) return;
      try {
        // Clean up old client listeners before reconnecting
        this.client.removeAllListeners();
        if (this._lock) {
          try { this._lock.release(); } catch { /* ignore */ }
          this._lock = null;
        }
        await this.start();
        this.emit('reconnected', { attempt: this._reconnectAttempts });
      } catch (err) {
        this.emit('error', err);
        this._scheduleReconnect();
      }
    }, delay);
  }

  async stop(): Promise<void> {
    if (!this.watching && !this._reconnectTimer) return;
    this._stopped = true;
    this.watching = false;

    // Cancel pending reconnect
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

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
