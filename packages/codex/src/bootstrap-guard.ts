/**
 * Request guard for the integration bootstrap routes.
 *
 * The install / uninstall / status endpoints write into the operator's
 * home directory and act on AgenticMail with the master key, so they must
 * never run for an unauthenticated remote caller. A request is admitted
 * only when ONE of these holds:
 *
 *   1. It carries `Authorization: Bearer <master key>` (timing-safe match).
 *   2. It is a genuine local bootstrap — a process on this machine talking
 *      to the loopback socket directly:
 *        - the TCP peer is a loopback address;
 *        - the Host header names localhost / 127.0.0.1 / [::1] (defeats
 *          DNS rebinding, where a browser reaches 127.0.0.1 under an
 *          attacker hostname);
 *        - there is no Origin header and no cross-site Sec-Fetch-Site
 *          (defeats any browser-originated request, CSRF included);
 *        - there are no proxy / tunnel forwarding headers (a Cloudflare
 *          quick-tunnel or reverse proxy connects FROM loopback, so the
 *          socket check alone would admit the whole internet).
 *
 * Independently of which branch admitted the request, the body is
 * re-sanitised by {@link sanitizeBootstrapBody}: the caller can never
 * choose the API URL or master key (so the on-disk key is only ever sent
 * to the configured local API), the MCP invocation is restricted to the
 * known AgenticMail MCP commands, and name fields are restricted to a
 * safe character set.
 *
 * This file is intentionally dependency-free (node:crypto only) so it can
 * ship without a lockstep bump of @agenticmail/core.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Minimal request shape so the guard is testable without Express. */
export interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | null;
}

export type GuardDecision =
  | { ok: true; authenticated: boolean }
  | { ok: false; status: 401 | 403; error: string };

/** Headers added by reverse proxies, CDNs and tunnels (cloudflared adds cf-*). */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'x-cluster-client-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
  'cf-warp-tag-id',
  'cdn-loop',
  'via',
];

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function header(req: GuardRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v.join(',');
  return v;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** True when a Host header value is localhost / 127.0.0.1 / [::1], with an optional port. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  let name: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return false;
    name = h.slice(0, end + 1);
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
  } else {
    const parts = h.split(':');
    if (parts.length > 2) return false;
    name = parts[0];
    if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return false;
  }
  return LOOPBACK_HOSTNAMES.has(name);
}

/**
 * Decide whether a bootstrap request may proceed.
 *
 * @param expectedMasterKey the configured master key ('' when none is set,
 *   in which case only the local-bootstrap branch can admit a request).
 */
export function authorizeBootstrapRequest(req: GuardRequest, expectedMasterKey: string): GuardDecision {
  const auth = header(req, 'authorization');
  if (auth !== undefined && auth !== '') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && expectedMasterKey && safeEqual(m[1].trim(), expectedMasterKey)) {
      return { ok: true, authenticated: true };
    }
    return { ok: false, status: 401, error: 'Invalid master key' };
  }

  if (!isLoopbackAddress(req.socket?.remoteAddress ?? undefined)) {
    return { ok: false, status: 403, error: 'Bootstrap without a master key is only allowed from this machine' };
  }
  if (!isLoopbackHostHeader(header(req, 'host'))) {
    return { ok: false, status: 403, error: 'Bootstrap without a master key requires a localhost Host header' };
  }
  const origin = header(req, 'origin');
  if (origin !== undefined) {
    return { ok: false, status: 403, error: 'Browser requests are not allowed on the bootstrap routes' };
  }
  const fetchSite = header(req, 'sec-fetch-site');
  if (fetchSite !== undefined && fetchSite.toLowerCase() !== 'none') {
    return { ok: false, status: 403, error: 'Browser requests are not allowed on the bootstrap routes' };
  }
  for (const h of FORWARDING_HEADERS) {
    if (header(req, h) !== undefined) {
      return { ok: false, status: 403, error: 'Proxied or tunnelled requests require the master key' };
    }
  }
  return { ok: true, authenticated: false };
}

/**
 * The only MCP invocations the HTTP routes will ever write into a host
 * config. Anything else (an arbitrary binary, a shell, extra args) is a
 * command-injection vector and is refused.
 */
export const ALLOWED_MCP_INVOCATIONS: ReadonlyArray<{ command: string; args: readonly string[] }> = [
  { command: 'npx', args: ['-y', '@agenticmail/mcp'] },
  { command: 'agenticmail-mcp', args: [] },
];

export function isAllowedMcpInvocation(command: string, args: readonly string[]): boolean {
  return ALLOWED_MCP_INVOCATIONS.some(
    inv => inv.command === command
      && inv.args.length === args.length
      && inv.args.every((a, i) => a === args[i]),
  );
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_PREFIX = /^[A-Za-z0-9_-]{0,64}$/;

export class BootstrapBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapBodyError';
  }
}

export interface SanitizeOptions {
  /** Path-valued fields (config file / agents dir locations) are honoured only for authenticated callers. */
  authenticated: boolean;
  /** Names of path-valued fields this host accepts. */
  pathFields: readonly string[];
}

/**
 * Re-build a request body from an allowlist. Never forwards `apiUrl` or
 * `masterKey`: the install always talks to the configured local API with
 * the configured key. Throws {@link BootstrapBodyError} for a value that is
 * present but unsafe, so the caller gets a 400 instead of a silent rewrite.
 */
export function sanitizeBootstrapBody(body: unknown, opts: SanitizeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;

  if (opts.authenticated) {
    for (const f of opts.pathFields) {
      if (typeof b[f] === 'string') out[f] = b[f];
    }
  }

  for (const f of ['mcpServerName', 'bridgeAgentName'] as const) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== 'string' || !SAFE_NAME.test(b[f] as string)) {
      throw new BootstrapBodyError(`${f} must match ${SAFE_NAME}`);
    }
    out[f] = b[f];
  }
  if (b.subagentPrefix !== undefined) {
    if (typeof b.subagentPrefix !== 'string' || !SAFE_PREFIX.test(b.subagentPrefix)) {
      throw new BootstrapBodyError(`subagentPrefix must match ${SAFE_PREFIX}`);
    }
    out.subagentPrefix = b.subagentPrefix;
  }

  if (b.mcpCommand !== undefined || b.mcpArgs !== undefined) {
    const command = b.mcpCommand;
    const args = b.mcpArgs ?? [];
    if (typeof command !== 'string'
      || !Array.isArray(args)
      || !args.every(a => typeof a === 'string')
      || !isAllowedMcpInvocation(command, args as string[])) {
      throw new BootstrapBodyError(
        'mcpCommand/mcpArgs must be one of: ' +
        ALLOWED_MCP_INVOCATIONS.map(i => [i.command, ...i.args].join(' ')).join(' | '),
      );
    }
    out.mcpCommand = command;
    out.mcpArgs = [...(args as string[])];
  }
  return out;
}
