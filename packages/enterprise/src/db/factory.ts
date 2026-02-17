/**
 * Database Adapter Factory
 * 
 * Creates the right adapter based on config.
 * Adapters are lazy-loaded to avoid bundling unused drivers.
 */

import type { DatabaseAdapter, DatabaseConfig, DatabaseType } from './adapter.js';

const ADAPTER_MAP: Record<DatabaseType, () => Promise<new () => DatabaseAdapter>> = {
  postgres:     () => import('./postgres.js').then(m => m.PostgresAdapter),
  supabase:     () => import('./postgres.js').then(m => m.PostgresAdapter),  // Supabase IS Postgres
  neon:         () => import('./postgres.js').then(m => m.PostgresAdapter),  // Neon IS Postgres
  cockroachdb:  () => import('./postgres.js').then(m => m.PostgresAdapter),  // CockroachDB is PG-compatible
  mysql:        () => import('./mysql.js').then(m => m.MysqlAdapter),
  planetscale:  () => import('./mysql.js').then(m => m.MysqlAdapter),        // PlanetScale IS MySQL
  mongodb:      () => import('./mongodb.js').then(m => m.MongoAdapter),
  sqlite:       () => import('./sqlite.js').then(m => m.SqliteAdapter),
  turso:        () => import('./turso.js').then(m => m.TursoAdapter),
  dynamodb:     () => import('./dynamodb.js').then(m => m.DynamoAdapter),
};

export async function createAdapter(config: DatabaseConfig): Promise<DatabaseAdapter> {
  const loader = ADAPTER_MAP[config.type];
  if (!loader) {
    throw new Error(
      `Unsupported database type: "${config.type}". ` +
      `Supported: ${Object.keys(ADAPTER_MAP).join(', ')}`
    );
  }

  const AdapterClass = await loader();
  const adapter = new AdapterClass();
  await adapter.connect(config);
  return adapter;
}

export function getSupportedDatabases(): { type: DatabaseType; label: string; group: string }[] {
  return [
    { type: 'postgres',    label: 'PostgreSQL',                  group: 'SQL' },
    { type: 'mysql',       label: 'MySQL / MariaDB',             group: 'SQL' },
    { type: 'sqlite',      label: 'SQLite (embedded, dev/small)',group: 'SQL' },
    { type: 'mongodb',     label: 'MongoDB',                     group: 'NoSQL' },
    { type: 'turso',       label: 'Turso (LibSQL, edge)',        group: 'Edge' },
    { type: 'dynamodb',    label: 'DynamoDB (AWS)',              group: 'Cloud' },
    { type: 'supabase',    label: 'Supabase (managed Postgres)', group: 'Cloud' },
    { type: 'neon',        label: 'Neon (serverless Postgres)',  group: 'Cloud' },
    { type: 'planetscale', label: 'PlanetScale (managed MySQL)', group: 'Cloud' },
    { type: 'cockroachdb', label: 'CockroachDB',                group: 'Distributed' },
  ];
}
