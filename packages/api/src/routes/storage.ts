/**
 * Storage Routes — Full Database Management System for Agents
 *
 * Complete DBMS capabilities: DDL, DML, indexing, constraints, transactions,
 * aggregation, schema introspection, import/export, and more.
 *
 * Tables are prefixed with `agt_` (per-agent) or `shared_` (org-wide).
 * Works across all SQL database backends (SQLite, Postgres, MySQL, Turso).
 */

import { Router, type Request, type Response } from 'express';
import type { AccountManager, AgenticMailConfig } from '@agenticmail/core';
import { analyzeRawSql, isForbiddenName, validateSqlExpression } from '../lib/sql-guard.js';

// ─── Types ──────────────────────────────────────────────

interface StorageDB {
  run(sql: string, params?: any[]): Promise<void> | void;
  get(sql: string, params?: any[]): Promise<any> | any;
  all(sql: string, params?: any[]): Promise<any[]> | any[];
}

interface ColumnDef {
  name: string;
  type: 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'blob' | 'timestamp';
  required?: boolean;
  default?: string | number | boolean;
  unique?: boolean;
  primaryKey?: boolean;
  references?: { table: string; column: string; onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' };
  check?: string; // CHECK constraint expression
}

interface IndexDef {
  name?: string;
  columns: string[];
  unique?: boolean;
  where?: string; // Partial index condition (Postgres/SQLite only)
}

// ─── Helpers ────────────────────────────────────────────

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

class StorageRouteError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

function sendStorageError(res: Response, err: any): void {
  const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  res.status(statusCode).json({ error: err?.message || 'Storage operation failed' });
}

function requireIdentifier(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new StorageRouteError(`${label} contains invalid characters`);
  }
  return value;
}

// Table names are built by safeTableName (prefix + up to 64 chars, plus an
// optional `__archived` suffix), so they can be longer than IDENTIFIER_RE allows.
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;

function requireTableName(value: unknown): string {
  if (typeof value !== 'string' || !TABLE_NAME_RE.test(value)) {
    throw new StorageRouteError('table name contains invalid characters');
  }
  return value;
}

function requireIdentifierList(values: string[], label: string): string[] {
  return values.map((value) => requireIdentifier(value, label));
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function mapColumnType(col: ColumnDef, dialect: string): string {
  const typeMap: Record<string, Record<string, string>> = {
    sqlite: { text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'JSON', blob: 'BLOB', timestamp: 'TEXT' },
    postgres: { text: 'TEXT', integer: 'INTEGER', real: 'DOUBLE PRECISION', boolean: 'BOOLEAN', json: 'JSONB', blob: 'BYTEA', timestamp: 'TIMESTAMPTZ' },
    mysql: { text: 'TEXT', integer: 'INT', real: 'DOUBLE', boolean: 'TINYINT(1)', json: 'JSON', blob: 'LONGBLOB', timestamp: 'DATETIME' },
    turso: { text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'TEXT', blob: 'BLOB', timestamp: 'TEXT' },
  };
  return (typeMap[dialect] || typeMap.sqlite)[col.type] || 'TEXT';
}

const ON_DELETE_ACTIONS = new Set(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT']);

/**
 * @param tableColumns every column of the table this column belongs to
 *   (including itself) — the only identifiers a CHECK expression may name.
 */
function buildColumnDDL(col: ColumnDef, dialect: string, tableColumns: string[] = []): string {
  const columnName = requireIdentifier(col.name, 'column name');
  let ddl = `${columnName} ${mapColumnType(col, dialect)}`;
  if (col.primaryKey) ddl += ' PRIMARY KEY';
  if (col.required && !col.primaryKey) ddl += ' NOT NULL';
  if (col.unique && !col.primaryKey) ddl += ' UNIQUE';
  if (col.default !== undefined) {
    // Issue #27 — when timestamps were auto-added we passed the SQL
    // expression `datetime('now')` (or `NOW()` on Postgres) through
    // col.default as a string. The original code quoted that string
    // as a literal: `DEFAULT 'datetime('now')'` — the embedded
    // apostrophe closed the literal early and SQLite emitted
    // `near "now": syntax error`.
    //
    // 0.5.59 unquoted SQL expressions but produced
    // `DEFAULT datetime('now')`, which SQLite *also* rejects with
    // `near "(": syntax error` — per the SQLite docs, "If the
    // DEFAULT value of a column is a non-constant expression, the
    // expression must be enclosed in parentheses". Wrap function
    // calls and CURRENT_* keywords in parens so the DDL is valid
    // on both SQLite and Postgres (Postgres also accepts
    // `DEFAULT (NOW())`). Literal string defaults still get their
    // apostrophes properly escaped (`replace(/'/g, "''")`) so
    // user-supplied defaults can't break out of the literal.
    let val: string | number | boolean;
    if (typeof col.default === 'string') {
      // Cap input length before `/\(.*\)/.test` — the unbounded `.*`
      // is technically polynomial on adversarial input (CodeQL
      // `js/polynomial-redos`). Column defaults are user-supplied
      // metadata; 500 chars is well past any legitimate use.
      const trimmed = col.default.slice(0, 500).trim();
      const isSqlExpr = /\(.*\)/.test(trimmed)
        || /^CURRENT_(?:TIMESTAMP|DATE|TIME)$/i.test(trimmed);
      // Security — the expression path used to embed `trimmed` raw, which
      // carried stacked statements into exec() (GHSA-m52q-h5cf-mj6c). It is
      // now held to the strict expression whitelist: literals, operators
      // and a small scalar-function allowlist, no column references.
      val = isSqlExpr
        ? `(${validateSqlExpression(trimmed, { label: 'column default', dialect })})`
        : `'${escapeSqlString(col.default)}'`;
    } else if (typeof col.default === 'number') {
      if (!Number.isFinite(col.default)) throw new StorageRouteError('column default must be a finite number');
      val = col.default;
    } else if (typeof col.default === 'boolean') {
      val = col.default;
    } else if (col.default === null) {
      val = 'NULL';
    } else {
      // Arrays/objects stringify into arbitrary SQL text — refuse them.
      throw new StorageRouteError('column default must be a string, number, boolean or null');
    }
    ddl += ` DEFAULT ${val}`;
  }
  if (col.check !== undefined && col.check !== null && col.check !== '') {
    const columns = tableColumns.length ? tableColumns : [columnName];
    ddl += ` CHECK (${validateSqlExpression(col.check, { label: 'check constraint', columns, dialect })})`;
  }
  if (col.references) {
    ddl += ` REFERENCES ${requireIdentifier(col.references.table, 'reference table')}(${requireIdentifier(col.references.column, 'reference column')})`;
    if (col.references.onDelete) {
      const action = typeof col.references.onDelete === 'string' ? col.references.onDelete.trim().toUpperCase() : '';
      if (!ON_DELETE_ACTIONS.has(action)) throw new StorageRouteError('references.onDelete must be CASCADE, SET NULL, RESTRICT, NO ACTION or SET DEFAULT');
      ddl += ` ON DELETE ${action}`;
    }
  }
  return ddl;
}

function safeTableName(agentId: string, name: string, shared: boolean): string {
  const clean = name.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 64);
  if (!clean) throw new Error('Invalid table name');
  const prefix = shared ? 'shared' : `agt_${agentId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16)}`;
  return `${prefix}_${clean}`;
}

function resolveTable(agentId: string, name: string): string {
  if (name.startsWith('agt_') || name.startsWith('shared_')) return requireTableName(name);
  return safeTableName(agentId, name, false);
}

function isSafeTable(tableName: string): boolean {
  return IDENTIFIER_RE.test(tableName) && (tableName.startsWith('agt_') || tableName.startsWith('shared_'));
}

function buildWhereClause(where: Record<string, any>): { sql: string; params: any[] } {
  const params: any[] = [];
  const conditions = Object.entries(where).map(([k, v]) => {
    const column = requireIdentifier(k, 'where key');
    if (v === null) return `${column} IS NULL`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Operator objects: { $gt: 5, $lt: 10, $like: '%foo%', $ne: 'bar', $is_null: true, $in: [1,2,3] }
      const ops = Object.entries(v).map(([op, val]) => {
        switch (op) {
          case '$gt': params.push(val); return `${column} > ?`;
          case '$gte': params.push(val); return `${column} >= ?`;
          case '$lt': params.push(val); return `${column} < ?`;
          case '$lte': params.push(val); return `${column} <= ?`;
          case '$ne': params.push(val); return `${column} != ?`;
          case '$like': params.push(val); return `${column} LIKE ?`;
          case '$ilike': params.push(val); return `LOWER(${column}) LIKE LOWER(?)`;
          case '$not_like': params.push(val); return `${column} NOT LIKE ?`;
          case '$in': {
            if (!Array.isArray(val)) throw new StorageRouteError('$in requires an array value');
            const arr = val as any[];
            params.push(...arr);
            return `${column} IN (${arr.map(() => '?').join(', ')})`;
          }
          case '$not_in': {
            if (!Array.isArray(val)) throw new StorageRouteError('$not_in requires an array value');
            const arr = val as any[];
            params.push(...arr);
            return `${column} NOT IN (${arr.map(() => '?').join(', ')})`;
          }
          case '$is_null': return val ? `${column} IS NULL` : `${column} IS NOT NULL`;
          case '$between': {
            if (!Array.isArray(val) || val.length !== 2) throw new StorageRouteError('$between requires a two-item array');
            const [lo, hi] = val as [any, any];
            params.push(lo, hi);
            return `${column} BETWEEN ? AND ?`;
          }
          default:
            throw new StorageRouteError(`Unsupported where operator: ${op}`);
        }
      });
      return ops.join(' AND ');
    }
    if (Array.isArray(v)) {
      params.push(...v);
      return `${column} IN (${v.map(() => '?').join(', ')})`;
    }
    params.push(typeof v === 'object' ? JSON.stringify(v) : v);
    return `${column} = ?`;
  });
  return { sql: conditions.join(' AND '), params };
}

function buildOrderBy(orderBy: string): string {
  const parts = orderBy.split(',').map((part) => {
    const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s+(ASC|DESC))?$/i);
    if (!match) throw new StorageRouteError('orderBy contains invalid characters');
    return `${match[1]}${match[2] ? ` ${match[2].toUpperCase()}` : ''}`;
  });
  return parts.join(', ');
}

function buildGroupBy(groupBy: string): string {
  return requireIdentifierList(groupBy.split(',').map((part) => part.trim()), 'groupBy column').join(', ');
}

/** Column names recorded in a table's storage metadata. */
function metaColumnNames(meta: any): string[] {
  try {
    const cols = typeof meta?.columns === 'string' ? JSON.parse(meta.columns) : meta?.columns;
    return Array.isArray(cols) ? cols.map((c: any) => c?.name).filter((c: any) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** Quote an identifier that came from the database itself. */
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function nowExpr(dialect: string): string {
  return dialect === 'postgres' ? 'NOW()' : "datetime('now')";
}

// ─── Routes ─────────────────────────────────────────────

/** Issue #15 — adapter from a raw sync SQLite Database (today
 *  {@code node:sqlite}'s {@code DatabaseSync}; was {@code
 *  better-sqlite3} before the v0.7 migration) to the async-flavored
 *  {@link StorageDB} surface every route in this file uses. Without
 *  this, calls like {@code db.run('CREATE TABLE …')} hit
 *  {@code undefined(...)} (the sync drivers only expose
 *  {@code prepare/exec}, not direct {@code run/get/all}), throw
 *  synchronously, and the rejected promise from
 *  {@code ensureMetaTable()} (which sits OUTSIDE the per-route
 *  try/catch) escapes Express's default async handler — leaving
 *  the request hanging until the client times out.
 *
 *  <p>The adapter prepares each statement (one statement per call —
 *  never {@code exec}, see the security note below), and returns
 *  plain (non-Promise) values;
 *  the awaits in the route handlers are no-ops on plain values, so
 *  no further changes were needed at the call sites. */
function adaptBetterSqlite(raw: any): StorageDB {
  // If the caller already passed something that quacks like
  // StorageDB (a future async driver, e.g. node-sqlite3 / pg),
  // pass it through unchanged.
  if (raw && typeof raw.run === 'function'
        && typeof raw.get === 'function'
        && typeof raw.all === 'function') {
    return raw as StorageDB;
  }
  // Otherwise wrap the sync-style SQLite instance (node:sqlite DatabaseSync today).
  //
  // Security — this adapter used to send parameter-less statements to
  // `raw.exec()`, which runs EVERY statement in the string. Any fragment an
  // agent could get into a DDL string (index WHERE, CHECK, DEFAULT) then
  // became arbitrary stacked SQL (GHSA-vj36-c6cj-8qmh, GHSA-fgq6-mm4x-93qq,
  // GHSA-m52q-h5cf-mj6c). Everything now goes through `prepare()`, which
  // compiles exactly one statement (node:sqlite prepares DDL and PRAGMA
  // fine), and `prepareSingle` refuses any text left over after that
  // statement instead of letting the driver silently ignore it.
  const prepareSingle = (sql: string): any => {
    const stmt = raw.prepare(sql);
    const source = typeof stmt?.sourceSQL === 'string' ? stmt.sourceSQL
      : typeof stmt?.source === 'string' ? stmt.source
        : null;
    if (source !== null) {
      const strip = (text: string) => text.replace(/[\s;]+$/, '').trim();
      if (strip(source).length < strip(sql).length) {
        throw new StorageRouteError('Only a single SQL statement is allowed');
      }
    }
    return stmt;
  };
  return {
    run(sql: string, params?: any[]): void {
      const stmt = prepareSingle(sql);
      if (params && params.length > 0) stmt.run(...params);
      else stmt.run();
    },
    get(sql: string, params?: any[]): any {
      const stmt = prepareSingle(sql);
      return params && params.length > 0 ? stmt.get(...params) : stmt.get();
    },
    all(sql: string, params?: any[]): any[] {
      const stmt = prepareSingle(sql);
      const rows = params && params.length > 0
        ? stmt.all(...params)
        : stmt.all();
      return rows as any[];
    },
  };
}

export function createStorageRoutes(
  rawDb: any,
  accountManager: AccountManager,
  config: AgenticMailConfig,
  dialect: string = 'sqlite',
): Router {
  const db = adaptBetterSqlite(rawDb);
  const router = Router();

  function getAgent(req: Request, res: Response): { id: string; email: string } | null {
    const agent = (req as any).agent;
    if (!agent) { res.status(401).json({ error: 'Authentication required' }); return null; }
    return agent;
  }

  async function verifyAccess(agent: { id: string }, tableName: string, res: Response, requireOwner = false): Promise<any | null> {
    const meta = await db.get('SELECT * FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
    if (!meta) { res.status(404).json({ error: 'Table not found' }); return null; }
    if (requireOwner && meta.agent_id !== agent.id) { res.status(403).json({ error: 'Only the owner can perform this action' }); return null; }
    if (meta.agent_id !== agent.id && !meta.shared) { res.status(403).json({ error: 'Access denied' }); return null; }
    return meta;
  }

  /** Every table / view / index / trigger in the database, keyed by
   *  lower-cased name, with the table each one belongs to. */
  async function loadSchemaObjects(): Promise<Map<string, { name: string; table: string }>> {
    let rows: any[];
    if (dialect === 'postgres') {
      rows = await db.all(
        `SELECT table_name AS name, table_name AS tbl_name FROM information_schema.tables
         UNION ALL SELECT indexname AS name, tablename AS tbl_name FROM pg_indexes`,
      );
    } else if (dialect === 'mysql') {
      rows = await db.all(
        `SELECT table_name AS name, table_name AS tbl_name FROM information_schema.tables
         UNION ALL SELECT index_name AS name, table_name AS tbl_name FROM information_schema.statistics`,
      );
    } else {
      rows = await db.all(
        `SELECT name, tbl_name FROM sqlite_master
         UNION ALL SELECT name, tbl_name FROM sqlite_temp_master`,
      );
    }
    const objects = new Map<string, { name: string; table: string }>();
    for (const row of rows) {
      const name = row?.name ?? row?.NAME;
      const table = row?.tbl_name ?? row?.TBL_NAME ?? name;
      if (typeof name === 'string') objects.set(name.toLowerCase(), { name, table: String(table) });
    }
    return objects;
  }

  /**
   * Security — ownership check for raw agent SQL (GHSA-vj36-c6cj-8qmh,
   * GHSA-fgq6-mm4x-93qq). The old check pulled table names out with a regex
   * anchored on `FROM\s+`, so `FROM/**\/agents` was invisible to it, and a
   * statement it found no tables in was allowed. Now:
   *
   *   - the statement is lexed (sql-guard), so comments, quoting and
   *     whitespace cannot hide a token; comments and stacked statements are
   *     refused outright, as are ATTACH/DETACH/PRAGMA/VACUUM and friends,
   *     and anything but SELECT/WITH/VALUES/INSERT/REPLACE/UPDATE/DELETE/
   *     EXPLAIN;
   *   - deny by default: EVERY identifier in the statement, and every string
   *     literal (SQLite accepts `FROM 'agents'`), is resolved against the
   *     live schema. Any that names a table, view, index or trigger which is
   *     not an agt_* / shared_* table this agent may use is refused, wherever
   *     in the statement it appears. A column that happens to share a core
   *     table's name is therefore refused too; the structured routes (or a
   *     bound parameter, for a value) are the way around that.
   */
  async function verifySqlAccess(agent: { id: string }, sql: unknown): Promise<ReturnType<typeof analyzeRawSql>> {
    const analysis = analyzeRawSql(sql, dialect);

    let schema: Map<string, { name: string; table: string }>;
    try {
      schema = await loadSchemaObjects();
    } catch {
      throw new StorageRouteError('Unable to verify table access for this statement', 403);
    }

    const verdicts = new Map<string, Promise<void>>();
    const checkTable = (tableName: string): Promise<void> => {
      const key = tableName.toLowerCase();
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = (async () => {
          if (key === 'agenticmail_storage_meta') {
            throw new StorageRouteError('Direct SQL access to storage metadata is not allowed', 403);
          }
          if (!isSafeTable(tableName)) {
            throw new StorageRouteError(`Cannot operate on table "${tableName}". Only agt_* and shared_* tables are allowed.`, 403);
          }
          const meta = await db.get('SELECT * FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
          if (!meta) {
            throw new StorageRouteError(`Table "${tableName}" is not registered in storage metadata`, 404);
          }
          if (meta.agent_id !== agent.id && !meta.shared) {
            throw new StorageRouteError(`Access denied for table "${tableName}"`, 403);
          }
        })();
        verdicts.set(key, verdict);
      }
      return verdict;
    };

    const checkName = async (name: string, isIdentifier: boolean): Promise<void> => {
      if (isForbiddenName(name)) {
        if (name.toLowerCase() === 'agenticmail_storage_meta') {
          throw new StorageRouteError('Direct SQL access to storage metadata is not allowed', 403);
        }
        throw new StorageRouteError(`Access to "${name}" is not allowed`, 403);
      }
      const object = schema.get(name.toLowerCase());
      if (object) return checkTable(object.table);
      // Not an existing object. An agt_*/shared_* identifier must still be a
      // registered table (keeps the old comma-join backstop's behaviour).
      if (isIdentifier && /^(?:agt|shared)_/i.test(name)) return checkTable(name);
    };

    for (const ident of analysis.identifiers) await checkName(ident, true);
    for (const str of analysis.strings) await checkName(str, false);
    return analysis;
  }

  // ─── Metadata tracking table ────────────────────────
  const ensureMetaTable = (() => {
    let done = false;
    return async () => {
      if (done) return;
      await db.run(`
        CREATE TABLE IF NOT EXISTS agenticmail_storage_meta (
          table_name TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT DEFAULT '',
          shared INTEGER NOT NULL DEFAULT 0,
          columns JSON NOT NULL DEFAULT '[]',
          indexes JSON NOT NULL DEFAULT '[]',
          row_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (${nowExpr(dialect)}),
          updated_at TEXT NOT NULL DEFAULT (${nowExpr(dialect)}),
          archived_at TEXT
        )
      `);
      done = true;
    };
  })();


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DDL — Schema Definition & Management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ─── POST /storage/tables — Create table ────────────

  router.post('/storage/tables', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { name, columns, indexes, shared, description, timestamps } = req.body as {
        name: string;
        columns: ColumnDef[];
        indexes?: IndexDef[];
        shared?: boolean;
        description?: string;
        timestamps?: boolean; // auto-add created_at/updated_at
      };

      if (!name || !columns?.length) return res.status(400).json({ error: 'name and columns are required' });

      const hasPK = columns.some(c => c.primaryKey);
      const allCols = [...(hasPK ? [] : [{ name: 'id', type: 'text' as const, primaryKey: true }]), ...columns];

      // Auto-add timestamps if requested
      if (timestamps !== false) {
        if (!allCols.find(c => c.name === 'created_at')) {
          allCols.push({ name: 'created_at', type: 'timestamp' as const, default: nowExpr(dialect) } as any);
        }
        if (!allCols.find(c => c.name === 'updated_at')) {
          allCols.push({ name: 'updated_at', type: 'timestamp' as const, default: nowExpr(dialect) } as any);
        }
      }

      const tableName = safeTableName(agent.id, name, !!shared);

      const existing = await db.get('SELECT table_name FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (existing) return res.status(409).json({ error: `Table "${name}" already exists`, table: tableName });

      const allColNames = allCols.map(c => requireIdentifier(c.name, 'column name'));
      const colDefs = allCols.map(c => buildColumnDDL(c, dialect, allColNames)).join(',\n  ');
      // Validate every index up front so a bad one cannot leave a
      // half-created, unregistered table behind.
      for (const idx of indexes ?? []) {
        if (!Array.isArray(idx?.columns) || !idx.columns.length) throw new StorageRouteError('index columns are required');
        requireIdentifierList(idx.columns, 'index column');
        if (idx.name) requireIdentifier(idx.name, 'index name');
        if (idx.where) validateSqlExpression(idx.where, { label: 'index where clause', columns: allColNames, dialect });
      }
      await db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${colDefs}\n)`);

      // Create indexes
      const idxMeta: any[] = [];
      if (indexes?.length) {
        for (let i = 0; i < indexes.length; i++) {
          const idx = indexes[i];
          const idxColumns = requireIdentifierList(idx.columns, 'index column');
          const idxName = idx.name ? requireIdentifier(idx.name, 'index name') : `idx_${tableName}_${idxColumns.join('_')}`;
          const unique = idx.unique ? 'UNIQUE ' : '';
          let idxSql = `CREATE ${unique}INDEX IF NOT EXISTS ${idxName} ON ${tableName}(${idxColumns.join(', ')})`;
          if (idx.where && (dialect === 'sqlite' || dialect === 'postgres' || dialect === 'turso')) {
            // Security — was interpolated raw (GHSA-fgq6-mm4x-93qq, GHSA-m52q-h5cf-mj6c).
            idxSql += ` WHERE ${validateSqlExpression(idx.where, { label: 'index where clause', columns: allColNames, dialect })}`;
          }
          await db.run(idxSql);
          idxMeta.push({ name: idxName, columns: idxColumns, unique: !!idx.unique, where: idx.where });
        }
      }

      await db.run(
        'INSERT INTO agenticmail_storage_meta (table_name, agent_id, display_name, description, shared, columns, indexes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tableName, agent.id, name, description || '', shared ? 1 : 0, JSON.stringify(allCols), JSON.stringify(idxMeta)]
      );

      res.json({ ok: true, table: tableName, columns: allCols, indexes: idxMeta });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── GET /storage/tables — List tables ──────────────

  router.get('/storage/tables', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const includeShared = req.query.includeShared !== 'false';
      const includeArchived = req.query.includeArchived === 'true';

      let sql = 'SELECT * FROM agenticmail_storage_meta WHERE (agent_id = ?';
      const params: any[] = [agent.id];
      if (includeShared) sql += ' OR shared = 1';
      sql += ')';
      if (!includeArchived) sql += ' AND archived_at IS NULL';

      const tables = await db.all(sql, params);
      res.json({
        tables: tables.map((t: any) => ({
          name: t.display_name,
          table: t.table_name,
          description: t.description,
          shared: !!t.shared,
          archived: !!t.archived_at,
          columns: typeof t.columns === 'string' ? JSON.parse(t.columns) : t.columns,
          indexes: typeof t.indexes === 'string' ? JSON.parse(t.indexes) : (t.indexes || []),
          rowCount: t.row_count,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        })),
      });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── GET /storage/tables/:name/describe — Full schema ─

  router.get('/storage/tables/:name/describe', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      // Get actual schema from DB
      let schemaInfo: any[] = [];
      if (dialect === 'sqlite' || dialect === 'turso') {
        schemaInfo = await db.all(`PRAGMA table_info(${tableName})`);
      } else if (dialect === 'postgres') {
        schemaInfo = await db.all(
          `SELECT column_name as name, data_type as type, is_nullable, column_default
           FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position`, [tableName]
        );
      } else if (dialect === 'mysql') {
        schemaInfo = await db.all(`DESCRIBE ${tableName}`);
      }

      // Get indexes from DB
      let indexInfo: any[] = [];
      if (dialect === 'sqlite' || dialect === 'turso') {
        indexInfo = await db.all(`PRAGMA index_list(${tableName})`);
      } else if (dialect === 'postgres') {
        indexInfo = await db.all(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ?`, [tableName]
        );
      }

      // Get row count
      const countResult = await db.get(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      const rowCount = countResult?.cnt || 0;

      // Update cached row count
      await db.run('UPDATE agenticmail_storage_meta SET row_count = ? WHERE table_name = ?', [rowCount, tableName]);

      res.json({
        table: tableName,
        name: meta.display_name,
        description: meta.description,
        shared: !!meta.shared,
        columns: typeof meta.columns === 'string' ? JSON.parse(meta.columns) : meta.columns,
        indexes: typeof meta.indexes === 'string' ? JSON.parse(meta.indexes) : (meta.indexes || []),
        rowCount,
        dbSchema: schemaInfo,
        dbIndexes: indexInfo,
        createdAt: meta.created_at,
      });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/columns — Add column ─

  router.post('/storage/tables/:name/columns', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { column } = req.body as { column: ColumnDef };
      if (!column?.name || !column?.type) return res.status(400).json({ error: 'column with name and type is required' });

      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      const tableColumns = [...metaColumnNames(meta), requireIdentifier(column.name, 'column name')];
      await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${buildColumnDDL(column, dialect, tableColumns)}`);

      const cols = typeof meta.columns === 'string' ? JSON.parse(meta.columns) : meta.columns;
      cols.push(column);
      await db.run(`UPDATE agenticmail_storage_meta SET columns = ?, updated_at = ${nowExpr(dialect)} WHERE table_name = ?`, [JSON.stringify(cols), tableName]);

      res.json({ ok: true, column: column.name });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── DELETE /storage/tables/:name/columns/:col — Drop column ─

  router.delete('/storage/tables/:name/columns/:col', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const colName = requireIdentifier(req.params.col, 'column name');
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      if (dialect === 'sqlite' || dialect === 'turso') {
        // SQLite 3.35+ supports ALTER TABLE DROP COLUMN
        await db.run(`ALTER TABLE ${tableName} DROP COLUMN ${colName}`);
      } else {
        await db.run(`ALTER TABLE ${tableName} DROP COLUMN ${colName}`);
      }

      const cols = (typeof meta.columns === 'string' ? JSON.parse(meta.columns) : meta.columns)
        .filter((c: any) => c.name !== colName);
      await db.run(`UPDATE agenticmail_storage_meta SET columns = ?, updated_at = ${nowExpr(dialect)} WHERE table_name = ?`, [JSON.stringify(cols), tableName]);

      res.json({ ok: true, dropped: colName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/rename — Rename table ─

  router.post('/storage/tables/:name/rename', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { newName } = req.body as { newName: string };
      if (!newName) return res.status(400).json({ error: 'newName is required' });

      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      const newTableName = safeTableName(agent.id, newName, !!meta.shared);
      await db.run(`ALTER TABLE ${tableName} RENAME TO ${newTableName}`);
      await db.run('UPDATE agenticmail_storage_meta SET table_name = ?, display_name = ?, updated_at = ' + nowExpr(dialect) + ' WHERE table_name = ?',
        [newTableName, newName, tableName]);

      res.json({ ok: true, oldTable: tableName, newTable: newTableName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/rename-column — Rename column ─

  router.post('/storage/tables/:name/rename-column', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { oldName, newName } = req.body as { oldName: string; newName: string };
      if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName are required' });
      requireIdentifier(oldName, 'column name');
      requireIdentifier(newName, 'column name');

      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      await db.run(`ALTER TABLE ${tableName} RENAME COLUMN ${oldName} TO ${newName}`);

      const cols = typeof meta.columns === 'string' ? JSON.parse(meta.columns) : meta.columns;
      const col = cols.find((c: any) => c.name === oldName);
      if (col) col.name = newName;
      await db.run(`UPDATE agenticmail_storage_meta SET columns = ?, updated_at = ${nowExpr(dialect)} WHERE table_name = ?`, [JSON.stringify(cols), tableName]);

      res.json({ ok: true, oldName, newName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── DELETE /storage/tables/:name — Drop table ──────

  router.delete('/storage/tables/:name', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      await db.run(`DROP TABLE IF EXISTS ${tableName}`);
      await db.run('DELETE FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);

      res.json({ ok: true, dropped: tableName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/clone — Clone table ─

  router.post('/storage/tables/:name/clone', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { newName, includeData } = req.body as { newName: string; includeData?: boolean };
      if (!newName) return res.status(400).json({ error: 'newName is required' });

      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      const newTableName = safeTableName(agent.id, newName, false);

      if (includeData !== false) {
        await db.run(`CREATE TABLE ${newTableName} AS SELECT * FROM ${tableName}`);
      } else {
        // Structure only (SQLite/Postgres compatible)
        await db.run(`CREATE TABLE ${newTableName} AS SELECT * FROM ${tableName} WHERE 0`);
      }

      const countResult = await db.get(`SELECT COUNT(*) as cnt FROM ${newTableName}`);

      await db.run(
        'INSERT INTO agenticmail_storage_meta (table_name, agent_id, display_name, description, shared, columns, indexes, row_count) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        [newTableName, agent.id, newName, `Clone of ${meta.display_name}`, meta.columns, '[]', countResult?.cnt || 0]
      );

      res.json({ ok: true, table: newTableName, rows: countResult?.cnt || 0 });
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INDEX MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ─── POST /storage/tables/:name/indexes — Create index ─

  router.post('/storage/tables/:name/indexes', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { columns, unique, name: idxName, where: whereClause } = req.body as IndexDef & { where?: string };
      if (!columns?.length) return res.status(400).json({ error: 'columns are required' });

      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      // Security (GHSA-vj36-c6cj-8qmh, GHSA-fgq6-mm4x-93qq) — name, columns
      // and where were all interpolated raw and then run through exec(), so
      // a stacked statement in `where` could read or rewrite any table. Every
      // fragment is now validated: identifiers by IDENTIFIER_RE, the WHERE by
      // the strict expression whitelist, which only admits this table's own
      // columns — so the statement can reference no other table at all.
      if (!Array.isArray(columns)) return res.status(400).json({ error: 'columns must be an array' });
      const safeColumns = requireIdentifierList(columns, 'index column');
      const finalName = idxName ? requireIdentifier(idxName, 'index name') : `idx_${tableName}_${safeColumns.join('_')}`;
      let sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${finalName} ON ${tableName}(${safeColumns.join(', ')})`;
      if (whereClause && (dialect === 'sqlite' || dialect === 'postgres' || dialect === 'turso')) {
        sql += ` WHERE ${validateSqlExpression(whereClause, { label: 'index where clause', columns: metaColumnNames(meta), dialect })}`;
      }
      await db.run(sql);

      // Update metadata
      const indexes = typeof meta.indexes === 'string' ? JSON.parse(meta.indexes) : (meta.indexes || []);
      indexes.push({ name: finalName, columns: safeColumns, unique: !!unique, where: whereClause });
      await db.run(`UPDATE agenticmail_storage_meta SET indexes = ?, updated_at = ${nowExpr(dialect)} WHERE table_name = ?`, [JSON.stringify(indexes), tableName]);

      res.json({ ok: true, index: finalName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── GET /storage/tables/:name/indexes — List indexes ─

  router.get('/storage/tables/:name/indexes', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      let dbIndexes: any[] = [];
      if (dialect === 'sqlite' || dialect === 'turso') {
        const idxList = await db.all(`PRAGMA index_list(${tableName})`);
        for (const idx of idxList) {
          const info = await db.all(`PRAGMA index_info(${quoteIdent(idx.name)})`);
          dbIndexes.push({ name: idx.name, unique: !!idx.unique, columns: info.map((i: any) => i.name) });
        }
      } else if (dialect === 'postgres') {
        dbIndexes = await db.all(`SELECT indexname as name, indexdef as definition FROM pg_indexes WHERE tablename = ?`, [tableName]);
      } else if (dialect === 'mysql') {
        dbIndexes = await db.all(`SHOW INDEX FROM ${tableName}`);
      }

      res.json({ indexes: dbIndexes });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── DELETE /storage/tables/:name/indexes/:idx — Drop index ─

  router.delete('/storage/tables/:name/indexes/:idx', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const idxName = requireIdentifier(req.params.idx, 'index name');
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      // The index must belong to THIS table — otherwise owning any table
      // was enough to drop any index in the database.
      let belongs: boolean;
      if (dialect === 'sqlite' || dialect === 'turso') {
        belongs = !!(await db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?", [idxName, tableName]));
      } else if (dialect === 'postgres') {
        belongs = !!(await db.get('SELECT indexname FROM pg_indexes WHERE indexname = ? AND tablename = ?', [idxName, tableName]));
      } else {
        belongs = true; // MySQL's DROP INDEX is already scoped with ON <table>.
      }
      if (!belongs) return res.status(404).json({ error: 'Index not found on this table' });

      if (dialect === 'mysql') {
        await db.run(`DROP INDEX ${idxName} ON ${tableName}`);
      } else {
        await db.run(`DROP INDEX IF EXISTS ${idxName}`);
      }

      const indexes = (typeof meta.indexes === 'string' ? JSON.parse(meta.indexes) : (meta.indexes || []))
        .filter((i: any) => i.name !== idxName);
      await db.run(`UPDATE agenticmail_storage_meta SET indexes = ?, updated_at = ${nowExpr(dialect)} WHERE table_name = ?`, [JSON.stringify(indexes), tableName]);

      res.json({ ok: true, dropped: idxName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/reindex — Rebuild indexes ─

  router.post('/storage/tables/:name/reindex', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      if (dialect === 'sqlite' || dialect === 'turso') {
        await db.run(`REINDEX ${tableName}`);
      } else if (dialect === 'postgres') {
        await db.run(`REINDEX TABLE ${tableName}`);
      } else if (dialect === 'mysql') {
        await db.run(`OPTIMIZE TABLE ${tableName}`);
      }

      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DML — Data Manipulation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ─── POST /storage/insert — Insert rows ─────────────

  router.post('/storage/insert', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, rows } = req.body as { table: string; rows: Record<string, any>[] };
      if (!table || !rows?.length) return res.status(400).json({ error: 'table and rows are required' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot insert into system tables' });

      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      let inserted = 0;
      for (const row of rows) {
        const keys = requireIdentifierList(Object.keys(row), 'row key');
        const vals = Object.values(row).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        const placeholders = keys.map(() => '?').join(', ');
        await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`, vals);
        inserted++;
      }

      // Update row count
      const countResult = await db.get(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      await db.run('UPDATE agenticmail_storage_meta SET row_count = ?, updated_at = ' + nowExpr(dialect) + ' WHERE table_name = ?', [countResult?.cnt || 0, tableName]);

      res.json({ ok: true, inserted });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/upsert — Insert or update on conflict ─

  router.post('/storage/upsert', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, rows, conflictColumn } = req.body as { table: string; rows: Record<string, any>[]; conflictColumn: string };
      if (!table || !rows?.length || !conflictColumn) return res.status(400).json({ error: 'table, rows, and conflictColumn are required' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot upsert into system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      let upserted = 0;
      const safeConflictColumn = requireIdentifier(conflictColumn, 'conflict column');
      for (const row of rows) {
        const keys = requireIdentifierList(Object.keys(row), 'row key');
        const vals = Object.values(row).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        const placeholders = keys.map(() => '?').join(', ');
        const updateCols = keys.filter(k => k !== safeConflictColumn).map(k => `${k} = excluded.${k}`).join(', ');

        if (dialect === 'mysql') {
          const dupUpdate = keys.filter(k => k !== safeConflictColumn).map(k => `${k} = VALUES(${k})`).join(', ');
          await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${dupUpdate}`, vals);
        } else {
          await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${safeConflictColumn}) DO UPDATE SET ${updateCols}`, vals);
        }
        upserted++;
      }

      res.json({ ok: true, upserted });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/query — Query rows ───────────────

  router.post('/storage/query', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where, orderBy, limit, offset, columns, distinct, groupBy, having } = req.body as {
        table: string;
        where?: Record<string, any>;
        orderBy?: string;
        limit?: number;
        offset?: number;
        columns?: string[];
        distinct?: boolean;
        groupBy?: string;
        having?: string;
      };

      if (!table) return res.status(400).json({ error: 'table is required' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot query system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      const selectCols = columns?.length ? requireIdentifierList(columns, 'selected column').join(', ') : '*';
      let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${selectCols} FROM ${tableName}`;
      let params: any[] = [];

      if (where && Object.keys(where).length) {
        const w = buildWhereClause(where);
        sql += ` WHERE ${w.sql}`;
        params = w.params;
      }

      if (groupBy) sql += ` GROUP BY ${buildGroupBy(groupBy)}`;
      // Security — the old keyword blocklist let `(SELECT … FROM agents)`
      // through, a boolean oracle on any table. Same whitelist as DDL.
      if (having) {
        sql += ` HAVING ${validateSqlExpression(having, {
          label: 'having clause', columns: metaColumnNames(meta), dialect, maxLength: 200, allowAggregates: true,
        })}`;
      }
      if (orderBy) sql += ` ORDER BY ${buildOrderBy(orderBy)}`;
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      if (offset) { sql += ' OFFSET ?'; params.push(offset); }

      const rows = await db.all(sql, params);
      res.json({ rows, count: rows.length });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/aggregate — Aggregate queries ────

  router.post('/storage/aggregate', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where, operations, groupBy } = req.body as {
        table: string;
        where?: Record<string, any>;
        operations: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'; column?: string; alias?: string }[];
        groupBy?: string;
      };

      if (!table || !operations?.length) return res.status(400).json({ error: 'table and operations are required' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot aggregate system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      const selects = operations.map((op, i) => {
        const alias = requireIdentifier(op.alias || `${op.fn}_${op.column || 'all'}`, 'operation alias');
        const col = op.column ? requireIdentifier(op.column, 'operation column') : '*';
        switch (op.fn) {
          case 'count': return `COUNT(${col}) as ${alias}`;
          case 'count_distinct': return `COUNT(DISTINCT ${col}) as ${alias}`;
          case 'sum': return `SUM(${col}) as ${alias}`;
          case 'avg': return `AVG(${col}) as ${alias}`;
          case 'min': return `MIN(${col}) as ${alias}`;
          case 'max': return `MAX(${col}) as ${alias}`;
          default: return `COUNT(*) as agg_${i}`;
        }
      });

      const groupBySql = groupBy ? buildGroupBy(groupBy) : '';
      let sql = `SELECT ${groupBySql ? groupBySql + ', ' : ''}${selects.join(', ')} FROM ${tableName}`;
      let params: any[] = [];

      if (where && Object.keys(where).length) {
        const w = buildWhereClause(where);
        sql += ` WHERE ${w.sql}`;
        params = w.params;
      }

      if (groupBySql) sql += ` GROUP BY ${groupBySql}`;

      const rows = await db.all(sql, params);
      res.json({ result: rows });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/update — Update rows ─────────────

  router.post('/storage/update', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where, set } = req.body as { table: string; where: Record<string, any>; set: Record<string, any> };
      if (!table || !where || !set) return res.status(400).json({ error: 'table, where, and set are required' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot update system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      const setKeys = requireIdentifierList(Object.keys(set), 'set key');
      const setClauses = setKeys.map(k => `${k} = ?`);
      const setVals = Object.values(set).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
      const w = buildWhereClause(where);

      await db.run(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${w.sql}`, [...setVals, ...w.params]);
      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/delete-rows — Delete rows ───────

  router.post('/storage/delete-rows', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where } = req.body as { table: string; where: Record<string, any> };
      if (!table || !where || !Object.keys(where).length) return res.status(400).json({ error: 'table and where are required (no blanket deletes)' });

      const tableName = resolveTable(agent.id, table);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot delete from system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      const w = buildWhereClause(where);
      await db.run(`DELETE FROM ${tableName} WHERE ${w.sql}`, w.params);

      const countResult = await db.get(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      await db.run('UPDATE agenticmail_storage_meta SET row_count = ?, updated_at = ' + nowExpr(dialect) + ' WHERE table_name = ?', [countResult?.cnt || 0, tableName]);

      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/truncate — Delete all rows ──────

  router.post('/storage/tables/:name/truncate', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      if (dialect === 'sqlite' || dialect === 'turso') {
        await db.run(`DELETE FROM ${tableName}`);
      } else {
        await db.run(`TRUNCATE TABLE ${tableName}`);
      }

      await db.run('UPDATE agenticmail_storage_meta SET row_count = 0, updated_at = ' + nowExpr(dialect) + ' WHERE table_name = ?', [tableName]);
      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ARCHIVE & LIFECYCLE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  router.post('/storage/tables/:name/archive', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      const archivedName = `${tableName}__archived`;
      await db.run(`ALTER TABLE ${tableName} RENAME TO ${archivedName}`);
      await db.run(`UPDATE agenticmail_storage_meta SET table_name = ?, archived_at = ${nowExpr(dialect)} WHERE table_name = ?`, [archivedName, tableName]);

      res.json({ ok: true, archived: archivedName });
    } catch (err: any) { sendStorageError(res, err); }
  });

  router.post('/storage/tables/:name/unarchive', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const archivedName = requireTableName(
        req.params.name.endsWith('__archived') ? req.params.name : `${resolveTable(agent.id, req.params.name)}__archived`,
      );
      const meta = await db.get('SELECT * FROM agenticmail_storage_meta WHERE table_name = ?', [archivedName]);
      if (!meta) return res.status(404).json({ error: 'Archived table not found' });
      if (meta.agent_id !== agent.id) return res.status(403).json({ error: 'Only the owner can unarchive' });

      const restoredName = archivedName.replace('__archived', '');
      await db.run(`ALTER TABLE ${archivedName} RENAME TO ${restoredName}`);
      await db.run('UPDATE agenticmail_storage_meta SET table_name = ?, archived_at = NULL WHERE table_name = ?', [restoredName, archivedName]);

      res.json({ ok: true, restored: restoredName });
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // IMPORT / EXPORT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ─── POST /storage/tables/:name/export — Export data as JSON ─

  router.post('/storage/tables/:name/export', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { format, where, limit } = req.body as { format?: 'json' | 'csv'; where?: Record<string, any>; limit?: number };
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      let sql = `SELECT * FROM ${tableName}`;
      let params: any[] = [];
      if (where && Object.keys(where).length) {
        const w = buildWhereClause(where);
        sql += ` WHERE ${w.sql}`;
        params = w.params;
      }
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }

      const rows = await db.all(sql, params);

      if (format === 'csv') {
        if (!rows.length) return res.json({ csv: '', rowCount: 0 });
        const headers = Object.keys(rows[0]);
        const csvLines = [headers.join(',')];
        for (const row of rows) {
          csvLines.push(headers.map(h => {
            const v = (row as any)[h];
            if (v === null || v === undefined) return '';
            const s = String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(','));
        }
        return res.json({ csv: csvLines.join('\n'), rowCount: rows.length });
      }

      res.json({ rows, rowCount: rows.length });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/tables/:name/import — Bulk import ─

  router.post('/storage/tables/:name/import', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { rows, onConflict, conflictColumn } = req.body as {
        rows: Record<string, any>[];
        onConflict?: 'skip' | 'replace' | 'error';
        conflictColumn?: string;
      };
      if (!rows?.length) return res.status(400).json({ error: 'rows are required' });

      const tableName = resolveTable(agent.id, req.params.name);
      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot import into system tables' });
      const meta = await verifyAccess(agent, tableName, res);
      if (!meta) return;

      let imported = 0;
      let skipped = 0;

      for (const row of rows) {
        const keys = requireIdentifierList(Object.keys(row), 'row key');
        const vals = Object.values(row).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        const placeholders = keys.map(() => '?').join(', ');

        try {
          if (onConflict === 'replace' && conflictColumn) {
            const safeConflictColumn = requireIdentifier(conflictColumn, 'conflict column');
            const updateCols = keys.filter(k => k !== safeConflictColumn).map(k => `${k} = excluded.${k}`).join(', ');
            if (dialect === 'mysql') {
              const dupUpdate = keys.filter(k => k !== safeConflictColumn).map(k => `${k} = VALUES(${k})`).join(', ');
              await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${dupUpdate}`, vals);
            } else {
              await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${safeConflictColumn}) DO UPDATE SET ${updateCols}`, vals);
            }
          } else if (onConflict === 'skip' && conflictColumn) {
            const safeConflictColumn = requireIdentifier(conflictColumn, 'conflict column');
            if (dialect === 'mysql') {
              await db.run(`INSERT IGNORE INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`, vals);
            } else {
              await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${safeConflictColumn}) DO NOTHING`, vals);
            }
          } else {
            await db.run(`INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`, vals);
          }
          imported++;
        } catch (e: any) {
          if (onConflict === 'skip') { skipped++; continue; }
          throw e;
        }
      }

      const countResult = await db.get(`SELECT COUNT(*) as cnt FROM ${tableName}`);
      await db.run('UPDATE agenticmail_storage_meta SET row_count = ?, updated_at = ' + nowExpr(dialect) + ' WHERE table_name = ?', [countResult?.cnt || 0, tableName]);

      res.json({ ok: true, imported, skipped, totalRows: countResult?.cnt || 0 });
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RAW SQL (advanced, guarded)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  router.post('/storage/sql', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { sql, params } = req.body as { sql: string; params?: any[] };
      if (!sql) return res.status(400).json({ error: 'sql is required' });
      if (params !== undefined && !Array.isArray(params)) return res.status(400).json({ error: 'params must be an array' });

      // Single statement, allowed type, every referenced object owned or
      // shared — see verifySqlAccess. Execute the analysed text, not `sql`.
      const statement = await verifySqlAccess(agent, sql);

      if (statement.kind === 'read') {
        const rows = await db.all(statement.sql, params);
        return res.json({ rows, count: rows.length });
      } else {
        await db.run(statement.sql, params);
        return res.json({ ok: true });
      }
    } catch (err: any) { sendStorageError(res, err); }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MAINTENANCE & STATS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ─── GET /storage/stats — Agent storage stats ───────

  router.get('/storage/stats', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tables = await db.all('SELECT * FROM agenticmail_storage_meta WHERE agent_id = ? AND archived_at IS NULL', [agent.id]);
      const archived = await db.all('SELECT * FROM agenticmail_storage_meta WHERE agent_id = ? AND archived_at IS NOT NULL', [agent.id]);

      let totalRows = 0;
      for (const t of tables) totalRows += t.row_count || 0;

      // Get DB size info (SQLite only)
      let dbSize: any = null;
      if (dialect === 'sqlite' || dialect === 'turso') {
        try {
          const pageCount = await db.get('PRAGMA page_count');
          const pageSize = await db.get('PRAGMA page_size');
          if (pageCount && pageSize) {
            dbSize = { bytes: (pageCount.page_count || 0) * (pageSize.page_size || 0) };
          }
        } catch {}
      }

      res.json({
        tables: tables.length,
        archivedTables: archived.length,
        totalRows,
        dbSize,
        dialect,
      });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/vacuum — Optimize/compact database ─

  router.post('/storage/vacuum', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;

    try {
      if (dialect === 'sqlite' || dialect === 'turso') {
        await db.run('VACUUM');
      } else if (dialect === 'postgres') {
        // VACUUM can't run in a transaction, best-effort
        await db.run('VACUUM ANALYZE');
      } else if (dialect === 'mysql') {
        // Get agent tables and optimize them
        const tables = await db.all('SELECT table_name FROM agenticmail_storage_meta WHERE agent_id = ? AND archived_at IS NULL', [agent.id]);
        for (const t of tables) await db.run(`OPTIMIZE TABLE ${t.table_name}`);
      }
      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/analyze — Update query planner stats ─

  router.post('/storage/tables/:name/analyze', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const tableName = resolveTable(agent.id, req.params.name);
      const meta = await verifyAccess(agent, tableName, res, true);
      if (!meta) return;

      if (dialect === 'sqlite' || dialect === 'turso') {
        await db.run(`ANALYZE ${tableName}`);
      } else if (dialect === 'postgres') {
        await db.run(`ANALYZE ${tableName}`);
      } else if (dialect === 'mysql') {
        await db.run(`ANALYZE TABLE ${tableName}`);
      }

      res.json({ ok: true });
    } catch (err: any) { sendStorageError(res, err); }
  });

  // ─── POST /storage/explain — Query execution plan ───

  router.post('/storage/explain', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { sql, params } = req.body as { sql: string; params?: any[] };
      if (!sql) return res.status(400).json({ error: 'sql is required' });
      if (params !== undefined && !Array.isArray(params)) return res.status(400).json({ error: 'params must be an array' });
      const statement = await verifySqlAccess(agent, sql);
      if (statement.firstKeyword === 'EXPLAIN') return res.status(400).json({ error: 'Pass the statement itself, without EXPLAIN' });

      let explainSql: string;
      if (dialect === 'postgres') {
        explainSql = `EXPLAIN (ANALYZE false, FORMAT JSON) ${statement.sql}`;
      } else if (dialect === 'mysql') {
        explainSql = `EXPLAIN FORMAT=JSON ${statement.sql}`;
      } else {
        explainSql = `EXPLAIN QUERY PLAN ${statement.sql}`;
      }

      const plan = await db.all(explainSql, params);
      res.json({ plan });
    } catch (err: any) { sendStorageError(res, err); }
  });

  return router;
}
