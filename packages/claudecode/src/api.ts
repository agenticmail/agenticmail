/**
 * Thin client for the AgenticMail master API.
 *
 * We talk to ONE endpoint family — `/api/agenticmail/accounts` — to discover
 * and provision agents. The MCP server itself handles every other call once
 * Claude Code is wired up, so this client deliberately stays tiny.
 */

import type { AgenticMailAccount } from './types.js';

export class AgenticMailApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AgenticMailApiError';
  }
}

interface AccountsListResponse {
  agents: AgenticMailAccount[];
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Total timeout for the request, ms. Default 10 s. */
  timeoutMs?: number;
}

async function request<T>(apiUrl: string, masterKey: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (!masterKey) {
    throw new AgenticMailApiError(0, 'AgenticMail master key is required — could not find one in ~/.agenticmail/config.json.');
  }
  const url = `${apiUrl.replace(/\/$/, '')}/api/agenticmail${path}`;
  const headers: Record<string, string> = { 'Authorization': `Bearer ${masterKey}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new AgenticMailApiError(0, `AgenticMail API unreachable at ${apiUrl}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    let text: string;
    try { text = await res.text(); } catch { text = '(could not read response body)'; }
    throw new AgenticMailApiError(res.status, `AgenticMail API ${res.status}: ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null as unknown as T;
  }
  return await res.json() as T;
}

/**
 * Confirm the master API is reachable.
 *
 * The `/health` route is intentionally unauthenticated upstream — we use it
 * here precisely *because* it doesn't require the master key, so an early
 * misconfiguration shows the user "API is down" rather than "key is wrong".
 * Returns the version string from the response.
 */
export async function checkApiHealth(apiUrl: string): Promise<{ ok: true; version?: string }> {
  const url = `${apiUrl.replace(/\/$/, '')}/api/agenticmail/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new AgenticMailApiError(res.status, `Health check returned HTTP ${res.status}`);
    const data: any = await res.json();
    return { ok: true, version: data?.version };
  } catch (err) {
    if (err instanceof AgenticMailApiError) throw err;
    throw new AgenticMailApiError(0, `AgenticMail API unreachable at ${apiUrl}: ${(err as Error).message}`);
  }
}

/** List every AgenticMail account (agents). Requires the master key. */
export async function listAccounts(apiUrl: string, masterKey: string): Promise<AgenticMailAccount[]> {
  const data = await request<AccountsListResponse>(apiUrl, masterKey, '/accounts');
  return data?.agents ?? [];
}

/** Look up a single account by name. Returns null if not found. */
export async function getAccountByName(apiUrl: string, masterKey: string, name: string): Promise<AgenticMailAccount | null> {
  const all = await listAccounts(apiUrl, masterKey);
  return all.find(a => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Create an AgenticMail account. Idempotent at the call site: if the name
 * already exists, returns the existing record instead of throwing.
 */
export async function ensureAccount(
  apiUrl: string,
  masterKey: string,
  name: string,
  role = 'assistant',
): Promise<AgenticMailAccount> {
  const existing = await getAccountByName(apiUrl, masterKey, name);
  if (existing) return existing;

  try {
    const created = await request<AgenticMailAccount>(apiUrl, masterKey, '/accounts', {
      method: 'POST',
      body: { name, role },
    });
    if (!created || typeof (created as any).apiKey !== 'string') {
      throw new AgenticMailApiError(0, 'Account creation returned no apiKey — refusing to continue.');
    }
    return created;
  } catch (err) {
    // Race: someone created it between our list and our POST. Re-fetch.
    if (err instanceof AgenticMailApiError && (err.status === 409 || /UNIQUE|exists/i.test(err.message))) {
      const after = await getAccountByName(apiUrl, masterKey, name);
      if (after) return after;
    }
    throw err;
  }
}

/** Delete an account by id. */
export async function deleteAccount(apiUrl: string, masterKey: string, id: string): Promise<void> {
  await request<null>(apiUrl, masterKey, `/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Update an account's role. Used by install.ts to migrate a pre-existing
 * bridge account (created when the API didn't yet accept 'bridge' as a
 * role) from 'assistant' to 'bridge'.
 */
export async function setAccountRole(
  apiUrl: string,
  masterKey: string,
  id: string,
  role: string,
): Promise<{ role: string }> {
  const updated = await request<{ role: string }>(
    apiUrl,
    masterKey,
    `/accounts/${encodeURIComponent(id)}/role`,
    { method: 'PATCH', body: { role } },
  );
  return updated ?? { role };
}

/**
 * Restart catch-up helpers.
 *
 * After a dispatcher restart the per-account SSE channel is reopened
 * but it only carries IMAP IDLE notifications going forward — anything
 * that arrived during the downtime never replays. These two helpers
 * give the dispatcher a one-shot "what did I miss?" query so it can
 * spawn workers for unprocessed mail / tasks once on channel open.
 *
 * Both authenticate as the agent itself (the agent's apiKey), not the
 * master key, so they match the auth scope the SSE channel uses.
 */

interface InboxEnvelope {
  uid: number;
  subject?: string;
  from?: Array<{ name?: string; address: string }>;
  to?: Array<{ name?: string; address: string }>;
  date?: string;
  flags?: string[];
  size?: number;
}

interface InboxListResponse {
  messages: InboxEnvelope[];
  count: number;
  total?: number;
}

/**
 * Snapshot the agent's INBOX. Returns the newest `limit` UIDs as
 * lightweight envelopes — enough to feed `handleEvent` like a
 * synthetic SSE 'new' event. Uses the agent's own apiKey so the
 * call hits the same auth path the SSE stream uses.
 */
export async function listInboxForAgent(
  apiUrl: string,
  agentApiKey: string,
  opts: { limit?: number } = {},
): Promise<InboxEnvelope[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  const url = `${apiUrl.replace(/\/$/, '')}/api/agenticmail/mail/inbox?limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${agentApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new AgenticMailApiError(res.status, `mail/inbox HTTP ${res.status}`);
  }
  const data = await res.json() as InboxListResponse;
  return data?.messages ?? [];
}

interface TaskRow {
  id: string;
  task_type?: string;
  type?: string;
  status: string;
  assignee_id?: string;
  assignee?: string;
  description?: string;
  task?: string;
  created_at?: string;
}

/**
 * Fetch tasks assigned to this agent that are still pending. The
 * `/tasks` route returns the agent's own tasks when called with an
 * agent api key. We filter by status='pending' on the client to
 * stay forward-compatible with the API adding more states.
 */
export async function listPendingTasksForAgent(
  apiUrl: string,
  agentApiKey: string,
): Promise<TaskRow[]> {
  const url = `${apiUrl.replace(/\/$/, '')}/api/agenticmail/tasks/pending`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${agentApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // 404 = older API without /tasks/pending; quiet failure so older
    // deployments still upgrade cleanly without dispatcher log-spamming.
    if (res.status === 404) return [];
    throw new AgenticMailApiError(res.status, `tasks/pending HTTP ${res.status}`);
  }
  const data = await res.json() as { tasks?: TaskRow[] } | TaskRow[];
  const rows = Array.isArray(data) ? data : (data?.tasks ?? []);
  // The endpoint returns pending+claimed; we only want pending here so
  // we don't re-spawn workers for tasks another instance already
  // claimed and is mid-flight on (claimed rows still hold the claim
  // and may resume on their own).
  return rows.filter(t => (t.status ?? '').toLowerCase() === 'pending');
}
