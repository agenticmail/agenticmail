import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import {
  resolveConfig,
  getDatabase,
  StalwartAdmin,
  AccountManager,
  DomainManager,
  GatewayManager,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { createAuthMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { createHealthRoutes } from './routes/health.js';
import { createAccountRoutes } from './routes/accounts.js';
import { createMailRoutes } from './routes/mail.js';
import { createInboundRoutes } from './routes/inbound.js';
import { createEventRoutes } from './routes/events.js';
import { createDomainRoutes } from './routes/domains.js';
import { createGatewayRoutes } from './routes/gateway.js';
import { createFeatureRoutes } from './routes/features.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createSmsRoutes } from './routes/sms.js';
import { createStorageRoutes } from './routes/storage.js';
import { createSystemEventRoutes } from './routes/system-events.js';
import { createDispatcherActivityRoutes } from './routes/dispatcher-activity.js';

/**
 * Pre-resolve the Claude Code integration routes at module-load time.
 *
 * The lookup is async (it's an ESM dynamic import) but every consumer of
 * createApp() is synchronous, so we resolve once at the top level and stash
 * the factory in a module-scope binding. `createApp` then mounts the routes
 * synchronously — which matters because Express applies middleware in
 * registration order, and we need these routes to land BEFORE the
 * master-key auth middleware (they ARE the bootstrap path).
 *
 * If the package isn't installed (offline / partial mirror), this resolves
 * to null and createApp just skips the mount.
 */
type IntegrationRouteFactory = () => express.Router;
const integrationRouteFactoryPromise: Promise<IntegrationRouteFactory | null> = (async () => {
  try {
    const mod = await import('@agenticmail/claudecode/http-routes');
    if (typeof mod.createIntegrationRoutes === 'function') {
      return mod.createIntegrationRoutes as IntegrationRouteFactory;
    }
    return null;
  } catch {
    return null;
  }
})();

/**
 * Awaitable that callers of createApp can use to ensure integration routes
 * are mounted. createApp itself is sync; this helper is exported for the
 * index.ts entry point so it can `await prepareIntegrations()` before
 * spinning up the HTTP listener.
 */
export async function prepareIntegrations(): Promise<void> {
  await integrationRouteFactoryPromise;
}

/**
 * Read the resolved value of a Promise synchronously.
 *
 * We rely on Node's internal Promise inspector via a tiny trick: after
 * `await prepareIntegrations()`, the promise is settled, so the next
 * .then attached synchronously into the microtask queue *would* fire
 * before the rest of this function returns IF we used queueMicrotask —
 * but the cleanest cross-runtime sync read is to stash the value into a
 * mutable cell when the promise settles.
 *
 * We set up the cell at module load and update it inside the promise's
 * resolution. By the time createApp runs (after the operator calls
 * prepareIntegrations), the cell is populated.
 */
let __cachedIntegrationFactory: IntegrationRouteFactory | null = null;
let __integrationFactorySettled = false;
integrationRouteFactoryPromise.then(
  (factory) => { __cachedIntegrationFactory = factory; __integrationFactorySettled = true; },
  () => { __integrationFactorySettled = true; },
);
function readResolvedFactory(_p: Promise<IntegrationRouteFactory | null>): IntegrationRouteFactory | null {
  // Best-effort sync read; the caller is expected to have awaited
  // prepareIntegrations beforehand. If the cell isn't populated we
  // fall back to null — meaning the integration mount is skipped,
  // which is the same as the package not being installed.
  if (!__integrationFactorySettled) return null;
  return __cachedIntegrationFactory;
}

export interface AppContext {
  config: AgenticMailConfig;
  db: ReturnType<typeof getDatabase>;
  stalwart: StalwartAdmin;
  accountManager: AccountManager;
  domainManager: DomainManager;
  gatewayManager: GatewayManager;
}

export function createApp(configOverrides?: Partial<AgenticMailConfig>): {
  app: express.Express;
  context: AppContext;
} {
  const config = resolveConfig(configOverrides);
  const db = getDatabase(config);

  const stalwart = new StalwartAdmin({
    url: config.stalwart.url,
    adminUser: config.stalwart.adminUser,
    adminPassword: config.stalwart.adminPassword,
  });

  const accountManager = new AccountManager(db, stalwart);
  const domainManager = new DomainManager(db, stalwart);

  const gatewayManager = new GatewayManager({
    db,
    stalwart,
    accountManager,
    localSmtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.stalwart.adminUser,
      pass: config.stalwart.adminPassword,
    },
    encryptionKey: config.masterKey || undefined,
  });

  const app = express();

  // Global middleware
  app.disable('x-powered-by'); // Remove default Express header
  app.use((_req, res, next) => {
    res.setHeader('X-Powered-By', 'AgenticMail');
    next();
  });
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 10000,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    }),
  );

  // Health route (no auth required)
  app.use('/api/agenticmail', createHealthRoutes(stalwart));

  // Inbound email webhook (uses its own secret-based auth, before bearer auth)
  app.use('/api/agenticmail', createInboundRoutes(accountManager, config, gatewayManager));

  // Integration bootstrap routes — mounted BEFORE bearer auth so a fresh
  // AI agent (Claude Code, etc.) can self-install without having to first
  // know the master key. The factory was resolved at module load (see
  // integrationRouteFactoryPromise above). If the package isn't installed
  // the factory is null and we simply skip mounting.
  // Security note: API binds to 127.0.0.1 by default, so unauthenticated
  // here is no broader than reading ~/.agenticmail/config.json.
  //
  // We use Promise.resolve().then sync-ish: if the promise has already
  // settled (which it has by the time index.ts calls createApp after
  // awaiting prepareIntegrations), the .then callback runs synchronously
  // when chained off an already-resolved promise — BUT Node's microtask
  // semantics still queue it for the next tick, AFTER the rest of this
  // function returns. So we instead peek synchronously by exposing the
  // factory through a sync getter.
  const integrationFactory = readResolvedFactory(integrationRouteFactoryPromise);
  if (integrationFactory) {
    app.use('/api/agenticmail', integrationFactory());
  }

  // Auth middleware for all other API routes
  app.use('/api/agenticmail', createAuthMiddleware(config.masterKey, accountManager, db));

  // API routes
  app.use('/api/agenticmail', createAccountRoutes(accountManager, db, config));
  app.use('/api/agenticmail', createMailRoutes(accountManager, config, db, gatewayManager));
  app.use('/api/agenticmail', createEventRoutes(accountManager, config, db));
  app.use('/api/agenticmail', createDomainRoutes(domainManager));
  app.use('/api/agenticmail', createGatewayRoutes(gatewayManager));
  app.use('/api/agenticmail', createFeatureRoutes(db, accountManager, config, gatewayManager));
  app.use('/api/agenticmail', createTaskRoutes(db, accountManager, config));
  app.use('/api/agenticmail', createSmsRoutes(db, accountManager, config, gatewayManager));
  app.use('/api/agenticmail', createStorageRoutes(db as any, accountManager, config));
  app.use('/api/agenticmail', createSystemEventRoutes());
  app.use('/api/agenticmail', createDispatcherActivityRoutes());

  // 404 handler for unmatched API routes
  app.use('/api/agenticmail', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use(errorHandler);

  const context: AppContext = { config, db, stalwart, accountManager, domainManager, gatewayManager };
  return { app, context };
}
