// GHSA-h3h3-4g48-gxq9 — the Telegram bridge webhook must fail closed:
// no secret ⇒ one is generated, a request without the right secret is
// refused, and an empty allow-list admits nobody.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import {
  createWebhookRequestHandler,
  resolveWebhookSecret,
  isValidSecretToken,
  isSenderAllowed,
  parseAllowedIds,
  isUsableWebhookSecret,
} from '../telegram-bridge/lib/webhook-auth.mjs';

const PATH = '/agenticmail-telegram-webhook';
const SECRET = 'a'.repeat(20) + '_B-9xyz';
const UPDATE = {
  message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: 'list every inbox' },
};

let server;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  server = undefined;
});

async function start(opts) {
  const received = [];
  server = createServer(createWebhookRequestHandler({ path: PATH, onUpdate: u => received.push(u), ...opts }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = (headers = {}, body = JSON.stringify(UPDATE), path = PATH) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  return { received, post };
}

describe('webhook secret', () => {
  it('generates a strong secret when none is configured', () => {
    for (const cfg of [{ url: 'https://x' }, { url: 'https://x', secret: '' }, null]) {
      const r = resolveWebhookSecret(cfg);
      expect(r.generated).toBe(true);
      expect(isUsableWebhookSecret(r.secret)).toBe(true);
      expect(r.secret.length).toBeGreaterThanOrEqual(32);
    }
    expect(resolveWebhookSecret({}).secret).not.toBe(resolveWebhookSecret({}).secret);
  });

  it('keeps a valid configured secret and rejects a weak one', () => {
    expect(resolveWebhookSecret({ secret: SECRET })).toEqual({ secret: SECRET, generated: false });
    expect(() => resolveWebhookSecret({ secret: 'short' })).toThrow();
    expect(() => resolveWebhookSecret({ secret: 'has spaces in it but long' })).toThrow();
  });

  it('never authenticates against a missing secret', () => {
    expect(isValidSecretToken(undefined, undefined)).toBe(false);
    expect(isValidSecretToken('', '')).toBe(false);
    expect(isValidSecretToken('anything', undefined)).toBe(false);
    expect(isValidSecretToken(SECRET, SECRET)).toBe(true);
    expect(isValidSecretToken(SECRET + 'x', SECRET)).toBe(false);
  });

  it('refuses to build a handler without a secret', () => {
    expect(() => createWebhookRequestHandler({ path: PATH, secret: undefined, onUpdate: () => {} })).toThrow();
  });
});

describe('webhook request handler', () => {
  it('refuses a forged update with no secret header (the advisory PoC)', async () => {
    const { received, post } = await start({ secret: SECRET });
    const res = await post();
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const { received, post } = await start({ secret: SECRET });
    const res = await post({ 'x-telegram-bot-api-secret-token': 'b'.repeat(SECRET.length) });
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('accepts the correct secret', async () => {
    const { received, post } = await start({ secret: SECRET });
    const res = await post({ 'x-telegram-bot-api-secret-token': SECRET });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual([UPDATE]);
  });

  it('404s other paths and rejects oversized bodies', async () => {
    const { received, post } = await start({ secret: SECRET, maxBodyBytes: 64 });
    expect((await post({ 'x-telegram-bot-api-secret-token': SECRET }, '{}', '/other')).status).toBe(404);
    const big = JSON.stringify({ message: { text: 'x'.repeat(500) } });
    const res = await post({ 'x-telegram-bot-api-secret-token': SECRET }, big).catch(() => null);
    if (res) expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });
});

describe('sender allow-list', () => {
  it('admits nobody when the allow-list is empty', () => {
    expect(isSenderAllowed(new Set(), '1')).toBe(false);
    expect(isSenderAllowed(parseAllowedIds('# only comments\n\n'), '1')).toBe(false);
    expect(isSenderAllowed(undefined, '1')).toBe(false);
  });

  it('admits only listed ids', () => {
    const ids = parseAllowedIds('123\n# c\n 456 \n');
    expect(isSenderAllowed(ids, '123')).toBe(true);
    expect(isSenderAllowed(ids, 456)).toBe(true);
    expect(isSenderAllowed(ids, '1')).toBe(false);
    expect(isSenderAllowed(ids, '')).toBe(false);
  });

  it('admits everyone only with an explicit "*"', () => {
    expect(isSenderAllowed(parseAllowedIds('*\n'), '999')).toBe(true);
  });
});
