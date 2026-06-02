#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toolDefinitions, handleToolCall } from './tools.js';
import { resourceDefinitions, handleResourceRead } from './resources.js';
import { setTelemetryVersion } from '@agenticmail/core';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { z, type ZodTypeAny } from 'zod';
import { coerceToArray, coerceToObject, coerceToNumber, coerceToBoolean } from './coerce.js';

setTelemetryVersion('0.5.55');

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema | undefined>;
  required?: string[];
  items?: JsonSchema;
};

function jsonSchemaToZod(schema: JsonSchema | undefined, topLevel = false): Record<string, ZodTypeAny> | ZodTypeAny {
  if (!schema || typeof schema !== 'object') return topLevel ? {} : z.any();

  let result: ZodTypeAny;
  if (schema.type === 'string') {
    result = schema.enum?.length ? z.enum(schema.enum as [string, ...string[]]) : z.string();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    // Accept stringified numbers — "42" → 42 — because LLM tool-call
    // surfaces routinely stringify scalars.
    result = z.preprocess(coerceToNumber, z.number());
  } else if (schema.type === 'boolean') {
    // Accept the dozen ways LLMs spell booleans.
    result = z.preprocess(coerceToBoolean, z.boolean());
  } else if (schema.type === 'array') {
    // When `items` is missing or empty, default to `z.any()` so the
    // tool still accepts heterogeneous arrays at runtime — several
    // existing tools pass arrays of objects without an items
    // declaration (db_admin's columns/rows/operations etc.) and a
    // string-only fallback would silently reject them. Strict
    // OpenAI-compatible validators still want explicit items
    // upstream — those are now declared per-field in tools.ts so
    // the runtime fallback is just defence-in-depth for new tools.
    const hasItems = !!schema.items && typeof schema.items === 'object' && Object.keys(schema.items).length > 0;
    const inner = z.array(hasItems ? jsonSchemaToZod(schema.items, false) as ZodTypeAny : z.any());
    // Accept JSON-string arrays + CSV — see coerceToArray for the
    // failure mode this guards against (batch_mark_read({ uids:
    // "[1,2,3]" }) being a Claude-Code default mistake).
    const itemKind = schema.items?.type;
    result = z.preprocess(v => coerceToArray(v, itemKind), inner);
  } else if (schema.type === 'object') {
    // Free-form object (no declared properties) → z.record(z.any())
    // so callers can pass arbitrary keys. db_admin's `where`,
    // `set`, and `column` are all free-form by design — turning
    // them into z.object({}) would reject every real call.
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      if (topLevel) return {};
      result = z.preprocess(coerceToObject, z.record(z.string(), z.any()));
    } else {
      const shape: Record<string, ZodTypeAny> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, prop] of Object.entries(schema.properties)) {
        let child = jsonSchemaToZod(prop, false) as ZodTypeAny;
        if (!required.has(key)) child = child.optional();
        shape[key] = child;
      }
      if (topLevel) return shape;
      result = z.preprocess(coerceToObject, z.object(shape));
    }
  } else {
    result = z.any();
  }

  return schema.description ? result.describe(schema.description) : result;
}

/**
 * Server-level instructions, sent on `initialize` to every connecting client
 * (Claude Code, ChatGPT, Cursor, Grok, Aider, custom MCP hosts — anyone).
 *
 * This is the ONLY surface guaranteed to be in the host LLM's context the
 * first time it touches AgenticMail. Every other piece of guidance (tool
 * descriptions, subagent persona files, README) only fires once the LLM is
 * already mid-task. The single most common mistake we keep seeing in the
 * wild is the host session reflexively spawning a native sub-agent / tool
 * to ROLEPLAY AS the AgenticMail agents it just created — instead of
 * trusting AgenticMail's own RPC + dispatcher to wake the real agents.
 * So we lead with that, in provider-agnostic language.
 */
const SERVER_INSTRUCTIONS = [
  '🎀 AgenticMail — multi-agent email + SMS infrastructure.',
  '',
  'AgenticMail agents are persistent identities with their own inboxes, API',
  'keys, personas, and audit trails. They coordinate the way humans do: in',
  'email threads, with every participant CC\'d, taking turns implicitly from',
  'context. Address other agents through AgenticMail\'s own primitives —',
  'never roleplay them inside your host\'s native sub-agent / sub-task tool.',
  '',
  '════════════════════════════════════════════════════════════════════════',
  'PREFERRED PATTERN: Single thread, CC everyone, agents take turns',
  '════════════════════════════════════════════════════════════════════════',
  '',
  'This is how a human boss coordinates a small team — and it is the right',
  'pattern for multi-agent work. One email thread is the shared workspace.',
  '',
  '1. Decide who participates.',
  '     • `list_agents()` — find existing identities',
  '     • `create_account({ name, role, ... })` — spawn fresh ones',
  '',
  '2. Send ONE kickoff email with all participants on To / CC:',
  '',
  '       send_email({',
  '         to: "vesper@localhost",                         // primary owner of step 1',
  '         cc: "orion@localhost, claudecode@localhost",     // teammates + yourself',
  '         subject: "Build a small terminal game",',
  '         wake: ["vesper"],                                // only Vesper gets a host turn',
  '         text: [',
  '           "Team —",',
  '           "",',
  '           "Vesper, please design a minimal terminal game (under ~80 LOC).",',
  '           "Reply-all with the design doc when ready.",',
  '           "",',
  '           "Orion, once Vesper signs off, implement it and reply-all with the code.",',
  '           "",',
  '           "I (the host) will watch the thread and step in if needed.",',
  '         ].join("\\n"),',
  '       })',
  '',
  '   The `wake` parameter is the SINGLE BIGGEST TOKEN SAVER on large threads.',
  '   Without it, every CC\'d recipient burns one host turn deciding whether',
  '   it is their turn. With it, only the named agents get a turn — the rest',
  '   receive the mail in their inbox but stay asleep until you (or another',
  '   agent) explicitly names them in a later `wake` list. Pass `wake: []`',
  '   for "deliver silently — wake nobody". Omit `wake` entirely to keep the',
  '   old "wake every CC\'d agent" behaviour (backwards compatible).',
  '',
  '   The mail server pushes a wake-up to every local recipient simultaneously.',
  '   Each agent reads the thread, decides if it is THEIR turn, and either',
  '   reply-all\'s to contribute or stays silent. Vesper goes first because she',
  '   was named first; Orion stays silent until Vesper hands off; you (the',
  '   host) see every reply land in your bridge inbox.',
  '',
  '3. Watch progress from the HOST session. The bridge inbox is yours to',
  '   monitor — the dispatcher does NOT spawn an autonomous worker for the',
  '   bridge (that would compete with you). Pick your monitoring style:',
  '     • `wait_for_email({ timeout? })` — blocks the current turn (push-',
  '         based, SSE-driven) until the next event lands in your inbox.',
  '         Best when you want a single-shot "ping me when anything new',
  '         arrives". Pair with `read_email` afterwards.',
  '     • `list_inbox()` + `read_email({ uid })` — explicit poll. Best when',
  '         the user is actively driving the conversation turn-by-turn.',
  '     • `search_emails({ subject })` — load the full thread at any point.',
  '   To unblock a stuck agent or change direction, just reply-all into the',
  '   same thread.',
  '',
  '4. **Close the thread when work is complete.** Send a wrap-up reply',
  '   with one of these markers in the subject: `[FINAL]`, `[DONE]`,',
  '   `[CLOSED]`, or `[WRAP]`. The dispatcher honours those markers and',
  '   stops waking workers on any further replies to that thread. Without',
  '   this, the cascade can keep firing as agents critique each other\'s',
  '   work even after the deliverables are in. Add the marker once, the',
  '   thread is sealed.',
  '',
  '5. Done when the last hand-off (or an explicit "complete" message) lands',
  '   in your inbox. Show the result to the user.',
  '',
  'Why this is right:',
  '  • Every agent has FULL context every time they wake (they read the thread).',
  '  • Turn-taking is implicit; no scheduler, no RPC ceremony.',
  '  • The thread is searchable history. The host (you) sees everything.',
  '  • Bringing in another teammate later is just adding them to CC.',
  '',
  '════════════════════════════════════════════════════════════════════════',
  'When to use one-shot RPC instead',
  '════════════════════════════════════════════════════════════════════════',
  '',
  '`call_agent({ target, task, timeout? })` is still the right tool when:',
  '  • You need ONE structured answer from ONE agent and no multi-step work.',
  '  • You need the result inline in your current call (not async).',
  '  • The work is short and there is no useful "thread" to share.',
  '',
  'For multi-step / multi-agent coordination — use the thread pattern above.',
  'For fire-and-forget handoffs to a single agent — `message_agent` is fine.',
  '',
  '════════════════════════════════════════════════════════════════════════',
  'What NOT to do (regardless of host — Claude Code, ChatGPT, Cursor, Grok)',
  '════════════════════════════════════════════════════════════════════════',
  '',
  '✗ Do NOT spawn a native sub-agent / sub-task tool of your host and tell',
  '  it to "act as Vesper" / "write as Orion". That produces output under',
  '  YOUR identity, never reaches the named agent\'s inbox, and bypasses',
  '  their persona, signatures, outbound guard, and audit trail.',
  '✗ Do NOT compose an agent\'s reply yourself in the host session and then',
  '  `send_email` it on their behalf. Let the real agent reply from their',
  '  own mailbox (via the thread pattern, or via call_agent for RPC).',
  '✗ Do NOT pass `_account: "<other-agent>"` to act AS another agent. That',
  '  falsifies the From: header.',
  '✗ Do NOT serialise the work yourself ("first I call_agent Vesper, get her',
  '  result, then I call_agent Orion with her result"). That works but it',
  '  is fragile, slow, and burns one full host turn per hop. The thread',
  '  pattern lets the agents drive their own handoffs.',
  '',
  '════════════════════════════════════════════════════════════════════════',
  'Identity (`_account`) & tool surface',
  '════════════════════════════════════════════════════════════════════════',
  '',
  'Every tool call accepts optional `_account: "<agent-name>"` to scope the',
  'call to a specific identity. From the host, omit it to use the bridge',
  'identity, or pass it to read/write a specific agent\'s mailbox directly.',
  'From inside an agent\'s own context, ALWAYS pass `_account: "<self>"`.',
  '',
  'Tool surface: ~100 tools across email, SMS, phone, Telegram, contacts,',
  'drafts, templates, rules, tags, search, scheduling, RPC. Only ~10 are',
  'pre-loaded; the rest are reachable via `request_tools` (discover) +',
  '`invoke` (call).',
].join('\n');

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: '🎀 AgenticMail',
      version: '0.2.30',
      description: '🎀 AgenticMail — Email infrastructure for AI agents. By Ope Olatunji (https://github.com/agenticmail/agenticmail)',
    } as any,
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Register tools.
  //
  // Every tool's input schema is augmented with an optional `_account` param
  // so callers can override the identity used for that single call (see
  // tools.ts → handleToolCall). Without this augmentation, Zod's default
  // "strip unknown keys" behaviour would drop `_account` before our handler
  // ever saw it — which silently degrades back to the static API_KEY and
  // makes the per-call account switching look like a no-op. Augmenting the
  // schema (rather than swapping to `z.record(z.any())` or `.passthrough()`)
  // also has the nice side effect of making `_account` discoverable in the
  // tool surface that the MCP client publishes to the LLM.
  const ACCOUNT_PROP = {
    type: 'string',
    description: 'Optional. Override identity for THIS call: pass the AgenticMail agent name (e.g. "Fola") to authenticate as that agent. Requires AGENTICMAIL_ACCOUNT_KEYS_JSON to contain a matching key. Omit to use the default identity (AGENTICMAIL_API_KEY).',
  } as const;

  for (const tool of toolDefinitions) {
    const augmentedSchema: JsonSchema = {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema?.properties ?? {}),
        _account: ACCOUNT_PROP,
      },
    };
    server.tool(
      tool.name,
      tool.description,
      jsonSchemaToZod(augmentedSchema, true) as any,
      async (args: Record<string, unknown>) => {
        try {
          const result = await handleToolCall(tool.name, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: result }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  // Register resources
  for (const resource of resourceDefinitions) {
    server.resource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async () => {
        try {
          const content = await handleResourceRead(resource.uri);
          return {
            contents: [{ uri: resource.uri, text: content, mimeType: resource.mimeType }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            contents: [{ uri: resource.uri, text: `Error: ${message}`, mimeType: 'text/plain' }],
          };
        }
      },
    );
  }

  return server;
}

// Parse CLI args
const args = process.argv.slice(2);
const httpFlag = args.includes('--http');
const portArg = args.find(a => a.startsWith('--port='));
const hostArg = args.find(a => a.startsWith('--host='));
const tokenArg = args.find(a => a.startsWith('--token='));
const insecureFlag = args.includes('--insecure');
const httpPort = portArg ? parseInt(portArg.split('=')[1], 10) : (parseInt(process.env.MCP_PORT || '', 10) || 8014);
// Default-bind to loopback. Override with --host=0.0.0.0 or MCP_HTTP_HOST
// to expose on other interfaces. Historical behavior (pre-fix for
// GHSA-63gr-g7jc-v8rg) was to bind all interfaces, which exposed the
// admin-tool surface to the LAN.
const httpHost = hostArg ? hostArg.split('=')[1] : (process.env.MCP_HTTP_HOST || '127.0.0.1');

/**
 * Resolve the bearer token required to call /mcp in HTTP mode.
 *
 * Resolution order:
 *   1. --token=<value> CLI flag
 *   2. MCP_HTTP_TOKEN env var
 *   3. Persistent file at ~/.agenticmail/mcp-http-token (auto-minted on
 *      first run, chmod 600). Survives restarts so a user can wire the
 *      token into their MCP client config once and forget it.
 *
 * Returns null only when --insecure is passed. That flag is the explicit
 * opt-out and prints a loud warning at startup so it can't happen by
 * accident.
 */
function resolveHttpToken(): string | null {
  if (insecureFlag) return null;
  if (tokenArg) return tokenArg.split('=').slice(1).join('=');
  if (process.env.MCP_HTTP_TOKEN) return process.env.MCP_HTTP_TOKEN;
  const dir = joinPath(homedir(), '.agenticmail');
  const file = joinPath(dir, 'mcp-http-token');
  if (existsSync(file)) {
    try {
      const t = readFileSync(file, 'utf8').trim();
      if (t) return t;
    } catch { /* fall through to mint */ }
  }
  const minted = 'mcphttp_' + randomUUID().replace(/-/g, '');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, minted + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    console.error('[agenticmail-mcp] WARN: could not persist auth token to', file, '—', (err as Error).message);
  }
  return minted;
}

/**
 * Constant-time bearer-token check. Returns true iff the request carries
 * `Authorization: Bearer ***`. Length-safe so an attacker can't
 * distinguish "wrong token" from "wrong length" via timing.
 */
function checkAuth(req: import('node:http').IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

if (httpFlag || process.env.MCP_HTTP === '1') {
  // ─── HTTP/Streamable HTTP Transport ───────────────────────────────
  // Supports both SSE streaming and direct JSON responses per MCP spec.
  // Usage: agenticmail-mcp --http [--port=8014] [--host=127.0.0.1]
  //        [--token=<bearer>] [--insecure]
  //
  // Security model (post-GHSA-63gr-g7jc-v8rg):
  //   - Binds to 127.0.0.1 by default so the admin-tool surface is not
  //     reachable from other hosts on the network.
  //   - Requires `Authorization: Bearer ***` on every /mcp request.
  //     Token is auto-minted on first run and stored at
  //     ~/.agenticmail/mcp-http-token (chmod 600). Override with
  //     MCP_HTTP_TOKEN or --token=.
  //   - --insecure disables both bind-restriction warnings and the auth
  //     check. Reserved for sandboxed test environments only.
  const authToken = resolveHttpToken();
  const server = createMcpServer();

  // Map of session ID -> transport for stateful connections
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${httpPort}`);
    const path = url.pathname;

    // Health check
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', sessions: transports.size }));
      return;
    }

    // Only handle /mcp endpoint
    if (path !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is POST /mcp' }));
      return;
    }

    // Authentication gate — every /mcp request (POST/GET/DELETE) must
    // present the bearer token. Skipped only when --insecure was passed
    // (authToken === null), which is logged loudly at startup.
    if (authToken !== null && !checkAuth(req, authToken)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="agenticmail-mcp"',
      });
      res.end(JSON.stringify({
        error: 'Unauthorized. Send Authorization: Bearer <token>. ' +
               'Token is at ~/.agenticmail/mcp-http-token or in MCP_HTTP_TOKEN.',
      }));
      return;
    }

    // Handle DELETE for session termination
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      }
      return;
    }

    // Handle GET for SSE stream (session resumption)
    if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID for SSE stream. Send a POST /mcp with initialize first.' }));
      }
      return;
    }

    // Handle POST for JSON-RPC messages
    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create transport and connect
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) transports.delete(sid);
      };

      // Connect a new server instance per session
      const sessionServer = createMcpServer();
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // Other methods
    res.writeHead(405, { 'Allow': 'GET, POST, DELETE', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST /mcp for JSON-RPC, GET /mcp for SSE stream.' }));
  });

  httpServer.listen(httpPort, httpHost, () => {
    const displayHost = httpHost === '0.0.0.0' || httpHost === '::' ? 'localhost' : httpHost;
    console.log(`🎀 AgenticMail MCP Server (Streamable HTTP)`);
    console.log(`   Endpoint: http://${displayHost}:${httpPort}/mcp`);
    console.log(`   Health:   http://${displayHost}:${httpPort}/health`);
    console.log(`   Bind:     ${httpHost}`);
    console.log(`   Transport: Streamable HTTP (SSE + JSON responses)`);
    if (authToken === null) {
      console.log('');
      console.log('   ⚠️  --insecure: bearer-token auth DISABLED on /mcp.');
      console.log('   ⚠️  Anyone who can reach the port can call master-key tools.');
      console.log('   ⚠️  Do not run this mode on untrusted networks.');
    } else {
      console.log(`   Auth:     Bearer token required on /mcp`);
      console.log('');
      console.log('   Connect an MCP client with:');
      console.log(`     Authorization: Bearer <token>`);
      if (httpHost !== '127.0.0.1' && httpHost !== 'localhost' && httpHost !== '::1') {
        console.log('');
        console.log(`   ⚠️  Bound to ${httpHost} — endpoint is reachable from the network.`);
        console.log('   ⚠️  Make sure the bearer token above is treated as a secret.');
      }
    }
  });

  // Graceful shutdown
  async function shutdown() {
    for (const transport of transports.values()) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

} else {
  // ─── Stdio Transport (default) ────────────────────────────────────
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error('[agenticmail-mcp] Failed to start:', err);
    process.exit(1);
  }

  async function shutdown() {
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}
