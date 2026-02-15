-- Gateway configuration and purchased domains

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
