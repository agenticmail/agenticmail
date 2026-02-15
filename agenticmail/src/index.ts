// agenticmail — convenience re-exports from @agenticmail/core

// Main client
export { AgenticMailClient, type AgenticMailClientOptions } from '@agenticmail/core';

// Config
export { resolveConfig, ensureDataDir, saveConfig, type AgenticMailConfig } from '@agenticmail/core';

// Stalwart Admin
export { StalwartAdmin, type StalwartAdminOptions } from '@agenticmail/core';
export type { StalwartPrincipal } from '@agenticmail/core';

// Account Management
export { AccountManager } from '@agenticmail/core';
export type { Agent, CreateAgentOptions } from '@agenticmail/core';

// Mail Operations
export { MailSender, type MailSenderOptions } from '@agenticmail/core';
export { MailReceiver, type MailReceiverOptions } from '@agenticmail/core';
export { parseEmail } from '@agenticmail/core';
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
} from '@agenticmail/core';

// Inbox Watching
export { InboxWatcher, type InboxWatcherOptions } from '@agenticmail/core';
export type { InboxEvent, InboxNewEvent, InboxExpungeEvent, InboxFlagsEvent, WatcherOptions } from '@agenticmail/core';

// Storage
export { getDatabase, closeDatabase, createTestDatabase } from '@agenticmail/core';
export { EmailSearchIndex, type SearchableEmail } from '@agenticmail/core';

// Domain Management
export { DomainManager } from '@agenticmail/core';
export type { DomainInfo, DnsRecord, DomainSetupResult } from '@agenticmail/core';

// Gateway (Internet Email)
export { GatewayManager, type GatewayManagerOptions } from '@agenticmail/core';
export { RelayGateway, type InboundEmail } from '@agenticmail/core';
export { CloudflareClient } from '@agenticmail/core';
export { DomainPurchaser, type DomainSearchResult, type DomainPurchaseResult } from '@agenticmail/core';
export { DNSConfigurator, type DnsSetupResult } from '@agenticmail/core';
export { TunnelManager, type TunnelConfig } from '@agenticmail/core';
export type {
  GatewayMode,
  GatewayConfig,
  GatewayStatus,
  RelayConfig,
  RelayProvider,
  DomainModeConfig,
  PurchasedDomain,
} from '@agenticmail/core';
export { RELAY_PRESETS } from '@agenticmail/core';
