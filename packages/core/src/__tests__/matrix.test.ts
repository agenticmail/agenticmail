import { describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../storage/db.js';
import { ConversationSessionManager } from '../conversation/session.js';
import {
  MatrixManager,
  buildMatrixConfig,
  getMatrixWhoami,
  parseMatrixSyncMessages,
  recordMatrixConversationInbound,
  redactMatrixConfig,
  sendMatrixMessage,
} from '../matrix/index.js';

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

describe('Matrix channel', () => {
  it('stores Matrix config encrypted and redacts access tokens', () => {
    const db = createDb();
    const manager = new MatrixManager(db, 'mk_test_key');
    const cfg = buildMatrixConfig({
      homeserverUrl: 'https://matrix.example.org/',
      accessToken: 'mx-token-secret',
      userId: '@agent:example.org',
      allowedRoomIds: ['!room:example.org'],
    });
    manager.saveConfig('agent1', cfg);

    const loaded = manager.getConfig('agent1');
    expect(loaded).toMatchObject({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'mx-token-secret',
      userId: '@agent:example.org',
      allowedRoomIds: ['!room:example.org'],
    });
    expect(redactMatrixConfig(loaded!).accessToken).toBe('***');
    const raw = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('agent1') as { metadata: string };
    expect(raw.metadata).not.toContain('mx-token-secret');
    db.close();
  });

  it('sends m.room.message events with bearer auth', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      event_id: '$event1',
    }), { status: 200 }));
    const cfg = buildMatrixConfig({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'mx-token-secret',
      allowedRoomIds: ['!room:example.org'],
    });

    const result = await sendMatrixMessage(cfg, '!room:example.org', 'Hello Matrix', {
      fetchFn: fetchMock as unknown as typeof fetch,
      txnId: 'txn1',
    });

    expect(result).toEqual({ eventId: '$event1', txnId: 'txn1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://matrix.example.org/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/txn1',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer mx-token-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ msgtype: 'm.text', body: 'Hello Matrix' }),
      }),
    );
  });

  it('parses sync message events and ignores the agent user', () => {
    const parsed = parseMatrixSyncMessages({
      next_batch: 's2',
      rooms: {
        join: {
          '!room:example.org': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  event_id: '$own',
                  sender: '@agent:example.org',
                  origin_server_ts: 1_700_000_000_000,
                  content: { msgtype: 'm.text', body: 'ignore me' },
                },
                {
                  type: 'm.room.message',
                  event_id: '$event2',
                  sender: '@benedikt:example.org',
                  origin_server_ts: 1_700_000_001_000,
                  content: { msgtype: 'm.text', body: 'hello' },
                },
              ],
            },
          },
        },
      },
    }, { ownUserId: '@agent:example.org', allowedRoomIds: ['!room:example.org'] });

    expect(parsed).toMatchObject([
      {
        roomId: '!room:example.org',
        eventId: '$event2',
        sender: '@benedikt:example.org',
        text: 'hello',
      },
    ]);
  });

  it('mirrors Matrix inbound events into active conversation sessions', () => {
    const db = createDb();
    const conversations = new ConversationSessionManager(db);
    const session = conversations.createSession({
      agentId: 'agent1',
      channel: 'matrix',
      peer: '!room:example.org',
      goal: 'Coordinate over Matrix',
    });

    const context = recordMatrixConversationInbound(conversations, 'agent1', {
      roomId: '!room:example.org',
      eventId: '$event2',
      sender: '@benedikt:example.org',
      text: 'hello',
      metadata: { originServerTs: 1_700_000_001_000 },
    });

    expect(context).toMatchObject({
      sessionId: session.id,
      channel: 'matrix',
      roomId: '!room:example.org',
      eventId: '$event2',
      latestText: 'hello',
      goal: 'Coordinate over Matrix',
    });
    expect(conversations.listMessages('agent1', session.id).map((m) => [m.direction, m.text])).toEqual([
      ['inbound', 'hello'],
    ]);
    db.close();
  });

  it('reads Matrix whoami identity', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_id: '@agent:example.org',
      device_id: 'DEVICE',
    }), { status: 200 }));

    await expect(getMatrixWhoami({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'mx-token-secret',
    }, { fetchFn: fetchMock as unknown as typeof fetch })).resolves.toEqual({
      userId: '@agent:example.org',
      deviceId: 'DEVICE',
    });
  });
});
