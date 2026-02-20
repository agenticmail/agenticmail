import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StalwartAdmin } from '../stalwart/admin.js';
import type { Agent, CreateAgentOptions, AgentRow, AgentRole } from './types.js';
import { DEFAULT_AGENT_ROLE } from './types.js';

function generateApiKey(): string {
  return `ak_${randomBytes(24).toString('hex')}`;
}

function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

const VALID_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function rowToAgent(row: AgentRow): Agent {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    apiKey: row.api_key,
    stalwartPrincipal: row.stalwart_principal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata,
    role: (row.role || 'secretary') as AgentRole,
  };
}

export class AccountManager {
  constructor(
    private db: Database.Database,
    private stalwart: StalwartAdmin,
  ) {}

  async create(options: CreateAgentOptions): Promise<Agent> {
    // Validate agent name for email-safe characters
    if (!options.name || !VALID_NAME_RE.test(options.name)) {
      throw new Error(`Invalid agent name "${options.name}": must match ${VALID_NAME_RE}`);
    }

    const id = uuidv4();
    const apiKey = generateApiKey();
    const password = options.password ?? generatePassword();
    const domain = options.domain ?? 'localhost';
    // RFC-compliant domain validation: each label must start/end with alphanumeric,
    // no consecutive dots, no hyphens at label boundaries, TLD must be 2+ alpha chars
    if (domain !== 'localhost' && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(domain)) {
      throw new Error(`Invalid domain "${domain}": must be a valid domain name`);
    }
    // Stalwart lowercases principal names and emails — match that to avoid auth mismatches
    const principalName = options.name.toLowerCase();
    const email = `${principalName}@${domain}`;

    // Ensure domain exists in Stalwart, then create principal
    await this.stalwart.ensureDomain(domain);
    await this.stalwart.createPrincipal({
      type: 'individual',
      name: principalName,
      secrets: [password],
      emails: [email],
      roles: ['user'],
      description: `AgenticMail agent: ${options.name}`,
    });

    // Build metadata, storing password for SMTP/IMAP auth
    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    metadata._password = password;
    if (options.gateway) {
      metadata._gateway = options.gateway;
    }

    const role = options.role ?? DEFAULT_AGENT_ROLE;

    // Store in SQLite — if this fails, clean up the Stalwart principal
    try {
      const stmt = this.db.prepare(`
        INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata, role)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, options.name, email, apiKey, principalName, JSON.stringify(metadata), role);
    } catch (err) {
      // Rollback Stalwart principal to avoid orphan
      try { await this.stalwart.deletePrincipal(principalName); } catch { /* best effort */ }
      throw err;
    }

    const agent = await this.getById(id);
    if (!agent) throw new Error('Failed to retrieve newly created agent');
    return agent;
  }

  async getById(id: string): Promise<Agent | null> {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?');
    const row = stmt.get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  async getByApiKey(apiKey: string): Promise<Agent | null> {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE api_key = ?');
    const row = stmt.get(apiKey) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  async getByName(name: string): Promise<Agent | null> {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE LOWER(name) = LOWER(?)');
    const row = stmt.get(name) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  async list(): Promise<Agent[]> {
    const stmt = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC');
    const rows = stmt.all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  async getByRole(role: AgentRole): Promise<Agent[]> {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE role = ? ORDER BY created_at DESC');
    const rows = stmt.all(role) as AgentRow[];
    return rows.map(rowToAgent);
  }

  async delete(id: string): Promise<boolean> {
    const agent = await this.getById(id);
    if (!agent) return false;

    // Delete from Stalwart
    try {
      await this.stalwart.deletePrincipal(agent.stalwartPrincipal);
    } catch {
      // Principal may already be gone
    }

    // Delete from SQLite
    const stmt = this.db.prepare('DELETE FROM agents WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<Agent | null> {
    // Merge with existing metadata, preserving internal _-prefixed fields
    const existing = await this.getById(id);
    if (!existing) return null;
    const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    // Preserve all internal (_-prefixed) keys from existing metadata
    for (const [k, v] of Object.entries(existingMeta)) {
      if (k.startsWith('_')) merged[k] = v;
    }
    // Apply user-supplied metadata (skip _-prefixed keys from user input)
    for (const [k, v] of Object.entries(metadata)) {
      if (!k.startsWith('_')) merged[k] = v;
    }
    const stmt = this.db.prepare(`
      UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?
    `);
    stmt.run(JSON.stringify(merged), id);
    return this.getById(id);
  }

  async getCredentials(id: string): Promise<{ email: string; password: string; principal: string; smtpHost: string; smtpPort: number; imapHost: string; imapPort: number } | null> {
    const agent = await this.getById(id);
    if (!agent) return null;

    return {
      email: agent.email,
      password: (agent.metadata as Record<string, any>)?._password || '',
      principal: agent.stalwartPrincipal,
      smtpHost: 'localhost',
      smtpPort: 587,
      imapHost: 'localhost',
      imapPort: 143,
    };
  }
}
