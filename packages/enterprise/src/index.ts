/**
 * AgenticMail Enterprise
 * 
 * Cloud-hosted AI agent identity, email, auth & compliance for organizations.
 */

// Database
export { DatabaseAdapter, type DatabaseConfig, type DatabaseType } from './db/adapter.js';
export type { Agent, AgentInput, User, UserInput, AuditEvent, AuditFilters } from './db/adapter.js';
export type { ApiKey, ApiKeyInput, EmailRule, RetentionPolicy, CompanySettings } from './db/adapter.js';
export { createAdapter, getSupportedDatabases } from './db/factory.js';

// Server
export { createServer, type ServerConfig } from './server.js';

// Deploy
export { deployToCloud, generateDockerCompose, generateFlyToml } from './deploy/managed.js';

// Routes (for custom server setups)
export { createAdminRoutes } from './admin/routes.js';
export { createAuthRoutes } from './auth/routes.js';
