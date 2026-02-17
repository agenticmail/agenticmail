/**
 * MySQL Database Adapter
 * 
 * Also works with PlanetScale (MySQL-compatible).
 * Uses mysql2 driver with connection pooling.
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';
import { getAllCreateStatements } from './sql-schema.js';

let mysql2: any;

async function getMysql() {
  if (!mysql2) {
    try {
      mysql2 = await import('mysql2/promise' as any);
    } catch {
      throw new Error(
        'MySQL driver not found. Install it: npm install mysql2\n' +
        'For PlanetScale, the same driver works with SSL enabled.'
      );
    }
  }
  return mysql2;
}

export class MysqlAdapter extends DatabaseAdapter {
  readonly type = 'mysql' as const;
  private pool: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const m = await getMysql();

    const poolConfig: any = config.connectionString
      ? { uri: config.connectionString }
      : {
          host: config.host || 'localhost',
          port: config.port || 3306,
          database: config.database,
          user: config.username,
          password: config.password,
        };

    poolConfig.waitForConnections = true;
    poolConfig.connectionLimit = 20;
    poolConfig.idleTimeout = 30000;

    if (config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = m.createPool(poolConfig);

    // Test connection
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async disconnect(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  isConnected(): boolean { return this.pool !== null; }

  async migrate(): Promise<void> {
    // MySQL uses AUTO_INCREMENT instead of DEFAULT for UUIDs,
    // and DATETIME instead of TIMESTAMP for some cases.
    // The SQL schema uses TIMESTAMP and TEXT which work in MySQL.
    const stmts = getAllCreateStatements();
    const conn = await this.pool.getConnection();
    try {
      for (const stmt of stmts) {
        // MySQL doesn't support "IF NOT EXISTS" on indexes the same way
        // Convert CREATE INDEX IF NOT EXISTS to MySQL syntax
        const mysqlStmt = stmt.replace(
          /CREATE INDEX IF NOT EXISTS (\w+)/g,
          'CREATE INDEX IF NOT EXISTS $1'
        );
        await conn.execute(mysqlStmt);
      }
      // Seed retention policy
      await conn.execute(
        `INSERT IGNORE INTO retention_policy (id) VALUES ('default')`
      );
    } finally {
      conn.release();
    }
  }

  // ─── Helpers ─────────────────────────────────────────

  private async query(sql: string, params: any[] = []): Promise<any[]> {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  private async queryOne(sql: string, params: any[] = []): Promise<any | null> {
    const rows = await this.query(sql, params);
    return rows[0] || null;
  }

  private async execute(sql: string, params: any[] = []): Promise<void> {
    await this.pool.execute(sql, params);
  }

  // ─── Company ─────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const r = await this.queryOne('SELECT * FROM company_settings WHERE id = ?', ['default']);
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
    if (sets.length === 0) return this.getSettings();
    sets.push('updated_at = NOW()');
    vals.push('default');
    await this.execute(`UPDATE company_settings SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.getSettings();
  }

  // ─── Agents ──────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const id = randomUUID();
    const email = input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`;
    await this.execute(
      `INSERT INTO agents (id, name, email, role, metadata, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.name, email, input.role || 'assistant', JSON.stringify(input.metadata || {}), input.createdBy],
    );
    return (await this.getAgent(id))!;
  }

  async getAgent(id: string): Promise<Agent | null> {
    const r = await this.queryOne('SELECT * FROM agents WHERE id = ?', [id]);
    return r ? this.mapAgent(r) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const r = await this.queryOne('SELECT * FROM agents WHERE name = ?', [name]);
    return r ? this.mapAgent(r) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    let q = 'SELECT * FROM agents';
    const params: any[] = [];
    if (opts?.status) { q += ' WHERE status = ?'; params.push(opts.status); }
    q += ' ORDER BY created_at DESC';
    if (opts?.limit) { q += ' LIMIT ?'; params.push(opts.limit); }
    if (opts?.offset) { q += ' OFFSET ?'; params.push(opts.offset); }
    const rows = await this.query(q, params);
    return rows.map((r: any) => this.mapAgent(r));
  }

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const [key, col] of Object.entries({ name: 'name', email: 'email', role: 'role', status: 'status' })) {
      if ((updates as any)[key] !== undefined) { fields.push(`${col} = ?`); vals.push((updates as any)[key]); }
    }
    if (updates.metadata) { fields.push('metadata = ?'); vals.push(JSON.stringify(updates.metadata)); }
    if (fields.length === 0) return (await this.getAgent(id))!;
    fields.push('updated_at = NOW()');
    vals.push(id);
    await this.execute(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, vals);
    return (await this.getAgent(id))!;
  }

  async archiveAgent(id: string): Promise<void> {
    await this.execute("UPDATE agents SET status = 'archived', updated_at = NOW() WHERE id = ?", [id]);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.execute('DELETE FROM agents WHERE id = ?', [id]);
  }

  async countAgents(status?: string): Promise<number> {
    const q = status
      ? await this.queryOne('SELECT COUNT(*) as c FROM agents WHERE status = ?', [status])
      : await this.queryOne('SELECT COUNT(*) as c FROM agents');
    return Number(q?.c || 0);
  }

  // ─── Users ───────────────────────────────────────────

  async createUser(input: UserInput): Promise<User> {
    const id = randomUUID();
    let passwordHash: string | null = null;
    if (input.password) {
      const { default: bcrypt } = await import('bcryptjs');
      passwordHash = await bcrypt.hash(input.password, 12);
    }
    await this.execute(
      `INSERT INTO users (id, email, name, role, password_hash, sso_provider, sso_subject) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.email, input.name, input.role, passwordHash, input.ssoProvider || null, input.ssoSubject || null],
    );
    return (await this.getUser(id))!;
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.queryOne('SELECT * FROM users WHERE id = ?', [id]);
    return r ? this.mapUser(r) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = await this.queryOne('SELECT * FROM users WHERE email = ?', [email]);
    return r ? this.mapUser(r) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    const r = await this.queryOne(
      'SELECT * FROM users WHERE sso_provider = ? AND sso_subject = ?', [provider, subject],
    );
    return r ? this.mapUser(r) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    let q = 'SELECT * FROM users ORDER BY created_at DESC';
    const params: any[] = [];
    if (opts?.limit) { q += ' LIMIT ?'; params.push(opts.limit); }
    if (opts?.offset) { q += ' OFFSET ?'; params.push(opts.offset); }
    const rows = await this.query(q, params);
    return rows.map((r: any) => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const key of ['email', 'name', 'role']) {
      if ((updates as any)[key] !== undefined) { fields.push(`${key} = ?`); vals.push((updates as any)[key]); }
    }
    if (fields.length === 0) return (await this.getUser(id))!;
    fields.push('updated_at = NOW()');
    vals.push(id);
    await this.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, vals);
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    await this.execute('DELETE FROM users WHERE id = ?', [id]);
  }

  // ─── Audit ───────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.execute(
      `INSERT INTO audit_log (id, actor, actor_type, action, resource, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), event.actor, event.actorType, event.action, event.resource,
       JSON.stringify(event.details || {}), event.ip || null],
    );
  }

  async queryAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; total: number }> {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.actor) { where.push('actor = ?'); params.push(filters.actor); }
    if (filters.action) { where.push('action = ?'); params.push(filters.action); }
    if (filters.resource) { where.push('resource LIKE ?'); params.push(`%${filters.resource}%`); }
    if (filters.from) { where.push('timestamp >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('timestamp <= ?'); params.push(filters.to); }

    const wc = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await this.queryOne(`SELECT COUNT(*) as c FROM audit_log ${wc}`, params);
    const total = Number(countRow?.c || 0);

    let q = `SELECT * FROM audit_log ${wc} ORDER BY timestamp DESC`;
    const qParams = [...params];
    if (filters.limit) { q += ' LIMIT ?'; qParams.push(filters.limit); }
    if (filters.offset) { q += ' OFFSET ?'; qParams.push(filters.offset); }
    const rows = await this.query(q, qParams);

    return {
      events: rows.map((r: any) => ({
        id: r.id, timestamp: new Date(r.timestamp), actor: r.actor, actorType: r.actor_type,
        action: r.action, resource: r.resource,
        details: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || {}),
        ip: r.ip,
      })),
      total,
    };
  }

  // ─── API Keys ────────────────────────────────────────

  async createApiKey(input: ApiKeyInput): Promise<{ key: ApiKey; plaintext: string }> {
    const id = randomUUID();
    const plaintext = `ek_${randomUUID().replace(/-/g, '')}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const keyPrefix = plaintext.substring(0, 11);
    await this.execute(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, keyHash, keyPrefix, JSON.stringify(input.scopes), input.createdBy, input.expiresAt || null],
    );
    return { key: (await this.getApiKey(id))!, plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const r = await this.queryOne('SELECT * FROM api_keys WHERE id = ?', [id]);
    return r ? this.mapApiKey(r) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const r = await this.queryOne('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0', [keyHash]);
    if (!r) return null;
    const key = this.mapApiKey(r);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    await this.execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [key.id]);
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    let q = 'SELECT * FROM api_keys';
    const params: any[] = [];
    if (opts?.createdBy) { q += ' WHERE created_by = ?'; params.push(opts.createdBy); }
    q += ' ORDER BY created_at DESC';
    const rows = await this.query(q, params);
    return rows.map((r: any) => this.mapApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.execute('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
  }

  // ─── Rules ───────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const id = randomUUID();
    await this.execute(
      `INSERT INTO email_rules (id, name, agent_id, conditions, actions, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, rule.name, rule.agentId || null, JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
       rule.priority, rule.enabled ? 1 : 0],
    );
    const r = await this.queryOne('SELECT * FROM email_rules WHERE id = ?', [id]);
    return this.mapRule(r);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    let q = 'SELECT * FROM email_rules';
    const params: any[] = [];
    if (agentId) { q += ' WHERE agent_id = ? OR agent_id IS NULL'; params.push(agentId); }
    q += ' ORDER BY priority DESC';
    const rows = await this.query(q, params);
    return rows.map((r: any) => this.mapRule(r));
  }

  async updateRule(id: string, updates: Partial<EmailRule>): Promise<EmailRule> {
    const fields: string[] = [];
    const vals: any[] = [];
    if (updates.name !== undefined) { fields.push('name = ?'); vals.push(updates.name); }
    if (updates.conditions) { fields.push('conditions = ?'); vals.push(JSON.stringify(updates.conditions)); }
    if (updates.actions) { fields.push('actions = ?'); vals.push(JSON.stringify(updates.actions)); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); vals.push(updates.priority); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0); }
    if (fields.length === 0) { const r = await this.queryOne('SELECT * FROM email_rules WHERE id = ?', [id]); return this.mapRule(r); }
    fields.push('updated_at = NOW()');
    vals.push(id);
    await this.execute(`UPDATE email_rules SET ${fields.join(', ')} WHERE id = ?`, vals);
    const r = await this.queryOne('SELECT * FROM email_rules WHERE id = ?', [id]);
    return this.mapRule(r);
  }

  async deleteRule(id: string): Promise<void> {
    await this.execute('DELETE FROM email_rules WHERE id = ?', [id]);
  }

  // ─── Retention ───────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const r = await this.queryOne('SELECT * FROM retention_policy WHERE id = ?', ['default']);
    if (!r) return { enabled: false, retainDays: 365, archiveFirst: true };
    return {
      enabled: !!r.enabled,
      retainDays: r.retain_days,
      excludeTags: typeof r.exclude_tags === 'string' ? JSON.parse(r.exclude_tags) : (r.exclude_tags || []),
      archiveFirst: !!r.archive_first,
    };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.execute(
      `UPDATE retention_policy SET enabled = ?, retain_days = ?, exclude_tags = ?, archive_first = ? WHERE id = 'default'`,
      [policy.enabled ? 1 : 0, policy.retainDays, JSON.stringify(policy.excludeTags || []), policy.archiveFirst ? 1 : 0],
    );
  }

  // ─── Stats ───────────────────────────────────────────

  async getStats() {
    const [agents, active, users, audit] = await Promise.all([
      this.queryOne('SELECT COUNT(*) as c FROM agents'),
      this.queryOne("SELECT COUNT(*) as c FROM agents WHERE status = 'active'"),
      this.queryOne('SELECT COUNT(*) as c FROM users'),
      this.queryOne('SELECT COUNT(*) as c FROM audit_log'),
    ]);
    return {
      totalAgents: Number(agents?.c || 0),
      activeAgents: Number(active?.c || 0),
      totalUsers: Number(users?.c || 0),
      totalEmails: 0,
      totalAuditEvents: Number(audit?.c || 0),
    };
  }

  // ─── Mappers ─────────────────────────────────────────

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
