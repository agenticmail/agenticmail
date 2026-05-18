import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createStorageRoutes } from '../routes/storage.js';

vi.mock('@agenticmail/core', () => ({
  AGENT_ROLES: ['secretary', 'assistant', 'researcher', 'writer', 'custom'],
  AgentDeletionService: class {
    listReports() { return []; }
    getReport() { return null; }
  },
}));

const { createAccountRoutes } = await import('../routes/accounts.js');

type TestAgent = { id: string; email: string };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  return { status: res.status, body: await res.json() };
}

function createAccountApp(db: Database.Database): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isMaster = true;
    next();
  });
  app.use(createAccountRoutes({} as any, db, {} as any));
  return app;
}

function createStorageDb(db: Database.Database) {
  return {
    run(sql: string, params?: any[]) {
      db.prepare(sql).run(...(params ?? []));
    },
    get(sql: string, params?: any[]) {
      return db.prepare(sql).get(...(params ?? []));
    },
    all(sql: string, params?: any[]) {
      return db.prepare(sql).all(...(params ?? []));
    },
  };
}

function createStorageApp(db: Database.Database): express.Express {
  const agents: Record<string, TestAgent> = {
    owner: { id: 'owneragent000001', email: 'owner@example.com' },
    intruder: { id: 'intruderagent001', email: 'intruder@example.com' },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.agent = agents[String(req.headers['x-agent'] || 'owner')];
    next();
  });
  app.use(createStorageRoutes(createStorageDb(db), {} as any, {} as any));
  return app;
}

describe('account route security validation', () => {
  it('rejects non-integer inactive-hours input before building SQL', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        role TEXT,
        last_activity_at TEXT,
        persistent INTEGER,
        created_at TEXT
      )
    `);
    const baseUrl = await listen(createAccountApp(db));

    const invalid = await request(baseUrl, '/accounts/inactive?hours=24x');
    expect(invalid.status).toBe(400);

    const valid = await request(baseUrl, '/accounts/inactive?hours=24');
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ agents: [], count: 0 });

    db.close();
  });
});

describe('storage route SQL guards', () => {
  it('rejects unsafe filter identifiers and allows valid filters', async () => {
    const db = new Database(':memory:');
    const baseUrl = await listen(createStorageApp(db));

    const created = await request(baseUrl, '/storage/tables', {
      method: 'POST',
      body: JSON.stringify({
        name: 'notes',
        timestamps: false,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text' },
        ],
      }),
    });
    expect(created.status).toBe(200);

    await request(baseUrl, '/storage/insert', {
      method: 'POST',
      body: JSON.stringify({ table: 'notes', rows: [{ id: 'n1', title: 'hello' }] }),
    });

    const invalid = await request(baseUrl, '/storage/query', {
      method: 'POST',
      body: JSON.stringify({ table: 'notes', where: { 'bad-key': 'n1' } }),
    });
    expect(invalid.status).toBe(400);

    const valid = await request(baseUrl, '/storage/query', {
      method: 'POST',
      body: JSON.stringify({ table: 'notes', where: { id: 'n1' } }),
    });
    expect(valid.status).toBe(200);
    expect(valid.body.count).toBe(1);

    db.close();
  });

  it('denies raw SQL access to another agent private table', async () => {
    const db = new Database(':memory:');
    const baseUrl = await listen(createStorageApp(db));

    const created = await request(baseUrl, '/storage/tables', {
      method: 'POST',
      body: JSON.stringify({
        name: 'secrets',
        timestamps: false,
        columns: [{ name: 'id', type: 'text', primaryKey: true }],
      }),
    });
    expect(created.status).toBe(200);

    const denied = await request(baseUrl, '/storage/sql', {
      method: 'POST',
      headers: { 'x-agent': 'intruder' },
      body: JSON.stringify({ sql: `SELECT * FROM ${created.body.table}` }),
    });
    expect(denied.status).toBe(403);

    db.close();
  });
});
