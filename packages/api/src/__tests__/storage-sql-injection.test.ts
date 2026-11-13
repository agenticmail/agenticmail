/**
 * Regression tests for the storage SQL advisories:
 *
 *   GHSA-vj36-c6cj-8qmh — comment between keyword and table name hid the
 *     table from the raw-SQL ownership guard; the index route ran stacked
 *     statements.
 *   GHSA-fgq6-mm4x-93qq — idx.where raw interpolation; ATTACH DATABASE not
 *     caught by the raw-SQL guard.
 *   GHSA-m52q-h5cf-mj6c — columns[].check / columns[].default / idx.where
 *     injection into DDL run through multi-statement exec().
 *
 * The routes are mounted on a RAW node:sqlite DatabaseSync, exactly as
 * app.ts does, so the production adapter (and its old exec() path) is the
 * one under test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStorageRoutes } from '../routes/storage.js';
import { analyzeRawSql, tokenizeSql, validateSqlExpression } from '../lib/sql-guard.js';

const ALICE = { id: 'aliceagent000001', email: 'alice@example.com' };
const BOB = { id: 'bobagent00000001', email: 'bob@example.com' };
const ALICE_KEY = 'ak_' + 'a'.repeat(48);
const BOB_KEY = 'ak_' + 'b'.repeat(48);
const ALICE_SECRETS = `agt_${ALICE.id}_secrets`;
const BOB_NOTES = `agt_${BOB.id}_notes`;

const servers: Server[] = [];
const dbs: DatabaseSync[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
});

async function request(baseUrl: string, path: string, body: unknown, as: 'alice' | 'bob' = 'bob', method = 'POST') {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-agent': as },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL UNIQUE, metadata TEXT);
    INSERT INTO agents VALUES ('${ALICE.id}', 'alice', '${ALICE_KEY}', '{"note":"ORIGINAL"}');
    INSERT INTO agents VALUES ('${BOB.id}', 'bob', '${BOB_KEY}', '{}');
  `);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).agent = req.headers['x-agent'] === 'alice' ? ALICE : BOB;
    next();
  });
  // Raw DatabaseSync — the production adapter path.
  app.use(createStorageRoutes(db, {} as any, {} as any));
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const a = await request(baseUrl, '/storage/tables', {
    name: 'secrets', timestamps: false,
    columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'secret', type: 'text' }],
  }, 'alice');
  expect(a.status).toBe(200);
  expect(a.body.table).toBe(ALICE_SECRETS);
  await request(baseUrl, '/storage/insert', { table: 'secrets', rows: [{ id: 's1', secret: 'CANARY-A' }] }, 'alice');

  const b = await request(baseUrl, '/storage/tables', {
    name: 'notes', timestamps: false,
    columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'note', type: 'text' }, { name: 'price', type: 'integer' }],
  }, 'bob');
  expect(b.status).toBe(200);
  expect(b.body.table).toBe(BOB_NOTES);
  await request(baseUrl, '/storage/insert', { table: 'notes', rows: [{ id: 'n1', note: 'mine', price: 5 }] }, 'bob');

  const tableExists = (name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name);
  const aliceMetadata = () => (db.prepare("SELECT metadata FROM agents WHERE id = ?").get(ALICE.id) as any).metadata;
  return { db, baseUrl, tableExists, aliceMetadata };
}

function expectNoLeak(res: { status: number; text: string }) {
  expect(res.status).not.toBe(200);
  expect(res.text).not.toContain(ALICE_KEY);
  expect(res.text).not.toContain('CANARY-A');
}

describe('GHSA-vj36-c6cj-8qmh — raw SQL ownership guard', () => {
  it('control: plain FROM agents and another agent\'s table are refused, own table is allowed', async () => {
    const { baseUrl } = await setup();
    expectNoLeak(await request(baseUrl, '/storage/sql', { sql: 'SELECT name, api_key FROM agents' }));
    expectNoLeak(await request(baseUrl, '/storage/sql', { sql: `SELECT secret FROM ${ALICE_SECRETS}` }));
    const own = await request(baseUrl, '/storage/sql', { sql: `SELECT note FROM ${BOB_NOTES}` });
    expect(own.status).toBe(200);
    expect(own.body.rows).toEqual([{ note: 'mine' }]);
  });

  const bypasses: [string, string][] = [
    ['block comment', 'SELECT name, api_key FROM/**/agents'],
    ['line comment + newline', 'SELECT name, api_key FROM--\nagents'],
    ['double-quoted identifier', 'SELECT name, api_key FROM"agents"'],
    ['single-quoted table name', "SELECT name, api_key FROM'agents'"],
    ['bracket identifier', 'SELECT name, api_key FROM[agents]'],
    ['backtick identifier', 'SELECT name, api_key FROM`agents`'],
    ['schema-qualified', 'SELECT name, api_key FROM main.agents'],
    ['comma join', `SELECT api_key FROM ${BOB_NOTES}, agents`],
    ['subquery in select list', `SELECT (SELECT group_concat(api_key) FROM/**/agents) FROM ${BOB_NOTES}`],
    ['comment-hidden victim table', `SELECT secret FROM/**/${ALICE_SECRETS}`],
    ['CTE', 'WITH x AS (SELECT api_key FROM\tagents) SELECT * FROM x'],
    ['UNION', `SELECT note FROM ${BOB_NOTES} UNION SELECT api_key FROM "agents"`],
    ['sqlite_master', 'SELECT sql FROM sqlite_master'],
    ['pragma table function', "SELECT * FROM pragma_table_info('agents')"],
    ['storage metadata, quoted', 'SELECT * FROM "agenticmail_storage_meta"'],
  ];
  for (const [label, sql] of bypasses) {
    it(`refuses ${label}`, async () => {
      const { baseUrl } = await setup();
      expectNoLeak(await request(baseUrl, '/storage/sql', { sql }));
      expectNoLeak(await request(baseUrl, '/storage/explain', { sql }));
    });
  }

  it('refuses stacked statements in raw SQL and leaves agents untouched', async () => {
    const { baseUrl, aliceMetadata } = await setup();
    const res = await request(baseUrl, '/storage/sql', {
      sql: `UPDATE ${BOB_NOTES} SET note = 'x'; UPDATE agents SET metadata = 'PWNED' WHERE name = 'alice'`,
    });
    expect(res.status).not.toBe(200);
    expect(aliceMetadata()).toBe('{"note":"ORIGINAL"}');
  });

  it('refuses writes to core tables hidden behind comments', async () => {
    const { baseUrl, aliceMetadata } = await setup();
    const res = await request(baseUrl, '/storage/sql', {
      sql: "UPDATE/**/agents SET metadata = 'PWNED' WHERE name = 'alice'",
    });
    expect(res.status).not.toBe(200);
    expect(aliceMetadata()).toBe('{"note":"ORIGINAL"}');
  });

  it('D4: index route where with stacked UPDATE is refused and agents are untouched', async () => {
    const { baseUrl, aliceMetadata } = await setup();
    const control = await request(baseUrl, `/storage/tables/notes/indexes`, { columns: ['note'], name: 'idx_control', where: 'price > 0' });
    expect(control.status).toBe(200);

    const attack = await request(baseUrl, `/storage/tables/notes/indexes`, {
      columns: ['note'], name: 'idx_attack',
      where: `1; UPDATE agents SET metadata='{"note":"OVERWRITTEN"}' WHERE name='alice'; --`,
    });
    expect(attack.status).toBe(400);
    expect(aliceMetadata()).toBe('{"note":"ORIGINAL"}');
  });

  it('index route refuses injection through name and columns', async () => {
    const { baseUrl, aliceMetadata } = await setup();
    const byName = await request(baseUrl, `/storage/tables/notes/indexes`, {
      columns: ['note'],
      name: "x ON agt_x(a); UPDATE agents SET metadata='PWNED'; CREATE INDEX y",
    });
    expect(byName.status).toBe(400);
    const byColumn = await request(baseUrl, `/storage/tables/notes/indexes`, {
      columns: ["note); UPDATE agents SET metadata='PWNED'; CREATE INDEX z ON agents(id"],
    });
    expect(byColumn.status).toBe(400);
    expect(aliceMetadata()).toBe('{"note":"ORIGINAL"}');
  });
});

describe('GHSA-fgq6-mm4x-93qq — idx.where and ATTACH', () => {
  it('index where cannot copy another agent\'s rows or the metadata table', async () => {
    const { baseUrl } = await setup();
    const attack = await request(baseUrl, `/storage/tables/notes/indexes`, {
      columns: ['id'],
      where: `1=1; INSERT INTO ${BOB_NOTES} (id) SELECT 'secrets:'||id||'='||secret FROM ${ALICE_SECRETS}; INSERT INTO ${BOB_NOTES} (id) SELECT 'meta:'||table_name FROM agenticmail_storage_meta; --`,
    });
    expect(attack.status).toBe(400);
    const rows = await request(baseUrl, '/storage/query', { table: 'notes' });
    expect(rows.status).toBe(200);
    expect(JSON.stringify(rows.body)).not.toContain('CANARY-A');
    expect(JSON.stringify(rows.body)).not.toContain('meta:');
  });

  it('index where cannot reference other tables through a subquery', async () => {
    const { baseUrl } = await setup();
    const res = await request(baseUrl, `/storage/tables/notes/indexes`, {
      columns: ['id'], where: `note IN (SELECT api_key FROM agents)`,
    });
    expect(res.status).toBe(400);
  });

  it('ATTACH DATABASE is refused and writes no file', async () => {
    const { baseUrl } = await setup();
    const target = join(tmpdir(), `am-attach-${randomBytes(6).toString('hex')}.db`);
    try {
      const plain = await request(baseUrl, '/storage/sql', { sql: `ATTACH DATABASE '${target}' AS ext` });
      expect(plain.status).toBe(403);
      const stacked = await request(baseUrl, '/storage/sql', { sql: `ATTACH DATABASE '${target}' AS ext; PRAGMA ext.user_version = 424242;` });
      expect(stacked.status).not.toBe(200);
      const hidden = await request(baseUrl, '/storage/sql', { sql: `SELECT 1; ATTACH DATABASE '${target}' AS ext` });
      expect(hidden.status).not.toBe(200);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it('PRAGMA, DETACH and VACUUM INTO are refused in raw SQL', async () => {
    const { baseUrl } = await setup();
    const target = join(tmpdir(), `am-vacuum-${randomBytes(6).toString('hex')}.db`);
    try {
      for (const sql of ['PRAGMA writable_schema = 1', 'DETACH DATABASE ext', `VACUUM INTO '${target}'`]) {
        const res = await request(baseUrl, '/storage/sql', { sql });
        expect(res.status).toBe(403);
      }
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  });
});

describe('GHSA-m52q-h5cf-mj6c — DDL expression injection', () => {
  const leakPayload = `CREATE TABLE IF NOT EXISTS shared_leak AS SELECT name, api_key FROM agents`;

  it('indexes[].where on create-table cannot stack statements (advisory PoC)', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'poc', timestamps: false,
      columns: [{ name: 'note', type: 'text' }],
      indexes: [{ columns: ['note'], where: `1=1; ${leakPayload}; INSERT INTO agenticmail_storage_meta(table_name,agent_id,display_name,shared) VALUES('shared_leak','${BOB.id}','leaked',1)` }],
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
    // Validation runs before CREATE TABLE, so no orphan table is left behind.
    expect(tableExists(`agt_${BOB.id}_poc`)).toBe(false);
  });

  it('columns[].check cannot stack statements', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'chk', timestamps: false,
      columns: [{ name: 'note', type: 'text', check: `1)); ${leakPayload}; CREATE TABLE agt_${BOB.id}_x ((x` }],
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
  });

  it('columns[].check cannot reference another table', async () => {
    const { baseUrl } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'chk2', timestamps: false,
      columns: [{ name: 'note', type: 'text', check: `note IN (SELECT api_key FROM agents)` }],
    });
    expect(res.status).toBe(400);
  });

  it('columns[].default (SQL-expression path) cannot stack statements', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'dflt', timestamps: false,
      columns: [{ name: 'note', type: 'text', default: `datetime('now')); ${leakPayload}; CREATE TABLE agt_${BOB.id}_y (y DEFAULT (1` }],
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
  });

  it('non-scalar defaults are refused instead of stringified into SQL', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'dflt2', timestamps: false,
      columns: [{ name: 'note', type: 'text', default: [`1); ${leakPayload}; SELECT (1`] }],
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
  });

  it('references.onDelete is restricted to the real actions', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables', {
      name: 'fk', timestamps: false,
      columns: [{ name: 'note', type: 'text', references: { table: BOB_NOTES, column: 'id', onDelete: `CASCADE); ${leakPayload}; CREATE TABLE agt_${BOB.id}_z (z TEXT` } }],
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
  });

  it('add-column check cannot stack statements', async () => {
    const { baseUrl, tableExists } = await setup();
    const res = await request(baseUrl, '/storage/tables/notes/columns', {
      column: { name: 'extra', type: 'text', check: `1); ${leakPayload}; SELECT (1` },
    });
    expect(res.status).toBe(400);
    expect(tableExists('shared_leak')).toBe(false);
  });

  it('drop-column and rename-column refuse non-identifiers', async () => {
    const { baseUrl, aliceMetadata } = await setup();
    const drop = await fetch(`${baseUrl}/storage/tables/notes/columns/${encodeURIComponent("note; UPDATE agents SET metadata='PWNED'")}`, {
      method: 'DELETE', headers: { 'x-agent': 'bob' },
    });
    expect(drop.status).toBe(400);
    const rename = await request(baseUrl, '/storage/tables/notes/rename-column', {
      oldName: 'note', newName: "n; UPDATE agents SET metadata='PWNED'",
    });
    expect(rename.status).toBe(400);
    expect(aliceMetadata()).toBe('{"note":"ORIGINAL"}');
  });
});

describe('related hardening', () => {
  it('having cannot run a subquery against another table', async () => {
    const { baseUrl } = await setup();
    const res = await request(baseUrl, '/storage/query', {
      table: 'notes', groupBy: 'note',
      having: `COUNT(*) > 0 AND (SELECT COUNT(*) FROM agents WHERE api_key LIKE 'ak_a%') > 0`,
    });
    expect(res.status).toBe(400);
  });

  it('cannot drop an index that belongs to another table', async () => {
    const { baseUrl, db } = await setup();
    db.exec('CREATE INDEX idx_agents_name ON agents(name)');
    const res = await fetch(`${baseUrl}/storage/tables/notes/indexes/idx_agents_name`, { method: 'DELETE', headers: { 'x-agent': 'bob' } });
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_agents_name'").get()).toBeTruthy();
  });
});

describe('legitimate use keeps working', () => {
  it('check, default, partial index, having and raw SQL on own tables', async () => {
    const { baseUrl, db } = await setup();
    const created = await request(baseUrl, '/storage/tables', {
      name: 'items',
      columns: [
        { name: 'sku', type: 'text', required: true, check: "length(sku) > 0 AND sku NOT LIKE '% %'" },
        { name: 'price', type: 'integer', default: 0, check: 'price >= 0 AND price <= 1000000' },
        { name: 'status', type: 'text', default: 'new', check: "status IN ('new', 'done')" },
        { name: 'seen_at', type: 'timestamp', default: "datetime('now')" },
      ],
      indexes: [{ columns: ['sku'], unique: true, where: "status = 'new' AND price > 0" }],
    });
    expect(created.status).toBe(200);
    const table = created.body.table;

    const ok = await request(baseUrl, '/storage/insert', { table: 'items', rows: [{ id: 'i1', sku: 'A1', price: 10 }] });
    expect(ok.status).toBe(200);
    const bad = await request(baseUrl, '/storage/insert', { table: 'items', rows: [{ id: 'i2', sku: 'A2', price: -1 }] });
    expect(bad.status).toBe(500); // CHECK constraint enforced

    const row = db.prepare(`SELECT status, seen_at, created_at FROM ${table} WHERE id = 'i1'`).get() as any;
    expect(row.status).toBe('new');
    expect(row.seen_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const idx = await request(baseUrl, '/storage/tables/items/indexes', { columns: ['price'], where: 'price IS NOT NULL' });
    expect(idx.status).toBe(200);

    const having = await request(baseUrl, '/storage/query', { table: 'items', groupBy: 'status', columns: ['status'], having: 'COUNT(*) > 0 AND SUM(price) >= 10' });
    expect(having.status).toBe(200);
    expect(having.body.count).toBe(1);

    const select = await request(baseUrl, '/storage/sql', { sql: `SELECT sku, price FROM ${table} WHERE status = 'new' AND price > ?;`, params: [1] });
    expect(select.status).toBe(200);
    expect(select.body.rows).toEqual([{ sku: 'A1', price: 10 }]);

    const insert = await request(baseUrl, '/storage/sql', { sql: `INSERT INTO ${table} (id, sku, price) VALUES (?, ?, ?)`, params: ['i3', 'B1', 3] });
    expect(insert.status).toBe(200);
    const update = await request(baseUrl, '/storage/sql', { sql: `UPDATE ${table} SET price = price + 1 WHERE id = 'i3'` });
    expect(update.status).toBe(200);
    const join = await request(baseUrl, '/storage/sql', {
      sql: `SELECT a.sku, b.note FROM ${table} a JOIN ${BOB_NOTES} b ON 1 = 1 ORDER BY a.sku`,
    });
    expect(join.status).toBe(200);
    expect(join.body.count).toBe(2);
    const literalWithKeywords = await request(baseUrl, '/storage/sql', {
      sql: `SELECT 'FROM/**/x; -- not a comment' AS s FROM ${table} LIMIT 1`,
    });
    expect(literalWithKeywords.status).toBe(200);
    expect(literalWithKeywords.body.rows[0].s).toBe('FROM/**/x; -- not a comment');

    const explain = await request(baseUrl, '/storage/explain', { sql: `SELECT * FROM ${table} WHERE sku = ?`, params: ['A1'] });
    expect(explain.status).toBe(200);

    const shared = await request(baseUrl, '/storage/sql', { sql: `SELECT * FROM ${BOB_NOTES}` }, 'alice');
    expect(shared.status).toBe(403); // bob's table is private
  });
});

describe('sql-guard unit', () => {
  it('lexes comments, quotes and separators so they cannot hide tokens', () => {
    expect(() => tokenizeSql('SELECT 1 FROM/**/agents')).toThrow(/comments/);
    expect(() => tokenizeSql('SELECT 1 --x')).toThrow(/comments/);
    expect(() => tokenizeSql('SELECT 1e--5')).toThrow(/comments/);
    expect(() => tokenizeSql("SELECT 'unterminated")).toThrow(/Unterminated/);
    expect(() => tokenizeSql('SELECT $$x$$', 'postgres')).toThrow(/Dollar/);
    expect(() => tokenizeSql("SELECT E'\\''; DROP TABLE x; --'", 'postgres')).toThrow(/Backslash/);
    expect(tokenizeSql("SELECT 'a;b' FROM \"t\"\"x\"").map((t) => [t.type, t.value])).toEqual([
      ['word', 'SELECT'], ['string', 'a;b'], ['word', 'FROM'], ['qident', 't"x'],
    ]);
  });

  it('analyzeRawSql enforces one allowed statement', () => {
    expect(analyzeRawSql('SELECT 1;;').sql).toBe('SELECT 1');
    expect(() => analyzeRawSql('SELECT 1; SELECT 2')).toThrow(/single/);
    expect(() => analyzeRawSql("SELECT ';' ; DROP TABLE agents")).toThrow(/single/);
    expect(() => analyzeRawSql('CREATE TABLE agt_x (a)')).toThrow(/not allowed/);
    expect(() => analyzeRawSql('SELECT * INTO agt_y FROM agt_x')).toThrow(/INTO/);
    expect(() => analyzeRawSql("SELECT load_extension('x')")).toThrow(/Function/);
    expect(analyzeRawSql('INSERT OR IGNORE INTO agt_x (a) VALUES (1)').kind).toBe('write');
    expect(analyzeRawSql('SELECT a FROM "agents"').identifiers).toContain('agents');
  });

  it('validateSqlExpression is a whitelist', () => {
    const cols = ['price', 'note'];
    expect(validateSqlExpression(' price > 0 ', { label: 'x', columns: cols })).toBe('price > 0');
    expect(() => validateSqlExpression('price > 0) OR (1', { label: 'x', columns: cols })).toThrow(/parentheses/);
    expect(() => validateSqlExpression('price, note', { label: 'x', columns: cols })).toThrow(/comma/);
    expect(() => validateSqlExpression('note IN agents', { label: 'x', columns: cols })).toThrow(/IN/);
    expect(() => validateSqlExpression('other > 0', { label: 'x', columns: cols })).toThrow(/not a column/);
    expect(() => validateSqlExpression('note.price > 0', { label: 'x', columns: cols })).toThrow(/forbidden token/);
    expect(() => validateSqlExpression('price > ?', { label: 'x', columns: cols })).toThrow(/parameters/);
    expect(() => validateSqlExpression('COUNT(*) > 1', { label: 'x', columns: cols })).toThrow();
    expect(validateSqlExpression('COUNT(*) > 1', { label: 'x', columns: cols, allowAggregates: true })).toBe('COUNT(*) > 1');
  });
});
