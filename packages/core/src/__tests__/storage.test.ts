import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../storage/db.js';
import { EmailSearchIndex } from '../storage/search.js';

describe('SQLite Database', () => {
  it('creates tables from migration', () => {
    const db = createTestDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('domains');
    expect(tableNames).toContain('config');
    expect(tableNames).toContain('email_search');
    db.close();
  });

  it('can insert and query agents', () => {
    const db = createTestDatabase();
    const stmt = db.prepare(`
      INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run('test-id', 'test-agent', 'test@localhost', 'ak_test', 'test-agent', '{}');

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('test-id') as any;
    expect(row.name).toBe('test-agent');
    expect(row.email).toBe('test@localhost');
    db.close();
  });
});

describe('EmailSearchIndex', () => {
  it('indexes and searches emails', () => {
    const db = createTestDatabase();
    const index = new EmailSearchIndex(db);

    index.index({
      agentId: 'agent-1',
      messageId: 'msg-1',
      subject: 'Hello World',
      fromAddress: 'alice@example.com',
      toAddress: 'bob@example.com',
      bodyText: 'This is a test email about machine learning',
      receivedAt: new Date().toISOString(),
    });

    index.index({
      agentId: 'agent-1',
      messageId: 'msg-2',
      subject: 'Meeting Tomorrow',
      fromAddress: 'carol@example.com',
      toAddress: 'bob@example.com',
      bodyText: 'Can we discuss the project?',
      receivedAt: new Date().toISOString(),
    });

    const results = index.search('agent-1', 'machine learning');
    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe('msg-1');

    const results2 = index.search('agent-1', 'meeting');
    expect(results2).toHaveLength(1);
    expect(results2[0].subject).toBe('Meeting Tomorrow');

    db.close();
  });

  it('isolates search by agentId', () => {
    const db = createTestDatabase();
    const index = new EmailSearchIndex(db);

    index.index({
      agentId: 'agent-1',
      messageId: 'msg-1',
      subject: 'Secret Report',
      fromAddress: 'a@test.com',
      toAddress: 'b@test.com',
      bodyText: 'confidential data',
      receivedAt: new Date().toISOString(),
    });

    const results = index.search('agent-2', 'confidential');
    expect(results).toHaveLength(0);

    db.close();
  });
});
