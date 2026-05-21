import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../storage/db.js';
import { ConversationSessionManager } from '../conversation/index.js';

function createDb() {
  const db = createTestDatabase();
  db.prepare(`
    INSERT INTO agents (id, name, email, api_key, stalwart_principal, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('agent1', 'ralf', 'ralf@example.com', 'ak_test', 'principal1', '{}');
  return db;
}

describe('conversation sessions', () => {
  it('creates a channel-neutral session and records transcript messages', () => {
    const db = createDb();
    const manager = new ConversationSessionManager(db);

    const session = manager.createSession({
      agentId: 'agent1',
      channel: 'telegram',
      peer: '42',
      externalRef: 'tg-thread-42',
      goal: 'Coordinate reservation details',
    });
    const outbound = manager.recordMessage({
      sessionId: session.id,
      agentId: 'agent1',
      channel: 'telegram',
      direction: 'outbound',
      text: 'I will check that.',
      externalMessageId: '999',
    });
    manager.recordTranscriptMessage({
      sessionId: session.id,
      agentId: 'agent1',
      direction: 'inbound',
      text: 'Thanks.',
    });

    expect(outbound.id).toMatch(/^cmsg_/);
    expect(manager.findActiveSessionByPeer('agent1', 'telegram', '42')?.id).toBe(session.id);
    expect(manager.findActiveSessionByExternalRef('agent1', 'telegram', 'tg-thread-42')?.id).toBe(session.id);
    expect(manager.listMessages('agent1', session.id).map((m) => m.text)).toEqual([
      'I will check that.',
      'Thanks.',
    ]);

    const ended = manager.endSession('agent1', session.id);
    expect(ended.status).toBe('ended');
    expect(manager.findActiveSessionByPeer('agent1', 'telegram', '42')).toBeNull();
    expect(manager.findActiveSessionByExternalRef('agent1', 'telegram', 'tg-thread-42')).toBeNull();
    expect(manager.findSessionByExternalRef('agent1', 'telegram', 'tg-thread-42')?.id).toBe(session.id);

    db.close();
  });

  it('fails closed for unsupported channels and inactive sessions', () => {
    const db = createDb();
    const manager = new ConversationSessionManager(db);

    expect(() => manager.createSession({
      agentId: 'agent1',
      channel: 'discord',
      peer: '42',
    })).toThrow(/Unsupported realtime conversation channel/);

    const session = manager.createSession({ agentId: 'agent1', channel: 'phone', peer: '+43123456789' });
    expect(() => manager.recordMessage({
      sessionId: session.id,
      agentId: 'agent1',
      channel: 'phone',
      direction: 'sideways' as any,
      text: 'bad direction',
    })).toThrow(/direction must be inbound/);

    manager.endSession('agent1', session.id);
    expect(() => manager.recordMessage({
      sessionId: session.id,
      agentId: 'agent1',
      channel: 'phone',
      direction: 'system',
      text: 'late',
    })).toThrow(/not active/);

    db.close();
  });
});
