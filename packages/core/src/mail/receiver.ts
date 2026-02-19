import { ImapFlow } from 'imapflow';
import type { EmailEnvelope, MailboxInfo, SearchCriteria } from './types.js';

export interface MailReceiverOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  secure?: boolean;
}

export class MailReceiver {
  private client: ImapFlow;
  private connected = false;

  constructor(private options: MailReceiverOptions) {
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

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;

    // Keep connected flag in sync with actual IMAP state
    this.client.on('close', () => { this.connected = false; });
    this.client.on('error', () => { this.connected = false; });
  }

  /** Check if the IMAP client is actually usable */
  get usable(): boolean {
    return this.connected && (this.client as any).usable !== false;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.logout();
    this.connected = false;
  }

  async getMailboxInfo(mailbox = 'INBOX'): Promise<MailboxInfo> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const status = this.client.mailbox;
      if (!status) {
        return { name: mailbox, exists: 0, recent: 0, unseen: 0 };
      }
      return {
        name: mailbox,
        exists: status.exists ?? 0,
        recent: (status as any).recent ?? 0,
        unseen: (status as any).unseen ?? 0,
      };
    } finally {
      lock.release();
    }
  }

  async listEnvelopes(mailbox = 'INBOX', options?: { limit?: number; offset?: number }): Promise<EmailEnvelope[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const envelopes: EmailEnvelope[] = [];
      const mb = this.client.mailbox;
      const total = mb ? (mb.exists ?? 0) : 0;
      if (total === 0) return envelopes;

      const limit = Math.min(Math.max(options?.limit ?? 20, 1), 1000);
      const offset = Math.max(options?.offset ?? 0, 0);

      // Early return if offset is beyond available messages
      if (offset >= total) return envelopes;

      // Use UID-based search + sort for stable pagination that isn't
      // affected by message deletions between pages.
      // Fetch ALL UIDs, sort descending (newest first), then slice for the page.
      const allUids = await this.client.search({ all: true }, { uid: true });
      if (!allUids || allUids.length === 0) return envelopes;

      // Sort UIDs descending (highest UID = newest message)
      const sortedUids = Array.from(allUids).sort((a, b) => b - a);

      // Apply offset and limit
      const pageUids = sortedUids.slice(offset, offset + limit);
      if (pageUids.length === 0) return envelopes;

      // Fetch metadata for the selected UIDs
      const uidRange = pageUids.join(',');
      for await (const msg of this.client.fetch(uidRange, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      })) {
        const env = msg.envelope;
        if (!env) continue;
        envelopes.push({
          uid: msg.uid,
          seq: msg.seq,
          messageId: env.messageId ?? '',
          subject: env.subject ?? '',
          from: (env.from ?? []).map((a: any) => ({
            name: a.name,
            address: a.address ?? '',
          })),
          to: (env.to ?? []).map((a: any) => ({
            name: a.name,
            address: a.address ?? '',
          })),
          date: env.date ?? new Date(),
          flags: msg.flags ?? new Set<string>(),
          size: msg.size ?? 0,
        });
      }

      // Sort by UID descending (newest first) since IMAP fetch order may vary
      envelopes.sort((a, b) => b.uid - a.uid);
      return envelopes;
    } finally {
      lock.release();
    }
  }

  async fetchMessage(uid: number, mailbox = 'INBOX'): Promise<Buffer> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const { content } = await this.client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally {
      lock.release();
    }
  }

  async search(criteria: SearchCriteria, mailbox = 'INBOX'): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const query: any = {};

      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;
      if (criteria.seen !== undefined) query.seen = criteria.seen;
      if (criteria.text) query.body = criteria.text;

      const results = await this.client.search(query, { uid: true });
      return Array.isArray(results) ? results : [];
    } finally {
      lock.release();
    }
  }

  async markSeen(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteMessage(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Mark a message as unseen (unread) */
  async markUnseen(uid: number, mailbox = 'INBOX'): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Move a message to another folder */
  async moveMessage(uid: number, fromMailbox: string, toMailbox: string): Promise<void> {
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      await this.client.messageMove(String(uid), toMailbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  /** List all IMAP folders/mailboxes */
  async listFolders(): Promise<FolderInfo[]> {
    const list = await this.client.list();
    return list.map((mb: any) => ({
      path: mb.path,
      name: mb.name,
      specialUse: mb.specialUse ?? undefined,
      flags: mb.flags ? [...mb.flags] : [],
    }));
  }

  /** Create a new IMAP folder */
  async createFolder(path: string): Promise<void> {
    await this.client.mailboxCreate(path);
  }

  /** Batch mark multiple messages as seen */
  async batchMarkSeen(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch mark multiple messages as unseen */
  async batchMarkUnseen(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch delete multiple messages */
  async batchDelete(uids: number[], mailbox = 'INBOX'): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageDelete(uids.join(','), { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Batch fetch raw message content for multiple UIDs */
  async batchFetch(uids: number[], mailbox = 'INBOX'): Promise<Map<number, Buffer>> {
    if (uids.length === 0) return new Map();
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results = new Map<number, Buffer>();
      for await (const msg of this.client.fetch(uids.join(','), { source: true, uid: true })) {
        if (msg.source) {
          results.set(msg.uid, Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source as any));
        }
      }
      return results;
    } finally {
      lock.release();
    }
  }

  /** Batch move multiple messages to another folder */
  async batchMove(uids: number[], fromMailbox: string, toMailbox: string): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      await this.client.messageMove(uids.join(','), toMailbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  /** Append a raw RFC822 message to a mailbox (e.g. "Sent") with given flags */
  async appendMessage(raw: Buffer, mailbox: string, flags?: string[]): Promise<void> {
    await this.client.append(mailbox, raw, flags ?? ['\\Seen'], new Date());
  }

  getImapClient(): ImapFlow {
    return this.client;
  }
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  flags: string[];
}
