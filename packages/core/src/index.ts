// @agenticmail/core — Public API

// Main client
export { AgenticMailClient, type AgenticMailClientOptions } from './client.js';

// Config
export { resolveConfig, ensureDataDir, saveConfig, type AgenticMailConfig } from './config.js';

// Stalwart Admin
export { StalwartAdmin, type StalwartAdminOptions } from './stalwart/admin.js';
export type { StalwartPrincipal } from './stalwart/types.js';

// Account Management
export { AccountManager } from './accounts/manager.js';
export type { Agent, CreateAgentOptions, AgentRole } from './accounts/types.js';
export { AGENT_ROLES, DEFAULT_AGENT_ROLE, DEFAULT_AGENT_NAME } from './accounts/types.js';
export { AgentDeletionService } from './accounts/deletion.js';
export type { DeletionReport, DeletionSummary, ArchivedEmail, ArchiveAndDeleteOptions } from './accounts/deletion.js';

// Mail Operations
export { MailSender, type MailSenderOptions, type SendResultWithRaw } from './mail/sender.js';
export { MailReceiver, type MailReceiverOptions, type FolderInfo } from './mail/receiver.js';
export { parseEmail } from './mail/parser.js';
export type {
  SendMailOptions,
  SendResult,
  EmailEnvelope,
  ParsedEmail,
  AddressInfo,
  Attachment,
  ParsedAttachment,
  MailboxInfo,
  SearchCriteria,
} from './mail/types.js';

// Spam Filter & Sanitizer
export { scoreEmail, isInternalEmail, type SpamResult, type SpamRuleMatch, type SpamCategory, SPAM_THRESHOLD, WARNING_THRESHOLD } from './mail/spam-filter.js';
export { sanitizeEmail, type SanitizeResult, type SanitizeDetection } from './mail/sanitizer.js';

// Outbound Guard
export {
  scanOutboundEmail,
  buildInboundSecurityAdvisory,
  type OutboundScanResult,
  type OutboundScanInput,
  type OutboundWarning,
  type OutboundCategory,
  type Severity,
  type SecurityAdvisory,
  type AttachmentAdvisory,
  type LinkAdvisory,
} from './mail/outbound-guard.js';

// Inbox Watching
export { InboxWatcher, type InboxWatcherOptions } from './inbox/watcher.js';
export type { InboxEvent, InboxNewEvent, InboxExpungeEvent, InboxFlagsEvent, WatcherOptions } from './inbox/types.js';

// Storage
export { getDatabase, closeDatabase, createTestDatabase } from './storage/db.js';
export { EmailSearchIndex, type SearchableEmail } from './storage/search.js';

// Domain Management
export { DomainManager } from './domain/manager.js';
export type { DomainInfo, DnsRecord, DomainSetupResult } from './domain/types.js';

// Gateway (Internet Email)
export { GatewayManager, type GatewayManagerOptions, type LocalSmtpConfig } from './gateway/manager.js';
export { RelayGateway, type InboundEmail, type RelaySearchResult } from './gateway/relay.js';
export { CloudflareClient } from './gateway/cloudflare.js';
export { DomainPurchaser, type DomainSearchResult, type DomainPurchaseResult } from './gateway/domain-purchase.js';
export { DNSConfigurator, type DnsSetupResult } from './gateway/dns-setup.js';
export { TunnelManager, type TunnelConfig } from './gateway/tunnel.js';
export { RelayBridge, startRelayBridge, type RelayBridgeOptions } from './gateway/relay-bridge.js';
export type {
  GatewayMode,
  GatewayConfig,
  GatewayStatus,
  RelayConfig,
  RelayProvider,
  DomainModeConfig,
  PurchasedDomain,
} from './gateway/types.js';
export { RELAY_PRESETS } from './gateway/types.js';

// Setup & Dependencies
export { SetupManager, DependencyChecker, DependencyInstaller, type DependencyStatus, type InstallProgress, type SetupConfig, type SetupResult } from './setup/index.js';
