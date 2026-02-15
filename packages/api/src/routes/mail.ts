import { Router } from 'express';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  MailSender,
  MailReceiver,
  parseEmail,
  scoreEmail,
  sanitizeEmail,
  isInternalEmail,
  scanOutboundEmail,
  type AccountManager,
  type AgenticMailConfig,
  type Agent,
  type GatewayManager,
} from '@agenticmail/core';
import { requireAgent, requireMaster, requireAuth } from '../middleware/auth.js';

// Cache of sender/receiver per agent with TTL-based eviction
const senderCache = new Map<string, { sender: MailSender; createdAt: number }>();
const receiverCache = new Map<string, { receiver: MailReceiver; createdAt: number }>();
const receiverPending = new Map<string, Promise<MailReceiver>>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 100;
let draining = false;

export function getAgentPassword(agent: Agent): string {
  return (agent.metadata as Record<string, any>)?._password || agent.name;
}

// Run eviction periodically instead of on every access
let evictionTimer: ReturnType<typeof setInterval> | null = null;
function startEvictionTimer(): void {
  if (evictionTimer) return;
  evictionTimer = setInterval(evictStaleEntries, 60_000);
}

function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of senderCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      try { entry.sender.close(); } catch { /* ignore */ }
      senderCache.delete(key);
    }
  }
  for (const [key, entry] of receiverCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      entry.receiver.disconnect().catch(() => {});
      receiverCache.delete(key);
    }
  }
}

function getSender(authUser: string, fromEmail: string, password: string, config: AgenticMailConfig): MailSender {
  if (draining) throw new Error('Server is shutting down');
  // Cache key includes email to handle email changes
  const cacheKey = `${authUser}:${fromEmail}`;
  const cached = senderCache.get(cacheKey);
  if (cached) return cached.sender;

  // Evict oldest if at capacity
  if (senderCache.size >= MAX_CACHE_SIZE) {
    const oldest = senderCache.keys().next().value;
    if (oldest) {
      try { senderCache.get(oldest)?.sender.close(); } catch { /* ignore */ }
      senderCache.delete(oldest);
    }
  }

  const sender = new MailSender({
    host: config.smtp.host,
    port: config.smtp.port,
    email: fromEmail,
    password,
    authUser,
  });
  senderCache.set(cacheKey, { sender, createdAt: Date.now() });
  startEvictionTimer();
  return sender;
}

async function getReceiver(authUser: string, password: string, config: AgenticMailConfig): Promise<MailReceiver> {
  if (draining) throw new Error('Server is shutting down');

  // Check cache for usable connection
  const cached = receiverCache.get(authUser);
  if (cached) {
    try {
      const client = cached.receiver.getImapClient();
      if (client.usable) return cached.receiver;
    } catch { /* fall through to reconnect */ }
    // Stale connection — evict and reconnect
    try { await cached.receiver.disconnect(); } catch { /* ignore */ }
    receiverCache.delete(authUser);
  }

  // Deduplicate concurrent connection attempts for the same agent
  const pending = receiverPending.get(authUser);
  if (pending) return pending;

  const promise = createReceiver(authUser, password, config);
  receiverPending.set(authUser, promise);
  try {
    return await promise;
  } finally {
    receiverPending.delete(authUser);
  }
}

async function createReceiver(authUser: string, password: string, config: AgenticMailConfig): Promise<MailReceiver> {
  // Evict oldest if at capacity
  if (receiverCache.size >= MAX_CACHE_SIZE) {
    const oldest = receiverCache.keys().next().value;
    if (oldest) {
      receiverCache.get(oldest)?.receiver.disconnect().catch(() => {});
      receiverCache.delete(oldest);
    }
  }

  const receiver = new MailReceiver({
    host: config.imap.host,
    port: config.imap.port,
    email: authUser,
    password,
  });

  try {
    await receiver.connect();
  } catch (err) {
    // Clean up on connect failure to avoid leaked sockets
    try { await receiver.disconnect(); } catch { /* ignore */ }
    throw err;
  }

  receiverCache.set(authUser, { receiver, createdAt: Date.now() });
  startEvictionTimer();
  return receiver;
}

/** Cleanup all cached connections (called on shutdown) */
export async function closeCaches(): Promise<void> {
  draining = true;
  if (evictionTimer) { clearInterval(evictionTimer); evictionTimer = null; }
  for (const [, entry] of senderCache) {
    try { entry.sender.close(); } catch { /* ignore */ }
  }
  senderCache.clear();
  for (const [, entry] of receiverCache) {
    try { await entry.receiver.disconnect(); } catch { /* ignore */ }
  }
  receiverCache.clear();
}

/** Append a sent message to the agent's Sent folder (fire-and-forget) */
function saveSentCopy(authUser: string, password: string, config: AgenticMailConfig, raw: Buffer): void {
  (async () => {
    try {
      const receiver = await getReceiver(authUser, password, config);
      await receiver.appendMessage(raw, 'Sent Items', ['\\Seen']);
    } catch (err) {
      // Best-effort — don't let Sent copy failures affect the send response
      console.warn(`[mail] Failed to save Sent copy for ${authUser}: ${(err as Error).message}`);
    }
  })();
}

export function createMailRoutes(accountManager: AccountManager, config: AgenticMailConfig, db: Database.Database, gatewayManager?: GatewayManager): Router {
  const router = Router();

  // Send email
  router.post('/mail/send', requireAgent, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'Request body must be JSON' });
        return;
      }
      const agent = req.agent!;
      const { to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, allowSensitive } = req.body;

      if (!to || !subject) {
        res.status(400).json({ error: 'to and subject are required' });
        return;
      }
      if (typeof to !== 'string' && !Array.isArray(to)) {
        res.status(400).json({ error: 'to must be a string or array of strings' });
        return;
      }

      // Server-side outbound guard — scan unless master key holder explicitly overrides.
      // Agents CANNOT bypass the guard even if they pass allowSensitive=true.
      let outboundWarnings: any[] | undefined;
      let outboundSummary: string | undefined;

      if (!(allowSensitive && req.isMaster)) {
        const scanResult = scanOutboundEmail({
          to: Array.isArray(to) ? to.join(', ') : to,
          subject,
          text,
          html,
          attachments: Array.isArray(attachments)
            ? attachments.map((a: any) => ({
                filename: a.filename || '',
                contentType: a.contentType,
                content: a.content,
                encoding: a.encoding,
              }))
            : undefined,
        });

        if (scanResult.blocked) {
          // Store in pending queue for human-in-the-loop approval
          const pendingId = crypto.randomUUID();
          const ownerName = (agent.metadata as Record<string, any>)?.ownerName;
          const fromName = ownerName ? `${agent.name} from ${ownerName}` : agent.name;
          const mailOptions = { to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, fromName };

          db.prepare(
            `INSERT INTO pending_outbound (id, agent_id, mail_options, warnings, summary) VALUES (?, ?, ?, ?, ?)`,
          ).run(pendingId, agent.id, JSON.stringify(mailOptions), JSON.stringify(scanResult.warnings), scanResult.summary);

          // Notify the owner via email with full email content for review (fire-and-forget)
          if (gatewayManager) {
            const ownerEmail = gatewayManager.getConfig()?.relay?.email;
            if (ownerEmail) {
              const warningList = scanResult.warnings
                .map((w: any) => `  - [${w.severity.toUpperCase()}] ${w.ruleId}: ${w.description}${w.match ? ` (matched: ${w.match})` : ''}`)
                .join('\n');

              // Build a complete preview of the blocked email for review
              const recipientLine = Array.isArray(to) ? to.join(', ') : to;
              const emailPreview: string[] = [
                '─'.repeat(50),
                `From: ${fromName} <${agent.email}>`,
                `To: ${recipientLine}`,
              ];
              if (cc) emailPreview.push(`CC: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
              if (bcc) emailPreview.push(`BCC: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}`);
              emailPreview.push(`Subject: ${subject}`);
              if (Array.isArray(attachments) && attachments.length > 0) {
                const attNames = attachments.map((a: any) => a.filename || 'unnamed').join(', ');
                emailPreview.push(`Attachments: ${attNames}`);
              }
              emailPreview.push('─'.repeat(50));
              if (text) emailPreview.push('', text);
              else if (html) emailPreview.push('', '[HTML content — see original for formatted version]');
              else emailPreview.push('', '[No body content]');
              emailPreview.push('─'.repeat(50));

              gatewayManager.routeOutbound(agent.name, {
                to: ownerEmail,
                subject: `[Approval Required] Blocked email from "${agent.name}" — "${subject}"`,
                text: [
                  `Your agent "${agent.name}" attempted to send an email that was blocked by the outbound security guard.`,
                  '',
                  'SECURITY WARNINGS:',
                  warningList,
                  '',
                  'FULL EMAIL FOR REVIEW:',
                  ...emailPreview,
                  '',
                  `Pending ID: ${pendingId}`,
                  '',
                  'ACTION REQUIRED:',
                  'Reply "approve" to this email to send it, or "reject" to discard it.',
                  'If you do not respond, the agent will follow up with you.',
                ].join('\n'),
                fromName: 'Agentic Mail',
              }).then((result) => {
                // Store the notification messageId so we can match owner replies
                if (result?.messageId) {
                  db.prepare('UPDATE pending_outbound SET notification_message_id = ? WHERE id = ?')
                    .run(result.messageId, pendingId);
                }
              }).catch(() => { /* notification is best-effort */ });
            }
          }

          res.json({
            sent: false,
            blocked: true,
            pendingId,
            warnings: scanResult.warnings,
            summary: scanResult.summary,
          });
          return;
        }

        // Medium warnings — send but include warnings in response
        if (scanResult.warnings.length > 0) {
          outboundWarnings = scanResult.warnings;
          outboundSummary = scanResult.summary;
        }
      }

      // Build display name: "AgentName from OwnerName" or just "AgentName"
      const ownerName = (agent.metadata as Record<string, any>)?.ownerName;
      const fromName = ownerName ? `${agent.name} from ${ownerName}` : agent.name;

      const mailOpts = { to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, fromName };
      const password = getAgentPassword(agent);

      // Try gateway routing first (relay/domain mode for external addresses)
      if (gatewayManager) {
        const gatewayResult = await gatewayManager.routeOutbound(agent.name, mailOpts);
        if (gatewayResult) {
          // Save copy to Sent folder (best-effort — don't fail the send)
          if (gatewayResult.raw) {
            saveSentCopy(agent.stalwartPrincipal, password, config, gatewayResult.raw);
          }
          const { raw: _raw, ...response } = gatewayResult as any;
          res.json({ ...response, ...(outboundWarnings ? { outboundWarnings, outboundSummary } : {}) });
          return;
        }
      }

      // Fallback: send via local Stalwart SMTP
      const sender = getSender(agent.stalwartPrincipal, agent.email, password, config);
      const result = await sender.send(mailOpts);

      // Save copy to Sent folder (best-effort)
      saveSentCopy(agent.stalwartPrincipal, password, config, result.raw);

      const { raw: _raw, ...response } = result;
      res.json({ ...response, ...(outboundWarnings ? { outboundWarnings, outboundSummary } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // List inbox
  router.get('/mail/inbox', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const password = getAgentPassword(agent);

      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const mailboxInfo = await receiver.getMailboxInfo('INBOX');
      const envelopes = await receiver.listEnvelopes('INBOX', { limit, offset });

      res.json({ messages: envelopes, count: envelopes.length, total: mailboxInfo.exists });
    } catch (err) {
      next(err);
    }
  });

  // Read specific message (with sanitization + spam scoring)
  router.get('/mail/messages/:uid', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }

      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const raw = await receiver.fetchMessage(uid, folder);
      const parsed = await parseEmail(raw);

      // Skip spam scoring + sanitization for internal (agent-to-agent) emails
      if (isInternalEmail(parsed)) {
        res.json({
          ...parsed,
          security: { internal: true, spamScore: 0, isSpam: false, isWarning: false },
        });
        return;
      }

      // Sanitize content (strip invisible chars, hidden HTML)
      const sanitized = sanitizeEmail(parsed);
      const spamScore = scoreEmail(parsed);

      res.json({
        ...parsed,
        text: sanitized.text,
        html: sanitized.html,
        security: {
          spamScore: spamScore.score,
          isSpam: spamScore.isSpam,
          isWarning: spamScore.isWarning,
          topCategory: spamScore.topCategory,
          matches: spamScore.matches.map(m => m.ruleId),
          sanitized: sanitized.wasModified,
          sanitizeDetections: sanitized.detections,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Download a specific attachment from a message
  router.get('/mail/messages/:uid/attachments/:index', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      const index = parseInt(req.params.index);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      if (isNaN(index) || index < 0) {
        res.status(400).json({ error: 'Invalid attachment index' });
        return;
      }

      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const raw = await receiver.fetchMessage(uid, folder);
      const parsed = await parseEmail(raw);

      if (!parsed.attachments || index >= parsed.attachments.length) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }

      const att = parsed.attachments[index];
      res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${att.filename.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Length', att.content.length);
      res.send(att.content);
    } catch (err) {
      next(err);
    }
  });

  // Search messages (local inbox; set searchRelay=true to also search connected Gmail/Outlook)
  router.post('/mail/search', requireAgent, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'Request body must be JSON' });
        return;
      }
      const agent = req.agent!;
      const { from, to, subject, since, before, seen, text, searchRelay } = req.body;
      const password = getAgentPassword(agent);

      // Validate date strings
      const sinceDate = since ? new Date(since) : undefined;
      const beforeDate = before ? new Date(before) : undefined;
      if (sinceDate && isNaN(sinceDate.getTime())) {
        res.status(400).json({ error: 'Invalid "since" date' });
        return;
      }
      if (beforeDate && isNaN(beforeDate.getTime())) {
        res.status(400).json({ error: 'Invalid "before" date' });
        return;
      }

      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const uids = await receiver.search({
        from, to, subject, since: sinceDate, before: beforeDate, seen, text,
      });

      // Only search relay when explicitly requested
      let relayResults: any[] | undefined;
      if (searchRelay === true && gatewayManager) {
        try {
          const relayHits = await gatewayManager.searchRelay({
            from, to, subject, text,
            since: sinceDate, before: beforeDate, seen,
          });
          if (relayHits.length > 0) {
            relayResults = relayHits.map(r => ({
              uid: r.uid,
              source: r.source,
              account: r.account,
              messageId: r.messageId,
              subject: r.subject,
              from: r.from,
              to: r.to,
              date: r.date,
              flags: r.flags,
            }));
          }
        } catch {
          // Relay search is best-effort
        }
      }

      res.json({ uids, ...(relayResults ? { relayResults } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // Import a specific email from the connected relay (Gmail/Outlook) into agent's local inbox
  // This downloads the full message and delivers it locally, preserving thread headers
  router.post('/mail/import-relay', requireAgent, async (req, res, next) => {
    try {
      const { uid } = req.body || {};
      if (!uid || typeof uid !== 'number' || uid < 1) {
        res.status(400).json({ error: 'uid (number) is required' });
        return;
      }
      if (!gatewayManager) {
        res.status(400).json({ error: 'No gateway configured' });
        return;
      }

      const agent = req.agent!;
      const result = await gatewayManager.importRelayMessage(uid, agent.name);
      if (!result.success) {
        res.status(400).json({ error: result.error || 'Import failed' });
        return;
      }

      res.json({ ok: true, message: 'Email imported to local inbox. Use /inbox or list_inbox to see it.' });
    } catch (err) {
      next(err);
    }
  });

  // Mark as seen
  router.post('/mail/messages/:uid/seen', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }

      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.markSeen(uid);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Delete message
  router.delete('/mail/messages/:uid', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }

      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.deleteMessage(uid);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // Mark as unseen (unread)
  router.post('/mail/messages/:uid/unseen', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.markUnseen(uid);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Move message to folder
  router.post('/mail/messages/:uid/move', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const { from: fromFolder, to: toFolder } = req.body || {};
      if (!toFolder) {
        res.status(400).json({ error: 'to (destination folder) is required' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.moveMessage(uid, fromFolder || 'INBOX', toFolder);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // List folders
  router.get('/mail/folders', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const folders = await receiver.listFolders();
      res.json({ folders });
    } catch (err) {
      next(err);
    }
  });

  // Create folder
  router.post('/mail/folders', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (name.length > 200 || /[\\*%]/.test(name)) {
        res.status(400).json({ error: 'Invalid folder name' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.createFolder(name);
      res.json({ ok: true, folder: name });
    } catch (err) {
      next(err);
    }
  });

  // List messages in any folder
  router.get('/mail/folders/:folder', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const folder = decodeURIComponent(req.params.folder);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const password = getAgentPassword(agent);

      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);

      let mailboxInfo;
      try {
        mailboxInfo = await receiver.getMailboxInfo(folder);
      } catch {
        // Folder doesn't exist in IMAP — return empty result
        res.json({ messages: [], count: 0, total: 0, folder });
        return;
      }

      const envelopes = await receiver.listEnvelopes(folder, { limit, offset });

      res.json({ messages: envelopes, count: envelopes.length, total: mailboxInfo.exists, folder });
    } catch (err) {
      next(err);
    }
  });

  // Batch delete
  /** Validate and sanitize a UIDs array from request body */
  function validateUids(raw: unknown): number[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    if (raw.length > 1000) return null; // cap at 1000
    const nums = raw.map(Number).filter(n => Number.isInteger(n) && n > 0);
    return nums.length > 0 ? nums : null;
  }

  router.post('/mail/batch/delete', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.batchDelete(uids, folder || 'INBOX');
      res.json({ ok: true, deleted: uids.length });
    } catch (err) {
      next(err);
    }
  });

  // Batch mark seen
  router.post('/mail/batch/seen', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.batchMarkSeen(uids, folder || 'INBOX');
      res.json({ ok: true, marked: uids.length });
    } catch (err) {
      next(err);
    }
  });

  // Batch mark unseen
  router.post('/mail/batch/unseen', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.batchMarkUnseen(uids, folder || 'INBOX');
      res.json({ ok: true, marked: uids.length });
    } catch (err) {
      next(err);
    }
  });

  // Batch move
  router.post('/mail/batch/move', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, from: fromFolder, to: toFolder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      if (!toFolder) {
        res.status(400).json({ error: 'to (destination folder) is required' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.batchMove(uids, fromFolder || 'INBOX', toFolder);
      res.json({ ok: true, moved: uids.length });
    } catch (err) {
      next(err);
    }
  });

  // Batch read — fetch and parse multiple messages in one call
  router.post('/mail/batch/read', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const rawMap = await receiver.batchFetch(uids, folder || 'INBOX');
      const messages: any[] = [];
      for (const [uid, raw] of rawMap) {
        const parsed = await parseEmail(raw);
        messages.push({ uid, ...parsed });
      }
      res.json({ messages, count: messages.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── Spam Management ───

  // List spam folder
  router.get('/mail/spam', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);

      let mailboxInfo;
      try {
        mailboxInfo = await receiver.getMailboxInfo('Spam');
      } catch {
        res.json({ messages: [], count: 0, total: 0, folder: 'Spam' });
        return;
      }

      const envelopes = await receiver.listEnvelopes('Spam', { limit, offset });
      res.json({ messages: envelopes, count: envelopes.length, total: mailboxInfo.exists, folder: 'Spam' });
    } catch (err) {
      next(err);
    }
  });

  // Report as spam — move to Spam folder
  router.post('/mail/messages/:uid/spam', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const folder = req.body?.folder || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      try { await receiver.createFolder('Spam'); } catch { /* already exists */ }
      await receiver.moveMessage(uid, folder, 'Spam');
      res.json({ ok: true, movedToSpam: true });
    } catch (err) {
      next(err);
    }
  });

  // Not spam — move from Spam to INBOX
  router.post('/mail/messages/:uid/not-spam', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.moveMessage(uid, 'Spam', 'INBOX');
      res.json({ ok: true, movedToInbox: true });
    } catch (err) {
      next(err);
    }
  });

  // Get spam score details for a message
  router.get('/mail/messages/:uid/spam-score', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const raw = await receiver.fetchMessage(uid, folder);
      const parsed = await parseEmail(raw);

      // Internal emails always score 0
      if (isInternalEmail(parsed)) {
        res.json({ score: 0, isSpam: false, isWarning: false, matches: [], topCategory: null, internal: true });
        return;
      }

      const result = scoreEmail(parsed);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Inbox digest — envelopes + body preview in a single call
  router.get('/mail/digest', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const previewLen = Math.min(Math.max(parseInt(req.query.previewLength as string) || 200, 50), 500);
      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const mailboxInfo = await receiver.getMailboxInfo(folder);
      const envelopes = await receiver.listEnvelopes(folder, { limit, offset });
      const uids = envelopes.map(e => e.uid);
      const rawMap = uids.length > 0 ? await receiver.batchFetch(uids, folder) : new Map();
      const messages: any[] = [];
      for (const env of envelopes) {
        let preview = '';
        const raw = rawMap.get(env.uid);
        if (raw) {
          const parsed = await parseEmail(raw);
          preview = (parsed.text || '').slice(0, previewLen);
        }
        messages.push({
          uid: env.uid, subject: env.subject,
          from: env.from, to: env.to, date: env.date,
          flags: [...env.flags], size: env.size, preview,
        });
      }
      res.json({ messages, count: messages.length, total: mailboxInfo.exists });
    } catch (err) {
      next(err);
    }
  });

  // ─── Pending Outbound (approval queue) ───

  // List pending outbound emails (agents see own, master sees all)
  router.get('/mail/pending', requireAuth, async (req, res) => {
    const rows = req.isMaster
      ? db.prepare(
          `SELECT id, agent_id, mail_options, warnings, summary, status, created_at, resolved_at, resolved_by
           FROM pending_outbound ORDER BY created_at DESC LIMIT 50`,
        ).all() as any[]
      : db.prepare(
          `SELECT id, agent_id, mail_options, warnings, summary, status, created_at, resolved_at, resolved_by
           FROM pending_outbound WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`,
        ).all(req.agent!.id) as any[];

    const pending = rows.map(r => {
      const opts = JSON.parse(r.mail_options);
      return {
        id: r.id,
        agentId: r.agent_id,
        to: opts.to,
        subject: opts.subject,
        warnings: JSON.parse(r.warnings),
        summary: r.summary,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolvedBy: r.resolved_by,
      };
    });
    res.json({ pending, count: pending.length });
  });

  // Get details of a specific pending email (agents see own, master sees all)
  router.get('/mail/pending/:id', requireAuth, async (req, res) => {
    const row = req.isMaster
      ? db.prepare(`SELECT * FROM pending_outbound WHERE id = ?`).get(req.params.id) as any
      : db.prepare(`SELECT * FROM pending_outbound WHERE id = ? AND agent_id = ?`).get(req.params.id, req.agent!.id) as any;

    if (!row) {
      res.status(404).json({ error: 'Pending email not found' });
      return;
    }
    res.json({
      id: row.id,
      mailOptions: JSON.parse(row.mail_options),
      warnings: JSON.parse(row.warnings),
      summary: row.summary,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
    });
  });

  // Approve a pending email — actually send it (master key only)
  router.post('/mail/pending/:id/approve', requireMaster, async (req, res, next) => {
    try {
      const row = db.prepare(
        `SELECT * FROM pending_outbound WHERE id = ?`,
      ).get(req.params.id) as any;

      if (!row) {
        res.status(404).json({ error: 'Pending email not found' });
        return;
      }
      if (row.status !== 'pending') {
        res.status(400).json({ error: `Email already ${row.status}` });
        return;
      }

      // Look up the agent that originally sent this email
      const agent = await accountManager.getById(row.agent_id);
      if (!agent) {
        res.status(404).json({ error: 'Agent account no longer exists' });
        return;
      }

      const mailOpts = JSON.parse(row.mail_options);

      // Refresh fromName from current agent metadata (in case it changed)
      const ownerName = (agent.metadata as Record<string, any>)?.ownerName;
      mailOpts.fromName = ownerName ? `${agent.name} from ${ownerName}` : agent.name;

      // Reconstitute any JSON-roundtripped Buffer objects in attachments
      if (Array.isArray(mailOpts.attachments)) {
        for (const att of mailOpts.attachments) {
          if (att.content && typeof att.content === 'object' && att.content.type === 'Buffer' && Array.isArray(att.content.data)) {
            att.content = Buffer.from(att.content.data);
          }
        }
      }

      const password = getAgentPassword(agent);

      // Send via gateway or local SMTP
      let response: any;
      if (gatewayManager) {
        const gatewayResult = await gatewayManager.routeOutbound(agent.name, mailOpts);
        if (gatewayResult) {
          if (gatewayResult.raw) {
            saveSentCopy(agent.stalwartPrincipal, password, config, gatewayResult.raw);
          }
          const { raw: _raw, ...rest } = gatewayResult as any;
          response = rest;
        }
      }

      if (!response) {
        const sender = getSender(agent.stalwartPrincipal, agent.email, password, config);
        const result = await sender.send(mailOpts);
        saveSentCopy(agent.stalwartPrincipal, password, config, result.raw);
        const { raw: _raw, ...rest } = result;
        response = rest;
      }

      db.prepare(
        `UPDATE pending_outbound SET status = 'approved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`,
      ).run('master', row.id);

      res.json({ ...response, approved: true, pendingId: row.id });
    } catch (err) {
      next(err);
    }
  });

  // Reject a pending email — discard it (master key only)
  router.post('/mail/pending/:id/reject', requireMaster, async (req, res) => {
    const row = db.prepare(
      `SELECT * FROM pending_outbound WHERE id = ?`,
    ).get(req.params.id) as any;

    if (!row) {
      res.status(404).json({ error: 'Pending email not found' });
      return;
    }
    if (row.status !== 'pending') {
      res.status(400).json({ error: `Email already ${row.status}` });
      return;
    }

    db.prepare(
      `UPDATE pending_outbound SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`,
    ).run('master', row.id);

    res.json({ ok: true, rejected: true, pendingId: row.id });
  });

  return router;
}
