/**
 * Enterprise Middleware Stack
 * 
 * Rate limiting, request logging, error handling, validation,
 * CORS, request IDs, and security headers.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import { KeyedRateLimiter, requestId } from '../lib/resilience.js';
import type { DatabaseAdapter } from '../db/adapter.js';

// ─── Request ID ──────────────────────────────────────────

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const id = c.req.header('X-Request-Id') || requestId();
    c.set('requestId' as any, id);
    c.header('X-Request-Id', id);
    await next();
  };
}

// ─── Request Logging ─────────────────────────────────────

export function requestLogger(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    await next();

    const elapsed = Date.now() - start;
    const status = c.res.status;
    const reqId = c.get('requestId' as any) || '-';

    // Structured log line
    const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    console.log(
      `[${new Date().toISOString()}] ${level} ${method} ${path} ${status} ${elapsed}ms req=${reqId}`,
    );
  };
}

// ─── Rate Limiting ───────────────────────────────────────

interface RateLimitConfig {
  /** Requests per window */
  limit: number;
  /** Window in seconds */
  windowSec: number;
  /** Key extractor (default: IP) */
  keyFn?: (c: Context) => string;
  /** Skip rate limiting for these paths */
  skipPaths?: string[];
}

export function rateLimiter(config: RateLimitConfig): MiddlewareHandler {
  const limiter = new KeyedRateLimiter({
    maxTokens: config.limit,
    refillRate: config.limit / config.windowSec,
  });

  return async (c: Context, next: Next) => {
    // Skip health checks
    if (config.skipPaths?.some(p => c.req.path.startsWith(p))) {
      return next();
    }

    const key = config.keyFn?.(c) ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'unknown';

    if (!limiter.tryConsume(key)) {
      const retryAfter = Math.ceil(limiter.getRetryAfterMs(key) / 1000);
      c.header('Retry-After', String(retryAfter));
      c.header('X-RateLimit-Limit', String(config.limit));
      c.header('X-RateLimit-Remaining', '0');
      return c.json(
        { error: 'Too many requests', retryAfter },
        429,
      );
    }

    await next();
  };
}

// ─── Security Headers ────────────────────────────────────

export function securityHeaders(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    await next();

    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '0'); // Modern browsers: CSP is better
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Only set HSTS if behind TLS
    if (c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https') {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  };
}

// ─── Error Handler ───────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

export function errorHandler(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (err: any) {
      const reqId = c.get('requestId' as any);
      const status = err.status || err.statusCode || 500;
      const message = status >= 500 ? 'Internal server error' : err.message;

      // Log full error for 5xx
      if (status >= 500) {
        console.error(`[${new Date().toISOString()}] ERROR req=${reqId}`, err);
      }

      const body: ApiError = {
        error: message,
        code: err.code,
        requestId: reqId,
      };

      // Include validation details for 400s
      if (status === 400 && err.details) {
        body.details = err.details;
      }

      return c.json(body, status);
    }
  };
}

// ─── Input Validation ────────────────────────────────────

export class ValidationError extends Error {
  status = 400;
  code = 'VALIDATION_ERROR';
  details: Record<string, string>;

  constructor(details: Record<string, string>) {
    const fields = Object.keys(details).join(', ');
    super(`Validation failed: ${fields}`);
    this.details = details;
  }
}

type Validator = {
  field: string;
  type: 'string' | 'number' | 'boolean' | 'email' | 'url' | 'uuid';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
};

export function validate(body: Record<string, any>, validators: Validator[]): void {
  const errors: Record<string, string> = {};

  for (const v of validators) {
    const value = body[v.field];

    if (value === undefined || value === null || value === '') {
      if (v.required) errors[v.field] = 'Required';
      continue;
    }

    switch (v.type) {
      case 'string':
        if (typeof value !== 'string') { errors[v.field] = 'Must be a string'; break; }
        if (v.minLength && value.length < v.minLength) errors[v.field] = `Min length: ${v.minLength}`;
        if (v.maxLength && value.length > v.maxLength) errors[v.field] = `Max length: ${v.maxLength}`;
        if (v.pattern && !v.pattern.test(value)) errors[v.field] = 'Invalid format';
        break;
      case 'number':
        if (typeof value !== 'number' || isNaN(value)) { errors[v.field] = 'Must be a number'; break; }
        if (v.min !== undefined && value < v.min) errors[v.field] = `Min: ${v.min}`;
        if (v.max !== undefined && value > v.max) errors[v.field] = `Max: ${v.max}`;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors[v.field] = 'Must be a boolean';
        break;
      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          errors[v.field] = 'Invalid email';
        break;
      case 'url':
        try { new URL(value); } catch { errors[v.field] = 'Invalid URL'; }
        break;
      case 'uuid':
        if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
          errors[v.field] = 'Invalid UUID';
        break;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
}

// ─── Audit Logger Middleware ─────────────────────────────

export function auditLogger(db: DatabaseAdapter): MiddlewareHandler {
  // Only audit mutating operations
  const AUDIT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return async (c: Context, next: Next) => {
    await next();

    if (!AUDIT_METHODS.has(c.req.method)) return;
    if (c.res.status >= 400) return; // Don't audit failed requests

    try {
      const userId = c.get('userId' as any) || 'anonymous';
      const path = c.req.path;
      const method = c.req.method;

      // Derive action from path + method
      const segments = path.split('/').filter(Boolean);
      const resource = segments[segments.length - 2] || segments[segments.length - 1] || 'unknown';
      const actionMap: Record<string, string> = {
        POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete',
      };
      const action = `${resource}.${actionMap[method] || method.toLowerCase()}`;

      await db.logEvent({
        actor: userId,
        actorType: 'user',
        action,
        resource: path,
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip'),
      });
    } catch {
      // Never let audit logging break the request
    }
  };
}

// ─── RBAC Middleware ─────────────────────────────────────

type Role = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function requireRole(minRole: Role): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const userRole = c.get('userRole' as any) as Role | undefined;

    // API keys bypass role check (scopes handle auth)
    if (c.get('authType' as any) === 'api-key') {
      return next();
    }

    if (!userRole || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minRole]) {
      return c.json({
        error: 'Insufficient permissions',
        required: minRole,
        current: userRole || 'none',
      }, 403);
    }

    return next();
  };
}
