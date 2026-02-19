import type Database from 'better-sqlite3';

export interface SearchableEmail {
  agentId: string;
  messageId: string;
  subject: string;
  fromAddress: string;
  toAddress: string;
  bodyText: string;
  receivedAt: string;
}

export class EmailSearchIndex {
  constructor(private db: Database.Database) {}

  index(email: SearchableEmail): void {
    // FTS5 tables have no UNIQUE constraint — guard against duplicate entries
    if (email.messageId) {
      const existing = this.db.prepare(
        'SELECT rowid FROM email_search WHERE agent_id = ? AND message_id = ?',
      ).get(email.agentId, email.messageId);
      if (existing) return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO email_search (agent_id, message_id, subject, from_address, to_address, body_text, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      email.agentId,
      email.messageId,
      email.subject,
      email.fromAddress,
      email.toAddress,
      email.bodyText,
      email.receivedAt,
    );
  }

  search(agentId: string, query: string, limit = 20): SearchableEmail[] {
    if (!query || !query.trim()) return [];
    limit = Math.min(Math.max(limit, 1), 1000);

    // Sanitize query for FTS5: wrap in double quotes to treat as literal phrase,
    // escaping any existing double quotes to prevent FTS5 syntax injection
    const sanitized = '"' + query.replace(/"/g, '""') + '"';

    try {
      const stmt = this.db.prepare(`
        SELECT agent_id as agentId, message_id as messageId, subject, from_address as fromAddress,
               to_address as toAddress, body_text as bodyText, received_at as receivedAt
        FROM email_search
        WHERE agent_id = ? AND email_search MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      return stmt.all(agentId, sanitized, limit) as SearchableEmail[];
    } catch {
      // FTS5 query errors (e.g., malformed syntax) — return empty
      return [];
    }
  }

  deleteByAgent(agentId: string): void {
    const stmt = this.db.prepare('DELETE FROM email_search WHERE agent_id = ?');
    stmt.run(agentId);
  }
}
