import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { AccountManager, Agent } from '@agenticmail/core';

// Throttle activity tracking to at most once per 60s per agent
const lastActivityUpdate = new Map<string, number>();
const ACTIVITY_THROTTLE_MS = 60_000;

/** Update an agent's last_activity_at (throttled to once per 60s per agent) */
export function touchActivity(db: Database.Database, agentId: string): void {
  const now = Date.now();
  const last = lastActivityUpdate.get(agentId) ?? 0;
  if (now - last > ACTIVITY_THROTTLE_MS) {
    lastActivityUpdate.set(agentId, now);
    try { db.prepare("UPDATE agents SET last_activity_at = datetime('now') WHERE id = ?").run(agentId); } catch { /* ignore */ }
  }
}

declare global {
  namespace Express {
    interface Request {
      agent?: Agent;
      isMaster?: boolean;
    }
  }
}

/** Constant-time string comparison using SHA-256 hashes to prevent length leaking */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createAuthMiddleware(masterKey: string, accountManager: AccountManager, db?: Database.Database) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!token) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Check if master key (reject empty master keys to prevent bypass)
    if (masterKey && safeEqual(token, masterKey)) {
      req.isMaster = true;
      next();
      return;
    }

    // Check if agent API key
    try {
      const agent = await accountManager.getByApiKey(token);
      if (agent) {
        req.agent = agent;
        // Track last activity (throttled)
        if (db) {
          touchActivity(db, agent.id);
        }
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }

    res.status(401).json({ error: 'Invalid API key' });
  };
}

export function requireMaster(req: Request, res: Response, next: NextFunction): void {
  if (!req.isMaster) {
    res.status(403).json({ error: 'Master API key required' });
    return;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.agent && !req.isMaster) {
    res.status(403).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireAgent(req: Request, res: Response, next: NextFunction): void {
  if (!req.agent) {
    res.status(403).json({ error: 'Agent API key required (master key alone is not sufficient)' });
    return;
  }
  next();
}
