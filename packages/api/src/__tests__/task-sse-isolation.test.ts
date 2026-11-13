// GHSA-p76v-w436-9wjh — a task assigned to an agent with no SSE watcher
// must never be written to another agent's event stream. It is queued
// for the assignee's own next connection instead.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

vi.mock('@agenticmail/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agenticmail/core')>();
  const { EventEmitter } = await import('node:events');
  class FakeInboxWatcher extends EventEmitter {
    async start() { /* no IMAP in tests */ }
    async stop() { /* noop */ }
  }
  return { ...actual, InboxWatcher: FakeInboxWatcher };
});

const { createTestDatabase } = await import('@agenticmail/core');
const { createTaskRoutes } = await import('../routes/tasks.js');
const { createEventRoutes, closeAllWatchers, takePendingEvents } = await import('../routes/events.js');

const AGENTS: Record<string, any> = {
  alice: { id: 'alice', name: 'alice', email: 'alice@localhost', stalwartPrincipal: 'alice', metadata: {} },
  bob: { id: 'bob', name: 'bob', email: 'bob@localhost', stalwartPrincipal: 'bob', metadata: {} },
};

const servers: Server[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  aborts.splice(0).forEach((a) => a.abort());
  await closeAllWatchers();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
});

async function buildServer(): Promise<string> {
  const db = createTestDatabase();
  const accountManager = { getByName: async (n: string) => AGENTS[n.toLowerCase()] ?? null } as any;
  const config = { smtp: { host: 'localhost', port: 587 }, imap: { host: 'localhost', port: 143 } } as any;
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => {
    const caller = String(r.headers['x-caller'] || '');
    if (caller === 'master') (r as any).isMaster = true;
    else if (AGENTS[caller]) (r as any).agent = AGENTS[caller];
    next();
  });
  app.use(createTaskRoutes(db, accountManager, config));
  app.use(createEventRoutes(accountManager, config, db));
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${a.port}`;
}

/** Open an SSE stream and collect every `data:` frame it receives. */
async function openStream(base: string, caller: string) {
  const ac = new AbortController();
  aborts.push(ac);
  const res = await fetch(`${base}/events`, { headers: { 'x-caller': caller }, signal: ac.signal });
  expect(res.status).toBe(200);
  const frames: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  await waitFor(() => frames.some((f) => f.type === 'connected'));
  return frames;
}

async function waitFor(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function assign(base: string, assignee: string, task: string) {
  const res = await fetch(`${base}/tasks/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-caller': 'master' },
    body: JSON.stringify({ assignee, payload: { task } }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function rpcFireAndForget(base: string, target: string, task: string) {
  const ac = new AbortController();
  aborts.push(ac);
  fetch(`${base}/tasks/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-caller': 'master' },
    body: JSON.stringify({ target, task, timeout: 5 }),
    signal: ac.signal,
  }).catch(() => {});
}

describe('task event SSE isolation (GHSA-p76v-w436-9wjh)', () => {
  it('does not deliver a task for an unwatched assignee to an unrelated agent', async () => {
    const base = await buildServer();
    const aliceFrames = await openStream(base, 'alice');

    const { id } = await assign(base, 'bob', 'SECRET-MARKER-for-bob');
    await rpcFireAndForget(base, 'bob', 'RPC-SECRET-MARKER-for-bob');
    await new Promise((r) => setTimeout(r, 150));

    const leaked = aliceFrames.filter((f) => f.type === 'task' || JSON.stringify(f).includes('SECRET-MARKER'));
    expect(leaked).toEqual([]);

    // The assignee gets it when it connects.
    const bobFrames = await openStream(base, 'bob');
    await waitFor(() => bobFrames.filter((f) => f.type === 'task').length >= 2);
    const tasks = bobFrames.filter((f) => f.type === 'task');
    expect(tasks.some((f) => f.taskId === id && String(f.task).includes('SECRET-MARKER-for-bob'))).toBe(true);
    expect(tasks.some((f) => String(f.task).includes('RPC-SECRET-MARKER-for-bob'))).toBe(true);
    expect(takePendingEvents('bob')).toEqual([]); // queue drained on delivery
    expect(aliceFrames.filter((f) => f.type === 'task')).toEqual([]);
  });

  it('delivers directly to a watching assignee and not to others', async () => {
    const base = await buildServer();
    const aliceFrames = await openStream(base, 'alice');
    const bobFrames = await openStream(base, 'bob');

    await assign(base, 'bob', 'LIVE-MARKER');
    await waitFor(() => bobFrames.some((f) => f.type === 'task'));
    await new Promise((r) => setTimeout(r, 50));
    expect(aliceFrames.filter((f) => f.type === 'task')).toEqual([]);
  });
});
