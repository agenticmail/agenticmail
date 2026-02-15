import { Router } from 'express';
import type { StalwartAdmin } from '@agenticmail/core';

export function createHealthRoutes(stalwart: StalwartAdmin): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      const stalwartOk = await stalwart.healthCheck();

      res.status(stalwartOk ? 200 : 503).json({
        status: stalwartOk ? 'ok' : 'degraded',
        services: {
          api: 'ok',
          stalwart: stalwartOk ? 'ok' : 'unreachable',
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({
        status: 'error',
        services: { api: 'ok', stalwart: 'unreachable' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
