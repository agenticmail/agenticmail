-- AgenticMail initial schema

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

-- Full-text search for future use
CREATE VIRTUAL TABLE IF NOT EXISTS email_search USING fts5(
  agent_id,
  message_id,
  subject,
  from_address,
  to_address,
  body_text,
  received_at
);
