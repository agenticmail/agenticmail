/**
 * HTTP routes for the Codex integration.
 *
 * Mounted under /api/agenticmail/integrations/codex by a host server.
 *
 * Purpose: let an agent (Codex itself, a shell script, a CI job, …)
 * install the integration with a single POST request.
 *
 * SECURITY MODEL (enforced, not assumed) — identical to
 * @agenticmail/claudecode's http-routes: every route runs
 * `authorizeBootstrapRequest` (bootstrap-guard.ts). A request needs
 * `Authorization: Bearer <master key>`, or must be a genuine local
 * bootstrap (loopback peer, localhost Host header, no browser Origin, no
 * proxy/tunnel forwarding headers). The body is rebuilt from an allowlist:
 * never a caller-chosen API URL or master key, only the known AgenticMail
 * MCP commands, and path overrides only with the master key.
 */

import { Router, type Request, type Response } from 'express';
import { install } from './install.js';
import { uninstall, type UninstallOptions } from './uninstall.js';
import { status } from './status.js';
import { AgenticMailApiError } from './api.js';
import { resolveConfig, type ResolveConfigOptions } from './config.js';
import { authorizeBootstrapRequest, sanitizeBootstrapBody, BootstrapBodyError } from './bootstrap-guard.js';

interface InstallBody extends ResolveConfigOptions {
  // No additional fields; alias for clarity at call sites.
}

interface UninstallBody extends UninstallOptions {
  // No additional fields.
}

/**
 * Filesystem locations (`codexHome`, `agentsDir`) and the MCP launch
 * command are never accepted over HTTP, authenticated or not: they decide
 * which files the server writes and which binary Codex later executes, so
 * they stay CLI/env-only. `apiUrl`/`masterKey` are never forwarded either
 * (see sanitizeBootstrapBody).
 */
const PATH_FIELDS = [] as const;

export function sanitizeInstallBody(body: unknown, authenticated = false): InstallBody {
  return sanitizeBootstrapBody(body, { authenticated, pathFields: PATH_FIELDS }) as InstallBody;
}

function sanitizeUninstallBody(body: unknown, authenticated: boolean): UninstallBody {
  const base = sanitizeInstallBody(body, authenticated) as UninstallBody;
  if (body && typeof body === 'object' && (body as Record<string, unknown>).purgeBridgeAgent === true) {
    base.purgeBridgeAgent = true;
  }
  return base;
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof BootstrapBodyError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof AgenticMailApiError) {
    const code = err.status === 0 ? 503 : err.status;
    res.status(code).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

/**
 * Build the Express router. Caller mounts at the prefix of its choosing
 * (typically `/api/agenticmail`); endpoints land at:
 *
 *   GET  /integrations/codex/status
 *   POST /integrations/codex/install
 *   POST /integrations/codex/uninstall
 */
export interface IntegrationRoutesOptions {
  /**
   * The master key the host API is running with. Used to authenticate
   * `Authorization: Bearer` callers. When omitted it is read from
   * ~/.agenticmail/config.json on each request.
   */
  masterKey?: string;
}

export function createIntegrationRoutes(opts: IntegrationRoutesOptions = {}): Router {
  const router = Router();
  const expectedKey = (): string => opts.masterKey ?? resolveConfig().masterKey;

  router.use('/integrations/codex', (req: Request, res: Response, next) => {
    const decision = authorizeBootstrapRequest(req, expectedKey());
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }
    res.locals.bootstrapAuthenticated = decision.authenticated;
    next();
  });

  router.get('/integrations/codex/status', async (_req: Request, res: Response) => {
    try {
      const result = await status();
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/integrations/codex/install', async (req: Request, res: Response) => {
    try {
      const body = sanitizeInstallBody(req.body, res.locals.bootstrapAuthenticated === true);
      const result = await install(body);
      // Redact every api key on the way out. The bridge's key has already
      // been written to ~/.codex/config.toml server-side and the other
      // agents' keys belong to those agents — neither needs to ride the
      // response. Returning them over HTTP would multiply their attack
      // surface (logs, transcripts, screenshots).
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

  router.post('/integrations/codex/uninstall', async (req: Request, res: Response) => {
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
