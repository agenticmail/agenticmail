/**
 * MongoDB Database Adapter
 * 
 * For organizations using MongoDB/Atlas.
 * Uses the official mongodb driver with connection pooling.
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';

let mongoMod: any;

async function getMongo() {
  if (!mongoMod) {
    try {
      mongoMod = await import('mongodb');
    } catch {
      throw new Error('MongoDB driver not found. Install: npm install mongodb');
    }
  }
  return mongoMod;
}

export class MongoAdapter extends DatabaseAdapter {
  readonly type = 'mongodb' as const;
  private client: any = null;
  private db: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const { MongoClient } = await getMongo();
    const uri = config.connectionString || `mongodb://${config.host || 'localhost'}:${config.port || 27017}`;
    this.client = new MongoClient(uri);
    await this.client.connect();
    const dbName = config.database || new URL(uri.replace('mongodb+srv://', 'https://')).pathname.slice(1) || 'agenticmail';
    this.db = this.client.db(dbName);
  }

  async disconnect(): Promise<void> {
    if (this.client) await this.client.close();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  private col(name: string) { return this.db.collection(name); }

  async migrate(): Promise<void> {
    // Create indexes
    await this.col('agents').createIndex({ name: 1 }, { unique: true });
    await this.col('agents').createIndex({ email: 1 }, { unique: true });
    await this.col('agents').createIndex({ status: 1 });
    await this.col('users').createIndex({ email: 1 }, { unique: true });
    await this.col('users').createIndex({ ssoProvider: 1, ssoSubject: 1 });
    await this.col('audit_log').createIndex({ timestamp: -1 });
    await this.col('audit_log').createIndex({ actor: 1 });
    await this.col('audit_log').createIndex({ action: 1 });
    await this.col('api_keys').createIndex({ keyHash: 1 }, { unique: true });
    await this.col('email_rules').createIndex({ agentId: 1 });

    // Seed defaults
    await this.col('settings').updateOne(
      { _id: 'default' },
      { $setOnInsert: { name: '', subdomain: '', plan: 'free', primaryColor: '#6366f1', createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true },
    );
    await this.col('retention_policy').updateOne(
      { _id: 'default' },
      { $setOnInsert: { enabled: false, retainDays: 365, excludeTags: [], archiveFirst: true } },
      { upsert: true },
    );
  }

  // ─── Company ─────────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const r = await this.col('settings').findOne({ _id: 'default' });
    if (!r) return null!;
    return { id: 'default', name: r.name, domain: r.domain, subdomain: r.subdomain, smtpHost: r.smtpHost, smtpPort: r.smtpPort, smtpUser: r.smtpUser, smtpPass: r.smtpPass, dkimPrivateKey: r.dkimPrivateKey, logoUrl: r.logoUrl, primaryColor: r.primaryColor, plan: r.plan, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    const { id, ...rest } = updates as any;
    await this.col('settings').updateOne({ _id: 'default' }, { $set: { ...rest, updatedAt: new Date() } }, { upsert: true });
    return this.getSettings();
  }

  // ─── Agents ──────────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const doc = {
      _id: randomUUID(),
      name: input.name,
      email: input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`,
      role: input.role || 'assistant',
      status: 'active' as const,
      metadata: input.metadata || {},
      createdBy: input.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.col('agents').insertOne(doc);
    return this.docToAgent(doc);
  }

  async getAgent(id: string): Promise<Agent | null> {
    const r = await this.col('agents').findOne({ _id: id });
    return r ? this.docToAgent(r) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const r = await this.col('agents').findOne({ name });
    return r ? this.docToAgent(r) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    const filter: any = {};
    if (opts?.status) filter.status = opts.status;
    const cursor = this.col('agents').find(filter).sort({ createdAt: -1 });
    if (opts?.offset) cursor.skip(opts.offset);
    if (opts?.limit) cursor.limit(opts.limit);
    return (await cursor.toArray()).map((r: any) => this.docToAgent(r));
  }

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const set: any = { updatedAt: new Date() };
    for (const key of ['name', 'email', 'role', 'status', 'metadata']) {
      if ((updates as any)[key] !== undefined) set[key] = (updates as any)[key];
    }
    await this.col('agents').updateOne({ _id: id }, { $set: set });
    return (await this.getAgent(id))!;
  }

  async archiveAgent(id: string): Promise<void> {
    await this.col('agents').updateOne({ _id: id }, { $set: { status: 'archived', updatedAt: new Date() } });
  }

  async deleteAgent(id: string): Promise<void> {
    await this.col('agents').deleteOne({ _id: id });
  }

  async countAgents(status?: string): Promise<number> {
    const filter: any = {};
    if (status) filter.status = status;
    return this.col('agents').countDocuments(filter);
  }

  // ─── Users ───────────────────────────────────────────────

  async createUser(input: UserInput): Promise<User> {
    let passwordHash: string | null = null;
    if (input.password) {
      const { default: bcrypt } = await import('bcryptjs');
      passwordHash = await bcrypt.hash(input.password, 12);
    }
    const doc = {
      _id: randomUUID(),
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash,
      ssoProvider: input.ssoProvider || null,
      ssoSubject: input.ssoSubject || null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null as Date | null,
    };
    await this.col('users').insertOne(doc);
    return this.docToUser(doc);
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.col('users').findOne({ _id: id });
    return r ? this.docToUser(r) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = await this.col('users').findOne({ email });
    return r ? this.docToUser(r) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    const r = await this.col('users').findOne({ ssoProvider: provider, ssoSubject: subject });
    return r ? this.docToUser(r) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    const cursor = this.col('users').find({}).sort({ createdAt: -1 });
    if (opts?.offset) cursor.skip(opts.offset);
    if (opts?.limit) cursor.limit(opts.limit);
    return (await cursor.toArray()).map((r: any) => this.docToUser(r));
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const set: any = { updatedAt: new Date() };
    for (const key of ['email', 'name', 'role', 'lastLoginAt']) {
      if ((updates as any)[key] !== undefined) set[key] = (updates as any)[key];
    }
    await this.col('users').updateOne({ _id: id }, { $set: set });
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    await this.col('users').deleteOne({ _id: id });
  }

  // ─── Audit ───────────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.col('audit_log').insertOne({
      _id: randomUUID(),
      timestamp: new Date(),
      actor: event.actor,
      actorType: event.actorType,
      action: event.action,
      resource: event.resource,
      details: event.details || {},
      ip: event.ip || null,
    });
  }

  async queryAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; total: number }> {
    const filter: any = {};
    if (filters.actor) filter.actor = filters.actor;
    if (filters.action) filter.action = filters.action;
    if (filters.resource) filter.resource = { $regex: filters.resource, $options: 'i' };
    if (filters.from || filters.to) {
      filter.timestamp = {};
      if (filters.from) filter.timestamp.$gte = filters.from;
      if (filters.to) filter.timestamp.$lte = filters.to;
    }
    const total = await this.col('audit_log').countDocuments(filter);
    const cursor = this.col('audit_log').find(filter).sort({ timestamp: -1 });
    if (filters.offset) cursor.skip(filters.offset);
    if (filters.limit) cursor.limit(filters.limit);
    const rows = await cursor.toArray();
    return {
      events: rows.map((r: any) => ({
        id: r._id, timestamp: r.timestamp, actor: r.actor, actorType: r.actorType,
        action: r.action, resource: r.resource, details: r.details, ip: r.ip,
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
    const doc = {
      _id: id, name: input.name, keyHash, keyPrefix, scopes: input.scopes,
      createdBy: input.createdBy, createdAt: new Date(), lastUsedAt: null as Date | null,
      expiresAt: input.expiresAt || null, revoked: false,
    };
    await this.col('api_keys').insertOne(doc);
    return { key: this.docToApiKey(doc), plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const r = await this.col('api_keys').findOne({ _id: id });
    return r ? this.docToApiKey(r) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const r = await this.col('api_keys').findOne({ keyHash, revoked: false });
    if (!r) return null;
    const key = this.docToApiKey(r);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    await this.col('api_keys').updateOne({ _id: r._id }, { $set: { lastUsedAt: new Date() } });
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    const filter: any = {};
    if (opts?.createdBy) filter.createdBy = opts.createdBy;
    return (await this.col('api_keys').find(filter).sort({ createdAt: -1 }).toArray()).map((r: any) => this.docToApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.col('api_keys').updateOne({ _id: id }, { $set: { revoked: true } });
  }

  // ─── Rules ───────────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const doc = {
      _id: randomUUID(), ...rule, createdAt: new Date(), updatedAt: new Date(),
    };
    await this.col('email_rules').insertOne(doc);
    return this.docToRule(doc);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    const filter: any = {};
    if (agentId) filter.$or = [{ agentId }, { agentId: null }];
    return (await this.col('email_rules').find(filter).sort({ priority: -1 }).toArray()).map((r: any) => this.docToRule(r));
  }

  async updateRule(id: string, updates: Partial<EmailRule>): Promise<EmailRule> {
    const { id: _id, createdAt, ...rest } = updates as any;
    await this.col('email_rules').updateOne({ _id: id }, { $set: { ...rest, updatedAt: new Date() } });
    const r = await this.col('email_rules').findOne({ _id: id });
    return this.docToRule(r);
  }

  async deleteRule(id: string): Promise<void> {
    await this.col('email_rules').deleteOne({ _id: id });
  }

  // ─── Retention ───────────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const r = await this.col('retention_policy').findOne({ _id: 'default' });
    if (!r) return { enabled: false, retainDays: 365, archiveFirst: true };
    return { enabled: r.enabled, retainDays: r.retainDays, excludeTags: r.excludeTags || [], archiveFirst: r.archiveFirst };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.col('retention_policy').updateOne({ _id: 'default' }, { $set: policy }, { upsert: true });
  }

  // ─── Stats ───────────────────────────────────────────────

  async getStats() {
    const [totalAgents, activeAgents, totalUsers, totalAuditEvents] = await Promise.all([
      this.col('agents').countDocuments(),
      this.col('agents').countDocuments({ status: 'active' }),
      this.col('users').countDocuments(),
      this.col('audit_log').countDocuments(),
    ]);
    return { totalAgents, activeAgents, totalUsers, totalEmails: 0, totalAuditEvents };
  }

  // ─── Mappers ─────────────────────────────────────────────

  private docToAgent(r: any): Agent {
    return { id: r._id, name: r.name, email: r.email, role: r.role, status: r.status, metadata: r.metadata || {}, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  private docToUser(r: any): User {
    return { id: r._id, email: r.email, name: r.name, role: r.role, passwordHash: r.passwordHash, ssoProvider: r.ssoProvider, ssoSubject: r.ssoSubject, createdAt: r.createdAt, updatedAt: r.updatedAt, lastLoginAt: r.lastLoginAt || undefined };
  }

  private docToApiKey(r: any): ApiKey {
    return { id: r._id, name: r.name, keyHash: r.keyHash, keyPrefix: r.keyPrefix, scopes: r.scopes || [], createdBy: r.createdBy, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt || undefined, expiresAt: r.expiresAt || undefined, revoked: r.revoked };
  }

  private docToRule(r: any): EmailRule {
    return { id: r._id, name: r.name, agentId: r.agentId, conditions: r.conditions || {}, actions: r.actions || {}, priority: r.priority, enabled: r.enabled, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
}
