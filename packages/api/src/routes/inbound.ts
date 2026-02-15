import { Router } from 'express';
import {
  parseEmail,
  MailSender,
  type AccountManager,
  type AgenticMailConfig,
  type GatewayManager,
} from '@agenticmail/core';

const INBOUND_SECRET = process.env.AGENTICMAIL_INBOUND_SECRET || 'inbound_2sabi_secret_key';

/**
 * Inbound email webhook — receives email forwarded by Cloudflare Email Workers.
 * Authenticates via X-Inbound-Secret header (not bearer token).
 * Delivers the email to the recipient's local Stalwart mailbox.
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

      // Decode the raw email from base64 and parse it
      const rawBuffer = Buffer.from(rawEmail, 'base64');
      const parsed = await parseEmail(rawBuffer);

      // Deduplicate: skip if already delivered
      const originalMessageId = parsed.messageId;
      if (originalMessageId && gatewayManager?.isAlreadyDelivered(originalMessageId, agent.name)) {
        console.log(`[Inbound] Skipping duplicate: ${originalMessageId} → ${agent.name}`);
        res.json({ ok: true, delivered: agent.email, duplicate: true });
        return;
      }

      console.log(`[Inbound] Delivering email to ${agent.email} from ${from} (subject: ${subject || parsed.subject})`);

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
        console.log(`[Inbound] Delivered to ${agent.email}`);
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
