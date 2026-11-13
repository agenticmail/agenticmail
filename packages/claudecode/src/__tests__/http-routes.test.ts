/**
 * HTTP-route smoke tests.
 *
 * We mount `createIntegrationRoutes()` on a bare Express app and drive it
 * with supertest. The underlying install / uninstall / status implementations
 * are mocked the same way as in install-uninstall.test.ts — the point here
 * is to verify the HTTP plumbing, not the install logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the three core operations through vi.hoisted so the route module
// (which imports them at module-init time) sees the mocks.
const ops = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  status: vi.fn(),
}));
vi.mock('../install.js', () => ({ install: ops.install }));
vi.mock('../uninstall.js', () => ({ uninstall: ops.uninstall }));
vi.mock('../status.js', () => ({ status: ops.status }));

import { createIntegrationRoutes } from '../http-routes.js';
import { AgenticMailApiError } from '../api.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agenticmail', createIntegrationRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /integrations/claudecode/status', () => {
  it('returns the status payload as JSON', async () => {
    ops.status.mockResolvedValue({
      state: 'installed',
      mcpInstalled: true,
      bridgeAgentExists: true,
      subagents: ['agenticmail-fola'],
      claudeConfigPath: '/tmp/.claude.json',
      agentsDir: '/tmp/agents',
      notes: [],
    });
    const res = await request(makeApp()).get('/api/agenticmail/integrations/claudecode/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('installed');
    expect(res.body.subagents).toEqual(['agenticmail-fola']);
  });

  it('returns 503 when AgenticMail itself is unreachable', async () => {
    ops.status.mockRejectedValue(new AgenticMailApiError(0, 'unreachable'));
    const res = await request(makeApp()).get('/api/agenticmail/integrations/claudecode/status');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unreachable/);
  });
});

describe('POST /integrations/claudecode/install', () => {
  it('runs install with a sanitised body and redacts every api key', async () => {
    ops.install.mockResolvedValue({
      registeredAgents: [
        { id: 'a', name: 'Fola', email: 'fola@localhost', apiKey: 'ak_FOLA_SECRET' },
        { id: 'b', name: 'writer', email: 'writer@localhost', apiKey: 'ak_WRITER_SECRET' },
      ],
      claudeConfigPath: '/tmp/.claude.json',
      agentsDir: '/tmp/agents',
      bridgeAgent: { id: 'c', name: 'claudecode', email: 'claudecode@localhost', apiKey: 'ak_BRIDGE_SECRET' },
      changed: true,
    });
    const res = await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/install')
      .send({ apiUrl: 'http://test', purgeBridgeAgent: 'oops-should-be-ignored', extraKey: 'ignored' });

    expect(res.status).toBe(200);
    expect(res.body.bridgeAgent.apiKey).toBe('***redacted***');
    for (const agent of res.body.registeredAgents) expect(agent.apiKey).toBe('***redacted***');
    // Sanity: no plaintext secret anywhere in the response body
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/ak_FOLA_SECRET|ak_WRITER_SECRET|ak_BRIDGE_SECRET/);
    expect(res.body.changed).toBe(true);
    // Sanitisation: only allowlisted fields are forwarded — never a
    // caller-chosen apiUrl (GHSA-4x3j-9wxx-863h).
    const call = ops.install.mock.calls[0][0];
    expect(call).not.toHaveProperty('apiUrl');
    expect(call).not.toHaveProperty('purgeBridgeAgent');
    expect(call).not.toHaveProperty('extraKey');
  });

  it('returns 503 on AgenticMailApiError(0)', async () => {
    ops.install.mockRejectedValue(new AgenticMailApiError(0, 'API down'));
    const res = await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/install')
      .send({});
    expect(res.status).toBe(503);
  });

  it('forwards upstream status codes for non-zero AgenticMailApiError', async () => {
    ops.install.mockRejectedValue(new AgenticMailApiError(409, 'Conflict'));
    const res = await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/install')
      .send({});
    expect(res.status).toBe(409);
  });

  it('returns 500 for generic errors', async () => {
    ops.install.mockRejectedValue(new Error('something broke'));
    const res = await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/install')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/something broke/);
  });
});

describe('POST /integrations/claudecode/uninstall', () => {
  it('forwards purgeBridgeAgent=true when explicitly set', async () => {
    ops.uninstall.mockResolvedValue({
      changed: true,
      removedSubagents: ['agenticmail-fola.md'],
      mcpBlockRemoved: true,
      bridgeAgentDeleted: true,
    });
    await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/uninstall')
      .send({ purgeBridgeAgent: true });
    const call = ops.uninstall.mock.calls[0][0];
    expect(call.purgeBridgeAgent).toBe(true);
  });

  it('ignores purgeBridgeAgent when set to a truthy non-boolean (defence-in-depth)', async () => {
    ops.uninstall.mockResolvedValue({
      changed: false, removedSubagents: [], mcpBlockRemoved: false, bridgeAgentDeleted: false,
    });
    await request(makeApp())
      .post('/api/agenticmail/integrations/claudecode/uninstall')
      .send({ purgeBridgeAgent: 'yes-please' });
    const call = ops.uninstall.mock.calls[0][0];
    expect(call.purgeBridgeAgent).toBeUndefined();
  });
});
