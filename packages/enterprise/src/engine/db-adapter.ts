/**
 * Engine Database Adapter
 *
 * Extends the base DatabaseAdapter with engine-specific persistence.
 * Works with SQLite, Postgres, MySQL, Turso — anything that speaks SQL.
 *
 * MongoDB and DynamoDB would need their own implementations.
 */

import type { ManagedAgent, AgentState, StateTransition, AgentUsage, LifecycleEvent } from './lifecycle.js';
import type { AgentPermissionProfile } from './skills.js';
import type { Organization, OrgPlan } from './tenant.js';
import type { ApprovalRequest, ApprovalPolicy } from './approvals.js';
import type { KnowledgeBase, KBDocument, KBChunk } from './knowledge.js';
import type { ActivityEvent, ToolCallRecord, ConversationEntry } from './activity.js';
import type { AgentConfig } from './agent-config.js';
import {
  ENGINE_TABLES,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  MIGRATIONS_TABLE_POSTGRES,
  sqliteToPostgres,
  sqliteToMySQL,
  type Migration,
  type DynamicTableDef,
} from './db-schema.js';

// ─── Types ──────────────────────────────────────────────

export interface EngineDB {
  // Execute raw SQL (adapter-specific)
  run(sql: string, params?: any[]): Promise<void>;
  get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
}

// ─── Engine Database Layer ──────────────────────────────

export class EngineDatabase {
  private db: EngineDB;
  private dialect: 'sqlite' | 'postgres' | 'mysql' | 'mongodb' | 'dynamodb' | 'turso';
  /** Raw driver handle for NoSQL migrations (MongoClient db, DynamoDB client, etc.) */
  private rawDriver?: any;

  constructor(db: EngineDB, dialect: 'sqlite' | 'postgres' | 'mysql' | 'mongodb' | 'dynamodb' | 'turso' = 'sqlite', rawDriver?: any) {
    this.db = db;
    this.dialect = dialect;
    this.rawDriver = rawDriver;
  }

  // ─── Migration System ─────────────────────────────────

  /**
   * Run all pending migrations in order.
   * Creates the migration tracking table first, then applies any unapplied migrations.
   */
  async migrate(): Promise<{ applied: number; total: number }> {
    // Create migration tracking table
    const trackingDDL = this.dialect === 'postgres' ? MIGRATIONS_TABLE_POSTGRES : MIGRATIONS_TABLE;
    for (const stmt of this.splitStatements(trackingDDL)) {
      await this.db.run(stmt);
    }

    // Get already-applied versions
    const applied = await this.db.all<{ version: number }>('SELECT version FROM engine_migrations ORDER BY version');
    const appliedSet = new Set(applied.map(r => r.version));

    let count = 0;
    for (const migration of MIGRATIONS) {
      if (appliedSet.has(migration.version)) continue;

      // Pick the right SQL for the dialect
      if ((this.dialect === 'mongodb' || this.dialect === 'dynamodb') && migration.nosql) {
        await migration.nosql(this.rawDriver, this.dialect);
      } else {
        const sql = this.getSqlForDialect(migration);
        if (sql) {
          for (const stmt of this.splitStatements(sql)) {
            await this.db.run(stmt);
          }
        }
      }

      // Record migration
      await this.db.run(
        'INSERT INTO engine_migrations (version, name) VALUES (?, ?)',
        [migration.version, migration.name]
      );
      count++;
    }

    return { applied: count, total: MIGRATIONS.length };
  }

  /**
   * Register and create a dynamic table at runtime.
   * Used by plugins, skills, or engine extensions that need their own storage.
   * Table name is auto-prefixed with `ext_` to avoid collisions with core tables.
   */
  async createDynamicTable(def: DynamicTableDef): Promise<void> {
    const prefixedName = def.name.startsWith('ext_') ? def.name : `ext_${def.name}`;

    if (this.dialect === 'mongodb' && def.mongoSetup) {
      await def.mongoSetup(this.rawDriver);
      return;
    }
    if (this.dialect === 'dynamodb' && def.dynamoSetup) {
      await def.dynamoSetup(this.rawDriver);
      return;
    }

    // SQL-based: pick dialect-specific DDL or auto-convert
    let ddl: string;
    if (this.dialect === 'postgres' && def.postgres) {
      ddl = def.postgres;
    } else if (this.dialect === 'mysql' && def.mysql) {
      ddl = def.mysql;
    } else if (this.dialect === 'postgres') {
      ddl = sqliteToPostgres(def.sql);
    } else if (this.dialect === 'mysql') {
      ddl = sqliteToMySQL(def.sql);
    } else {
      ddl = def.sql;
    }

    // Replace the table name with prefixed version
    ddl = ddl.replace(new RegExp(`\\b${def.name}\\b`, 'g'), prefixedName);

    for (const stmt of this.splitStatements(ddl)) {
      await this.db.run(stmt);
    }

    // Create any additional indexes
    if (def.indexes) {
      for (const idx of def.indexes) {
        const prefixedIdx = idx.replace(new RegExp(`\\b${def.name}\\b`, 'g'), prefixedName);
        await this.db.run(prefixedIdx);
      }
    }
  }

  /**
   * Run arbitrary SQL — for custom queries on dynamic tables.
   * Returns rows for SELECT, void for mutations.
   */
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return this.db.all<T>(sql, params);
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    return this.db.run(sql, params);
  }

  /**
   * List all dynamic (ext_*) tables currently in the database.
   */
  async listDynamicTables(): Promise<string[]> {
    if (this.dialect === 'postgres') {
      const rows = await this.db.all<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'ext_%'"
      );
      return rows.map(r => r.tablename);
    } else if (this.dialect === 'mysql') {
      const rows = await this.db.all<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'ext_%'"
      );
      return rows.map(r => r.table_name);
    } else {
      // SQLite / Turso
      const rows = await this.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ext_%'"
      );
      return rows.map(r => r.name);
    }
  }

  // ─── Helpers ────────────────────────────────────────

  private splitStatements(sql: string): string[] {
    return sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  }

  private getSqlForDialect(migration: Migration): string | undefined {
    if (this.dialect === 'postgres' && migration.postgres) return migration.postgres;
    if (this.dialect === 'mysql' && migration.mysql) return migration.mysql;
    if (this.dialect === 'postgres' && migration.sql) return sqliteToPostgres(migration.sql);
    if (this.dialect === 'mysql' && migration.sql) return sqliteToMySQL(migration.sql);
    return migration.sql;
  }

  // ─── Managed Agents ─────────────────────────────────

  async upsertManagedAgent(agent: ManagedAgent): Promise<void> {
    await this.db.run(`
      INSERT INTO managed_agents (id, org_id, name, display_name, state, config, health, usage, permission_profile_id, version, last_deployed_at, last_health_check_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        config = excluded.config,
        health = excluded.health,
        usage = excluded.usage,
        permission_profile_id = excluded.permission_profile_id,
        version = excluded.version,
        last_deployed_at = excluded.last_deployed_at,
        last_health_check_at = excluded.last_health_check_at,
        updated_at = excluded.updated_at
    `, [
      agent.id, agent.orgId, agent.config.name, agent.config.displayName,
      agent.state, JSON.stringify(agent.config), JSON.stringify(agent.health),
      JSON.stringify(agent.usage), agent.config.permissionProfileId,
      agent.version, agent.lastDeployedAt || null, agent.lastHealthCheckAt || null,
      agent.createdAt, agent.updatedAt,
    ]);
  }

  async getManagedAgent(id: string): Promise<ManagedAgent | null> {
    const row = await this.db.get<any>('SELECT * FROM managed_agents WHERE id = ?', [id]);
    return row ? this.rowToManagedAgent(row) : null;
  }

  async getManagedAgentsByOrg(orgId: string): Promise<ManagedAgent[]> {
    const rows = await this.db.all<any>('SELECT * FROM managed_agents WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
    return rows.map(r => this.rowToManagedAgent(r));
  }

  async getManagedAgentsByState(state: AgentState): Promise<ManagedAgent[]> {
    const rows = await this.db.all<any>('SELECT * FROM managed_agents WHERE state = ?', [state]);
    return rows.map(r => this.rowToManagedAgent(r));
  }

  async deleteManagedAgent(id: string): Promise<void> {
    await this.db.run('DELETE FROM managed_agents WHERE id = ?', [id]);
  }

  async countManagedAgents(orgId: string, state?: AgentState): Promise<number> {
    const sql = state
      ? 'SELECT COUNT(*) as count FROM managed_agents WHERE org_id = ? AND state = ?'
      : 'SELECT COUNT(*) as count FROM managed_agents WHERE org_id = ?';
    const row = await this.db.get<any>(sql, state ? [orgId, state] : [orgId]);
    return row?.count || 0;
  }

  // ─── State History ──────────────────────────────────

  async addStateTransition(agentId: string, transition: StateTransition): Promise<void> {
    await this.db.run(`
      INSERT INTO agent_state_history (id, agent_id, from_state, to_state, reason, triggered_by, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      crypto.randomUUID(), agentId, transition.from, transition.to,
      transition.reason, transition.triggeredBy, transition.error || null, transition.timestamp,
    ]);
  }

  async getStateHistory(agentId: string, limit: number = 50): Promise<StateTransition[]> {
    const rows = await this.db.all<any>(
      'SELECT * FROM agent_state_history WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
      [agentId, limit]
    );
    return rows.map(r => ({
      from: r.from_state, to: r.to_state, reason: r.reason,
      triggeredBy: r.triggered_by, timestamp: r.created_at, error: r.error,
    }));
  }

  // ─── Permission Profiles ────────────────────────────

  async upsertPermissionProfile(orgId: string, profile: AgentPermissionProfile): Promise<void> {
    await this.db.run(`
      INSERT INTO permission_profiles (id, org_id, name, description, config, is_preset, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        config = excluded.config, updated_at = excluded.updated_at
    `, [
      profile.id, orgId, profile.name, profile.description || null,
      JSON.stringify(profile), profile.createdAt, profile.updatedAt,
    ]);
  }

  async getPermissionProfile(id: string): Promise<AgentPermissionProfile | null> {
    const row = await this.db.get<any>('SELECT * FROM permission_profiles WHERE id = ?', [id]);
    return row ? JSON.parse(row.config) : null;
  }

  async getPermissionProfilesByOrg(orgId: string): Promise<AgentPermissionProfile[]> {
    const rows = await this.db.all<any>('SELECT config FROM permission_profiles WHERE org_id = ? ORDER BY name', [orgId]);
    return rows.map(r => JSON.parse(r.config));
  }

  async deletePermissionProfile(id: string): Promise<void> {
    await this.db.run('DELETE FROM permission_profiles WHERE id = ?', [id]);
  }

  // ─── Organizations ──────────────────────────────────

  async upsertOrganization(org: Organization): Promise<void> {
    await this.db.run(`
      INSERT INTO organizations (id, name, slug, plan, limits, usage, settings, sso_config, allowed_domains, billing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, slug = excluded.slug, plan = excluded.plan,
        limits = excluded.limits, usage = excluded.usage, settings = excluded.settings,
        sso_config = excluded.sso_config, allowed_domains = excluded.allowed_domains,
        billing = excluded.billing, updated_at = excluded.updated_at
    `, [
      org.id, org.name, org.slug, org.plan,
      JSON.stringify(org.limits), JSON.stringify(org.usage),
      JSON.stringify(org.settings), org.ssoConfig ? JSON.stringify(org.ssoConfig) : null,
      JSON.stringify(org.allowedDomains), org.billing ? JSON.stringify(org.billing) : null,
      org.createdAt, org.updatedAt,
    ]);
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const row = await this.db.get<any>('SELECT * FROM organizations WHERE id = ?', [id]);
    return row ? this.rowToOrg(row) : null;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    const row = await this.db.get<any>('SELECT * FROM organizations WHERE slug = ?', [slug]);
    return row ? this.rowToOrg(row) : null;
  }

  async listOrganizations(): Promise<Organization[]> {
    const rows = await this.db.all<any>('SELECT * FROM organizations ORDER BY created_at DESC');
    return rows.map(r => this.rowToOrg(r));
  }

  async deleteOrganization(id: string): Promise<void> {
    await this.db.run('DELETE FROM organizations WHERE id = ?', [id]);
  }

  // ─── Knowledge Bases ────────────────────────────────

  async upsertKnowledgeBase(kb: KnowledgeBase): Promise<void> {
    await this.db.run(`
      INSERT INTO knowledge_bases (id, org_id, name, description, agent_ids, config, stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        agent_ids = excluded.agent_ids, config = excluded.config,
        stats = excluded.stats, updated_at = excluded.updated_at
    `, [
      kb.id, kb.orgId, kb.name, kb.description || null,
      JSON.stringify(kb.agentIds), JSON.stringify(kb.config),
      JSON.stringify(kb.stats), kb.createdAt, kb.updatedAt,
    ]);
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    const row = await this.db.get<any>('SELECT * FROM knowledge_bases WHERE id = ?', [id]);
    if (!row) return null;
    const kb: any = {
      id: row.id, orgId: row.org_id, name: row.name, description: row.description,
      agentIds: JSON.parse(row.agent_ids), config: JSON.parse(row.config),
      stats: JSON.parse(row.stats), createdAt: row.created_at, updatedAt: row.updated_at,
      documents: [],
    };
    // Load documents
    kb.documents = await this.getKBDocuments(id);
    return kb;
  }

  async getKnowledgeBasesByOrg(orgId: string): Promise<KnowledgeBase[]> {
    const rows = await this.db.all<any>('SELECT * FROM knowledge_bases WHERE org_id = ? ORDER BY name', [orgId]);
    return rows.map(r => ({
      id: r.id, orgId: r.org_id, name: r.name, description: r.description,
      agentIds: JSON.parse(r.agent_ids), config: JSON.parse(r.config),
      stats: JSON.parse(r.stats), createdAt: r.created_at, updatedAt: r.updated_at,
      documents: [], // Loaded on demand
    }));
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    await this.db.run('DELETE FROM knowledge_bases WHERE id = ?', [id]);
  }

  // ─── KB Documents & Chunks ──────────────────────────

  async insertKBDocument(doc: KBDocument): Promise<void> {
    await this.db.run(`
      INSERT INTO kb_documents (id, knowledge_base_id, name, source_type, source_url, mime_type, size, metadata, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      doc.id, doc.knowledgeBaseId, doc.name, doc.sourceType,
      doc.sourceUrl || null, doc.mimeType, doc.size,
      JSON.stringify(doc.metadata), doc.status, doc.error || null,
      doc.createdAt, doc.updatedAt,
    ]);

    // Insert chunks
    for (const chunk of doc.chunks) {
      await this.db.run(`
        INSERT INTO kb_chunks (id, document_id, content, token_count, position, embedding, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        chunk.id, doc.id, chunk.content, chunk.tokenCount,
        chunk.position, chunk.embedding ? Buffer.from(new Float32Array(chunk.embedding).buffer) : null,
        JSON.stringify(chunk.metadata),
      ]);
    }
  }

  async getKBDocuments(kbId: string): Promise<KBDocument[]> {
    const docs = await this.db.all<any>('SELECT * FROM kb_documents WHERE knowledge_base_id = ?', [kbId]);
    const result: KBDocument[] = [];
    for (const d of docs) {
      const chunks = await this.db.all<any>('SELECT * FROM kb_chunks WHERE document_id = ? ORDER BY position', [d.id]);
      result.push({
        id: d.id, knowledgeBaseId: d.knowledge_base_id, name: d.name,
        sourceType: d.source_type, sourceUrl: d.source_url, mimeType: d.mime_type,
        size: d.size, metadata: JSON.parse(d.metadata), status: d.status, error: d.error,
        createdAt: d.created_at, updatedAt: d.updated_at,
        chunks: chunks.map((c: any) => ({
          id: c.id, documentId: c.document_id, content: c.content,
          tokenCount: c.token_count, position: c.position,
          embedding: c.embedding ? Array.from(new Float32Array(c.embedding)) : undefined,
          metadata: JSON.parse(c.metadata),
        })),
      });
    }
    return result;
  }

  async deleteKBDocument(docId: string): Promise<void> {
    await this.db.run('DELETE FROM kb_documents WHERE id = ?', [docId]);
  }

  // ─── Tool Calls (Activity) ──────────────────────────

  async insertToolCall(record: ToolCallRecord): Promise<void> {
    await this.db.run(`
      INSERT INTO tool_calls (id, agent_id, org_id, session_id, tool_id, tool_name, parameters, result, timing, cost, permission, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id, record.agentId, record.orgId, record.sessionId || null,
      record.toolId, record.toolName, JSON.stringify(record.parameters),
      record.result ? JSON.stringify(record.result) : null,
      JSON.stringify(record.timing), record.cost ? JSON.stringify(record.cost) : null,
      JSON.stringify(record.permission), record.timing.startedAt,
    ]);
  }

  async updateToolCallResult(id: string, result: ToolCallRecord['result'], timing: ToolCallRecord['timing'], cost?: ToolCallRecord['cost']): Promise<void> {
    await this.db.run(
      'UPDATE tool_calls SET result = ?, timing = ?, cost = ? WHERE id = ?',
      [JSON.stringify(result), JSON.stringify(timing), cost ? JSON.stringify(cost) : null, id]
    );
  }

  async getToolCalls(opts: { agentId?: string; orgId?: string; toolId?: string; since?: string; limit?: number }): Promise<ToolCallRecord[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.orgId) { conditions.push('org_id = ?'); params.push(opts.orgId); }
    if (opts.toolId) { conditions.push('tool_id = ?'); params.push(opts.toolId); }
    if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(opts.limit || 50);
    const rows = await this.db.all<any>(`SELECT * FROM tool_calls ${where} ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(r => ({
      id: r.id, agentId: r.agent_id, orgId: r.org_id, sessionId: r.session_id,
      toolId: r.tool_id, toolName: r.tool_name, parameters: JSON.parse(r.parameters || '{}'),
      result: r.result ? JSON.parse(r.result) : undefined,
      timing: JSON.parse(r.timing), cost: r.cost ? JSON.parse(r.cost) : undefined,
      permission: JSON.parse(r.permission),
    }));
  }

  // ─── Activity Events ────────────────────────────────

  async insertActivityEvent(event: ActivityEvent): Promise<void> {
    await this.db.run(`
      INSERT INTO activity_events (id, agent_id, org_id, session_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [event.id, event.agentId, event.orgId, event.sessionId || null, event.type, JSON.stringify(event.data), event.timestamp]);
  }

  async getActivityEvents(opts: { agentId?: string; orgId?: string; types?: string[]; since?: string; limit?: number }): Promise<ActivityEvent[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.orgId) { conditions.push('org_id = ?'); params.push(opts.orgId); }
    if (opts.types?.length) { conditions.push(`type IN (${opts.types.map(() => '?').join(',')})`); params.push(...opts.types); }
    if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(opts.limit || 50);
    const rows = await this.db.all<any>(`SELECT * FROM activity_events ${where} ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(r => ({
      id: r.id, agentId: r.agent_id, orgId: r.org_id, sessionId: r.session_id,
      type: r.type, data: JSON.parse(r.data), timestamp: r.created_at,
    }));
  }

  // ─── Conversations ──────────────────────────────────

  async insertConversation(entry: ConversationEntry): Promise<void> {
    await this.db.run(`
      INSERT INTO conversations (id, agent_id, session_id, role, content, channel, token_count, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id, entry.agentId, entry.sessionId, entry.role,
      entry.content, entry.channel || null, entry.tokenCount,
      entry.toolCalls ? JSON.stringify(entry.toolCalls) : null, entry.timestamp,
    ]);
  }

  async getConversation(sessionId: string, limit: number = 50): Promise<ConversationEntry[]> {
    const rows = await this.db.all<any>(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
      [sessionId, limit]
    );
    return rows.map(r => ({
      id: r.id, agentId: r.agent_id, sessionId: r.session_id, role: r.role,
      content: r.content, channel: r.channel, tokenCount: r.token_count,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined, timestamp: r.created_at,
    }));
  }

  // ─── Approval Requests ──────────────────────────────

  async insertApprovalRequest(req: ApprovalRequest, orgId: string): Promise<void> {
    await this.db.run(`
      INSERT INTO approval_requests (id, agent_id, agent_name, org_id, tool_id, tool_name, reason, risk_level, side_effects, parameters, context, status, decision, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.id, req.agentId, req.agentName, orgId, req.toolId, req.toolName,
      req.reason, req.riskLevel, JSON.stringify(req.sideEffects),
      req.parameters ? JSON.stringify(req.parameters) : null, req.context || null,
      req.status, req.decision ? JSON.stringify(req.decision) : null,
      req.expiresAt, req.createdAt,
    ]);
  }

  async updateApprovalRequest(id: string, status: string, decision?: any): Promise<void> {
    await this.db.run(
      'UPDATE approval_requests SET status = ?, decision = ? WHERE id = ?',
      [status, decision ? JSON.stringify(decision) : null, id]
    );
  }

  async getApprovalRequests(opts: { orgId?: string; status?: string; agentId?: string; limit?: number }): Promise<ApprovalRequest[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.orgId) { conditions.push('org_id = ?'); params.push(opts.orgId); }
    if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
    if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(opts.limit || 50);
    const rows = await this.db.all<any>(`SELECT * FROM approval_requests ${where} ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(r => ({
      id: r.id, agentId: r.agent_id, agentName: r.agent_name, toolId: r.tool_id,
      toolName: r.tool_name, reason: r.reason, riskLevel: r.risk_level,
      sideEffects: JSON.parse(r.side_effects), parameters: r.parameters ? JSON.parse(r.parameters) : undefined,
      context: r.context, status: r.status,
      decision: r.decision ? JSON.parse(r.decision) : undefined,
      createdAt: r.created_at, expiresAt: r.expires_at,
    }));
  }

  // ─── Approval Policies ──────────────────────────────

  async upsertApprovalPolicy(orgId: string, policy: ApprovalPolicy): Promise<void> {
    await this.db.run(`
      INSERT INTO approval_policies (id, org_id, name, description, triggers, approvers, timeout, notify, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        triggers = excluded.triggers, approvers = excluded.approvers,
        timeout = excluded.timeout, notify = excluded.notify,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `, [
      policy.id, orgId, policy.name, policy.description || null,
      JSON.stringify(policy.triggers), JSON.stringify(policy.approvers),
      JSON.stringify(policy.timeout), JSON.stringify(policy.notify),
      policy.enabled ? 1 : 0, new Date().toISOString(), new Date().toISOString(),
    ]);
  }

  async getApprovalPolicies(orgId: string): Promise<ApprovalPolicy[]> {
    const rows = await this.db.all<any>('SELECT * FROM approval_policies WHERE org_id = ? ORDER BY name', [orgId]);
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggers: JSON.parse(r.triggers), approvers: JSON.parse(r.approvers),
      timeout: JSON.parse(r.timeout), notify: JSON.parse(r.notify),
      enabled: !!r.enabled,
    }));
  }

  async deleteApprovalPolicy(id: string): Promise<void> {
    await this.db.run('DELETE FROM approval_policies WHERE id = ?', [id]);
  }

  // ─── Aggregate Stats ───────────────────────────────

  async getEngineStats(orgId: string): Promise<{
    totalManagedAgents: number;
    runningAgents: number;
    totalToolCallsToday: number;
    totalActivityToday: number;
    pendingApprovals: number;
    totalKnowledgeBases: number;
  }> {
    const today = new Date().toISOString().split('T')[0];

    const [agents, running, toolCalls, activity, approvals, kbs] = await Promise.all([
      this.db.get<any>('SELECT COUNT(*) as c FROM managed_agents WHERE org_id = ?', [orgId]),
      this.db.get<any>('SELECT COUNT(*) as c FROM managed_agents WHERE org_id = ? AND state = ?', [orgId, 'running']),
      this.db.get<any>('SELECT COUNT(*) as c FROM tool_calls WHERE org_id = ? AND created_at >= ?', [orgId, today]),
      this.db.get<any>('SELECT COUNT(*) as c FROM activity_events WHERE org_id = ? AND created_at >= ?', [orgId, today]),
      this.db.get<any>('SELECT COUNT(*) as c FROM approval_requests WHERE org_id = ? AND status = ?', [orgId, 'pending']),
      this.db.get<any>('SELECT COUNT(*) as c FROM knowledge_bases WHERE org_id = ?', [orgId]),
    ]);

    return {
      totalManagedAgents: agents?.c || 0,
      runningAgents: running?.c || 0,
      totalToolCallsToday: toolCalls?.c || 0,
      totalActivityToday: activity?.c || 0,
      pendingApprovals: approvals?.c || 0,
      totalKnowledgeBases: kbs?.c || 0,
    };
  }

  /**
   * Cleanup old data based on retention
   */
  async cleanup(retainDays: number): Promise<{ toolCalls: number; events: number; conversations: number }> {
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();

    const tc = await this.db.get<any>('SELECT COUNT(*) as c FROM tool_calls WHERE created_at < ?', [cutoff]);
    const ev = await this.db.get<any>('SELECT COUNT(*) as c FROM activity_events WHERE created_at < ?', [cutoff]);
    const cv = await this.db.get<any>('SELECT COUNT(*) as c FROM conversations WHERE created_at < ?', [cutoff]);

    await this.db.run('DELETE FROM tool_calls WHERE created_at < ?', [cutoff]);
    await this.db.run('DELETE FROM activity_events WHERE created_at < ?', [cutoff]);
    await this.db.run('DELETE FROM conversations WHERE created_at < ?', [cutoff]);

    return {
      toolCalls: tc?.c || 0,
      events: ev?.c || 0,
      conversations: cv?.c || 0,
    };
  }

  // ─── Row Mappers ────────────────────────────────────

  private rowToManagedAgent(row: any): ManagedAgent {
    return {
      id: row.id,
      orgId: row.org_id,
      config: JSON.parse(row.config),
      state: row.state,
      stateHistory: [], // Loaded separately via getStateHistory
      health: JSON.parse(row.health || '{}'),
      usage: JSON.parse(row.usage || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastDeployedAt: row.last_deployed_at,
      lastHealthCheckAt: row.last_health_check_at,
      version: row.version,
    };
  }

  private rowToOrg(row: any): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan as OrgPlan,
      limits: JSON.parse(row.limits || '{}'),
      usage: JSON.parse(row.usage || '{}'),
      settings: JSON.parse(row.settings || '{}'),
      ssoConfig: row.sso_config ? JSON.parse(row.sso_config) : undefined,
      allowedDomains: JSON.parse(row.allowed_domains || '[]'),
      billing: row.billing ? JSON.parse(row.billing) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
