/**
 * Shared SQL schema for Postgres, MySQL, SQLite, CockroachDB, etc.
 * Each adapter translates these to dialect-specific DDL.
 */

export const TABLES = {
  company: `
    CREATE TABLE IF NOT EXISTS company_settings (
      id TEXT PRIMARY KEY DEFAULT 'default',
      name TEXT NOT NULL,
      domain TEXT,
      subdomain TEXT NOT NULL UNIQUE,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_user TEXT,
      smtp_pass TEXT,
      dkim_private_key TEXT,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#6366f1',
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  agents: `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'assistant',
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  users: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      password_hash TEXT,
      sso_provider TEXT,
      sso_subject TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP
    )`,

  audit_log: `
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'user',
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      ip TEXT
    )`,

  api_keys: `
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP,
      expires_at TIMESTAMP,
      revoked INTEGER NOT NULL DEFAULT 0
    )`,

  email_rules: `
    CREATE TABLE IF NOT EXISTS email_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT,
      conditions TEXT NOT NULL DEFAULT '{}',
      actions TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  retention_policy: `
    CREATE TABLE IF NOT EXISTS retention_policy (
      id TEXT PRIMARY KEY DEFAULT 'default',
      enabled INTEGER NOT NULL DEFAULT 0,
      retain_days INTEGER NOT NULL DEFAULT 365,
      exclude_tags TEXT DEFAULT '[]',
      archive_first INTEGER NOT NULL DEFAULT 1
    )`,

  // Indexes
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)',
    'CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name)',
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_sso ON users(sso_provider, sso_subject)',
    'CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)',
    'CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)',
    'CREATE INDEX IF NOT EXISTS idx_email_rules_agent ON email_rules(agent_id)',
  ],
};

export function getAllCreateStatements(): string[] {
  const stmts: string[] = [];
  for (const [key, value] of Object.entries(TABLES)) {
    if (key === 'indexes') continue;
    stmts.push(value as string);
  }
  stmts.push(...TABLES.indexes);
  return stmts;
}
