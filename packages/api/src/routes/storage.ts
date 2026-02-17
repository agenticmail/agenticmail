/**
 * Storage Routes — Dynamic table/collection management for agents
 *
 * Lets agents create, query, and manage their own data tables at runtime.
 * Tables are prefixed with `agt_` (per-agent) or `shared_` (org-wide).
 * Works across all database backends (SQLite, Postgres, MySQL, Turso, MongoDB, DynamoDB).
 */

import { Router, type Request, type Response } from 'express';
import type { AccountManager, AgenticMailConfig } from '@agenticmail/core';

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
}

interface IndexDef {
  columns: string[];
  unique?: boolean;
}

// ─── Helpers ────────────────────────────────────────────

function mapColumnType(col: ColumnDef, dialect: string): string {
  const typeMap: Record<string, Record<string, string>> = {
    sqlite: { text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'JSON', blob: 'BLOB', timestamp: 'TEXT' },
    postgres: { text: 'TEXT', integer: 'INTEGER', real: 'DOUBLE PRECISION', boolean: 'BOOLEAN', json: 'JSONB', blob: 'BYTEA', timestamp: 'TIMESTAMPTZ' },
    mysql: { text: 'TEXT', integer: 'INT', real: 'DOUBLE', boolean: 'TINYINT(1)', json: 'JSON', blob: 'LONGBLOB', timestamp: 'DATETIME' },
    turso: { text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'TEXT', blob: 'BLOB', timestamp: 'TEXT' },
  };
  return (typeMap[dialect] || typeMap.sqlite)[col.type] || 'TEXT';
}

function buildColumnDDL(col: ColumnDef, dialect: string): string {
  let ddl = `${col.name} ${mapColumnType(col, dialect)}`;
  if (col.primaryKey) ddl += ' PRIMARY KEY';
  if (col.required && !col.primaryKey) ddl += ' NOT NULL';
  if (col.unique && !col.primaryKey) ddl += ' UNIQUE';
  if (col.default !== undefined) {
    const val = typeof col.default === 'string' ? `'${col.default}'` : col.default;
    ddl += ` DEFAULT ${val}`;
  }
  return ddl;
}

function safeTableName(agentId: string, name: string, shared: boolean): string {
  // Sanitize: only alphanumeric + underscores
  const clean = name.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 64);
  if (!clean) throw new Error('Invalid table name');
  const prefix = shared ? 'shared' : `agt_${agentId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16)}`;
  return `${prefix}_${clean}`;
}

function isSafeTable(tableName: string): boolean {
  return tableName.startsWith('agt_') || tableName.startsWith('shared_');
}

// ─── Routes ─────────────────────────────────────────────

export function createStorageRoutes(
  db: StorageDB,
  accountManager: AccountManager,
  config: AgenticMailConfig,
  dialect: string = 'sqlite',
): Router {
  const router = Router();

  /** Helper: get authenticated agent or return 401 */
  function getAgent(req: Request, res: Response): { id: string; email: string } | null {
    const agent = (req as any).agent;
    if (!agent) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return agent;
  }

  // ─── Metadata tracking table ────────────────────────
  // Track which tables exist and who owns them
  const ensureMetaTable = (() => {
    let done = false;
    return async () => {
      if (done) return;
      await db.run(`
        CREATE TABLE IF NOT EXISTS agenticmail_storage_meta (
          table_name TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          shared INTEGER NOT NULL DEFAULT 0,
          columns JSON NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (${dialect === 'postgres' ? 'NOW()' : "datetime('now')"}),
          archived_at TEXT
        )
      `);
      done = true;
    };
  })();

  // ─── POST /storage/tables — Create a new table ──────

  router.post('/storage/tables', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { name, columns, indexes, shared } = req.body as {
        name: string;
        columns: ColumnDef[];
        indexes?: IndexDef[];
        shared?: boolean;
      };

      if (!name || !columns?.length) {
        return res.status(400).json({ error: 'name and columns are required' });
      }

      // Ensure at least one column is a primary key, or auto-add id
      const hasPK = columns.some(c => c.primaryKey);
      const allCols = hasPK ? columns : [{ name: 'id', type: 'text' as const, primaryKey: true }, ...columns];

      const tableName = safeTableName(agent.id, name, !!shared);

      // Check if already exists
      const existing = await db.get('SELECT table_name FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (existing) {
        return res.status(409).json({ error: `Table "${name}" already exists`, table: tableName });
      }

      // Build CREATE TABLE DDL
      const colDefs = allCols.map(c => buildColumnDDL(c, dialect)).join(',\n  ');
      const createSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${colDefs}\n)`;
      await db.run(createSQL);

      // Create indexes
      if (indexes?.length) {
        for (let i = 0; i < indexes.length; i++) {
          const idx = indexes[i];
          const idxName = `idx_${tableName}_${i}`;
          const unique = idx.unique ? 'UNIQUE ' : '';
          await db.run(`CREATE ${unique}INDEX IF NOT EXISTS ${idxName} ON ${tableName}(${idx.columns.join(', ')})`);
        }
      }

      // Record in metadata
      await db.run(
        'INSERT INTO agenticmail_storage_meta (table_name, agent_id, display_name, shared, columns) VALUES (?, ?, ?, ?, ?)',
        [tableName, agent.id, name, shared ? 1 : 0, JSON.stringify(allCols)]
      );

      res.json({ ok: true, table: tableName, columns: allCols });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /storage/tables — List agent's tables ──────

  router.get('/storage/tables', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const includeShared = req.query.includeShared !== 'false';
      const includeArchived = req.query.includeArchived === 'true';

      let sql = 'SELECT * FROM agenticmail_storage_meta WHERE (agent_id = ?';
      const params: any[] = [agent.id];

      if (includeShared) {
        sql += ' OR shared = 1';
      }
      sql += ')';

      if (!includeArchived) {
        sql += ' AND archived_at IS NULL';
      }

      const tables = await db.all(sql, params);
      res.json({
        tables: tables.map((t: any) => ({
          name: t.display_name,
          table: t.table_name,
          shared: !!t.shared,
          archived: !!t.archived_at,
          columns: typeof t.columns === 'string' ? JSON.parse(t.columns) : t.columns,
          createdAt: t.created_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/insert — Insert rows ─────────────

  router.post('/storage/insert', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, rows } = req.body as { table: string; rows: Record<string, any>[] };
      if (!table || !rows?.length) {
        return res.status(400).json({ error: 'table and rows are required' });
      }

      // Resolve table name
      const tableName = table.startsWith('agt_') || table.startsWith('shared_')
        ? table : safeTableName(agent.id, table, false);

      if (!isSafeTable(tableName)) {
        return res.status(403).json({ error: 'Cannot insert into system tables' });
      }

      // Verify ownership
      const meta = await db.get('SELECT agent_id, shared FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id && !meta.shared) {
        return res.status(403).json({ error: 'Access denied' });
      }

      let inserted = 0;
      for (const row of rows) {
        const keys = Object.keys(row);
        const vals = Object.values(row).map(v => typeof v === 'object' ? JSON.stringify(v) : v);
        const placeholders = keys.map(() => '?').join(', ');
        await db.run(
          `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`,
          vals
        );
        inserted++;
      }

      res.json({ ok: true, inserted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/query — Query rows ───────────────

  router.post('/storage/query', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where, orderBy, limit, offset, columns } = req.body as {
        table: string;
        where?: Record<string, any>;
        orderBy?: string;
        limit?: number;
        offset?: number;
        columns?: string[];
      };

      if (!table) return res.status(400).json({ error: 'table is required' });

      const tableName = table.startsWith('agt_') || table.startsWith('shared_')
        ? table : safeTableName(agent.id, table, false);

      if (!isSafeTable(tableName)) {
        return res.status(403).json({ error: 'Cannot query system tables' });
      }

      // Verify ownership
      const meta = await db.get('SELECT agent_id, shared FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id && !meta.shared) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const selectCols = columns?.length ? columns.join(', ') : '*';
      let sql = `SELECT ${selectCols} FROM ${tableName}`;
      const params: any[] = [];

      if (where && Object.keys(where).length) {
        const conditions = Object.entries(where).map(([k, v]) => {
          if (v === null) return `${k} IS NULL`;
          if (Array.isArray(v)) {
            params.push(...v);
            return `${k} IN (${v.map(() => '?').join(', ')})`;
          }
          params.push(typeof v === 'object' ? JSON.stringify(v) : v);
          return `${k} = ?`;
        });
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      if (orderBy) sql += ` ORDER BY ${orderBy.replace(/[^a-zA-Z0-9_, ]/g, '')}`;
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      if (offset) { sql += ' OFFSET ?'; params.push(offset); }

      const rows = await db.all(sql, params);
      res.json({ rows, count: rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/update — Update rows ─────────────

  router.post('/storage/update', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where, set } = req.body as {
        table: string;
        where: Record<string, any>;
        set: Record<string, any>;
      };

      if (!table || !where || !set) {
        return res.status(400).json({ error: 'table, where, and set are required' });
      }

      const tableName = table.startsWith('agt_') || table.startsWith('shared_')
        ? table : safeTableName(agent.id, table, false);

      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot update system tables' });

      const meta = await db.get('SELECT agent_id, shared FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id && !meta.shared) return res.status(403).json({ error: 'Access denied' });

      const setClauses = Object.keys(set).map(k => `${k} = ?`);
      const setVals = Object.values(set).map(v => typeof v === 'object' ? JSON.stringify(v) : v);

      const whereClauses = Object.entries(where).map(([k, v]) => {
        if (v === null) return `${k} IS NULL`;
        setVals.push(typeof v === 'object' ? JSON.stringify(v) : v);
        return `${k} = ?`;
      });

      await db.run(
        `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
        setVals
      );

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/delete-rows — Delete rows ───────

  router.post('/storage/delete-rows', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const { table, where } = req.body as {
        table: string;
        where: Record<string, any>;
      };

      if (!table || !where || !Object.keys(where).length) {
        return res.status(400).json({ error: 'table and where are required (no blanket deletes)' });
      }

      const tableName = table.startsWith('agt_') || table.startsWith('shared_')
        ? table : safeTableName(agent.id, table, false);

      if (!isSafeTable(tableName)) return res.status(403).json({ error: 'Cannot delete from system tables' });

      const meta = await db.get('SELECT agent_id, shared FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id && !meta.shared) return res.status(403).json({ error: 'Access denied' });

      const params: any[] = [];
      const conditions = Object.entries(where).map(([k, v]) => {
        if (v === null) return `${k} IS NULL`;
        params.push(typeof v === 'object' ? JSON.stringify(v) : v);
        return `${k} = ?`;
      });

      await db.run(`DELETE FROM ${tableName} WHERE ${conditions.join(' AND ')}`, params);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /storage/tables/:name — Drop a table ────

  router.delete('/storage/tables/:name', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const name = req.params.name;
      const tableName = name.startsWith('agt_') || name.startsWith('shared_')
        ? name : safeTableName(agent.id, name, false);

      const meta = await db.get('SELECT agent_id FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id) return res.status(403).json({ error: 'Only the owner can drop a table' });

      await db.run(`DROP TABLE IF EXISTS ${tableName}`);
      await db.run('DELETE FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);

      res.json({ ok: true, dropped: tableName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/tables/:name/archive — Archive ──

  router.post('/storage/tables/:name/archive', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const name = req.params.name;
      const tableName = name.startsWith('agt_') || name.startsWith('shared_')
        ? name : safeTableName(agent.id, name, false);

      const meta = await db.get('SELECT agent_id FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id) return res.status(403).json({ error: 'Only the owner can archive' });

      const now = dialect === 'postgres' ? 'NOW()' : "datetime('now')";
      await db.run(`UPDATE agenticmail_storage_meta SET archived_at = ${now} WHERE table_name = ?`, [tableName]);

      // Rename table to mark as archived
      const archivedName = `${tableName}__archived`;
      await db.run(`ALTER TABLE ${tableName} RENAME TO ${archivedName}`);
      await db.run('UPDATE agenticmail_storage_meta SET table_name = ? WHERE table_name = ?', [archivedName, tableName]);

      res.json({ ok: true, archived: archivedName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/tables/:name/unarchive — Restore ─

  router.post('/storage/tables/:name/unarchive', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const name = req.params.name;
      const archivedName = name.endsWith('__archived') ? name : `${name}__archived`;

      const meta = await db.get('SELECT agent_id, table_name FROM agenticmail_storage_meta WHERE table_name = ?', [archivedName]);
      if (!meta) return res.status(404).json({ error: 'Archived table not found' });
      if (meta.agent_id !== agent.id) return res.status(403).json({ error: 'Only the owner can unarchive' });

      const restoredName = archivedName.replace('__archived', '');
      await db.run(`ALTER TABLE ${archivedName} RENAME TO ${restoredName}`);
      await db.run('UPDATE agenticmail_storage_meta SET table_name = ?, archived_at = NULL WHERE table_name = ?', [restoredName, archivedName]);

      res.json({ ok: true, restored: restoredName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /storage/tables/:name/columns — Add column ─

  router.post('/storage/tables/:name/columns', async (req: Request, res: Response) => {
    const agent = getAgent(req, res);
    if (!agent) return;
    await ensureMetaTable();

    try {
      const name = req.params.name;
      const { column } = req.body as { column: ColumnDef };

      if (!column?.name || !column?.type) {
        return res.status(400).json({ error: 'column with name and type is required' });
      }

      const tableName = name.startsWith('agt_') || name.startsWith('shared_')
        ? name : safeTableName(agent.id, name, false);

      const meta = await db.get('SELECT agent_id, columns FROM agenticmail_storage_meta WHERE table_name = ?', [tableName]);
      if (!meta) return res.status(404).json({ error: 'Table not found' });
      if (meta.agent_id !== agent.id) return res.status(403).json({ error: 'Only the owner can alter tables' });

      await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${buildColumnDDL(column, dialect)}`);

      // Update metadata
      const cols = typeof meta.columns === 'string' ? JSON.parse(meta.columns) : meta.columns;
      cols.push(column);
      await db.run('UPDATE agenticmail_storage_meta SET columns = ? WHERE table_name = ?', [JSON.stringify(cols), tableName]);

      res.json({ ok: true, column: column.name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
