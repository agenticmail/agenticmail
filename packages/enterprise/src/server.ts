/**
 * AgenticMail Enterprise Server
 * 
 * Hono-based API server with full middleware stack.
 * Production-ready: rate limiting, audit logging, RBAC,
 * health checks, graceful shutdown.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { DatabaseAdapter } from './db/adapter.js';
import { createAdminRoutes } from './admin/routes.js';
import { createAuthRoutes } from './auth/routes.js';
import {
  requestIdMiddleware,
  requestLogger,
  rateLimiter,
  securityHeaders,
  errorHandler,
  auditLogger,
  requireRole,
} from './middleware/index.js';
import { HealthMonitor, CircuitBreaker } from './lib/resilience.js';

export interface ServerConfig {
  port: number;
  db: DatabaseAdapter;
  jwtSecret: string;
  corsOrigins?: string[];
  /** Requests per minute per IP (default: 120) */
  rateLimit?: number;
  /** Trusted proxy IPs for X-Forwarded-For */
  trustedProxies?: string[];
  /** Enable verbose request logging (default: true) */
  logging?: boolean;
}

export interface ServerInstance {
  app: Hono;
  start: () => Promise<{ close: () => void }>;
  healthMonitor: HealthMonitor;
}

export function createServer(config: ServerConfig): ServerInstance {
  const app = new Hono();

  // ─── DB Circuit Breaker ──────────────────────────────

  const dbBreaker = new CircuitBreaker({
    failureThreshold: 5,
    recoveryTimeMs: 30_000,
    timeout: 10_000,
  });

  // ─── Health Monitor ──────────────────────────────────

  const healthMonitor = new HealthMonitor(
    async () => {
      // Simple connectivity check
      await config.db.getStats();
    },
    { intervalMs: 30_000, timeoutMs: 5_000, unhealthyThreshold: 3 },
  );

  healthMonitor.onStatusChange((healthy) => {
    console.log(
      `[${new Date().toISOString()}] ${healthy ? '✅' : '❌'} Database health: ${healthy ? 'healthy' : 'unhealthy'}`,
    );
  });

  // ─── Global Middleware ───────────────────────────────

  // Request ID (first — everything references it)
  app.use('*', requestIdMiddleware());

  // Error handler (wraps everything below)
  app.use('*', errorHandler());

  // Security headers
  app.use('*', securityHeaders());

  // CORS
  app.use('*', cors({
    origin: config.corsOrigins || '*',
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  }));

  // Rate limiting
  app.use('*', rateLimiter({
    limit: config.rateLimit ?? 120,
    windowSec: 60,
    skipPaths: ['/health', '/ready'],
  }));

  // Request logging
  if (config.logging !== false) {
    app.use('*', requestLogger());
  }

  // ─── Health Endpoints ────────────────────────────────

  app.get('/health', (c) => c.json({
    status: 'ok',
    version: '0.1.0',
    uptime: process.uptime(),
  }));

  app.get('/ready', async (c) => {
    const dbHealthy = healthMonitor.isHealthy();
    const status = dbHealthy ? 200 : 503;
    return c.json({
      ready: dbHealthy,
      checks: {
        database: dbHealthy ? 'ok' : 'unhealthy',
        circuitBreaker: dbBreaker.getState(),
      },
    }, status);
  });

  // ─── Auth Routes (public) ───────────────────────────

  const authRoutes = createAuthRoutes(config.db, config.jwtSecret);
  app.route('/auth', authRoutes);

  // ─── Protected API Routes ───────────────────────────

  const api = new Hono();

  // Authentication middleware
  api.use('*', async (c, next) => {
    // Check API key first
    const apiKeyHeader = c.req.header('X-API-Key');
    if (apiKeyHeader) {
      const key = await dbBreaker.execute(() => config.db.validateApiKey(apiKeyHeader));
      if (!key) return c.json({ error: 'Invalid API key' }, 401);
      c.set('userId' as any, key.createdBy);
      c.set('authType' as any, 'api-key');
      c.set('apiKeyScopes' as any, key.scopes);
      return next();
    }

    // JWT auth
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(config.jwtSecret);
      const { payload } = await jwtVerify(authHeader.slice(7), secret);
      c.set('userId' as any, payload.sub);
      c.set('userRole' as any, payload.role);
      c.set('authType' as any, 'jwt');
      return next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });

  // Audit logging on all API mutations
  api.use('*', auditLogger(config.db));

  // Admin routes
  const adminRoutes = createAdminRoutes(config.db);
  api.route('/', adminRoutes);

  app.route('/api', api);

  // ─── 404 Handler ─────────────────────────────────────

  app.notFound((c) => {
    return c.json({ error: 'Not found', path: c.req.path }, 404);
  });

  // ─── Server Start ────────────────────────────────────

  return {
    app,
    healthMonitor,
    start: () => {
      return new Promise((resolve) => {
        const server = serve(
          { fetch: app.fetch, port: config.port },
          (info) => {
            console.log(`\n🏢 AgenticMail Enterprise`);
            console.log(`   API:    http://localhost:${info.port}/api`);
            console.log(`   Auth:   http://localhost:${info.port}/auth`);
            console.log(`   Health: http://localhost:${info.port}/health`);
            console.log('');

            // Start health monitoring
            healthMonitor.start();

            // Graceful shutdown
            const shutdown = () => {
              console.log('\n⏳ Shutting down gracefully...');
              healthMonitor.stop();
              server.close(() => {
                config.db.disconnect().then(() => {
                  console.log('✅ Shutdown complete');
                  process.exit(0);
                });
              });
              // Force exit after 10s
              setTimeout(() => { process.exit(1); }, 10_000).unref();
            };

            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);

            resolve({
              close: () => {
                healthMonitor.stop();
                server.close();
              },
            });
          },
        );
      });
    },
  };
}
