import { Router } from 'express';
import crypto from 'node:crypto';
import type { Database } from '@agenticmail/core';
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
import { pushEventToAgent } from './events.js';

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

export async function getReceiver(authUser: string, password: string, config: AgenticMailConfig): Promise<MailReceiver> {
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

// ─────────────────────────────────────────────────────────────────────────
// Issue #24 — SSE 'new' event missing for INTERNAL agent-to-agent mail.
//
// Root cause: When agent A authenticates over SMTP submission and the
// recipient is local (test-beta@localhost), Stalwart 0.15.5 routes the
// message through its internal store path. Empirically this delivery
// completes (the message appears in test-beta's INBOX on subsequent
// IMAP fetches) but does NOT push an unsolicited EXISTS notification
// to test-beta's outstanding IDLE session. As a result the InboxWatcher
// (whose lock-release fix from #16 is correct and remains intact) never
// sees `'exists'` and never emits `'new'` to the SSE bus.
//
// Why we don't paper over this with a polling fallback: the codebase
// already has the right architectural primitive — `pushEventToAgent`
// in routes/events.ts (used by the task RPC endpoint, see its docstring:
// "without relying on SMTP email delivery → IMAP IDLE → SSE chain").
// For internal mail we know the recipient agent at send time, so we can
// short-circuit the IDLE chain and push the SSE event directly when the
// SMTP send returns 200. External mail is unchanged and continues to
// flow through IMAP IDLE (which #16 fixed and which works correctly
// for inbound from outside the local Stalwart instance).
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// Issue #29 — SSE 'new' event emitted uid:0 for internal mail.
//
// The #24 fix pushed a doorbell-style event the instant POST /mail/send
// returned 200, but at that moment the recipient's IMAP store hasn't
// finished indexing the message — we don't know the UID yet, so we used
// 0 as a sentinel. Consumers that try to FETCH using that UID either
// fail or hit the wrong message. Instead of emitting a sentinel we now
// briefly poll the recipient's INBOX for the Message-ID we just sent
// (200ms, 400, 600, 800 — capped at ~2s total) and emit the event with
// the real UID. Falls back to 0 only if the lookup actually fails — but
// we surface a `lookup: 'failed'` flag in that case so consumers can
// distinguish "lookup didn't finish" from "this is the real UID 0".
// ─────────────────────────────────────────────────────────────────────────
export async function findUidByMessageId(
  receiver: MailReceiver,
  messageId: string,
  maxAttempts = 8,
): Promise<number> {
  // Issue #32 — 0.5.61's lookup ran with a 2 s budget and used IMAP
  // header-search exclusively. In practice Stalwart 0.15.5 doesn't
  // make a freshly delivered internal message visible to header-search
  // until several seconds after delivery, so the lookup almost always
  // returned 0 with `uidLookup: 'failed'`. The mail IS in INBOX from
  // moment one — `GET /mail/inbox` shows it — but Stalwart's search
  // index lags. Two changes:
  //
  //   1. Bigger budget: 8 attempts at 250/500/750/1000/1250/1500/2000ms
  //      → cap at ~7 s wall-clock, plenty for Stalwart's index to catch
  //      up while still capping latency for legitimate misses.
  //   2. Two-prong lookup: try header-search first (fast when it
  //      works) and fall back to enumerating the last 10 UIDs in INBOX
  //      and matching their `messageId` envelope field. The fallback
  //      doesn't depend on the search index — it just walks recent
  //      mail. nodemailer returns Message-IDs WITH angle brackets
  //      (`<id@host>`); Stalwart stores the same form, but we
  //      normalize both sides anyway so an extra/missing pair of
  //      brackets can't cause a false negative.
  const target = normalizeMessageId(messageId);
  const client = receiver.getImapClient();

  const tryHeaderSearch = async (): Promise<number> => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const results = await client.search(
        { header: ['Message-ID', messageId] },
        { uid: true },
      );
      if (Array.isArray(results) && results.length > 0) {
        return results[results.length - 1];
      }
    } finally {
      lock.release();
    }
    return 0;
  };

  const tryEnvelopeScan = async (): Promise<number> => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Pull the last 10 UIDs by sequence and check their envelopes.
      const status = await client.status('INBOX', { messages: true });
      const total = status?.messages ?? 0;
      if (total === 0) return 0;
      const start = Math.max(1, total - 9);
      const range = `${start}:${total}`;
      let bestUid = 0;
      for await (const msg of client.fetch(range, { uid: true, envelope: true })) {
        if (!msg.envelope?.messageId) continue;
        if (normalizeMessageId(msg.envelope.messageId) === target) {
          // Keep iterating — we want the highest UID match.
          if (msg.uid > bestUid) bestUid = msg.uid;
        }
      }
      return bestUid;
    } finally {
      lock.release();
    }
  };

  // Backoff schedule (ms before attempt 2..N): 250, 500, 750, 1000, 1250, 1500, 2000.
  const delays = [0, 250, 500, 750, 1000, 1250, 1500, 2000];
  for (let i = 0; i < maxAttempts; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const headerHit = await tryHeaderSearch();
      if (headerHit > 0) return headerHit;
      // Search may not have indexed yet; try the envelope scan.
      const scanHit = await tryEnvelopeScan();
      if (scanHit > 0) return scanHit;
    } catch (err) {
      // Last-attempt failure surfaces in the route's `console.warn`;
      // intermediate failures retry silently.
      if (i === maxAttempts - 1) {
        console.warn(`[mail] findUidByMessageId attempt ${i + 1} failed for ${messageId}: ${(err as Error).message}`);
      }
    }
  }
  return 0;
}

function normalizeMessageId(id: string | undefined): string {
  if (!id) return '';
  return id.trim().replace(/^<+|>+$/g, '').toLowerCase();
}

/**
 * Normalise a `wake` value (string or string[]) into the canonical
 * lowercased bare-name list the SSE event and the X-AgenticMail-Wake
 * header expect. Returns undefined if the input is undefined/null, so
 * callers can distinguish "wake all CC'd" (undefined) from "wake nobody"
 * (empty array) cleanly.
 *
 * Exported so the templates route and the pending-approve route can
 * apply the same normalisation as POST /mail/send.
 */
/**
 * Sentinel `wake` value the sender can pass to opt back into the
 * pre-0.9.0 behaviour ("wake every CC'd recipient"). Useful for
 * notification-style broadcasts where every recipient really
 * should get a Claude turn (rare).
 */
export const WAKE_ALL_SENTINEL = '__wake_all__';

export function normalizeWakeList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'all' || value === WAKE_ALL_SENTINEL) return undefined; // opt-out: no allowlist filtering
  const strip = (s: string) => s.trim().replace(/@localhost$/i, '').toLowerCase();
  if (Array.isArray(value)) return value.map(v => strip(String(v))).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(strip).filter(Boolean);
  return undefined;
}

/**
 * Default wake list derived from the `to` field — local
 * @localhost recipients only. CC'd local agents do NOT
 * appear in the default wake list, mirroring the email
 * convention that To is for action and CC is for awareness.
 *
 * Behaviour:
 *   - sender passes explicit `wake: [...]` → use that
 *   - sender passes `wake: 'all'`           → no allowlist (every CC wakes)
 *   - sender omits `wake` entirely          → derive from To (this fn)
 *
 * Returns undefined when `to` doesn't contain any local
 * recipients; the caller treats that as "no allowlist"
 * (the wake decision falls through to the default-from-
 * scratch path, which for external `to` addresses means
 * no local wakes anyway).
 */
export function deriveDefaultWakeList(toField: string | string[] | undefined): string[] | undefined {
  if (!toField) return undefined;
  const arr = Array.isArray(toField) ? toField : String(toField).split(',');
  const localNames: string[] = [];
  for (const raw of arr) {
    // Extract the bare address FIRST, before the `endsWith('@localhost')`
    // check — display-name forms like `"Vesper <vesper@localhost>"`
    // end with `>`, not `@localhost`, and would otherwise be
    // skipped entirely. This previously caused `deriveDefaultWakeList`
    // to return undefined on display-name addressing, falling
    // through to "no allowlist" → everyone wakes. The new default
    // semantics need to survive that case.
    const trimmed = String(raw).trim().toLowerCase();
    const m = trimmed.match(/<([^>]+)>/);
    const bare = (m ? m[1] : trimmed).trim();
    if (!bare.endsWith('@localhost')) continue;
    const name = bare.replace(/@localhost$/i, '');
    if (name) localNames.push(name);
  }
  return localNames.length > 0 ? localNames : undefined;
}

/**
 * Build the SMTP `headers` map from a normalised wake list. Centralised
 * so every send path produces the same header format.
 */
export function wakeHeaders(wakeList: string[] | undefined): Record<string, string> {
  if (wakeList === undefined) return {};
  return { 'X-AgenticMail-Wake': wakeList.join(', ') };
}

// Re-export so template + pending-approve routes can push to SSE the
// same way POST /mail/send does. The fn name signal-bumps that this
// is the right primitive to use for "I just sent local mail, notify
// the dispatcher" — not new HTTP plumbing.
export { notifyLocalRecipientsOfNewMail as pushLocalRecipientWakes };

async function notifyLocalRecipientsOfNewMail(
  accountManager: AccountManager,
  toField: string | string[] | undefined,
  ccField: string | string[] | undefined,
  bccField: string | string[] | undefined,
  fromAgent: Agent,
  subject: string,
  messageId: string | undefined,
  config: AgenticMailConfig,
  /**
   * Optional wake allowlist. When set, the SSE event carries
   * `wakeAllowlist` so the @agenticmail/claudecode dispatcher can
   * decide whether to actually spawn a worker for each recipient.
   * Mail is delivered to every CC'd inbox regardless — only the
   * "should the agent get a Claude turn" decision is gated.
   *
   * Names are pre-normalised by the route (lowercased, @localhost
   * stripped). Empty array means "wake nobody"; undefined means
   * "use the default wake-all-CC'd behaviour".
   */
  wakeList?: string[],
): Promise<void> {
  const collected: string[] = [];
  const push = (v: string | string[] | undefined): void => {
    if (!v) return;
    if (Array.isArray(v)) collected.push(...v);
    else collected.push(v);
  };
  push(toField); push(ccField); push(bccField);

  // Extract bare addresses from each field SEPARATELY so the SSE
  // event can carry per-recipient "were you on To, Cc, or Bcc?"
  // metadata. The dispatcher uses this to honor a recipient's
  // wake_on_cc:false preference — agents that opt out of CC wakes
  // only need their `to` check to see "is my address on To?".
  const addrRe = /<([^>]+)>|([^\s,;<>]+@[^\s,;<>]+)/g;
  function extractAddrs(v: string | string[] | undefined): string[] {
    if (!v) return [];
    const items = Array.isArray(v) ? v : [v];
    const out = new Set<string>();
    for (const entry of items) {
      let match: RegExpExecArray | null;
      addrRe.lastIndex = 0;
      while ((match = addrRe.exec(entry)) !== null) {
        const a = (match[1] || match[2] || '').trim().toLowerCase();
        if (a) out.add(a);
      }
    }
    return Array.from(out);
  }
  const toAddrs  = extractAddrs(toField);
  const ccAddrs  = extractAddrs(ccField);
  const bccAddrs = extractAddrs(bccField);
  const addresses = new Set<string>([...toAddrs, ...ccAddrs, ...bccAddrs]);
  // Convert each to bare local name for the per-recipient check.
  const toLocalNames = new Set(toAddrs.filter(a => a.endsWith('@localhost')).map(a => a.replace(/@localhost$/i, '')));

  const notified = new Set<string>();
  for (const addr of addresses) {
    const at = addr.indexOf('@');
    if (at < 0) continue;
    const localPart = addr.slice(0, at);
    const domain = addr.slice(at + 1);
    // Only fire for local recipients (Stalwart's default domain is localhost).
    if (domain !== 'localhost') continue;
    // Don't notify the sender of their own send.
    if (addr === fromAgent.email.toLowerCase()) continue;

    let recipient: Agent | null = null;
    try {
      recipient = await accountManager.getByName(localPart);
    } catch { /* lookup is best-effort */ }
    if (!recipient || notified.has(recipient.id)) continue;
    notified.add(recipient.id);

    // Look up the real IMAP UID for this Message-ID before emitting.
    // We open (or reuse) the recipient's MailReceiver — same primitive
    // every other route uses — and search INBOX by Message-ID with a
    // small retry budget (Stalwart sometimes doesn't have the message
    // visible to IMAP for a few hundred ms after SMTP submission).
    let uid = 0;
    let lookup: 'resolved' | 'failed' | 'no-message-id' = 'no-message-id';
    if (messageId) {
      try {
        const recipientPassword = getAgentPassword(recipient);
        const receiver = await getReceiver(
          recipient.stalwartPrincipal,
          recipientPassword,
          config,
        );
        uid = await findUidByMessageId(receiver, messageId);
        lookup = uid > 0 ? 'resolved' : 'failed';
      } catch {
        lookup = 'failed';
      }
    }

    // Tell the dispatcher whether THIS recipient was on `To:` or
    // only on CC/Bcc. Used by the per-agent wake_on_cc preference
    // (an agent with wake_on_cc:false skips wakes when it's not
    // on To, regardless of the sender's wake list).
    const wasOnTo = toLocalNames.has(recipient.name.toLowerCase());

    pushEventToAgent(recipient.id, {
      type: 'new',
      uid,
      // Tell consumers whether the UID is real or a sentinel — preserves
      // backwards compat (uid is still always a number) while giving
      // clients a reliable signal to fall back to /mail/inbox.
      uidLookup: lookup,
      internal: true,
      from: { name: fromAgent.name, address: fromAgent.email },
      subject,
      messageId,
      // Wake gating signal. Present iff the sender opted in. The
      // dispatcher reads this and spawns a Claude worker only for
      // recipients whose name is on the list (or for everyone if the
      // field is absent, preserving the v0.8.x default).
      ...(wakeList !== undefined ? { wakeAllowlist: wakeList } : {}),
      // Per-recipient "was I on To?" flag for wake_on_cc honoring.
      // The dispatcher uses this combined with account.wakeOnCc to
      // decide whether to skip a CC-only delivery.
      wasOnTo,
    });
  }
}

/**
 * Append a sent message to the agent's Sent folder (fire-and-forget).
 *
 * Auto-discovers the correct folder name instead of hard-coding
 * 'Sent Items'. Different mail servers use different names —
 * Stalwart defaults to `Sent`, Outlook installs often `Sent Items`,
 * macOS Mail can mount it as `Sent Messages`. Before this lookup,
 * the hard-coded name would silently fail on every server that
 * didn't match, leaving an empty Sent folder. The first match
 * is cached on the IMAP capability set so we only pay the
 * listFolders cost once per process.
 */
const sentFolderCache = new Map<string, string>(); // authUser → folder path
async function saveSentCopy(authUser: string, password: string, config: AgenticMailConfig, raw: Buffer): Promise<void> {
  try {
    const receiver = await getReceiver(authUser, password, config);
    let folder = sentFolderCache.get(authUser);
    if (!folder) {
      const folders = await receiver.listFolders();
      const sentRe = /^sent\b|sent items|sent mail|sent messages|\[gmail\]\/sent/i;
      folder = folders.find(f => f.specialUse === '\\Sent')?.path
        ?? folders.find(f => sentRe.test(f.name) || sentRe.test(f.path))?.path
        ?? 'Sent Items';   // last-resort fallback
      sentFolderCache.set(authUser, folder);
    }
    await receiver.appendMessage(raw, folder, ['\\Seen']);
  } catch (err) {
    // Best-effort — don't let Sent copy failures affect the send response
    console.warn(`[mail] Failed to save Sent copy for ${authUser}: ${(err as Error).message}`);
  }
}

export function createMailRoutes(accountManager: AccountManager, config: AgenticMailConfig, db: Database, gatewayManager?: GatewayManager): Router {
  const router = Router();

  // Send email
  router.post('/mail/send', requireAgent, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'Request body must be JSON' });
        return;
      }
      const agent = req.agent!;
      const { to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, allowSensitive, wake } = req.body;

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
          // Persist the wake intent so it survives the approval round-trip —
          // otherwise an outbound-guard-blocked mail loses its wake list
          // when the owner later approves it, and every CC'd recipient
          // gets a Claude turn even though the sender wanted just one.
          // Same 0.9.0 default-from-To derivation as the unguarded
           // send path. When the sender omitted `wake`, persist the
           // implicit To-only allowlist so an approved outbound
           // matches what the unguarded path would have sent.
          const explicitWakeForPersist = normalizeWakeList(wake);
          const wakeListForPersist = wake === undefined ? deriveDefaultWakeList(to) : explicitWakeForPersist;
          const mailOptions: Record<string, unknown> = {
            to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, fromName,
            ...(wakeListForPersist !== undefined ? { wakeList: wakeListForPersist } : {}),
          };

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

      // Normalise the wake list and build the outgoing header in one
      // place — every send path uses the same primitives.
      //
      // 0.9.0 default: if the sender omitted `wake`, derive an
      // implicit allowlist from local `To:` recipients only. CC'd
      // local agents receive the mail in their inbox but do NOT
      // get a Claude wake unless the sender explicitly names them.
      // This matches the email convention "To is for action; CC is
      // for awareness" and stops the wake-thrash failure mode on
      // multi-CC threads. Sender can opt back to "wake everyone"
      // with `wake: 'all'`.
      const explicitWake = normalizeWakeList(wake);
      const wakeList = wake === undefined ? deriveDefaultWakeList(to) : explicitWake;
      const customHeaders = wakeHeaders(wakeList);

      const mailOpts = {
        to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, attachments, fromName,
        ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
      };
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

      // Issue #24 — push SSE 'new' event directly to local recipients.
      // Stalwart 0.15.5 doesn't reliably push EXISTS to IDLE'd sessions
      // for messages it locally-delivered from authenticated submission,
      // so the watcher chain never fires for internal agent-to-agent mail.
      // We know the recipient at send time, so notify SSE directly.
      // Fire-and-forget — must never block or fail the send.
      notifyLocalRecipientsOfNewMail(
        accountManager, to, cc, bcc, agent, subject, result.messageId, config, wakeList,
      ).catch((err) => {
        console.warn(`[mail] Internal SSE notify failed: ${(err as Error).message}`);
      });

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

  /**
   * Delete a message.
   *
   * Default behaviour is **move-to-trash** (Gmail / Outlook
   * semantics): the message is moved to the IMAP trash folder
   * with `messageMove`. It still exists, the user can recover
   * it from Trash, and no other mailbox state is touched.
   *
   * Opt into IMAP EXPUNGE with `?permanent=true`. The web UI
   * uses this when the user empties Trash. **Beware**: classic
   * IMAP EXPUNGE is mailbox-wide and removes every message
   * with `\Deleted` set, not just the target UID. We try
   * `UID EXPUNGE` (RFC 4315) when the server advertises
   * UIDPLUS to narrow the scope, but the user must explicitly
   * opt in.
   *
   * Source folder defaults to INBOX; override with
   * `?folder=Foo` so callers (e.g. the web UI deleting from
   * Sent / Drafts / etc.) point at the right mailbox.
   */
  router.delete('/mail/messages/:uid', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const permanent = req.query.permanent === 'true' || req.query.permanent === '1';
      const sourceFolder = (req.query.folder as string) || 'INBOX';

      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);

      if (permanent) {
        // Explicit permanent delete — only fires when the user opts
        // in (typically from the Trash folder's "Delete forever"
        // action). Uses UID EXPUNGE when the server supports it.
        await receiver.expungeMessage(uid, sourceFolder);
        res.status(204).send();
        return;
      }

      // Discover the trash mailbox by name. Pattern matches
      // Stalwart's "Deleted Items" / "Trash", Gmail's
      // "[Gmail]/Trash", Outlook's "Deleted Items", macOS Mail's
      // "Deleted Messages". Falls back to the conservative
      // expunge path if no trash mailbox is found — better to
      // remove than to crash, but it's a degraded mode.
      const folders = await receiver.listFolders();
      const trashRe = /^trash\b|deleted items|deleted messages|\[gmail\]\/trash|\[gmail\]\/bin/i;
      const trashFolder = folders.find(f => trashRe.test(f.name) || trashRe.test(f.path))?.path
        ?? folders.find(f => f.specialUse === '\\Trash')?.path;
      if (!trashFolder || trashFolder === sourceFolder) {
        // Either no trash mailbox, or the user is already in
        // Trash — fall through to expunge so the action does
        // something visible. The "in Trash" case is the natural
        // "empty trash" flow on most clients.
        await receiver.expungeMessage(uid, sourceFolder);
      } else {
        await receiver.moveToTrash(uid, sourceFolder, trashFolder);
      }
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

  /**
   * Star / unstar a message.
   *
   * Body: { starred: boolean }. Maps to IMAP's `\Flagged` flag —
   * same on-disk bit Gmail's star uses. The web UI fires this on
   * every star click; the response is just `{ ok: true }` so the
   * client can resolve its optimistic update.
   */
  router.post('/mail/messages/:uid/star', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const starred = req.body?.starred !== false;
      const folder = (req.body?.folder as string) || (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      await receiver.setStarred(uid, starred, folder);
      res.json({ ok: true, starred });
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

  /**
   * Archive a single message — move it to the agent's Archive
   * mailbox. Auto-discovers the archive folder using the
   * `\Archive` specialUse marker first (the IMAP-blessed signal)
   * and falls back to common names. Creates `Archive` on the fly
   * if nothing exists; without that step, first-archive on a
   * vanilla Stalwart would 404.
   *
   * Body: { folder?: string } — source folder; defaults to INBOX.
   */
  router.post('/mail/messages/:uid/archive', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const uid = parseInt(req.params.uid);
      if (isNaN(uid) || uid < 1) {
        res.status(400).json({ error: 'Invalid UID' });
        return;
      }
      const sourceFolder = (req.body?.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      // Find a real archive mailbox. Prefer the IMAP \Archive
      // specialUse hint; fall back to common names; create if missing.
      const folders = await receiver.listFolders();
      const archiveRe = /^archives?\b|^all archive\b/i;
      let archiveFolder = folders.find(f => f.specialUse === '\\Archive')?.path
        ?? folders.find(f => archiveRe.test(f.name) || archiveRe.test(f.path))?.path;
      if (!archiveFolder) {
        try { await receiver.createFolder('Archive'); } catch { /* race or already-exists is fine */ }
        archiveFolder = 'Archive';
      }
      if (archiveFolder === sourceFolder) {
        res.status(400).json({ error: 'Message already in archive' });
        return;
      }
      await receiver.moveMessage(uid, sourceFolder, archiveFolder);
      res.json({ ok: true, archive: archiveFolder });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Batch archive — same shape as `batch/move` but with
   * auto-discovery of the archive target. Single-call convenience
   * for the web UI's bulk-action toolbar.
   */
  router.post('/mail/batch/archive', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const sourceFolder = (folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const folders = await receiver.listFolders();
      const archiveRe = /^archives?\b|^all archive\b/i;
      let archiveFolder = folders.find(f => f.specialUse === '\\Archive')?.path
        ?? folders.find(f => archiveRe.test(f.name) || archiveRe.test(f.path))?.path;
      if (!archiveFolder) {
        try { await receiver.createFolder('Archive'); } catch { /* race */ }
        archiveFolder = 'Archive';
      }
      if (archiveFolder === sourceFolder) {
        res.status(400).json({ error: 'Messages already in archive' });
        return;
      }
      await receiver.batchMove(uids, sourceFolder, archiveFolder);
      res.json({ ok: true, archived: uids.length, archive: archiveFolder });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Batch move-to-trash — the safe alternative to
   * `batch/delete`'s mailbox-wide EXPUNGE. The web UI's bulk
   * Delete action calls this. Trash folder is auto-discovered;
   * if the user is already in Trash, falls through to the
   * existing batch-delete (permanent expunge) which is the
   * natural "empty trash" flow.
   */
  router.post('/mail/batch/trash', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const { uids: rawUids, folder } = req.body || {};
      const uids = validateUids(rawUids);
      if (!uids) {
        res.status(400).json({ error: 'uids must be a non-empty array of positive integers (max 1000)' });
        return;
      }
      const sourceFolder = (folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);
      const folders = await receiver.listFolders();
      const trashRe = /^trash\b|deleted items|deleted messages|\[gmail\]\/trash|\[gmail\]\/bin/i;
      const trashFolder = folders.find(f => f.specialUse === '\\Trash')?.path
        ?? folders.find(f => trashRe.test(f.name) || trashRe.test(f.path))?.path;
      if (!trashFolder || trashFolder === sourceFolder) {
        // Either no trash mailbox, or the user is in Trash — do
        // the permanent expunge variant. The user opted into
        // batch/trash from Trash specifically (UI surfaces
        // "Delete forever" copy there), so this is intended.
        await receiver.batchDelete(uids, sourceFolder);
        res.json({ ok: true, deleted: uids.length });
        return;
      }
      await receiver.batchMove(uids, sourceFolder, trashFolder);
      res.json({ ok: true, trashed: uids.length, trash: trashFolder });
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

  // Inbox digest — envelopes + body preview + authoritative total in one call.
  //
  // Three things this endpoint gets right that the previous version
  // didn't:
  //
  //   1. **Authoritative total.** Was returning `mailboxInfo.exists`
  //      which reads from `client.mailbox.exists` — a cached count
  //      from the last SELECT/EXISTS push that lags behind reality
  //      on pooled IMAP receivers. When a mailbox had >50 messages
  //      the cache often returned 50 anyway, the UI did
  //      `nextBtn.disabled = pageEnd >= total` → 50 >= 50 → Next
  //      button stuck disabled. Fix: derive total from
  //      `SEARCH ALL` UID list length — the count the server itself
  //      gives us, in the same lock that fetches the page.
  //
  //   2. **Truncated source fetches.** Was IMAP-fetching the FULL
  //      RFC822 source of every message (potentially MBs apiece
  //      with attachments) just to slice the first 240 chars of
  //      body text. Now we ask for the first 8 KB only — enough
  //      for headers + a comfortable body preview in virtually
  //      every real-world email.
  //
  //   3. **Parallel parsing.** Was awaiting `parseEmail(raw)` in
  //      a SEQUENTIAL for-loop. Now Promise.all so the async I/O
  //      inside mailparser overlaps across messages.
  //
  // Net effect on a 50-message page: ~2.4 s → ~150 ms.
  router.get('/mail/digest', requireAgent, async (req, res, next) => {
    try {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const previewLen = Math.min(Math.max(parseInt(req.query.previewLength as string) || 200, 50), 500);
      const folder = (req.query.folder as string) || 'INBOX';
      const password = getAgentPassword(agent);
      const receiver = await getReceiver(agent.stalwartPrincipal, password, config);

      // One mailbox lock for the whole thing — SEARCH (authoritative
      // total + uid list) → envelope fetch (page slice) → truncated
      // source fetch (preview text). Bypasses the SDK's
      // listEnvelopes + batchFetch helpers because we need (a) the
      // total count from the search and (b) the byte-range source
      // option that isn't exposed on `batchFetch`.
      const PREVIEW_MAX_BYTES = 8192;
      const client = receiver.getImapClient();
      const lock = await client.getMailboxLock(folder);
      const envelopes: Array<{
        uid: number; subject: string;
        from: Array<{ name?: string; address: string }>;
        to: Array<{ name?: string; address: string }>;
        date: Date; flags: string[]; size: number;
      }> = [];
      const rawMap = new Map<number, Buffer>();
      let total = 0;
      try {
        const searchResult = await client.search({ all: true }, { uid: true });
        const allUids: number[] = Array.isArray(searchResult) ? searchResult : [];
        total = allUids.length;
        const sorted = allUids.slice().sort((a, b) => b - a);  // newest first
        const pageUids = sorted.slice(offset, offset + limit);

        if (pageUids.length > 0) {
          // Envelopes for the page.
          for await (const msg of client.fetch(pageUids.join(','), {
            uid: true, envelope: true, flags: true, size: true,
          })) {
            const env = msg.envelope;
            if (!env) continue;
            envelopes.push({
              uid: msg.uid as number,
              subject: env.subject ?? '',
              from: (env.from ?? []).map((a: any) => ({ name: a.name, address: a.address ?? '' })),
              to: (env.to ?? []).map((a: any) => ({ name: a.name, address: a.address ?? '' })),
              date: env.date ?? new Date(),
              flags: msg.flags ? [...msg.flags] : [],
              size: msg.size ?? 0,
            });
          }
          // Sort newest first (fetch order isn't guaranteed).
          envelopes.sort((a, b) => b.uid - a.uid);

          // Truncated source — first 8 KB per message for preview.
          for await (const msg of client.fetch(pageUids.join(','), {
            uid: true,
            source: { start: 0, maxLength: PREVIEW_MAX_BYTES },
          } as Parameters<typeof client.fetch>[1])) {
            if (msg.source) {
              rawMap.set(
                msg.uid as number,
                Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source as Uint8Array),
              );
            }
          }
        }
      } finally {
        lock.release();
      }

      // Parallel parse — mailparser is async so concurrent invocations
      // overlap I/O. A truncated source can confuse the parser; on any
      // error we fall back to an empty preview rather than 500-ing
      // the whole page.
      const messages = await Promise.all(envelopes.map(async env => {
        const raw = rawMap.get(env.uid);
        let preview = '';
        if (raw) {
          try {
            const parsed = await parseEmail(raw);
            preview = (parsed.text || '').slice(0, previewLen);
          } catch { /* truncated source — leave preview blank */ }
        }
        return {
          uid: env.uid, subject: env.subject,
          from: env.from, to: env.to, date: env.date,
          flags: env.flags, size: env.size, preview,
        };
      }));

      res.json({ messages, count: messages.length, total });
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

      // Restore the X-AgenticMail-Wake header from the persisted wakeList
      // so approval doesn't strip the sender's wake intent. Without this,
      // an outbound-guard-blocked mail would lose its wake hint when the
      // owner approves it, and every CC'd recipient would get a Claude
      // turn even though the sender wanted just one.
      const persistedWakeList: string[] | undefined = Array.isArray(mailOpts.wakeList) ? mailOpts.wakeList : undefined;
      if (persistedWakeList !== undefined) {
        mailOpts.headers = { ...(mailOpts.headers ?? {}), ...wakeHeaders(persistedWakeList) };
        // The stored field isn't part of the SMTP message shape, scrub it.
        delete mailOpts.wakeList;
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
        // Issue #24 — same direct-SSE bypass as POST /mail/send (see
        // comment there). Pass the persisted wake list so dispatcher
        // sees the same allowlist it would have seen on the original
        // pre-approval send.
        notifyLocalRecipientsOfNewMail(
          accountManager, mailOpts.to, mailOpts.cc, mailOpts.bcc, agent, mailOpts.subject, result.messageId, config, persistedWakeList,
        ).catch((err) => {
          console.warn(`[mail] Internal SSE notify (approve) failed: ${(err as Error).message}`);
        });
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
