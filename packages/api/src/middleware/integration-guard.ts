/**
 * API-side gate in front of the integration bootstrap routers
 * (`/api/agenticmail/integrations/*`).
 *
 * The integration packages (@agenticmail/claudecode, @agenticmail/codex)
 * guard their own routers, but they are optional dependencies that may be
 * installed at an older version. This middleware enforces the same rules
 * at the API layer so the routes are safe regardless of which integration
 * version is mounted:
 *
 *   - a request needs `Authorization: Bearer <master key>`, or must be a
 *     genuine local bootstrap (see bootstrap-guard.ts);
 *   - `apiUrl` and `masterKey` are stripped from the body, so the on-disk
 *     master key is only ever sent to the configured local API;
 *   - `mcpCommand` / `mcpArgs` must be one of the known AgenticMail MCP
 *     invocations;
 *   - config-path overrides are stripped unless the caller authenticated.
 *
 * bootstrap-guard.ts is kept byte-identical to the copies in the
 * claudecode and codex packages (a test enforces it) so each package can
 * ship without a lockstep @agenticmail/core release.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { authorizeBootstrapRequest, isAllowedMcpInvocation, ALLOWED_MCP_INVOCATIONS } from './bootstrap-guard.js';

const PATH_FIELDS = ['claudeConfigPath', 'claudeSettingsPath', 'agentsDir', 'codexHome', 'agenticmailConfigPath'];
const ALWAYS_STRIPPED = ['apiUrl', 'masterKey', 'agenticmailConfigPath'];

export function createIntegrationGuard(masterKey: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const decision = authorizeBootstrapRequest(req, masterKey);
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }

    const body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      for (const f of ALWAYS_STRIPPED) delete b[f];
      if (!decision.authenticated) for (const f of PATH_FIELDS) delete b[f];
      if (b.mcpCommand !== undefined || b.mcpArgs !== undefined) {
        const args = b.mcpArgs ?? [];
        const ok = typeof b.mcpCommand === 'string'
          && Array.isArray(args)
          && args.every(a => typeof a === 'string')
          && isAllowedMcpInvocation(b.mcpCommand, args as string[]);
        if (!ok) {
          res.status(400).json({
            error: 'mcpCommand/mcpArgs must be one of: '
              + ALLOWED_MCP_INVOCATIONS.map(i => [i.command, ...i.args].join(' ')).join(' | '),
          });
          return;
        }
      }
    }
    next();
  };
}
