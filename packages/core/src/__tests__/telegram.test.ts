import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  TelegramPoller,
  stripTelegramMarkdown,
  splitTelegramMessage,
  redactBotToken,
  callTelegramApi,
  sendTelegramMessage,
  getTelegramMe,
  TelegramApiError,
  parseTelegramUpdate,
  isTelegramStopCommand,
  nextTelegramOffset,
  TelegramManager,
  redactTelegramConfig,
  isTelegramChatAllowed,
  formatOperatorQueryTelegramMessage,
  parseTelegramOperatorReply,
  recordTelegramConversationInbound,
  type TelegramConfig,
} from '../telegram/index.js';
import { isEncryptedSecret } from '../crypto/secrets.js';
import { createTestDatabase } from '../storage/db.js';
import { ConversationSessionManager } from '../conversation/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmno';

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    enabled: true,
    botToken: TOKEN,
    allowedChatIds: [],
    mode: 'poll',
    configuredAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function seedAgent(db: ReturnType<typeof createTestDatabase>, id = 'agent1'): void {
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, `${id}@example.com`, `ak_${id}`, `principal_${id}`, '{}');
}

// ─── client: text helpers ───────────────────────────────

describe('stripTelegramMarkdown', () => {
  it('strips bold, italic, code and links', () => {
    expect(stripTelegramMarkdown('**bold** and *italic* and `code`')).toBe('bold and italic and code');
    expect(stripTelegramMarkdown('[AgenticMail](https://example.com)')).toBe('AgenticMail');
    expect(stripTelegramMarkdown('# Heading\ntext')).toBe('Heading\ntext');
  });

  it('is a no-op on empty input', () => {
    expect(stripTelegramMarkdown('')).toBe('');
  });
});

describe('splitTelegramMessage', () => {
  it('keeps short text in one chunk', () => {
    expect(splitTelegramMessage('hello')).toEqual(['hello']);
  });

  it('splits long text into <= maxLen chunks on newline boundaries', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
    const chunks = splitTelegramMessage(text, 80);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
  });
});

describe('redactBotToken', () => {
  it('redacts an explicitly known token', () => {
    expect(redactBotToken(`url: https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN))
      .not.toContain(TOKEN);
  });

  it('redacts the generic token shape even without the exact token', () => {
    const leaked = 'failed to reach 987654321:BBunknown_tokenshape_aaaaaaaaaaaaaaaaaa';
    expect(redactBotToken(leaked)).toBe('failed to reach bot***');
  });
});

// ─── client: API calls (mocked HTTP) ────────────────────

describe('callTelegramApi', () => {
  it('returns result on ok responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ id: 1, username: 'ambot' })));
    const result = await callTelegramApi(TOKEN, 'getMe');
    expect(result).toMatchObject({ id: 1, username: 'ambot' });
  });

  it('throws a TelegramApiError on ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, description: 'Unauthorized', error_code: 401 }),
      { status: 401 },
    )));
    await expect(callTelegramApi(TOKEN, 'getMe')).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('never leaks the bot token in a network-failure error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`);
    }));
    try {
      await callTelegramApi(TOKEN, 'getMe');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).toContain('bot***');
    }
  });
});

describe('sendTelegramMessage', () => {
  it('strips markdown and attaches the reply target to the first chunk only', async () => {
    const fetchMock = vi.fn(async () => okResponse({ message_id: 55 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendTelegramMessage(TOKEN, '42', '**hello**', { replyToMessageId: 9 });
    expect(result.messageIds).toEqual([55]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toBe('hello');
    expect(body.chat_id).toBe('42');
    expect(body.reply_parameters).toEqual({ message_id: 9 });
  });

  it('splits an over-long message into multiple sendMessage calls', async () => {
    const fetchMock = vi.fn(async () => okResponse({ message_id: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendTelegramMessage(TOKEN, '42', 'x'.repeat(9000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('getTelegramMe', () => {
  it('targets the official Bot API getMe endpoint', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 7, is_bot: true, username: 'ambot' }));
    vi.stubGlobal('fetch', fetchMock);
    const info = await getTelegramMe(TOKEN);
    expect(info.username).toBe('ambot');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });
});

// ─── update parsing ─────────────────────────────────────

describe('parseTelegramUpdate', () => {
  it('parses a private text message', () => {
    const parsed = parseTelegramUpdate({
      update_id: 100,
      message: {
        message_id: 5,
        date: 1716000000,
        chat: { id: 42, type: 'private' },
        from: { id: 7, first_name: 'Ope', last_name: 'O', username: 'ope' },
        text: 'hello',
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.chatId).toBe('42');
    expect(parsed!.fromId).toBe('7');
    expect(parsed!.fromName).toBe('Ope O');
    expect(parsed!.text).toBe('hello');
    expect(parsed!.chatType).toBe('private');
  });

  it('parses a channel post and a reply target', () => {
    const post = parseTelegramUpdate({
      update_id: 101,
      channel_post: { message_id: 6, date: 1, chat: { id: -100, type: 'channel', title: 'News' }, text: 'post' },
    });
    expect(post!.chatTitle).toBe('News');

    const reply = parseTelegramUpdate({
      update_id: 102,
      message: {
        message_id: 8, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7 },
        text: 'my answer',
        reply_to_message: { message_id: 3, text: '[AMQ oq_abc]' },
      },
    });
    expect(reply!.replyToMessageId).toBe(3);
    expect(reply!.replyToText).toBe('[AMQ oq_abc]');
  });

  it('returns null for non-text and non-message updates', () => {
    expect(parseTelegramUpdate({ update_id: 1, callback_query: { id: 'x' } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 2, message: { message_id: 9, chat: { id: 1, type: 'private' }, date: 1 } })).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate({})).toBeNull();
  });
});

describe('isTelegramStopCommand', () => {
  it('recognises bare stop words', () => {
    expect(isTelegramStopCommand('stop')).toBe(true);
    expect(isTelegramStopCommand('/stop')).toBe(true);
    expect(isTelegramStopCommand('  CANCEL! ')).toBe(true);
    expect(isTelegramStopCommand('stop the booking please')).toBe(false);
  });
});

describe('nextTelegramOffset', () => {
  it('advances past the highest update_id in a batch', () => {
    expect(nextTelegramOffset(0, [{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }])).toBe(10);
    expect(nextTelegramOffset(12, [])).toBe(12);
    expect(nextTelegramOffset(3, [{}, { update_id: 1 }])).toBe(3);
  });
});

// ─── manager: config + redaction + crypto ───────────────

describe('redactTelegramConfig', () => {
  it('never exposes the bot token or webhook secret', () => {
    const redacted = redactTelegramConfig(makeConfig({ webhookSecret: 'supersecretwebhook01' }));
    expect(redacted.botToken).toBe('***');
    expect(redacted.webhookSecret).toBe('***');
  });
});

describe('isTelegramChatAllowed', () => {
  it('fails closed on an empty allow-list', () => {
    expect(isTelegramChatAllowed(makeConfig(), '42')).toBe(false);
  });

  it('allows linked chats and the operator chat', () => {
    const cfg = makeConfig({ allowedChatIds: ['42'], operatorChatId: '99' });
    expect(isTelegramChatAllowed(cfg, '42')).toBe(true);
    expect(isTelegramChatAllowed(cfg, '99')).toBe(true);
    expect(isTelegramChatAllowed(cfg, '7')).toBe(false);
  });
});

describe('TelegramManager', () => {
  it('encrypts credentials at rest and decrypts on read', () => {
    const db = createTestDatabase();
    seedAgent(db);
    const manager = new TelegramManager(db as any, 'mk_test_key');

    manager.saveConfig('agent1', makeConfig({ webhookSecret: 'supersecretwebhook01', mode: 'webhook' }));

    // Raw metadata in the agents table must hold ciphertext, not the token.
    const raw = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('agent1') as { metadata: string };
    const stored = JSON.parse(raw.metadata).telegram;
    expect(stored.botToken).not.toBe(TOKEN);
    expect(isEncryptedSecret(stored.botToken)).toBe(true);
    expect(isEncryptedSecret(stored.webhookSecret)).toBe(true);

    // getConfig returns the decrypted values.
    const loaded = manager.getConfig('agent1');
    expect(loaded!.botToken).toBe(TOKEN);
    expect(loaded!.webhookSecret).toBe('supersecretwebhook01');
    db.close();
  });

  it('resolves an agent by webhook secret and rejects a wrong one', () => {
    const db = createTestDatabase();
    seedAgent(db);
    const manager = new TelegramManager(db as any, 'mk_test_key');
    manager.saveConfig('agent1', makeConfig({ webhookSecret: 'supersecretwebhook01', mode: 'webhook' }));

    expect(manager.findAgentByWebhookSecret('supersecretwebhook01')?.agentId).toBe('agent1');
    expect(manager.findAgentByWebhookSecret('wrong-secret')).toBeNull();
    expect(manager.findAgentByWebhookSecret('')).toBeNull();
    db.close();
  });

  it('records inbound/outbound messages and dedups inbound by telegram id', () => {
    const db = createTestDatabase();
    seedAgent(db);
    const manager = new TelegramManager(db as any, 'mk_test_key');

    expect(manager.inboundMessageExists('agent1', '42', 5)).toBe(false);
    manager.recordInbound('agent1', { chatId: '42', telegramMessageId: 5, fromId: '7', text: 'hi' });
    expect(manager.inboundMessageExists('agent1', '42', 5)).toBe(true);

    manager.recordOutbound('agent1', { chatId: '42', text: 'reply', telegramMessageId: 6, status: 'sent' });

    const all = manager.listMessages('agent1');
    expect(all.length).toBe(2);
    expect(manager.listMessages('agent1', { direction: 'inbound' })).toHaveLength(1);
    expect(manager.listMessages('agent1', { direction: 'outbound' })).toHaveLength(1);
    db.close();
  });

  it('persists the poll offset', () => {
    const db = createTestDatabase();
    seedAgent(db);
    const manager = new TelegramManager(db as any, 'mk_test_key');
    manager.saveConfig('agent1', makeConfig());
    manager.updatePollOffset('agent1', 4242);
    expect(manager.getConfig('agent1')!.pollOffset).toBe(4242);
    db.close();
  });
});

// ─── operator-query bridge ──────────────────────────────

describe('formatOperatorQueryTelegramMessage', () => {
  it('includes the question and a matchable query tag', () => {
    const msg = formatOperatorQueryTelegramMessage({
      queryId: 'oq_abc-123',
      question: 'Is 8pm acceptable?',
      urgency: 'high',
    });
    expect(msg).toContain('Is 8pm acceptable?');
    expect(msg).toContain('[AMQ oq_abc-123]');
    expect(msg).toContain('URGENT');
  });

  it('surfaces only short bare commands, not /answer <oq_id>', () => {
    // v0.9.90 — earlier copy printed `/answer oq_<long-id> <text>` and
    // `/approve oq_<long-id>` inline, which read like a CLI manpage.
    // The shape should be: bare /approve · /reject + a "reply to this
    // message" instruction, with the oq_id hidden in a small footer.
    const msg = formatOperatorQueryTelegramMessage({
      queryId: 'oq_abc-123',
      question: 'Is 8pm acceptable?',
    });
    expect(msg).toMatch(/\/approve.+\/reject/);
    expect(msg).not.toMatch(/\/answer\s+oq_/);  // no inline /answer <id> in primary copy
    expect(msg).not.toMatch(/\/approve oq_abc-123/);  // no inline id with /approve
  });
});

describe('parseTelegramOperatorReply', () => {
  it('parses an explicit /answer command', () => {
    expect(parseTelegramOperatorReply({ text: '/answer oq_abc-1 yes go ahead' }))
      .toEqual({ queryId: 'oq_abc-1', answer: 'yes go ahead', kind: 'answer' });
  });

  it('parses /approve and /deny with a note', () => {
    expect(parseTelegramOperatorReply({ text: '/approve oq_abc-1 under $300' }))
      .toEqual({ queryId: 'oq_abc-1', answer: 'Approved: under $300', kind: 'approve' });
    expect(parseTelegramOperatorReply({ text: '/deny@am_bot oq_abc-1' }))
      .toEqual({ queryId: 'oq_abc-1', answer: 'Denied.', kind: 'deny' });
  });

  it('treats /reject as an alias for /deny (v0.9.90 user-facing synonym)', () => {
    expect(parseTelegramOperatorReply({ text: '/reject', replyToText: 'Q: ...\n[AMQ oq_z]' }))
      .toEqual({ queryId: 'oq_z', answer: 'Denied.', kind: 'deny' });
    expect(parseTelegramOperatorReply({ text: '/reject not in budget', replyToText: '[AMQ oq_z]' }))
      .toEqual({ queryId: 'oq_z', answer: 'Denied: not in budget', kind: 'deny' });
  });

  it('takes the query id from a quoted tagged notification', () => {
    const reply = parseTelegramOperatorReply({
      text: 'Yes, that works',
      replyToText: 'Question: ...\n[AMQ oq_xyz-9]',
    });
    expect(reply).toEqual({ queryId: 'oq_xyz-9', answer: 'Yes, that works', kind: 'answer' });
  });

  it('returns a queryId-less answer for a bare message', () => {
    const reply = parseTelegramOperatorReply({ text: 'go for it' });
    expect(reply).toEqual({ queryId: undefined, answer: 'go for it', kind: 'answer' });
  });

  it('returns null for an empty message', () => {
    expect(parseTelegramOperatorReply({ text: '   ' })).toBeNull();
  });
});

describe('recordTelegramConversationInbound', () => {
  it('records stop commands and closes the active Telegram conversation session', () => {
    const db = createTestDatabase();
    seedAgent(db, 'agent1');
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'telegram',
      peer: '42',
    });

    const context = recordTelegramConversationInbound(conversations, 'agent1', {
      updateId: 10,
      messageId: 5,
      chatId: '42',
      chatType: 'private',
      fromId: '42',
      fromName: 'Ope',
      text: '/stop',
      date: new Date().toISOString(),
    });

    expect(context).toMatchObject({ sessionId: session.id, ended: true });
    expect(conversations.listMessages('agent1', session.id).map((m) => m.text)).toEqual(['/stop']);
    expect(conversations.getSession('agent1', session.id)?.status).toBe('ended');
    expect(conversations.findActiveSessionByPeer('agent1', 'telegram', '42')).toBeNull();

    db.close();
  });
});

// ─── poller: long-poll loop ────────────────────────────────

describe('TelegramPoller', () => {
  /**
   * One inbound message goes from "Telegram getUpdates" → recorded in
   * the DB → fires the `onInbound` callback exactly once. The poller
   * advances the offset so a redelivered batch is a no-op (Telegram
   * acks updates only after offset advances).
   */
  it('records a new inbound message and fires onInbound exactly once', async () => {
    const db = createTestDatabase();
    seedAgent(db, 'agent1');
    const manager = new TelegramManager(db);
    manager.saveConfig('agent1', makeConfig({ allowedChatIds: ['42'], pollOffset: 0 }));
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'telegram',
      peer: '42',
      goal: 'Coordinate dinner',
    });

    const update = {
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 42, first_name: 'Ope' },
        chat: { id: 42, type: 'private' },
        date: 1700000000,
        text: 'hello',
      },
    };
    let getUpdatesCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('getUpdates')) {
        getUpdatesCalls++;
        // Return the update once, then empty so the loop idles.
        return okResponse(getUpdatesCalls === 1 ? [update] : []);
      }
      return okResponse({});
    }));

    const seen: string[] = [];
    const seenSessions: Array<string | undefined> = [];
    const poller = new TelegramPoller(manager, 'agent1', { timeoutSec: 1, conversationManager: conversations });
    poller.onInbound = (e) => {
      seen.push(e.message.text);
      seenSessions.push(e.conversation?.sessionId);
    };
    await poller.start();

    // Let the loop run one or two iterations.
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(seen).toEqual(['hello']);
    expect(seenSessions).toEqual([session.id]);
    expect(conversations.listMessages('agent1', session.id).map((m) => m.text)).toEqual(['hello']);
    // Offset must have advanced past the delivered update_id so a
    // redelivery doesn't replay it.
    const cfg = manager.getConfig('agent1');
    expect(cfg?.pollOffset).toBe(101);
  });

  /** A disabled config stops the loop immediately on the next iteration. */
  it('stops itself when the config is disabled mid-flight', async () => {
    const db = createTestDatabase();
    seedAgent(db, 'agent1');
    const manager = new TelegramManager(db);
    manager.saveConfig('agent1', makeConfig({ enabled: false }));

    vi.stubGlobal('fetch', vi.fn(async () => okResponse([])));

    const poller = new TelegramPoller(manager, 'agent1', { timeoutSec: 1 });
    await poller.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(poller.isRunning).toBe(false);
  });

  /**
   * A 401 from Telegram (revoked / wrong token) is permanent — the
   * poller exits rather than spin forever burning quota.
   */
  it('stops on a 401 token-rejected response', async () => {
    const db = createTestDatabase();
    seedAgent(db, 'agent1');
    const manager = new TelegramManager(db);
    manager.saveConfig('agent1', makeConfig({ allowedChatIds: ['42'] }));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })
    ));

    const poller = new TelegramPoller(manager, 'agent1', { timeoutSec: 1 });
    await poller.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(poller.isRunning).toBe(false);
  });
});
