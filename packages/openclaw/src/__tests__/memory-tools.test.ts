import { afterEach, describe, expect, it } from 'vitest';
import { registerTools } from '../tools.js';

/** Build the registered OpenClaw tools (one session). */
function collectTools(): any[] {
  const tools: any[] = [];
  registerTools({
    registerTool(factory: any) { tools.push(factory({ sessionKey: 'agent:main' })); },
  }, {
    config: { apiUrl: 'http://127.0.0.1:3102', apiKey: 'ak_test' },
  });
  return tools;
}

function tool(name: string): any {
  const found = collectTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

interface CapturedRequest { url: string; method: string; body: any; }

/** Stub global fetch; record requests; return a fixed JSON body. */
function stubFetch(jsonBody: unknown = { ok: true }): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as any;
  };
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OpenClaw memory tool surface', () => {
  it('registers the four memory tools', () => {
    const names = collectTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'agenticmail_memory',
      'agenticmail_memory_reflect',
      'agenticmail_memory_context',
      'agenticmail_memory_stats',
    ]));
  });

  it('agenticmail_memory set → POST /memory with the content', async () => {
    const calls = stubFetch({ success: true, memory: { id: 'm1' } });
    await tool('agenticmail_memory').execute('call-1', {
      action: 'set', content: 'Operator prefers morning calls', importance: 'high',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://127.0.0.1:3102/api/agenticmail/memory');
    expect(calls[0].body).toMatchObject({ content: 'Operator prefers morning calls', importance: 'high' });
  });

  it('agenticmail_memory search → GET /memory?query=…', async () => {
    const calls = stubFetch({ memories: [], count: 0 });
    await tool('agenticmail_memory').execute('call-2', { action: 'search', query: 'reservations' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/agenticmail/memory?query=reservations');
  });

  it('agenticmail_memory get/delete → /memory/:id', async () => {
    const getCalls = stubFetch({ memory: { id: 'abc' } });
    await tool('agenticmail_memory').execute('c', { action: 'get', id: 'abc' });
    expect(getCalls[0].url).toContain('/api/agenticmail/memory/abc');
    expect(getCalls[0].method).toBe('GET');

    const delCalls = stubFetch({ success: true });
    await tool('agenticmail_memory').execute('c', { action: 'delete', id: 'abc' });
    expect(delCalls[0].method).toBe('DELETE');
    expect(delCalls[0].url).toContain('/api/agenticmail/memory/abc');
  });

  it('agenticmail_memory rejects a set without content (no HTTP call)', async () => {
    const calls = stubFetch();
    const result = await tool('agenticmail_memory').execute('c', { action: 'set' });
    expect(calls).toHaveLength(0);
    expect(result.details).toMatchObject({ success: false });
  });

  it('agenticmail_memory rejects an unknown action', async () => {
    const calls = stubFetch();
    const result = await tool('agenticmail_memory').execute('c', { action: 'frobnicate' });
    expect(calls).toHaveLength(0);
    expect(result.details.error).toContain('Invalid action');
  });

  it('agenticmail_memory_reflect → POST /memory/reflect', async () => {
    const calls = stubFetch({ success: true, memory: { id: 'r1' } });
    await tool('agenticmail_memory_reflect').execute('c', { content: 'Always confirm the callback number' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/agenticmail/memory/reflect');
    expect(calls[0].body).toMatchObject({ content: 'Always confirm the callback number' });
  });

  it('agenticmail_memory_context → GET /memory/context with the query', async () => {
    const calls = stubFetch({ context: '## Agent Memory' });
    await tool('agenticmail_memory_context').execute('c', { query: 'pricing', maxTokens: 800 });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/agenticmail/memory/context?');
    expect(calls[0].url).toContain('query=pricing');
    expect(calls[0].url).toContain('maxTokens=800');
  });

  it('agenticmail_memory_stats → GET /memory/stats', async () => {
    const calls = stubFetch({ stats: { totalEntries: 3 } });
    await tool('agenticmail_memory_stats').execute('c', {});
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/agenticmail/memory/stats');
  });
});
