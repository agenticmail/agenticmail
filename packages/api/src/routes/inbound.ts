import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  parseEmail,
  MailSender,
  PhoneManager,
  parseOperatorQueryReply,
  isOperatorReplySender,
  getDatabase,
  type AccountManager,
  type AgenticMailConfig,
  type GatewayManager,
} from '@agenticmail/core';

type Db = ReturnType<typeof getDatabase>;

// Generate a random secret if none provided. Never fall back to a hardcoded value.
const INBOUND_SECRET = process.env.AGENTICMAIL_INBOUND_SECRET || (() => {
  const generated = randomUUID();
  console.warn('[Inbound] WARNING: AGENTICMAIL_INBOUND_SECRET is not set. Generated a random secret for this session.');
  console.warn(`[Inbound] Set AGENTICMAIL_INBOUND_SECRET="${generated}" in your environment to persist it across restarts.`);
  return generated;
})();
const DEBUG = () => !!process.env.AGENTICMAIL_DEBUG;

/**
 * Inbound email webhook — receives email forwarded by Cloudflare Email Workers.
 * Authenticates via X-Inbound-Secret header (not bearer token).
 * Delivers the email to the recipient's local Stalwart mailbox.
 */
export function createInboundRoutes(
  accountManager: AccountManager,
  config: AgenticMailConfig,
  db: Db,
  gatewayManager?: GatewayManager,
): Router {
  const router = Router();
  // Used by the operator-query email-reply hook (plan §5) — see below.
  const phoneManager = new PhoneManager(db as any, config.masterKey);

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

      // Decode the raw email from base64 and parse it
      const rawBuffer = Buffer.from(rawEmail, 'base64');
      const parsed = await parseEmail(rawBuffer);

      // ─── Operator-query email-reply hook (v0.9.53, plan §5) ──────
      //
      // The realtime voice `ask_operator` tool emails the operator a
      // question tagged with the query id in the subject. When the
      // operator replies, that reply lands here — parse the id + answer
      // out and route it into the matching phone-mission query, which
      // unblocks the waiting voice agent (and may trigger a callback if
      // the call already dropped, plan §7). The email is STILL delivered
      // to the agent's mailbox below — the reply is a real message.
      try {
        const opReply = parseOperatorQueryReply({
          subject: parsed.subject || subject || '',
          text: parsed.text || '',
        });
        if (opReply) {
          // Fail-closed sender check (v0.9.53 security review): the query
          // id in the subject is an unguessable capability token, but it
          // travels in plaintext subjects (quoting, forwarding, relay/
          // provider logs). So an emailed answer is only honoured when its
          // From address matches the configured operator — consistent
          // with plan §5 (the operator is the one who replies). Ultimate
          // strength still depends on inbound SPF/DKIM rejecting a spoofed
          // From; this closes the casual-leak path.
          const replyFrom = parsed.from?.[0]?.address || (typeof from === 'string' ? from : '');
          if (!isOperatorReplySender(replyFrom, config.operatorEmail)) {
            console.warn(
              `[Inbound] operator-query reply for ${opReply.queryId} rejected — `
              + `sender "${replyFrom || '(unknown)'}" is not the configured operator`,
            );
          } else {
            const found = phoneManager.findMissionByOperatorQueryId(opReply.queryId);
            if (found) {
              phoneManager.answerOperatorQuery(found.mission.id, opReply.queryId, opReply.answer, { via: 'email' });
              // Best-effort callback — must not block / fail inbound delivery.
              void phoneManager.triggerCallback(found.mission.id).catch((err) => {
                console.warn('[Inbound] operator-query callback failed:', (err as Error)?.message ?? err);
              });
              if (DEBUG()) console.log(`[Inbound] Operator answered query ${opReply.queryId} via email reply`);
            }
          }
        }
      } catch (err) {
        // The hook is additive — never let it break normal delivery.
        console.warn('[Inbound] operator-query reply hook failed:', (err as Error)?.message ?? err);
      }

      // Deduplicate: skip if already delivered
      const originalMessageId = parsed.messageId;
      if (originalMessageId && gatewayManager?.isAlreadyDelivered(originalMessageId, agent.name)) {
        if (DEBUG()) console.log(`[Inbound] Skipping duplicate: ${originalMessageId} → ${agent.name}`);
        res.json({ ok: true, delivered: agent.email, duplicate: true });
        return;
      }

      if (DEBUG()) console.log(`[Inbound] Delivering email to ${agent.email} from ${from} (subject: ${subject || parsed.subject})`);

      // Deliver to agent's Stalwart mailbox via SMTP
      // Authenticate as the agent and send to themselves
      const sender = new MailSender({
        host: config.smtp.host,
        port: config.smtp.port,
        email: agent.email,
        password: agentPassword,
        authUser: agent.stalwartPrincipal,
      });

      try {
        await sender.send({
          to: agent.email,
          subject: parsed.subject || subject || '(no subject)',
          text: parsed.text || undefined,
          html: parsed.html || undefined,
          replyTo: from || parsed.from?.[0]?.address,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          headers: {
            'X-AgenticMail-Inbound': 'cloudflare-worker',
            'X-Original-From': from || parsed.from?.[0]?.address || '',
            ...(parsed.messageId ? { 'X-Original-Message-Id': parsed.messageId } : {}),
          },
          attachments: parsed.attachments?.map(a => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        });

        // Record delivery for deduplication
        if (originalMessageId) gatewayManager?.recordDelivery(originalMessageId, agent.name);
        if (DEBUG()) console.log(`[Inbound] Delivered to ${agent.email}`);
        res.json({ ok: true, delivered: agent.email });
      } finally {
        sender.close();
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
