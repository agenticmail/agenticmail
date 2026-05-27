import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  parseEmail,
  type AccountManager,
  type AgenticMailConfig,
  type GatewayManager,
} from '@agenticmail/core';
import { getReceiver } from './mail.js';

// Generate a random secret if none provided. Never fall back to a hardcoded value.
const INBOUND_SECRET = process.env.AGENTICMAIL_INBOUND_SECRET || (() => {
  const generated = randomUUID();
  console.warn('[Inbound] WARNING: AGENTICMAIL_INBOUND_SECRET is not set. Generated a random secret for this session.');
  console.warn(`[Inbound] Set AGENTICMAIL_INBOUND_SECRET="${generated}" in your environment to persist it across restarts.`);
  return generated;
})();
const DEBUG = () => !!process.env.AGENTICMAIL_DEBUG;

/**
 * Prepend custom tracing headers to a raw RFC822 message buffer.
 *
 * Inserts the headers immediately after the first line so they sit at the
 * top of the message head, then preserves the rest of the message bytes
 * (other headers, blank line, body, MIME parts) exactly. This keeps
 * `From:`, `To:`, `Message-Id:`, `In-Reply-To:`, `References:`, and any
 * attachments untouched — which is the whole point of switching to IMAP
 * APPEND for inbound delivery.
 */
export function prependHeaders(raw: Buffer, headers: Record<string, string>): Buffer {
  const entries = Object.entries(headers).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return raw;
  // Match either CRLF or bare LF as the first line terminator. RFC822
  // mandates CRLF, but some pipelines (incl. Mailgun fixtures) normalise
  // to LF. Detect and reuse the same terminator for the inserted lines.
  const crlfIdx = raw.indexOf('\r\n');
  const lfIdx = raw.indexOf('\n');
  const useCrlf = crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx);
  const eol = useCrlf ? '\r\n' : '\n';
  const firstBreak = useCrlf ? crlfIdx : lfIdx;
  if (firstBreak === -1) return raw; // Single-line input — nothing sensible to do.
  const headerBlock = entries.map(([k, v]) => `${k}: ${v}`).join(eol) + eol;
  return Buffer.concat([
    raw.subarray(0, firstBreak + eol.length),
    Buffer.from(headerBlock, 'utf8'),
    raw.subarray(firstBreak + eol.length),
  ]);
}

/**
 * Inbound email webhook — receives email forwarded by Cloudflare Email Workers.
 * Authenticates via X-Inbound-Secret header (not bearer token).
 *
 * Delivers the email to the recipient's local Stalwart mailbox via IMAP
 * APPEND. We deliberately do NOT re-submit over SMTP authenticated as the
 * recipient, because nodemailer derives `From:` from the authenticated
 * user and would overwrite the original sender. APPEND writes the raw
 * RFC822 bytes straight to INBOX, preserving `From:` exactly as it
 * arrived.
 */
export function createInboundRoutes(accountManager: AccountManager, config: AgenticMailConfig, gatewayManager?: GatewayManager): Router {
  const router = Router();

  router.post('/mail/inbound', async (req, res, next) => {
    try {
      const secret = req.headers['x-inbound-secret'];
      if (secret !== INBOUND_SECRET) {
        res.status(401).json({ error: 'Invalid inbound secret' });
        return;
      }

      const { from, to, subject, rawEmail } = req.body;
      if (!to || !rawEmail) {
        res.status(400).json({ error: 'to and rawEmail are required' });
        return;
      }

      // Extract the local part of the recipient to find the agent
      const recipientEmail = typeof to === 'string' ? to : to[0];
      const localPart = recipientEmail.split('@')[0];

      // Find the agent by name (local part of email)
      const agent = await accountManager.getByName(localPart);
      if (!agent) {
        console.warn(`[Inbound] No agent found for "${localPart}" (${recipientEmail})`);
        res.status(404).json({ error: `No agent found for ${recipientEmail}` });
        return;
      }

      const agentPassword = (agent.metadata as Record<string, any>)?._password;
      if (!agentPassword) {
        console.warn(`[Inbound] No password for agent "${agent.name}"`);
        res.status(500).json({ error: 'Agent has no password configured' });
        return;
      }

      // Decode the raw email from base64 and parse it (parse only used for
      // dedup key + debug subject; the raw buffer is what we deliver).
      const rawBuffer = Buffer.from(rawEmail, 'base64');
      const parsed = await parseEmail(rawBuffer);

      // Deduplicate: skip if already delivered
      const originalMessageId = parsed.messageId;
      if (originalMessageId && gatewayManager?.isAlreadyDelivered(originalMessageId, agent.name)) {
        if (DEBUG()) console.log(`[Inbound] Skipping duplicate: ${originalMessageId} → ${agent.name}`);
        res.json({ ok: true, delivered: agent.email, duplicate: true });
        return;
      }

      if (DEBUG()) console.log(`[Inbound] Delivering email to ${agent.email} from ${from} (subject: ${subject || parsed.subject})`);

      // Prepend tracing headers without touching From:/To:/threading.
      // We no longer need `X-Original-From` — the original `From:` is the
      // real `From:` now — but we keep `X-AgenticMail-Inbound` for
      // operators grepping logs and `X-Original-Message-Id` for cross-
      // system tracing (parity with the previous behaviour).
      const tracingHeaders: Record<string, string> = {
        'X-AgenticMail-Inbound': 'cloudflare-worker',
      };
      if (parsed.messageId) tracingHeaders['X-Original-Message-Id'] = parsed.messageId;
      const toAppend = prependHeaders(rawBuffer, tracingHeaders);

      // Append to the agent's INBOX via IMAP. Uses the same pooled
      // receiver that the rest of the API uses, so we inherit the
      // connection-reuse / IDLE-safety behaviour.
      const receiver = await getReceiver(agent.stalwartPrincipal, agentPassword, config);
      await receiver.appendMessage(toAppend, 'INBOX');

      // Record delivery for deduplication
      if (originalMessageId) gatewayManager?.recordDelivery(originalMessageId, agent.name);
      if (DEBUG()) console.log(`[Inbound] Delivered to ${agent.email}`);
      res.json({ ok: true, delivered: agent.email });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
