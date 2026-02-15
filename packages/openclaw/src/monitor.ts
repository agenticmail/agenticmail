import type { ToolContext } from './tools.js';

/**
 * Create a lightweight health-check service for the email channel.
 *
 * The actual email monitoring and dispatch is handled by the channel's
 * gateway.startAccount() — this service just validates connectivity
 * at startup so the user gets early feedback if their API key is wrong
 * or the server is down.
 */
export function createMailMonitorService(ctx: ToolContext): any {
  return {
    id: 'agenticmail-monitor',

    async start(serviceCtx: any): Promise<void> {
      const logger = serviceCtx?.logger;
      const apiKey = ctx.config.apiKey;

      if (!apiKey) {
        logger?.warn?.('[agenticmail] No API key configured — email features will be limited');
        return;
      }

      // Validate connectivity to AgenticMail API
      try {
        const res = await fetch(`${ctx.config.apiUrl}/api/agenticmail/accounts/me`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });

        if (res.ok) {
          const me: any = await res.json();
          logger?.info?.(`[agenticmail] Connected as ${me?.name ?? 'unknown'} (${me?.email ?? '?'})`);
        } else {
          logger?.warn?.(`[agenticmail] API returned ${res.status} — check your API key`);
        }
      } catch (err) {
        logger?.warn?.(`[agenticmail] Cannot reach API at ${ctx.config.apiUrl}: ${(err as Error).message}`);
        logger?.warn?.('[agenticmail] Start the server with: agenticmail start');
      }
    },

    async stop(serviceCtx: any): Promise<void> {
      serviceCtx?.logger?.info?.('[agenticmail] Service stopped');
    },
  };
}
