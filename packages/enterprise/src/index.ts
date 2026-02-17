/**
 * AgenticMail Enterprise
 * 
 * Cloud-hosted AI agent identity, email, auth & compliance for organizations.
 * 
 * @example
 * ```ts
 * import { createAdapter, createServer } from '@agenticmail/enterprise';
 * 
 * const db = await createAdapter({ type: 'postgres', connectionString: '...' });
 * await db.migrate();
 * 
 * const server = createServer({ port: 3000, db, jwtSecret: '...' });
 * await server.start();
 * ```
 */

// Database
export { DatabaseAdapter } from './db/adapter.js';
export type {
  DatabaseConfig, DatabaseType,
  Agent, AgentInput, User, UserInput,
  AuditEvent, AuditFilters, ApiKey, ApiKeyInput,
  EmailRule, RetentionPolicy, CompanySettings,
} from './db/adapter.js';
export { createAdapter, getSupportedDatabases } from './db/factory.js';

// Server
export { createServer } from './server.js';
export type { ServerConfig, ServerInstance } from './server.js';

// Deploy
export { deployToCloud, generateDockerCompose, generateFlyToml } from './deploy/managed.js';

// Routes (for custom server setups)
export { createAdminRoutes } from './admin/routes.js';
export { createAuthRoutes } from './auth/routes.js';

// Middleware (for extending the server)
export {
  requestIdMiddleware,
  requestLogger,
  rateLimiter,
  securityHeaders,
  errorHandler,
  auditLogger,
  requireRole,
  validate,
  ValidationError,
} from './middleware/index.js';

// Engine (managed agent deployment platform)
export * from './engine/index.js';

// Resilience (for custom integrations)
export {
  withRetry,
  CircuitBreaker,
  RateLimiter,
  KeyedRateLimiter,
  HealthMonitor,
  CircuitOpenError,
} from './lib/resilience.js';
export type { RetryOptions, CircuitBreakerOptions, RateLimiterOptions, HealthCheckOptions } from './lib/resilience.js';
