/**
 * CORS policy for the AgenticMail API.
 *
 * The bundled web UI is served from the API's own origin, so it needs no
 * CORS at all. Cross-origin browser access is therefore OFF by default:
 * no `Access-Control-Allow-Origin` header is ever sent for an origin that
 * is not explicitly listed. Operators who front the API with a separate
 * browser app list its exact origins in `AGENTICMAIL_CORS_ORIGINS`
 * (comma-separated, e.g. `https://mail.example.com,http://localhost:5173`).
 *
 * There is no wildcard and no origin reflection: a `*` entry is ignored.
 */

import cors from 'cors';
import type { RequestHandler } from 'express';

export function parseCorsOrigins(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const v = part.trim().replace(/\/+$/, '');
    if (!v || v === '*' || v === 'null') continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      out.add(u.origin);
    } catch {
      /* ignore malformed entries */
    }
  }
  return out;
}

export function createCorsPolicy(allowedOrigins: Set<string>): RequestHandler {
  return cors({
    origin: (origin, cb) => cb(null, typeof origin === 'string' && allowedOrigins.has(origin)),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }) as RequestHandler;
}
