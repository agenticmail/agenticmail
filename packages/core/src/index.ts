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

// Telegram channel (plan §13.5) — users chat with their agents over
// Telegram; doubles as an ask_operator notification + approval channel.
export {
  TELEGRAM_API_BASE,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_CHUNK_SIZE,
  TelegramApiError,
  redactBotToken,
  callTelegramApi,
  stripTelegramMarkdown,
  splitTelegramMessage,
  sendTelegramMessage,
  getTelegramMe,
  getTelegramChat,
  getTelegramUpdates,
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramWebhookInfo,
  parseTelegramUpdate,
  isTelegramStopCommand,
  nextTelegramOffset,
  TELEGRAM_STOP_WORDS,
  TelegramManager,
  redactTelegramConfig,
  isTelegramChatAllowed,
  TELEGRAM_WEBHOOK_SECRET_RE,
  TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH,
  formatOperatorQueryTelegramMessage,
  parseTelegramOperatorReply,
  TELEGRAM_OPERATOR_QUERY_TAG,
} from './telegram/index.js';
export type {
  TelegramApiOptions,
  TelegramBotInfo,
  GetUpdatesOptions,
  SetWebhookOptions,
  SendTelegramMessageOptions,
  SendTelegramMessageResult,
  ParsedTelegramMessage,
  TelegramChatType,
  TelegramConfig,
  TelegramMessage,
  TelegramMode,
  OperatorQueryNotificationInput,
  ParsedOperatorReply,
  OperatorReplyKind,
} from './telegram/index.js';

// Phone Mission Policy
export {
  ELKS_REALTIME_AUDIO_FORMATS,
  OPENAI_REALTIME_URL,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_REALTIME_AUDIO_FORMAT,
  REALTIME_AUDIO_SAMPLE_RATE,
  REALTIME_MAX_AUDIO_FRAME_BASE64,
  RealtimeVoiceBridge,
  buildOpenAIRealtimeUrl,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  // v0.9.93 — voice-runtime providers (drop-in plugin directory).
  registerVoiceProvider,
  listVoiceProviders,
  getVoiceProvider,
  resolveVoiceRuntime,
  // v0.9.99 — interactive audio preview for setup-voice picker.
  previewVoice,
  playWav,
  TWILIO_MEDIA_SAMPLE_RATE,
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioRealtimeMessage,
  buildTwilioSignature,
  validateTwilioSignature,
  buildTwilioStreamTwiML,
  buildTwilioSayTwiML,
  escapeXml,
  ELKS_REALTIME_WS_PATH,
  TWILIO_REALTIME_WS_PATH,
  ElksRealtimeTransport,
  TwilioRealtimeTransport,
  createRealtimeTransport,
  PhoneManager,
  PhoneWebhookAuthError,
  PhoneRateLimitError,
  PHONE_MISSION_STATES,
  PHONE_REGION_SCOPES,
  TELEPHONY_TRANSPORT_CAPABILITIES,
  PHONE_SERVER_MAX_CALL_DURATION_SECONDS,
  PHONE_SERVER_MAX_COST_PER_MISSION,
  PHONE_SERVER_MAX_ATTEMPTS,
  PHONE_SERVER_MAX_EXTENSION_SECONDS_PER_REQUEST,
  PHONE_SERVER_MAX_EXTENSION_REQUESTS_PER_CALL,
  PHONE_SERVER_MAX_TOTAL_EXTENSION_SECONDS,
  PHONE_SERVER_MAX_CALLBACK_CHAIN,
  PHONE_CALLBACK_MIN_DELAY_SECONDS,
  PHONE_CALLBACK_MAX_DELAY_SECONDS,
  DEFAULT_EXTENSION_POLICY,
  DEFAULT_CALLBACK_POLICY,
  resolveExtensionPolicy,
  resolveCallbackPolicy,
  PHONE_TASK_MAX_LENGTH,
  PHONE_RATE_LIMIT_PER_MINUTE,
  PHONE_RATE_LIMIT_PER_HOUR,
  PHONE_MAX_CONCURRENT_MISSIONS,
  PHONE_MIN_WEBHOOK_SECRET_LENGTH,
  PHONE_CALL_CONTROL_PROVIDERS,
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
  REALTIME_TOOL_CALL_TIMEOUT_MS,
  OPERATOR_QUERY_TIMEOUT_MS,
  OPERATOR_QUERY_POLL_INTERVAL_MS,
  OPERATOR_QUERY_TIMEOUT_SENTINEL,
  OPERATOR_QUERY_SUBJECT_TAG,
  DEFAULT_WEB_SEARCH_ENDPOINT,
  WEB_SEARCH_UNTRUSTED_PREFIX,
  ASK_OPERATOR_TOOL,
  WEB_SEARCH_TOOL,
  RECALL_MEMORY_TOOL,
  GET_DATETIME_TOOL,
  SEARCH_EMAIL_TOOL,
  SEARCH_SKILLS_TOOL,
  LOAD_SKILL_TOOL,
  GET_CALL_STATUS_TOOL,
  EXTEND_CALL_TIME_TOOL,
  SCHEDULE_CALLBACK_TOOL,
  END_CALL_TOOL,
  REALTIME_TOOL_DEFINITIONS,
  buildRealtimeToolGuidance,
  createToolExecutor,
  getDatetime,
  recallMemory,
  webSearch,
  pollForOperatorAnswer,
  operatorQuerySubject,
  parseOperatorQueryReply,
  extractEmailAddress,
  isOperatorReplySender,
} from './phone/index.js';
export type {
  ElksRealtimeAudioFormat,
  ElksRealtimeAudioMessage,
  ElksRealtimeByeMessage,
  ElksRealtimeHelloMessage,
  ElksRealtimeInboundMessage,
  ElksRealtimeOutboundMessage,
  TwilioConnectedMessage,
  TwilioMarkMessage,
  TwilioMediaMessage,
  TwilioRealtimeInboundMessage,
  TwilioRealtimeOutboundMessage,
  TwilioStartMessage,
  TwilioStopMessage,
  TwilioStreamTwiMLOptions,
  RealtimeTransportAdapter,
  RealtimeTransportProvider,
  RealtimeInboundEvent,
  OpenClawPhoneMissionPolicy,
  PhoneCallMission,
  PhoneAlternativePolicy,
  PhoneCallbackPolicy,
  PhoneConfirmPolicy,
  PhoneExtensionPolicy,
  PhoneScheduledCallback,
  ScheduledCallbackRequest,
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
  RealtimeToolDefinition,
  RealtimeToolCall,
  RealtimeToolResult,
  ToolExecutor,
  RealtimeToolHandler,
  MemoryRecaller,
  GetDatetimeOptions,
  WebSearchOptions,
  OperatorQueryPollOptions,
  PhoneOperatorQuery,
  OperatorQueryUrgency,
  VoiceProvider,
  VoiceRuntimeConnection,
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

// Media toolset — text-to-speech, image / video / audio editing, media
// probing, video understanding, and reference-voice cloning. The work
// is done by external system binaries (ffmpeg, ffprobe, ImageMagick,
// whisper.cpp, Python) invoked via execFile with argument arrays — no
// shell. None are bundled; every operation feature-detects the binary
// it needs and degrades gracefully with an actionable install hint.
// See packages/core/src/media/* for the design.
export {
  MediaManager,
  detectBinary,
  requireBinary,
  requireWhisperModel,
  getMediaCapabilities,
  clearMediaCapabilityCache,
} from './media/index.js';
export type {
  MediaManagerOptions,
  MediaBinary,
  MediaCapability,
  MediaCapabilityReport,
  MediaFileResult,
  MediaInfoResult,
  MediaStreamInfo,
  TtsGenerateOptions,
  ImageAction,
  ImageEditOptions,
  VideoAction,
  VideoEditOptions,
  AudioAction,
  AudioEditOptions,
  VideoUnderstandOptions,
  VideoTimelineEntry,
  VideoUnderstandResult,
  VoiceCloneOptions,
} from './media/index.js';

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

// Channel-neutral realtime conversation capabilities. Phone is the
// first executable duplex-audio transport; Telegram is text-turn
// available; Matrix, WhatsApp, and Google Meet are intentionally
// represented as planned/gated so future adapters share one contract
// without false availability claims.
export {
  REALTIME_CONVERSATION_CHANNELS,
  getRealtimeConversationCapability,
  isRealtimeConversationChannel,
  listRealtimeConversationCapabilities,
  planRealtimeConversationStart,
  ConversationSessionManager,
} from './conversation/index.js';
export type {
  ConversationMessage,
  ConversationMessageDirection,
  ConversationSession,
  ConversationSessionStatus,
  CreateConversationSessionInput,
  RecordConversationMessageInput,
  RealtimeConversationCapability,
  RealtimeConversationChannel,
  RealtimeConversationMode,
  RealtimeConversationStartContext,
  RealtimeConversationStartPlan,
  RealtimeConversationStatus,
} from './conversation/index.js';

// Skill library — JSON how-to-act-like-a-skilled-human bundles agents
// load on demand during phone calls. Built-in skills ship in the
// `skills/built-in/` folder; user-contributed ones live in
// `~/.agenticmail/skills/`. See packages/core/src/skills/*.
export {
  listSkills, searchSkills, loadSkill, saveUserSkill, validateSkill,
  invalidateSkillCache, userSkillsDir, renderSkillAsPrompt,
} from './skills/index.js';
export type {
  Skill, SkillCategory, SkillContext, SkillTactic, SkillExitStrategy,
  SkillSummary, SkillValidationError,
} from './skills/index.js';

// v0.9.85 — per-agent persona ("soul file") system. Same agent
// identity across voice, telegram, and email; auto-created with a
// sensible default on first read; freely editable by the operator.
export {
  AGENT_STATE_ROOT,
  PERSONA_FILENAME,
  buildDefaultPersona,
  loadAgentPersona,
  personaPathFor,
  saveAgentPersona,
  // v0.9.95 — frontmatter-aware persona reader + writer.
  readAgentPersonaFile,
  updateAgentPersonaFrontmatter,
} from './persona/index.js';
export type { AgentPersonaFrontmatter } from './persona/index.js';
