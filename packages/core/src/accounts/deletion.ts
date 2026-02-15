import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AccountManager } from './manager.js';
import type { Agent } from './types.js';
import { MailReceiver } from '../mail/receiver.js';
import { parseEmail } from '../mail/parser.js';
import type { AgenticMailConfig } from '../config.js';

export interface ArchivedEmail {
  uid: number;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  text?: string;
  html?: string;
}

export interface DeletionReport {
  id: string;
  agent: {
    id: string;
    name: string;
    email: string;
    role: string;
    createdAt: string;
  };
  deletedAt: string;
  deletedBy: string;
  reason?: string;
  emails: {
    inbox: ArchivedEmail[];
    sent: ArchivedEmail[];
    other: Record<string, ArchivedEmail[]>;
  };
  summary: {
    totalEmails: number;
    inboxCount: number;
    sentCount: number;
    otherCount: number;
    folders: string[];
    firstEmailDate?: string;
    lastEmailDate?: string;
    topCorrespondents: { address: string; count: number }[];
  };
}

export interface DeletionSummary {
  id: string;
  agentName: string;
  agentEmail: string;
  agentRole: string | null;
  deletedAt: string;
  deletedBy: string | null;
  reason: string | null;
  emailCount: number;
  filePath: string | null;
}

export interface ArchiveAndDeleteOptions {
  deletedBy?: string;
  reason?: string;
}

export class AgentDeletionService {
  constructor(
    private db: Database.Database,
    private accountManager: AccountManager,
    private config: AgenticMailConfig,
  ) {}

  async archiveAndDelete(agentId: string, options?: ArchiveAndDeleteOptions): Promise<DeletionReport> {
    // Prevent deleting the last agent
    const allAgents = await this.accountManager.list();
    if (allAgents.length <= 1) {
      throw new Error('Cannot delete the last agent. At least one agent must remain.');
    }

    const agent = await this.accountManager.getById(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const password = (agent.metadata as Record<string, any>)?._password;
    if (!password) throw new Error(`Agent ${agent.name} has no stored password — cannot connect to IMAP`);

    // Archive all emails
    const emails = await this.archiveEmails(agent, password);

    // Build summary
    const summary = this.buildSummary(emails);

    const report: DeletionReport = {
      id: `del_${uuidv4()}`,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        createdAt: agent.createdAt,
      },
      deletedAt: new Date().toISOString(),
      deletedBy: options?.deletedBy ?? 'unknown',
      reason: options?.reason,
      emails,
      summary,
    };

    // Save to database
    const filePath = this.saveToFile(report);
    this.saveToDatabase(report, filePath);

    // Now delete the agent (Stalwart principal + DB row)
    await this.accountManager.delete(agentId);

    return report;
  }

  getReport(deletionId: string): DeletionReport | null {
    const stmt = this.db.prepare('SELECT * FROM agent_deletions WHERE id = ?');
    const row = stmt.get(deletionId) as any;
    if (!row) return null;

    try {
      return JSON.parse(row.report) as DeletionReport;
    } catch {
      return null;
    }
  }

  listReports(): DeletionSummary[] {
    const stmt = this.db.prepare(
      'SELECT id, agent_name, agent_email, agent_role, deleted_at, deleted_by, reason, email_count, file_path FROM agent_deletions ORDER BY deleted_at DESC',
    );
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      id: row.id,
      agentName: row.agent_name,
      agentEmail: row.agent_email,
      agentRole: row.agent_role,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      reason: row.reason,
      emailCount: row.email_count,
      filePath: row.file_path,
    }));
  }

  private async archiveEmails(
    agent: Agent,
    password: string,
  ): Promise<DeletionReport['emails']> {
    const result: DeletionReport['emails'] = {
      inbox: [],
      sent: [],
      other: {},
    };

    let receiver: MailReceiver | null = null;
    try {
      receiver = new MailReceiver({
        host: this.config.imap.host,
        port: this.config.imap.port,
        email: agent.stalwartPrincipal,
        password,
        secure: false,
      });
      await receiver.connect();

      const folders = await receiver.listFolders();

      for (const folder of folders) {
        // Skip non-selectable folders (like namespace roots)
        if (folder.flags.includes('\\Noselect')) continue;

        const archived = await this.archiveFolder(receiver, folder.path);
        if (archived.length === 0) continue;

        if (folder.path === 'INBOX') {
          result.inbox = archived;
        } else if (folder.specialUse === '\\Sent' || folder.path === 'Sent Items') {
          result.sent = archived;
        } else {
          result.other[folder.path] = archived;
        }
      }
    } catch (err) {
      // If IMAP connection fails, proceed with empty archive
      console.warn(`[deletion] Failed to archive emails for ${agent.name}: ${(err as Error).message}`);
    } finally {
      if (receiver) {
        try { await receiver.disconnect(); } catch { /* best effort */ }
      }
    }

    return result;
  }

  private async archiveFolder(receiver: MailReceiver, folder: string): Promise<ArchivedEmail[]> {
    const archived: ArchivedEmail[] = [];

    try {
      // List all envelopes (up to 10000 — practical limit)
      const envelopes = await receiver.listEnvelopes(folder, { limit: 10000 });

      for (const env of envelopes) {
        try {
          const raw = await receiver.fetchMessage(env.uid, folder);
          const parsed = await parseEmail(raw);

          archived.push({
            uid: env.uid,
            messageId: parsed.messageId || env.messageId,
            from: parsed.from?.[0]?.address ?? '',
            to: parsed.to?.map((a) => a.address) ?? [],
            subject: parsed.subject || env.subject,
            date: parsed.date?.toISOString() ?? env.date?.toISOString?.() ?? '',
            text: parsed.text,
            html: parsed.html,
          });
        } catch {
          // If individual message parse fails, use envelope data
          archived.push({
            uid: env.uid,
            messageId: env.messageId,
            from: env.from?.[0]?.address ?? '',
            to: env.to?.map((a) => a.address) ?? [],
            subject: env.subject,
            date: env.date?.toISOString?.() ?? '',
          });
        }
      }
    } catch (err) {
      console.warn(`[deletion] Failed to archive folder ${folder}: ${(err as Error).message}`);
    }

    return archived;
  }

  private buildSummary(emails: DeletionReport['emails']): DeletionReport['summary'] {
    const allEmails: ArchivedEmail[] = [
      ...emails.inbox,
      ...emails.sent,
      ...Object.values(emails.other).flat(),
    ];

    const correspondentCounts = new Map<string, number>();
    const allDates: string[] = [];

    for (const email of allEmails) {
      if (email.date) allDates.push(email.date);

      // Count correspondents from both from and to
      if (email.from) {
        correspondentCounts.set(email.from, (correspondentCounts.get(email.from) ?? 0) + 1);
      }
      for (const addr of email.to) {
        correspondentCounts.set(addr, (correspondentCounts.get(addr) ?? 0) + 1);
      }
    }

    allDates.sort();

    const otherCount = Object.values(emails.other).reduce((sum, arr) => sum + arr.length, 0);
    const folders = ['INBOX', 'Sent Items', ...Object.keys(emails.other)].filter(
      (f) => {
        if (f === 'INBOX') return emails.inbox.length > 0;
        if (f === 'Sent Items') return emails.sent.length > 0;
        return (emails.other[f]?.length ?? 0) > 0;
      },
    );

    const topCorrespondents = [...correspondentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, count]) => ({ address, count }));

    return {
      totalEmails: allEmails.length,
      inboxCount: emails.inbox.length,
      sentCount: emails.sent.length,
      otherCount,
      folders,
      firstEmailDate: allDates[0],
      lastEmailDate: allDates[allDates.length - 1],
      topCorrespondents,
    };
  }

  private saveToFile(report: DeletionReport): string {
    const dir = join(homedir(), '.agenticmail', 'deletions');
    mkdirSync(dir, { recursive: true });

    const timestamp = report.deletedAt.replace(/[:.]/g, '-');
    const filename = `${report.agent.name}_${timestamp}.json`;
    const filePath = join(dir, filename);

    writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return filePath;
  }

  private saveToDatabase(report: DeletionReport, filePath: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_deletions (id, agent_id, agent_name, agent_email, agent_role, agent_created_at, deleted_at, deleted_by, reason, email_count, report, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      report.id,
      report.agent.id,
      report.agent.name,
      report.agent.email,
      report.agent.role,
      report.agent.createdAt,
      report.deletedAt,
      report.deletedBy,
      report.reason ?? null,
      report.summary.totalEmails,
      JSON.stringify(report),
      filePath,
    );
  }
}
