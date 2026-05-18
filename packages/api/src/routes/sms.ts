import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  SmsManager,
  parseGoogleVoiceSms,
  extractVerificationCode,
  normalizePhoneNumber,
  isValidPhoneNumber,
  getSmsProvider,
  mapProviderSmsStatus,
  redactSmsConfig,
  type AccountManager,
  type AgenticMailConfig,
  type SmsConfig,
} from '@agenticmail/core';

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readWebhookSecret(req: Request): string {
  return requestString(req.get('x-agenticmail-webhook-secret'))
    || requestString(req.get('x-46elks-secret'))
    || requestString(req.query.secret)
    || requestString((req.body as Record<string, unknown> | undefined)?.secret);
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSmsWebhookRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
): Router {
  const router = Router();
  const smsManager = new SmsManager(db as any);

  // POST /sms/webhook/46elks — Receive inbound SMS from 46elks without bearer auth.
  router.post('/sms/webhook/46elks', (req: Request, res: Response) => {
    try {
      const event = getSmsProvider('46elks').parseInboundSms(req.body ?? {});
      if (!event) {
        return res.status(400).json({ error: 'Invalid 46elks SMS webhook payload' });
      }

      const match = smsManager.findAgentBySmsNumber(event.to, '46elks');
      if (!match) {
        return res.status(404).json({ error: 'No enabled 46elks SMS config found for recipient number' });
      }

      const expectedSecret = requestString(match.config.webhookSecret);
      const providedSecret = readWebhookSecret(req);
      if (!expectedSecret || !providedSecret || !secretMatches(providedSecret, expectedSecret)) {
        return res.status(403).json({ error: 'Invalid SMS webhook secret' });
      }

      const sms = smsManager.recordInbound(
        match.agentId,
        {
          from: event.from,
          body: event.body,
          timestamp: event.timestamp,
          raw: JSON.stringify(event.raw ?? event),
        },
        {
          provider: event.provider,
          providerMessageId: event.id,
          to: event.to,
        },
      );

      res.json({ success: true, sms });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

export function createSmsRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  accountManager: AccountManager,
  config: AgenticMailConfig,
  gatewayManager?: any,
): Router {
  const router = Router();
  const smsManager = new SmsManager(db as any);

  /** Helper: get authenticated agent or return 401 */
  function getAgent(req: Request, res: Response): { id: string; email: string } | null {
    const agent = (req as any).agent;
    if (!agent) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return agent;
  }

  // GET /sms/config — Get SMS config for current agent
  router.get('/sms/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const smsConfig = smsManager.getSmsConfig(agent.id);
      res.json({
        configured: !!smsConfig,
        sms: smsConfig ? redactSmsConfig(smsConfig) : null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /sms/setup — Configure SMS provider
  router.post('/sms/setup', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const {
        phoneNumber,
        forwardingEmail,
        forwardingPassword,
        provider = 'google_voice',
        username,
        password,
        webhookSecret,
        apiUrl,
      } = req.body;

      if (!phoneNumber || typeof phoneNumber !== 'string') {
        return res.status(400).json({ error: 'phoneNumber is required (string)' });
      }

      if (provider !== 'google_voice' && provider !== '46elks') {
        return res.status(400).json({ error: 'provider must be "google_voice" or "46elks"' });
      }

      if (!isValidPhoneNumber(phoneNumber)) {
        return res.status(400).json({
          error: 'Invalid phone number. Provide an E.164 number like +46701234567 or +12125551234.',
        });
      }

      const normalized = normalizePhoneNumber(phoneNumber)!;

      if (provider === '46elks') {
        if (!requestString(username) || !requestString(password)) {
          return res.status(400).json({ error: 'username and password are required for provider "46elks"' });
        }
        if (!requestString(webhookSecret)) {
          return res.status(400).json({ error: 'webhookSecret is required for provider "46elks"' });
        }

        const smsConfig: SmsConfig = {
          enabled: true,
          phoneNumber: normalized,
          provider: '46elks',
          username: requestString(username),
          password: requestString(password),
          webhookSecret: requestString(webhookSecret),
          apiUrl: requestString(apiUrl) || undefined,
          configuredAt: new Date().toISOString(),
        };

        smsManager.saveSmsConfig(agent.id, smsConfig);

        return res.json({
          success: true,
          sms: redactSmsConfig(smsConfig),
          nextSteps: [
            'Configure the inbound SMS webhook in 46elks for this number.',
            'Set sms_url to /api/agenticmail/sms/webhook/46elks?secret=<webhookSecret> on this AgenticMail API host.',
            'Outbound SMS will be sent directly through the configured 46elks API credentials.',
          ],
        });
      }

      // Validate forwarding email if provided
      if (forwardingEmail && typeof forwardingEmail === 'string') {
        if (!forwardingEmail.includes('@')) {
          return res.status(400).json({ error: 'forwardingEmail must be a valid email address' });
        }
      }

      // Determine if GV Gmail is same as relay email
      const fwdEmail = (typeof forwardingEmail === 'string' && forwardingEmail.trim()) || '';
      let relayEmail = '';
      try {
        if (gatewayManager) {
          const gwStatus = gatewayManager.getStatus?.() || gatewayManager.status?.();
          if (gwStatus?.relay?.email) {
            relayEmail = gwStatus.relay.email;
          }
        }
        if (!relayEmail) {
          const gwConfig = config.gateway;
          if (gwConfig && 'email' in gwConfig) relayEmail = (gwConfig as any).email || '';
        }
      } catch {}
      const effectiveEmail = fwdEmail || relayEmail || agent.email || '';
      const sameAsRelay = !fwdEmail || (!!relayEmail && fwdEmail.toLowerCase() === relayEmail.toLowerCase());

      const smsConfig: SmsConfig = {
        enabled: true,
        phoneNumber: normalized,
        forwardingEmail: effectiveEmail,
        forwardingPassword: (!sameAsRelay && typeof forwardingPassword === 'string' && forwardingPassword.trim())
          ? forwardingPassword.trim() : undefined,
        sameAsRelay: !!sameAsRelay,
        provider: 'google_voice',
        configuredAt: new Date().toISOString(),
      };

      smsManager.saveSmsConfig(agent.id, smsConfig);

      const nextSteps: string[] = [
        'Ensure Google Voice SMS forwarding is enabled in Settings > Messages.',
      ];
      if (smsConfig.sameAsRelay) {
        nextSteps.push(`SMS will be detected automatically during email polling (same Gmail: ${effectiveEmail}).`);
      } else if (smsConfig.forwardingPassword) {
        nextSteps.push(`SMS will be polled separately from ${effectiveEmail} (separate Gmail with credentials).`);
      } else {
        nextSteps.push(`WARNING: SMS forwarding email (${effectiveEmail}) differs from relay but no password provided. SMS polling will NOT work.`);
        nextSteps.push('Provide forwardingPassword to enable SMS polling, or use the same Gmail for relay and Google Voice.');
      }

      res.json({
        success: true,
        sms: redactSmsConfig(smsConfig),
        nextSteps,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /sms/disable — Disable SMS
  router.post('/sms/disable', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const existing = smsManager.getSmsConfig(agent.id);
      if (existing) {
        existing.enabled = false;
        smsManager.saveSmsConfig(agent.id, existing);
        res.json({ success: true, message: 'SMS disabled' });
      } else {
        res.json({ success: true, message: 'SMS was not configured' });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /sms/messages — List SMS messages
  router.get('/sms/messages', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const rawDir = req.query.direction as string | undefined;
      const direction = rawDir === 'inbound' || rawDir === 'outbound' ? rawDir : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const messages = smsManager.listMessages(agent.id, { direction, limit, offset });
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /sms/send — Record an outbound SMS
  router.post('/sms/send', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const smsConfig = smsManager.getSmsConfig(agent.id);
      if (!smsConfig?.enabled) {
        return res.status(400).json({
          error: 'SMS not configured or disabled. Use sms_setup first.',
          hint: 'Call agenticmail_sms_setup with provider "46elks" or "google_voice".',
        });
      }

      const { to, body } = req.body;
      if (!to || typeof to !== 'string') {
        return res.status(400).json({ error: '"to" (phone number) is required' });
      }
      if (!body || typeof body !== 'string') {
        return res.status(400).json({ error: '"body" (message text) is required' });
      }
      if (body.length > 1600) {
        return res.status(400).json({ error: 'SMS body too long (max 1600 characters, ~10 SMS segments)' });
      }

      if (!isValidPhoneNumber(to)) {
        return res.status(400).json({ error: 'Invalid "to" phone number' });
      }

      if (smsConfig.provider === '46elks') {
        const smsRecord = smsManager.recordOutbound(agent.id, to, body, 'pending', {
          provider: smsConfig.provider,
        });

        try {
          const result = await getSmsProvider('46elks').sendSms(smsConfig, { to, body });
          const status = mapProviderSmsStatus(result.status);
          const metadata = {
            ...smsRecord.metadata,
            provider: smsConfig.provider,
            providerMessageId: result.id,
          };
          smsManager.updateStatus(smsRecord.id, status, metadata);
          return res.json({
            success: true,
            sms: { ...smsRecord, status, metadata },
            providerResult: {
              provider: result.provider,
              id: result.id,
              status: result.status,
            },
            delivery: 'direct_provider_api',
          });
        } catch (err) {
          const metadata = {
            ...smsRecord.metadata,
            provider: smsConfig.provider,
            providerError: (err as Error).message,
          };
          smsManager.updateStatus(smsRecord.id, 'failed', metadata);
          return res.status(502).json({
            success: false,
            sms: { ...smsRecord, status: 'failed', metadata },
            error: (err as Error).message,
          });
        }
      }

      const smsRecord = smsManager.recordOutbound(agent.id, to, body, 'pending', {
        provider: smsConfig.provider,
      });

      res.json({
        success: true,
        sms: smsRecord,
        sendInstructions: {
          method: 'browser_automation',
          url: 'https://voice.google.com',
          steps: [
            'Open voice.google.com in browser',
            `Click "Send a message" or navigate to Messages`,
            `Enter recipient: ${normalizePhoneNumber(to)}`,
            `Type message and send`,
            `Then call agenticmail_sms_messages to verify it was recorded`,
          ],
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /sms/parse-email — Parse an SMS from a forwarded Google Voice email
  router.post('/sms/parse-email', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const { emailBody, emailFrom } = req.body;
      if (!emailBody || typeof emailBody !== 'string') {
        return res.status(400).json({ error: 'emailBody is required (string)' });
      }

      const parsed = parseGoogleVoiceSms(emailBody, emailFrom || '');
      if (!parsed) {
        return res.json({
          success: false,
          parsed: null,
          verificationCode: null,
          message: 'Could not parse SMS from this email. It may not be a Google Voice forwarded SMS.',
        });
      }

      // Record inbound
      const msg = smsManager.recordInbound(agent.id, parsed);

      // Check for verification code
      const code = extractVerificationCode(parsed.body);

      res.json({
        success: true,
        sms: msg,
        verificationCode: code,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /sms/verification-code — Check for recent verification codes
  router.get('/sms/verification-code', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const minutesBack = Math.min(Math.max(parseInt(req.query.minutes as string) || 10, 1), 1440);
      const result = smsManager.checkForVerificationCode(agent.id, minutesBack);

      if (result) {
        res.json({ found: true, ...result });
      } else {
        res.json({
          found: false,
          message: `No verification codes found in the last ${minutesBack} minutes.`,
          hint: 'TIP: For fastest results, open https://voice.google.com/u/0/messages in the browser and read the code directly. Then use agenticmail_sms_record to save it. Email forwarding can be delayed 1-5 minutes.',
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /sms/record — Record an SMS read from Google Voice web or other source
  router.post('/sms/record', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const { from, body } = req.body;
      if (!from || typeof from !== 'string') {
        return res.status(400).json({ error: '"from" (sender phone number) is required' });
      }
      if (!body || typeof body !== 'string') {
        return res.status(400).json({ error: '"body" (message text) is required' });
      }

      // Normalize the sender number
      const normalizedFrom = normalizePhoneNumber(from) || from.replace(/[^+\d]/g, '');

      // Record inbound SMS
      const msg = smsManager.recordInbound(agent.id, {
        from: normalizedFrom,
        body: body.trim(),
        timestamp: new Date().toISOString(),
      });

      // Check for verification code
      const code = extractVerificationCode(body);

      res.json({
        success: true,
        sms: msg,
        verificationCode: code,
        source: 'manual_record',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
