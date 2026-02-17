/**
 * Engine Database Schema
 *
 * SQL DDL for all engine tables. Used by SQLite, Postgres, MySQL, Turso.
 * MongoDB/DynamoDB use their own collection/table designs.
 */

export const ENGINE_TABLES = `
-- Managed agents (the deployed AI employees)
CREATE TABLE IF NOT EXISTS managed_agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  config JSON NOT NULL,
  health JSON NOT NULL DEFAULT '{}',
  usage JSON NOT NULL DEFAULT '{}',
  permission_profile_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_deployed_at TEXT,
  last_health_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_managed_agents_org ON managed_agents(org_id);
CREATE INDEX IF NOT EXISTS idx_managed_agents_state ON managed_agents(state);

-- State transition history
CREATE TABLE IF NOT EXISTS agent_state_history (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES managed_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_state_history_agent ON agent_state_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_state_history_time ON agent_state_history(created_at);

-- Permission profiles
CREATE TABLE IF NOT EXISTS permission_profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  config JSON NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_permission_profiles_org ON permission_profiles(org_id);

-- Organizations (tenants)
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  limits JSON NOT NULL DEFAULT '{}',
  usage JSON NOT NULL DEFAULT '{}',
  settings JSON NOT NULL DEFAULT '{}',
  sso_config JSON,
  allowed_domains JSON NOT NULL DEFAULT '[]',
  billing JSON,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- Knowledge bases
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  agent_ids JSON NOT NULL DEFAULT '[]',
  config JSON NOT NULL DEFAULT '{}',
  stats JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_org ON knowledge_bases(org_id);

-- Knowledge base documents
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  size INTEGER NOT NULL DEFAULT 0,
  metadata JSON NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(knowledge_base_id);

-- Knowledge base chunks (for RAG)
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  metadata JSON NOT NULL DEFAULT '{}',
  FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id);

-- Tool call records (activity tracking)
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  session_id TEXT,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  parameters JSON,
  result JSON,
  timing JSON NOT NULL,
  cost JSON,
  permission JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_org ON tool_calls(org_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_time ON tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_id);

-- Activity events (real-time stream)
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  data JSON NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_activity_org ON activity_events(org_id);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_events(type);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_events(created_at);

-- Conversation entries
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  channel TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  tool_calls JSON,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);

-- Approval requests
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  side_effects JSON NOT NULL DEFAULT '[]',
  parameters JSON,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision JSON,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_org ON approval_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approval_requests(agent_id);

-- Approval policies
CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  triggers JSON NOT NULL,
  approvers JSON NOT NULL,
  timeout JSON NOT NULL,
  notify JSON NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_policies_org ON approval_policies(org_id);
`;

/**
 * Postgres-compatible version (uses JSONB instead of JSON, SERIAL, etc.)
 */
export const ENGINE_TABLES_POSTGRES = ENGINE_TABLES
  .replace(/JSON/g, 'JSONB')
  .replace(/INTEGER NOT NULL DEFAULT 0/g, 'INTEGER NOT NULL DEFAULT 0')
  .replace(/datetime\('now'\)/g, "NOW()")
  .replace(/INTEGER NOT NULL DEFAULT 1/g, 'BOOLEAN NOT NULL DEFAULT TRUE')
  .replace(/is_preset INTEGER NOT NULL DEFAULT 0/g, 'is_preset BOOLEAN NOT NULL DEFAULT FALSE');

// ─── Versioned Migration System ────────────────────────

/**
 * Migration tracking table — created first, tracks which migrations have run.
 */
export const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS engine_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export const MIGRATIONS_TABLE_POSTGRES = MIGRATIONS_TABLE
  .replace(/datetime\('now'\)/g, "NOW()");

/**
 * Each migration has a version number, name, and per-dialect SQL.
 * The engine runs migrations in order, skipping already-applied ones.
 *
 * For MongoDB/DynamoDB: provide the `nosql` callback instead of SQL.
 */
export interface Migration {
  version: number;
  name: string;
  /** SQL statements (SQLite/Turso compatible) */
  sql?: string;
  /** Postgres-specific SQL (if different from sql) */
  postgres?: string;
  /** MySQL-specific SQL (if different from sql) */
  mysql?: string;
  /** NoSQL migration callback (MongoDB, DynamoDB) — receives the raw driver handle */
  nosql?: (db: any, dialect: string) => Promise<void>;
}

/**
 * Core migrations — the initial schema is migration 1.
 * Add new migrations here as the schema evolves.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: ENGINE_TABLES,
    postgres: ENGINE_TABLES_POSTGRES,
  },
  // ── Example future migration ──
  // {
  //   version: 2,
  //   name: 'add_agent_tags',
  //   sql: `
  //     CREATE TABLE IF NOT EXISTS agent_tags (
  //       agent_id TEXT NOT NULL,
  //       tag TEXT NOT NULL,
  //       PRIMARY KEY (agent_id, tag),
  //       FOREIGN KEY (agent_id) REFERENCES managed_agents(id) ON DELETE CASCADE
  //     );
  //     CREATE INDEX IF NOT EXISTS idx_agent_tags_tag ON agent_tags(tag);
  //   `,
  //   nosql: async (db, dialect) => {
  //     if (dialect === 'mongodb') {
  //       // MongoDB: add tags field to managed_agents collection
  //       await db.collection('managed_agents').updateMany(
  //         { tags: { $exists: false } },
  //         { $set: { tags: [] } }
  //       );
  //     }
  //   },
  // },
];

// ─── Dynamic Table Definitions ─────────────────────────

/**
 * Schema for a dynamically-registered table.
 * Plugins, skills, or the engine itself can register new tables at runtime.
 */
export interface DynamicTableDef {
  /** Table name (must be unique, will be prefixed with `ext_` to avoid collisions) */
  name: string;
  /** SQL CREATE TABLE statement (SQLite/Turso syntax) */
  sql: string;
  /** Postgres-specific DDL (optional, falls back to sql with auto-conversion) */
  postgres?: string;
  /** MySQL-specific DDL (optional) */
  mysql?: string;
  /** MongoDB collection setup callback */
  mongoSetup?: (db: any) => Promise<void>;
  /** DynamoDB table setup callback */
  dynamoSetup?: (client: any) => Promise<void>;
  /** Indexes to create (SQL only) */
  indexes?: string[];
}

/**
 * Convert SQLite-style DDL to Postgres-compatible DDL (best-effort).
 */
export function sqliteToPostgres(sql: string): string {
  return sql
    .replace(/JSON/g, 'JSONB')
    .replace(/datetime\('now'\)/g, "NOW()")
    .replace(/INTEGER NOT NULL DEFAULT 1(?!\d)/g, 'BOOLEAN NOT NULL DEFAULT TRUE')
    .replace(/INTEGER NOT NULL DEFAULT 0(?!\d)/g, 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * Convert SQLite-style DDL to MySQL-compatible DDL (best-effort).
 */
export function sqliteToMySQL(sql: string): string {
  return sql
    .replace(/TEXT PRIMARY KEY/g, 'VARCHAR(255) PRIMARY KEY')
    .replace(/TEXT NOT NULL UNIQUE/g, 'VARCHAR(255) NOT NULL UNIQUE')
    .replace(/TEXT NOT NULL DEFAULT/g, 'VARCHAR(255) NOT NULL DEFAULT')
    .replace(/BLOB/g, 'LONGBLOB')
    .replace(/datetime\('now'\)/g, "NOW()")
    .replace(/INTEGER NOT NULL DEFAULT 1/g, 'TINYINT(1) NOT NULL DEFAULT 1')
    .replace(/ON CONFLICT\(.*?\) DO UPDATE SET/g, 'ON DUPLICATE KEY UPDATE');
}
