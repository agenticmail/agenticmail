import { Router } from 'express';
import type { DomainManager } from '@agenticmail/core';
import { requireMaster } from '../middleware/auth.js';

export function createDomainRoutes(domainManager: DomainManager): Router {
  const router = Router();

  // Setup a new domain
  router.post('/domains', requireMaster, async (req, res, next) => {
    try {
      const { domain } = req.body;
      if (!domain) {
        res.status(400).json({ error: 'domain is required' });
        return;
      }

      const result = await domainManager.setup(domain);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // List domains
  router.get('/domains', requireMaster, async (_req, res, next) => {
    try {
      const domains = await domainManager.list();
      res.json({ domains });
    } catch (err) {
      next(err);
    }
  });

  // Get DNS records for a domain
  router.get('/domains/:domain/dns', requireMaster, async (req, res, next) => {
    try {
      const records = await domainManager.getDnsRecords(req.params.domain);
      res.json({ records });
    } catch (err) {
      next(err);
    }
  });

  // Verify domain DNS
  router.post('/domains/:domain/verify', requireMaster, async (req, res, next) => {
    try {
      const verified = await domainManager.verify(req.params.domain);
      res.json({ domain: req.params.domain, verified });
    } catch (err) {
      next(err);
    }
  });

  // Delete domain
  router.delete('/domains/:domain', requireMaster, async (req, res, next) => {
    try {
      const deleted = await domainManager.delete(req.params.domain);
      if (!deleted) {
        res.status(404).json({ error: 'Domain not found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
