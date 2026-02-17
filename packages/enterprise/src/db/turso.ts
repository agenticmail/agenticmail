/**
 * Turso (LibSQL) Database Adapter
 * 
 * Edge-native SQLite via libsql. Same SQL schema as SQLite
 * but uses the @libsql/client async driver.
 * Works with Turso cloud and local libsql-server.
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';
import { getAllCreateStatements } from './sql-schema.js';

let libsqlClient: any;

async function getClient() {
  if (!libsqlClient) {
    try {
      libsqlClient = await import('@libsql/client');
    } catch {
      throw new Error('Turso driver not found. Install: npm install @libsql/client');
    }
  }
  return libsqlClient;
}

export class TursoAdapter extends DatabaseAdapter {
  readonly type = 'turso' as const;
  private client: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const lib = await getClient();
    this.client = lib.createClient({
      url: config.connectionString || 'file:./agenticmail-enterprise.db',
      authToken: config.authToken,
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) this.client.close();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  private async run(sql: string, args: any[] = []): Promise<any> {
    return this.client.execute({ sql, args });
  }

  private async get(sql: string, args: any[] = []): Promise<any> {
    const result = await this.run(sql, args);
    if (!result.rows || result.rows.length === 0) return null;
    return result.rows[0];
  }

  private async all(sql: string, args: any[] = []): Promise<any[]> {
    const result = await this.run(sql, args);
    return result.rows || [];
  }

  async migrate(): Promise<void> {
    const stmts = getAllCreateStatements();
    await this.client.batch(
      stmts.map(sql => ({ sql, args: [] })).concat([
        { sql: `INSERT OR IGNORE INTO retention_policy (id) VALUES ('default')`, args: [] },
      ]),
      'write',
    );
  }

  // ─── Company ─────────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const r = await this.get('SELECT * FROM company_settings WHERE id = ?', ['default']);
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
    await this.run(`UPDATE company_settings SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.getSettings();
  }

  // ─── Agents ──────────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const id = randomUUID();
    const email = input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`;
    await this.run(
      `INSERT INTO agents (id, name, email, role, metadata, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.name, email, input.role || 'assistant', JSON.stringify(input.metadata || {}), input.createdBy],
    );
    return (await this.getAgent(id))!;
  }

  async getAgent(id: string): Promise<Agent | null> {
    const r = await this.get('SELECT * FROM agents WHERE id = ?', [id]);
    return r ? this.mapAgent(r) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const r = await this.get('SELECT * FROM agents WHERE name = ?', [name]);
    return r ? this.mapAgent(r) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    let q = 'SELECT * FROM agents';
    const params: any[] = [];
    if (opts?.status) { q += ' WHERE status = ?'; params.push(opts.status); }
    q += ' ORDER BY created_at DESC';
    if (opts?.limit) q += ` LIMIT ${opts.limit}`;
    if (opts?.offset) q += ` OFFSET ${opts.offset}`;
    return (await this.all(q, params)).map(r => this.mapAgent(r));
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
    await this.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, vals);
    return (await this.getAgent(id))!;
  }

  async archiveAgent(id: string): Promise<void> {
    await this.run("UPDATE agents SET status = 'archived', updated_at = datetime('now') WHERE id = ?", [id]);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.run('DELETE FROM agents WHERE id = ?', [id]);
  }

  async countAgents(status?: string): Promise<number> {
    const r = status
      ? await this.get('SELECT COUNT(*) as c FROM agents WHERE status = ?', [status])
      : await this.get('SELECT COUNT(*) as c FROM agents', []);
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
    await this.run(
      `INSERT INTO users (id, email, name, role, password_hash, sso_provider, sso_subject) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.email, input.name, input.role, passwordHash, input.ssoProvider || null, input.ssoSubject || null],
    );
    return (await this.getUser(id))!;
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.get('SELECT * FROM users WHERE id = ?', [id]);
    return r ? this.mapUser(r) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = await this.get('SELECT * FROM users WHERE email = ?', [email]);
    return r ? this.mapUser(r) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    const r = await this.get('SELECT * FROM users WHERE sso_provider = ? AND sso_subject = ?', [provider, subject]);
    return r ? this.mapUser(r) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    let q = 'SELECT * FROM users ORDER BY created_at DESC';
    if (opts?.limit) q += ` LIMIT ${opts.limit}`;
    if (opts?.offset) q += ` OFFSET ${opts.offset}`;
    return (await this.all(q)).map(r => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const key of ['email', 'name', 'role']) {
      if ((updates as any)[key] !== undefined) { fields.push(`${key} = ?`); vals.push((updates as any)[key]); }
    }
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    await this.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, vals);
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    await this.run('DELETE FROM users WHERE id = ?', [id]);
  }

  // ─── Audit ───────────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.run(
      `INSERT INTO audit_log (id, actor, actor_type, action, resource, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), event.actor, event.actorType, event.action, event.resource, JSON.stringify(event.details || {}), event.ip || null],
    );
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
    const countRow = await this.get(`SELECT COUNT(*) as c FROM audit_log ${wc}`, params);
    let q = `SELECT * FROM audit_log ${wc} ORDER BY timestamp DESC`;
    if (filters.limit) q += ` LIMIT ${filters.limit}`;
    if (filters.offset) q += ` OFFSET ${filters.offset}`;
    const rows = await this.all(q, params);
    return {
      events: rows.map(r => ({
        id: r.id, timestamp: new Date(r.timestamp), actor: r.actor, actorType: r.actor_type,
        action: r.action, resource: r.resource, details: JSON.parse(r.details || '{}'), ip: r.ip,
      })),
      total: countRow.c,
    };
  }

  // ─── API Keys ────────────────────────────────────────────

  async createApiKey(input: ApiKeyInput): Promise<{ key: ApiKey; plaintext: string }> {
    const id = randomUUID();
    const plaintext = `ek_${randomUUID().replace(/-/g, '')}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const keyPrefix = plaintext.substring(0, 11);
    await this.run(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, keyHash, keyPrefix, JSON.stringify(input.scopes), input.createdBy, input.expiresAt?.toISOString() || null],
    );
    return { key: (await this.getApiKey(id))!, plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const r = await this.get('SELECT * FROM api_keys WHERE id = ?', [id]);
    return r ? this.mapApiKey(r) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const r = await this.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0', [keyHash]);
    if (!r) return null;
    const key = this.mapApiKey(r);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    await this.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", [key.id]);
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    let q = 'SELECT * FROM api_keys';
    const params: any[] = [];
    if (opts?.createdBy) { q += ' WHERE created_by = ?'; params.push(opts.createdBy); }
    q += ' ORDER BY created_at DESC';
    return (await this.all(q, params)).map(r => this.mapApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
  }

  // ─── Rules ───────────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const id = randomUUID();
    await this.run(
      `INSERT INTO email_rules (id, name, agent_id, conditions, actions, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, rule.name, rule.agentId || null, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.priority, rule.enabled ? 1 : 0],
    );
    const r = await this.get('SELECT * FROM email_rules WHERE id = ?', [id]);
    return this.mapRule(r);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    let q = 'SELECT * FROM email_rules';
    const params: any[] = [];
    if (agentId) { q += ' WHERE agent_id = ? OR agent_id IS NULL'; params.push(agentId); }
    q += ' ORDER BY priority DESC';
    return (await this.all(q, params)).map(r => this.mapRule(r));
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
    await this.run(`UPDATE email_rules SET ${fields.join(', ')} WHERE id = ?`, vals);
    const r = await this.get('SELECT * FROM email_rules WHERE id = ?', [id]);
    return this.mapRule(r);
  }

  async deleteRule(id: string): Promise<void> {
    await this.run('DELETE FROM email_rules WHERE id = ?', [id]);
  }

  // ─── Retention ───────────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const r = await this.get('SELECT * FROM retention_policy WHERE id = ?', ['default']);
    if (!r) return { enabled: false, retainDays: 365, archiveFirst: true };
    return { enabled: !!r.enabled, retainDays: r.retain_days, excludeTags: JSON.parse(r.exclude_tags || '[]'), archiveFirst: !!r.archive_first };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.run(
      `UPDATE retention_policy SET enabled = ?, retain_days = ?, exclude_tags = ?, archive_first = ? WHERE id = 'default'`,
      [policy.enabled ? 1 : 0, policy.retainDays, JSON.stringify(policy.excludeTags || []), policy.archiveFirst ? 1 : 0],
    );
  }

  // ─── Stats ───────────────────────────────────────────────

  async getStats() {
    const [total, active, users, audit] = await Promise.all([
      this.get('SELECT COUNT(*) as c FROM agents'),
      this.get("SELECT COUNT(*) as c FROM agents WHERE status = 'active'"),
      this.get('SELECT COUNT(*) as c FROM users'),
      this.get('SELECT COUNT(*) as c FROM audit_log'),
    ]);
    return {
      totalAgents: total.c,
      activeAgents: active.c,
      totalUsers: users.c,
      totalEmails: 0,
      totalAuditEvents: audit.c,
    };
  }

  // ─── Mappers ─────────────────────────────────────────────

  private mapAgent(r: any): Agent {
    return {
      id: r.id, name: r.name, email: r.email, role: r.role, status: r.status,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
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
      scopes: typeof r.scopes === 'string' ? JSON.parse(r.scopes) : (r.scopes || []),
      createdBy: r.created_by, createdAt: new Date(r.created_at),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : undefined,
      expiresAt: r.expires_at ? new Date(r.expires_at) : undefined,
      revoked: !!r.revoked,
    };
  }

  private mapRule(r: any): EmailRule {
    return {
      id: r.id, name: r.name, agentId: r.agent_id,
      conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions) : (r.conditions || {}),
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : (r.actions || {}),
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
