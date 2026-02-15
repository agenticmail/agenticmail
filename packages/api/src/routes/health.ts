import { Router } from 'express';
import type { StalwartAdmin } from '@agenticmail/core';

const ABOUT = {
  name: 'AgenticMail',
  version: '0.2.26',
  description: 'Email infrastructure for AI agents — send, receive, coordinate, and automate email with full DKIM/SPF/DMARC authentication.',
  author: {
    name: 'Ope Olatunji',
    github: 'https://github.com/ope-olatunji',
  },
  license: 'MIT',
  repository: 'https://github.com/ope-olatunji/agenticmail',
};

export function createHealthRoutes(stalwart: StalwartAdmin): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      const stalwartOk = await stalwart.healthCheck();

      res.status(stalwartOk ? 200 : 503).json({
        status: stalwartOk ? 'ok' : 'degraded',
        version: ABOUT.version,
        services: {
          api: 'ok',
          stalwart: stalwartOk ? 'ok' : 'unreachable',
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({
        status: 'error',
        version: ABOUT.version,
        services: { api: 'ok', stalwart: 'unreachable' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/about', (_req, res) => {
    res.json(ABOUT);
  });

  return router;
}
