/**
 * DynamoDB Database Adapter
 * 
 * For AWS-native organizations. Uses single-table design
 * with GSIs for efficient access patterns.
 * Requires @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb.
 */

import { randomUUID, createHash } from 'crypto';
import {
  DatabaseAdapter, DatabaseConfig,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './adapter.js';

let ddbLib: any;
let ddbDocLib: any;

async function getDdb() {
  if (!ddbLib) {
    try {
      ddbLib = await import('@aws-sdk/client-dynamodb');
      ddbDocLib = await import('@aws-sdk/lib-dynamodb');
    } catch {
      throw new Error('DynamoDB drivers not found. Install: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb');
    }
  }
  return { ddbLib, ddbDocLib };
}

const TABLE = 'agenticmail_enterprise';

// Single-table design: PK = entity type, SK = entity ID
// GSI1: GSI1PK/GSI1SK for secondary lookups (email, name, etc.)

function pk(type: string) { return `${type}`; }
function sk(id: string) { return id; }

export class DynamoAdapter extends DatabaseAdapter {
  readonly type = 'dynamodb' as const;
  private client: any = null;
  private docClient: any = null;
  private tableName = TABLE;

  async connect(config: DatabaseConfig): Promise<void> {
    const { ddbLib, ddbDocLib } = await getDdb();
    const opts: any = {};
    if (config.region) opts.region = config.region;
    if (config.accessKeyId && config.secretAccessKey) {
      opts.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
    }
    if (config.connectionString) {
      // Local DynamoDB endpoint
      opts.endpoint = config.connectionString;
    }
    if (config.options?.tableName) this.tableName = config.options.tableName as string;

    this.client = new ddbLib.DynamoDBClient(opts);
    this.docClient = ddbDocLib.DynamoDBDocumentClient.from(this.client);
  }

  async disconnect(): Promise<void> {
    if (this.client) this.client.destroy();
  }

  isConnected(): boolean { return this.client !== null; }

  private async put(item: any): Promise<void> {
    const { ddbDocLib } = await getDdb();
    await this.docClient.send(new ddbDocLib.PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async getItem(pkVal: string, skVal: string): Promise<any> {
    const { ddbDocLib } = await getDdb();
    const result = await this.docClient.send(new ddbDocLib.GetCommand({
      TableName: this.tableName, Key: { PK: pkVal, SK: skVal },
    }));
    return result.Item || null;
  }

  private async query(pkVal: string, opts?: { limit?: number; sk?: { begins?: string }; index?: string; pkField?: string }): Promise<any[]> {
    const { ddbDocLib } = await getDdb();
    const params: any = {
      TableName: this.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': opts?.pkField || 'PK' },
      ExpressionAttributeValues: { ':pk': pkVal },
    };
    if (opts?.sk?.begins) {
      params.KeyConditionExpression += ' AND begins_with(#sk, :skPrefix)';
      params.ExpressionAttributeNames['#sk'] = 'SK';
      params.ExpressionAttributeValues[':skPrefix'] = opts.sk.begins;
    }
    if (opts?.index) params.IndexName = opts.index;
    if (opts?.limit) params.Limit = opts.limit;
    params.ScanIndexForward = false;
    const result = await this.docClient.send(new ddbDocLib.QueryCommand(params));
    return result.Items || [];
  }

  private async deleteItem(pkVal: string, skVal: string): Promise<void> {
    const { ddbDocLib } = await getDdb();
    await this.docClient.send(new ddbDocLib.DeleteCommand({
      TableName: this.tableName, Key: { PK: pkVal, SK: skVal },
    }));
  }

  async migrate(): Promise<void> {
    // Create table if needed (works for local DynamoDB; production tables should be pre-created via IaC)
    const { ddbLib } = await getDdb();
    try {
      await this.client.send(new ddbLib.CreateTableCommand({
        TableName: this.tableName,
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }));
      // Wait for table to be active
      const waiter = new ddbLib.DescribeTableCommand({ TableName: this.tableName });
      for (let i = 0; i < 30; i++) {
        const desc = await this.client.send(waiter);
        if (desc.Table?.TableStatus === 'ACTIVE') break;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err: any) {
      if (!err.name?.includes('ResourceInUse') && !err.message?.includes('already exists')) throw err;
    }

    // Seed defaults
    const existing = await this.getItem(pk('SETTINGS'), 'default');
    if (!existing) {
      await this.put({ PK: pk('SETTINGS'), SK: 'default', name: '', subdomain: '', plan: 'free', primaryColor: '#6366f1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    const retPol = await this.getItem(pk('RETENTION'), 'default');
    if (!retPol) {
      await this.put({ PK: pk('RETENTION'), SK: 'default', enabled: false, retainDays: 365, excludeTags: [], archiveFirst: true });
    }
  }

  // ─── Company ─────────────────────────────────────────────

  async getSettings(): Promise<CompanySettings> {
    const r = await this.getItem(pk('SETTINGS'), 'default');
    if (!r) return null!;
    return { id: 'default', name: r.name, domain: r.domain, subdomain: r.subdomain, smtpHost: r.smtpHost, smtpPort: r.smtpPort, smtpUser: r.smtpUser, smtpPass: r.smtpPass, dkimPrivateKey: r.dkimPrivateKey, logoUrl: r.logoUrl, primaryColor: r.primaryColor, plan: r.plan, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) };
  }

  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    const current = await this.getItem(pk('SETTINGS'), 'default') || {};
    const { id, ...rest } = updates as any;
    await this.put({ ...current, ...rest, PK: pk('SETTINGS'), SK: 'default', updatedAt: new Date().toISOString() });
    return this.getSettings();
  }

  // ─── Agents ──────────────────────────────────────────────

  async createAgent(input: AgentInput): Promise<Agent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const email = input.email || `${input.name.toLowerCase().replace(/\s+/g, '-')}@localhost`;
    const item = {
      PK: pk('AGENT'), SK: id,
      GSI1PK: 'AGENT_NAME', GSI1SK: input.name,
      name: input.name, email, role: input.role || 'assistant', status: 'active',
      metadata: input.metadata || {}, createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
    await this.put(item);
    return this.itemToAgent(item);
  }

  async getAgent(id: string): Promise<Agent | null> {
    const r = await this.getItem(pk('AGENT'), id);
    return r ? this.itemToAgent(r) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const items = await this.query('AGENT_NAME', { index: 'GSI1', pkField: 'GSI1PK', sk: { begins: name }, limit: 1 });
    return items.length > 0 ? this.itemToAgent(items[0]) : null;
  }

  async listAgents(opts?: { status?: string; limit?: number; offset?: number }): Promise<Agent[]> {
    // DynamoDB doesn't support offset natively; scan AGENT partition
    const items = await this.query(pk('AGENT'), { limit: (opts?.limit || 50) + (opts?.offset || 0) });
    let result = items.map((r: any) => this.itemToAgent(r));
    if (opts?.status) result = result.filter(a => a.status === opts.status);
    if (opts?.offset) result = result.slice(opts.offset);
    if (opts?.limit) result = result.slice(0, opts.limit);
    return result;
  }

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent> {
    const current = await this.getItem(pk('AGENT'), id);
    if (!current) throw new Error('Agent not found');
    const merged = { ...current, updatedAt: new Date().toISOString() };
    for (const key of ['name', 'email', 'role', 'status', 'metadata']) {
      if ((updates as any)[key] !== undefined) merged[key] = (updates as any)[key];
    }
    if (updates.name) { merged.GSI1SK = updates.name; }
    await this.put(merged);
    return this.itemToAgent(merged);
  }

  async archiveAgent(id: string): Promise<void> {
    await this.updateAgent(id, { status: 'archived' } as any);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.deleteItem(pk('AGENT'), id);
  }

  async countAgents(status?: string): Promise<number> {
    const items = await this.query(pk('AGENT'));
    if (status) return items.filter((i: any) => i.status === status).length;
    return items.length;
  }

  // ─── Users ───────────────────────────────────────────────

  async createUser(input: UserInput): Promise<User> {
    const id = randomUUID();
    const now = new Date().toISOString();
    let passwordHash: string | null = null;
    if (input.password) {
      const { default: bcrypt } = await import('bcryptjs');
      passwordHash = await bcrypt.hash(input.password, 12);
    }
    const item = {
      PK: pk('USER'), SK: id,
      GSI1PK: 'USER_EMAIL', GSI1SK: input.email,
      email: input.email, name: input.name, role: input.role,
      passwordHash, ssoProvider: input.ssoProvider || null, ssoSubject: input.ssoSubject || null,
      createdAt: now, updatedAt: now, lastLoginAt: null,
    };
    await this.put(item);
    return this.itemToUser(item);
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.getItem(pk('USER'), id);
    return r ? this.itemToUser(r) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const items = await this.query('USER_EMAIL', { index: 'GSI1', pkField: 'GSI1PK', sk: { begins: email }, limit: 1 });
    return items.length > 0 ? this.itemToUser(items[0]) : null;
  }

  async getUserBySso(provider: string, subject: string): Promise<User | null> {
    // Full scan of USER partition — not ideal but SSO lookups are infrequent
    const items = await this.query(pk('USER'));
    const found = items.find((i: any) => i.ssoProvider === provider && i.ssoSubject === subject);
    return found ? this.itemToUser(found) : null;
  }

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]> {
    const items = await this.query(pk('USER'), { limit: (opts?.limit || 50) + (opts?.offset || 0) });
    let result = items.map((r: any) => this.itemToUser(r));
    if (opts?.offset) result = result.slice(opts.offset);
    if (opts?.limit) result = result.slice(0, opts.limit);
    return result;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const current = await this.getItem(pk('USER'), id);
    if (!current) throw new Error('User not found');
    const merged = { ...current, updatedAt: new Date().toISOString() };
    for (const key of ['email', 'name', 'role', 'lastLoginAt']) {
      if ((updates as any)[key] !== undefined) merged[key] = (updates as any)[key];
    }
    if (updates.email) { merged.GSI1SK = updates.email; }
    await this.put(merged);
    return this.itemToUser(merged);
  }

  async deleteUser(id: string): Promise<void> {
    await this.deleteItem(pk('USER'), id);
  }

  // ─── Audit ───────────────────────────────────────────────

  async logEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.put({
      PK: pk('AUDIT'), SK: `${now}#${id}`,
      GSI1PK: `AUDIT_ACTOR#${event.actor}`, GSI1SK: now,
      id, timestamp: now, actor: event.actor, actorType: event.actorType,
      action: event.action, resource: event.resource, details: event.details || {}, ip: event.ip || null,
    });
  }

  async queryAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; total: number }> {
    let items: any[];
    if (filters.actor) {
      items = await this.query(`AUDIT_ACTOR#${filters.actor}`, { index: 'GSI1', pkField: 'GSI1PK' });
    } else {
      items = await this.query(pk('AUDIT'));
    }
    // Apply filters client-side (DynamoDB limitations)
    if (filters.action) items = items.filter(i => i.action === filters.action);
    if (filters.resource) items = items.filter(i => i.resource?.includes(filters.resource));
    if (filters.from) items = items.filter(i => new Date(i.timestamp) >= filters.from!);
    if (filters.to) items = items.filter(i => new Date(i.timestamp) <= filters.to!);
    const total = items.length;
    if (filters.offset) items = items.slice(filters.offset);
    if (filters.limit) items = items.slice(0, filters.limit);
    return {
      events: items.map(r => ({ id: r.id || r.SK, timestamp: new Date(r.timestamp), actor: r.actor, actorType: r.actorType, action: r.action, resource: r.resource, details: r.details, ip: r.ip })),
      total,
    };
  }

  // ─── API Keys ────────────────────────────────────────────

  async createApiKey(input: ApiKeyInput): Promise<{ key: ApiKey; plaintext: string }> {
    const id = randomUUID();
    const plaintext = `ek_${randomUUID().replace(/-/g, '')}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const keyPrefix = plaintext.substring(0, 11);
    const now = new Date().toISOString();
    const item = {
      PK: pk('APIKEY'), SK: id,
      GSI1PK: 'APIKEY_HASH', GSI1SK: keyHash,
      name: input.name, keyHash, keyPrefix, scopes: input.scopes,
      createdBy: input.createdBy, createdAt: now, lastUsedAt: null,
      expiresAt: input.expiresAt?.toISOString() || null, revoked: false,
    };
    await this.put(item);
    return { key: this.itemToApiKey(item), plaintext };
  }

  async getApiKey(id: string): Promise<ApiKey | null> {
    const r = await this.getItem(pk('APIKEY'), id);
    return r ? this.itemToApiKey(r) : null;
  }

  async validateApiKey(plaintext: string): Promise<ApiKey | null> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const items = await this.query('APIKEY_HASH', { index: 'GSI1', pkField: 'GSI1PK', sk: { begins: keyHash }, limit: 1 });
    if (items.length === 0 || items[0].revoked) return null;
    const key = this.itemToApiKey(items[0]);
    if (key.expiresAt && new Date() > key.expiresAt) return null;
    items[0].lastUsedAt = new Date().toISOString();
    await this.put(items[0]);
    return key;
  }

  async listApiKeys(opts?: { createdBy?: string }): Promise<ApiKey[]> {
    const items = await this.query(pk('APIKEY'));
    let result = items;
    if (opts?.createdBy) result = result.filter((i: any) => i.createdBy === opts.createdBy);
    return result.map((r: any) => this.itemToApiKey(r));
  }

  async revokeApiKey(id: string): Promise<void> {
    const current = await this.getItem(pk('APIKEY'), id);
    if (current) { current.revoked = true; await this.put(current); }
  }

  // ─── Rules ───────────────────────────────────────────────

  async createRule(rule: Omit<EmailRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<EmailRule> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const item = { PK: pk('RULE'), SK: id, ...rule, createdAt: now, updatedAt: now };
    await this.put(item);
    return this.itemToRule(item);
  }

  async getRules(agentId?: string): Promise<EmailRule[]> {
    const items = await this.query(pk('RULE'));
    let result = items;
    if (agentId) result = result.filter((i: any) => !i.agentId || i.agentId === agentId);
    return result.map((r: any) => this.itemToRule(r)).sort((a, b) => b.priority - a.priority);
  }

  async updateRule(id: string, updates: Partial<EmailRule>): Promise<EmailRule> {
    const current = await this.getItem(pk('RULE'), id);
    if (!current) throw new Error('Rule not found');
    const { id: _id, createdAt, ...rest } = updates as any;
    const merged = { ...current, ...rest, updatedAt: new Date().toISOString() };
    await this.put(merged);
    return this.itemToRule(merged);
  }

  async deleteRule(id: string): Promise<void> {
    await this.deleteItem(pk('RULE'), id);
  }

  // ─── Retention ───────────────────────────────────────────

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const r = await this.getItem(pk('RETENTION'), 'default');
    if (!r) return { enabled: false, retainDays: 365, archiveFirst: true };
    return { enabled: r.enabled, retainDays: r.retainDays, excludeTags: r.excludeTags || [], archiveFirst: r.archiveFirst };
  }

  async setRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    await this.put({ PK: pk('RETENTION'), SK: 'default', ...policy });
  }

  // ─── Stats ───────────────────────────────────────────────

  async getStats() {
    const [agents, users, audit] = await Promise.all([
      this.query(pk('AGENT')),
      this.query(pk('USER')),
      this.query(pk('AUDIT')),
    ]);
    return {
      totalAgents: agents.length,
      activeAgents: agents.filter((a: any) => a.status === 'active').length,
      totalUsers: users.length,
      totalEmails: 0,
      totalAuditEvents: audit.length,
    };
  }

  // ─── Mappers ─────────────────────────────────────────────

  private itemToAgent(r: any): Agent {
    return { id: r.SK || r.id, name: r.name, email: r.email, role: r.role, status: r.status, metadata: r.metadata || {}, createdBy: r.createdBy, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) };
  }

  private itemToUser(r: any): User {
    return { id: r.SK || r.id, email: r.email, name: r.name, role: r.role, passwordHash: r.passwordHash, ssoProvider: r.ssoProvider, ssoSubject: r.ssoSubject, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt), lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt) : undefined };
  }

  private itemToApiKey(r: any): ApiKey {
    return { id: r.SK || r.id, name: r.name, keyHash: r.keyHash, keyPrefix: r.keyPrefix, scopes: r.scopes || [], createdBy: r.createdBy, createdAt: new Date(r.createdAt), lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : undefined, expiresAt: r.expiresAt ? new Date(r.expiresAt) : undefined, revoked: r.revoked };
  }

  private itemToRule(r: any): EmailRule {
    return { id: r.SK || r.id, name: r.name, agentId: r.agentId, conditions: r.conditions || {}, actions: r.actions || {}, priority: r.priority || 0, enabled: r.enabled ?? true, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) };
  }
}
