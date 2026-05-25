import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MCP Matrix tool dispatch', () => {
  let handleToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    vi.resetModules();
    process.env.AGENTICMAIL_API_URL = 'http://api.test';
    process.env.AGENTICMAIL_API_KEY = 'ak_test';
    ({ handleToolCall } = await import('../tools.js'));
  }, 15_000);

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets up Matrix through the API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, matrix: { accessToken: '***' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleToolCall('matrix_setup', {
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'mx-token',
      allowedRoomIds: ['!room:example.org'],
      verify: false,
    }));

    expect(result).toEqual({ success: true, matrix: { accessToken: '***' } });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/agenticmail/matrix/setup', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        homeserverUrl: 'https://matrix.example.org',
        accessToken: 'mx-token',
        allowedRoomIds: ['!room:example.org'],
        verify: false,
      }),
    }));
  });

  it('sends and polls Matrix messages through the API', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/matrix/send')) return jsonResponse({ success: true, eventId: '$event1' });
      if (String(url).endsWith('/matrix/poll')) return jsonResponse({ success: true, recorded: 1, mirrored: 1 });
      if (String(url).includes('/matrix/messages?')) return jsonResponse({ messages: [{ id: 'mx_1' }], count: 1 });
      return jsonResponse({ configured: true, matrix: { accessToken: '***' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const sent = JSON.parse(await handleToolCall('matrix_send', {
      roomId: '!room:example.org',
      text: 'Hello Matrix',
    }));
    expect(sent.eventId).toBe('$event1');

    const poll = JSON.parse(await handleToolCall('matrix_poll', { timeoutMs: 0 }));
    expect(poll).toMatchObject({ recorded: 1, mirrored: 1 });

    const messages = JSON.parse(await handleToolCall('matrix_messages', { roomId: '!room:example.org' }));
    expect(messages.count).toBe(1);
  });
});
