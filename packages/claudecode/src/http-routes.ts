/**
 * HTTP routes for the Claude Code integration.
 *
 * Mounted by `@agenticmail/api` (see app.ts) under
 *   /api/agenticmail/integrations/claudecode
 *
 * Purpose: let an agent (Claude Code itself, a shell script, a CI job, …)
 * install the integration with a single POST request, no terminal interaction
 * required.
 *
 * SECURITY MODEL (enforced, not assumed)
 * --------------------------------------
 * Every route runs `authorizeBootstrapRequest` (bootstrap-guard.ts) first.
 * A request is admitted only with `Authorization: Bearer <master key>`, or
 * as a genuine local bootstrap: loopback TCP peer, a localhost Host header
 * (anti DNS-rebinding), no browser Origin / cross-site Sec-Fetch-Site, and
 * no proxy or tunnel forwarding headers (a Cloudflare quick-tunnel connects
 * from loopback, so the socket check alone is not enough).
 *
 * The body is rebuilt from an allowlist: the caller can never pick the API
 * URL or the master key, so the on-disk key is only ever sent to the
 * configured local API; the MCP invocation is limited to the known
 * AgenticMail MCP commands; config-path overrides need the master key.
 */

import { Router, type Request, type Response } from 'express';
import { install } from './install.js';
import { uninstall, type UninstallOptions } from './uninstall.js';
import { status } from './status.js';
import { AgenticMailApiError } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { authorizeBootstrapRequest, sanitizeBootstrapBody, BootstrapBodyError } from './bootstrap-guard.js';

/** Body shape accepted by the install endpoint — every field is optional. */
interface InstallBody extends ResolveConfigOptions {
  // No additional fields; alias for clarity at call sites.
}

interface UninstallBody extends UninstallOptions {
  // No additional fields.
}

const PATH_FIELDS = ['claudeConfigPath', 'agentsDir'] as const;

function sanitizeInstallBody(body: unknown, authenticated: boolean): InstallBody {
  return sanitizeBootstrapBody(body, { authenticated, pathFields: PATH_FIELDS }) as InstallBody;
}

function sanitizeUninstallBody(body: unknown, authenticated: boolean): UninstallBody {
  const base = sanitizeInstallBody(body, authenticated) as UninstallBody;
  if (body && typeof body === 'object' && (body as Record<string, unknown>).purgeBridgeAgent === true) {
    base.purgeBridgeAgent = true;
  }
  return base;
}

/** Translate package errors into HTTP responses. */
function handleError(err: unknown, res: Response): void {
  if (err instanceof BootstrapBodyError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof AgenticMailApiError) {
    // status=0 means we couldn't reach AgenticMail itself — that's a
    // 503 (Service Unavailable) rather than a 500. status>0 is a real
    // upstream HTTP error we can forward.
    const code = err.status === 0 ? 503 : err.status;
    res.status(code).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

/**
 * Build the Express router. Caller mounts at the prefix of its choosing
 * (typically `/api/agenticmail/integrations/claudecode`).
 */
export interface IntegrationRoutesOptions {
  /**
   * The master key the API is running with. Used to authenticate
   * `Authorization: Bearer` callers. When omitted it is read from
   * ~/.agenticmail/config.json on each request.
   */
  masterKey?: string;
}

export function createIntegrationRoutes(opts: IntegrationRoutesOptions = {}): Router {
  const router = Router();
  const expectedKey = (): string => opts.masterKey ?? resolveConfig().masterKey;

  // Gate every bootstrap route. Records whether the caller presented the
  // master key so path overrides can be limited to authenticated callers.
  router.use('/integrations/claudecode', (req: Request, res: Response, next) => {
    const decision = authorizeBootstrapRequest(req, expectedKey());
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }
    res.locals.bootstrapAuthenticated = decision.authenticated;
    next();
  });

  router.get('/integrations/claudecode/status', async (_req: Request, res: Response) => {
    try {
      const result = await status();
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/claudecode/install', async (req: Request, res: Response) => {
    try {
      const body = sanitizeInstallBody(req.body, res.locals.bootstrapAuthenticated === true);
      const result = await install(body);
      // Redact EVERY api key on the way out. The caller is the AgenticMail
      // server itself; the bridge's key has already been written to
      // ~/.claude.json server-side and the other agents' keys belong to
      // those agents — neither needs to ride the response. Returning them
      // over HTTP would multiply their attack surface (logs, transcripts,
      // screenshots) without unlocking any feature the caller is asking
      // for.
      const safeRegisteredAgents = result.registeredAgents.map(a => ({
        ...a, apiKey: '***redacted***',
      }));
      const safeBridge = { ...result.bridgeAgent, apiKey: '***redacted***' };
      res.status(200).json({
        ...result,
        registeredAgents: safeRegisteredAgents,
        bridgeAgent: safeBridge,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/claudecode/uninstall', async (req: Request, res: Response) => {
    try {
      const body = sanitizeUninstallBody(req.body, res.locals.bootstrapAuthenticated === true);
      const result = await uninstall(body);
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
