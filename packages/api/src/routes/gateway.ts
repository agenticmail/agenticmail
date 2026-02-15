import { Router } from 'express';
import {
  GatewayManager,
  RELAY_PRESETS,
  AGENT_ROLES,
  type RelayConfig,
  type RelayProvider,
  type AgentRole,
} from '@agenticmail/core';
import { requireMaster } from '../middleware/auth.js';

export function createGatewayRoutes(gatewayManager: GatewayManager): Router {
  const router = Router();

  // Setup guide — explains both modes
  router.get('/gateway/setup-guide', requireMaster, async (_req, res) => {
    res.json({
      modes: [
        {
          mode: 'relay',
          difficulty: 'Beginner',
          description: 'Use your existing Gmail or Outlook account to send/receive emails. No domain needed.',
          fromAddress: 'yourname+agentname@gmail.com',
          requirements: [
            'A Gmail or Outlook email account',
            'An app password (not your regular password)',
          ],
          setup: {
            tool: 'agenticmail_setup_relay',
            params: { provider: 'gmail', email: 'you@gmail.com', password: 'xxxx xxxx xxxx xxxx' },
          },
          howToGetAppPassword: {
            gmail: 'https://myaccount.google.com/apppasswords (requires 2FA enabled)',
            outlook: 'https://account.live.com/proofs/AppPassword',
          },
          pros: ['Quick setup (< 2 min)', 'No domain purchase needed', 'Free'],
          cons: ['Emails show as yourname+agent@gmail.com', 'Less professional', 'Tied to personal email'],
        },
        {
          mode: 'domain',
          difficulty: 'Advanced',
          description: 'Use your own domain for professional agent emails (agent@yourdomain.com). Full DKIM/SPF/DMARC authentication.',
          fromAddress: 'agentname@yourdomain.com',
          requirements: [
            'A Cloudflare account (free tier works)',
            'A Cloudflare API token with Zone:Edit, DNS:Edit, Worker:Edit, Email Routing:Edit permissions',
            'A domain name (can purchase during setup, ~$10/yr for .com)',
            'A Gmail account + app password for outbound relay (recommended)',
          ],
          setup: {
            tool: 'agenticmail_setup_domain',
            params: {
              cloudflareToken: 'your-api-token',
              cloudflareAccountId: 'your-account-id',
              domain: 'yourdomain.com',
              gmailRelay: { email: 'you@gmail.com', appPassword: 'xxxx xxxx xxxx xxxx' },
            },
          },
          postSetup: [
            'Add each agent email as a Gmail "Send mail as" alias (use agenticmail_setup_gmail_alias tool for instructions)',
            'DNS propagation takes 5-30 minutes',
            'DKIM signing is automatic',
          ],
          howToGetCloudflareToken: 'https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom Token',
          howToGetAccountId: 'https://dash.cloudflare.com → click any site → right sidebar shows Account ID',
          pros: ['Professional emails (agent@yourdomain.com)', 'Full DKIM/SPF/DMARC', 'Multiple agents with unique addresses', 'Better deliverability'],
          cons: ['Requires Cloudflare account', 'Domain costs ~$10/yr', 'More setup steps', 'Gmail alias step needed for outbound'],
        },
      ],
    });
  });

  // Setup relay mode — requires master key
  router.post('/gateway/relay', requireMaster, async (req, res, next) => {
    try {
      const { provider, email, password, smtpHost, smtpPort, imapHost, imapPort, agentName, agentRole, skipDefaultAgent } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: 'email and password are required' });
        return;
      }

      // Validate agentRole if provided
      if (agentRole && !AGENT_ROLES.includes(agentRole as AgentRole)) {
        res.status(400).json({ error: `Invalid agentRole. Must be one of: ${AGENT_ROLES.join(', ')}` });
        return;
      }

      const prov = (provider ?? 'custom') as RelayProvider;
      const preset = (prov === 'gmail' || prov === 'outlook') ? RELAY_PRESETS[prov] : null;

      const config: RelayConfig = {
        provider: prov,
        email,
        password,
        smtpHost: smtpHost ?? preset?.smtpHost ?? 'localhost',
        smtpPort: smtpPort ?? preset?.smtpPort ?? 587,
        imapHost: imapHost ?? preset?.imapHost ?? 'localhost',
        imapPort: imapPort ?? preset?.imapPort ?? 993,
      };

      const result = await gatewayManager.setupRelay(config, {
        defaultAgentName: agentName,
        defaultAgentRole: agentRole as AgentRole | undefined,
        skipDefaultAgent,
      });

      const response: Record<string, any> = {
        status: 'ok',
        mode: 'relay',
        email: config.email,
        provider: config.provider,
      };

      if (result.agent) {
        response.agent = {
          id: result.agent.id,
          name: result.agent.name,
          email: result.agent.email,
          apiKey: result.agent.apiKey,
          role: result.agent.role,
          subAddress: `${email.split('@')[0]}+${result.agent.name}@${email.split('@')[1]}`,
        };
      }

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // Setup domain mode — requires master key
  router.post('/gateway/domain', requireMaster, async (req, res, next) => {
    try {
      const { cloudflareToken, cloudflareAccountId, domain, purchase, gmailRelay } = req.body;
      if (!cloudflareToken || !cloudflareAccountId) {
        res.status(400).json({ error: 'cloudflareToken and cloudflareAccountId are required' });
        return;
      }

      const result = await gatewayManager.setupDomain({
        cloudflareToken,
        cloudflareAccountId,
        domain,
        purchase,
        gmailRelay,
      });

      res.json({ status: 'ok', mode: 'domain', ...result });
    } catch (err) {
      next(err);
    }
  });

  // Get Gmail "Send mail as" alias setup instructions for browser automation
  router.post('/gateway/domain/alias-setup', requireMaster, async (req, res, next) => {
    try {
      const config = gatewayManager.getConfig();
      if (config.mode !== 'domain' || !config.domain) {
        res.status(400).json({ error: 'Domain mode not configured' });
        return;
      }

      const { agentEmail, agentDisplayName } = req.body;
      if (!agentEmail) {
        res.status(400).json({ error: 'agentEmail is required (e.g. secretary@yourdomain.com)' });
        return;
      }

      // Read relay credentials from Stalwart config
      const stalwart = gatewayManager.getStalwart();
      const gmailUsername = await stalwart.getSettings('queue.route.gmail.auth');
      const relayEmail = gmailUsername?.['username'];
      if (!relayEmail) {
        res.status(400).json({ error: 'Gmail relay not configured. Set up domain with gmailRelay first.' });
        return;
      }

      const domain = config.domain.domain;
      const displayName = agentDisplayName || agentEmail.split('@')[0];

      res.json({
        status: 'ok',
        instructions: {
          summary: `Add "${agentEmail}" as a "Send mail as" alias in Gmail`,
          gmailSettingsUrl: 'https://mail.google.com/mail/u/0/#settings/accounts',
          steps: [
            { step: 1, action: 'Navigate to Gmail settings', url: 'https://mail.google.com/mail/u/0/#settings/accounts' },
            { step: 2, action: 'Click "Add another email address" under "Send mail as"' },
            { step: 3, action: 'Fill name and email', fields: { name: displayName, email: agentEmail, treatAsAlias: false } },
            { step: 4, action: 'Click "Next Step"' },
            {
              step: 5,
              action: 'IMPORTANT: Gmail auto-fills wrong SMTP values. Change ALL fields to:',
              fields: {
                smtpServer: 'smtp.gmail.com',
                port: 465,
                username: relayEmail,
                password: '[app password - same one used during domain setup]',
                security: 'SSL',
              },
            },
            { step: 6, action: 'Click "Add Account"' },
            { step: 7, action: `Check AgenticMail inbox for verification email from gmail-noreply@google.com, extract the confirmation link or code` },
            { step: 8, action: 'Open the confirmation link or enter the code to complete verification' },
          ],
        },
        domain,
        agentEmail,
      });
    } catch (err) {
      next(err);
    }
  });

  // Get gateway status
  router.get('/gateway/status', requireMaster, async (_req, res, next) => {
    try {
      const status = gatewayManager.getStatus();
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  // Search + buy a domain — requires master key
  router.post('/gateway/domain/purchase', requireMaster, async (req, res, next) => {
    try {
      const { keywords, tld } = req.body;
      if (!keywords?.length) {
        res.status(400).json({ error: 'keywords array is required' });
        return;
      }

      const purchaser = gatewayManager.getDomainPurchaser();
      if (!purchaser) {
        res.status(400).json({ error: 'Domain mode not configured. Set up Cloudflare credentials first.' });
        return;
      }

      const results = await purchaser.searchAvailable(keywords, tld ? [tld] : undefined);
      res.json({ domains: results });
    } catch (err) {
      next(err);
    }
  });

  // View DNS records for configured domain
  router.get('/gateway/domain/dns', requireMaster, async (_req, res, next) => {
    try {
      const config = gatewayManager.getConfig();
      if (config.mode !== 'domain' || !config.domain) {
        res.status(400).json({ error: 'Domain mode not configured' });
        return;
      }

      const dnsConfig = gatewayManager.getDNSConfigurator();
      if (!dnsConfig) {
        res.status(400).json({ error: 'DNS configurator not available' });
        return;
      }

      const verification = await dnsConfig.verify(config.domain.domain);
      res.json({ domain: config.domain.domain, dns: verification });
    } catch (err) {
      next(err);
    }
  });

  // Start/restart tunnel — requires master key
  router.post('/gateway/tunnel/start', requireMaster, async (_req, res, next) => {
    try {
      const config = gatewayManager.getConfig();
      if (config.mode !== 'domain' || !config.domain?.tunnelToken) {
        res.status(400).json({ error: 'Domain mode with tunnel not configured' });
        return;
      }

      const tunnel = gatewayManager.getTunnelManager();
      if (!tunnel) {
        res.status(400).json({ error: 'Tunnel manager not available' });
        return;
      }

      await tunnel.start(config.domain.tunnelToken);
      res.json({ status: 'ok', tunnel: tunnel.status() });
    } catch (err) {
      next(err);
    }
  });

  // Stop tunnel — requires master key
  router.post('/gateway/tunnel/stop', requireMaster, async (_req, res, next) => {
    try {
      const tunnel = gatewayManager.getTunnelManager();
      if (!tunnel) {
        res.status(400).json({ error: 'Tunnel manager not available' });
        return;
      }

      await tunnel.stop();
      res.json({ status: 'ok', tunnel: tunnel.status() });
    } catch (err) {
      next(err);
    }
  });

  // Send a test email to verify gateway works
  router.post('/gateway/test', requireMaster, async (req, res, next) => {
    try {
      const { to } = req.body;
      if (!to) {
        res.status(400).json({ error: 'to email address is required' });
        return;
      }

      const result = await gatewayManager.sendTestEmail(to);

      if (result) {
        res.json({ status: 'ok', messageId: result.messageId });
      } else {
        res.status(400).json({ error: 'No gateway configured or destination is local' });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
