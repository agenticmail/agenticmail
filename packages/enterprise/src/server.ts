/**
 * AgenticMail Enterprise Server
 * 
 * Hono-based API server + static admin dashboard.
 * Runs as a single process — deploy anywhere.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DatabaseAdapter } from './db/adapter.js';
import { createAdminRoutes } from './admin/routes.js';
import { createAuthRoutes } from './auth/routes.js';

export interface ServerConfig {
  port: number;
  db: DatabaseAdapter;
  jwtSecret: string;
  corsOrigins?: string[];
  staticDir?: string;  // Path to built admin UI
}

export function createServer(config: ServerConfig) {
  const app = new Hono();

  // Global middleware
  app.use('*', cors({
    origin: config.corsOrigins || '*',
    credentials: true,
  }));

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

  // Auth routes (login, SAML callback, OIDC callback)
  const authRoutes = createAuthRoutes(config.db, config.jwtSecret);
  app.route('/auth', authRoutes);

  // Protected API routes
  const api = new Hono();
  api.use('*', async (c, next) => {
    // Check for API key first
    const apiKeyHeader = c.req.header('X-API-Key');
    if (apiKeyHeader) {
      const key = await config.db.validateApiKey(apiKeyHeader);
      if (!key) return c.json({ error: 'Invalid API key' }, 401);
      c.set('userId' as any, key.createdBy);
      c.set('authType' as any, 'api-key');
      return next();
    }
    // Fall back to JWT
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    try {
      const { default: jose } = await import('jose');
      const secret = new TextEncoder().encode(config.jwtSecret);
      const { payload } = await jose.jwtVerify(authHeader.slice(7), secret);
      c.set('userId' as any, payload.sub);
      c.set('userRole' as any, payload.role);
      c.set('authType' as any, 'jwt');
      return next();
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
  });

  const adminRoutes = createAdminRoutes(config.db);
  api.route('/', adminRoutes);
  app.route('/api', api);

  // Serve static admin UI
  if (config.staticDir) {
    app.use('/*', serveStatic({ root: config.staticDir }));
    // SPA fallback
    app.get('*', serveStatic({ root: config.staticDir, path: 'index.html' }));
  }

  return {
    app,
    start: () => {
      serve({ fetch: app.fetch, port: config.port }, (info) => {
        console.log(`\n🏢 AgenticMail Enterprise running on http://localhost:${info.port}`);
      });
    },
  };
}
