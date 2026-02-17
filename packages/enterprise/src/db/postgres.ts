/**
 * PostgreSQL Database Adapter
 * 
 * Also works with Supabase, Neon, CockroachDB (all PG-compatible).
 * Uses 'pg' driver — user must install: npm install pg
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';
import { getAllCreateStatements } from './sql-schema.js';

let pg: any;

async function getPg() {
  if (!pg) {
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'PostgreSQL driver not found. Install it: npm install pg\n' +
        'For Supabase/Neon/CockroachDB, the same pg driver works.'
      );
    }
  }
  return pg;
}

export class PostgresAdapter extends DatabaseAdapter {
  readonly type = 'postgres' as const;
  private pool: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const { Pool } = await getPg();
    this.pool = new Pool({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
    });
    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  async disconnect(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  async migrate(): Promise<void> {
    const stmts = getAllCreateStatements();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const stmt of stmts) {
        await client.query(stmt);
      }
      // Seed retention policy
      await client.query(`
        INSERT INTO retention_policy (id) VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Company ─────────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const { rows } = await this.pool.query(
      'SELECT * FROM company_settings WHERE id = $1', ['default']
    );
    return rows[0] ? this.mapSettings(rows[0]) : null!;
  }

  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    const map: Record<string, string> = {
      name: 'name', domain: 'domain', subdomain: 'subdomain',
      smtpHost: 'smtp_host', smtpPort: 'smtp_port', smtpUser: 'smtp_user',
      smtpPass: 'smtp_pass', dkimPrivateKey: 'dkim_private_key',
      logoUrl: 'logo_url', primaryColor: 'primary_color', plan: 'plan',
    };
    for (const [key, col] of Object.entries(map)) {
      if ((updates as any)[key] !== undefined) {
        fields.push(`${col} = $${i}`);
        values.push((updates as any)[key]);
        i++;
      }
    }
    fields.push(`updated_at = NOW()`);
    values.push('default');
    const { rows } = await this.pool.query(
      `UPDATE company_settings SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return this.mapSettings(rows[0]);
  }

  // ─── Agents ──────────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const id = randomUUID();
    const email = input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`;
    const { rows } = await this.pool.query(
      `INSERT INTO agents (id, name, email, role, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, input.name, email, input.role || 'assistant', JSON.stringify(input.metadata || {}), input.createdBy]
    );
    return this.mapAgent(rows[0]);
  }

  async getAgent(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query('SELECT * FROM agents WHERE id = $1', [id]);
    return rows[0] ? this.mapAgent(rows[0]) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const { rows } = await this.pool.query('SELECT * FROM agents WHERE name = $1', [name]);
    return rows[0] ? this.mapAgent(rows[0]) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    let q = 'SELECT * FROM agents';
    const params: any[] = [];
    if (opts?.status) { q += ' WHERE status = $1'; params.push(opts.status); }
    q += ' ORDER BY created_at DESC';
    if (opts?.limit) { q += ` LIMIT ${opts.limit}`; }
    if (opts?.offset) { q += ` OFFSET ${opts.offset}`; }
    const { rows } = await this.pool.query(q, params);
    return rows.map((r: any) => this.mapAgent(r));
  }

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, col] of Object.entries({ name: 'name', email: 'email', role: 'role', status: 'status' })) {
      if ((updates as any)[key] !== undefined) {
        fields.push(`${col} = $${i}`);
        values.push((updates as any)[key]);
        i++;
      }
    }
    if (updates.metadata) {
      fields.push(`metadata = $${i}`);
      values.push(JSON.stringify(updates.metadata));
      i++;
    }
    fields.push('updated_at = NOW()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE agents SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return this.mapAgent(rows[0]);
  }

  async archiveAgent(id: string): Promise<void> {
    await this.pool.query("UPDATE agents SET status = 'archived', updated_at = NOW() WHERE id = $1", [id]);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agents WHERE id = $1', [id]);
  }

  async countAgents(status?: string): Promise<number> {
    const q = status
      ? await this.pool.query('SELECT COUNT(*) FROM agents WHERE status = $1', [status])
      : await this.pool.query('SELECT COUNT(*) FROM agents');
    return parseInt(q.rows[0].count, 10);
  }

  // ─── Users ───────────────────────────────────────────────

  async createUser(input: UserInput): Promise<User> {
    const id = randomUUID();
    let passwordHash: string | null = null;
    if (input.password) {
      const { default: bcrypt } = await import('bcryptjs');
      passwordHash = await bcrypt.hash(input.password, 12);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, email, name, role, password_hash, sso_provider, sso_subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, input.email, input.name, input.role, passwordHash, input.ssoProvider || null, input.ssoSubject || null]
    );
    return this.mapUser(rows[0]);
  }

  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE sso_provider = $1 AND sso_subject = $2',
      [provider, subject]
    );
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    let q = 'SELECT * FROM users ORDER BY created_at DESC';
    if (opts?.limit) q += ` LIMIT ${opts.limit}`;
    if (opts?.offset) q += ` OFFSET ${opts.offset}`;
    const { rows } = await this.pool.query(q);
    return rows.map((r: any) => this.mapUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const key of ['email', 'name', 'role', 'sso_provider', 'sso_subject'] as const) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if ((updates as any)[camelKey] !== undefined) {
        fields.push(`${key} = $${i}`);
        values.push((updates as any)[camelKey]);
        i++;
      }
    }
    fields.push('updated_at = NOW()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return this.mapUser(rows[0]);
  }

  async deleteUser(id: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
  }

  // ─── Audit ───────────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (id, actor, actor_type, action, resource, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), event.actor, event.actorType, event.action, event.resource,
       JSON.stringify(event.details || {}), event.ip || null]
    );
  }

  async queryAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; total: number }> {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (filters.actor) { where.push(`actor = $${i++}`); params.push(filters.actor); }
    if (filters.action) { where.push(`action = $${i++}`); params.push(filters.action); }
    if (filters.resource) { where.push(`resource LIKE $${i++}`); params.push(`%${filters.resource}%`); }
    if (filters.from) { where.push(`timestamp >= $${i++}`); params.push(filters.from); }
    if (filters.to) { where.push(`timestamp <= $${i++}`); params.push(filters.to); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.pool.query(`SELECT COUNT(*) FROM audit_log ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    let q = `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC`;
    if (filters.limit) q += ` LIMIT ${filters.limit}`;
    if (filters.offset) q += ` OFFSET ${filters.offset}`;
    const { rows } = await this.pool.query(q, params);

    return {
      events: rows.map((r: any) => ({
        id: r.id, timestamp: r.timestamp, actor: r.actor, actorType: r.actor_type,
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
    const keyPrefix = plaintext.substring(0, 11); // "ek_" + 8 chars
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, input.name, keyHash, keyPrefix, JSON.stringify(input.scopes), input.createdBy, input.expiresAt || null]
    );
    return { key: this.mapApiKey(rows[0]), plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    return rows[0] ? this.mapApiKey(rows[0]) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const { rows } = await this.pool.query(
      'SELECT * FROM api_keys WHERE key_hash = $1 AND revoked = 0',
      [keyHash]
    );
    if (!rows[0]) return null;
    const key = this.mapApiKey(rows[0]);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    // Update last used
    await this.pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]);
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    let q = 'SELECT * FROM api_keys';
    const params: any[] = [];
    if (opts?.createdBy) { q += ' WHERE created_by = $1'; params.push(opts.createdBy); }
    q += ' ORDER BY created_at DESC';
    const { rows } = await this.pool.query(q, params);
    return rows.map((r: any) => this.mapApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET revoked = 1 WHERE id = $1', [id]);
  }

  // ─── Rules ───────────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO email_rules (id, name, agent_id, conditions, actions, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, rule.name, rule.agentId || null, JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
       rule.priority, rule.enabled ? 1 : 0]
    );
    return this.mapRule(rows[0]);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    let q = 'SELECT * FROM email_rules';
    const params: any[] = [];
    if (agentId) { q += ' WHERE agent_id = $1 OR agent_id IS NULL'; params.push(agentId); }
    q += ' ORDER BY priority DESC';
    const { rows } = await this.pool.query(q, params);
    return rows.map((r: any) => this.mapRule(r));
  }

  async updateRule(id: string, updates: Partial<EmailRule>): Promise<EmailRule> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (updates.name !== undefined) { fields.push(`name = $${i++}`); values.push(updates.name); }
    if (updates.conditions) { fields.push(`conditions = $${i++}`); values.push(JSON.stringify(updates.conditions)); }
    if (updates.actions) { fields.push(`actions = $${i++}`); values.push(JSON.stringify(updates.actions)); }
    if (updates.priority !== undefined) { fields.push(`priority = $${i++}`); values.push(updates.priority); }
    if (updates.enabled !== undefined) { fields.push(`enabled = $${i++}`); values.push(updates.enabled ? 1 : 0); }
    fields.push('updated_at = NOW()');
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE email_rules SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return this.mapRule(rows[0]);
  }

  async deleteRule(id: string): Promise<void> {
    await this.pool.query('DELETE FROM email_rules WHERE id = $1', [id]);
  }

  // ─── Retention ───────────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const { rows } = await this.pool.query('SELECT * FROM retention_policy WHERE id = $1', ['default']);
    if (!rows[0]) return { enabled: false, retainDays: 365, archiveFirst: true };
    return {
      enabled: !!rows[0].enabled,
      retainDays: rows[0].retain_days,
      excludeTags: JSON.parse(rows[0].exclude_tags || '[]'),
      archiveFirst: !!rows[0].archive_first,
    };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.pool.query(
      `UPDATE retention_policy SET enabled = $1, retain_days = $2, exclude_tags = $3, archive_first = $4
       WHERE id = 'default'`,
      [policy.enabled ? 1 : 0, policy.retainDays, JSON.stringify(policy.excludeTags || []), policy.archiveFirst ? 1 : 0]
    );
  }

  // ─── Stats ───────────────────────────────────────────────

  async getStats() {
    const [agents, active, users, audit] = await Promise.all([
      this.pool.query('SELECT COUNT(*) FROM agents'),
      this.pool.query("SELECT COUNT(*) FROM agents WHERE status = 'active'"),
      this.pool.query('SELECT COUNT(*) FROM users'),
      this.pool.query('SELECT COUNT(*) FROM audit_log'),
    ]);
    return {
      totalAgents: parseInt(agents.rows[0].count, 10),
      activeAgents: parseInt(active.rows[0].count, 10),
      totalUsers: parseInt(users.rows[0].count, 10),
      totalEmails: 0, // TODO: wire to email storage
      totalAuditEvents: parseInt(audit.rows[0].count, 10),
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
