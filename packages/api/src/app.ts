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
  });

  const app = express();

  // Global middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    }),
  );

  // Health route (no auth required)
  app.use('/api/agenticmail', createHealthRoutes(stalwart));

  // Inbound email webhook (uses its own secret-based auth, before bearer auth)
  app.use('/api/agenticmail', createInboundRoutes(accountManager, config, gatewayManager));

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

  // 404 handler for unmatched API routes
  app.use('/api/agenticmail', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use(errorHandler);

  const context: AppContext = { config, db, stalwart, accountManager, domainManager, gatewayManager };
  return { app, context };
}
