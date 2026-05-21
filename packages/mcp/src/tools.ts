import { scheduleFollowUp, drainFollowUps, cancelFollowUp } from './pending-followup.js';
import { recordToolCall, redactSecret } from '@agenticmail/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TOOL_SETS, SET_DESCRIPTIONS, TOOL_TO_SET, type ToolSetName } from './tool-catalog.js';

const API_URL = process.env.AGENTICMAIL_API_URL ?? 'http://127.0.0.1:3829';
const API_KEY = process.env.AGENTICMAIL_API_KEY ?? '';
const MASTER_KEY = process.env.AGENTICMAIL_MASTER_KEY ?? '';

/**
 * Which host integration this MCP server instance belongs to.
 *
 * Each host installer (`@agenticmail/claudecode install`, `agenticmail-codex
 * install`) stamps `AGENTICMAIL_MCP_HOST=<bridge-name>` into the MCP server
 * env block in its host's config. The value is used by:
 *
 *   1. `create_account` — to auto-stamp `metadata.host` on every new agent
 *      so dispatchers and installers can route correctly.
 *   2. `list_agents` / `check_activity` / `inbox_digest` — to scope the
 *      response to the calling host's own teammates. Without this filter,
 *      a Codex session calling `check_activity` sees Claude-owned workers
 *      (and vice versa), which is confusing UX and a (mild) information
 *      leak across host boundaries.
 *
 * Empty / unset means "no host integration registered me" — fall back to
 * the un-filtered view so direct MCP usage from a non-host client still
 * works. Lowercased for case-insensitive comparisons.
 */
const MCP_HOST = (process.env.AGENTICMAIL_MCP_HOST ?? '').trim().toLowerCase();

/**
 * Decide whether `host` (the `metadata.host` value on some account or
 * worker) should be visible to the caller. Three states:
 *
 *   - MCP_HOST is empty (no host integration set): pass everything.
 *   - host matches MCP_HOST exactly: visible.
 *   - host is unset/legacy (no metadata.host stamp): visible — these are
 *     pre-0.9.20 accounts that haven't been claimed by any dispatcher
 *     yet; surfacing them to every host preserves discovery.
 *   - host belongs to a different integration: hidden.
 *
 * This is the canonical sanity check for every list-style MCP tool that
 * returns multiple agents / workers.
 */
function visibleToCallerHost(host: string | null | undefined): boolean {
  if (!MCP_HOST) return true;  // not running under a host integration
  if (!host) return true;       // legacy / unclaimed — always visible
  return host.toLowerCase() === MCP_HOST;
}

/**
 * Assert that an agent named `target` is visible to the current host.
 * Used by single-target tools (`message_agent`, `call_agent`,
 * `delete_agent`, …) to refuse cross-host targeting BEFORE the
 * underlying API call runs — saves a round-trip and produces a clear
 * error message that names the ownership mismatch.
 *
 * If `target` doesn't resolve (typo, deleted, never existed) we
 * fall through silently so the downstream call can produce its own
 * "agent not found" error with its usual phrasing.
 */
async function assertHostOwnsAgent(target: string): Promise<void> {
  if (!MCP_HOST) return;
  if (!target) return;
  try {
    const info = await apiRequest('GET', `/accounts/directory/${encodeURIComponent(target)}`);
    const host = typeof info?.host === 'string' ? info.host : null;
    if (!visibleToCallerHost(host)) {
      throw new Error(
        `Agent "${target}" is owned by host "${host}", not "${MCP_HOST}". ` +
        `Each host's MCP server only talks to its own teammates + unclaimed accounts. ` +
        `If you want to transfer this agent: \`agenticmail-${host} claim ${target} --unclaim\` then \`agenticmail-${MCP_HOST} claim ${target}\`.`,
      );
    }
  } catch (err) {
    // Only rethrow our own ownership error; anything else (404, network)
    // bubbles through to the downstream call so the model sees the
    // canonical not-found message.
    if (err instanceof Error && err.message.includes('owned by host')) throw err;
  }
}

/**
 * Per-call identity override.
 *
 * The MCP server has a single "default" identity (AGENTICMAIL_API_KEY). For
 * the @agenticmail/claudecode integration, a single Claude Code session
 * needs to act as MANY AgenticMail agents — one subagent per agent, each
 * operating its own mailbox. Spawning one MCP server per identity at
 * Claude Code startup would be expensive (one stdio child per agent, every
 * session). Instead, the host writes the full set of agent API keys into
 * `AGENTICMAIL_ACCOUNT_KEYS_JSON` at install time, and the subagent passes
 * `_account: "Fola"` (etc.) on every tool call — we look the key up here.
 *
 * Falsy / missing / unknown account → falls back to the default API_KEY,
 * which keeps the standalone MCP-server use case unaffected.
 */
/**
 * Account-key cache, lower-case name → apiKey.
 *
 * Two paths populate this:
 *   1. Initial seeding from AGENTICMAIL_ACCOUNT_KEYS_JSON at module load
 *      (the @agenticmail/claudecode installer writes a snapshot of every
 *      AgenticMail account here so the common case is zero round trips).
 *   2. Lazy on-demand fill via the master API when a tool call references
 *      an unknown name (see resolveAccountKey below). This means a fresh
 *      `create_account` followed immediately by an `_account: "<new-name>"`
 *      call WORKS without anyone having to restart the MCP server or
 *      rewrite `~/.claude.json` — the cache extends itself.
 *
 * The cache only ever grows. Account deletions are rare; the worst case
 * for a stale entry is one extra 401 from the API, which the tool layer
 * surfaces as a normal error.
 */
const ACCOUNT_KEYS: Map<string, string> = new Map();
(() => {
  const raw = process.env.AGENTICMAIL_ACCOUNT_KEYS_JSON ?? '';
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v) ACCOUNT_KEYS.set(k.toLowerCase(), v);
      }
    }
  } catch (err) {
    console.error(`[agenticmail-mcp] Warning: AGENTICMAIL_ACCOUNT_KEYS_JSON is not valid JSON: ${(err as Error).message}`);
  }
})();

/**
 * Resolve an account name to its apiKey, falling back to a master-keyed
 * lookup when the cache misses. Returns null if the account doesn't
 * exist OR if no master key is configured.
 *
 * Negative results are NOT cached — if a worker creates an account and
 * immediately tries to use it, an earlier negative cache hit would lock
 * us into the wrong answer for the rest of the process's lifetime. The
 * positive cache is cheap to refill; the cost of an extra GET /accounts
 * for misses is bounded by the create-account rate, which is low.
 */
async function resolveAccountKey(name: string): Promise<string | null> {
  const lower = name.toLowerCase();
  const cached = ACCOUNT_KEYS.get(lower);
  if (cached) return cached;
  if (!MASTER_KEY) return null;
  try {
    const res = await fetch(`${API_URL}/api/agenticmail/accounts`, {
      headers: { 'Authorization': `Bearer ${MASTER_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { agents?: Array<{ name?: string; apiKey?: string }> };
    for (const agent of data.agents ?? []) {
      if (typeof agent.name === 'string' && typeof agent.apiKey === 'string' && agent.apiKey) {
        ACCOUNT_KEYS.set(agent.name.toLowerCase(), agent.apiKey);
      }
    }
    return ACCOUNT_KEYS.get(lower) ?? null;
  } catch {
    return null;
  }
}

interface ToolCallContext {
  /** Per-call API key override; null = use default API_KEY. */
  apiKey: string | null;
}
const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

if (!API_KEY && !MASTER_KEY && ACCOUNT_KEYS.size === 0) {
  console.error('[agenticmail-mcp] Warning: No AGENTICMAIL_API_KEY, AGENTICMAIL_MASTER_KEY, or AGENTICMAIL_ACCOUNT_KEYS_JSON is set');
}

type ApiJsonObject = Record<string, any>;
type ApiJsonArray = any[];
type ApiResponse = ApiJsonObject | ApiJsonArray | null;

/** Build a check function that returns true if a pending email is still awaiting approval. */
function makePendingCheck(pendingId: string): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetch(`${API_URL}/api/agenticmail/mail/pending/${encodeURIComponent(pendingId)}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const data: any = await res.json();
      return data?.status === 'pending';
    } catch {
      return true;
    }
  };
}

/** Attach any queued follow-up reminders to a text response. */
function withReminders(text: string): string {
  const reminders = drainFollowUps();
  if (reminders.length === 0) return text;
  return text + '\n\n' + reminders.map(r => r.message).join('\n\n');
}

async function apiRequest<T extends ApiResponse = ApiJsonObject>(method: string, path: string, body?: unknown, useMasterKey = false, timeoutMs = 30_000): Promise<T> {
  // Resolution order:
  //   1. If the tool needs the master key (admin-scoped ops) AND we have one — master wins.
  //   2. Otherwise prefer the per-call identity from toolCallContext (set by
  //      handleToolCall when the caller passed `_account: "..."`).
  //   3. Otherwise fall back to the static AGENTICMAIL_API_KEY.
  const perCallKey = toolCallContext.getStore()?.apiKey ?? null;
  const key = useMasterKey && MASTER_KEY ? MASTER_KEY : (perCallKey ?? API_KEY);
  // AGENTICMAIL_MCP_DEBUG flips on a per-request trace of which identity was
  // used. Kept here permanently because identity-routing bugs (forgotten
  // `_account` arg, typo in account name, missing key in the map) are
  // notoriously silent — they degrade back to the default identity and look
  // like "the inbox is just empty", which is the wrong intuition.
  if (process.env.AGENTICMAIL_MCP_DEBUG) {
    // Redact the actual key material; preserve only the `mk_`/`ak_`
    // prefix so the log still tells you "this used a master key
    // vs a per-agent key". 12-char prefix logging is enough for
    // an attacker who sees the log to identify which credential
    // leaked — CodeQL `js/clear-text-logging`.
    console.error(`[mcp-debug] apiRequest ${method} ${path} | perCall=${perCallKey ? redactSecret(perCallKey) : 'none'} | resolved=${redactSecret(key)}`);
  }
  if (!key) {
    throw new Error(useMasterKey
      ? 'Master key is required for this operation. Set AGENTICMAIL_MASTER_KEY.'
      : 'API key is not configured. Set AGENTICMAIL_API_KEY (or pass _account to use a per-agent key).');
  }

  const headers: Record<string, string> = { 'Authorization': `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_URL}/api/agenticmail${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    let text: string;
    try { text = await response.text(); } catch { text = '(could not read response body)'; }
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    try {
      return await response.json() as T;
    } catch {
      throw new Error(`API returned invalid JSON from ${path}`);
    }
  }
  return null as T;
}

export const toolDefinitions = [
  {
    name: 'send_email',
    description: 'Send an email from the agent\'s mailbox. The PRIMARY primitive for multi-agent coordination. **Use `to` and `cc` as the email standard intends** — `to` is the actor(s) the message is addressed to (one or two recipients in most cases); `cc` is everyone else on the thread for awareness. Lumping every participant on `to` is wrong and defeats the wake gating. WAKE SEMANTICS (0.9.0+): by default only local @localhost recipients on `to:` get a host wake; CC\'d local agents receive the mail but don\'t wake — they see it on their next natural wake. To override: pass `wake: ["alice","bob"]` for specific agents regardless of To/CC, or `wake: "all"` for the pre-0.9.0 "wake every recipient" behaviour, or `wake: []` to deliver silently. External emails are scanned for sensitive content; HIGH severity detections are BLOCKED for owner approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Primary actor — the agent(s) you want to act on this message. Usually one address; rarely two. **Everyone else on the thread goes on `cc`, NOT here.** Lumping all participants on `to` defeats the wake gating: every local @localhost recipient on `to` gets a host turn, so a 5-agent thread = 5 host turns per round. Comma-separated supported but use sparingly.' },
        subject: { type: 'string', description: 'Email subject line' },
        text: { type: 'string', description: 'Plain text body' },
        html: { type: 'string', description: 'HTML body (optional)' },
        cc: { type: 'string', description: 'CC recipients — the team. Comma-separated, e.g. "vesper@localhost, orion@localhost". CC\'d local recipients receive the mail but DO NOT wake by default (0.9.0+). Put the actor on `to`; CC the rest for awareness.' },
        wake: {
          description: 'Optional wake-control. Accepts: (1) an array of agent names — `["alice","bob"]` — to wake exactly those agents (overrides default To-only behaviour); (2) the string `"all"` to wake every local recipient on To and CC (pre-0.9.0 behaviour); (3) an empty array `[]` to deliver silently with no wakes; (4) omit entirely to use the default — wake local recipients on `To:` only. CC\'d recipients NOT in the wake list still receive the mail in their inbox and will see it when they next wake naturally.',
        },
        inReplyTo: { type: 'string', description: 'Message-ID to reply to (optional)' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message-IDs for threading (optional)',
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Attachment filename' },
              content: { type: 'string', description: 'File content as text string (for text files) or base64-encoded string (for binary files)' },
              contentType: { type: 'string', description: 'MIME type (e.g. text/plain, application/pdf)' },
              encoding: { type: 'string', description: 'Set to "base64" only if content is base64-encoded' },
            },
            required: ['filename', 'content'],
          },
          description: 'File attachments',
        },
      },
      required: ['to', 'subject'],
    },
  },
  {
    name: 'list_inbox',
    description: 'List recent emails in the agent\'s inbox',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 20)' },
        offset: { type: 'number', description: 'Number of messages to skip (default: 0)' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its UID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The UID of the email to read' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'delete_email',
    description: 'Delete an email by its UID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The UID of the email to delete' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails by criteria (from, to, subject, text, date range). By default searches the local inbox only. Set searchRelay=true to also search the connected Gmail/Outlook account — results include relay UIDs that can be imported with import_relay_email.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Filter by sender address' },
        to: { type: 'string', description: 'Filter by recipient address' },
        subject: { type: 'string', description: 'Filter by subject keyword' },
        text: { type: 'string', description: 'Search body text' },
        since: { type: 'string', description: 'Messages since date (ISO 8601)' },
        before: { type: 'string', description: 'Messages before date (ISO 8601)' },
        seen: { type: 'boolean', description: 'Filter by read/unread status' },
        searchRelay: { type: 'boolean', description: 'Also search the connected Gmail/Outlook account (default: false). Use this to find past emails from the user\'s main inbox.' },
      },
    },
  },
  {
    name: 'import_relay_email',
    description: 'Import an email from the connected Gmail/Outlook account into the agent\'s local inbox. This downloads the full message with all headers (Message-ID, In-Reply-To, References) so you can continue the thread using reply_email. Use search_emails with searchRelay=true first to find the relay UID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The relay UID of the email to import (from search_emails relay results)' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'reply_email',
    description: 'Reply to an email. Fetches the original message, auto-fills To, Subject (Re:), In-Reply-To, and References, then sends with quoted body. **For multi-agent thread coordination, pass `replyAll: true`** — the original sender lands on To:, every other thread participant lands on Cc:. **Wake routing is body-aware**: if your reply addresses a specific CC\'d agent ("Marlow —", "@kepler", "handing off to rivet", etc.), the dispatcher wakes them automatically. If your body has no such addressing, the original sender (on To:) wakes by default. **Pass `wake` to override** explicitly (e.g. `wake: ["marlow"]` to force-target one agent, or `wake: []` to deliver silently). Outbound guard applies — HIGH severity content is held for review.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to reply to' },
        text: { type: 'string', description: 'Your reply text' },
        html: { type: 'string', description: 'HTML reply (optional)' },
        replyAll: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
        wake: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Names of the agents who should get a host turn from the dispatcher when this reply lands. CC\'d agents NOT in this list still receive the email but stay asleep — saves significant tokens on large threads. Pass `[]` to deliver silently. Omit to wake everyone CC\'d.',
        },
      },
      required: ['uid', 'text'],
    },
  },
  {
    name: 'forward_email',
    description: 'Forward an email to another recipient. Outbound guard applies — HIGH severity content is held for review. Pass `wake` to limit which local recipients get a host turn from the dispatcher when this forward lands.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to forward' },
        to: { type: 'string', description: 'Recipient to forward to' },
        text: { type: 'string', description: 'Additional message (optional)' },
        wake: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Names of the agents who should get a host turn when the forward lands. Pass `[]` to deliver silently. Omit to wake everyone CC\'d.',
        },
      },
      required: ['uid', 'to'],
    },
  },
  {
    name: 'move_email',
    description: 'Move an email to another folder (e.g., Trash, Archive)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to move' },
        to: { type: 'string', description: 'Destination folder (e.g., Trash, Archive)' },
        from: { type: 'string', description: 'Source folder (default: INBOX)' },
      },
      required: ['uid', 'to'],
    },
  },
  {
    name: 'mark_unread',
    description: 'Mark an email as unread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'mark_read',
    description: 'Mark an email as read',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'list_folders',
    description: 'List all mail folders/mailboxes',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_folder',
    description: 'List messages in a specific folder',
    inputSchema: {
      type: 'object' as const,
      properties: {
        folder: { type: 'string', description: 'Folder path (e.g., INBOX, Trash, Sent)' },
        limit: { type: 'number', description: 'Max messages (default: 20)' },
        offset: { type: 'number', description: 'Skip messages (default: 0)' },
      },
      required: ['folder'],
    },
  },
  {
    name: 'batch_delete',
    description: 'Delete multiple emails by UIDs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to delete' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'batch_mark_read',
    description: 'Mark multiple emails as read',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to mark as read' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'manage_contacts',
    description: 'List, add, or delete contacts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'delete'], description: 'Action to perform' },
        email: { type: 'string', description: 'Contact email (for add)' },
        name: { type: 'string', description: 'Contact name (for add)' },
        id: { type: 'string', description: 'Contact ID (for delete)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_drafts',
    description: 'List, create, update, send, or delete drafts. On send, you can pass `wake` to limit which local recipients get a host turn — same semantics as send_email.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'send', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Draft ID (for update/send/delete)' },
        to: { type: 'string', description: 'Recipient (for create/update)' },
        subject: { type: 'string', description: 'Subject (for create/update)' },
        text: { type: 'string', description: 'Body text (for create/update)' },
        wake: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional, for action=send. Names of the agents who should get a host turn when the drafted mail lands. Pass `[]` to deliver silently. Omit to wake everyone CC\'d.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_scheduled',
    description: 'Manage scheduled emails: create a new scheduled email, list pending ones, or cancel one. Accepts flexible time formats for create: ISO 8601, relative ("in 30 minutes"), named ("tomorrow 8am"), day-based ("next monday 9am"), or human-friendly ("02-14-2026 3:30 PM EST").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'Action to perform (default: create)' },
        to: { type: 'string', description: 'Recipient email (for create)' },
        subject: { type: 'string', description: 'Email subject (for create)' },
        text: { type: 'string', description: 'Body text (for create)' },
        sendAt: { type: 'string', description: 'When to send (for create)' },
        id: { type: 'string', description: 'Scheduled email ID (for cancel)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new mail folder for organizing emails',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Folder name (e.g., Projects, Clients, Newsletters)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'manage_tags',
    description: 'Create, list, delete tags, tag/untag messages, get messages by tag, or get all tags for a specific message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete', 'tag_message', 'untag_message', 'get_messages', 'get_message_tags'], description: 'Action to perform' },
        name: { type: 'string', description: 'Tag name (for create)' },
        color: { type: 'string', description: 'Tag color hex code (for create, e.g. #ff0000)' },
        id: { type: 'string', description: 'Tag ID (for delete, tag_message, untag_message, get_messages)' },
        uid: { type: 'number', description: 'Message UID (for tag_message, untag_message)' },
        folder: { type: 'string', description: 'Folder the message is in (default: INBOX)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_account',
    description: 'Create a new AgenticMail agent (email account + identity + API key + persona derived from role/metadata). Requires master API key. After creation: address them at `<name>@localhost`, delegate work via `call_agent({ target: "<name>", task: ... })`, or hand off via `send_email` / `message_agent`. The new agent acts as themselves — you never need to (and must not) roleplay them inside your host\'s native sub-agent tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent name (will be used as email local part)' },
        domain: { type: 'string', description: 'Email domain (default: localhost)' },
        role: { type: 'string', enum: ['secretary', 'assistant', 'researcher', 'writer', 'custom'], description: 'Agent role (default: secretary)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'setup_operator_email',
    description: 'Save the operator\'s notification email address for bridge-escalation alerts. When sub-agents mail a host bridge (e.g. `wake: ["codex"]`) AND no fresh host session is available for a headless resume, the dispatcher forwards a digest to this address so the operator gets a phone push (via Gmail / Apple Mail / whichever app handles their address). Master-key scoped. The host agent should call this during bootstrap after asking the operator: "what email should we alert you at when sub-agents need your attention?" — the answer is typically the operator\'s personal Gmail with mobile push enabled. Idempotent: re-running with a new address updates the config.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Operator notification email (e.g. you@example.com). Pass `null` or an empty string to clear an existing setting.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'setup_email_relay',
    description: 'Configure Gmail/Outlook relay for sending real internet email (requires master API key). BEGINNER-FRIENDLY: Just needs a Gmail/Outlook email + app password. Agents send as user+agentname@gmail.com. Automatically creates a default agent (secretary) unless skipped. Best for: quick setup, personal use, no domain needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        provider: { type: 'string', enum: ['gmail', 'outlook', 'custom'], description: 'Email provider (gmail, outlook, or custom)' },
        email: { type: 'string', description: 'Your real email address (e.g., user@gmail.com)' },
        password: { type: 'string', description: 'App password (not your regular password)' },
        smtpHost: { type: 'string', description: 'SMTP host (auto-filled for gmail/outlook)' },
        smtpPort: { type: 'number', description: 'SMTP port (auto-filled for gmail/outlook)' },
        imapHost: { type: 'string', description: 'IMAP host (auto-filled for gmail/outlook)' },
        imapPort: { type: 'number', description: 'IMAP port (auto-filled for gmail/outlook)' },
        agentName: { type: 'string', description: 'Name for the default agent (default: secretary). This becomes the email sub-address, e.g., user+secretary@gmail.com' },
        agentRole: { type: 'string', enum: ['secretary', 'assistant', 'researcher', 'writer', 'custom'], description: 'Role for the default agent (default: secretary)' },
        skipDefaultAgent: { type: 'boolean', description: 'Skip creating the default agent (default: false)' },
      },
      required: ['provider', 'email', 'password'],
    },
  },
  {
    name: 'setup_email_domain',
    description: 'Set up a custom domain for real internet email via Cloudflare (requires master API key). ADVANCED: Requires Cloudflare account, API token, and a domain. Emails send from agent@yourdomain.com with full DKIM/SPF/DMARC. Optionally configures Gmail SMTP as outbound relay (recommended for residential IPs). After setup with gmailRelay, use setup_gmail_alias for each agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cloudflareToken: { type: 'string', description: 'Cloudflare API token (Zone>Zone>Read, Zone>DNS>Edit, Zone>Email Routing Rules>Edit, Account>Cloudflare Tunnel>Edit, Account>Workers Scripts>Edit; optional: Account>Registrar: Domains>Edit for domain purchase)' },
        cloudflareAccountId: { type: 'string', description: 'Cloudflare account ID' },
        domain: { type: 'string', description: 'Domain to use (if already owned)' },
        purchase: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for available domains' },
            tld: { type: 'string', description: 'Preferred TLD (e.g., .com, .io)' },
          },
          description: 'Purchase a new domain (if domain not provided)',
        },
        gmailRelay: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Gmail address for SMTP relay (e.g., you@gmail.com)' },
            appPassword: { type: 'string', description: 'Gmail app password (from https://myaccount.google.com/apppasswords)' },
          },
          description: 'Gmail SMTP relay for outbound delivery (recommended for residential IPs without PTR records)',
        },
      },
      required: ['cloudflareToken', 'cloudflareAccountId'],
    },
  },
  {
    name: 'setup_guide',
    description: 'Get a comparison of email setup modes (Relay vs Domain) AND the optional channels — realtime voice (OPENAI_API_KEY), phone call-control with a 46elks-vs-Twilio provider choice, and the Telegram channel — each with difficulty levels, requirements, pros/cons, and step-by-step instructions. Show this to users who want to set up real internet email, voice calls, phone, or Telegram.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'setup_gmail_alias',
    description: 'Get step-by-step instructions (with exact field values) to add an agent email as a Gmail "Send mail as" alias. Returns the Gmail settings URL and all field values. Required after domain mode setup with gmailRelay to show correct From address. The agent can automate this via browser tools or present instructions to the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentEmail: { type: 'string', description: 'Agent email to add as alias (e.g., secretary@yourdomain.com)' },
        agentDisplayName: { type: 'string', description: 'Display name for the alias (defaults to agent name)' },
      },
      required: ['agentEmail'],
    },
  },
  {
    name: 'setup_payment',
    description: 'Get instructions for adding a payment method to Cloudflare (required before purchasing domains). Returns Option A (self-service link) and Option B (browser automation steps). Card details go directly to Cloudflare — never stored by 🎀 AgenticMail.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'purchase_domain',
    description: 'Search for available domains via Cloudflare Registrar (requires master API key). NOTE: Cloudflare API only supports READ access — domains must be purchased manually at https://dash.cloudflare.com or from another registrar (then point nameservers to Cloudflare).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for (e.g., ["mybot", "aimail"])' },
        tld: { type: 'string', description: 'Preferred TLD (default: checks .com, .net, .io, .dev)' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'check_gateway_status',
    description: 'Check the current email gateway status — relay mode, domain mode, or not configured',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'send_test_email',
    description: 'Send a test email through the gateway to verify configuration (requires master API key)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Email address to send the test to' },
      },
      required: ['to'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all AI agents in the system with their email addresses and roles. Use this to discover which agents you can call via call_agent (sync RPC) or email via send_email / message_agent (async). DO NOT spawn one of your host\'s native sub-agents and roleplay AS these agents — each one is a real identity with its own mailbox; just address them through AgenticMail and let them work as themselves.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'message_agent',
    description: 'Async fire-and-forget: deliver a message to another AI agent\'s inbox. They will process it on their own schedule (immediately if a dispatcher is attached, later otherwise) and may reply by email. Use this for non-blocking handoffs. Prefer `call_agent` when you need a structured reply back. Both flows let the target agent do the work AS THEMSELVES — never roleplay them inside your own host.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Name of the recipient agent (e.g. "researcher", "writer")' },
        subject: { type: 'string', description: 'Message subject — describe the purpose clearly' },
        text: { type: 'string', description: 'Message body' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'Priority level (default: normal)' },
      },
      required: ['agent', 'subject', 'text'],
    },
  },
  {
    name: 'check_messages',
    description: 'Check for new unread messages from other agents or external senders. Returns a summary of pending communications. Use this to stay aware of requests and coordinate with other agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_agent',
    description: 'Delete an agent account. Archives all emails and generates a deletion report before removing the account permanently. Returns the deletion summary. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the agent to delete' },
        reason: { type: 'string', description: 'Reason for deletion (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'stop_agent',
    description: 'Soft-stop an agent mid-task WITHOUT deleting it. Sets the agent\'s `stopped` flag — the dispatcher then refuses to wake the agent for any reason (allowlists, To/Cc, task events all silently no-op). Mail STILL lands in the mailbox, so the email-thread audit trail is preserved. Use this instead of `delete_agent` when you want to halt a churning sub-agent partway through a task and keep the option to read the thread later or resume it. Resume with `resume_agent`. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the agent to stop' },
        reason: { type: 'string', description: 'Optional free-form reason (e.g. "task superseded", "user requested halt") — stored on the agent row for later audit.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'resume_agent',
    description: 'Reverse a previous `stop_agent` call. Clears the `stopped` flag so the dispatcher resumes waking this agent on incoming mail and task events. The agent\'s inbox is exactly as it was during the pause — any mail that arrived while stopped is still there and will be picked up on the next natural wake. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the agent to resume' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deletion_reports',
    description: 'List past agent deletion reports or retrieve a specific report by ID. Shows archived email summaries from deleted agents. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Deletion report ID (omit to list all reports)' },
      },
    },
  },
  {
    name: 'manage_signatures',
    description: 'List, create, or delete email signatures',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Signature ID (for delete)' },
        name: { type: 'string', description: 'Signature name (for create)' },
        text: { type: 'string', description: 'Signature text content (for create)' },
        isDefault: { type: 'boolean', description: 'Set as default signature (for create)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_templates',
    description: 'List, create, or delete email templates',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Template ID (for delete)' },
        name: { type: 'string', description: 'Template name (for create)' },
        subject: { type: 'string', description: 'Template subject (for create)' },
        text: { type: 'string', description: 'Template body text (for create)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'batch_mark_unread',
    description: 'Mark multiple emails as unread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to mark as unread' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'batch_move',
    description: 'Move multiple emails to another folder',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to move' },
        from: { type: 'string', description: 'Source folder (default: INBOX)' },
        to: { type: 'string', description: 'Destination folder (e.g., Trash, Archive)' },
      },
      required: ['uids', 'to'],
    },
  },
  {
    name: 'whoami',
    description: 'Get the current agent\'s account info — name, email, role, and metadata',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'update_metadata',
    description: 'Update the current agent\'s metadata. Merges provided keys with existing metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        metadata: { type: 'object', description: 'Metadata key-value pairs to set or update' },
      },
      required: ['metadata'],
    },
  },
  {
    name: 'check_health',
    description: 'Check 🎀 AgenticMail server health status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'wait_for_email',
    description: 'Block until a matching email (or task) lands in your inbox. Push-based (SSE) — far more efficient than polling. Supports filtering by sender, subject substring, thread (In-Reply-To), or a participants list. The single-most-useful tool for thread-based coordination: send a kickoff email CC\'ing your team, then `wait_for_email({ subject: "<core thread subject>" })` to wake on the first reply. Non-matching events that arrive during the wait are ignored — you only resume when something you asked for shows up (or timeout).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        timeout: { type: 'number', description: 'Max seconds to wait (default: 120, max: 300)' },
        from: { type: 'string', description: 'Only resume on an email FROM this address (case-insensitive substring match on the bare address — "orion" matches "orion@localhost").' },
        subject: { type: 'string', description: 'Only resume on an email whose subject contains this string (case-insensitive). The thread\'s core subject works — "Build a small game" matches "Re: Build a small game".' },
        inReplyTo: { type: 'string', description: 'Only resume on an email whose In-Reply-To header equals this Message-ID. Most precise thread filter — use when you have the exact Message-ID of the message you expect a reply to.' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only resume on an email from ANY of these addresses (case-insensitive). Use this to wait for any teammate\'s reply, e.g. ["vesper@localhost", "orion@localhost"].',
        },
        includeTasks: { type: 'boolean', description: 'Include task-assignment events as matches (default: true). Set false if you only care about email.' },
      },
    },
  },
  {
    name: 'batch_read',
    description: 'Read multiple emails at once by UIDs. Returns full parsed content for each message in a single call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to read' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'inbox_digest',
    description: 'Get a compact inbox digest with subject, sender, date, flags and text preview for each message. More efficient than listing then reading individually.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max messages (default: 20, max: 50)' },
        offset: { type: 'number', description: 'Skip messages (default: 0)' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
        previewLength: { type: 'number', description: 'Preview text length (default: 200, max: 500)' },
      },
    },
  },
  {
    name: 'template_send',
    description: 'Send an email using a saved template with variable substitution. Variables like {{name}} are replaced.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Template ID' },
        to: { type: 'string', description: 'Recipient email' },
        variables: { type: 'object', description: 'Variables to substitute: { name: "Alice" }' },
        cc: { type: 'string', description: 'CC recipients' },
        bcc: { type: 'string', description: 'BCC recipients' },
        wake: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Names of the agents who should get a host turn when this template-rendered mail lands. Pass `[]` to deliver silently. Omit to wake everyone CC\'d.',
        },
      },
      required: ['id', 'to'],
    },
  },
  {
    name: 'manage_rules',
    description: 'Manage server-side email rules that auto-process incoming messages (move, tag, mark read, delete).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Rule ID (for delete)' },
        name: { type: 'string', description: 'Rule name (for create)' },
        priority: { type: 'number', description: 'Higher priority rules match first (for create)' },
        conditions: { type: 'object', description: 'Match conditions: { from_contains?, subject_contains?, subject_regex?, to_contains?, has_attachment? }' },
        actions: { type: 'object', description: 'Actions on match: { move_to?, mark_read?, delete?, add_tags? }' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cleanup_agents',
    description: 'List or remove inactive non-persistent agent accounts (requires master API key)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list_inactive', 'cleanup', 'set_persistent'], description: 'Action to perform' },
        hours: { type: 'number', description: 'Inactivity threshold in hours (default: 24)' },
        dryRun: { type: 'boolean', description: 'Preview without deleting (for cleanup)' },
        agentId: { type: 'string', description: 'Agent ID (for set_persistent)' },
        persistent: { type: 'boolean', description: 'Set persistent flag (for set_persistent)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'save_thread_memory',
    description: 'Persist a one-paragraph memory of where THIS agent stands on the given thread. Called at the end of every wake — Claude Code reads it back into the next wake\'s prompt so the agent doesn\'t re-derive context from scratch by re-reading 10 prior messages. Pass `threadId` from `get_thread_id`. Fields are a snapshot: summary (where the thread stands), commitments (what you committed to), openQuestions (what you are blocked on), lastAction (what you just did), lastUid (newest UID you have digested). The file overwrites; you do not need to merge with the previous version — the dispatcher reads only the most recent write.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadId: { type: 'string', description: 'Stable thread id from get_thread_id. Required.' },
        summary: { type: 'string', description: 'One-paragraph narrative of where the thread stands.' },
        commitments: { type: 'array', items: { type: 'string' }, description: 'Things you have committed to doing on this thread.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Things you are waiting on / open questions.' },
        lastAction: { type: 'string', description: 'The last action you took on the thread (e.g. "replied UID 41 asking for raw counts").' },
        lastUid: { type: 'number', description: 'Newest message UID you have digested into this memory.' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'get_thread_id',
    description: 'Resolve the stable thread id for a message UID. Use this BEFORE calling save_thread_memory or when you want to inspect the cache for a thread. Pass the UID of any message on the thread (root or reply) — the API normalises the subject, resolves the canonical root sender, and returns the same id every time. `folder` defaults to INBOX.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'Message UID.' },
        folder: { type: 'string', description: 'IMAP folder where the UID lives. Defaults to INBOX.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'tail_worker',
    description: 'Tail the log of a running (or recently-finished) dispatcher worker. Use this when check_activity shows a worker has been running a long time or is marked stale, and you want to see what it is actually doing — every tool call, tool result, and assistant chunk is logged as a one-liner. Returns the last N lines (default 80). The workerId comes from check_activity output. Requires master key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workerId: { type: 'string', description: 'Worker id from check_activity output.' },
        lines: { type: 'number', description: 'How many trailing log lines to return. Default 80, max 1000.' },
      },
      required: ['workerId'],
    },
  },
  {
    name: 'check_activity',
    description: 'Check which agents are currently being woken by the dispatcher. Use this when you sent mail to a teammate and want to know if they have actually started working, or to audit the live multi-agent state. Returns active workers with the agent name, what triggered the wake (mail UID + subject, or task id), how long they have been running, the most recent tool they invoked, how many tool calls they have made, a `stale` flag (true if the dispatcher has not heartbeated in 90s+), and a preview of recently-finished work. Workers may run for hours — there is no auto-eviction; staleness is just a hint. Requires master key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Filter to a specific agent by name (case-insensitive). Omit to see every active and recently-finished worker.' },
        includeRecent: { type: 'boolean', description: 'Include workers that finished in the last ~2 minutes (default: true). Set false to see only currently-running workers.' },
      },
    },
  },
  {
    name: 'check_tasks',
    description: 'Check for pending tasks assigned to you (or a specific agent) or tasks you assigned to others',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['incoming', 'outgoing'], description: 'incoming (assigned to me) or outgoing (I assigned)' },
        assignee: { type: 'string', description: 'Check tasks for a specific agent by name (only for incoming direction)' },
      },
    },
  },
  {
    name: 'claim_task',
    description: 'Claim a pending task assigned to you',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID to claim' },
      },
      required: ['id'],
    },
  },
  {
    name: 'submit_result',
    description: 'Submit the result for a claimed task, marking it as completed',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID' },
        result: { type: 'object', description: 'Task result data' },
      },
      required: ['id'],
    },
  },
  {
    name: 'call_agent',
    description: 'Synchronous RPC to delegate work to another AgenticMail agent. Pipeline: the task is queued in AgenticMail, the target agent processes it AS THEMSELVES (under their real identity, mailbox, persona, and audit trail), and the structured result returns into your call. THIS IS HOW MULTI-AGENT COORDINATION IS SUPPOSED TO WORK from any MCP host. Do not, instead, spawn one of your host\'s native sub-agents and tell it to "act as <target>" — that produces output under your identity, never touches the target\'s inbox, and skips their persona. Pass outputSchema to require a structured deliverable shape: the API validates the worker\'s submit_result against the schema and rejects mismatches with validator errors, so the worker can retry with a correct shape rather than returning free-form prose. Times out after the specified duration (default 180s, max 300s).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Name of the agent to call' },
        task: { type: 'string', description: 'Task description' },
        payload: { type: 'object', description: 'Additional data' },
        timeout: { type: 'number', description: 'Max seconds to wait (default: 180, max: 300)' },
        outputSchema: { type: 'object', description: 'Optional JSON Schema (draft-7 subset: type, required, properties, items, enum, additionalProperties, minLength/maxLength, minimum/maximum) describing the shape submit_result must conform to. The worker sees the schema in the wake prompt and the API validates on submission.' },
      },
      required: ['target', 'task'],
    },
  },
  {
    name: 'manage_spam',
    description: 'Manage spam: list spam folder, report a message as spam, mark as not-spam, or get the spam score of a message. Emails are auto-scored on arrival; high-scoring messages are moved to Spam automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'report', 'not_spam', 'score'], description: 'Action to perform' },
        uid: { type: 'number', description: 'Message UID (for report, not_spam, score)' },
        folder: { type: 'string', description: 'Source folder (for report/score, default: INBOX)' },
        limit: { type: 'number', description: 'Max messages to list (for list, default: 20)' },
        offset: { type: 'number', description: 'Skip messages (for list, default: 0)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_pending_emails',
    description: 'Check the status of pending outbound emails blocked by the outbound guard. You can list all your pending emails or get details of a specific one. You CANNOT approve or reject — only the owner can do that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'Action to perform (list or get only — approve/reject require owner)' },
        id: { type: 'string', description: 'Pending email ID (required for get)' },
      },
      required: ['action'],
    },
  },

  // --- SMS / Phone Tools ---
  {
    name: 'sms_setup',
    description: 'Configure SMS/phone number access. Supports Google Voice legacy forwarding and direct 46elks provider delivery/webhooks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phoneNumber: { type: 'string', description: 'SMS phone number in E.164 format (e.g. +46701234567 or +12125551234)' },
        provider: { type: 'string', enum: ['google_voice', '46elks'], description: 'SMS provider (default: google_voice)' },
        forwardingEmail: { type: 'string', description: 'Google Voice only: email address Google Voice forwards SMS to (defaults to agent email)' },
        forwardingPassword: { type: 'string', description: 'Google Voice only: app password for a separate forwarding Gmail' },
        username: { type: 'string', description: '46elks only: API username' },
        password: { type: 'string', description: '46elks only: API password' },
        webhookSecret: { type: 'string', description: '46elks only: shared secret required on inbound SMS webhooks' },
        apiUrl: { type: 'string', description: '46elks only: optional API base URL override' },
      },
      required: ['phoneNumber'],
    },
  },
  {
    name: 'sms_send',
    description: 'Send an SMS text message. Direct provider configs such as 46elks send through the provider API; Google Voice legacy configs return browser-send instructions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient phone number' },
        body: { type: 'string', description: 'Text message body' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'sms_messages',
    description: 'List SMS messages (inbound and outbound). Use direction filter to see only received or sent messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Filter by direction' },
        limit: { type: 'number', description: 'Max messages (default: 20)' },
        offset: { type: 'number', description: 'Skip messages (default: 0)' },
      },
    },
  },
  {
    name: 'sms_check_code',
    description: 'Check for recent verification/OTP codes received via SMS. Scans inbound SMS for common code patterns (6-digit, 4-digit, alphanumeric). Use this after requesting a verification code during sign-up flows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        minutes: { type: 'number', description: 'How many minutes back to check (default: 10)' },
      },
    },
  },
  {
    name: 'sms_parse_email',
    description: 'Parse an SMS from a forwarded Google Voice email. Use this when you receive an email from Google Voice containing an SMS. Extracts the sender number, message body, and any verification codes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        emailBody: { type: 'string', description: 'The email body text to parse' },
        emailFrom: { type: 'string', description: 'The email sender address' },
      },
      required: ['emailBody'],
    },
  },
  {
    name: 'storage',
    description: 'Full database management system for agents. 28 actions: DDL (create/alter/drop/clone/rename tables & columns), DML (insert/upsert/query/aggregate/update/delete/truncate), indexing (create/list/drop/reindex), import/export (JSON/CSV, conflict handling), raw SQL, maintenance (stats/vacuum/analyze/explain), archiving. WHERE supports operators: $gt, $gte, $lt, $lte, $ne, $like, $ilike, $in, $not_in, $is_null, $between. Works on SQLite, Postgres, MySQL, Turso.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'create_table, list_tables, describe_table, insert, upsert, query, aggregate, update, delete_rows, truncate, drop_table, clone_table, rename_table, rename_column, add_column, drop_column, create_index, list_indexes, drop_index, reindex, archive_table, unarchive_table, export, import, sql, stats, vacuum, analyze, explain' },
        table: { type: 'string', description: 'Table name' },
        description: { type: 'string', description: 'For create_table: human-readable description' },
        columns: { type: 'array', items: { type: 'object' }, description: 'For create_table: [{name, type, required?, default?, unique?, primaryKey?, references?: {table, column, onDelete?}, check?}]' },
        indexes: { type: 'array', items: { type: 'object' }, description: 'For create_table: [{columns, unique?, name?, where?}]' },
        shared: { type: 'boolean', description: 'For create_table: shared across agents' },
        timestamps: { type: 'boolean', description: 'For create_table: auto-add created_at/updated_at (default: true)' },
        rows: { type: 'array', items: { type: 'object' }, description: 'For insert/upsert/import: row objects' },
        where: { type: 'object', description: 'Filter conditions with operator support' },
        set: { type: 'object', description: 'For update: {column: newValue}' },
        orderBy: { type: 'string', description: 'ORDER BY clause' },
        limit: { type: 'number', description: 'Max rows' },
        offset: { type: 'number', description: 'Skip rows' },
        selectColumns: { type: 'array', items: { type: 'string' }, description: 'Specific columns to select' },
        distinct: { type: 'boolean', description: 'SELECT DISTINCT' },
        groupBy: { type: 'string', description: 'GROUP BY clause' },
        having: { type: 'string', description: 'HAVING clause' },
        operations: { type: 'array', items: { type: 'object' }, description: 'For aggregate: [{fn: count|sum|avg|min|max|count_distinct, column?, alias?}]' },
        column: { type: 'object', description: 'For add_column: {name, type, ...}' },
        columnName: { type: 'string', description: 'For drop_column' },
        indexName: { type: 'string', description: 'For create/drop_index' },
        indexColumns: { type: 'array', items: { type: 'string' }, description: 'For create_index' },
        indexUnique: { type: 'boolean', description: 'For create_index' },
        indexWhere: { type: 'string', description: 'Partial index condition' },
        newName: { type: 'string', description: 'For rename_table/rename_column/clone_table' },
        oldName: { type: 'string', description: 'For rename_column' },
        conflictColumn: { type: 'string', description: 'For upsert/import' },
        onConflict: { type: 'string', description: 'For import: skip|replace|error' },
        includeData: { type: 'boolean', description: 'For clone_table' },
        format: { type: 'string', description: 'For export: json|csv' },
        sql: { type: 'string', description: 'For sql/explain: raw SQL' },
        params: { type: 'array', items: { type: 'string' }, description: 'For sql/explain: query params' },
        includeShared: { type: 'boolean', description: 'For list_tables' },
        includeArchived: { type: 'boolean', description: 'For list_tables' },
      },
      required: ['action'],
    },
  },
  {
    name: 'sms_config',
    description: 'Get the current SMS/phone number configuration for this agent. Shows whether SMS is enabled, the phone number, and forwarding email.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'sms_read_voice',
    description: 'Get instructions and URL for reading SMS directly from Google Voice web (FASTEST method). Returns the voice.google.com URL and guidance for browser-based SMS reading. Primary method - much faster than email forwarding.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'sms_record',
    description: 'Record an SMS message read from Google Voice web or any other source. Saves to SMS database and extracts verification codes. Use after reading a message from voice.google.com.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Sender phone number' },
        body: { type: 'string', description: 'SMS message text' },
      },
      required: ['from', 'body'],
    },
  },
  {
    name: 'phone_transport_setup',
    description: 'Configure the phone call-control transport for this agent. This stores provider credentials and webhook settings; it does not start a call. Pick ONE provider — 46elks or twilio — and supply that provider\'s credentials. For 46elks pass username + password; for twilio pass accountSid + authToken (or the generic username + password — for twilio username is the account SID and password is the auth token).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        provider: { type: 'string', enum: ['46elks', 'twilio'], description: 'Phone provider: "46elks" (default) or "twilio". Both support call-control missions and realtime voice.' },
        phoneNumber: { type: 'string', description: 'Owned caller phone number in E.164 format, e.g. +43123456789' },
        username: { type: 'string', description: '46elks API username. For twilio this is the account SID — prefer the accountSid param for clarity.' },
        password: { type: 'string', description: '46elks API password. For twilio this is the auth token — prefer the authToken param for clarity.' },
        accountSid: { type: 'string', description: 'Twilio only: the account SID (alias for username when provider is "twilio").' },
        authToken: { type: 'string', description: 'Twilio only: the account auth token (alias for password when provider is "twilio").' },
        webhookBaseUrl: { type: 'string', description: 'Public HTTPS base URL for AgenticMail phone webhooks' },
        webhookSecret: { type: 'string', description: 'Shared secret included on provider webhook URLs (at least 24 characters)' },
        apiUrl: { type: 'string', description: 'Optional provider API base URL override (46elks or Twilio REST root)' },
        realtimeBridgeNumber: { type: 'string', description: '46elks only: websocket-number in E.164 format used for realtime outbound calls when capabilities include "realtime_media".' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Transport capabilities, e.g. ["call_control"] or ["call_control","realtime_media"]' },
        supportedRegions: { type: 'array', items: { type: 'string' }, description: 'Supported region scopes: AT, DE, EU, WORLD' },
      },
      required: ['phoneNumber', 'webhookBaseUrl', 'webhookSecret'],
    },
  },
  {
    name: 'phone_capabilities',
    description: 'Show the configured phone provider, caller number, supported regions, and whether realtime media is available.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'realtime_conversation_capabilities',
    description: 'Show AgenticMail realtime-conversation channel readiness for this agent: phone, Telegram, Matrix, WhatsApp, and Google Meet. Planned adapters fail closed until implemented.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['phone', 'telegram', 'matrix', 'whatsapp', 'google_meet'], description: 'Optional channel to inspect; omit to list all channels.' },
        policyProvided: { type: 'boolean', description: 'Set true when a concrete per-mission policy is already present.' },
        operatorApproved: { type: 'boolean', description: 'Set true only when the operator approved a gated channel action.' },
        userOptedIn: { type: 'boolean', description: 'Override the inferred opt-in gate for channels that require it.' },
      },
    },
  },
  {
    name: 'realtime_conversation_plan',
    description: 'Check whether a realtime conversation can start on one channel and get the exact missing gates. Use before claiming a live phone, Telegram, Matrix, WhatsApp, or Google Meet conversation is ready.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['phone', 'telegram', 'matrix', 'whatsapp', 'google_meet'], description: 'Channel to start.' },
        policyProvided: { type: 'boolean', description: 'True when a concrete phone mission policy exists.' },
        operatorApproved: { type: 'boolean', description: 'True only after explicit operator approval for gated channels.' },
        userOptedIn: { type: 'boolean', description: 'True only when the target user/chat/meeting has opted in or is already linked.' },
        transportConfigured: { type: 'boolean', description: 'Override inferred transport configuration, mainly for tests/future adapters.' },
        realtimeMediaConfigured: { type: 'boolean', description: 'Override inferred phone realtime-media capability.' },
        openaiRealtimeConfigured: { type: 'boolean', description: 'Override inferred OpenAI Realtime API key availability.' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'conversation_list',
    description: 'List live conversation sessions for the current agent. Use this to find active Telegram/phone sessions before sending or reading turns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'ended', 'failed'], description: 'Optional session status filter.' },
        channel: { type: 'string', enum: ['phone', 'telegram', 'matrix', 'whatsapp', 'google_meet'], description: 'Optional conversation channel filter.' },
        limit: { type: 'number', description: 'Maximum sessions to return (1-100, default 20).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
  {
    name: 'conversation_get',
    description: 'Read one live conversation session by id, including status, channel, peer, goal, and external transport reference.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Conversation session id.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'conversation_context',
    description: 'Read one live conversation session plus a compact transcript window in a single call. Use this after a wake message gives you a sessionId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Conversation session id.' },
        messageLimit: { type: 'number', description: 'Maximum transcript messages to return from the end of the session (1-200, default 50).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'conversation_start',
    description: 'Start a live conversation session. Telegram is executable now; phone starts a tracked phone mission; Matrix, WhatsApp, and Google Meet fail closed until adapters ship.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['phone', 'telegram', 'matrix', 'whatsapp', 'google_meet'], description: 'Conversation channel.' },
        chatId: { type: 'string', description: 'Telegram chat id. Alias: peer.' },
        peer: { type: 'string', description: 'Generic peer id: Telegram chat id, phone number, future Matrix room, etc.' },
        to: { type: 'string', description: 'Phone target number in E.164 format. Alias: peer.' },
        goal: { type: 'string', description: 'Conversation objective.' },
        task: { type: 'string', description: 'Phone task/objective. Alias: goal.' },
        subject: { type: 'string', description: 'Optional short session subject.' },
        initialMessage: { type: 'string', description: 'Optional first Telegram message to send immediately.' },
        policy: { type: 'object', description: 'Required for phone sessions: phone mission policy.' },
        policyPreset: { type: 'string', enum: ['safe_default', 'reservation', 'support'], description: 'Phone only: safe policy preset. Use this instead of raw policy for normal calls.' },
        regionAllowlist: { type: 'array', items: { type: 'string', enum: ['AT', 'DE', 'EU', 'WORLD'] }, description: 'Phone only: allowed dial regions.' },
        maxCallDurationSeconds: { type: 'integer', description: 'Phone only: positive call-duration cap. Server hard ceiling still applies.' },
        maxCostPerMission: { type: 'number', description: 'Phone only: non-negative mission cost cap. Server hard ceiling still applies.' },
        maxAttempts: { type: 'integer', description: 'Phone only: positive attempt cap. Server hard ceiling still applies.' },
        maxTimeShiftMinutes: { type: 'integer', description: 'Phone only: allowed appointment time shift before asking the operator.' },
        transcriptEnabled: { type: 'boolean', description: 'Phone only: defaults to true for safe presets.' },
        recordingEnabled: { type: 'boolean', description: 'Phone only: defaults to false and still requires transport support.' },
        voiceRuntime: { type: 'string', description: 'Phone only: optional voice-runtime provider id.' },
        voiceModel: { type: 'string', description: 'Phone only: optional voice model override.' },
        voice: { type: 'string', description: 'Phone only: optional voice character override.' },
        dryRun: { type: 'boolean', description: 'Phone only: create a mission/session without calling the carrier.' },
        operatorApproved: { type: 'boolean', description: 'Future gated channels only: explicit operator approval.' },
        userOptedIn: { type: 'boolean', description: 'Future opt-in channels only: explicit target opt-in.' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'conversation_send',
    description: 'Send one text turn into an active live conversation session. Currently executable for Telegram sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Conversation session id.' },
        text: { type: 'string', description: 'Message text to send.' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'conversation_messages',
    description: 'Read the transcript/message ledger for a conversation session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Conversation session id.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'conversation_end',
    description: 'End a live conversation session and mark it ended or failed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Conversation session id.' },
        status: { type: 'string', enum: ['ended', 'failed'], description: 'Terminal status (default: ended).' },
      },
      required: ['sessionId'],
    },
  },

  // --- Telegram Channel ---
  {
    name: 'telegram_setup',
    description: 'Configure the Telegram channel for this agent — register a bot token from @BotFather and link the chat(s) allowed to message the agent. The token is verified with Telegram and stored encrypted. Defaults to poll mode (call telegram_poll on a schedule); pass mode "webhook" with a public HTTPS webhookUrl + webhookSecret for push delivery.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        botToken: { type: 'string', description: 'Telegram bot API token from @BotFather (e.g. 123456789:AA...).' },
        operatorChatId: { type: 'string', description: 'The chat id of the operator — always allowed to message the agent and to answer ask_operator questions.' },
        allowedChatIds: { type: 'array', items: { type: 'string' }, description: 'Additional chat ids permitted to message the agent. An empty allow-list means only the operator chat can reach the agent (fail-closed).' },
        mode: { type: 'string', enum: ['poll', 'webhook'], description: 'Inbound transport: "poll" (default — pull updates with telegram_poll) or "webhook" (Telegram pushes updates).' },
        webhookUrl: { type: 'string', description: 'Webhook mode only: public HTTPS URL Telegram delivers updates to.' },
        webhookSecret: { type: 'string', description: 'Webhook mode only: shared secret echoed in the X-Telegram-Bot-Api-Secret-Token header (at least 16 chars, A-Z a-z 0-9 _ -).' },
      },
      required: ['botToken'],
    },
  },
  {
    name: 'telegram_config',
    description: 'Get the current Telegram channel configuration for this agent — whether it is enabled, the bot username, linked chats, and transport mode. Credentials are redacted.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'telegram_send',
    description: 'Send a Telegram message from this agent\'s bot to a chat. Requires the Telegram channel to be configured (telegram_setup) and enabled.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatId: { type: 'string', description: 'Target Telegram chat id.' },
        text: { type: 'string', description: 'Message text to send.' },
        replyToMessageId: { type: 'number', description: 'Optional Telegram message id to reply to.' },
      },
      required: ['chatId', 'text'],
    },
  },
  {
    name: 'telegram_messages',
    description: 'List stored Telegram messages (inbound and outbound) for this agent, newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Filter by direction.' },
        chatId: { type: 'string', description: 'Filter by chat id.' },
        limit: { type: 'number', description: 'Max messages (default: 20, max: 100).' },
        offset: { type: 'number', description: 'Skip messages (default: 0).' },
      },
    },
  },
  {
    name: 'telegram_poll',
    description: 'Pull and process new Telegram updates (poll-mode transport). Call this on a schedule when the channel is in poll mode to ingest new inbound messages and answer ask_operator questions sent from the operator chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'matrix_setup',
    description: 'Configure the Matrix channel for this agent. Stores a Matrix homeserver URL, access token, and allowed room ids; verifies the token with /account/whoami unless verify=false. Matrix E2EE rooms need a separate E2EE-capable bot runtime.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        homeserverUrl: { type: 'string', description: 'Matrix homeserver base URL, e.g. https://matrix.example.org' },
        accessToken: { type: 'string', description: 'Matrix access token for the bot/user. Stored encrypted and never returned.' },
        allowedRoomIds: { type: 'array', items: { type: 'string' }, description: 'Room ids the agent may read/send, e.g. !room:example.org' },
        operatorRoomId: { type: 'string', description: 'Optional operator room id; always allowed.' },
        userId: { type: 'string', description: 'Optional Matrix user id. Usually discovered via whoami.' },
        deviceId: { type: 'string', description: 'Optional Matrix device id. Usually discovered via whoami.' },
        verify: { type: 'boolean', description: 'Set false to skip Matrix /account/whoami verification.' },
      },
      required: ['homeserverUrl', 'accessToken'],
    },
  },
  {
    name: 'matrix_config',
    description: 'Show the current Matrix channel config with secrets redacted.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'matrix_send',
    description: 'Send a plain-text Matrix m.room.message to an allowed room.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        roomId: { type: 'string', description: 'Matrix room id, e.g. !room:example.org' },
        text: { type: 'string', description: 'Plain-text message body.' },
      },
      required: ['roomId', 'text'],
    },
  },
  {
    name: 'matrix_messages',
    description: 'List stored Matrix messages for this agent, newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Filter by direction.' },
        roomId: { type: 'string', description: 'Filter by Matrix room id.' },
        limit: { type: 'number', description: 'Max messages (default 20, max 100).' },
        offset: { type: 'number', description: 'Skip messages.' },
      },
    },
  },
  {
    name: 'matrix_poll',
    description: 'Poll Matrix /sync for allowed rooms and mirror inbound m.room.message events into active Matrix conversation sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Optional Matrix sync token override. Omit to use saved syncToken.' },
        timeoutMs: { type: 'number', description: 'Matrix /sync timeout in milliseconds, max 30000.' },
      },
    },
  },
  {
    name: 'call_phone_safe',
    description: [
      'Start a tracked outbound phone mission with a built-in safe policy preset. Prefer this for normal OpenClaw/Codex/Gemini phone tasks; use call_phone only when the operator supplied an exact raw policy JSON.',
      'The generated policy still forbids payment details and contract commitments, routes over-limit cost / sensitive personal data / unclear alternatives to the operator, enables transcripts by default, and disables recording by default.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Target phone number in E.164 format (e.g. +43123456789)' },
        task: { type: 'string', description: 'Concrete call objective, e.g. "reserve a table for two at 19:30"' },
        policyPreset: { type: 'string', enum: ['safe_default', 'reservation', 'support'], description: 'Safe policy preset. Defaults to safe_default.' },
        regionAllowlist: { type: 'array', items: { type: 'string', enum: ['AT', 'DE', 'EU', 'WORLD'] }, description: 'Allowed dial regions. Defaults to ["WORLD"].' },
        maxCallDurationSeconds: { type: 'integer', description: 'Positive call-duration cap. Server hard ceiling still applies.' },
        maxCostPerMission: { type: 'number', description: 'Non-negative mission cost cap. Server hard ceiling still applies.' },
        maxAttempts: { type: 'integer', description: 'Positive attempt cap. Server hard ceiling still applies.' },
        maxTimeShiftMinutes: { type: 'integer', description: 'Allowed appointment time shift before asking the operator.' },
        transcriptEnabled: { type: 'boolean', description: 'Defaults to true.' },
        recordingEnabled: { type: 'boolean', description: 'Defaults to false and still requires transport support.' },
        voiceRuntime: { type: 'string', description: 'Optional voice-runtime provider id (e.g. "openai", "grok").' },
        voiceModel: { type: 'string', description: 'Optional realtime voice model override.' },
        voice: { type: 'string', description: 'Optional voice character override.' },
        voiceRuntimeRef: { type: 'string', description: 'Optional external voice runtime/session reference.' },
        dryRun: { type: 'boolean', description: 'When true, store the mission without calling the provider.' },
      },
      required: ['to', 'task'],
    },
  },
  {
    name: 'call_phone',
    description: [
      'Start a tracked outbound phone mission. This is call-control only unless the configured transport reports realtime_media; risky decisions must be encoded in policy and may require the operator.',
      '',
      'POLICY SCHEMA — every field below is REQUIRED and the literal values shown are the ONLY accepted values (anything else returns `unsafe-confirm-policy` / `invalid-policy`). Do not guess synonyms ("abort", "never_ever", true) — use the literals exactly.',
      '',
      'Minimal valid policy (copy-paste, then adjust the cost / duration / regions to taste):',
      '{',
      '  "policyVersion": 1,',
      '  "regionAllowlist": ["WORLD"],',
      '  "maxCallDurationSeconds": 600,',
      '  "maxCostPerMission": 2.0,',
      '  "maxAttempts": 1,',
      '  "transcriptEnabled": true,',
      '  "recordingEnabled": false,',
      '  "confirmPolicy": {',
      '    "paymentDetails": "never",',
      '    "contractCommitment": "never",',
      '    "costOverLimit": "needs_operator",',
      '    "sensitivePersonalData": "needs_operator",',
      '    "unclearAlternative": "needs_operator"',
      '  },',
      '  "alternativePolicy": { "maxTimeShiftMinutes": 30 }',
      '}',
      '',
      'Field requirements (the validator is strict — use these EXACT names and types):',
      '  - policyVersion: the literal number 1 (NOT a string like "2025-01"). Required.',
      '  - maxCallDurationSeconds: positive integer (NOT "maxDurationSeconds"). Server caps it.',
      '  - maxCostPerMission: non-negative number, plain decimal (NOT "USD:2.00", NOT "maxCostUsd"). Server caps it.',
      '  - maxAttempts: positive integer. Server caps it.',
      '  - transcriptEnabled / recordingEnabled: boolean.',
      '',
      'confirmPolicy field values are FIXED enums:',
      '  - paymentDetails / contractCommitment: always "never" (the agent must never agree to pay or commit; recovering from a mistake costs the operator real money).',
      '  - costOverLimit / sensitivePersonalData / unclearAlternative: always "needs_operator" (route the decision back through ask_operator).',
      'regionAllowlist values: "AT" | "DE" | "EU" | "WORLD". Use "WORLD" for any US/global destination; the transport\'s supportedRegions must intersect this set or the call is blocked as transport-region-unsupported.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Target phone number in E.164 format (e.g. +15555550100)' },
        task: { type: 'string', description: 'Concrete call objective, e.g. "reserve a table for two at 19:30"' },
        policy: {
          type: 'object',
          description: 'Phone mission policy — see tool description for the minimal valid shape. All fields required.',
          properties: {
            policyVersion: { type: 'number', description: 'Must be the literal number 1 (no other value is accepted).' },
            regionAllowlist: {
              type: 'array',
              description: 'Regions the agent is allowed to dial. Must intersect the transport\'s supportedRegions.',
              items: { type: 'string', enum: ['AT', 'DE', 'EU', 'WORLD'] },
            },
            maxCallDurationSeconds: { type: 'integer', description: 'Hard cap on call duration in seconds, positive integer. Server enforces a ceiling.' },
            maxCostPerMission: { type: 'number', description: 'Cost cap in USD as a plain decimal (e.g. 2.0, not "USD:2.00"). Server enforces a ceiling.' },
            maxAttempts: { type: 'integer', description: 'Max redial attempts, positive integer. Server caps this.' },
            transcriptEnabled: { type: 'boolean' },
            recordingEnabled: { type: 'boolean' },
            confirmPolicy: {
              type: 'object',
              description: 'Risk-decision routing. Every field uses a FIXED literal — see tool description.',
              properties: {
                paymentDetails: { type: 'string', enum: ['never'], description: 'Must be "never".' },
                contractCommitment: { type: 'string', enum: ['never'], description: 'Must be "never".' },
                costOverLimit: { type: 'string', enum: ['needs_operator'], description: 'Must be "needs_operator".' },
                sensitivePersonalData: { type: 'string', enum: ['needs_operator'], description: 'Must be "needs_operator".' },
                unclearAlternative: { type: 'string', enum: ['needs_operator'], description: 'Must be "needs_operator".' },
              },
              required: ['paymentDetails', 'contractCommitment', 'costOverLimit', 'sensitivePersonalData', 'unclearAlternative'],
            },
            alternativePolicy: {
              type: 'object',
              properties: {
                maxTimeShiftMinutes: { type: 'integer', description: 'How far the agent may move a proposed appointment without re-asking the operator, non-negative integer.' },
              },
              required: ['maxTimeShiftMinutes'],
            },
            // v0.9.95 — voice-runtime + voice character per-call
            // overrides. All optional; if omitted, the agent's
            // persona frontmatter wins; otherwise the install
            // default; otherwise the provider default.
            voiceRuntime: {
              type: 'string',
              description: 'Optional voice-runtime provider id (e.g. "openai", "grok"). Beats agent persona + install default.',
            },
            voiceModel: {
              type: 'string',
              description: 'Optional model override (e.g. "gpt-realtime-mini", "grok-voice-fast").',
            },
            voice: {
              type: 'string',
              description: 'Optional voice character (e.g. "cedar", "ara", or a custom voice id). Validated against the runtime\'s catalogue; unknown names fall through to the provider default with a log warning.',
            },
          },
          required: [
            'policyVersion', 'regionAllowlist', 'maxCallDurationSeconds', 'maxCostPerMission', 'maxAttempts',
            'transcriptEnabled', 'recordingEnabled', 'confirmPolicy', 'alternativePolicy',
          ],
        },
        voiceRuntimeRef: { type: 'string', description: 'Optional external voice runtime/session reference for future realtime integration' },
        dryRun: { type: 'boolean', description: 'When true, store the mission without calling the provider' },
      },
      required: ['to', 'task', 'policy'],
    },
  },
  {
    name: 'call_status',
    description: 'Get one phone mission by id, or list recent phone missions when id is omitted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Phone mission id' },
        status: { type: 'string', description: 'Optional status filter when listing missions' },
        limit: { type: 'number', description: 'Max missions when listing (default: 20, max: 100)' },
        offset: { type: 'number', description: 'Skip missions when listing' },
      },
    },
  },
  {
    name: 'call_transcript',
    description: 'Read the transcript entries recorded for a phone mission.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Phone mission id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'call_cancel',
    description: 'Cancel a tracked phone mission in AgenticMail. Provider-side hangup is not guaranteed in this call-control slice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Phone mission id' },
      },
      required: ['id'],
    },
  },
  // v0.9.97 — operator-query inspection + answer-injection for live
  // calls. Lets the dispatcher (claudecode / codex) read pending
  // ask_operator queries on a live mission AND inject an answer
  // directly, so a verification-challenge mid-call (DOB, account #,
  // etc.) closes in sub-second through the existing bridge poll,
  // without redialing.
  {
    name: 'call_open_queries',
    description:
      'List PENDING ask_operator queries on a phone mission (or all of an agent\'s missions when id is omitted). Use this BEFORE assuming a verification-style message from the operator is a fresh chat question — if there\'s an open query, the operator is most likely answering it. Pair with call_answer_query to inject the answer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Phone mission id. Omit to scan all of your agent\'s missions for open queries.' },
      },
    },
  },
  {
    name: 'call_answer_query',
    description:
      'Inject an answer to a pending ask_operator query on a live phone call. The voice agent\'s next poll picks it up within ~3 seconds and relays the answer verbatim to the other party on the line. Use when the operator has provided info the call needs (DOB / account # / address / yes-or-no decision) — this beats redialing by a factor of 30× in wall-clock time and preserves the original call\'s context. If the mission was already terminated and the query auto-closed, this returns alreadyAnswered=true and is a no-op. When the call had already dropped, the answer arms a callback-on-disconnect that the scheduler dials a few seconds later with the answer baked into the continuation task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mission_id: { type: 'string', description: 'Phone mission id (oq_ ids are bound to one mission; you can get this from call_open_queries).' },
        query_id: { type: 'string', description: 'Operator-query id, e.g. "oq_abc-123…". From call_open_queries.' },
        answer: { type: 'string', description: 'The literal answer to relay back to the call (e.g. "11/26/1998", "Yes go ahead", "Approved up to $200"). The voice agent reads this verbatim to the other party.' },
      },
      required: ['mission_id', 'query_id', 'answer'],
    },
  },
  // ─── Media toolset ─────────────────────────────────────────────────
  //
  // Local, opt-in media tools (text-to-speech, image / video / audio
  // editing, probing, video understanding, voice cloning). They drive
  // external system binaries (ffmpeg, ffprobe, ImageMagick, whisper.cpp,
  // Python) that are NOT bundled. Each tool feature-detects the binary
  // it needs; when one is missing the call returns a clear, actionable
  // install hint instead of failing the server. Call media_capabilities
  // first to see what is available.
  {
    name: 'media_capabilities',
    description: 'Report which media binaries (ffmpeg, ffprobe, ImageMagick, whisper.cpp, Python, edge-tts) are installed and available. Media tools are opt-in — call this first to see what operations are possible before attempting them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        refresh: { type: 'boolean', description: 'Re-probe the binaries instead of using the cached result (e.g. after installing one).' },
      },
    },
  },
  {
    name: 'media_tts',
    description: 'Convert text to speech using Edge TTS (free, local — requires the optional node-edge-tts package). Returns an audio file path (OGG/Opus when ffmpeg is available, else MP3).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak.' },
        voice: { type: 'string', description: 'Preset name (guy, jenny, aria, davis, tony, ana, brian, emma, ryan, sonia, william, natasha) or a full Edge voice id.' },
        rate: { type: 'string', description: 'Speaking rate, e.g. "+20%" or "-10%".' },
        pitch: { type: 'string', description: 'Pitch shift, e.g. "+5Hz" or "-10Hz".' },
      },
      required: ['text'],
    },
  },
  {
    name: 'media_tts_voices',
    description: 'List the available text-to-speech voice presets.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'media_image_edit',
    description: 'Edit an image: resize, crop, rotate, convert format, compress, overlay text, flip, blur, sharpen, grayscale. Requires ImageMagick.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: 'Absolute path to the input image.' },
        action: { type: 'string', enum: ['resize', 'crop', 'rotate', 'convert', 'compress', 'text_overlay', 'flip', 'blur', 'sharpen', 'grayscale'], description: 'The edit action to perform.' },
        width: { type: 'number', description: 'Target width in pixels (resize/crop).' },
        height: { type: 'number', description: 'Target height in pixels (resize/crop).' },
        angle: { type: 'number', description: 'Rotation angle in degrees (rotate).' },
        format: { type: 'string', description: 'Output format: png, jpg, webp, gif, bmp, tiff (convert).' },
        quality: { type: 'number', description: 'JPEG/WebP quality 1-100 (compress). Default: 80.' },
        text: { type: 'string', description: 'Text to overlay (text_overlay).' },
        position: { type: 'string', description: 'Text position: north, south, center, northeast, etc. Default: south.' },
        fontSize: { type: 'number', description: 'Font size in points (text_overlay). Default: 36.' },
        fontColor: { type: 'string', description: 'Text colour (text_overlay). Default: white.' },
        blurRadius: { type: 'number', description: 'Blur radius (blur). Default: 5.' },
        direction: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Flip direction. Default: horizontal.' },
        offsetX: { type: 'number', description: 'Crop X offset from top-left. Default: 0.' },
        offsetY: { type: 'number', description: 'Crop Y offset from top-left. Default: 0.' },
      },
      required: ['input', 'action'],
    },
  },
  {
    name: 'media_video_edit',
    description: 'Edit a video. Basic: trim, extract_frame, extract_frames, convert, gif, compress, resize, add_audio, remove_audio, speed. Cinematic: color_grade, transition, text_overlay, picture_in_picture, split_screen, ken_burns, slow_motion, watermark, concatenate, audio_mix, auto_caption. Requires ffmpeg (ImageMagick for text/captions, whisper.cpp for auto_caption).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: 'Absolute path to the input video (or image for ken_burns). Not required for concatenate.' },
        action: { type: 'string', enum: ['trim', 'extract_frame', 'extract_frames', 'convert', 'gif', 'compress', 'resize', 'add_audio', 'remove_audio', 'speed', 'color_grade', 'transition', 'text_overlay', 'picture_in_picture', 'split_screen', 'ken_burns', 'slow_motion', 'watermark', 'concatenate', 'audio_mix', 'auto_caption'], description: 'The edit action.' },
        start: { type: 'string', description: 'Start time: "00:00:05" or "5".' },
        end: { type: 'string', description: 'End time: "00:00:15" or "15".' },
        duration: { type: 'string', description: 'Duration in seconds.' },
        timestamp: { type: 'string', description: 'Timestamp for single frame extraction.' },
        interval: { type: 'number', description: 'Seconds between extracted frames. Default: 1.' },
        format: { type: 'string', description: 'Output format: mp4, webm, mov, avi, mkv.' },
        width: { type: 'number', description: 'Target width.' },
        height: { type: 'number', description: 'Target height.' },
        fps: { type: 'number', description: 'Frame rate.' },
        crf: { type: 'number', description: 'Quality 0-51, lower is better. Default: 28.' },
        audioPath: { type: 'string', description: 'Path to an audio file (add_audio, audio_mix).' },
        speedFactor: { type: 'number', description: 'Speed multiplier: 0.5 = half, 2 = double.' },
        secondInput: { type: 'string', description: 'Second video/image path (transition, picture_in_picture, split_screen).' },
        transitionType: { type: 'string', description: 'Transition type: fade, wipeleft, slideright, circlecrop, etc. Default: fade.' },
        transitionDuration: { type: 'number', description: 'Transition duration in seconds. Default: 1.' },
        text: { type: 'string', description: 'Text for text_overlay.' },
        fontSize: { type: 'number', description: 'Font size for text_overlay. Default: 72.' },
        fontColor: { type: 'string', description: 'Text colour. Default: white.' },
        textPosition: { type: 'string', description: 'Text position: center, top, bottom, top-left, top-right, bottom-left, bottom-right.' },
        textBg: { type: 'string', description: 'Text background colour with opacity, e.g. "black@0.5".' },
        textStart: { type: 'string', description: 'When text appears (seconds). Default: 0.' },
        textEnd: { type: 'string', description: 'When text disappears (seconds).' },
        overlayOpacity: { type: 'number', description: 'Watermark opacity 0.0-1.0. Default: 0.7.' },
        overlayScale: { type: 'number', description: 'Watermark scale 0.0-1.0. Default: 0.2.' },
        watermarkPosition: { type: 'string', description: 'Watermark position: top-left, top-right, bottom-left, bottom-right, center.' },
        watermarkPath: { type: 'string', description: 'Path to the watermark/logo image.' },
        pipWidth: { type: 'number', description: 'Picture-in-picture overlay width. Default: 320.' },
        pipPosition: { type: 'string', description: 'PiP position: top-left, top-right, bottom-left, bottom-right.' },
        splitDirection: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Split-screen direction. Default: horizontal.' },
        zoomDirection: { type: 'string', description: 'Ken Burns: zoom_in, zoom_out, pan_left, pan_right, pan_up, pan_down.' },
        zoomDuration: { type: 'number', description: 'Ken Burns output duration in seconds. Default: 5.' },
        zoomFactor: { type: 'number', description: 'Ken Burns zoom factor 1.0-3.0. Default: 1.5.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths (concatenate).' },
        bgVolume: { type: 'string', description: 'Background audio volume for audio_mix. Default: 0.3.' },
        fgVolume: { type: 'string', description: 'Foreground audio volume for audio_mix. Default: 1.0.' },
        colorPreset: { type: 'string', description: 'Colour grade preset: warm, cool, vintage, cinematic, dramatic, bleach, noir, vivid, muted, golden_hour.' },
        lutPath: { type: 'string', description: 'Path to a .cube LUT file for color_grade.' },
        captionColor: { type: 'string', description: 'Auto-caption text colour. Default: white.' },
        captionFontSize: { type: 'number', description: 'Auto-caption font size. Default: auto-scaled.' },
        whisperModel: { type: 'string', description: 'Absolute path to a whisper.cpp model file (.bin) — required for auto_caption.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'media_audio_edit',
    description: 'Edit audio: trim, convert format, merge files, adjust volume, change speed, extract from video, reverse, fade in/out. Requires ffmpeg.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: 'Absolute path to the input audio (or video for extract). Not required for merge.' },
        action: { type: 'string', enum: ['trim', 'convert', 'merge', 'volume', 'speed', 'extract', 'reverse', 'fade'], description: 'The edit action.' },
        start: { type: 'string', description: 'Start time (trim): "00:00:05" or "5".' },
        end: { type: 'string', description: 'End time (trim): "00:00:15".' },
        duration: { type: 'string', description: 'Duration (trim): "10".' },
        format: { type: 'string', description: 'Output format: mp3, wav, ogg, flac, aac, m4a (convert/extract).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to merge (merge).' },
        volume: { type: 'string', description: 'Volume: "1.5" (150%), "0.5" (50%), or "10dB", "-5dB".' },
        speedFactor: { type: 'number', description: 'Speed: 0.5 = half, 2 = double (speed).' },
        fadeType: { type: 'string', enum: ['in', 'out', 'both'], description: 'Fade direction (fade).' },
        fadeDuration: { type: 'number', description: 'Fade duration in seconds (fade). Default: 3.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'media_info',
    description: 'Get metadata about any media file: duration, resolution, codec, bitrate, channels, etc. Requires ffprobe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: 'Absolute path to the media file.' },
      },
      required: ['input'],
    },
  },
  {
    name: 'media_video_understand',
    description: 'Analyse a video before editing it. Extracts frames at intervals and (when a whisper model is supplied) transcribes the audio, returning a structured timeline of what is shown and said. Requires ffmpeg; transcription additionally needs whisper.cpp + a model file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: 'Absolute path to the video file.' },
        frameInterval: { type: 'number', description: 'Seconds between extracted frames. Default: 3.' },
        maxFrames: { type: 'number', description: 'Maximum number of frames to extract. Default: 30.' },
        whisperModel: { type: 'string', description: 'Absolute path to a whisper.cpp model file (.bin). When supplied, the audio is transcribed and merged into the timeline.' },
      },
      required: ['input'],
    },
  },
  {
    name: 'media_voice_clone',
    description: 'Synthesise speech in a reference voice using F5-TTS. Requires a Python interpreter with the f5-tts and soundfile packages. You MUST supply a reference audio sample and its transcript — there is no built-in voice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak in the cloned voice. Keep it short (~15 words) for best quality.' },
        refAudio: { type: 'string', description: 'Absolute path to the reference audio sample (required).' },
        refText: { type: 'string', description: 'Transcript of the reference audio (required).' },
        pythonBin: { type: 'string', description: 'Optional absolute path to a Python interpreter with F5-TTS installed.' },
        device: { type: 'string', description: 'Compute device for F5-TTS: cpu, cuda, mps. Default: cpu.' },
      },
      required: ['text', 'refAudio', 'refText'],
    },
  },
  // ─── Persistent agent memory ───────────────────────────────────────
  {
    name: 'memory',
    description: 'Your persistent, long-term memory — knowledge that survives across every conversation, like a human employee learning on the job. Use `set` to remember something durable (a preference, a fact, a correction, a learned skill); `search` to recall by topic; `list` to browse; `get` to read one entry; `delete` to forget. Memory is private to you and persists forever unless it decays from disuse or you delete it. Store things you would want to still know weeks from now — not transient task state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['set', 'get', 'search', 'list', 'delete'], description: 'set | get | search | list | delete' },
        content: { type: 'string', description: 'set: the thing to remember (plain text).' },
        title: { type: 'string', description: 'set: a short title/label for the memory (optional — derived from content if omitted).' },
        category: { type: 'string', enum: ['knowledge', 'interaction_pattern', 'preference', 'correction', 'skill', 'context', 'reflection', 'session_learning', 'system_notice'], description: 'set: memory category (default: context).' },
        importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'set: how important this is (default: normal). critical entries never decay.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'set: optional tags.' },
        query: { type: 'string', description: 'search: the topic to recall.' },
        id: { type: 'string', description: 'get | delete: the memory entry id.' },
        limit: { type: 'number', description: 'search | list: max entries to return (default 50).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory_reflect',
    description: 'Record a self-reflection into your persistent memory — an insight or lesson you want to carry forward (stored as a high-confidence `reflection` entry). Use this at the end of a task or conversation to capture what you learned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The reflection / insight to remember.' },
        title: { type: 'string', description: 'Optional short title.' },
        importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Default: normal.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_context',
    description: 'Get a ranked markdown digest of your most relevant persistent memory — what you would want loaded into your working context right now. Optionally pass a `query` to bias the digest toward a topic. This is the same memory block a voice/phone session injects so you act with full continuity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Optional topic to focus the digest on.' },
        maxTokens: { type: 'number', description: 'Approximate size budget (default 1500).' },
      },
    },
  },
  {
    name: 'memory_stats',
    description: 'Get aggregate statistics about your persistent memory — total entries, breakdown by category / importance / source, and average confidence.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  // ─── Skill library — load real-world phone-call playbooks ──────────
  // The skill library is a JSON-on-disk collection of structured
  // playbooks ("negotiate a bill reduction", "handle a debt collector
  // call", "book a restaurant reservation") — each one a complete
  // bundle of principles, tactics, scripted phrases, boundaries, and
  // exit strategies. Agents load them on demand DURING a call when
  // they hit a situation they don't have ambient knowledge of: pause
  // the call ("hold on one moment"), `skill_search` for relevant
  // ones, `skill_load` the best match, then resume with the loaded
  // skill grounding the next turn.
  {
    name: 'skill_list',
    description: 'List available phone-call skill playbooks, optionally filtered by category (e.g. "negotiation", "reservations", "debt-collection") or tag. Returns summaries (id, name, description, tags) — call `skill_load` with the id to get the full playbook.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category. Valid: negotiation, customer-service, reservations, medical-admin, legal-admin, finance-admin, real-estate, travel, subscription, home-services, social, civic, employment, debt-collection, other.' },
        tag: { type: 'string', description: 'Filter by a single tag (case-insensitive).' },
      },
    },
  },
  {
    name: 'skill_search',
    description: 'Fuzzy-search skills by free-text query against name, description, tags, principles, phrases, and tactic scripts. Use this DURING a call when you need a playbook for the situation you just hit ("the rep is asking for a settlement number — what do I do?"). Returns ranked summaries; load the top match with `skill_load`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text query, e.g. "rep wants me to commit to payment" or "restaurant fully booked".' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_load',
    description: 'Load the FULL skill playbook by id. Returns the complete JSON document: principles, scripted phrases, tactic priority list, boundaries, success/failure signals, exit strategy. Use the response to ground your next turns on the call — the playbook should drive your phrasing, tactic order, and exit decisions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Skill id (lowercase-hyphenated, e.g. "negotiate-bill-reduction").' },
      },
      required: ['id'],
    },
  },
  // ─── Meta-tools for tiered tool loading ────────────────────────────
  // These exist so a Claude Code subagent (or any host that wants to keep
  // its spawn context small) can load this MCP server with only a handful
  // of pre-declared tools and still reach the full 60+ tool surface on
  // demand. See tool-catalog.ts for the categorisation behind this.
  {
    name: 'request_tools',
    description: 'Discover AgenticMail tools that are NOT already in your loaded tool list. Returns a text catalogue grouped by set (mail_extras, sms, agent_coord, …) with each tool name and its schema summary. After calling this, use `invoke` to call any tool by name. Optional filters: `query` (substring match on tool name/description) or `sets` (return only the named sets).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on tool name or description (e.g. "signature", "voice").',
        },
        sets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the output to these set names (e.g. ["sms", "mail_extras"]). See SET_DESCRIPTIONS for valid names.',
        },
      },
    },
  },
  {
    name: 'invoke',
    description: 'Call ANY AgenticMail tool by name with structured args — including tools not in your pre-loaded tool list. Use after `request_tools` to discover the right tool. Pass `_account` either at the top level OR inside `args`; either works. Example: invoke({ tool: "manage_signatures", args: { action: "create", name: "default", body: "—\\nFola" }, _account: "Fola" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool: {
          type: 'string',
          description: 'The AgenticMail tool name to call (e.g. "manage_signatures", "sms_send"). See request_tools for the full catalogue.',
        },
        args: {
          type: 'object',
          description: 'Arguments for the target tool. Same shape you would pass if calling the tool directly.',
        },
      },
      required: ['tool'],
    },
  },
];

// Tools that require master key access
const MASTER_KEY_TOOLS = new Set([
  'create_account', 'setup_email_relay', 'setup_email_domain',
  'setup_guide', 'setup_gmail_alias', 'setup_payment',
  'purchase_domain', 'check_gateway_status', 'send_test_email',
  'delete_agent', 'deletion_reports', 'cleanup_agents',
  'stop_agent', 'resume_agent',
]);

// ─── Inline Inbound Security Advisory ─────────────────────────────────

const MCP_EXEC_EXTS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.scr', '.com', '.vbs', '.js', '.wsf', '.hta', '.cpl', '.jar', '.app', '.dmg', '.run']);
const MCP_ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.cab', '.iso']);

function mcpBuildSecuritySection(security: any, attachments: any[]): string {
  const lines: string[] = [];

  if (security?.isSpam) {
    lines.push(`[SPAM] Score: ${security.score}, Category: ${security.topCategory ?? security.category} — This email was flagged as spam`);
  } else if (security?.isWarning) {
    lines.push(`[WARNING] Score: ${security.score}, Category: ${security.topCategory ?? security.category} — Treat with caution`);
  }

  if (security?.sanitized && security.sanitizeDetections?.length) {
    lines.push(`Content sanitized: ${security.sanitizeDetections.map((d: any) => d.type).join(', ')}`);
  }

  if (attachments?.length) {
    for (const att of attachments) {
      const name = att.filename ?? 'unknown';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
      const parts = lower.split('.');
      if (parts.length > 2 && MCP_EXEC_EXTS.has('.' + parts[parts.length - 1])) {
        lines.push(`  [CRITICAL] "${name}": DOUBLE EXTENSION — Disguised executable`);
      } else if (MCP_EXEC_EXTS.has(ext)) {
        lines.push(`  [HIGH] "${name}": EXECUTABLE file — DO NOT open or trust`);
      } else if (MCP_ARCHIVE_EXTS.has(ext)) {
        lines.push(`  [MEDIUM] "${name}": ARCHIVE — May contain malware`);
      } else if (ext === '.html' || ext === '.htm') {
        lines.push(`  [HIGH] "${name}": HTML file — May contain phishing/scripts`);
      }
    }
  }

  const matches: Array<{ ruleId: string }> = security?.spamMatches ?? security?.matches ?? [];
  for (const m of matches) {
    if (m.ruleId === 'ph_mismatched_display_url') lines.push('  [!] Mismatched display URL — PHISHING');
    else if (m.ruleId === 'ph_data_uri') lines.push('  [!] data: URI in link — may execute code');
    else if (m.ruleId === 'ph_homograph') lines.push('  [!] Homograph domain — mimicking legitimate domain');
    else if (m.ruleId === 'ph_spoofed_sender') lines.push('  [!] Spoofed brand sender');
    else if (m.ruleId === 'de_webhook_exfil') lines.push('  [!] Suspicious webhook URL — data exfiltration risk');
    else if (m.ruleId === 'pi_invisible_unicode') lines.push('  [!] Invisible unicode — hidden instructions');
  }

  if (lines.length === 0) return '';
  return `\n--- Security ---\n${lines.join('\n')}`;
}

// ─── Inline Outbound Guard (defense-in-depth) ────────────────────────

interface McpOutboundWarning { category: string; severity: 'high' | 'medium'; ruleId: string; description: string; match: string; }
interface McpOutboundScanResult { warnings: McpOutboundWarning[]; blocked: boolean; summary: string; }

const MCP_OB_RULES: Array<{ id: string; cat: string; sev: 'high' | 'medium'; desc: string; test: (t: string) => string | null; }> = [
  // PII
  { id: 'ob_ssn', cat: 'pii', sev: 'high', desc: 'SSN', test: t => { const m = t.match(/\b\d{3}-\d{2}-\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_ssn_obfuscated', cat: 'pii', sev: 'high', desc: 'SSN (obfuscated)', test: t => {
    const m1 = t.match(/\b\d{3}\.\d{2}\.\d{4}\b/); if (m1) return m1[0];
    const m2 = t.match(/\b\d{3}\s\d{2}\s\d{4}\b/); if (m2) return m2[0];
    const m3 = t.match(/\b(?:ssn|social\s*security|soc\s*sec)\s*(?:#|number|num|no)?[\s:]*\d{9}\b/i); if (m3) return m3[0];
    return null;
  } },
  { id: 'ob_credit_card', cat: 'pii', sev: 'high', desc: 'Credit card', test: t => { const m = t.match(/\b(?:\d{4}[-\s]?){3}\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_phone', cat: 'pii', sev: 'medium', desc: 'Phone number', test: t => { const m = t.match(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_bank_routing', cat: 'pii', sev: 'high', desc: 'Bank routing/account', test: t => { const m = t.match(/\b(?:routing|account|acct)\s*(?:#|number|num|no)?[\s:]*\d{6,17}\b/i); return m ? m[0] : null; } },
  { id: 'ob_drivers_license', cat: 'pii', sev: 'high', desc: "Driver's license", test: t => { const m = t.match(/\b(?:driver'?s?\s*(?:license|licence|lic)|DL)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9][A-Z0-9-]{4,14}\b/i); return m ? m[0] : null; } },
  { id: 'ob_dob', cat: 'pii', sev: 'medium', desc: 'Date of birth', test: t => { const m = t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/i) ?? t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i); return m ? m[0] : null; } },
  { id: 'ob_passport', cat: 'pii', sev: 'high', desc: 'Passport number', test: t => { const m = t.match(/\b(?:passport)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9]{6,12}\b/i); return m ? m[0] : null; } },
  { id: 'ob_tax_id', cat: 'pii', sev: 'high', desc: 'Tax ID / EIN', test: t => { const m = t.match(/\b(?:EIN|TIN|tax\s*(?:id|identification)|employer\s*id)\s*(?:#|number|num|no)?[\s:]*\d{2}-?\d{7}\b/i); return m ? m[0] : null; } },
  { id: 'ob_itin', cat: 'pii', sev: 'high', desc: 'ITIN', test: t => { const m = t.match(/\bITIN\s*(?:#|number|num|no)?[\s:]*9\d{2}-?\d{2}-?\d{4}\b/i); return m ? m[0] : null; } },
  { id: 'ob_medicare', cat: 'pii', sev: 'high', desc: 'Medicare/Medicaid ID', test: t => { const m = t.match(/\b(?:medicare|medicaid|health\s*(?:insurance|plan))\s*(?:#|id|number|num|no)?[\s:]*[A-Z0-9]{8,14}\b/i); return m ? m[0] : null; } },
  { id: 'ob_immigration', cat: 'pii', sev: 'high', desc: 'Immigration A-number', test: t => { const m = t.match(/\b(?:A-?number|alien\s*(?:#|number|num|no)?|USCIS)\s*[:=\s]*A?-?\d{8,9}\b/i); return m ? m[0] : null; } },
  { id: 'ob_pin', cat: 'pii', sev: 'medium', desc: 'PIN code', test: t => { const m = t.match(/\b(?:PIN|pin\s*code|pin\s*number)\s*[:=]\s*\d{4,8}\b/i); return m ? m[0] : null; } },
  { id: 'ob_security_qa', cat: 'pii', sev: 'medium', desc: 'Security Q&A', test: t => { const m = t.match(/\b(?:security\s*question|secret\s*question|challenge\s*question)\s*[:=]?\s*.{5,80}(?:answer|response)\s*[:=]?\s*\S+/i) ?? t.match(/\b(?:security\s*(?:answer|response)|mother'?s?\s*maiden\s*name|first\s*pet'?s?\s*name)\s*[:=]?\s*\S{2,}/i); return m ? m[0].slice(0, 80) : null; } },
  // Financial
  { id: 'ob_iban', cat: 'pii', sev: 'high', desc: 'IBAN', test: t => { const m = t.match(/\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/); return m ? m[0] : null; } },
  { id: 'ob_swift', cat: 'pii', sev: 'medium', desc: 'SWIFT/BIC', test: t => { const m = t.match(/\b(?:SWIFT|BIC|swift\s*code|bic\s*code)\s*[:=]?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/i); return m ? m[0] : null; } },
  { id: 'ob_crypto_wallet', cat: 'pii', sev: 'high', desc: 'Crypto wallet', test: t => { const m = t.match(/\b(?:bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/); return m ? m[0] : null; } },
  { id: 'ob_wire_transfer', cat: 'pii', sev: 'high', desc: 'Wire transfer', test: t => { if (/\bwire\s+(?:transfer|funds?|payment|to)\b/i.test(t) && /\b(?:routing|account|swift|iban|beneficiary)\b/i.test(t)) return 'wire transfer instructions'; return null; } },
  // Credentials
  { id: 'ob_api_key', cat: 'credential', sev: 'high', desc: 'API key', test: t => { const m = t.match(/\b(?:sk_|pk_|rk_|api_key_|apikey_)[a-zA-Z0-9_]{20,}\b/i) ?? t.match(/\b(?:sk-(?:proj|ant|live|test)-)[a-zA-Z0-9_-]{20,}/); return m ? m[0] : null; } },
  { id: 'ob_aws_key', cat: 'credential', sev: 'high', desc: 'AWS key', test: t => { const m = t.match(/\bAKIA[A-Z0-9]{16}\b/); return m ? m[0] : null; } },
  { id: 'ob_password_value', cat: 'credential', sev: 'high', desc: 'Password', test: t => { const m = t.match(/\bp[a@4]ss(?:w[o0]rd)?\s*[:=]\s*\S+/i); return m ? m[0] : null; } },
  { id: 'ob_private_key', cat: 'credential', sev: 'high', desc: 'Private key', test: t => { const m = t.match(/-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i); return m ? m[0] : null; } },
  { id: 'ob_bearer_token', cat: 'credential', sev: 'high', desc: 'Bearer token', test: t => { const m = t.match(/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_connection_string', cat: 'credential', sev: 'high', desc: 'Connection string', test: t => { const m = t.match(/\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s]+/i); return m ? m[0] : null; } },
  { id: 'ob_github_token', cat: 'credential', sev: 'high', desc: 'GitHub token', test: t => { const m = t.match(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[a-zA-Z0-9_]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_stripe_key', cat: 'credential', sev: 'high', desc: 'Stripe key', test: t => { const m = t.match(/\b(?:sk_live_|pk_live_|rk_live_|sk_test_|pk_test_|rk_test_)[a-zA-Z0-9]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_jwt', cat: 'credential', sev: 'high', desc: 'JWT token', test: t => { const m = t.match(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_webhook_url', cat: 'credential', sev: 'high', desc: 'Webhook URL', test: t => { const m = t.match(/\bhttps?:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|[\w.-]+\.webhook\.site)\/\S+/i); return m ? m[0] : null; } },
  { id: 'ob_env_block', cat: 'credential', sev: 'high', desc: '.env block', test: t => { const lines = t.split('\n'); let c = 0, f = ''; for (const l of lines) { if (/^[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(l.trim())) { if (++c === 1) f = l.trim(); if (c >= 3) return f + '...'; } else if (l.trim() !== '' && !l.trim().startsWith('#')) c = 0; } return null; } },
  { id: 'ob_seed_phrase', cat: 'credential', sev: 'high', desc: 'Seed/recovery phrase', test: t => { const m = t.match(/\b(?:seed\s*phrase|recovery\s*phrase|mnemonic|backup\s*words)\s*[:=]?\s*.{10,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_2fa_codes', cat: 'credential', sev: 'high', desc: '2FA codes', test: t => { const m = t.match(/\b(?:2fa|two.factor|backup|recovery)\s*(?:code|key)s?\s*[:=]?\s*(?:[A-Z0-9]{4,8}[\s,;-]+){2,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_credential_pair', cat: 'credential', sev: 'high', desc: 'Username+password pair', test: t => { const m = t.match(/\b(?:user(?:name)?|email|login)\s*[:=]\s*\S+[\s,;]+(?:password|passwd|pass|pwd)\s*[:=]\s*\S+/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_oauth_token', cat: 'credential', sev: 'high', desc: 'OAuth token', test: t => { const m = t.match(/\b(?:access_token|refresh_token|oauth_token)\s*[:=]\s*[a-zA-Z0-9_\-.]{20,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_vpn_creds', cat: 'credential', sev: 'high', desc: 'VPN credentials', test: t => { const m = t.match(/\b(?:vpn|openvpn|wireguard|ipsec)\b.*\b(?:password|key|secret|credential|pre.?shared)\b/i); return m ? m[0].slice(0, 80) : null; } },
  // System internals
  { id: 'ob_private_ip', cat: 'system_internal', sev: 'medium', desc: 'Private IP', test: t => { const m = t.match(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/); return m ? m[0] : null; } },
  { id: 'ob_file_path', cat: 'system_internal', sev: 'medium', desc: 'File path', test: t => { const m = t.match(/(?:\/Users\/|\/home\/|\/etc\/|\/var\/|C:\\Users\\|C:\\Windows\\)\S+/i); return m ? m[0] : null; } },
  { id: 'ob_env_variable', cat: 'system_internal', sev: 'medium', desc: 'Env variable', test: t => { const m = t.match(/\b[A-Z][A-Z0-9_]{2,}(?:_URL|_KEY|_SECRET|_TOKEN|_PASSWORD|_HOST|_PORT|_DSN)\s*=\s*\S+/); return m ? m[0] : null; } },
  // Owner privacy
  { id: 'ob_owner_info', cat: 'owner_privacy', sev: 'high', desc: 'Owner info', test: t => { const m = t.match(/\b(?:my\s+)?owner'?s?\s+(?:name|address|phone|email|password|social|ssn|credit\s+card|bank|account)\b/i); return m ? m[0] : null; } },
  { id: 'ob_personal_reveal', cat: 'owner_privacy', sev: 'high', desc: 'Personal reveal', test: t => { const m = t.match(/\b(?:the\s+person\s+who\s+(?:owns|runs|operates)\s+me|my\s+(?:human|creator|operator)\s+(?:is|lives|works|named))\b/i); return m ? m[0] : null; } },
];

const MCP_OB_HIGH_RISK_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.env', '.credentials', '.keystore', '.jks', '.p8']);
const MCP_OB_MEDIUM_RISK_EXT = new Set(['.db', '.sqlite', '.sqlite3', '.sql', '.csv', '.tsv', '.json', '.yml', '.yaml', '.conf', '.config', '.ini']);

function mcpStripHtml(h: string): string { return h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' '); }

function mcpScanOutbound(to: string | string[], subject?: string, text?: string, html?: string, attachments?: Array<{ filename?: string }>): McpOutboundScanResult {
  const recipients = Array.isArray(to) ? to : [to];
  if (recipients.every(r => r.endsWith('@localhost'))) return { warnings: [], blocked: false, summary: '' };
  const warnings: McpOutboundWarning[] = [];
  const combined = [subject ?? '', text ?? '', html ? mcpStripHtml(html) : ''].join('\n');
  if (combined.trim()) {
    for (const rule of MCP_OB_RULES) {
      const match = rule.test(combined);
      if (match) warnings.push({ category: rule.cat, severity: rule.sev, ruleId: rule.id, description: rule.desc, match: match.length > 80 ? match.slice(0, 80) + '...' : match });
    }
  }
  if (attachments?.length) {
    for (const att of attachments) {
      const name = att.filename ?? '';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
      if (MCP_OB_HIGH_RISK_EXT.has(ext)) warnings.push({ category: 'attachment_risk', severity: 'high', ruleId: 'ob_sensitive_file', description: `Sensitive file: ${ext}`, match: name });
      else if (MCP_OB_MEDIUM_RISK_EXT.has(ext)) warnings.push({ category: 'attachment_risk', severity: 'medium', ruleId: 'ob_data_file', description: `Data file: ${ext}`, match: name });
    }
  }
  const hasHigh = warnings.some(w => w.severity === 'high');
  return {
    warnings, blocked: hasHigh,
    summary: warnings.length === 0 ? '' : hasHigh
      ? `OUTBOUND GUARD BLOCKED: ${warnings.length} warning(s) with HIGH severity. Email NOT sent.`
      : `OUTBOUND GUARD: ${warnings.length} warning(s). Review before sending.`,
  };
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  // Anonymous telemetry — fire and forget
  recordToolCall(name);
  const useMaster = MASTER_KEY_TOOLS.has(name);

  // Per-call identity override: when the caller passes `_account: "Fola"`,
  // resolve it to that agent's apiKey and run the whole dispatch inside an
  // AsyncLocalStorage context so deep inside apiRequest we can grab the
  // right key without threading it through every tool handler manually.
  //
  // Resolution path: in-memory cache → master-keyed lookup of /accounts
  // (if MASTER_KEY is set). The lookup is what lets dynamically-created
  // accounts (e.g. workers provisioned by the dispatcher) be addressable
  // immediately, without any restart-the-MCP-server dance.
  //
  // Unknown / missing _account → null, which falls back to the default key.
  const requestedAccount = typeof args?._account === 'string' ? args._account.toLowerCase() : null;
  let accountKey: string | null = null;
  if (requestedAccount) {
    accountKey = await resolveAccountKey(requestedAccount);
    if (!accountKey) {
      // Soft warning — we don't reject the call. A typo'd or actually
      // nonexistent account silently falls back to the default identity,
      // which is the common foot-gun when wiring up new agents.
      console.warn(`[agenticmail-mcp] _account="${requestedAccount}" did not resolve to a known account; falling back to the default identity.`);
    }
  }

  if (process.env.AGENTICMAIL_MCP_DEBUG) {
    // Same redaction policy as apiRequest above — `ak_***` shape
    // preserves the diagnostic signal without leaking the secret.
    console.error(`[mcp-debug] handleToolCall name=${name} requested=${requestedAccount ?? 'none'} accountKey=${accountKey ? redactSecret(accountKey) : 'null'} ACCOUNT_KEYS.size=${ACCOUNT_KEYS.size}`);
  }
  return toolCallContext.run({ apiKey: accountKey }, () => dispatchToolCall(name, args, useMaster));
}

async function dispatchToolCall(name: string, args: Record<string, unknown>, useMaster: boolean): Promise<string> {
  switch (name) {
    case 'send_email': {
      const sendBody: Record<string, unknown> = {
        to: args.to,
        subject: args.subject,
        text: args.text ?? '',
        html: args.html,
        cc: args.cc,
        inReplyTo: args.inReplyTo,
        references: args.references,
      };
      if (Array.isArray(args.attachments) && args.attachments.length > 0) {
        sendBody.attachments = (args.attachments as any[]).map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          ...(a.encoding ? { encoding: a.encoding } : {}),
        }));
      }
      // Wake-allowlist: forward as-is. The API normalises strings/arrays
      // into a real array, sets the X-AgenticMail-Wake header on the
      // outgoing mail, and surfaces the list in the SSE event so the
      // dispatcher can decide which recipients deserve a host turn.
      // Empty array means "wake nobody"; absent means "wake everyone CC'd"
      // (the default backwards-compatible behaviour).
      if (args.wake !== undefined) {
        sendBody.wake = args.wake;
      }
      const result = await apiRequest('POST', '/mail/send', sendBody);

      // Check if API held the email for review
      if (result?.blocked && result?.pendingId) {
        scheduleFollowUp(result.pendingId, String(args.to), String(args.subject || '(no subject)'), makePendingCheck(result.pendingId));
        return `Email NOT sent — blocked by outbound guard.\n${result.summary}\n\nPending ID: ${result.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the email was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this email is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Email sent successfully. Message ID: ${result?.messageId ?? 'unknown'}`;
      if (result?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n[WARNING] ${result.outboundWarnings.length} potential issue(s):\n${result.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}: ${w.match}`).join('\n')}`;
      }
      return response;
    }

    case 'list_inbox': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const result = await apiRequest('GET', `/mail/inbox?limit=${limit}&offset=${offset}`);
      if (!result?.messages?.length) {
        return 'Inbox is empty.';
      }
      const lines = result.messages.map((m: any, i: number) =>
        `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`,
      );
      return `Inbox (${result.messages.length} messages):\n${lines.join('\n')}`;
    }

    case 'read_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer');
      }
      const result = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!result) throw new Error('Email not found or empty response');
      const lines: (string | null)[] = [
        `From: ${result.from?.map((a: any) => a.address).join(', ') ?? 'unknown'}`,
        `To: ${result.to?.map((a: any) => a.address).join(', ') ?? 'unknown'}`,
        `Subject: ${result.subject}`,
        `Date: ${result.date}`,
        `Message-ID: ${result.messageId}`,
        result.inReplyTo ? `In-Reply-To: ${result.inReplyTo}` : null,
        '---',
        result.text ?? result.html ?? '(no body)',
      ];
      if (result.attachments?.length) {
        lines.push('---');
        lines.push(`Attachments (${result.attachments.length}):`);
        for (const att of result.attachments) {
          lines.push(`  - ${att.filename} (${att.contentType}, ${Math.round(att.size / 1024)}KB)`);
        }
      }
      const secSection = mcpBuildSecuritySection(result.security, result.attachments);
      if (secSection) lines.push(secSection);
      return lines.filter(line => line !== null).join('\n');
    }

    case 'delete_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer');
      }
      await apiRequest('DELETE', `/mail/messages/${uid}`);
      return `Email UID ${uid} deleted successfully.`;
    }

    case 'search_emails': {
      const { from, to, subject, text, since, before, seen, searchRelay } = args;
      const result = await apiRequest('POST', '/mail/search', { from, to, subject, text, since, before, seen, searchRelay });
      const lines: string[] = [];

      if (result?.uids?.length) {
        lines.push(`Local inbox: ${result.uids.length} match${result.uids.length !== 1 ? 'es' : ''}. UIDs: ${result.uids.join(', ')}`);
      }

      if (result?.relayResults?.length) {
        lines.push(`\nConnected account (${result.relayResults[0].account}): ${result.relayResults.length} match${result.relayResults.length !== 1 ? 'es' : ''}`);
        for (const r of result.relayResults.slice(0, 20)) {
          const fromAddr = r.from?.[0]?.address ?? 'unknown';
          const date = r.date ? new Date(r.date).toLocaleDateString() : '';
          lines.push(`  [relay UID:${r.uid}] From: ${fromAddr} | Subject: ${r.subject} | Date: ${date}`);
        }
        lines.push('\nTo continue a thread from the connected account, use import_relay_email with the relay UID, then reply_email as normal.');
      }

      if (lines.length === 0) {
        return searchRelay
          ? 'No matching emails found in local inbox or connected account.'
          : 'No matching emails found. Tip: set searchRelay=true to also search your connected Gmail/Outlook account.';
      }
      return lines.join('\n');
    }

    case 'import_relay_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer (relay UID from search results)');
      }
      const result = await apiRequest('POST', '/mail/import-relay', { uid });
      return result?.ok
        ? 'Email imported to local inbox. You can now use list_inbox to find it and reply_email to continue the thread.'
        : `Import failed: ${result?.error || 'unknown error'}`;
    }

    case 'reply_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      const original = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!original) throw new Error('Original email not found');
      const replyTo = original.replyTo?.[0]?.address || original.from?.[0]?.address;
      if (!replyTo) throw new Error('Original email has no sender address — cannot reply');
      const origSubject = original.subject ?? '';
      const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
      const refs = Array.isArray(original.references) ? [...original.references] : [];
      if (original.messageId) refs.push(original.messageId);
      // Quote header — preserve the original To/Cc audience on the
      // quoted block so a reader can see who was on the previous
      // round of the thread, not just the sender. The web UI's
      // message-view.js parser surfaces these lines in the thread-
      // quote chrome alongside the sender name + friendly date.
      const fmtAddrs = (arr: unknown): string => (Array.isArray(arr) ? arr : [])
        .map((a: any) => (typeof a === 'string' ? a : (a?.address ?? '')))
        .filter(Boolean)
        .join(', ');
      const origTo = fmtAddrs(original.to);
      const origCc = fmtAddrs(original.cc);
      const headerLines = [`On ${original.date}, ${replyTo} wrote:`];
      if (origTo) headerLines.push(`To: ${origTo}`);
      if (origCc) headerLines.push(`Cc: ${origCc}`);
      const quotedBody = (original.text || '').split('\n').map((l: string) => `> ${l}`).join('\n');
      const fullText = `${args.text}\n\n${headerLines.join('\n')}\n${quotedBody}`;

      // Reply addressing.
      //
      // PRE-0.9.2 BUG: replyAll merged original.to + original.cc +
      // sender into a single `to` field. Every reply-all dumped all
      // participants on `To:`, which defeated 0.9.0's wake-default-
      // from-To (everyone was on To, so everyone woke).
      //
      // Canonical reply-all is To: the previous actor (replyTo);
      // Cc: everyone else, minus the new sender themselves. This
      // way the dispatcher's "wake on To only" default fires
      // exactly one host turn (the previous actor) per round,
      // and everyone on the thread still sees the message.
      //
      // We can't know our own outgoing `from` here (the API will
      // fill it from the authed agent), so we strip it server-side
      // via the sender-self-loop guard. Best-effort de-self here
      // is harmless extra hygiene.
      let to: string = replyTo;
      let cc: string | undefined;
      if (args.replyAll) {
        const norm = (a: { address?: string } | string) =>
          (typeof a === 'string' ? a : a?.address ?? '').trim().toLowerCase();
        const replyToLower = norm(replyTo);
        const others = [...(original.to || []), ...(original.cc || [])]
          .map((a: { address?: string }) => a?.address)
          .filter((v): v is string => !!v)
          .filter((v) => norm(v) !== replyToLower)
          // Deduplicate while preserving order.
          .filter((v, i, a) => a.findIndex((x) => norm(x) === norm(v)) === i);
        to = replyTo;
        cc = others.length > 0 ? others.join(', ') : undefined;
      }

      const replySendBody: Record<string, unknown> = {
        to, subject, text: fullText, html: args.html,
        inReplyTo: original.messageId, references: refs,
        ...(cc !== undefined ? { cc } : {}),
      };
      // Forward the wake allowlist down the same path send_email uses.
      // The /mail/send route normalises and translates it into the
      // X-AgenticMail-Wake header + the wakeAllowlist SSE field.
      if (args.wake !== undefined) {
        replySendBody.wake = args.wake;
      }

      const sendResult = await apiRequest('POST', '/mail/send', replySendBody);

      if (sendResult?.blocked && sendResult?.pendingId) {
        scheduleFollowUp(sendResult.pendingId, to, String(replySendBody.subject || '(no subject)'), makePendingCheck(sendResult.pendingId));
        return `Reply NOT sent — blocked by outbound guard.\n${sendResult.summary}\n\nPending ID: ${sendResult.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the reply was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this reply is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Reply sent to ${to}. Message ID: ${sendResult?.messageId ?? 'unknown'}`;
      if (sendResult?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n${sendResult.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}`).join('\n')}`;
      }
      return response;
    }

    case 'forward_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      const orig = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!orig) throw new Error('Email not found');
      const fwdSubject = (orig.subject ?? '').startsWith('Fwd:') ? orig.subject : `Fwd: ${orig.subject}`;
      const origFrom = orig.from?.[0]?.address ?? 'unknown';
      const origTo = (orig.to || []).map((a: any) => a.address).join(', ');
      const fwdBody = `${args.text ? args.text + '\n\n' : ''}---------- Forwarded message ----------\nFrom: ${origFrom}\nTo: ${origTo}\nDate: ${orig.date}\nSubject: ${orig.subject}\n\n${orig.text || ''}`;

      const fwdSendBody: Record<string, unknown> = { to: args.to, subject: fwdSubject, text: fwdBody };

      // Include original attachments in the forward
      if (Array.isArray(orig.attachments) && orig.attachments.length > 0) {
        fwdSendBody.attachments = orig.attachments.map((a: any) => ({
          filename: a.filename,
          content: a.content?.data ? Buffer.from(a.content.data).toString('base64') : a.content,
          contentType: a.contentType,
          encoding: 'base64',
        }));
      }
      // Pass-through wake allowlist — same semantics as send_email.
      if (args.wake !== undefined) {
        fwdSendBody.wake = args.wake;
      }

      const fwdResult = await apiRequest('POST', '/mail/send', fwdSendBody);

      if (fwdResult?.blocked && fwdResult?.pendingId) {
        scheduleFollowUp(fwdResult.pendingId, String(args.to), fwdSubject, makePendingCheck(fwdResult.pendingId));
        return `Forward NOT sent — blocked by outbound guard.\n${fwdResult.summary}\n\nPending ID: ${fwdResult.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the forward was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this forward is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Forwarded to ${args.to}. Message ID: ${fwdResult?.messageId ?? 'unknown'}`;
      if (fwdResult?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n${fwdResult.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}`).join('\n')}`;
      }
      return response;
    }

    case 'move_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/move`, { from: args.from || 'INBOX', to: args.to });
      return `Moved message UID ${uid} to ${args.to}`;
    }

    case 'mark_unread': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/unseen`);
      return `Marked message UID ${uid} as unread`;
    }

    case 'mark_read': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/seen`);
      return `Marked message UID ${uid} as read`;
    }

    case 'list_folders': {
      const result = await apiRequest('GET', '/mail/folders');
      if (!result?.folders?.length) return 'No folders found.';
      return result.folders.map((f: any) => `${f.path}${f.specialUse ? ` (${f.specialUse})` : ''}`).join('\n');
    }

    case 'list_folder': {
      const folder = encodeURIComponent(String(args.folder));
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const result = await apiRequest('GET', `/mail/folders/${folder}?limit=${limit}&offset=${offset}`);
      if (!result?.messages?.length) return `Folder "${args.folder}" is empty.`;
      const lines = result.messages.map((m: any, i: number) =>
        `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`);
      return `${args.folder} (${result.total} total):\n${lines.join('\n')}`;
    }

    case 'batch_delete': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/delete', { uids, folder: args.folder });
      return `Deleted ${uids.length} messages.`;
    }

    case 'batch_mark_read': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/seen', { uids, folder: args.folder });
      return `Marked ${uids.length} messages as read.`;
    }

    case 'manage_contacts': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/contacts');
        if (!r?.contacts?.length) return 'No contacts.';
        return r.contacts.map((c: any) => `${c.name || '(no name)'} <${c.email}>`).join('\n');
      }
      if (args.action === 'add') {
        if (!args.email) throw new Error('email is required');
        await apiRequest('POST', '/contacts', { email: args.email, name: args.name });
        return `Contact added: ${args.name || ''} <${args.email}>`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/contacts/${args.id}`);
        return 'Contact deleted.';
      }
      throw new Error('Invalid action');
    }

    case 'manage_drafts': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/drafts');
        if (!r?.drafts?.length) return 'No drafts.';
        return r.drafts.map((d: any) => `[${d.id}] To: ${d.to_addr || '?'} | Subject: ${d.subject || '?'}`).join('\n');
      }
      if (args.action === 'create') {
        const r = await apiRequest('POST', '/drafts', { to: args.to, subject: args.subject, text: args.text });
        return `Draft created: ${r?.id}`;
      }
      if (args.action === 'update') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('PUT', `/drafts/${args.id}`, { to: args.to, subject: args.subject, text: args.text });
        return `Draft ${args.id} updated.`;
      }
      if (args.action === 'send') {
        if (!args.id) throw new Error('id is required');
        const draftSendBody: Record<string, unknown> = {};
        if (args.wake !== undefined) draftSendBody.wake = args.wake;
        const r = await apiRequest('POST', `/drafts/${args.id}/send`, draftSendBody);
        return `Draft sent. Message ID: ${r?.messageId ?? 'unknown'}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/drafts/${args.id}`);
        return 'Draft deleted.';
      }
      throw new Error('Invalid action');
    }

    case 'manage_scheduled': {
      const action = args.action || 'create';
      if (action === 'list') {
        const r = await apiRequest('GET', '/scheduled');
        if (!r?.scheduled?.length) return 'No scheduled emails.';
        return r.scheduled.map((s: any) =>
          `[${s.id}] To: ${s.to_addr} | Subject: ${s.subject} | Send at: ${s.send_at} | Status: ${s.status}`
        ).join('\n');
      }
      if (action === 'cancel') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/scheduled/${args.id}`);
        return 'Scheduled email cancelled.';
      }
      // create
      const r = await apiRequest('POST', '/scheduled', {
        to: args.to, subject: args.subject, text: args.text, sendAt: args.sendAt,
      });
      return `Email scheduled for ${r?.sendAt}. ID: ${r?.id}`;
    }

    case 'create_folder': {
      if (!args.name) throw new Error('name is required');
      await apiRequest('POST', '/mail/folders', { name: args.name });
      return `Folder "${args.name}" created successfully.`;
    }

    case 'manage_tags': {
      const action = args.action as string;
      if (action === 'list') {
        const r = await apiRequest('GET', '/tags');
        if (!r?.tags?.length) return 'No tags.';
        return r.tags.map((t: any) => `[${t.id.slice(0, 8)}] ${t.name} (${t.color})`).join('\n');
      }
      if (action === 'create') {
        if (!args.name) throw new Error('name is required');
        const r = await apiRequest('POST', '/tags', { name: args.name, color: args.color });
        return `Tag "${args.name}" created (${r?.color}). ID: ${r?.id}`;
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/tags/${args.id}`);
        return 'Tag deleted.';
      }
      if (action === 'tag_message') {
        if (!args.id || !args.uid) throw new Error('id and uid are required');
        await apiRequest('POST', `/tags/${args.id}/messages`, { uid: args.uid, folder: args.folder });
        return `Tagged message UID ${args.uid} with tag ${args.id}`;
      }
      if (action === 'untag_message') {
        if (!args.id || !args.uid) throw new Error('id and uid are required');
        const folder = args.folder || 'INBOX';
        await apiRequest('DELETE', `/tags/${args.id}/messages/${args.uid}?folder=${encodeURIComponent(String(folder))}`);
        return `Removed tag from message UID ${args.uid} in ${folder}`;
      }
      if (action === 'get_messages') {
        if (!args.id) throw new Error('id is required');
        const r = await apiRequest('GET', `/tags/${args.id}/messages`);
        if (!r?.messages?.length) return `No messages with this tag.`;
        return `Tag "${r.tag.name}" — ${r.messages.length} messages:\n${r.messages.map((m: any) => `  UID ${m.uid} (${m.folder})`).join('\n')}`;
      }
      if (action === 'get_message_tags') {
        if (!args.uid) throw new Error('uid is required');
        const r = await apiRequest('GET', `/messages/${args.uid}/tags`);
        if (!r?.tags?.length) return 'No tags on this message.';
        return r.tags.map((t: any) => `[${t.id.slice(0, 8)}] ${t.name} (${t.color})`).join('\n');
      }
      throw new Error('Invalid action');
    }

    case 'create_account': {
      // Host ownership tagging. When the MCP server runs inside a host
      // integration (claudecode, codex, …), its install writes
      // AGENTICMAIL_MCP_HOST=<host-bridge-name> into the MCP server's
      // env block. We stamp that onto every account created via this
      // tool so each host's dispatcher knows which agents belong to it
      // and the other dispatcher(s) skip them. Without this, both
      // dispatchers wake the same teammate on every reply — double
      // workers, double cost, double thread noise.
      //
      // No env var = no tag = backwards-compatible (legacy accounts
      // remain "unclaimed" and watchable by any dispatcher; the user
      // can claim them later with `agenticmail-<host> claim <name>`).
      const hostTag = process.env.AGENTICMAIL_MCP_HOST?.trim();
      const userMetadata = (args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata))
        ? args.metadata as Record<string, unknown>
        : undefined;
      const metadata: Record<string, unknown> | undefined = hostTag
        ? { ...(userMetadata ?? {}), host: hostTag }
        : userMetadata;
      const result = await apiRequest('POST', '/accounts', {
        name: args.name,
        domain: args.domain,
        role: args.role,
        ...(metadata ? { metadata } : {}),
      }, useMaster);
      if (!result) throw new Error('No response from account creation');
      return [
        `Account created successfully!`,
        `  Name: ${result.name}`,
        `  Email: ${result.email}`,
        `  Role: ${result.role}`,
        `  API Key: ${result.apiKey}`,
        `  ID: ${result.id}`,
        hostTag ? `  Host: ${hostTag} (this account is owned by the ${hostTag} dispatcher)` : '',
      ].filter(Boolean).join('\n');
    }

    case 'setup_operator_email': {
      // Persist the operator's notification address into the master
      // config. The dispatcher reads it back when bridge mail can't
      // be resumed and emails a digest there. See
      // packages/api/src/routes/system-events.ts::bridge-escalation
      // for the consumer path.
      const raw = args.email;
      const email = typeof raw === 'string' ? raw.trim() : '';
      // Empty / null clears the setting — operator can disable
      // escalation emails without ripping config out of disk.
      const body = email ? { email } : { email: null };
      const result = await apiRequest('PATCH', '/system/operator-email', body, true);
      if (!email) {
        return 'Operator escalation email cleared. Bridge alerts will still be recorded as system events but no email forward will be sent.';
      }
      return [
        `✓ Operator escalation email set to ${result?.email ?? email}.`,
        `When sub-agents mail a bridge inbox and no fresh host session is available for a headless resume, the dispatcher will email this address with a digest so you get a phone push.`,
        `Re-run setup_operator_email with a new address any time to update.`,
      ].join('\n');
    }

    case 'setup_email_relay': {
      const result = await apiRequest('POST', '/gateway/relay', {
        provider: args.provider,
        email: args.email,
        password: args.password,
        smtpHost: args.smtpHost,
        smtpPort: args.smtpPort,
        imapHost: args.imapHost,
        imapPort: args.imapPort,
        agentName: args.agentName,
        agentRole: args.agentRole,
        skipDefaultAgent: args.skipDefaultAgent,
      }, useMaster);
      if (!result) throw new Error('No response from relay setup');
      const lines = [
        `Email relay configured!`,
        `  Mode: ${result.mode}`,
        `  Provider: ${result.provider}`,
        `  Email: ${result.email}`,
      ];
      if (result.agent) {
        lines.push(
          `  Default agent: ${result.agent.name} (${result.agent.role})`,
          `  Agent email: ${result.agent.subAddress}`,
          `  Agent API Key: ${result.agent.apiKey}`,
        );
      }
      return lines.join('\n');
    }

    case 'setup_email_domain': {
      const result = await apiRequest('POST', '/gateway/domain', {
        cloudflareToken: args.cloudflareToken,
        cloudflareAccountId: args.cloudflareAccountId,
        domain: args.domain,
        purchase: args.purchase,
        gmailRelay: args.gmailRelay,
      }, useMaster);
      if (!result) throw new Error('No response from domain setup');
      const lines = [
        `Domain email configured!`,
        `  Domain: ${result.domain}`,
        `  DNS: ${result.dnsConfigured ? 'configured' : 'pending'}`,
        `  Tunnel: ${result.tunnelId}`,
      ];
      if (result.outboundRelay) {
        lines.push(`  Outbound relay: ${result.outboundRelay.configured ? 'configured' : 'failed'} (${result.outboundRelay.provider})`);
      }
      if (result.nextSteps?.length) {
        lines.push('', 'Next steps:');
        for (const step of result.nextSteps) {
          lines.push(`  ${step}`);
        }
      }
      return lines.join('\n');
    }

    case 'setup_guide': {
      const result = await apiRequest('GET', '/gateway/setup-guide', undefined, useMaster);
      if (!result?.modes) throw new Error('No response from setup guide');
      const lines: string[] = ['Email Setup Options:', ''];
      for (const mode of result.modes) {
        lines.push(`=== ${mode.mode.toUpperCase()} MODE (${mode.difficulty}) ===`);
        lines.push(mode.description);
        lines.push(`From address: ${mode.fromAddress}`);
        lines.push('Requirements:');
        for (const req of mode.requirements) lines.push(`  - ${req}`);
        lines.push('Pros:');
        for (const pro of mode.pros) lines.push(`  + ${pro}`);
        lines.push('Cons:');
        for (const con of mode.cons) lines.push(`  - ${con}`);
        lines.push('');
      }
      // Optional channels beyond email — realtime voice, the phone
      // carrier choice (46elks vs Twilio), and the Telegram channel.
      if (Array.isArray(result.channels) && result.channels.length) {
        lines.push('Optional Channels (independent of email — add any time):', '');
        for (const ch of result.channels) {
          lines.push(`=== ${String(ch.channel).toUpperCase()} (${ch.difficulty}) ===`);
          lines.push(ch.description);
          lines.push('Requirements:');
          for (const req of ch.requirements ?? []) lines.push(`  - ${req}`);
          if (Array.isArray(ch.providers)) {
            lines.push('Providers (pick one):');
            for (const p of ch.providers) lines.push(`  - ${p.provider}: ${p.credentials}`);
          }
          if (typeof ch.setup === 'string') lines.push(`Setup: ${ch.setup}`);
          for (const pro of ch.pros ?? []) lines.push(`  + ${pro}`);
          for (const con of ch.cons ?? []) lines.push(`  - ${con}`);
          if (ch.note) lines.push(`Note: ${ch.note}`);
          lines.push('');
        }
      }
      return lines.join('\n');
    }

    case 'setup_gmail_alias': {
      const result = await apiRequest('POST', '/gateway/domain/alias-setup', {
        agentEmail: args.agentEmail,
        agentDisplayName: args.agentDisplayName,
      }, useMaster);
      if (!result?.instructions) throw new Error('No response from alias setup');
      const lines = [
        result.instructions.summary,
        '',
        'Steps:',
      ];
      for (const step of result.instructions.steps) {
        lines.push(`${step.step}. ${step.action}`);
        if (step.fields) {
          for (const [k, v] of Object.entries(step.fields)) {
            lines.push(`   ${k}: ${v}`);
          }
        }
        if (step.url) lines.push(`   URL: ${step.url}`);
      }
      return lines.join('\n');
    }

    case 'setup_payment': {
      const result = await apiRequest('GET', '/gateway/domain/payment-setup', undefined, useMaster);
      if (!result?.instructions) throw new Error('No response from payment setup');
      const lines = [result.instructions.summary, ''];
      for (const opt of result.instructions.options) {
        lines.push(`=== Option ${opt.option}: ${opt.label} ===`);
        if (opt.securityNote) lines.push(`Security: ${opt.securityNote}`);
        for (const step of opt.steps) {
          lines.push(`  ${step.step}. ${step.action}`);
          if (step.url) lines.push(`     URL: ${step.url}`);
          if (step.note) lines.push(`     Note: ${step.note}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    case 'purchase_domain': {
      const result = await apiRequest('POST', '/gateway/domain/purchase', {
        keywords: args.keywords,
        tld: args.tld,
      }, useMaster);
      if (!result?.domains?.length) return 'No domains found.';
      const lines = result.domains.map((d: any) =>
        `  ${d.domain}: ${d.available ? 'available' : 'taken'}${d.price ? ` ($${d.price})` : ''}${d.premium ? ' (premium)' : ''}`,
      );
      return `Domain search results:\n${lines.join('\n')}`;
    }

    case 'check_gateway_status': {
      const result = await apiRequest('GET', '/gateway/status', undefined, useMaster);
      if (!result) throw new Error('No response from gateway status');
      const lines = [`Gateway mode: ${result.mode}`, `Healthy: ${result.healthy}`];
      if (result.relay) {
        lines.push(`Relay provider: ${result.relay.provider}`, `Relay email: ${result.relay.email}`, `Polling: ${result.relay.polling}`);
      }
      if (result.domain) {
        lines.push(`Domain: ${result.domain.domain}`, `DNS: ${result.domain.dnsConfigured}`, `Tunnel: ${result.domain.tunnelActive}`);
      }
      return lines.join('\n');
    }

    case 'send_test_email': {
      const result = await apiRequest('POST', '/gateway/test', { to: args.to }, useMaster);
      return `Test email sent! Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'list_agents': {
      const result = await apiRequest('GET', '/accounts/directory');
      const allAgents: any[] = Array.isArray(result?.agents) ? result.agents : [];
      // Scope the listing to the calling host's own teammates +
      // unclaimed accounts. When run inside a claudecode session
      // this hides codex-owned agents (and vice versa), so the
      // model doesn't try to spawn / mail / delegate to teammates
      // belonging to the other host's dispatcher.
      const agents = allAgents.filter(a => visibleToCallerHost(a.host));
      if (agents.length === 0) {
        return MCP_HOST
          ? `No agents owned by host "${MCP_HOST}" (or unclaimed) found. Use \`agenticmail-${MCP_HOST} claim --all\` to take ownership of legacy agents.`
          : 'No agents found.';
      }
      const lines = agents.map((a: any) => {
        const hostTag = a.host ? ` · host=${a.host}` : '';
        const stoppedTag = a.stopped === true ? ' · [STOPPED]' : '';
        return `  ${a.name} (${a.email}) — ${a.role}${hostTag}${stoppedTag}`;
      });
      const header = MCP_HOST
        ? `Agents on host "${MCP_HOST}" (+ unclaimed):`
        : 'Agents in the system:';
      return `${header}\n${lines.join('\n')}`;
    }

    case 'message_agent': {
      const agentName = String(args.agent ?? '').toLowerCase().trim();
      if (!agentName) throw new Error('agent name is required');

      // Validate the target agent exists AND belongs to this host.
      // assertHostOwnsAgent does both — it 404's silently to the
      // not-found branch below, or throws with a clear ownership
      // mismatch message if the agent is owned by another host.
      await assertHostOwnsAgent(agentName);
      try {
        await apiRequest('GET', `/accounts/directory/${encodeURIComponent(agentName)}`);
      } catch {
        throw new Error(`Agent "${agentName}" not found. Use list_agents to see available agents.`);
      }

      const to = `${agentName}@localhost`;
      const priority = String(args.priority ?? 'normal');
      const subject = priority === 'urgent'
        ? `[URGENT] ${args.subject}`
        : priority === 'high'
          ? `[HIGH] ${args.subject}`
          : String(args.subject);
      const result = await apiRequest('POST', '/mail/send', { to, subject, text: args.text });
      return `Message sent to ${to}. Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'check_messages': {
      const searchResult = await apiRequest('POST', '/mail/search', { seen: false });
      const uids: number[] = searchResult?.uids ?? [];
      if (uids.length === 0) return 'No unread messages.';
      const details: string[] = [];
      for (const uid of uids.slice(0, 10)) {
        try {
          const email = await apiRequest('GET', `/mail/messages/${uid}`);
          if (!email) continue;
          const from = email.from?.[0]?.address ?? 'unknown';
          const subject = email.subject ?? '(no subject)';
          const tag = from.endsWith('@localhost') ? '[agent]' : '[external]';
          details.push(`  ${tag} UID ${uid}: from ${from} — "${subject}"`);
        } catch { /* skip */ }
      }
      const more = uids.length > 10 ? `\n  (${uids.length - 10} more not shown)` : '';
      return `${uids.length} unread message(s):\n${details.join('\n')}${more}`;
    }

    case 'delete_agent': {
      const agentName = String(args.name ?? '').trim();
      if (!agentName) throw new Error('name is required');
      // Refuse to delete an agent belonging to a different host —
      // the calling MCP server's host shouldn't have authority over
      // teammates owned by another integration's dispatcher.
      await assertHostOwnsAgent(agentName);

      // Look up agent by name to get ID
      const agents = await apiRequest('GET', '/accounts', undefined, true);
      const fullAgent = agents?.agents?.find((a: any) => a.name === agentName);
      if (!fullAgent) throw new Error(`Agent "${agentName}" not found`);

      const qs = new URLSearchParams({ archive: 'true', deletedBy: 'mcp-tool' });
      if (args.reason) qs.set('reason', String(args.reason));

      const report = await apiRequest('DELETE', `/accounts/${fullAgent.id}?${qs.toString()}`, undefined, true);
      const lines = [
        `Agent "${agentName}" deleted successfully.`,
        `  Deletion ID: ${report?.id}`,
        `  Emails archived: ${report?.summary?.totalEmails ?? 0}`,
        `  Deleted at: ${report?.deletedAt}`,
      ];
      if (report?.summary?.topCorrespondents?.length) {
        lines.push(`  Top correspondents: ${report.summary.topCorrespondents.map((c: any) => c.address).join(', ')}`);
      }
      return lines.join('\n');
    }

    case 'stop_agent': {
      const agentName = String(args.name ?? '').trim();
      if (!agentName) throw new Error('name is required');
      // Refuse to stop an agent belonging to a different host — same
      // ownership rule we apply to delete_agent. Soft-stop is just
      // as scoped to the calling host's teammates.
      await assertHostOwnsAgent(agentName);

      const agents = await apiRequest('GET', '/accounts', undefined, true);
      const fullAgent = agents?.agents?.find((a: any) => a.name === agentName);
      if (!fullAgent) throw new Error(`Agent "${agentName}" not found`);
      if (fullAgent.stopped === true) {
        return `Agent "${agentName}" is already stopped. Use resume_agent to reactivate.`;
      }

      const body: Record<string, unknown> = {};
      if (args.reason) body.reason = String(args.reason);
      const result = await apiRequest('POST', `/accounts/${fullAgent.id}/stop`, body, true);
      const lines = [
        `Agent "${agentName}" stopped successfully.`,
        '  The dispatcher will no longer wake this agent.',
        '  Incoming mail still lands in the mailbox (audit trail preserved).',
        '  Resume with: resume_agent({ name: "' + agentName + '" })',
      ];
      if (result?.stoppedAt) lines.push(`  Stopped at: ${result.stoppedAt}`);
      if (result?.reason) lines.push(`  Reason: ${result.reason}`);
      return lines.join('\n');
    }

    case 'resume_agent': {
      const agentName = String(args.name ?? '').trim();
      if (!agentName) throw new Error('name is required');
      await assertHostOwnsAgent(agentName);

      const agents = await apiRequest('GET', '/accounts', undefined, true);
      const fullAgent = agents?.agents?.find((a: any) => a.name === agentName);
      if (!fullAgent) throw new Error(`Agent "${agentName}" not found`);
      if (fullAgent.stopped !== true) {
        return `Agent "${agentName}" is not stopped. No action taken.`;
      }

      await apiRequest('POST', `/accounts/${fullAgent.id}/resume`, {}, true);
      return [
        `Agent "${agentName}" resumed.`,
        '  The dispatcher will now wake this agent on new mail / task events.',
        '  Any mail that arrived while stopped is in the inbox; it will be picked up on the next natural wake.',
      ].join('\n');
    }

    case 'deletion_reports': {
      if (args.id) {
        const report = await apiRequest('GET', `/accounts/deletions/${encodeURIComponent(String(args.id))}`, undefined, true);
        if (!report) throw new Error('Deletion report not found');
        const lines = [
          `Deletion Report: ${report.id}`,
          `  Agent: ${report.agent.name} (${report.agent.email})`,
          `  Role: ${report.agent.role}`,
          `  Deleted: ${report.deletedAt}`,
          `  By: ${report.deletedBy}`,
          report.reason ? `  Reason: ${report.reason}` : null,
          `  Total emails: ${report.summary.totalEmails}`,
          `  Inbox: ${report.summary.inboxCount}, Sent: ${report.summary.sentCount}, Other: ${report.summary.otherCount}`,
        ];
        if (report.summary.firstEmailDate) {
          lines.push(`  Date range: ${report.summary.firstEmailDate} → ${report.summary.lastEmailDate}`);
        }
        if (report.summary.topCorrespondents?.length) {
          lines.push(`  Top correspondents: ${report.summary.topCorrespondents.map((c: any) => `${c.address} (${c.count})`).join(', ')}`);
        }
        return lines.filter(Boolean).join('\n');
      }
      const result = await apiRequest('GET', '/accounts/deletions', undefined, true);
      const deletions = result?.deletions ?? [];
      if (deletions.length === 0) return 'No deletion reports found.';
      const lines = deletions.map((d: any) =>
        `  [${d.id}] ${d.agentName} (${d.agentEmail}) — deleted ${d.deletedAt}, ${d.emailCount} emails archived`);
      return `Deletion reports:\n${lines.join('\n')}`;
    }

    case 'manage_signatures': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/signatures');
        if (!r?.signatures?.length) return 'No signatures.';
        return r.signatures.map((s: any) => `[${s.id}] ${s.name}${s.isDefault ? ' (default)' : ''}: ${s.text}`).join('\n');
      }
      if (args.action === 'create') {
        if (!args.name || !args.text) throw new Error('name and text are required');
        const r = await apiRequest('POST', '/signatures', { name: args.name, text: args.text, isDefault: args.isDefault });
        return `Signature "${args.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/signatures/${args.id}`);
        return 'Signature deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'manage_templates': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/templates');
        if (!r?.templates?.length) return 'No templates.';
        return r.templates.map((t: any) => `[${t.id}] ${t.name}: ${t.subject}`).join('\n');
      }
      if (args.action === 'create') {
        if (!args.name || !args.subject || !args.text) throw new Error('name, subject, and text are required');
        const r = await apiRequest('POST', '/templates', { name: args.name, subject: args.subject, text: args.text });
        return `Template "${args.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/templates/${args.id}`);
        return 'Template deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'batch_mark_unread': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/unseen', { uids, folder: args.folder });
      return `Marked ${uids.length} messages as unread.`;
    }

    case 'batch_move': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/move', { uids, from: args.from || 'INBOX', to: args.to });
      return `Moved ${uids.length} messages to ${args.to}.`;
    }

    case 'whoami': {
      const result = await apiRequest('GET', '/accounts/me');
      if (!result) throw new Error('Could not retrieve agent info');
      return [
        `Name: ${result.name}`,
        `Email: ${result.email}`,
        `Role: ${result.role}`,
        `ID: ${result.id}`,
        `Created: ${result.createdAt}`,
        result.metadata && Object.keys(result.metadata).length > 0
          ? `Metadata: ${JSON.stringify(result.metadata)}`
          : null,
      ].filter(Boolean).join('\n');
    }

    case 'update_metadata': {
      if (!args.metadata || typeof args.metadata !== 'object') throw new Error('metadata object is required');
      const result = await apiRequest('PATCH', '/accounts/me', { metadata: args.metadata });
      return `Metadata updated successfully. Agent: ${result?.name ?? 'unknown'}`;
    }

    case 'check_health': {
      const result = await apiRequest('GET', '/health');
      if (!result) throw new Error('No response from health check');
      return `🎀 AgenticMail server: ${result.status ?? 'ok'}${result.stalwart ? `, Stalwart: ${result.stalwart}` : ''}`;
    }

    case 'wait_for_email': {
      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 120, 5), 300);
      const includeTasks = args.includeTasks !== false;

      // Normalise filters once. All comparisons are case-insensitive and
      // tolerant of "Display Name <addr@host>" vs bare "addr@host".
      const fromFilter = typeof args.from === 'string' ? args.from.trim().toLowerCase() : '';
      const subjectFilter = typeof args.subject === 'string' ? args.subject.trim().toLowerCase() : '';
      const inReplyToFilter = typeof args.inReplyTo === 'string' ? args.inReplyTo.trim() : '';
      const participantsRaw = Array.isArray(args.participants) ? (args.participants as unknown[]) : [];
      const participantsFilter: string[] = participantsRaw
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map(p => p.trim().toLowerCase());
      const hasAnyFilter = !!(fromFilter || subjectFilter || inReplyToFilter || participantsFilter.length);

      /** Strip "Name <addr>" → "addr". Returns lowercased bare address. */
      const bareAddr = (s: string | undefined): string => {
        if (!s) return '';
        const m = s.match(/<([^>]+)>/);
        return (m ? m[1] : s).trim().toLowerCase();
      };

      /** Does this email match the caller's filters? */
      const emailMatches = (email: any): boolean => {
        if (!hasAnyFilter) return true;
        const fromAddr = bareAddr(email?.from?.[0]?.address ?? '');
        const subj = String(email?.subject ?? '').toLowerCase();
        const ire = String(email?.inReplyTo ?? '').trim();
        if (fromFilter && !fromAddr.includes(fromFilter)) return false;
        if (subjectFilter && !subj.includes(subjectFilter)) return false;
        if (inReplyToFilter && ire !== inReplyToFilter) return false;
        if (participantsFilter.length > 0) {
          const ok = participantsFilter.some(p => fromAddr.includes(p));
          if (!ok) return false;
        }
        return true;
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

      try {
        const res = await fetch(`${API_URL}/api/agenticmail/events`, {
          headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'text/event-stream' },
          signal: controller.signal,
        });

        if (!res.ok) {
          clearTimeout(timer);
          // Fallback: if SSE not available, do a single filtered poll.
          // Push the filters down into the search so we don't have to
          // load every unread email and re-filter client-side.
          const searchBody: Record<string, unknown> = { seen: false };
          if (fromFilter) searchBody.from = fromFilter;
          if (subjectFilter) searchBody.subject = subjectFilter;
          const search = await apiRequest('POST', '/mail/search', searchBody);
          const uids: number[] = search?.uids ?? [];
          // Walk newest-first looking for a real match (the API's
          // search is best-effort; we still verify with the parsed
          // email so inReplyTo / participants filters apply).
          for (const uid of [...uids].reverse()) {
            const email = await apiRequest('GET', `/mail/messages/${uid}`);
            if (!email || !emailMatches(email)) continue;
            const fromAddr = bareAddr(email.from?.[0]?.address);
            return JSON.stringify({
              arrived: true,
              mode: 'poll-fallback',
              eventType: 'email',
              email: {
                uid,
                from: fromAddr,
                fromName: email.from?.[0]?.name ?? fromAddr,
                subject: email.subject ?? '(no subject)',
                date: email.date,
                preview: (email.text ?? '').slice(0, 300),
                messageId: email.messageId,
                inReplyTo: email.inReplyTo,
                isInterAgent: fromAddr.endsWith('@localhost'),
              },
              totalUnread: uids.length,
            });
          }
          return JSON.stringify({
            arrived: false,
            reason: hasAnyFilter
              ? 'SSE unavailable and no unread emails match the filters'
              : 'SSE unavailable and no unread emails',
            timedOut: true,
          });
        }

        if (!res.body) {
          clearTimeout(timer);
          return JSON.stringify({ arrived: false, reason: 'SSE response has no body' });
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // Count events we ignored — surfaced in the timeout response so
        // callers can tell "nothing happened" from "things happened but
        // none matched".
        let skipped = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              for (const line of frame.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                let event: any;
                try { event = JSON.parse(line.slice(6)); } catch { continue; }

                // Task event — pushed directly by the task assign/RPC endpoints.
                // Task events carry no subject/from in a useful way for thread
                // filtering, so we honour `includeTasks` as a coarse switch.
                // When ANY email filter is set, we conservatively skip tasks
                // (the caller is clearly waiting for thread mail, not RPC).
                if (event.type === 'task' && event.taskId) {
                  if (!includeTasks || hasAnyFilter) { skipped++; continue; }
                  clearTimeout(timer);
                  try { reader.cancel(); } catch { /* ignore */ }
                  return JSON.stringify({
                    arrived: true,
                    mode: 'push',
                    eventType: 'task',
                    task: {
                      taskId: event.taskId,
                      taskType: event.taskType,
                      description: event.task,
                      from: event.from,
                    },
                    hint: 'You have a new task. Use check_tasks(action="pending") to see and claim it.',
                  });
                }

                // New email event — from IMAP IDLE or local internal push
                if (event.type === 'new' && event.uid) {
                  const email = await apiRequest('GET', `/mail/messages/${event.uid}`);
                  if (!email || !emailMatches(email)) { skipped++; continue; }
                  clearTimeout(timer);
                  try { reader.cancel(); } catch { /* ignore */ }
                  const fromAddr = bareAddr(email.from?.[0]?.address);
                  return JSON.stringify({
                    arrived: true,
                    mode: 'push',
                    eventType: 'email',
                    skippedEvents: skipped,
                    email: {
                      uid: event.uid,
                      from: fromAddr,
                      fromName: email.from?.[0]?.name ?? fromAddr,
                      subject: email.subject ?? '(no subject)',
                      date: email.date,
                      preview: (email.text ?? '').slice(0, 300),
                      messageId: email.messageId,
                      inReplyTo: email.inReplyTo,
                      isInterAgent: fromAddr.endsWith('@localhost'),
                    },
                  });
                }
              }
            }
          }
        } finally {
          try { reader.cancel(); } catch { /* ignore */ }
        }

        clearTimeout(timer);
        return JSON.stringify({ arrived: false, reason: 'SSE connection closed', timedOut: false, skippedEvents: skipped });

      } catch (err) {
        clearTimeout(timer);
        if ((err as Error).name === 'AbortError') {
          return JSON.stringify({
            arrived: false,
            reason: hasAnyFilter
              ? `Timed out after ${timeoutSec}s — no matching email arrived (filters: ${[
                  fromFilter && `from~="${fromFilter}"`,
                  subjectFilter && `subject~="${subjectFilter}"`,
                  inReplyToFilter && `inReplyTo="${inReplyToFilter}"`,
                  participantsFilter.length && `participants=${JSON.stringify(participantsFilter)}`,
                ].filter(Boolean).join(', ')})`
              : `No email received within ${timeoutSec}s`,
            timedOut: true,
          });
        }
        return JSON.stringify({ arrived: false, reason: (err as Error).message });
      }
    }

    case 'batch_read': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      const result = await apiRequest('POST', '/mail/batch/read', { uids, folder: args.folder });
      if (!result?.messages?.length) return 'No messages found for the given UIDs.';
      const lines = result.messages.map((m: any) => {
        const from = m.from?.map((a: any) => a.address).join(', ') ?? 'unknown';
        return `[UID:${m.uid}] From: ${from} | Subject: ${m.subject}\n${(m.text ?? '').slice(0, 500)}`;
      });
      return `${result.count} messages:\n\n${lines.join('\n\n---\n\n')}`;
    }

    case 'inbox_digest': {
      const qs = new URLSearchParams();
      if (args.limit) qs.set('limit', String(args.limit));
      if (args.offset) qs.set('offset', String(args.offset));
      if (args.folder) qs.set('folder', String(args.folder));
      if (args.previewLength) qs.set('previewLength', String(args.previewLength));
      const query = qs.toString();
      const result = await apiRequest('GET', `/mail/digest${query ? '?' + query : ''}`);
      if (!result?.messages?.length) return 'Inbox is empty.';
      const lines = result.messages.map((m: any, i: number) => {
        const from = m.from?.[0]?.address ?? 'unknown';
        const flags = m.flags?.length ? ` [${m.flags.join(', ')}]` : '';
        return `${i + 1}. [UID:${m.uid}] From: ${from} | Subject: ${m.subject}${flags}\n   ${m.preview || '(no preview)'}`;
      });
      return `Inbox digest (${result.count}/${result.total}):\n${lines.join('\n')}`;
    }

    case 'template_send': {
      // Same wake semantics as send_email — forward as-is and let the
      // API route normalise it. The templates endpoint reuses the same
      // /mail/send path under the hood so the X-AgenticMail-Wake header
      // + SSE wakeAllowlist plumbing all just works.
      const templateBody: Record<string, unknown> = {
        to: args.to, variables: args.variables, cc: args.cc, bcc: args.bcc,
      };
      if (args.wake !== undefined) templateBody.wake = args.wake;
      const result = await apiRequest('POST', `/templates/${args.id}/send`, templateBody);
      return `Template email sent. Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'manage_rules': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/rules');
        if (!r?.rules?.length) return 'No email rules configured.';
        return r.rules.map((rule: any) =>
          `[${rule.id.slice(0, 8)}] ${rule.name} (priority: ${rule.priority}, enabled: ${rule.enabled})\n  Conditions: ${JSON.stringify(rule.conditions)}\n  Actions: ${JSON.stringify(rule.actions)}`
        ).join('\n');
      }
      if (args.action === 'create') {
        const r = await apiRequest('POST', '/rules', {
          name: args.name, priority: args.priority, conditions: args.conditions, actions: args.actions,
        });
        return `Rule "${r?.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/rules/${args.id}`);
        return 'Rule deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'cleanup_agents': {
      // Scope every cleanup view + action to agents the calling host
      // owns (or unclaimed). Without this filter, codex's cleanup
      // would silently sweep Claude-owned teammates and vice versa.
      // We post-filter the API response by metadata.host rather than
      // adding a new server-side parameter so existing master-key
      // tools (CLI, scripts) keep their broad scope.
      let visibleNames: Set<string> | null = null;
      if (MCP_HOST) {
        try {
          const dir = await apiRequest('GET', '/accounts/directory');
          visibleNames = new Set<string>(
            (Array.isArray(dir?.agents) ? dir.agents : [])
              .filter((a: any) => visibleToCallerHost(a.host))
              .map((a: any) => String(a.name ?? '').toLowerCase()),
          );
        } catch { /* fall back to no filter on directory failure */ }
      }
      const visibleAgent = (a: any) =>
        !visibleNames || visibleNames.has(String(a.name ?? '').toLowerCase());

      if (args.action === 'list_inactive') {
        const qs = args.hours ? `?hours=${args.hours}` : '';
        const r = await apiRequest('GET', `/accounts/inactive${qs}`, undefined, true);
        const rows = (Array.isArray(r?.agents) ? r.agents : []).filter(visibleAgent);
        if (rows.length === 0) return 'No inactive agents found. All agents are either active or persistent.';
        return `${rows.length} inactive agent(s):\n${rows.map((a: any) =>
          `  ${a.name} (${a.email}) — last active: ${a.last_activity_at || 'never'}, persistent: ${a.persistent}`
        ).join('\n')}`;
      }
      if (args.action === 'cleanup') {
        const r = await apiRequest('POST', '/accounts/cleanup', { hours: args.hours, dryRun: args.dryRun }, true);
        const candidates = (Array.isArray(r?.wouldDelete) ? r.wouldDelete : []).filter(visibleAgent);
        const deleted = (Array.isArray(r?.deleted) ? r.deleted : []).filter((name: string) =>
          !visibleNames || visibleNames.has(String(name).toLowerCase()),
        );
        if (r?.dryRun) {
          if (!candidates.length) return 'No inactive agents to clean up. All agents are either active or persistent.';
          return `Would delete ${candidates.length} agent(s): ${candidates.map((a: any) => a.name).join(', ')}`;
        }
        if (!deleted.length) return 'No inactive agents to clean up. All agents are either active or persistent.';
        return `Deleted ${deleted.length} agent(s): ${deleted.join(', ')}`;
      }
      if (args.action === 'set_persistent') {
        if (!args.agentId) throw new Error('agentId is required');
        // Refuse to toggle persistence on agents owned by another
        // host — the agentId is opaque, so look up the agent's
        // name + host before mutating. We do this only when an
        // MCP_HOST is configured; direct master-key callers
        // (CLI / scripts) keep the broader scope.
        if (MCP_HOST) {
          try {
            const all = await apiRequest('GET', '/accounts', undefined, true);
            const agent = (all?.agents ?? []).find((a: any) => a.id === args.agentId);
            const host = typeof agent?.metadata?.host === 'string' ? agent.metadata.host : null;
            if (agent && !visibleToCallerHost(host)) {
              throw new Error(`Agent ${args.agentId} (${agent.name}) is owned by host "${host}", not "${MCP_HOST}".`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.includes('owned by host')) throw err;
            // Network / 404 on the lookup — let the patch attempt
            // fail with its own clearer error.
          }
        }
        await apiRequest('PATCH', `/accounts/${args.agentId}/persistent`, { persistent: args.persistent !== false }, true);
        return `Agent ${args.agentId} persistent flag set to ${args.persistent !== false}`;
      }
      throw new Error('Invalid action. Use: list_inactive, cleanup, or set_persistent');
    }

    case 'save_thread_memory': {
      if (!args.threadId) throw new Error('threadId is required (call get_thread_id first)');
      const body: Record<string, unknown> = { };
      if (typeof args.summary === 'string') body.summary = args.summary;
      if (Array.isArray(args.commitments)) body.commitments = args.commitments;
      if (Array.isArray(args.openQuestions)) body.openQuestions = args.openQuestions;
      if (typeof args.lastAction === 'string') body.lastAction = args.lastAction;
      if (typeof args.lastUid === 'number') body.lastUid = args.lastUid;
      await apiRequest('POST', `/agents/me/memory/threads/${encodeURIComponent(String(args.threadId))}`, body);
      return `Memory saved for thread ${args.threadId}.`;
    }

    case 'get_thread_id': {
      if (typeof args.uid !== 'number' || args.uid < 1) throw new Error('uid (number, ≥1) is required');
      const folder = typeof args.folder === 'string' ? args.folder : 'INBOX';
      const r = await apiRequest('GET', `/agents/me/thread-id?uid=${args.uid}&folder=${encodeURIComponent(folder)}`);
      if (!r?.threadId) throw new Error('Failed to resolve thread id');
      return `Thread ${r.threadId} (subject "${r.subject}", root from ${r.rootFromAddr}).`;
    }

    case 'tail_worker': {
      if (!args.workerId) throw new Error('workerId is required');
      const lines = typeof args.lines === 'number' ? args.lines : 80;
      const r = await apiRequest('GET', `/dispatcher/worker-log/${encodeURIComponent(String(args.workerId))}?lines=${lines}`, undefined, true);
      if (!r?.tail || !Array.isArray(r.tail)) return `No log found for worker ${args.workerId}.`;
      if (r.tail.length === 0) return `Worker ${args.workerId} has no log entries yet.`;
      return `Worker ${args.workerId} log (last ${r.lines} of ${r.bytes} bytes):\n${r.tail.join('\n')}`;
    }

    case 'check_activity': {
      // Endpoint requires master key. We hit it via apiRequest's master
      // path (the 4th arg = `useMasterKey` opt-in), same as cleanup_agents.
      const r = await apiRequest('GET', '/dispatcher/activity', undefined, true);
      const filterAgent = typeof args.agent === 'string' ? args.agent.toLowerCase() : '';
      const includeRecent = args.includeRecent !== false;
      const matchesFilter = (w: any) => !filterAgent || (w.agentName ?? '').toLowerCase().includes(filterAgent);
      // Build the set of agent names visible to this host so we can
      // filter the activity registry to "workers for agents I own".
      // Without this, a codex MCP session calling check_activity sees
      // every Claude-owned worker too — confusing UX and a (mild)
      // cross-host information leak.
      let visibleNames: Set<string> | null = null;
      if (MCP_HOST) {
        try {
          const dir = await apiRequest('GET', '/accounts/directory');
          visibleNames = new Set<string>(
            (Array.isArray(dir?.agents) ? dir.agents : [])
              .filter((a: any) => visibleToCallerHost(a.host))
              .map((a: any) => String(a.name ?? '').toLowerCase()),
          );
        } catch { /* fall back to no host filter on directory failure */ }
      }
      const visibleToHost = (w: any) => {
        if (!visibleNames) return true;  // no host scoping
        return visibleNames.has(String(w.agentName ?? '').toLowerCase());
      };
      const matchesAll = (w: any) => matchesFilter(w) && visibleToHost(w);
      const activeList: any[] = Array.isArray(r?.active) ? r.active.filter(matchesAll) : [];
      const recentList: any[] = includeRecent && Array.isArray(r?.recent) ? r.recent.filter(matchesAll) : [];
      if (activeList.length === 0 && recentList.length === 0) {
        if (filterAgent) return `No dispatcher activity for "${args.agent}" right now or in the last 2 minutes. Either the agent has not been woken on this thread yet, the dispatcher is not running, or mail to them is still in flight.`;
        return 'No dispatcher activity right now or in the last 2 minutes. If you just sent mail and expected an agent to wake, give it a moment — the dispatcher subscribes to /system/events for sub-second wake. If nothing happens for 30s, check that the dispatcher process is running (`pm2 list`) and that the recipient is a real local agent (`list_agents`).';
      }
      const fmtDur = (ms: number) => {
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
        if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
        return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
      };
      const fmt = (w: any, prefix: string) => {
        const dur = w.durationMs ? fmtDur(w.durationMs) : '?';
        const trig = w.trigger?.subject ? ` — ${String(w.trigger.subject).slice(0, 60)}` : w.trigger?.taskId ? ` — task ${String(w.trigger.taskId).slice(0, 8)}` : '';
        const from = w.trigger?.from ? ` (from ${w.trigger.from})` : '';
        const preview = w.resultPreview ? `\n      → ${String(w.resultPreview).slice(0, 140).replace(/\s+/g, ' ').trim()}` : '';
        // Context-budget telemetry: only present on finished workers
        // (the SDK emits usage in the result frame at end-of-turn).
        // Renders as a second line so the row stays scannable.
        const usage = w.usage ? `\n      ⚡ ${String(w.usage)}` : '';
        let status = w.endedAtMs ? (w.ok === false ? 'failed' : 'finished') : 'running';
        if (!w.endedAtMs && w.stale) status = 'running (stale heartbeat)';
        const turns = !w.endedAtMs && typeof w.turnCount === 'number' ? ` · ${w.turnCount} tool calls` : '';
        const tool = !w.endedAtMs && w.lastTool ? ` · last tool: ${w.lastTool}` : '';
        const idHint = !w.endedAtMs ? `\n      id: ${w.workerId}  (use tail_worker for the log)` : '';
        return `  ${prefix} ${w.agentName} [${w.kind}] ${status} ${dur}${turns}${tool}${trig}${from}${preview}${usage}${idHint}`;
      };
      const lines: string[] = [];
      if (activeList.length > 0) {
        lines.push(`Active workers (${activeList.length}):`);
        for (const w of activeList) lines.push(fmt(w, '●'));
      }
      if (recentList.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Recently finished (last 2 min, ${recentList.length}):`);
        for (const w of recentList) lines.push(fmt(w, '○'));
      }
      return lines.join('\n');
    }

    case 'check_tasks': {
      let endpoint = args.direction === 'outgoing' ? '/tasks/assigned' : '/tasks/pending';
      if (args.direction !== 'outgoing' && args.assignee) {
        endpoint += `?assignee=${encodeURIComponent(String(args.assignee))}`;
      }
      const r = await apiRequest('GET', endpoint);
      if (!r?.tasks?.length) return args.direction === 'outgoing' ? 'No tasks assigned by you.' : 'No pending tasks.';
      return `${r.count} tasks:\n${r.tasks.map((t: any) =>
        `  [${t.id.slice(0, 8)}] ${t.taskType} — status: ${t.status}, payload: ${JSON.stringify(t.payload).slice(0, 100)}`
      ).join('\n')}`;
    }

    case 'claim_task': {
      const r = await apiRequest('POST', `/tasks/${args.id}/claim`);
      return `Task ${r?.id} claimed. Payload: ${JSON.stringify(r?.payload)}`;
    }

    case 'submit_result': {
      await apiRequest('POST', `/tasks/${args.id}/result`, { result: args.result });
      return `Result submitted for task ${args.id}.`;
    }

    case 'call_agent': {
      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 180, 5), 300);

      // Refuse to call an agent owned by a different host — same
      // routing principle as message_agent. Without this, codex's
      // call_agent could synchronously RPC into a Claude-owned
      // teammate, which would either deadlock (Claude's dispatcher
      // wakes the agent, codex polls and times out) or succeed
      // but cross the host boundary in a way the operator didn't
      // ask for.
      await assertHostOwnsAgent(String(args.target ?? ''));

      // Step 1: Create the task (quick request — returns immediately)
      const created = await apiRequest('POST', '/tasks/assign', {
        assignee: args.target,
        taskType: 'rpc',
        payload: { task: args.task, ...(args.payload || {}) },
        // Pass outputSchema through verbatim. The API persists it
        // and renders it into the worker's wake prompt; validation
        // happens server-side on submit_result.
        ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}),
      });
      if (!created?.id) throw new Error('Failed to create task');
      const taskId = created.id;

      // Step 2: Poll for completion with short-lived requests
      const deadline = Date.now() + timeoutSec * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const task = await apiRequest('GET', `/tasks/${taskId}`);
          if (task?.status === 'completed') return `RPC completed. Result: ${JSON.stringify(task.result)}`;
          if (task?.status === 'failed') return `RPC failed: ${task.error}`;
        } catch { /* poll error — retry on next cycle */ }
      }

      return `RPC timed out. Task ID: ${taskId} — check later with check_tasks.`;
    }

    case 'manage_spam': {
      const action = args.action as string;
      if (action === 'list') {
        const qs = new URLSearchParams();
        if (args.limit) qs.set('limit', String(args.limit));
        if (args.offset) qs.set('offset', String(args.offset));
        const query = qs.toString();
        const result = await apiRequest('GET', `/mail/spam${query ? '?' + query : ''}`);
        if (!result?.messages?.length) return 'Spam folder is empty.';
        const lines = result.messages.map((m: any, i: number) =>
          `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`);
        return `Spam folder (${result.count}/${result.total}):\n${lines.join('\n')}`;
      }
      if (action === 'report') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        await apiRequest('POST', `/mail/messages/${uid}/spam`, { folder: args.folder || 'INBOX' });
        return `Message UID ${uid} moved to Spam.`;
      }
      if (action === 'not_spam') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        await apiRequest('POST', `/mail/messages/${uid}/not-spam`);
        return `Message UID ${uid} moved from Spam to INBOX.`;
      }
      if (action === 'score') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        const folder = args.folder || 'INBOX';
        const result = await apiRequest('GET', `/mail/messages/${uid}/spam-score?folder=${encodeURIComponent(String(folder))}`);
        const lines = [
          `Spam Score: ${result.score}/100 (${result.isSpam ? 'SPAM' : result.isWarning ? 'WARNING' : 'CLEAN'})`,
          result.topCategory ? `Top Category: ${result.topCategory}` : null,
        ];
        if (result.matches?.length) {
          lines.push('Matches:');
          for (const m of result.matches) {
            lines.push(`  [${m.ruleId}] +${m.score} — ${m.description}`);
          }
        }
        return lines.filter(Boolean).join('\n');
      }
      throw new Error('Invalid action. Use: list, report, not_spam, or score');
    }

    case 'manage_pending_emails': {
      const action = String(args.action);
      if (action === 'list') {
        const result = await apiRequest('GET', '/mail/pending');
        // Cancel follow-ups for any resolved emails
        if (result?.pending) {
          for (const p of result.pending) {
            if (p.status !== 'pending') cancelFollowUp(p.id);
          }
        }
        if (!result?.pending?.length) return withReminders('No pending outbound emails.');
        const lines = result.pending.map((p: any, i: number) =>
          `${i + 1}. [${p.id}] To: ${p.to} | Subject: ${p.subject} | Status: ${p.status} | Created: ${p.createdAt}`);
        return withReminders(`Pending emails (${result.count}):\n${lines.join('\n')}`);
      }
      if (action === 'get') {
        if (!args.id) throw new Error('id is required');
        const result = await apiRequest('GET', `/mail/pending/${encodeURIComponent(String(args.id))}`);
        if (!result) throw new Error('Pending email not found');
        if (result.status !== 'pending') cancelFollowUp(String(args.id));
        return withReminders(`Pending Email: ${result.id}\nTo: ${result.mailOptions?.to}\nSubject: ${result.mailOptions?.subject}\nStatus: ${result.status}\nCreated: ${result.createdAt}\nWarnings:\n${result.summary}`);
      }
      if (action === 'approve' || action === 'reject') {
        return withReminders(`You cannot ${action} pending emails. Only the owner (human) can approve or reject blocked emails. Please inform the owner and wait for their decision.`);
      }
      throw new Error('Invalid action. Use: list or get');
    }

    // --- SMS / Phone Tools ---

    case 'sms_setup': {
      const result = await apiRequest('POST', '/sms/setup', {
        phoneNumber: args.phoneNumber,
        provider: args.provider ?? 'google_voice',
        forwardingEmail: args.forwardingEmail,
        forwardingPassword: args.forwardingPassword,
        username: args.username,
        password: args.password,
        webhookSecret: args.webhookSecret,
        apiUrl: args.apiUrl,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'sms_send': {
      const result = await apiRequest('POST', '/sms/send', {
        to: args.to,
        body: args.body,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'sms_messages': {
      const query = new URLSearchParams();
      if (args.direction) query.set('direction', String(args.direction));
      if (args.limit) query.set('limit', String(args.limit));
      if (args.offset) query.set('offset', String(args.offset));
      const result = await apiRequest('GET', `/sms/messages?${query.toString()}`);
      return JSON.stringify(result, null, 2);
    }

    case 'sms_check_code': {
      const query = args.minutes ? `?minutes=${args.minutes}` : '';
      const result = await apiRequest('GET', `/sms/verification-code${query}`);
      return JSON.stringify(result, null, 2);
    }

    case 'sms_parse_email': {
      const result = await apiRequest('POST', '/sms/parse-email', {
        emailBody: args.emailBody,
        emailFrom: args.emailFrom,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'storage': {
      const act = args.action as string;
      const tbl = args.table ? encodeURIComponent(args.table as string) : '';
      let result: any;
      switch (act) {
        // DDL
        case 'create_table':
          result = await apiRequest('POST', '/storage/tables', { name: args.table, columns: args.columns, indexes: args.indexes, shared: args.shared, description: args.description, timestamps: args.timestamps }); break;
        case 'list_tables':
          result = await apiRequest('GET', `/storage/tables?includeShared=${args.includeShared !== false}&includeArchived=${args.includeArchived === true}`); break;
        case 'describe_table':
          result = await apiRequest('GET', `/storage/tables/${tbl}/describe`); break;
        case 'add_column':
          result = await apiRequest('POST', `/storage/tables/${tbl}/columns`, { column: args.column }); break;
        case 'drop_column':
          result = await apiRequest('DELETE', `/storage/tables/${tbl}/columns/${encodeURIComponent(args.columnName as string)}`); break;
        case 'rename_table':
          result = await apiRequest('POST', `/storage/tables/${tbl}/rename`, { newName: args.newName }); break;
        case 'rename_column':
          result = await apiRequest('POST', `/storage/tables/${tbl}/rename-column`, { oldName: args.oldName, newName: args.newName }); break;
        case 'drop_table':
          result = await apiRequest('DELETE', `/storage/tables/${tbl}`); break;
        case 'clone_table':
          result = await apiRequest('POST', `/storage/tables/${tbl}/clone`, { newName: args.newName, includeData: args.includeData }); break;
        case 'truncate':
          result = await apiRequest('POST', `/storage/tables/${tbl}/truncate`); break;
        // Indexes
        case 'create_index':
          result = await apiRequest('POST', `/storage/tables/${tbl}/indexes`, { columns: args.indexColumns || args.columns, unique: args.indexUnique, name: args.indexName, where: args.indexWhere }); break;
        case 'list_indexes':
          result = await apiRequest('GET', `/storage/tables/${tbl}/indexes`); break;
        case 'drop_index':
          result = await apiRequest('DELETE', `/storage/tables/${tbl}/indexes/${encodeURIComponent(args.indexName as string)}`); break;
        case 'reindex':
          result = await apiRequest('POST', `/storage/tables/${tbl}/reindex`); break;
        // DML
        case 'insert':
          result = await apiRequest('POST', '/storage/insert', { table: args.table, rows: args.rows }); break;
        case 'upsert':
          result = await apiRequest('POST', '/storage/upsert', { table: args.table, rows: args.rows, conflictColumn: args.conflictColumn }); break;
        case 'query':
          result = await apiRequest('POST', '/storage/query', { table: args.table, where: args.where, orderBy: args.orderBy, limit: args.limit, offset: args.offset, columns: args.selectColumns, distinct: args.distinct, groupBy: args.groupBy, having: args.having }); break;
        case 'aggregate':
          result = await apiRequest('POST', '/storage/aggregate', { table: args.table, where: args.where, operations: args.operations, groupBy: args.groupBy }); break;
        case 'update':
          result = await apiRequest('POST', '/storage/update', { table: args.table, where: args.where, set: args.set }); break;
        case 'delete_rows':
          result = await apiRequest('POST', '/storage/delete-rows', { table: args.table, where: args.where }); break;
        // Archive
        case 'archive_table':
          result = await apiRequest('POST', `/storage/tables/${tbl}/archive`); break;
        case 'unarchive_table':
          result = await apiRequest('POST', `/storage/tables/${tbl}/unarchive`); break;
        // Import/Export
        case 'export':
          result = await apiRequest('POST', `/storage/tables/${tbl}/export`, { format: args.format, where: args.where, limit: args.limit }); break;
        case 'import':
          result = await apiRequest('POST', `/storage/tables/${tbl}/import`, { rows: args.rows, onConflict: args.onConflict, conflictColumn: args.conflictColumn }); break;
        // Raw SQL
        case 'sql':
          result = await apiRequest('POST', '/storage/sql', { sql: args.sql, params: args.params }); break;
        case 'explain':
          result = await apiRequest('POST', '/storage/explain', { sql: args.sql, params: args.params }); break;
        // Maintenance
        case 'stats':
          result = await apiRequest('GET', '/storage/stats'); break;
        case 'vacuum':
          result = await apiRequest('POST', '/storage/vacuum'); break;
        case 'analyze':
          result = await apiRequest('POST', `/storage/tables/${tbl}/analyze`); break;
        default:
          result = { error: `Unknown action "${act}". 28 actions available: create_table, list_tables, describe_table, insert, upsert, query, aggregate, update, delete_rows, truncate, drop_table, clone_table, rename_table, rename_column, add_column, drop_column, create_index, list_indexes, drop_index, reindex, archive_table, unarchive_table, export, import, sql, stats, vacuum, analyze, explain` };
      }
      return JSON.stringify(result, null, 2);
    }

    case 'sms_config': {
      const result = await apiRequest('GET', '/sms/config');
      return JSON.stringify(result, null, 2);
    }

    case 'sms_read_voice': {
      const configResult = await apiRequest('GET', '/sms/config');
      const phone = configResult?.sms?.phoneNumber || 'unknown';
      return JSON.stringify({
        method: 'google_voice_web',
        phoneNumber: phone,
        browserUrl: 'https://voice.google.com/u/0/messages',
        instructions: [
          'Open the browser to: https://voice.google.com/u/0/messages',
          'Take a screenshot to see the message list',
          'Recent SMS messages appear in the sidebar with sender and preview',
          'After reading, use sms_record to save the SMS to the database',
        ],
        tip: 'This is much faster than email forwarding. Messages appear instantly.',
      }, null, 2);
    }

    case 'sms_record': {
      const result = await apiRequest('POST', '/sms/record', {
        from: args.from,
        body: args.body,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'phone_transport_setup': {
      const result = await apiRequest('POST', '/phone/transport/setup', {
        provider: args.provider ?? '46elks',
        phoneNumber: args.phoneNumber,
        username: args.username,
        password: args.password,
        // Twilio credential aliases — buildPhoneTransportConfig accepts
        // accountSid/authToken in place of username/password for twilio.
        accountSid: args.accountSid,
        authToken: args.authToken,
        webhookBaseUrl: args.webhookBaseUrl,
        webhookSecret: args.webhookSecret,
        apiUrl: args.apiUrl,
        realtimeBridgeNumber: args.realtimeBridgeNumber,
        capabilities: args.capabilities,
        supportedRegions: args.supportedRegions,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'phone_capabilities': {
      const result = await apiRequest('GET', '/phone/capabilities');
      return JSON.stringify(result, null, 2);
    }

    case 'realtime_conversation_capabilities': {
      const query = new URLSearchParams();
      for (const key of ['channel', 'policyProvided', 'operatorApproved', 'userOptedIn']) {
        if (args[key] !== undefined) query.set(key, String(args[key]));
      }
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/conversation/realtime/capabilities${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'realtime_conversation_plan': {
      const result = await apiRequest('POST', '/conversation/realtime/plan', {
        channel: args.channel,
        policyProvided: args.policyProvided,
        operatorApproved: args.operatorApproved,
        userOptedIn: args.userOptedIn,
        transportConfigured: args.transportConfigured,
        realtimeMediaConfigured: args.realtimeMediaConfigured,
        openaiRealtimeConfigured: args.openaiRealtimeConfigured,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_list': {
      const query = new URLSearchParams();
      for (const key of ['status', 'channel', 'limit', 'offset']) {
        if (args[key] !== undefined) query.set(key, String(args[key]));
      }
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/conversation/sessions${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_get': {
      if (!args.sessionId) throw new Error('sessionId is required');
      const result = await apiRequest('GET', `/conversation/sessions/${encodeURIComponent(String(args.sessionId))}`);
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_context': {
      if (!args.sessionId) throw new Error('sessionId is required');
      const query = new URLSearchParams();
      if (args.messageLimit !== undefined) query.set('messageLimit', String(args.messageLimit));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/conversation/sessions/${encodeURIComponent(String(args.sessionId))}/context${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_start': {
      const result = await apiRequest('POST', '/conversation/sessions/start', {
        channel: args.channel,
        chatId: args.chatId,
        peer: args.peer,
        to: args.to,
        goal: args.goal,
        task: args.task,
        subject: args.subject,
        initialMessage: args.initialMessage,
        policy: args.policy,
        policyPreset: args.policyPreset,
        regionAllowlist: args.regionAllowlist,
        maxCallDurationSeconds: args.maxCallDurationSeconds,
        maxCostPerMission: args.maxCostPerMission,
        maxAttempts: args.maxAttempts,
        maxTimeShiftMinutes: args.maxTimeShiftMinutes,
        transcriptEnabled: args.transcriptEnabled,
        recordingEnabled: args.recordingEnabled,
        voiceRuntime: args.voiceRuntime,
        voiceModel: args.voiceModel,
        voice: args.voice,
        dryRun: args.dryRun,
        operatorApproved: args.operatorApproved,
        userOptedIn: args.userOptedIn,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_send': {
      if (!args.sessionId) throw new Error('sessionId is required');
      const result = await apiRequest('POST', `/conversation/sessions/${encodeURIComponent(String(args.sessionId))}/messages`, {
        text: args.text,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_messages': {
      if (!args.sessionId) throw new Error('sessionId is required');
      const result = await apiRequest('GET', `/conversation/sessions/${encodeURIComponent(String(args.sessionId))}/messages`);
      return JSON.stringify(result, null, 2);
    }

    case 'conversation_end': {
      if (!args.sessionId) throw new Error('sessionId is required');
      const result = await apiRequest('POST', `/conversation/sessions/${encodeURIComponent(String(args.sessionId))}/end`, {
        status: args.status,
      });
      return JSON.stringify(result, null, 2);
    }

    // --- Telegram Channel ---

    case 'telegram_setup': {
      const result = await apiRequest('POST', '/telegram/setup', {
        botToken: args.botToken,
        operatorChatId: args.operatorChatId,
        allowedChatIds: args.allowedChatIds,
        mode: args.mode,
        webhookUrl: args.webhookUrl,
        webhookSecret: args.webhookSecret,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'telegram_config': {
      const result = await apiRequest('GET', '/telegram/config');
      return JSON.stringify(result, null, 2);
    }

    case 'telegram_send': {
      const result = await apiRequest('POST', '/telegram/send', {
        chatId: args.chatId,
        text: args.text,
        replyToMessageId: args.replyToMessageId,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'telegram_messages': {
      const query = new URLSearchParams();
      if (args.direction) query.set('direction', String(args.direction));
      if (args.chatId) query.set('chatId', String(args.chatId));
      if (args.limit) query.set('limit', String(args.limit));
      if (args.offset) query.set('offset', String(args.offset));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/telegram/messages${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'telegram_poll': {
      const result = await apiRequest('POST', '/telegram/poll');
      return JSON.stringify(result, null, 2);
    }

    case 'matrix_setup': {
      const result = await apiRequest('POST', '/matrix/setup', {
        homeserverUrl: args.homeserverUrl,
        accessToken: args.accessToken,
        allowedRoomIds: args.allowedRoomIds,
        operatorRoomId: args.operatorRoomId,
        userId: args.userId,
        deviceId: args.deviceId,
        verify: args.verify,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'matrix_config': {
      const result = await apiRequest('GET', '/matrix/config');
      return JSON.stringify(result, null, 2);
    }

    case 'matrix_send': {
      const result = await apiRequest('POST', '/matrix/send', {
        roomId: args.roomId,
        text: args.text,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'matrix_messages': {
      const query = new URLSearchParams();
      if (args.direction) query.set('direction', String(args.direction));
      if (args.roomId) query.set('roomId', String(args.roomId));
      if (args.limit) query.set('limit', String(args.limit));
      if (args.offset) query.set('offset', String(args.offset));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/matrix/messages${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'matrix_poll': {
      const result = await apiRequest('POST', '/matrix/poll', {
        since: args.since,
        timeoutMs: args.timeoutMs,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'call_phone_safe': {
      const result = await apiRequest('POST', '/calls/start', {
        to: args.to,
        task: args.task,
        policyPreset: args.policyPreset ?? 'safe_default',
        regionAllowlist: args.regionAllowlist,
        maxCallDurationSeconds: args.maxCallDurationSeconds,
        maxCostPerMission: args.maxCostPerMission,
        maxAttempts: args.maxAttempts,
        maxTimeShiftMinutes: args.maxTimeShiftMinutes,
        transcriptEnabled: args.transcriptEnabled,
        recordingEnabled: args.recordingEnabled,
        voiceRuntime: args.voiceRuntime,
        voiceModel: args.voiceModel,
        voice: args.voice,
        voiceRuntimeRef: args.voiceRuntimeRef,
        dryRun: args.dryRun,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'call_phone': {
      const result = await apiRequest('POST', '/calls/start', {
        to: args.to,
        task: args.task,
        policy: args.policy,
        voiceRuntimeRef: args.voiceRuntimeRef,
        dryRun: args.dryRun,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'call_status': {
      if (args.id) {
        const result = await apiRequest('GET', `/calls/${encodeURIComponent(String(args.id))}`);
        return JSON.stringify(result, null, 2);
      }
      const query = new URLSearchParams();
      if (args.status) query.set('status', String(args.status));
      if (args.limit) query.set('limit', String(args.limit));
      if (args.offset) query.set('offset', String(args.offset));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/calls${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'call_transcript': {
      if (!args.id) throw new Error('id is required');
      const result = await apiRequest('GET', `/calls/${encodeURIComponent(String(args.id))}/transcript`);
      return JSON.stringify(result, null, 2);
    }

    case 'call_cancel': {
      if (!args.id) throw new Error('id is required');
      const result = await apiRequest('POST', `/calls/${encodeURIComponent(String(args.id))}/cancel`);
      return JSON.stringify(result, null, 2);
    }

    // v0.9.97 — operator-query inspection + answer injection.
    // call_open_queries(id?)        → GET /calls/:id/operator-queries
    //                                  (or scans listMissions when id omitted)
    // call_answer_query(mission_id, query_id, answer)
    //                              → POST /calls/:id/operator-queries/:qid/answer
    case 'call_open_queries': {
      if (args.id) {
        const result = await apiRequest('GET', `/calls/${encodeURIComponent(String(args.id))}/operator-queries`);
        return JSON.stringify(result, null, 2);
      }
      // Scan ALL of the agent's missions for open queries. Cheap: the
      // listMissions endpoint returns mission summaries; we then ask
      // each for its operator-queries. Wins when the dispatcher wants
      // "is there ANY pending query right now I should answer?".
      const missions = await apiRequest('GET', '/calls') as { missions?: Array<{ id: string }> };
      const list = Array.isArray(missions?.missions) ? missions.missions : [];
      const out: Array<{ missionId: string; queries: any[] }> = [];
      for (const m of list) {
        try {
          const detail = await apiRequest('GET', `/calls/${encodeURIComponent(m.id)}/operator-queries`) as any;
          const queries = Array.isArray(detail?.operatorQueries) ? detail.operatorQueries : [];
          const open = queries.filter((q: any) => !q.answer);
          if (open.length > 0) out.push({ missionId: m.id, queries: open });
        } catch { /* one bad mission shouldn't break the scan */ }
      }
      return JSON.stringify({ openByMission: out, count: out.reduce((n, m) => n + m.queries.length, 0) }, null, 2);
    }

    case 'call_answer_query': {
      const missionId = args.mission_id ?? args.missionId;
      const queryId = args.query_id ?? args.queryId;
      const answer = args.answer;
      if (!missionId) throw new Error('mission_id is required');
      if (!queryId) throw new Error('query_id is required');
      if (!answer || (typeof answer === 'string' && !answer.trim())) {
        throw new Error('answer is required (non-empty string)');
      }
      const result = await apiRequest(
        'POST',
        `/calls/${encodeURIComponent(String(missionId))}/operator-queries/${encodeURIComponent(String(queryId))}/answer`,
        { answer: String(answer) },
      );
      return JSON.stringify(result, null, 2);
    }

    // ─── Media toolset ───────────────────────────────────────────────
    // Thin clients of the /media/* API routes. The API delegates to the
    // core MediaManager, which feature-detects each external binary and
    // returns a 503 with an actionable install hint when one is missing.
    case 'media_capabilities': {
      const suffix = args.refresh === true ? '?refresh=true' : '';
      const result = await apiRequest('GET', `/media/capabilities${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'media_tts': {
      const result = await apiRequest('POST', '/media/tts', {
        text: args.text,
        voice: args.voice,
        rate: args.rate,
        pitch: args.pitch,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'media_tts_voices': {
      const result = await apiRequest('GET', '/media/voices');
      return JSON.stringify(result, null, 2);
    }

    case 'media_image_edit': {
      const result = await apiRequest('POST', '/media/image', {
        input: args.input,
        action: args.action,
        width: args.width,
        height: args.height,
        angle: args.angle,
        format: args.format,
        quality: args.quality,
        text: args.text,
        position: args.position,
        fontSize: args.fontSize,
        fontColor: args.fontColor,
        blurRadius: args.blurRadius,
        direction: args.direction,
        offsetX: args.offsetX,
        offsetY: args.offsetY,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'media_video_edit': {
      const result = await apiRequest('POST', '/media/video', {
        input: args.input,
        action: args.action,
        start: args.start,
        end: args.end,
        duration: args.duration,
        timestamp: args.timestamp,
        interval: args.interval,
        format: args.format,
        width: args.width,
        height: args.height,
        fps: args.fps,
        crf: args.crf,
        audioPath: args.audioPath,
        speedFactor: args.speedFactor,
        secondInput: args.secondInput,
        transitionType: args.transitionType,
        transitionDuration: args.transitionDuration,
        text: args.text,
        fontSize: args.fontSize,
        fontColor: args.fontColor,
        textPosition: args.textPosition,
        textBg: args.textBg,
        textStart: args.textStart,
        textEnd: args.textEnd,
        overlayOpacity: args.overlayOpacity,
        overlayScale: args.overlayScale,
        watermarkPosition: args.watermarkPosition,
        watermarkPath: args.watermarkPath,
        pipWidth: args.pipWidth,
        pipPosition: args.pipPosition,
        splitDirection: args.splitDirection,
        zoomDirection: args.zoomDirection,
        zoomDuration: args.zoomDuration,
        zoomFactor: args.zoomFactor,
        files: args.files,
        bgVolume: args.bgVolume,
        fgVolume: args.fgVolume,
        colorPreset: args.colorPreset,
        lutPath: args.lutPath,
        captionColor: args.captionColor,
        captionFontSize: args.captionFontSize,
        whisperModel: args.whisperModel,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'media_audio_edit': {
      const result = await apiRequest('POST', '/media/audio', {
        input: args.input,
        action: args.action,
        start: args.start,
        end: args.end,
        duration: args.duration,
        format: args.format,
        files: args.files,
        volume: args.volume,
        speedFactor: args.speedFactor,
        fadeType: args.fadeType,
        fadeDuration: args.fadeDuration,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'media_info': {
      const result = await apiRequest('POST', '/media/info', { input: args.input });
      return JSON.stringify(result, null, 2);
    }

    case 'media_video_understand': {
      const result = await apiRequest('POST', '/media/understand', {
        input: args.input,
        frameInterval: args.frameInterval,
        maxFrames: args.maxFrames,
        whisperModel: args.whisperModel,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'media_voice_clone': {
      const result = await apiRequest('POST', '/media/voice-clone', {
        text: args.text,
        refAudio: args.refAudio,
        refText: args.refText,
        pythonBin: args.pythonBin,
        device: args.device,
      });
      return JSON.stringify(result, null, 2);
    }

    // ─── Persistent agent memory ─────────────────────────────────────
    case 'memory': {
      const action = String(args.action || '');
      if (action === 'set') {
        if (!args.content) throw new Error('content is required for action "set"');
        const result = await apiRequest('POST', '/memory', {
          content: args.content,
          title: args.title,
          category: args.category,
          importance: args.importance,
          tags: args.tags,
        });
        return JSON.stringify(result, null, 2);
      }
      if (action === 'get') {
        if (!args.id) throw new Error('id is required for action "get"');
        const result = await apiRequest('GET', `/memory/${encodeURIComponent(String(args.id))}`);
        return JSON.stringify(result, null, 2);
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('id is required for action "delete"');
        const result = await apiRequest('DELETE', `/memory/${encodeURIComponent(String(args.id))}`);
        return JSON.stringify(result, null, 2);
      }
      if (action === 'search' || action === 'list') {
        const query = new URLSearchParams();
        if (action === 'search') {
          if (!args.query) throw new Error('query is required for action "search"');
          query.set('query', String(args.query));
        }
        if (args.category) query.set('category', String(args.category));
        if (args.importance) query.set('importance', String(args.importance));
        if (args.limit) query.set('limit', String(args.limit));
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const result = await apiRequest('GET', `/memory${suffix}`);
        return JSON.stringify(result, null, 2);
      }
      throw new Error('Invalid action. Use: set | get | search | list | delete');
    }

    case 'memory_reflect': {
      if (!args.content) throw new Error('content is required');
      const result = await apiRequest('POST', '/memory/reflect', {
        content: args.content,
        title: args.title,
        importance: args.importance,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'memory_context': {
      const query = new URLSearchParams();
      if (args.query) query.set('query', String(args.query));
      if (args.maxTokens) query.set('maxTokens', String(args.maxTokens));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const result = await apiRequest('GET', `/memory/context${suffix}`);
      return JSON.stringify(result, null, 2);
    }

    case 'memory_stats': {
      const result = await apiRequest('GET', '/memory/stats');
      return JSON.stringify(result, null, 2);
    }

    // ─── Skill library ───────────────────────────────────────────────
    // Skills don't need the API server — they're files on disk read
    // by `@agenticmail/core`'s skill registry. The MCP server is
    // already linked against core, so we just import and call.
    case 'skill_list': {
      const { listSkills } = await import('@agenticmail/core');
      const result = listSkills({
        category: typeof args.category === 'string' ? (args.category as any) : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
      });
      return JSON.stringify({ count: result.length, skills: result }, null, 2);
    }
    case 'skill_search': {
      const { searchSkills } = await import('@agenticmail/core');
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      if (!query) throw new Error('skill_search: `query` is required');
      const result = searchSkills(query, limit);
      return JSON.stringify({ count: result.length, query, skills: result }, null, 2);
    }
    case 'skill_load': {
      const { loadSkill, renderSkillAsPrompt } = await import('@agenticmail/core');
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id) throw new Error('skill_load: `id` is required');
      const skill = loadSkill(id);
      if (!skill) throw new Error(`skill_load: no skill with id "${id}" — call \`skill_list\` to see what's available`);
      // Return BOTH the structured JSON (for programmatic use) and a
      // pre-rendered prompt block (for direct injection into the
      // next call turn's instructions). Agents typically use the
      // rendered form; tooling that wants to operate on the
      // tactics list can parse the JSON instead.
      return JSON.stringify({
        skill,
        rendered_prompt: renderSkillAsPrompt(skill),
      }, null, 2);
    }

    // ─── Meta-tools ──────────────────────────────────────────────────
    case 'request_tools': {
      return renderToolCatalogue({
        query: typeof args.query === 'string' ? args.query : undefined,
        sets: Array.isArray(args.sets) ? (args.sets as string[]) : undefined,
      });
    }
    case 'invoke': {
      const targetTool = args.tool;
      if (typeof targetTool !== 'string' || !targetTool) {
        throw new Error('invoke: `tool` (string) is required.');
      }
      if (targetTool === 'invoke' || targetTool === 'request_tools') {
        // Calling invoke through invoke is a confused-deputy footgun. Refuse
        // explicitly so the agent gets a clear error instead of a confusing
        // recursion or no-op.
        throw new Error(`invoke: cannot invoke the meta-tool "${targetTool}" through invoke.`);
      }
      const rawInner = (args.args ?? {}) as Record<string, unknown>;
      // Allow `_account` to be passed at either the outer level (so it's
      // visually attached to the invoke call) OR inside `args` (so the
      // inner call looks the same as a direct call). The outer level wins
      // if both are supplied; that matches "invoke as Fola" being the
      // explicit operator intent.
      const innerArgs: Record<string, unknown> = { ...rawInner };
      if (typeof args._account === 'string' && args._account) {
        innerArgs._account = args._account;
      }
      // Re-enter the public entrypoint so the `_account` resolution +
      // AsyncLocalStorage context setup happen exactly once and exactly
      // the same way as a direct call. This keeps the auth path single-
      // sourced rather than duplicating the resolution inside invoke.
      return await handleToolCall(targetTool, innerArgs);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Build the human-readable catalogue returned by `request_tools`.
 *
 * Format is deliberately Markdown-ish so it renders well both as a tool
 * response and inside the agent's reasoning. Each set is a heading, each
 * tool a bullet with name + description, truncated to the first sentence
 * to keep the catalogue under ~3K tokens even unfiltered. The agent can
 * always re-call with `query=...` for more detail on a specific tool.
 */
function renderToolCatalogue(opts: { query?: string; sets?: string[] }): string {
  const query = opts.query?.toLowerCase().trim();
  const wantedSets = opts.sets && opts.sets.length > 0 ? new Set(opts.sets) : null;

  // Index tool definitions by name for fast description lookup.
  const byName = new Map<string, { name: string; description: string }>();
  for (const tool of toolDefinitions) {
    byName.set(tool.name, { name: tool.name, description: tool.description ?? '' });
  }

  const matches = (toolName: string): boolean => {
    if (!query) return true;
    const def = byName.get(toolName);
    return toolName.toLowerCase().includes(query)
      || (def?.description.toLowerCase().includes(query) ?? false);
  };

  // First sentence only — keeps catalogue compact. Falls back to whole
  // description if the period detection fails.
  const firstSentence = (s: string): string => {
    const m = s.match(/^([^.!?]+[.!?])/);
    return (m ? m[1] : s).trim();
  };

  const lines: string[] = [];
  let totalShown = 0;

  for (const [setName, description] of Object.entries(SET_DESCRIPTIONS)) {
    if (wantedSets && !wantedSets.has(setName)) continue;
    const toolsInSet = TOOL_SETS[setName as ToolSetName];
    const filtered = toolsInSet.filter(matches);
    if (filtered.length === 0) continue;
    lines.push(`## ${setName} — ${description}`);
    for (const toolName of filtered) {
      const def = byName.get(toolName);
      if (!def) continue;
      lines.push(`- **${toolName}**: ${firstSentence(def.description)}`);
      totalShown++;
    }
    lines.push('');
  }

  // Surface any tools that exist in the runtime but aren't in any set —
  // a soft nudge to come back and categorise them.
  const allCategorised = new Set<string>(Object.keys(TOOL_TO_SET));
  const uncategorised = [...byName.keys()].filter(
    n => !allCategorised.has(n) && n !== 'request_tools' && n !== 'invoke' && matches(n),
  );
  if (uncategorised.length > 0 && !wantedSets) {
    lines.push('## _uncategorised — present in runtime but not yet placed in a set');
    for (const n of uncategorised) {
      const def = byName.get(n);
      lines.push(`- **${n}**: ${firstSentence(def?.description ?? '')}`);
      totalShown++;
    }
    lines.push('');
  }

  if (totalShown === 0) {
    return query
      ? `No tools matched query="${opts.query}". Try a broader term, or call request_tools() with no arguments to see the full catalogue.`
      : 'No tools available.';
  }

  const header = [
    `# AgenticMail tool catalogue (${totalShown} tool${totalShown === 1 ? '' : 's'} shown)`,
    '',
    'Call any tool below with: `invoke({ tool: "<name>", args: { ... }, _account: "<your account>" })`.',
    '',
  ].join('\n');

  return header + lines.join('\n').trimEnd();
}
