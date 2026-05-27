/**
 * Inbound webhook tests — regression coverage for issue #1
 * (inbound mail must preserve the original `From:` header instead of
 * rewriting it to the recipient's own address).
 *
 * Two layers of coverage:
 *
 *   1. `prependHeaders` — pure unit test that the tracing-header
 *      injection inserts new headers AFTER the first header line, so
 *      `From:` (always first in our fixtures and in the real wire
 *      format from Cloudflare Email Workers / Mailgun) is left
 *      untouched.
 *
 *   2. Route behaviour — feeds a raw RFC822 message through the
 *      Express route with `getReceiver` mocked, asserts the buffer
 *      handed to `appendMessage()` still has the original sender in
 *      `From:` and was written to `INBOX`. This is the real
 *      acceptance criterion from issue #1.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Router } from 'express';

// Mock the receiver pool before importing the route module that uses it.
vi.mock('../routes/mail.js', () => ({
  getReceiver: vi.fn(),
}));

// Route module reads AGENTICMAIL_INBOUND_SECRET at module-init time and
// captures it in a closure, so we must set it BEFORE the import. ESM
// hoists imports above top-level code, so we use a dynamic import
// inside beforeAll after the env var is set.
let prependHeaders: typeof import('../routes/inbound.js').prependHeaders;
let createInboundRoutes: typeof import('../routes/inbound.js').createInboundRoutes;
let getReceiver: any;

const INBOUND_SECRET = 'test-secret';

beforeAll(async () => {
  process.env.AGENTICMAIL_INBOUND_SECRET = INBOUND_SECRET;
  const mod = await import('../routes/inbound.js');
  prependHeaders = mod.prependHeaders;
  createInboundRoutes = mod.createInboundRoutes;
  ({ getReceiver } = await import('../routes/mail.js'));
});

/**
 * Pull the POST /mail/inbound handler out of the router so we can drive
 * it directly with a minimal req/res shim — avoids dragging in supertest
 * just for one route. Express stores handlers on `router.stack[i].route`.
 */
function extractInboundHandler(router: Router): (req: any, res: any, next: any) => Promise<void> {
  const stack = (router as any).stack as Array<{ route?: { path: string; stack: Array<{ method: string; handle: any }> } }>;
  const layer = stack.find(l => l.route?.path === '/mail/inbound');
  if (!layer?.route) throw new Error('inbound route not found on router');
  const handlerLayer = layer.route.stack.find(s => s.method === 'post');
  if (!handlerLayer) throw new Error('POST handler not found on /mail/inbound');
  return handlerLayer.handle;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  return res;
}

function makeReq(headers: Record<string, string>, body: any) {
  return { headers, body };
}

describe('prependHeaders', () => {
  it('inserts headers after the first header line, leaving From: untouched', () => {
    const raw = Buffer.from(
      'From: luke@bermont.digital\r\n' +
      'To: warren@myhorizon.co.za\r\n' +
      'Subject: hi\r\n' +
      '\r\n' +
      'body',
      'utf8',
    );
    const out = prependHeaders(raw, { 'X-AgenticMail-Inbound': 'cloudflare-worker' });
    const text = out.toString('utf8');
    expect(text.startsWith('From: luke@bermont.digital\r\n')).toBe(true);
    expect(text).toContain('X-AgenticMail-Inbound: cloudflare-worker\r\n');
    expect(text).toContain('To: warren@myhorizon.co.za\r\n');
    expect(text).toContain('\r\n\r\nbody'); // body unchanged
  });

  it('reuses bare LF when input uses LF (no spurious CRLF mixing)', () => {
    const raw = Buffer.from('From: a@b\nTo: c@d\n\nbody', 'utf8');
    const out = prependHeaders(raw, { 'X-Tag': '1' });
    const text = out.toString('utf8');
    expect(text).toBe('From: a@b\nX-Tag: 1\nTo: c@d\n\nbody');
  });

  it('returns input unchanged when no headers given', () => {
    const raw = Buffer.from('From: a@b\r\n\r\nbody', 'utf8');
    expect(prependHeaders(raw, {}).equals(raw)).toBe(true);
  });

  it('skips empty / undefined header values', () => {
    const raw = Buffer.from('From: a@b\r\n\r\nbody', 'utf8');
    const out = prependHeaders(raw, { 'X-Empty': '', 'X-Real': 'yes' });
    const text = out.toString('utf8');
    expect(text).toContain('X-Real: yes');
    expect(text).not.toContain('X-Empty');
  });
});

describe('POST /api/agenticmail/mail/inbound', () => {
  const appendMessage = vi.fn();
  const accountManager = {
    getByName: vi.fn(),
  } as any;
  const config = {
    imap: { host: 'localhost', port: 143 },
    smtp: { host: 'localhost', port: 587 },
  } as any;
  const gatewayManager = {
    isAlreadyDelivered: vi.fn(() => false),
    recordDelivery: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    appendMessage.mockReset();
    (getReceiver as any).mockResolvedValue({ appendMessage });
    accountManager.getByName.mockResolvedValue({
      name: 'warren',
      email: 'warren@myhorizon.co.za',
      stalwartPrincipal: 'warren@localhost',
      metadata: { _password: 'pw' },
    });
  });

  function call(body: any, secret = INBOUND_SECRET) {
    const router = createInboundRoutes(accountManager, config, gatewayManager);
    const handler = extractInboundHandler(router);
    const req = makeReq({ 'x-inbound-secret': secret }, body);
    const res = makeRes();
    const next = vi.fn((err?: any) => { if (err) throw err; });
    return handler(req, res, next).then(() => ({ res, next }));
  }

  function rawWith(from: string, to: string, subject = 'hello'): string {
    const raw = Buffer.from(
      `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Message-Id: <msg-${Date.now()}@bermont.digital>\r\n` +
      `In-Reply-To: <parent@thread>\r\n` +
      `References: <root@thread> <parent@thread>\r\n` +
      `\r\n` +
      `body text\r\n`,
      'utf8',
    );
    return raw.toString('base64');
  }

  it('preserves the original From: header (issue #1 acceptance)', async () => {
    const { res } = await call({
      from: 'luke@bermont.digital',
      to: 'warren@myhorizon.co.za',
      rawEmail: rawWith('luke@bermont.digital', 'warren@myhorizon.co.za'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: 'warren@myhorizon.co.za' });
    expect(appendMessage).toHaveBeenCalledTimes(1);

    const [appended, mailbox] = appendMessage.mock.calls[0];
    expect(mailbox).toBe('INBOX');

    const text = (appended as Buffer).toString('utf8');
    // The original From: must still be at the top of the message head.
    expect(text.startsWith('From: luke@bermont.digital\r\n')).toBe(true);
    // The recipient must NOT have been rewritten into From: — this is
    // the exact bug we're fixing.
    expect(text).not.toMatch(/^From: warren@myhorizon\.co\.za/m);
    // Threading headers must survive untouched.
    expect(text).toContain('In-Reply-To: <parent@thread>');
    expect(text).toContain('References: <root@thread> <parent@thread>');
    // Tracing headers are added.
    expect(text).toContain('X-AgenticMail-Inbound: cloudflare-worker');
    expect(text).toMatch(/X-Original-Message-Id: <msg-\d+@bermont\.digital>/);
  });

  it('returns 401 when X-Inbound-Secret is wrong', async () => {
    const { res } = await call({ to: 'warren@myhorizon.co.za', rawEmail: rawWith('a@b', 'warren@myhorizon.co.za') }, 'wrong');
    expect(res.statusCode).toBe(401);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('400s when rawEmail is missing', async () => {
    const { res } = await call({ to: 'warren@myhorizon.co.za' });
    expect(res.statusCode).toBe(400);
  });

  it('404s when no agent matches the recipient local part', async () => {
    accountManager.getByName.mockResolvedValueOnce(null);
    const { res } = await call({
      to: 'ghost@myhorizon.co.za',
      rawEmail: rawWith('a@b', 'ghost@myhorizon.co.za'),
    });
    expect(res.statusCode).toBe(404);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('short-circuits on duplicate delivery without re-appending', async () => {
    gatewayManager.isAlreadyDelivered.mockReturnValueOnce(true);
    const { res } = await call({
      to: 'warren@myhorizon.co.za',
      rawEmail: rawWith('luke@bermont.digital', 'warren@myhorizon.co.za'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true });
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('records delivery in gatewayManager after successful append', async () => {
    await call({
      to: 'warren@myhorizon.co.za',
      rawEmail: rawWith('luke@bermont.digital', 'warren@myhorizon.co.za'),
    });
    expect(gatewayManager.recordDelivery).toHaveBeenCalledTimes(1);
    const [messageId, agentName] = gatewayManager.recordDelivery.mock.calls[0];
    expect(agentName).toBe('warren');
    expect(messageId).toMatch(/^<msg-\d+@bermont\.digital>$/);
  });
});
