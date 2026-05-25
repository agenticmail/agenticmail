import type { Database } from '../storage/db.js';
import { join } from 'node:path';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import nodemailer from 'nodemailer';
import { debug } from '../debug.js';
import { RelayGateway, formatPollError, type InboundEmail } from './relay.js';
import { CloudflareClient } from './cloudflare.js';
import { DomainPurchaser } from './domain-purchase.js';
import { DNSConfigurator } from './dns-setup.js';
import { TunnelManager } from './tunnel.js';
import type {
  GatewayConfig,
  GatewayMode,
  GatewayStatus,
  RelayConfig,
  DomainModeConfig,
  GatewayConfigRow,
  PurchasedDomainRow,
  RELAY_PRESETS,
} from './types.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SendMailOptions, SendResult, ParsedEmail, AddressInfo, ParsedAttachment } from '../mail/types.js';
import type { SendResultWithRaw } from '../mail/sender.js';
import { scoreEmail } from '../mail/spam-filter.js';
import type { StalwartAdmin } from '../stalwart/admin.js';
import type { AccountManager } from '../accounts/manager.js';
import type { Agent, AgentRole } from '../accounts/types.js';
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_ROLE } from '../accounts/types.js';
import { SmsManager, SmsPoller, parseGoogleVoiceSms, type SmsConfig } from '../sms/manager.js';
import {
  TelegramManager,
  TelegramPoller,
  parseTelegramOperatorReply,
  type TelegramConversationContext,
  type ParsedTelegramMessage,
  type TelegramConfig,
} from '../telegram/index.js';
import type {
  MatrixConfig,
  MatrixConversationContext,
  ParsedMatrixMessage,
} from '../matrix/index.js';
import { PhoneManager } from '../phone/manager.js';
import { ConversationSessionManager } from '../conversation/session.js';

export interface LocalSmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface GatewayManagerOptions {
  db: Database;
  stalwart: StalwartAdmin;
  accountManager?: AccountManager;
  localSmtp?: LocalSmtpConfig;
  onInboundMail?: (agentName: string, mail: InboundEmail) => void | Promise<void>;
  /** Master key used to encrypt credentials at rest in SQLite. */
  encryptionKey?: string;
}

/**
 * GatewayManager orchestrates relay and domain modes for sending/receiving
 * real internet email. It coordinates between the relay gateway, Cloudflare
 * services (DNS, tunnels, registrar), and the local Stalwart instance.
 */
export class GatewayManager {
  private db: Database;
  private stalwart: StalwartAdmin;
  private accountManager: AccountManager | null;
  private relay: RelayGateway;
  private config: GatewayConfig = { mode: 'none' };
  private cfClient: CloudflareClient | null = null;
  private tunnel: TunnelManager | null = null;
  private dnsConfigurator: DNSConfigurator | null = null;
  private domainPurchaser: DomainPurchaser | null = null;
  private smsManager: SmsManager | null = null;
  private smsPollers: Map<string, SmsPoller> = new Map();
  private telegramManager: TelegramManager | null = null;
  private telegramPollers: Map<string, TelegramPoller> = new Map();
  private encryptionKey: string | null = null;

  constructor(private options: GatewayManagerOptions) {
    this.db = options.db;
    this.stalwart = options.stalwart;
    this.accountManager = options.accountManager ?? null;
    this.encryptionKey = options.encryptionKey ?? process.env.AGENTICMAIL_MASTER_KEY ?? null;

    // Wire up inbound mail handler: either user-provided or built-in local delivery
    const inboundHandler = options.onInboundMail ?? (
      this.accountManager && options.localSmtp
        ? this.deliverInboundLocally.bind(this)
        : undefined
    );

    this.relay = new RelayGateway({
      onInboundMail: inboundHandler,
      defaultAgentName: DEFAULT_AGENT_NAME,
    });

    // Load saved config from DB (may fail if migrations haven't run yet)
    try { this.loadConfig(); } catch { this.config = { mode: 'none' }; }

    // Initialize SMS manager
    try { this.smsManager = new SmsManager(options.db as any); } catch {}

    // Initialize Telegram manager. The encryption key is the same master
    // key used for SMS/phone — Telegram credentials (bot token, webhook
    // secret) are stored encrypted at rest under it. A missing key
    // means tests / no-key deployments; the manager tolerates both.
    try {
      this.telegramManager = new TelegramManager(options.db as any, this.encryptionKey ?? undefined);
    } catch {
      this.telegramManager = null;
    }
  }

  /**
   * Check if a message has already been delivered to an agent (deduplication).
   */
  isAlreadyDelivered(messageId: string, agentName: string): boolean {
    if (!messageId) return false;
    const row = this.db.prepare('SELECT 1 FROM delivered_messages WHERE message_id = ? AND agent_name = ?').get(messageId, agentName);
    return !!row;
  }

  /**
   * Record that a message was delivered to an agent.
   */
  recordDelivery(messageId: string, agentName: string): void {
    if (!messageId) return;
    this.db.prepare('INSERT OR IGNORE INTO delivered_messages (message_id, agent_name) VALUES (?, ?)').run(messageId, agentName);
  }

  /**
   * Built-in inbound mail handler: delivers relay inbound mail to agent's local Stalwart mailbox.
   * Authenticates as the agent to send to their own mailbox (Stalwart requires sender = auth user).
   *
   * Also intercepts owner replies to approval notification emails — if the reply says
   * "approve" or "reject", the pending outbound email is automatically processed.
   */
  private async deliverInboundLocally(agentName: string, mail: InboundEmail): Promise<void> {
    if (!this.accountManager || !this.options.localSmtp) {
      console.warn('[GatewayManager] Cannot deliver inbound: no accountManager or localSmtp config');
      return;
    }

    // Deduplicate: skip if we've already delivered this message to this agent
    if (mail.messageId && this.isAlreadyDelivered(mail.messageId, agentName)) return;

    // SMS detection: check if this is a Google Voice forwarded SMS
    if (this.smsManager) {
      try {
        const smsBody = mail.text || mail.html || '';
        const parsedSms = parseGoogleVoiceSms(smsBody, mail.from);
        if (parsedSms) {
          // Find the agent this belongs to and check if SMS is configured
          const agent = this.accountManager ? await this.accountManager.getByName(agentName) : null;
          const agentId = agent?.id;
          if (agentId) {
            const smsConfig = this.smsManager.getSmsConfig(agentId);
            if (smsConfig?.enabled && smsConfig.sameAsRelay) {
              this.smsManager.recordInbound(agentId, parsedSms);
              console.log(`[GatewayManager] SMS received from ${parsedSms.from}: "${parsedSms.body.slice(0, 50)}..." → agent ${agentName}`);
              // Record delivery so we don't re-process
              if (mail.messageId) this.recordDelivery(mail.messageId, agentName);
              // Still deliver the email too (agent might want to see raw), but we've recorded the SMS
            }
          }
        }
      } catch (err) {
        // Non-fatal — continue with normal email delivery
        debug('GatewayManager', `SMS detection error: ${(err as Error).message}`);
      }
    }

    // Check if this is a reply to a pending approval notification
    try {
      await this.tryProcessApprovalReply(mail);
    } catch (err) {
      console.warn(`[GatewayManager] Approval reply check failed: ${(err as Error).message}`);
    }

    // --- Spam filter: skip for internal @localhost emails (no SPF/DKIM to check) ---
    const parsed = inboundToParsedEmail(mail);
    const { isInternalEmail } = await import('../mail/spam-filter.js');
    if (!isInternalEmail(parsed)) {
      const spamResult = scoreEmail(parsed);
      if (spamResult.isSpam) {
        console.warn(`[GatewayManager] Spam blocked (score=${spamResult.score}, category=${spamResult.topCategory}): "${mail.subject}" from ${mail.from}`);
        // Record delivery so we don't re-process on next poll
        if (mail.messageId) this.recordDelivery(mail.messageId, agentName);
        return;
      }
    }

    let agent = await this.accountManager.getByName(agentName);
    if (!agent && agentName !== DEFAULT_AGENT_NAME) {
      // Unknown agent — try the default agent as fallback
      agent = await this.accountManager.getByName(DEFAULT_AGENT_NAME);
      if (agent) {
        console.warn(`[GatewayManager] Agent "${agentName}" not found, delivering to default agent "${DEFAULT_AGENT_NAME}"`);
      }
    }
    if (!agent) {
      console.warn(`[GatewayManager] No agent to deliver inbound mail (target: "${agentName}")`);
      return;
    }

    const agentPassword = (agent.metadata as Record<string, any>)?._password;
    if (!agentPassword) {
      console.warn(`[GatewayManager] No password for agent "${agentName}", cannot deliver`);
      return;
    }

    // Create a transport authenticated as the agent, sending to themselves
    const transport = nodemailer.createTransport({
      host: this.options.localSmtp.host,
      port: this.options.localSmtp.port,
      secure: false,
      auth: {
        user: agent.stalwartPrincipal,
        pass: agentPassword,
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    try {
      await transport.sendMail({
        from: `${mail.from} <${agent.email}>`,
        to: agent.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html || undefined,
        replyTo: mail.from,
        inReplyTo: mail.inReplyTo,
        references: Array.isArray(mail.references) ? mail.references.join(' ') : mail.references,
        headers: {
          'X-AgenticMail-Relay': 'inbound',
          'X-Original-From': mail.from,
          ...(mail.messageId ? { 'X-Original-Message-Id': mail.messageId } : {}),
        },
        attachments: mail.attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      // Record delivery for deduplication
      if (mail.messageId) this.recordDelivery(mail.messageId, agentName);
    } catch (err) {
      console.error(`[GatewayManager] Failed to deliver to ${agent.email}: ${(err as Error).message}`);
      throw err; // Re-throw so the relay knows delivery failed and doesn't mark as seen
    } finally {
      transport.close();
    }
  }

  /**
   * Check if an inbound email is a reply to a pending approval notification.
   * If the reply body starts with "approve"/"yes" or "reject"/"no", automatically
   * process the pending email (send it or discard it) and confirm to the owner.
   */
  private async tryProcessApprovalReply(mail: InboundEmail): Promise<boolean> {
    // Need In-Reply-To or References to match against notification
    const candidateIds: string[] = [];
    if (mail.inReplyTo) candidateIds.push(mail.inReplyTo);
    if (mail.references) candidateIds.push(...mail.references);
    if (candidateIds.length === 0) return false;

    // Check if any of these IDs match a pending notification
    let row: any = null;
    for (const id of candidateIds) {
      row = this.db.prepare(
        `SELECT * FROM pending_outbound WHERE notification_message_id = ? AND status = 'pending'`,
      ).get(id);
      if (row) break;
    }
    if (!row) return false;

    // Parse the reply body for approval/rejection keywords
    const body = (mail.text || '').trim();
    // Extract meaningful lines (skip empty lines and quoted text starting with >)
    const lines = body.split('\n')
      .filter(l => !l.startsWith('>') && l.trim().length > 0);
    const firstLine = (lines[0] || '').trim().toLowerCase();

    const approvePattern = /^(approve[d]?|yes|send\s*it|send|go\s*ahead|lgtm|ok(?:ay)?)\b/;
    const rejectPattern = /^(reject(?:ed)?|no|den(?:y|ied)|don'?t\s*send|do\s*not\s*send|cancel|block(?:ed)?)\b/;

    let action: 'approve' | 'reject' | null = null;
    if (approvePattern.test(firstLine)) {
      action = 'approve';
    } else if (rejectPattern.test(firstLine)) {
      action = 'reject';
    }

    if (!action) return false;

    try {
      if (action === 'approve') {
        await this.executeApproval(row);
      } else {
        this.db.prepare(
          `UPDATE pending_outbound SET status = 'rejected', resolved_at = datetime('now'), resolved_by = 'owner-reply' WHERE id = ?`,
        ).run(row.id);
      }

      // Send confirmation email to owner
      await this.sendApprovalConfirmation(row, action, mail.messageId);
    } catch (err) {
      console.error(`[GatewayManager] Failed to process approval reply for ${row.id}:`, err);
    }

    return true;
  }

  /**
   * Execute approval of a pending outbound email: look up the agent, reconstitute
   * attachments, and send the email via gateway routing or local SMTP.
   */
  private async executeApproval(row: any): Promise<void> {
    if (!this.accountManager) {
      throw new Error('AccountManager required for approval processing');
    }

    const agent = await this.accountManager.getById(row.agent_id);
    if (!agent) {
      console.warn(`[GatewayManager] Cannot approve pending ${row.id}: agent ${row.agent_id} no longer exists`);
      this.db.prepare(
        `UPDATE pending_outbound SET status = 'rejected', resolved_at = datetime('now'), resolved_by = 'owner-reply', error = 'Agent no longer exists' WHERE id = ?`,
      ).run(row.id);
      return;
    }

    const mailOpts = JSON.parse(row.mail_options);

    // Refresh fromName from current agent metadata
    const ownerName = (agent.metadata as Record<string, any>)?.ownerName;
    mailOpts.fromName = ownerName ? `${agent.name} from ${ownerName}` : agent.name;

    // Reconstitute JSON-roundtripped Buffer objects in attachments
    if (Array.isArray(mailOpts.attachments)) {
      for (const att of mailOpts.attachments) {
        if (att.content && typeof att.content === 'object' && att.content.type === 'Buffer' && Array.isArray(att.content.data)) {
          att.content = Buffer.from(att.content.data);
        }
      }
    }

    // Send via gateway routing (relay or domain mode)
    const gatewayResult = await this.routeOutbound(agent.name, mailOpts);

    if (!gatewayResult && this.options.localSmtp) {
      // Fallback: send via local SMTP directly
      const agentPassword = (agent.metadata as Record<string, any>)?._password;
      if (!agentPassword) {
        throw new Error(`No password for agent "${agent.name}"`);
      }

      const transport = nodemailer.createTransport({
        host: this.options.localSmtp.host,
        port: this.options.localSmtp.port,
        secure: false,
        auth: {
          user: agent.stalwartPrincipal,
          pass: agentPassword,
        },
        tls: { rejectUnauthorized: false },
      });

      try {
        await transport.sendMail({
          from: mailOpts.fromName ? `${mailOpts.fromName} <${agent.email}>` : agent.email,
          to: Array.isArray(mailOpts.to) ? mailOpts.to.join(', ') : mailOpts.to,
          subject: mailOpts.subject,
          text: mailOpts.text || undefined,
          html: mailOpts.html || undefined,
          cc: mailOpts.cc || undefined,
          bcc: mailOpts.bcc || undefined,
          replyTo: mailOpts.replyTo || undefined,
          inReplyTo: mailOpts.inReplyTo || undefined,
          references: Array.isArray(mailOpts.references) ? mailOpts.references.join(' ') : (mailOpts.references || undefined),
          attachments: mailOpts.attachments?.map((a: any) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
            encoding: a.encoding,
          })),
        });
      } finally {
        transport.close();
      }
    }

    // Mark as approved in DB
    this.db.prepare(
      `UPDATE pending_outbound SET status = 'approved', resolved_at = datetime('now'), resolved_by = 'owner-reply' WHERE id = ?`,
    ).run(row.id);

    // Pending email approved and sent
  }

  /**
   * Send a confirmation email back to the owner after processing an approval reply.
   */
  private async sendApprovalConfirmation(row: any, action: 'approve' | 'reject', replyMessageId?: string): Promise<void> {
    const ownerEmail = this.config.relay?.email;
    if (!ownerEmail || !this.accountManager) return;

    const mailOpts = JSON.parse(row.mail_options);
    const agent = await this.accountManager.getById(row.agent_id);
    const agentName = agent?.name || 'unknown agent';

    const statusText = action === 'approve'
      ? 'APPROVED and sent'
      : 'REJECTED and discarded';

    this.routeOutbound(agentName, {
      to: ownerEmail,
      subject: `Re: [Approval Required] Blocked email from "${agentName}" — ${statusText}`,
      text: [
        `The blocked email has been ${statusText}.`,
        '',
        `  To: ${Array.isArray(mailOpts.to) ? mailOpts.to.join(', ') : mailOpts.to}`,
        `  Subject: ${mailOpts.subject}`,
        '',
        action === 'approve'
          ? 'The email has been delivered to the recipient.'
          : 'The email has been discarded and will not be sent.',
      ].join('\n'),
      fromName: 'Agentic Mail',
      inReplyTo: replyMessageId,
    }).catch((err) => {
      console.warn(`[GatewayManager] Failed to send approval confirmation: ${(err as Error).message}`);
    });
  }

  // --- Relay Mode ---

  async setupRelay(config: RelayConfig, options?: {
    defaultAgentName?: string;
    defaultAgentRole?: AgentRole;
    skipDefaultAgent?: boolean;
  }): Promise<{ agent?: Agent }> {
    // Validate by connecting
    await this.relay.setup(config);

    // Store config
    this.config = { mode: 'relay', relay: config };
    this.saveConfig();

    // Auto-create default agent (idempotent — skips if already exists)
    let agent: Agent | undefined;
    if (!options?.skipDefaultAgent && this.accountManager) {
      const agentName = options?.defaultAgentName ?? DEFAULT_AGENT_NAME;
      const agentRole = options?.defaultAgentRole ?? DEFAULT_AGENT_ROLE;
      const existing = await this.accountManager.getByName(agentName);
      if (existing) {
        agent = existing;
      } else {
        agent = await this.accountManager.create({
          name: agentName,
          role: agentRole,
          gateway: 'relay',
        });
      }
    }

    // Wire up UID persistence and start IMAP polling
    this.relay.onUidAdvance = (uid: number) => this.saveLastSeenUid(uid);
    await this.relay.startPolling();

    return { agent };
  }

  // --- Domain Mode ---

  async setupDomain(options: {
    cloudflareToken: string;
    cloudflareAccountId: string;
    domain?: string;
    purchase?: { keywords: string[]; tld?: string };
    outboundWorkerUrl?: string;
    outboundSecret?: string;
    gmailRelay?: {
      email: string;
      appPassword: string;
    };
  }): Promise<{ domain: string; dnsConfigured: boolean; tunnelId: string; outboundRelay?: { configured: boolean; provider: string }; nextSteps?: string[] }> {
    // Initialize Cloudflare client
    this.cfClient = new CloudflareClient(options.cloudflareToken, options.cloudflareAccountId);
    this.dnsConfigurator = new DNSConfigurator(this.cfClient);
    this.tunnel = new TunnelManager(this.cfClient);
    this.domainPurchaser = new DomainPurchaser(this.cfClient);

    let domain = options.domain;

    // Step 1: Purchase domain if needed
    if (!domain && options.purchase) {
      const available = await this.domainPurchaser.searchAvailable(
        options.purchase.keywords,
        options.purchase.tld ? [options.purchase.tld] : undefined,
      );

      const first = available.find((d) => d.available && !d.premium);
      if (!first) {
        throw new Error('No available domains found for the given keywords');
      }

      await this.domainPurchaser.purchase(first.domain);
      domain = first.domain;

      // Record the purchase
      this.db.prepare(`
        INSERT OR REPLACE INTO purchased_domains (domain, registrar) VALUES (?, ?)
      `).run(domain, 'cloudflare');
    }

    if (!domain) {
      throw new Error('No domain specified and no purchase keywords provided');
    }

    // Step 2: Get or create zone in Cloudflare
    let zone = await this.cfClient.getZone(domain);
    if (!zone) {
      zone = await this.cfClient.createZone(domain);
    }

    // Step 2b: Backup existing DNS records before making any changes
    const existingRecords = await this.cfClient.listDnsRecords(zone.id);
    const { homedir } = await import('node:os');
    const backupDir = join(homedir(), '.agenticmail');
    const backupPath = join(backupDir, `dns-backup-${domain}-${Date.now()}.json`);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(backupPath, JSON.stringify({
      domain,
      zoneId: zone.id,
      backedUpAt: new Date().toISOString(),
      records: existingRecords,
    }, null, 2));
    console.log(`[GatewayManager] DNS backup saved to ${backupPath} (${existingRecords.length} records)`);

    // Warn about records that will be modified
    const rootRecords = existingRecords.filter((r: any) =>
      r.name === domain && (r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME' || r.type === 'MX')
    );
    if (rootRecords.length > 0) {
      console.warn(`[GatewayManager] ⚠️  WARNING: ${rootRecords.length} existing root DNS record(s) for ${domain} will be modified:`);
      for (const r of rootRecords) {
        console.warn(`[GatewayManager]   ${r.type} ${r.name} → ${r.content}`);
      }
      console.warn(`[GatewayManager] Backup saved at: ${backupPath}`);
    }

    // Step 3: Create Cloudflare Tunnel
    const tunnelConfig = await this.tunnel.create(`agenticmail-${domain}`);

    // Step 4a: Set Stalwart hostname to match domain (critical for EHLO greeting)
    console.log(`[GatewayManager] Configuring mail server hostname: ${domain}`);
    try {
      await this.stalwart.setHostname(domain);
      console.log(`[GatewayManager] Mail server hostname set to ${domain}`);
    } catch (err) {
      console.warn(`[GatewayManager] Failed to set hostname (EHLO may show "localhost"): ${(err as Error).message}`);
    }

    // Step 4b: Configure DKIM signing in Stalwart
    console.log('[GatewayManager] Setting up DKIM signing...');
    let dkimPublicKey: string | undefined;
    let dkimSelector = 'agenticmail';
    try {
      const dkim = await this.stalwart.createDkimSignature(domain, dkimSelector);
      dkimPublicKey = dkim.publicKey;
      console.log(`[GatewayManager] DKIM signature created (selector: ${dkimSelector})`);
    } catch (err) {
      console.warn(`[GatewayManager] DKIM setup failed (email may land in spam): ${(err as Error).message}`);
    }

    // Step 5: Configure DNS records — clean up conflicting records first
    const tunnelRemoved = await this.dnsConfigurator.configureForTunnel(domain, zone.id, tunnelConfig.tunnelId);
    if (tunnelRemoved.length > 0) {
      console.log(`[GatewayManager] Removed ${tunnelRemoved.length} conflicting DNS record(s) for tunnel`);
    }
    const emailDns = await this.dnsConfigurator.configureForEmail(domain, zone.id, {
      dkimSelector,
      dkimPublicKey,
    });
    if (emailDns.removed.length > 0) {
      console.log(`[GatewayManager] Replaced ${emailDns.removed.length} old DNS record(s) for email`);
    }

    // Step 6: Start tunnel
    await this.tunnel.start(tunnelConfig.tunnelToken);
    await this.tunnel.createIngress(tunnelConfig.tunnelId, domain);

    // Step 7a: Enable Email Routing on the zone
    console.log('[GatewayManager] Enabling Cloudflare Email Routing...');
    try {
      await this.cfClient.enableEmailRouting(zone.id);
      console.log('[GatewayManager] Email Routing enabled');
    } catch (err) {
      // May already be enabled or need manual activation for first-time zones
      console.warn(`[GatewayManager] Email Routing enable failed (may already be active): ${(err as Error).message}`);
    }

    // Step 7b: Deploy inbound Email Worker
    const workerName = `agenticmail-inbound-${domain.replace(/\./g, '-')}`;
    const inboundUrl = `https://${domain}/api/agenticmail/mail/inbound`;
    const inboundSecret = options.outboundSecret || crypto.randomUUID();
    console.log(`[GatewayManager] Deploying Email Worker "${workerName}"...`);
    console.log(`[GatewayManager] Set AGENTICMAIL_INBOUND_SECRET="${inboundSecret}" in your environment to match the worker`);
    try {
      const { EMAIL_WORKER_SCRIPT } = await import('./email-worker-template.js');
      await this.cfClient.deployEmailWorker(workerName, EMAIL_WORKER_SCRIPT, {
        INBOUND_URL: inboundUrl,
        INBOUND_SECRET: inboundSecret,
      });
      console.log(`[GatewayManager] Email Worker deployed: ${workerName}`);
    } catch (err) {
      console.warn(`[GatewayManager] Email Worker deployment failed: ${(err as Error).message}`);
      console.warn('[GatewayManager] You may need to deploy the worker manually or check Workers permissions on your API token');
    }

    // Step 7c: Set catch-all Email Routing rule → Worker
    console.log('[GatewayManager] Configuring catch-all Email Routing rule...');
    try {
      await this.cfClient.setCatchAllWorkerRule(zone.id, workerName);
      console.log('[GatewayManager] Catch-all rule set: all emails → Worker → AgenticMail');
    } catch (err) {
      console.warn(`[GatewayManager] Catch-all rule failed: ${(err as Error).message}`);
    }

    // Step 8: Create domain principal in Stalwart
    try {
      await this.stalwart.createPrincipal({
        type: 'domain',
        name: domain,
        description: `AgenticMail gateway domain: ${domain}`,
      });
    } catch {
      // Domain may already exist in Stalwart
    }

    // Step 8b: Add @domain email aliases to all existing agent principals
    // So agents can send from agent@domain instead of only agent@localhost
    if (this.accountManager) {
      try {
        const agents = await this.accountManager.list();
        for (const agent of agents) {
          const domainEmail = `${agent.name.toLowerCase()}@${domain}`;
          try {
            const principal = await this.stalwart.getPrincipal(agent.stalwartPrincipal);
            const emails: string[] = principal.emails ?? [];
            if (!emails.includes(domainEmail)) {
              await this.stalwart.addEmailAlias(agent.stalwartPrincipal, domainEmail);
              console.log(`[GatewayManager] Added ${domainEmail} to Stalwart principal "${agent.stalwartPrincipal}"`);
            }
          } catch (err) {
            console.warn(`[GatewayManager] Could not update principal for ${agent.name}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        console.warn(`[GatewayManager] Could not update agent email aliases: ${(err as Error).message}`);
      }
    }

    // Step 9: Store config
    const domainConfig: DomainModeConfig = {
      domain,
      cloudflareApiToken: options.cloudflareToken,
      cloudflareAccountId: options.cloudflareAccountId,
      tunnelId: tunnelConfig.tunnelId,
      tunnelToken: tunnelConfig.tunnelToken,
      outboundWorkerUrl: options.outboundWorkerUrl,
      outboundSecret: options.outboundSecret,
      inboundSecret,
      emailWorkerName: workerName,
    };

    this.config = { mode: 'domain', domain: domainConfig };
    this.saveConfig();

    // Update purchased_domains record
    this.db.prepare(`
      INSERT OR REPLACE INTO purchased_domains (domain, registrar, cloudflare_zone_id, tunnel_id, dns_configured, tunnel_active)
      VALUES (?, 'cloudflare', ?, ?, 1, 1)
    `).run(domain, zone.id, tunnelConfig.tunnelId);

    // Step 10: Configure outbound relay through Gmail SMTP (if provided)
    let outboundRelay: { configured: boolean; provider: string } | undefined;
    const nextSteps: string[] = [];

    if (options.gmailRelay) {
      console.log('[GatewayManager] Configuring outbound relay through Gmail SMTP...');
      try {
        await this.stalwart.configureOutboundRelay({
          smtpHost: 'smtp.gmail.com',
          smtpPort: 465,
          username: options.gmailRelay.email,
          password: options.gmailRelay.appPassword,
        });
        outboundRelay = { configured: true, provider: 'gmail' };
        console.log('[GatewayManager] Outbound relay configured: all external mail routes through Gmail SMTP');

        // Add "Send mail as" alias instructions
        const gmailSettingsUrl = 'https://mail.google.com/mail/u/0/#settings/accounts';
        nextSteps.push(
          `IMPORTANT: To send emails showing your domain (not ${options.gmailRelay.email}), add each agent email as a "Send mail as" alias in Gmail:`,
          `1. Open: ${gmailSettingsUrl}`,
          `2. Under "Send mail as" click "Add another email address"`,
          `3. Enter agent name and email (e.g. "Secretary" / secretary@${domain}), uncheck "Treat as alias"`,
          `4. On the SMTP screen, Gmail will auto-fill WRONG values. You MUST change them to:`,
          `   SMTP Server: smtp.gmail.com | Port: 465 | Username: ${options.gmailRelay.email} | Password: [your app password] | Select "Secured connection using SSL"`,
          `5. Click "Add Account". Gmail sends a verification email to the agent's @${domain} address`,
          `6. Check AgenticMail inbox for the code/link from gmail-noreply@google.com, then confirm`,
          `7. Repeat for each agent. Or ask your OpenClaw agent to automate this via the browser tool.`,
        );
      } catch (err) {
        outboundRelay = { configured: false, provider: 'gmail' };
        console.warn(`[GatewayManager] Outbound relay setup failed: ${(err as Error).message}`);
        nextSteps.push(`Outbound relay setup failed: ${(err as Error).message}. You can configure it manually later.`);
      }
    } else {
      nextSteps.push(
        'Outbound email: Your server sends directly from your IP. If your IP lacks a PTR record (common for residential connections), emails may be rejected.',
        'To fix this, re-run setup with gmailRelay: { email: "you@gmail.com", appPassword: "xxxx xxxx xxxx xxxx" } to relay outbound mail through Gmail SMTP.',
        'You will need a Gmail app password: https://myaccount.google.com/apppasswords',
      );
    }

    return {
      domain,
      dnsConfigured: true,
      tunnelId: tunnelConfig.tunnelId,
      outboundRelay,
      nextSteps: nextSteps.length > 0 ? nextSteps : undefined,
    };
  }

  // --- Test ---

  /**
   * Send a test email through the gateway without requiring a real agent.
   * In relay mode, uses "test" as the sub-address.
   * In domain mode, uses the first available agent (Stalwart needs real credentials).
   */
  async sendTestEmail(to: string): Promise<SendResultWithRaw | null> {
    const mail: SendMailOptions = {
      to,
      subject: 'AgenticMail Gateway Test',
      text: 'This is a test email sent via the AgenticMail gateway to verify your configuration is working.',
    };

    if (this.config.mode === 'relay') {
      return this.routeOutbound('test', mail);
    }

    if (this.config.mode === 'domain' && this.accountManager) {
      const agents = await this.accountManager.list();
      if (agents.length === 0) {
        throw new Error('No agents exist yet. Create an agent first, then send a test email.');
      }
      // Prefer a persistent/primary agent over test leftovers
      const primary = agents.find(a => (a.metadata as any)?.persistent) ?? agents[0];
      return this.routeOutbound(primary.name, mail);
    }

    return null;
  }

  // --- Routing ---

  /**
   * Route an outbound email. If the destination is external and a gateway
   * is configured, send via the appropriate channel.
   * Returns null if the mail should be sent via local Stalwart.
   */
  async routeOutbound(agentName: string, mail: SendMailOptions): Promise<SendResultWithRaw | null> {
    if (this.config.mode === 'none') return null;

    // Check ALL recipients (to, cc, bcc) — if every address is local, skip the relay.
    // This prevents inter-agent @localhost emails from ever touching Gmail.
    const collect = (field: string | string[] | undefined): string[] => {
      if (!field) return [];
      if (Array.isArray(field)) return field;
      return field.split(',').map(s => s.trim()).filter(Boolean);
    };
    const allRecipients = [
      ...collect(mail.to as any),
      ...collect(mail.cc as any),
      ...collect(mail.bcc as any),
    ];

    const localDomain = this.config.domain?.domain?.toLowerCase();
    const isExternal = allRecipients.some((addr) => {
      const domain = (addr.split('@')[1] ?? 'localhost').toLowerCase();
      return domain !== 'localhost' && domain !== localDomain;
    });

    if (!isExternal) return null;

    if (this.config.mode === 'relay') {
      return this.relay.sendViaRelay(agentName, mail);
    }

    // Domain mode: submit to Stalwart for direct MX delivery (DKIM signed, FROM preserved)
    if (this.config.mode === 'domain' && this.config.domain) {
      return this.sendViaStalwart(agentName, mail);
    }

    return null;
  }

  /**
   * Send email by submitting to local Stalwart via SMTP (port 587).
   * Stalwart handles DKIM signing and delivery (direct or via relay).
   * Reply-To is set to the agent's domain email so replies come back
   * to the domain (handled by Cloudflare Email Routing → inbound Worker).
   */
  private async sendViaStalwart(agentName: string, mail: SendMailOptions): Promise<SendResultWithRaw> {
    if (!this.accountManager) {
      throw new Error('AccountManager required for domain mode outbound');
    }

    const agent = await this.accountManager.getByName(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not found`);
    }

    const agentPassword = (agent.metadata as Record<string, any>)?._password;
    if (!agentPassword) {
      throw new Error(`No password for agent "${agentName}"`);
    }

    // Replace @localhost with the configured domain for outbound email
    const domainName = this.config.domain?.domain;
    const fromAddr = domainName
      ? agent.email.replace(/@localhost$/, `@${domainName}`)
      : agent.email;
    const displayName = mail.fromName || agentName;
    const from = `${displayName} <${fromAddr}>`;

    // Ensure the domain email is an allowed address in Stalwart
    // (agents created before domain setup only have @localhost)
    if (domainName && fromAddr !== agent.email) {
      try {
        const principal = await this.stalwart.getPrincipal(agent.stalwartPrincipal);
        const emails: string[] = principal.emails ?? [];
        if (!emails.includes(fromAddr)) {
          await this.stalwart.addEmailAlias(agent.stalwartPrincipal, fromAddr);
          console.log(`[GatewayManager] Auto-added ${fromAddr} to Stalwart principal "${agent.stalwartPrincipal}"`);
        }
      } catch (err) {
        console.warn(`[GatewayManager] Could not auto-add domain email alias: ${(err as Error).message}`);
      }
    }
    const recipients = Array.isArray(mail.to) ? mail.to : [mail.to];

    const mailOpts: any = {
      from,
      to: recipients.join(', '),
      cc: mail.cc ? (Array.isArray(mail.cc) ? mail.cc.join(', ') : mail.cc) : undefined,
      bcc: mail.bcc ? (Array.isArray(mail.bcc) ? mail.bcc.join(', ') : mail.bcc) : undefined,
      subject: mail.subject,
      text: mail.text || undefined,
      // The `html` field is the literal HTML body of the outbound
      // mail — by design it is whatever the sender chose to compose.
      // CodeQL `js/xss` flags this because the value flows from user
      // input, but nodemailer is the SMTP serializer, not an HTML
      // renderer; XSS would only occur if the recipient's MUA
      // executed the body, which is outside our trust boundary.
      // The outbound-guard (packages/core/src/mail/outbound-guard.ts)
      // already scores HTML bodies for suspicious patterns at the
      // pre-send step. lgtm[js/xss]
      html: mail.html || undefined,
      replyTo: mail.replyTo || from,
      inReplyTo: mail.inReplyTo || undefined,
      references: Array.isArray(mail.references) ? mail.references.join(' ') : (mail.references || undefined),
      headers: {
        'X-Mailer': 'AgenticMail/1.0',
      },
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        encoding: a.encoding,
      })),
    };

    // Build raw RFC822 message for Sent folder copy
    const composer = new MailComposer(mailOpts);
    const raw = await composer.compile().build();

    // Submit to local Stalwart via SMTP submission port (587)
    // Stalwart signs DKIM, resolves MX, delivers on port 25
    const smtpHost = this.options.localSmtp?.host ?? '127.0.0.1';
    const smtpPort = this.options.localSmtp?.port ?? 587;

    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: false,
      auth: {
        user: agent.stalwartPrincipal,
        pass: agentPassword,
      },
      tls: { rejectUnauthorized: false },
    });

    try {
      const info = await transport.sendMail(mailOpts);

      debug('GatewayManager', `Sent via Stalwart: ${info.messageId} → ${info.response}`);

      return {
        messageId: info.messageId,
        envelope: { from, to: recipients },
        raw,
      };
    } finally {
      transport.close();
    }
  }

  // --- Status ---

  getStatus(): GatewayStatus {
    const status: GatewayStatus = {
      mode: this.config.mode,
      healthy: false,
    };

    if (this.config.mode === 'relay' && this.config.relay) {
      status.relay = {
        provider: this.config.relay.provider,
        email: this.config.relay.email,
        polling: this.relay.isPolling(),
      };
      status.healthy = this.relay.isConfigured();
    }

    if (this.config.mode === 'domain' && this.config.domain) {
      const tunnelStatus = this.tunnel?.status();
      status.domain = {
        domain: this.config.domain.domain,
        dnsConfigured: true,
        tunnelActive: tunnelStatus?.running ?? false,
      };
      status.healthy = tunnelStatus?.running ?? false;
    }

    if (this.config.mode === 'none') {
      status.healthy = true;
    }

    return status;
  }

  getMode(): GatewayMode {
    return this.config.mode;
  }

  getConfig(): GatewayConfig {
    return this.config;
  }

  // --- Domain Purchase ---

  getStalwart(): StalwartAdmin {
    return this.stalwart;
  }

  getDomainPurchaser(): DomainPurchaser | null {
    return this.domainPurchaser;
  }

  getDNSConfigurator(): DNSConfigurator | null {
    return this.dnsConfigurator;
  }

  getTunnelManager(): TunnelManager | null {
    return this.tunnel;
  }

  getRelay(): RelayGateway {
    return this.relay;
  }

  /**
   * Search the connected relay account (Gmail/Outlook) for emails matching criteria.
   * Returns empty array if relay is not configured.
   */
  async searchRelay(criteria: {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    since?: Date;
    before?: Date;
    seen?: boolean;
  }, maxResults = 50): Promise<import('./relay.js').RelaySearchResult[]> {
    if (this.config.mode !== 'relay' || !this.relay.isConfigured()) return [];
    return this.relay.searchRelay(criteria, maxResults);
  }

  /**
   * Import an email from the connected relay account into an agent's local inbox.
   * Fetches the full message from relay IMAP and delivers it locally, preserving
   * all headers (Message-ID, In-Reply-To, References) for thread continuity.
   */
  async importRelayMessage(relayUid: number, agentName: string): Promise<{ success: boolean; error?: string }> {
    if (this.config.mode !== 'relay' || !this.relay.isConfigured()) {
      return { success: false, error: 'Relay not configured' };
    }

    const mail = await this.relay.fetchRelayMessage(relayUid);
    if (!mail) {
      return { success: false, error: 'Could not fetch message from relay account' };
    }

    try {
      await this.deliverInboundLocally(agentName, mail);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- SMS Polling ---

  /**
   * Start SMS pollers for all agents that have separate GV Gmail credentials.
   * Agents with sameAsRelay=true are handled in deliverInboundLocally.
   */
  private async startSmsPollers(): Promise<void> {
    if (!this.smsManager || !this.accountManager) return;

    // List all agents and check for SMS configs with separate credentials
    const agents = this.db.prepare('SELECT id, name, metadata FROM agents').all() as unknown as Array<{ id: string; name: string; metadata: string }>;

    for (const agent of agents) {
      try {
        const meta = JSON.parse(agent.metadata || '{}');
        const smsConfig = meta.sms as SmsConfig | undefined;
        if (!smsConfig?.enabled || !smsConfig.forwardingPassword || smsConfig.sameAsRelay) continue;

        // This agent has separate GV Gmail — start a dedicated poller
        const poller = new SmsPoller(this.smsManager, agent.id, smsConfig);
        poller.onSmsReceived = (agentId, sms) => {
          console.log(`[SmsPoller] SMS received for agent ${agent.name}: from ${sms.from}, body="${sms.body.slice(0, 50)}..."`);
        };

        this.smsPollers.set(agent.id, poller);
        await poller.startPolling();
        console.log(`[GatewayManager] SMS poller started for agent "${agent.name}" (${smsConfig.forwardingEmail})`);
      } catch {
        // Skip agents with invalid config
      }
    }
  }

  // --- Telegram Polling ---

  /**
   * Start a long-poll loop for every agent whose Telegram channel is
   * configured + enabled + in poll mode. Webhook-mode agents skip — the
   * webhook route already calls back into the same agent-wake bridge.
   *
   * Each new inbound Telegram message (that isn't an operator-query
   * reply) is converted to a synthetic email and delivered into the
   * agent's INBOX via the existing local-SMTP path — the very same
   * delivery the relay uses for real email. This makes the existing
   * IMAP IDLE → claudecode dispatcher path light up exactly as it
   * would for a real inbound mail, so the agent gets a host turn
   * without any new dispatcher plumbing. The body of the synthetic
   * mail tells the agent the message came from Telegram and that it
   * MUST reply via the `telegram_send` MCP tool, not via email.
   */
  private async startTelegramPollers(): Promise<void> {
    if (!this.telegramManager || !this.accountManager) return;

    const agents = this.db.prepare('SELECT id, name FROM agents').all() as unknown as Array<{ id: string; name: string }>;
    for (const agent of agents) {
      try {
        const config = this.telegramManager.getConfig(agent.id);
        if (!config?.enabled || config.mode !== 'poll' || !config.botToken) continue;
        await this.startTelegramPollerForAgent(agent.id, agent.name);
      } catch (err) {
        console.warn(`[GatewayManager] Could not start Telegram poller for ${agent.name}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Start (or restart) the Telegram poller for one agent. Idempotent —
   * a prior poller is stopped first so re-running `/telegram/setup`
   * picks up the new token / allow-list cleanly.
   *
   * Public so the API layer can poke the gateway after a successful
   * `/telegram/setup` without waiting for the next server restart.
   */
  async startTelegramPollerForAgent(agentId: string, agentName?: string): Promise<void> {
    if (!this.telegramManager) return;

    const existing = this.telegramPollers.get(agentId);
    if (existing) {
      try { await existing.stop(); } catch { /* ignore */ }
      this.telegramPollers.delete(agentId);
    }

    const config = this.telegramManager.getConfig(agentId);
    if (!config?.enabled || config.mode !== 'poll' || !config.botToken) return;

    const poller = new TelegramPoller(this.telegramManager, agentId, {
      conversationManager: new ConversationSessionManager(this.db as any),
    });
    poller.onInbound = async (event) => {
      await this.bridgeInboundTelegram(event.agentId, event.message, event.config, event.conversation, agentName);
    };
    this.telegramPollers.set(agentId, poller);
    await poller.start();
    const botName = config.botUsername ? `@${config.botUsername}` : `bot ${config.botId ?? '(unknown)'}`;
    console.log(`[GatewayManager] Telegram poller started for agent "${agentName ?? agentId.slice(0, 8)}" (${botName})`);
  }

  /** Stop a single agent's Telegram poller (called on disable). */
  async stopTelegramPollerForAgent(agentId: string): Promise<void> {
    const poller = this.telegramPollers.get(agentId);
    if (!poller) return;
    try { await poller.stop(); } catch { /* ignore */ }
    this.telegramPollers.delete(agentId);
  }

  /**
   * Convert one new inbound Telegram message into a synthetic email
   * landing in the agent's INBOX, so the dispatcher wakes the agent.
   *
   * Two short-circuits before delivery:
   *
   *   1. If the message is from the configured operator's chat AND
   *      looks like an operator-query reply (parsed by
   *      `parseTelegramOperatorReply`), it's an answer to an in-flight
   *      voice mission, not free-form chat — the HTTP webhook/poll
   *      route already handles those by calling into the phone
   *      manager, and the route does NOT need an agent turn. The poller
   *      hands them off the same way: we just skip the wake here.
   *
   *   2. Plain `/start` (BotFather's default first DM) is a Telegram
   *      housekeeping nudge — replying with an LLM turn for "/start"
   *      would be embarrassing. Skip it.
   *
   * Everything else: synthesise the email and deliver.
   */
  /**
   * Public wrapper around the bridge — the Telegram webhook route calls
   * this directly so push-mode and poll-mode share the wake path.
   */
  async bridgeTelegramInbound(
    agentId: string,
    parsed: ParsedTelegramMessage,
    config: TelegramConfig,
    conversation?: TelegramConversationContext | null,
  ): Promise<void> {
    return this.bridgeInboundTelegram(agentId, parsed, config, conversation);
  }

  private async bridgeInboundTelegram(
    agentId: string,
    parsed: ParsedTelegramMessage,
    config: TelegramConfig,
    conversation?: TelegramConversationContext | null,
    agentNameHint?: string,
  ): Promise<void> {
    console.log(`[TelegramBridge] inbound msg id=${parsed.messageId} chat=${parsed.chatId} text="${(parsed.text||'').slice(0,40)}" agentId=${agentId.slice(0,8)}`);
    // Operator-query short-circuit. ONLY skip the agent wake when the
    // message is an actual answer to an in-flight phone-call query —
    // either an explicit `/answer <queryId> ...` command, or a plain
    // text reply while exactly one query is open. Earlier versions of
    // this bridge mistakenly short-circuited EVERY message from the
    // operator's own chat, because `parseTelegramOperatorReply` happily
    // treats any plain text as a potential answer — silently dropping
    // every "Hey how are you" the user typed into the bot.
    //
    // The actual hand-off to the phone manager still happens in the
    // route's `processInboundMessage`; here we just decide whether to
    // additionally wake the agent.
    const operatorChatId = config.operatorChatId?.toString().trim() || '';
    if (operatorChatId && parsed.chatId === operatorChatId) {
      const reply = parseTelegramOperatorReply({ text: parsed.text, replyToText: parsed.replyToText });
      if (reply) {
        // Only treat as an operator-query reply if it actually has a
        // resolvable query id — either inline / in a quoted reply, or
        // implicitly when exactly one query is open.
        if (reply.queryId) return;
        try {
          const phoneManager = new PhoneManager(this.db as any, this.encryptionKey ?? undefined);
          const missions = phoneManager.listMissions(agentId, { limit: 100, offset: 0 });
          let openCount = 0;
          for (const m of missions) {
            for (const q of phoneManager.listOperatorQueries(m.id, agentId)) {
              if (!q.answer) openCount++;
            }
          }
          if (openCount === 1) return; // unambiguous answer-to-open-query
        } catch {
          // If the phone manager can't be constructed (e.g. missing DB
          // table), fall through to normal agent-wake — better to wake
          // the agent on the message than silently lose it.
        }
      }
    }

    // Bot-housekeeping commands skip the wake (still recorded by the
    // poller — visible in /telegram → "view recent messages").
    const trimmedText = (parsed.text ?? '').trim();
    if (trimmedText === '/start' || trimmedText === '/help' || trimmedText === '/stop') {
      console.log(`[TelegramBridge] skip housekeeping command "${trimmedText}"`);
      return;
    }
    if (!trimmedText) {
      console.log('[TelegramBridge] skip empty text');
      return;
    }

    if (!this.accountManager) {
      console.log('[TelegramBridge] no accountManager');
      return;
    }
    const agent = await this.accountManager.getById(agentId);
    if (!agent) {
      console.log(`[TelegramBridge] agent ${agentId.slice(0,8)} not found`);
      return;
    }
    const agentName = agentNameHint ?? agent.name;
    console.log(`[TelegramBridge] delivering synthetic mail to ${agent.email} (agentName=${agentName})`);

    const fromLabel = parsed.fromName
      ? `${parsed.fromName} (Telegram chat ${parsed.chatId})`
      : `Telegram chat ${parsed.chatId}`;
    const senderName = parsed.fromName || parsed.fromUsername || 'User';
    const subject = `[Telegram] ${trimmedText.slice(0, 80)}${trimmedText.length > 80 ? '…' : ''}`;

    // Body is designed to be read by the LLM agent. The structure +
    // wording is borrowed from the agent-harness Fola Telegram bridge,
    // which has been hardened against the two classic failure modes of
    // bridged channels:
    //
    //   1. Reply duplication. Without an explicit routing rule the
    //      agent often does both a tool call (telegram_send) and a
    //      written-out narration ("I sent the message"), and the user
    //      receives two copies of everything. The REPLY ROUTING block
    //      below spells out that the telegram_send tool is the
    //      authoritative reply channel — the agent's prose / narration
    //      stays internal.
    //   2. Wrong-channel reply. Because this prompt arrived as an email
    //      the agent will instinctively want to reply by email. The
    //      block explicitly forbids that — the user is on Telegram and
    //      will never see an email reply.
    const replyRouting = conversation ? [
      `=== ACTIVE CONVERSATION SESSION (important, read before responding) ===`,
      `This Telegram message belongs to an active AgenticMail conversation session.`,
      `session_id:          ${conversation.sessionId}`,
      `conversation_msg_id: ${conversation.messageId}`,
      `channel:             telegram`,
      `chat_id:             ${conversation.chatId}`,
      conversation.goal ? `goal:                ${conversation.goal}` : null,
      conversation.subject ? `subject:             ${conversation.subject}` : null,
      ``,
      `Reply through the conversation session, NOT raw telegram_send and NOT email.`,
      ``,
      `For MCP hosts, call:`,
      ``,
      `    mcp__agenticmail__invoke({`,
      `      tool: "conversation_send",`,
      `      args: { sessionId: "${conversation.sessionId}", text: "<your reply text>" }`,
      `    })`,
      ``,
      `For OpenClaw hosts, call agenticmail_conversation_send with:`,
      `    { sessionId: "${conversation.sessionId}", text: "<your reply text>" }`,
      ``,
      `To inspect the session plus transcript first, use conversation_context /`,
      `agenticmail_conversation_context with the same sessionId.`,
      `Send EXACTLY ONE conversation_send response unless you need to do work first.`,
      `Do not also reply by email or narrate a duplicate summary.`,
      `=== END ACTIVE CONVERSATION SESSION ===`,
    ] : [
      `=== REPLY ROUTING (important, read before responding) ===`,
      `This message arrived via Telegram, NOT email. To reply to ${senderName}`,
      `you MUST send through the Telegram bot — replying by email will go`,
      `nowhere they can see it.`,
      ``,
      `The Telegram send tool is in the deferred MCP toolset (not in your`,
      `default tool list), so call it through the \`invoke\` meta-tool:`,
      ``,
      `    mcp__agenticmail__invoke({`,
      `      tool: "telegram_send",`,
      `      args: { chatId: "${parsed.chatId}", text: "<your reply text>" }`,
      `    })`,
      ``,
      `Do NOT spend a turn on \`request_tools\` first — the tool name and args`,
      `above are exactly what \`invoke\` expects. Send EXACTLY ONE invoke call`,
      `per response — do not also reply by email or write a duplicate summary,`,
      `that shows up to the user as a second message. Keep replies concise and`,
      `plain text (Telegram strips markdown). No preamble like "sure, here you`,
      `go" — just answer.`,
      ``,
      `If the user is asking you to do an errand (call someone, look up info,`,
      `send something), do the work FIRST, then \`invoke\` telegram_send with a`,
      `single clear update back to chat_id ${parsed.chatId} when done — that`,
      `invoke call is the whole reply.`,
      `=== END REPLY ROUTING ===`,
    ];

    const body = [
      `[Incoming Telegram message — via AgenticMail Telegram bridge]`,
      `from_name:           ${senderName}`,
      parsed.fromId ? `from_id:             ${parsed.fromId}` : null,
      `chat_id:             ${parsed.chatId}`,
      `chat_type:           ${parsed.chatType}`,
      `telegram_message_id: ${parsed.messageId}`,
      `received_at:         ${parsed.date}`,
      ``,
      ...replyRouting,
      ``,
      `--- User's message ---`,
      trimmedText,
      `---`,
    ].filter((l) => l !== null).join('\n');

    const inbound: InboundEmail = {
      from: `telegram-bridge@telegram.local`,
      to: agent.email,
      subject,
      text: body,
      html: undefined,
      // Use the Telegram-provided send time so the inbox ordering matches
      // when the user actually pressed Send, not when the bridge ran.
      date: parsed.date ? new Date(parsed.date) : new Date(),
      messageId: `<tg-${parsed.chatId}-${parsed.messageId}@telegram.local>`,
    };

    try {
      await this.deliverInboundLocally(agentName, inbound);
      console.log(`[TelegramBridge] delivered ok messageId=${inbound.messageId}`);
    } catch (err) {
      console.warn(`[GatewayManager] Telegram → inbox bridge failed for ${agentName}: ${(err as Error).message}`);
    }
  }

  /**
   * Public wrapper around the Matrix bridge. Matrix poll ingestion calls
   * this after it has persisted a fresh inbound event, mirroring the
   * Telegram webhook/poll wake path.
   */
  async bridgeMatrixInbound(
    agentId: string,
    parsed: ParsedMatrixMessage,
    config: MatrixConfig,
    conversation?: MatrixConversationContext | null,
  ): Promise<void> {
    if (!parsed.text.trim()) return;
    if (!this.accountManager) {
      console.log('[MatrixBridge] no accountManager');
      return;
    }
    const agent = await this.accountManager.getById(agentId);
    if (!agent) {
      console.log(`[MatrixBridge] agent ${agentId.slice(0, 8)} not found`);
      return;
    }

    const trimmedText = parsed.text.trim();
    const senderName = parsed.sender || 'Matrix user';
    const subject = `[Matrix] ${trimmedText.slice(0, 80)}${trimmedText.length > 80 ? '…' : ''}`;
    const replyRouting = conversation ? [
      `=== ACTIVE CONVERSATION SESSION (important, read before responding) ===`,
      `This Matrix message belongs to an active AgenticMail conversation session.`,
      `session_id:          ${conversation.sessionId}`,
      `conversation_msg_id: ${conversation.messageId}`,
      `channel:             matrix`,
      `room_id:             ${conversation.roomId}`,
      conversation.sender ? `sender:              ${conversation.sender}` : null,
      conversation.goal ? `goal:                ${conversation.goal}` : null,
      conversation.subject ? `subject:             ${conversation.subject}` : null,
      ``,
      `Reply through the conversation session, NOT raw matrix_send and NOT email.`,
      ``,
      `For MCP hosts, call:`,
      ``,
      `    mcp__agenticmail__invoke({`,
      `      tool: "conversation_send",`,
      `      args: { sessionId: "${conversation.sessionId}", text: "<your reply text>" }`,
      `    })`,
      ``,
      `For OpenClaw hosts, call agenticmail_conversation_send with:`,
      `    { sessionId: "${conversation.sessionId}", text: "<your reply text>" }`,
      ``,
      `To inspect the session plus transcript first, use conversation_context /`,
      `agenticmail_conversation_context with the same sessionId.`,
      `Send EXACTLY ONE conversation_send response unless you need to do work first.`,
      `Do not also reply by email or narrate a duplicate summary.`,
      `=== END ACTIVE CONVERSATION SESSION ===`,
    ] : [
      `=== REPLY ROUTING (important, read before responding) ===`,
      `This message arrived via Matrix, NOT email. To reply to ${senderName}`,
      `you MUST send through the Matrix bot — replying by email will go`,
      `nowhere they can see it.`,
      ``,
      `For MCP hosts, call:`,
      ``,
      `    mcp__agenticmail__invoke({`,
      `      tool: "matrix_send",`,
      `      args: { roomId: "${parsed.roomId}", text: "<your reply text>" }`,
      `    })`,
      ``,
      `For OpenClaw hosts, call agenticmail_matrix_send with:`,
      `    { roomId: "${parsed.roomId}", text: "<your reply text>" }`,
      ``,
      `Send EXACTLY ONE Matrix reply unless you need to do work first.`,
      `Do not also reply by email or narrate a duplicate summary.`,
      `=== END REPLY ROUTING ===`,
    ];

    const body = [
      `[Incoming Matrix message — via AgenticMail Matrix bridge]`,
      `sender:              ${senderName}`,
      `room_id:             ${parsed.roomId}`,
      `event_id:            ${parsed.eventId}`,
      config.userId ? `agent_matrix_user:   ${config.userId}` : null,
      parsed.createdAt ? `received_at:         ${parsed.createdAt}` : null,
      ``,
      ...replyRouting,
      ``,
      `--- User's message ---`,
      trimmedText,
      `---`,
    ].filter((l) => l !== null).join('\n');

    const idToken = Buffer.from(`${parsed.roomId}:${parsed.eventId}`).toString('base64url').slice(0, 120);
    const inbound: InboundEmail = {
      from: 'matrix-bridge@matrix.local',
      to: agent.email,
      subject,
      text: body,
      html: undefined,
      date: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
      messageId: `<mx-${idToken}@matrix.local>`,
    };

    try {
      await this.deliverInboundLocally(agent.name, inbound);
      console.log(`[MatrixBridge] delivered ok messageId=${inbound.messageId}`);
    } catch (err) {
      console.warn(`[GatewayManager] Matrix → inbox bridge failed for ${agent.name}: ${(err as Error).message}`);
    }
  }

  // --- Lifecycle ---

  async shutdown(): Promise<void> {
    await this.relay.shutdown();
    this.tunnel?.stop();
    // Stop all SMS pollers
    for (const poller of this.smsPollers.values()) {
      poller.stopPolling();
    }
    this.smsPollers.clear();
    // Stop all Telegram pollers — fire-and-forget; stop() awaits the
    // in-flight long-poll abort but we don't want shutdown to block on a
    // pathological Telegram socket.
    for (const poller of this.telegramPollers.values()) {
      try { void poller.stop(); } catch { /* ignore */ }
    }
    this.telegramPollers.clear();
  }

  /**
   * Resume gateway from saved config (e.g., after server restart).
   *
   * Issue #31 — On a Docker container restart the API can come up
   * before Stalwart / Gmail IMAP / DNS is reachable, so the very first
   * setup() can fail with a transient network error. Previously that
   * single failure was logged and never retried, leaving polling
   * permanently dead until someone noticed and manually revived the
   * relay. We now schedule background retries with exponential backoff
   * (5s, 10s, 20s, 40s, 60s cap, indefinite) so the relay
   * self-recovers as soon as the dependency is reachable again.
   */
  async resume(): Promise<void> {
    if (this.config.mode === 'relay' && this.config.relay) {
      try {
        await this._resumeRelayOnce();
      } catch (err) {
        console.error('[GatewayManager] Initial relay resume failed; scheduling retries:', formatPollError(err));
        this._scheduleRelayResumeRetry();
      }
    }

    // Start SMS pollers for agents with separate GV Gmail credentials
    if (this.smsManager && this.accountManager) {
      try {
        await this.startSmsPollers();
      } catch (err) {
        console.error('[GatewayManager] Failed to start SMS pollers:', err);
      }
    }

    // Start Telegram long-poll loops for poll-mode-enabled agents.
    // Webhook-mode agents skip — Telegram pushes to /telegram/webhook,
    // which goes through the same bridge path on the route side.
    if (this.telegramManager && this.accountManager) {
      try {
        await this.startTelegramPollers();
      } catch (err) {
        console.error('[GatewayManager] Failed to start Telegram pollers:', err);
      }
    }

    if (this.config.mode === 'domain' && this.config.domain) {
      try {
        this.cfClient = new CloudflareClient(
          this.config.domain.cloudflareApiToken,
          this.config.domain.cloudflareAccountId,
        );
        this.dnsConfigurator = new DNSConfigurator(this.cfClient);
        this.tunnel = new TunnelManager(this.cfClient);
        this.domainPurchaser = new DomainPurchaser(this.cfClient);

        if (this.config.domain.tunnelToken) {
          await this.tunnel.start(this.config.domain.tunnelToken);
        }
      } catch (err) {
        console.error('[GatewayManager] Failed to resume domain mode:', err);
      }
    }
  }

  // ─── Issue #31 helpers — resume retry with backoff ───
  private _resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _resumeRetryAttempt = 0;

  private async _resumeRelayOnce(): Promise<void> {
    if (!this.config.relay) throw new Error('No relay config to resume');
    await this.relay.setup(this.config.relay);
    const savedUid = this.loadLastSeenUid();
    if (savedUid > 0) {
      this.relay.setLastSeenUid(savedUid);
      console.log(`[GatewayManager] Restored lastSeenUid=${savedUid} from database`);
    }
    this.relay.onUidAdvance = (uid: number) => this.saveLastSeenUid(uid);
    await this.relay.startPolling();
    if (this._resumeRetryAttempt > 0) {
      console.log(`[GatewayManager] Relay polling resumed after ${this._resumeRetryAttempt} retry attempt${this._resumeRetryAttempt !== 1 ? 's' : ''}`);
    }
    this._resumeRetryAttempt = 0;
  }

  private _scheduleRelayResumeRetry(): void {
    if (this._resumeRetryTimer) return; // retry already pending
    this._resumeRetryAttempt++;
    // 5s, 10s, 20s, 40s, then 60s cap. Jitter ±20% so a fleet of
    // restarting nodes don't all reconnect in lockstep.
    const base = Math.min(5_000 * Math.pow(2, this._resumeRetryAttempt - 1), 60_000);
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delay = Math.round(jitter);
    console.log(`[GatewayManager] Will retry relay resume in ${(delay / 1000).toFixed(1)}s (attempt ${this._resumeRetryAttempt + 1})`);
    this._resumeRetryTimer = setTimeout(async () => {
      this._resumeRetryTimer = null;
      // Bail if config was cleared / mode flipped while we slept.
      if (this.config.mode !== 'relay' || !this.config.relay) return;
      try {
        await this._resumeRelayOnce();
      } catch (err) {
        console.error(`[GatewayManager] Relay resume retry ${this._resumeRetryAttempt} failed:`, formatPollError(err));
        this._scheduleRelayResumeRetry();
      }
    }, delay);
  }

  // --- Persistence ---

  private loadConfig(): void {
    const row = this.db.prepare('SELECT * FROM gateway_config WHERE id = ?').get('default') as unknown as GatewayConfigRow | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.config);
        // Decrypt sensitive credential fields
        if (this.encryptionKey) {
          if (parsed.relay?.password) {
            try { parsed.relay.password = decryptSecret(parsed.relay.password, this.encryptionKey); } catch { /* legacy plaintext */ }
          }
          if (parsed.relay?.appPassword) {
            try { parsed.relay.appPassword = decryptSecret(parsed.relay.appPassword, this.encryptionKey); } catch { /* legacy plaintext */ }
          }
          if (parsed.domain?.cloudflareApiToken) {
            try { parsed.domain.cloudflareApiToken = decryptSecret(parsed.domain.cloudflareApiToken, this.encryptionKey); } catch { /* legacy */ }
          }
          if (parsed.domain?.tunnelToken) {
            try { parsed.domain.tunnelToken = decryptSecret(parsed.domain.tunnelToken, this.encryptionKey); } catch { /* legacy */ }
          }
          if (parsed.domain?.inboundSecret) {
            try { parsed.domain.inboundSecret = decryptSecret(parsed.domain.inboundSecret, this.encryptionKey); } catch { /* legacy */ }
          }
          if (parsed.domain?.outboundSecret) {
            try { parsed.domain.outboundSecret = decryptSecret(parsed.domain.outboundSecret, this.encryptionKey); } catch { /* legacy */ }
          }
        }
        this.config = {
          mode: row.mode as GatewayMode,
          ...parsed,
        };
      } catch {
        this.config = { mode: 'none' };
      }
    }
  }

  private saveConfig(): void {
    const { mode, ...rest } = this.config;
    // Encrypt sensitive credential fields before storing
    const toStore = JSON.parse(JSON.stringify(rest));
    if (this.encryptionKey) {
      if (toStore.relay?.password) {
        toStore.relay.password = encryptSecret(toStore.relay.password, this.encryptionKey);
      }
      if (toStore.relay?.appPassword) {
        toStore.relay.appPassword = encryptSecret(toStore.relay.appPassword, this.encryptionKey);
      }
      if (toStore.domain?.cloudflareApiToken) {
        toStore.domain.cloudflareApiToken = encryptSecret(toStore.domain.cloudflareApiToken, this.encryptionKey);
      }
      if (toStore.domain?.tunnelToken) {
        toStore.domain.tunnelToken = encryptSecret(toStore.domain.tunnelToken, this.encryptionKey);
      }
      if (toStore.domain?.inboundSecret) {
        toStore.domain.inboundSecret = encryptSecret(toStore.domain.inboundSecret, this.encryptionKey);
      }
      if (toStore.domain?.outboundSecret) {
        toStore.domain.outboundSecret = encryptSecret(toStore.domain.outboundSecret, this.encryptionKey);
      }
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO gateway_config (id, mode, config)
      VALUES ('default', ?, ?)
    `).run(mode, JSON.stringify(toStore));
  }

  private saveLastSeenUid(uid: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value) VALUES ('relay_last_seen_uid', ?)
    `).run(String(uid));
  }

  private loadLastSeenUid(): number {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('relay_last_seen_uid') as { value: string } | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  }
}

/**
 * Parse an email address string like "Name <email@example.com>" or "email@example.com"
 * into an AddressInfo object.
 */
function parseAddressString(addr: string): AddressInfo {
  const match = addr.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), address: match[2].trim() };
  }
  return { address: addr.trim() };
}

/**
 * Convert an InboundEmail (from relay) to a ParsedEmail (for spam filter).
 */
function inboundToParsedEmail(mail: InboundEmail): ParsedEmail {
  return {
    messageId: mail.messageId || '',
    subject: mail.subject || '',
    from: [parseAddressString(mail.from)],
    to: [parseAddressString(mail.to)],
    date: mail.date || new Date(),
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    attachments: (mail.attachments ?? []).map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      content: a.content,
    })),
    headers: new Map<string, string>(),
  };
}
