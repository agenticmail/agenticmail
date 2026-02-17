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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
    version: '0.3.0',
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

  // Engine routes (skills, permissions, deployment, approvals, lifecycle, KB, etc.)
  // Loaded lazily on first request to avoid top-level await.
  // On first hit, also initializes the EngineDatabase and runs engine migrations.
  let engineInitialized = false;
  api.all('/engine/*', async (c, next) => {
    try {
      const { engineRoutes, setEngineDb } = await import('./engine/routes.js');
      const { EngineDatabase } = await import('./engine/db-adapter.js');

      // Initialize engine DB on first request
      if (!engineInitialized) {
        // Determine dialect from the adapter
        const dbType = (config.db as any).type || (config.db as any).config?.type || 'sqlite';
        const dialectMap: Record<string, string> = {
          sqlite: 'sqlite', postgres: 'postgres', postgresql: 'postgres',
          mysql: 'mysql', mariadb: 'mysql', turso: 'turso', libsql: 'turso',
          mongodb: 'mongodb', dynamodb: 'dynamodb',
        };
        const dialect = (dialectMap[dbType] || 'sqlite') as any;

        // Create an EngineDB wrapper around the existing DatabaseAdapter
        const engineDbWrapper = {
          run: async (sql: string, params?: any[]) => {
            await (config.db as any).run?.(sql, params) ?? (config.db as any).query?.(sql, params);
          },
          get: async <T = any>(sql: string, params?: any[]): Promise<T | undefined> => {
            if ((config.db as any).get) return (config.db as any).get(sql, params);
            const rows = await (config.db as any).query?.(sql, params) ?? [];
            return rows[0];
          },
          all: async <T = any>(sql: string, params?: any[]): Promise<T[]> => {
            if ((config.db as any).all) return (config.db as any).all(sql, params);
            return await (config.db as any).query?.(sql, params) ?? [];
          },
        };

        const engineDb = new EngineDatabase(engineDbWrapper, dialect, (config.db as any).rawDriver);
        const migrationResult = await engineDb.migrate();
        console.log(`[engine] Migrations: ${migrationResult.applied} applied, ${migrationResult.total} total`);
        setEngineDb(engineDb);
        engineInitialized = true;
      }

      // Forward to engine routes
      const subPath = c.req.path.replace(/^\/api\/engine/, '') || '/';
      const subReq = new Request(new URL(subPath, 'http://localhost'), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      });
      return engineRoutes.fetch(subReq);
    } catch (e: any) {
      console.error('[engine] Error:', e.message);
      return c.json({ error: 'Engine module not available', detail: e.message }, 501);
    }
  });

  app.route('/api', api);

  // ─── Dashboard (Admin UI) ─────────────────────────────

  let dashboardHtml: string | null = null;
  function getDashboardHtml(): string {
    if (!dashboardHtml) {
      try {
        const dir = dirname(fileURLToPath(import.meta.url));
        dashboardHtml = readFileSync(join(dir, 'dashboard', 'index.html'), 'utf-8');
      } catch {
        // Fallback: try relative to cwd
        try {
          dashboardHtml = readFileSync(join(process.cwd(), 'node_modules', '@agenticmail', 'enterprise', 'dist', 'dashboard', 'index.html'), 'utf-8');
        } catch {
          dashboardHtml = '<html><body><h1>Dashboard not found</h1><p>The dashboard HTML file could not be located.</p></body></html>';
        }
      }
    }
    return dashboardHtml;
  }

  app.get('/', (c) => c.redirect('/dashboard'));
  app.get('/dashboard', (c) => c.html(getDashboardHtml()));
  app.get('/dashboard/*', (c) => c.html(getDashboardHtml()));

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
