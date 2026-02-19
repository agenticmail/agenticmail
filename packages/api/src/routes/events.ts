import { Router } from 'express';
import type { Response } from 'express';
import {
  InboxWatcher,
  MailReceiver,
  parseEmail,
  scoreEmail,
  isInternalEmail,
  SPAM_THRESHOLD,
  WARNING_THRESHOLD,
  type AccountManager,
  type AgenticMailConfig,
} from '@agenticmail/core';
import { v4 as uuidv4 } from 'uuid';
import { requireAgent, touchActivity } from '../middleware/auth.js';
import { getAgentPassword } from './mail.js';
import { evaluateRules } from './features.js';

const MAX_SSE_PER_AGENT = 5;
const activeWatchers = new Map<string, Set<{ watcher: InboxWatcher; res: Response }>>();

/**
 * Push an event directly to an agent's active SSE connections.
 * Used by the task RPC endpoint to instantly notify the target agent
 * without relying on SMTP email delivery → IMAP IDLE → SSE chain.
 */
export function pushEventToAgent(agentId: string, event: Record<string, unknown>): boolean {
  const watchers = activeWatchers.get(agentId);
  if (!watchers || watchers.size === 0) return false;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const entry of watchers) {
    try { entry.res.write(data); } catch { /* ignore write-after-end */ }
  }
  return true;
}

/**
 * Broadcast an event to ALL active SSE connections.
 * Used as a fallback when the targeted push finds no watchers for the
 * assignee — common when OpenClaw sub-agents act on behalf of a target
 * agent under a different identity.
 */
export function broadcastEvent(event: Record<string, unknown>): number {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  let count = 0;
  for (const [, watchers] of activeWatchers) {
    for (const entry of watchers) {
      try { entry.res.write(data); count++; } catch { /* ignore */ }
    }
  }
  return count;
}

/** Cleanup all active SSE watchers (called on shutdown) */
export async function closeAllWatchers(): Promise<void> {
  for (const [, watchers] of activeWatchers) {
    for (const entry of watchers) {
      try { await entry.watcher.stop(); } catch { /* ignore */ }
      try { entry.res.end(); } catch { /* ignore */ }
    }
  }
  activeWatchers.clear();
}

export function createEventRoutes(accountManager: AccountManager, config: AgenticMailConfig, db?: import('better-sqlite3').Database): Router {
  const router = Router();

  // SSE endpoint for real-time events
  router.get('/events', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const password = getAgentPassword(agent);

      // Enforce per-agent SSE connection limit
      const agentWatchers = activeWatchers.get(agent.id) ?? new Set();
      if (agentWatchers.size >= MAX_SSE_PER_AGENT) {
        res.status(429).json({ error: `Maximum ${MAX_SSE_PER_AGENT} concurrent SSE connections per agent` });
        return;
      }

      // Create and start watcher BEFORE flushing SSE headers
      // so failures produce a normal JSON error response
      const watcher = new InboxWatcher({
        host: config.imap.host,
        port: config.imap.port,
        email: agent.stalwartPrincipal,
        password,
        autoReconnect: true,
        maxReconnectAttempts: 20,
      });

      try {
        await watcher.start();
      } catch (err) {
        res.status(500).json({ error: 'Failed to start event stream: ' + (err instanceof Error ? err.message : String(err)) });
        return;
      }

      // Now set SSE headers (point of no return for JSON error responses)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let closed = false;
      const entry = { watcher, res };

      // Track this connection
      activeWatchers.set(agent.id, agentWatchers);
      agentWatchers.add(entry);

      const safeWrite = (data: string): void => {
        if (!closed) {
          try { res.write(data); } catch { /* ignore write-after-end */ }
        }
      };

      safeWrite(`data: ${JSON.stringify({ type: 'connected', agentId: agent.id })}\n\n`);

      watcher.on('new', async (event) => {
        // Agent is active — receiving events via SSE
        if (db) touchActivity(db, agent.id);

        // Run spam filter + rules if db is available
        if (db && event.uid) {
          try {
            const receiver = new MailReceiver({
              host: config.imap.host, port: config.imap.port,
              email: agent.stalwartPrincipal, password,
              secure: false,
            });
            await receiver.connect();
            try {
              const raw = await receiver.fetchMessage(event.uid);
              const parsed = await parseEmail(raw);

              // --- Spam filter (runs BEFORE rules, skipped for internal emails) ---
              // Relay-delivered emails have X-AgenticMail-Relay header — they are
              // external emails rewritten with @localhost from, so never treat as internal.
              const isRelay = !!parsed.headers.get('x-agenticmail-relay');
              const internal = !isRelay && isInternalEmail(parsed);
              if (internal) {
                // Internal agent-to-agent email — skip spam filter entirely
                const ruleResult = evaluateRules(db, agent.id, parsed);
                if (ruleResult) {
                  const actions = ruleResult.actions;
                  if (actions.mark_read) await receiver.markSeen(event.uid);
                  if (actions.delete) { await receiver.deleteMessage(event.uid); return; }
                  if (actions.move_to) await receiver.moveMessage(event.uid, 'INBOX', actions.move_to);
                  (event as any).ruleApplied = { ruleId: ruleResult.ruleId, actions };
                }
                safeWrite(`data: ${JSON.stringify(event)}\n\n`);
                return;
              }

              const spamResult = scoreEmail(parsed);
              // Log to spam_log
              try {
                db.prepare(
                  'INSERT INTO spam_log (id, agent_id, message_uid, score, flags, category, is_spam) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).run(
                  uuidv4(), agent.id, event.uid, spamResult.score,
                  JSON.stringify(spamResult.matches.map(m => m.ruleId)),
                  spamResult.topCategory, spamResult.isSpam ? 1 : 0,
                );
              } catch { /* ignore log errors */ }

              if (spamResult.isSpam) {
                // Create Spam folder (idempotent) and move message
                try { await receiver.createFolder('Spam'); } catch { /* already exists */ }
                await receiver.moveMessage(event.uid, 'INBOX', 'Spam');
                (event as any).spam = { score: spamResult.score, category: spamResult.topCategory, movedToSpam: true };
                safeWrite(`data: ${JSON.stringify(event)}\n\n`);
                return;
              }
              if (spamResult.isWarning) {
                (event as any).spamWarning = { score: spamResult.score, category: spamResult.topCategory, matches: spamResult.matches.map(m => m.ruleId) };
              }

              // --- Email rules (runs AFTER spam filter) ---
              const ruleResult = evaluateRules(db, agent.id, parsed);
              if (ruleResult) {
                const actions = ruleResult.actions;
                if (actions.mark_read) await receiver.markSeen(event.uid);
                if (actions.delete) { await receiver.deleteMessage(event.uid); return; }
                if (actions.move_to) await receiver.moveMessage(event.uid, 'INBOX', actions.move_to);
                (event as any).ruleApplied = { ruleId: ruleResult.ruleId, actions };
              }
            } finally {
              await receiver.disconnect();
            }
          } catch (err) {
            console.error('[SSE] Spam/rule evaluation error:', (err as Error).message);
          }
        }
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      });

      watcher.on('expunge', (event) => {
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      });

      watcher.on('flags', (event) => {
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      });

      watcher.on('error', (err) => {
        safeWrite(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      });

      watcher.on('reconnecting', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnecting', attempt: info.attempt, delayMs: info.delayMs })}\n\n`);
      });

      watcher.on('reconnected', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnected', attempt: info.attempt })}\n\n`);
      });

      watcher.on('reconnect_failed', (info) => {
        safeWrite(`data: ${JSON.stringify({ type: 'reconnect_failed', attempts: info.attempts })}\n\n`);
      });

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        safeWrite(`: ping\n\n`);
      }, 30000);

      // Cleanup on disconnect
      req.on('close', () => {
        closed = true;
        clearInterval(pingInterval);
        agentWatchers.delete(entry);
        if (agentWatchers.size === 0) activeWatchers.delete(agent.id);
        watcher.removeAllListeners();
        watcher.stop().catch((err) => {
          console.error('[SSE] Watcher cleanup error:', err);
        });
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
