// GHSA-3jw6-982f-pp9w — subject_regex must be validated on store and run
// safely (length-capped, time-boxed) at evaluation.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createTestDatabase } from '@agenticmail/core';
import { createFeatureRoutes, evaluateRules, validateRuleConditions } from '../routes/features.js';
import { validateRuleRegex, safeRegexTest, REGEX_TIMEOUT_MS } from '../rule-regex.js';

const CATASTROPHIC = [
  '^(a+)+$',
  '(a*)*b',
  '(.*a){12}',
  '^(a|a)+$',
  '^(a|aa)*$',
  '((ab)*)+c',
  '(\\w+\\s?)*$',
  '^(([a-z])+.)+[A-Z]([a-z])+$',
  '(x+x+)+y',
  '(?:a+)+$',
  '(a+){2,}',
  '(\\d+)\\1',
  '(?<n>a)\\k<n>',
  '(?=a+)+',
  'a{1,99999}',
  'x'.repeat(201),
];

const BENIGN = [
  '\\[Newsletter\\]',
  '^re:',
  '^(re|fwd?):\\s*',
  'invoice #\\d+',
  '.*urgent.*',
  '[a-z]+ report \\d{4}-\\d{2}',
  '(foo)+',
  '(?:abc)?def',
  '\\u00e9t\\u00e9',
  '[(+*)]',
  'a{2}b{1,3}',
];

describe('validateRuleRegex', () => {
  for (const p of CATASTROPHIC) {
    it(`rejects ${p.slice(0, 40)}`, () => {
      expect(validateRuleRegex(p).ok).toBe(false);
    });
  }
  for (const p of BENIGN) {
    it(`accepts ${p}`, () => {
      expect(validateRuleRegex(p)).toEqual({ ok: true });
    });
  }
  it('rejects non-strings and invalid syntax', () => {
    expect(validateRuleRegex(42).ok).toBe(false);
    expect(validateRuleRegex('(').ok).toBe(false);
    expect(validateRuleRegex('').ok).toBe(false);
  });
});

describe('safeRegexTest', () => {
  it('matches normally', () => {
    expect(safeRegexTest('^re:', 'Re: hello')).toBe(true);
    expect(safeRegexTest('^re:', 'hello')).toBe(false);
  });

  it('refuses a catastrophic pattern without running it', () => {
    const start = Date.now();
    expect(safeRegexTest('^(a+)+$', 'a'.repeat(40) + '!')).toBe('invalid');
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('time-boxes a pattern that passes validation but blows up polynomially', () => {
    const p = '^\\w*\\w*\\w*\\w*\\w*\\w*!$';
    expect(validateRuleRegex(p).ok).toBe(true);
    const start = Date.now();
    expect(safeRegexTest(p, 'a'.repeat(5000))).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(REGEX_TIMEOUT_MS * 10);
  });
});

describe('validateRuleConditions', () => {
  it('rejects wrong types and accepts a normal rule', () => {
    expect(validateRuleConditions({ subject_regex: '^(a+)+$' })).toMatch(/rejected/);
    expect(validateRuleConditions({ from_contains: 5 })).toMatch(/string/);
    expect(validateRuleConditions([])).toMatch(/object/);
    expect(validateRuleConditions({ subject_regex: '^re:', from_contains: 'x', has_attachment: true })).toBeNull();
    expect(validateRuleConditions(undefined)).toBeNull();
  });
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('POST /rules and evaluateRules', () => {
  async function setup() {
    const db = createTestDatabase();
    const app = express();
    app.use(express.json());
    app.use((r, _res, next) => { (r as any).agent = { id: 'agent-1', name: 'a', email: 'a@localhost' }; next(); });
    app.use(createFeatureRoutes(db, {} as any, {} as any));
    const server = createServer(app);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('bad address');
    const post = (body: unknown) => fetch(`http://127.0.0.1:${a.port}/rules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { db, post };
  }

  it('refuses to store a catastrophic subject_regex', async () => {
    const { db, post } = await setup();
    const res = await post({ name: 'evil', conditions: { subject_regex: '^(a+)+$' }, actions: { mark_read: true } });
    expect(res.status).toBe(400);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM email_rules').get() as any).n;
    expect(n).toBe(0);
  });

  it('stores and applies a benign subject_regex', async () => {
    const { db, post } = await setup();
    const res = await post({ name: 'news', conditions: { subject_regex: '\\[Newsletter\\]' }, actions: { mark_read: true } });
    expect(res.status).toBe(201);
    expect(evaluateRules(db, 'agent-1', { subject: '[Newsletter] Weekly' })?.actions).toEqual({ mark_read: true });
    expect(evaluateRules(db, 'agent-1', { subject: 'Hello' })).toBeNull();
  });

  it('evaluates a legacy stored catastrophic rule safely (no hang, no match)', async () => {
    const { db } = await setup();
    db.prepare(
      'INSERT INTO email_rules (id, agent_id, name, priority, enabled, conditions, actions) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('legacy', 'agent-1', 'legacy', 0, 1, JSON.stringify({ subject_regex: '^(a+)+$' }), JSON.stringify({ delete: true }));
    const start = Date.now();
    expect(evaluateRules(db, 'agent-1', { subject: 'a'.repeat(30) + '!' })).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('survives legacy rules with non-string conditions', async () => {
    const { db } = await setup();
    db.prepare(
      'INSERT INTO email_rules (id, agent_id, name, priority, enabled, conditions, actions) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('weird', 'agent-1', 'weird', 0, 1, JSON.stringify({ from_contains: 5 }), JSON.stringify({}));
    expect(() => evaluateRules(db, 'agent-1', { subject: 'x', from: [{ address: 'x@y' }] })).not.toThrow();
  });
});
