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
export { MailSender, isLoopbackMailHost, resolveTlsRejectUnauthorized, type MailSenderOptions, type SendResultWithRaw } from './mail/sender.js';
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
export { classifyEmailRoute, type EmailRouteClassification, type EmailRouteClass, type EmailRouteAction, type EmailRouteInput } from './mail/route-classifier.js';
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
export { getDatabase, closeDatabase, createTestDatabase, type Database } from './storage/db.js';
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

// SMS / Google Voice
export {
  SmsManager,
  SmsPoller,
  parseGoogleVoiceSms,
  extractVerificationCode,
  normalizePhoneNumber,
  isValidPhoneNumber,
  getSmsProvider,
  mapProviderSmsStatus,
  redactSmsConfig,
} from './sms/index.js';
export type {
  SmsConfig,
  ParsedSms,
  SmsMessage,
  SendSmsInput,
  SendSmsResult,
  InboundSmsEvent,
  SmsProvider,
} from './sms/index.js';

// Phone Mission Policy
export {
  ELKS_REALTIME_AUDIO_FORMATS,
  OPENAI_REALTIME_URL,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  REALTIME_AUDIO_SAMPLE_RATE,
  REALTIME_MAX_AUDIO_FRAME_BASE64,
  RealtimeVoiceBridge,
  buildOpenAIRealtimeUrl,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  PhoneManager,
  PhoneWebhookAuthError,
  PhoneRateLimitError,
  PHONE_MISSION_STATES,
  PHONE_REGION_SCOPES,
  TELEPHONY_TRANSPORT_CAPABILITIES,
  PHONE_SERVER_MAX_CALL_DURATION_SECONDS,
  PHONE_SERVER_MAX_COST_PER_MISSION,
  PHONE_SERVER_MAX_ATTEMPTS,
  PHONE_TASK_MAX_LENGTH,
  PHONE_RATE_LIMIT_PER_MINUTE,
  PHONE_RATE_LIMIT_PER_HOUR,
  PHONE_MAX_CONCURRENT_MISSIONS,
  PHONE_MIN_WEBHOOK_SECRET_LENGTH,
  buildElksAudioMessage,
  buildElksByeMessage,
  buildElksHandshakeMessages,
  buildElksInterruptMessage,
  buildElksListeningMessage,
  buildElksSendingMessage,
  buildPhoneTransportConfig,
  classifyPhoneNumberRisk,
  inferPhoneRegion,
  isPhoneRegionAllowed,
  parseElksRealtimeMessage,
  redactPhoneTransportConfig,
  validatePhoneMissionPolicy,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
} from './phone/index.js';
export type {
  ElksRealtimeAudioFormat,
  ElksRealtimeAudioMessage,
  ElksRealtimeByeMessage,
  ElksRealtimeHelloMessage,
  ElksRealtimeInboundMessage,
  ElksRealtimeOutboundMessage,
  OpenClawPhoneMissionPolicy,
  PhoneCallMission,
  PhoneAlternativePolicy,
  PhoneConfirmPolicy,
  PhoneMissionState,
  PhoneMissionTranscriptEntry,
  PhoneMissionStartValidationResult,
  PhoneTransportValidationResult,
  PhoneMissionValidationIssue,
  PhoneMissionValidationResult,
  PhoneNumberRisk,
  PhoneRegionScope,
  PhoneTransportConfig,
  PhoneTransportProvider,
  PhoneTransportProfile,
  PhoneWebhookResult,
  StartPhoneCallOptions,
  StartPhoneCallResult,
  StartPhoneMissionInput,
  TelephonyTransportCapability,
  ValidatedPhoneMissionStart,
  RealtimeBridgePort,
  RealtimeBridgeTranscriptEntry,
  RealtimeInstructionOptions,
  RealtimeSessionConfigOptions,
  RealtimeVoiceBridgeOptions,
} from './phone/index.js';

// Telemetry
export { recordToolCall, setTelemetryVersion, flushTelemetry } from './telemetry.js';

// Debug
export { debug, debugWarn } from './debug.js';

// Path-traversal safe filesystem joiner. Used by every host
// integration (claudecode, codex, …) to bound file operations to an
// operator-configured base directory. See util/safe-path.ts for the
// rationale + CodeQL `js/path-injection` mitigation.
export {
  safeJoin,
  tryJoin,
  assertWithinBase,
  PathTraversalError,
  type SafeJoinOptions,
} from './util/safe-path.js';

// Redact sensitive material from log lines. Master keys and per-agent
// API keys frequently flow into config objects we log for diagnostics
// — redactSecret() collapses them to `mk_***` / `ak_***` shape so the
// log line stays useful for context without leaking the secret.
export {
  redactSecret,
  redactObject,
  REDACTED,
} from './util/redact.js';

// Operator notification preferences. Stored separately from the
// bootstrap-managed config.json so the host agent (claudecode /
// codex) can update it via MCP at any time without touching the
// read-only config blob. See operator-prefs.ts for the storage
// format and the use case (bridge-escalation email forwarding).
export {
  getOperatorEmail,
  setOperatorEmail,
  operatorPrefsStoragePath,
} from './operator-prefs.js';

// Headless bridge-wake: persist host session_id captured from the
// mail-hook so the dispatcher can resume a Claude Code / Codex
// session against bridge mail when the operator's CLI isn't
// actively running. See util/host-sessions.ts for the threat model
// and the freshness gate.
export {
  saveHostSession,
  loadHostSession,
  isSessionFresh,
  forgetHostSession,
  hostSessionStoragePath,
  DEFAULT_SESSION_MAX_AGE_MS,
  type HostName,
  type HostSession,
  type HostSessionResumeMode,
} from './host-sessions.js';

export {
  BRIDGE_OPERATOR_LIVE_WINDOW_MS,
  bridgeWakeErrorMessage,
  bridgeWakeLastSeenAgeMs,
  classifyResumeError,
  composeBridgeWakePrompt,
  planBridgeWake,
  shouldSkipBridgeWakeForLiveOperator,
  type BridgeWakeError,
  type BridgeMailContext,
  type BridgeWakePromptArgs,
  type BridgeWakeResult,
  type BridgeWakeRoute,
  type PlanBridgeWakeArgs,
  type ResumeErrorClassificationOptions,
} from './host-bridge.js';

// SSRF-safe URL validation for the master API base URL — used by
// every host integration to bound where its fetch requests can go.
// See util/safe-url.ts for the blocklist (cloud metadata, file://,
// javascript:, embedded creds) and CodeQL `js/request-forgery`
// mitigation.
export {
  validateApiUrl,
  buildApiUrl,
  UnsafeApiUrlError,
} from './util/safe-url.js';

// Setup & Dependencies
export { SetupManager, DependencyChecker, DependencyInstaller, ServiceManager, type ServiceStatus, type DependencyStatus, type InstallProgress, type SetupConfig, type SetupResult } from './setup/index.js';

// Layered wake-context system (thread cache + agent memory).
// See packages/core/src/threading/* for the design.
export {
  threadIdFor, normalizeSubject, normalizeAddress,
  ThreadCache, AgentMemoryStore,
} from './threading/index.js';
export type {
  ThreadIdInput, ThreadCacheEntry, CachedMessage, ThreadCacheOptions,
  AgentMemoryFields, AgentMemoryRead, AgentMemoryOptions,
} from './threading/index.js';

// Persistent per-agent memory — categorised, confidence-decaying,
// BM25F-searchable knowledge store. See packages/core/src/memory/*.
export {
  AgentMemoryManager, MEMORY_CATEGORIES, MemorySearchIndex, stem, tokenize,
} from './memory/index.js';
export type {
  AgentMemoryEntry, MemoryCategory, MemoryImportance, MemorySource,
  MemoryStats, CreateMemoryInput, UpdateMemoryInput, MemoryQueryOptions,
} from './memory/index.js';
