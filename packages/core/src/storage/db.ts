import Database from 'better-sqlite3';
import { ensureDataDir, type AgenticMailConfig } from '../config.js';

let db: Database.Database | null = null;

export function getDatabase(config: AgenticMailConfig): Database.Database {
  if (db) return db;

  ensureDataDir(config);
  const dbPath = `${config.dataDir}/agenticmail.db`;
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Inline migration SQL so there's no filesystem dependency when bundled
const MIGRATIONS: Record<string, string> = {
  '001_init.sql': `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  stalwart_principal TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  stalwart_principal TEXT NOT NULL,
  dkim_selector TEXT,
  dkim_public_key TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_agents_email ON agents(email);

CREATE VIRTUAL TABLE IF NOT EXISTS email_search USING fts5(
  agent_id,
  message_id,
  subject,
  from_address,
  to_address,
  body_text,
  received_at
);
`,
  '002_gateway.sql': `
CREATE TABLE IF NOT EXISTS gateway_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  mode TEXT NOT NULL DEFAULT 'none',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchased_domains (
  domain TEXT PRIMARY KEY,
  registrar TEXT NOT NULL,
  cloudflare_zone_id TEXT,
  tunnel_id TEXT,
  dns_configured INTEGER NOT NULL DEFAULT 0,
  tunnel_active INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  '003_agent_roles.sql': `
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'secretary';
`,
  '004_dedup.sql': `
CREATE TABLE IF NOT EXISTS delivered_messages (
  message_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, agent_name)
);
`,
  '005_features.sql': `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, email)
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  to_addr TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  cc TEXT,
  bcc TEXT,
  in_reply_to TEXT,
  refs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  text_content TEXT,
  html_content TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  cc TEXT,
  bcc TEXT,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_drafts_agent ON drafts(agent_id);
CREATE INDEX IF NOT EXISTS idx_signatures_agent ON signatures(agent_id);
CREATE INDEX IF NOT EXISTS idx_templates_agent ON templates(agent_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_agent ON scheduled_emails(agent_id, status);
`,
  '006_tags.sql': `
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#888888',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);

CREATE TABLE IF NOT EXISTS message_tags (
  agent_id TEXT NOT NULL,
  message_uid INTEGER NOT NULL,
  tag_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, message_uid, tag_id, folder),
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tags_agent ON tags(agent_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_agent ON message_tags(agent_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_uid ON message_tags(agent_id, message_uid, folder);
`,
  '007_agent_deletions.sql': `
CREATE TABLE IF NOT EXISTS agent_deletions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_role TEXT,
  agent_created_at TEXT,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by TEXT,
  reason TEXT,
  email_count INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '{}',
  file_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_deletions_name ON agent_deletions(agent_name);
`,
  '008_rules.sql': `
CREATE TABLE IF NOT EXISTS email_rules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_email_rules_agent ON email_rules(agent_id, priority);
`,
  '009_agent_lifecycle.sql': `
ALTER TABLE agents ADD COLUMN last_activity_at TEXT;
ALTER TABLE agents ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
`,
  '010_tasks.sql': `
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  assigner_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'generic',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON agent_tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigner ON agent_tasks(assigner_id, status);
`,
  '011_spam_log.sql': `
CREATE TABLE IF NOT EXISTS spam_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message_uid INTEGER NOT NULL,
  score REAL NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  is_spam INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spam_log_agent ON spam_log(agent_id, created_at);
`,
  '012_pending_outbound.sql': `
CREATE TABLE IF NOT EXISTS pending_outbound (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mail_options TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_outbound_agent ON pending_outbound(agent_id, status);
`,
  '013_pending_notification_id.sql': `
ALTER TABLE pending_outbound ADD COLUMN notification_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_notification ON pending_outbound(notification_message_id);
`,
};

function runMigrations(database: Database.Database): void {
  // Ensure migrations tracking table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedStmt = database.prepare('SELECT name FROM _migrations');
  const applied = new Set(appliedStmt.all().map((r: any) => r.name));

  const insertStmt = database.prepare('INSERT INTO _migrations (name) VALUES (?)');

  // Sort migrations by name to ensure consistent ordering
  const sortedMigrations = Object.entries(MIGRATIONS).sort(([a], [b]) => a.localeCompare(b));

  // Run each migration in a transaction for atomicity
  const runMigration = database.transaction((name: string, sql: string) => {
    database.exec(sql);
    insertStmt.run(name);
  });

  for (const [name, sql] of sortedMigrations) {
    if (applied.has(name)) continue;
    runMigration(name, sql);
  }
}

export function createTestDatabase(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');

  for (const sql of Object.values(MIGRATIONS)) {
    testDb.exec(sql);
  }

  return testDb;
}
