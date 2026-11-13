/**
 * Codex integration routes carry the same bootstrap guard as the Claude
 * Code ones (GHSA-4x3j-9wxx-863h, GHSA-cpgx-gj4r-pf3w, GHSA-vm2m-87j8-8w9m).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ops = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../install.js', () => ({ install: ops.install }));
vi.mock('../uninstall.js', () => ({ uninstall: ops.uninstall }));
vi.mock('../status.js', () => ({ status: ops.status }));

import { createIntegrationRoutes } from '../http-routes.js';
import { resolveConfig } from '../config.js';

const MASTER = 'mk_codex_master';
const INSTALL = '/api/agenticmail/integrations/codex/install';
const STATUS = '/api/agenticmail/integrations/codex/status';
const UNINSTALL = '/api/agenticmail/integrations/codex/uninstall';

function makeApp(remoteAddress?: string) {
  const app = express();
  if (remoteAddress) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
  }
  app.use(express.json());
  app.use('/api/agenticmail', createIntegrationRoutes({ masterKey: MASTER }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  ops.install.mockResolvedValue({
    registeredAgents: [], codexConfigPath: '/tmp/c.toml', agentsDir: '/tmp/a',
    bridgeAgent: { id: 'c', name: 'codex', email: 'codex@localhost', apiKey: 'ak_x' }, changed: true,
  });
  ops.uninstall.mockResolvedValue({ changed: false });
  ops.status.mockResolvedValue({ state: 'installed' });
});

describe('codex bootstrap routes', () => {
  it('refuse a non-loopback peer without the master key', async () => {
    const app = makeApp('203.0.113.7');
    expect((await request(app).post(INSTALL).send({})).status).toBe(403);
    expect((await request(app).get(STATUS)).status).toBe(403);
    expect((await request(app).post(UNINSTALL).send({})).status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
    expect(ops.status).not.toHaveBeenCalled();
    expect(ops.uninstall).not.toHaveBeenCalled();
  });

  it('refuse tunnel headers, a rebinding Host and a browser Origin', async () => {
    expect((await request(makeApp()).post(INSTALL).set('cf-connecting-ip', '198.51.100.9').send({})).status).toBe(403);
    expect((await request(makeApp()).post(INSTALL).set('Host', 'evil.example').send({})).status).toBe(403);
    expect((await request(makeApp()).post(INSTALL).set('Origin', 'http://evil.example').send({})).status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('reject a wrong bearer with 401 and admit the right one through a tunnel', async () => {
    expect((await request(makeApp()).post(INSTALL).set('Authorization', 'Bearer bad').send({})).status).toBe(401);
    const ok = await request(makeApp())
      .post(INSTALL)
      .set('cf-connecting-ip', '198.51.100.9')
      .set('Authorization', `Bearer ${MASTER}`)
      .send({});
    expect(ok.status).toBe(200);
  });

  it('strip apiUrl/masterKey and refuse an arbitrary mcpCommand', async () => {
    await request(makeApp()).post(INSTALL).send({ apiUrl: 'https://attacker.example', masterKey: 'x' });
    const call = ops.install.mock.calls[0][0];
    expect(call).not.toHaveProperty('apiUrl');
    expect(call).not.toHaveProperty('masterKey');
    const bad = await request(makeApp()).post(INSTALL).send({ mcpCommand: '/bin/sh', mcpArgs: ['-c', 'id'] });
    expect(bad.status).toBe(400);
    expect(ops.install).toHaveBeenCalledTimes(1);
  });

  it('never honours codexHome over HTTP', async () => {
    await request(makeApp()).post(INSTALL).send({ codexHome: '/tmp/evil' });
    expect(ops.install.mock.calls[0][0]).not.toHaveProperty('codexHome');
  });
});

describe('codex resolveConfig', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'amcx-sec-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never pairs the on-disk master key with a foreign apiUrl', () => {
    const p = join(dir, 'am.json');
    writeFileSync(p, JSON.stringify({ masterKey: 'mk_disk', api: { port: 3200, host: '127.0.0.1' } }), 'utf-8');
    expect(resolveConfig({ agenticmailConfigPath: p }).masterKey).toBe('mk_disk');
    expect(resolveConfig({ agenticmailConfigPath: p, apiUrl: 'https://attacker.example' }).masterKey).toBe('');
  });
});
