/**
 * SQLite Database Adapter
 * 
 * For development, small teams, or self-hosted single-server deployments.
 * Uses better-sqlite3 for sync performance.
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';
import { getAllCreateStatements } from './sql-schema.js';

let Database: any;

async function getSqlite() {
  if (!Database) {
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default;
    } catch {
      throw new Error('SQLite driver not found. Install it: npm install better-sqlite3');
    }
  }
  return Database;
}

export class SqliteAdapter extends DatabaseAdapter {
  readonly type = 'sqlite' as const;
  private db: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const Db = await getSqlite();
    const path = config.connectionString || config.database || './agenticmail-enterprise.db';
    this.db = new Db(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async disconnect(): Promise<void> {
    if (this.db) this.db.close();
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  async migrate(): Promise<void> {
    const stmts = getAllCreateStatements();
    const tx = this.db.transaction(() => {
      for (const stmt of stmts) this.db.exec(stmt);
      // Seed retention policy
      this.db.prepare(
        `INSERT OR IGNORE INTO retention_policy (id) VALUES ('default')`
      ).run();
    });
    tx();
  }

  // ─── Company ─────────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const r = this.db.prepare('SELECT * FROM company_settings WHERE id = ?').get('default');
    return r ? this.mapSettings(r) : null!;
  }

  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    const map: Record<string, string> = {
      name: 'name', domain: 'domain', subdomain: 'subdomain',
      smtpHost: 'smtp_host', smtpPort: 'smtp_port', smtpUser: 'smtp_user',
      smtpPass: 'smtp_pass', dkimPrivateKey: 'dkim_private_key',
      logoUrl: 'logo_url', primaryColor: 'primary_color', plan: 'plan',
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if ((updates as any)[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push((updates as any)[key]);
      }
    }
    sets.push("updated_at = datetime('now')");
    vals.push('default');
    this.db.prepare(`UPDATE company_settings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getSettings();
  }

  // ─── Agents ──────────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const id = randomUUID();
    const email = input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`;
    this.db.prepare(
      `INSERT INTO agents (id, name, email, role, metadata, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, email, input.role || 'assistant', JSON.stringify(input.metadata || {}), input.createdBy);
    return (await this.getAgent(id))!;
  }

  async getAgent(id: string): Promise<Agent | null> {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return r ? this.mapAgent(r) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const r = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    return r ? this.mapAgent(r) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    let q = 'SELECT * FROM agents';
    const params: any[] = [];
    if (opts?.status) { q += ' WHERE status = ?'; params.push(opts.status); }
    q += ' ORDER BY created_at DESC';
    if (opts?.limit) q += ` LIMIT ${opts.limit}`;
    if (opts?.offset) q += ` OFFSET ${opts.offset}`;
    return this.db.prepare(q).all(...params).map((r: any) => this.mapAgent(r));
  }

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const [key, col] of Object.entries({ name: 'name', email: 'email', role: 'role', status: 'status' })) {
      if ((updates as any)[key] !== undefined) { fields.push(`${col} = ?`); vals.push((updates as any)[key]); }
    }
    if (updates.metadata) { fields.push('metadata = ?'); vals.push(JSON.stringify(updates.metadata)); }
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    return (await this.getAgent(id))!;
  }

  async archiveAgent(id: string): Promise<void> {
    this.db.prepare("UPDATE agents SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(id);
  }

  async deleteAgent(id: string): Promise<void> {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  async countAgents(status?: string): Promise<number> {
    const r = status
      ? this.db.prepare('SELECT COUNT(*) as c FROM agents WHERE status = ?').get(status)
      : this.db.prepare('SELECT COUNT(*) as c FROM agents').get();
    return r.c;
  }

  // ─── Users ───────────────────────────────────────────────

  async createUser(input: UserInput): Promise<User> {
    const id = randomUUID();
    let passwordHash: string | null = null;
    if (input.password) {
      const { default: bcrypt } = await import('bcryptjs');
      passwordHash = await bcrypt.hash(input.password, 12);
    }
    this.db.prepare(
      `INSERT INTO users (id, email, name, role, password_hash, sso_provider, sso_subject)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.email, input.name, input.role, passwordHash, input.ssoProvider || null, input.ssoSubject || null);
    return (await this.getUser(id))!;
  }

  async getUser(id: string): Promise<User | null> {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return r ? this.mapUser(r) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return r ? this.mapUser(r) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    const r = this.db.prepare('SELECT * FROM users WHERE sso_provider = ? AND sso_subject = ?').get(provider, subject);
    return r ? this.mapUser(r) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    let q = 'SELECT * FROM users ORDER BY created_at DESC';
    if (opts?.limit) q += ` LIMIT ${opts.limit}`;
    if (opts?.offset) q += ` OFFSET ${opts.offset}`;
    return this.db.prepare(q).all().map((r: any) => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const key of ['email', 'name', 'role']) {
      if ((updates as any)[key] !== undefined) { fields.push(`${key} = ?`); vals.push((updates as any)[key]); }
    }
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  // ─── Audit ───────────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO audit_log (id, actor, actor_type, action, resource, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), event.actor, event.actorType, event.action, event.resource,
      JSON.stringify(event.details || {}), event.ip || null);
  }

  async queryAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; total: number }> {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.actor) { where.push('actor = ?'); params.push(filters.actor); }
    if (filters.action) { where.push('action = ?'); params.push(filters.action); }
    if (filters.resource) { where.push('resource LIKE ?'); params.push(`%${filters.resource}%`); }
    if (filters.from) { where.push('timestamp >= ?'); params.push(filters.from.toISOString()); }
    if (filters.to) { where.push('timestamp <= ?'); params.push(filters.to.toISOString()); }
    const wc = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) as c FROM audit_log ${wc}`).get(...params).c;
    let q = `SELECT * FROM audit_log ${wc} ORDER BY timestamp DESC`;
    if (filters.limit) q += ` LIMIT ${filters.limit}`;
    if (filters.offset) q += ` OFFSET ${filters.offset}`;
    const rows = this.db.prepare(q).all(...params);
    return {
      events: rows.map((r: any) => ({
        id: r.id, timestamp: new Date(r.timestamp), actor: r.actor, actorType: r.actor_type,
        action: r.action, resource: r.resource, details: JSON.parse(r.details || '{}'), ip: r.ip,
      })),
      total,
    };
  }

  // ─── API Keys ────────────────────────────────────────────

  async createApiKey(input: ApiKeyInput): Promise<{ key: ApiKey; plaintext: string }> {
    const id = randomUUID();
    const plaintext = `ek_${randomUUID().replace(/-/g, '')}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const keyPrefix = plaintext.substring(0, 11);
    this.db.prepare(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, keyHash, keyPrefix, JSON.stringify(input.scopes), input.createdBy, input.expiresAt?.toISOString() || null);
    return { key: (await this.getApiKey(id))!, plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    return r ? this.mapApiKey(r) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(keyHash);
    if (!r) return null;
    const key = this.mapApiKey(r);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    this.db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    let q = 'SELECT * FROM api_keys';
    const params: any[] = [];
    if (opts?.createdBy) { q += ' WHERE created_by = ?'; params.push(opts.createdBy); }
    q += ' ORDER BY created_at DESC';
    return this.db.prepare(q).all(...params).map((r: any) => this.mapApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
  }

  // ─── Rules ───────────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO email_rules (id, name, agent_id, conditions, actions, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, rule.name, rule.agentId || null, JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
      rule.priority, rule.enabled ? 1 : 0);
    const r = this.db.prepare('SELECT * FROM email_rules WHERE id = ?').get(id);
    return this.mapRule(r);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    let q = 'SELECT * FROM email_rules';
    const params: any[] = [];
    if (agentId) { q += ' WHERE agent_id = ? OR agent_id IS NULL'; params.push(agentId); }
    q += ' ORDER BY priority DESC';
    return this.db.prepare(q).all(...params).map((r: any) => this.mapRule(r));
  }

  async updateRule(id: string, updates: Partial<EmailRule>): Promise<EmailRule> {
    const fields: string[] = [];
    const vals: any[] = [];
    if (updates.name !== undefined) { fields.push('name = ?'); vals.push(updates.name); }
    if (updates.conditions) { fields.push('conditions = ?'); vals.push(JSON.stringify(updates.conditions)); }
    if (updates.actions) { fields.push('actions = ?'); vals.push(JSON.stringify(updates.actions)); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); vals.push(updates.priority); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0); }
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE email_rules SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    const r = this.db.prepare('SELECT * FROM email_rules WHERE id = ?').get(id);
    return this.mapRule(r);
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare('DELETE FROM email_rules WHERE id = ?').run(id);
  }

  // ─── Retention ───────────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const r = this.db.prepare('SELECT * FROM retention_policy WHERE id = ?').get('default');
    if (!r) return { enabled: false, retainDays: 365, archiveFirst: true };
    return { enabled: !!r.enabled, retainDays: r.retain_days, excludeTags: JSON.parse(r.exclude_tags || '[]'), archiveFirst: !!r.archive_first };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    this.db.prepare(
      `UPDATE retention_policy SET enabled = ?, retain_days = ?, exclude_tags = ?, archive_first = ? WHERE id = 'default'`
    ).run(policy.enabled ? 1 : 0, policy.retainDays, JSON.stringify(policy.excludeTags || []), policy.archiveFirst ? 1 : 0);
  }

  // ─── Stats ───────────────────────────────────────────────

  async getStats() {
    return {
      totalAgents: this.db.prepare('SELECT COUNT(*) as c FROM agents').get().c,
      activeAgents: this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'active'").get().c,
      totalUsers: this.db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      totalEmails: 0,
      totalAuditEvents: this.db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c,
    };
  }

  // ─── Mappers ─────────────────────────────────────────────

  private mapAgent(r: any): Agent {
    return {
      id: r.id, name: r.name, email: r.email, role: r.role, status: r.status,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), createdBy: r.created_by,
    };
  }

  private mapUser(r: any): User {
    return {
      id: r.id, email: r.email, name: r.name, role: r.role,
      passwordHash: r.password_hash, ssoProvider: r.sso_provider, ssoSubject: r.sso_subject,
      createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : undefined,
    };
  }

  private mapApiKey(r: any): ApiKey {
    return {
      id: r.id, name: r.name, keyHash: r.key_hash, keyPrefix: r.key_prefix,
      scopes: typeof r.scopes === 'string' ? JSON.parse(r.scopes) : r.scopes,
      createdBy: r.created_by, createdAt: new Date(r.created_at),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : undefined,
      expiresAt: r.expires_at ? new Date(r.expires_at) : undefined,
      revoked: !!r.revoked,
    };
  }

  private mapRule(r: any): EmailRule {
    return {
      id: r.id, name: r.name, agentId: r.agent_id,
      conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions) : r.conditions,
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : r.actions,
      priority: r.priority, enabled: !!r.enabled,
      createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
    };
  }

  private mapSettings(r: any): CompanySettings {
    return {
      id: r.id, name: r.name, domain: r.domain, subdomain: r.subdomain,
      smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpUser: r.smtp_user, smtpPass: r.smtp_pass,
      dkimPrivateKey: r.dkim_private_key, logoUrl: r.logo_url, primaryColor: r.primary_color,
      plan: r.plan, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
    };
  }
}
