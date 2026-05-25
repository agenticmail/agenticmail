export {
  ELKS_REALTIME_AUDIO_FORMATS,
  buildElksAudioMessage,
  buildElksByeMessage,
  buildElksHandshakeMessages,
  buildElksInterruptMessage,
  buildElksListeningMessage,
  buildElksSendingMessage,
  parseElksRealtimeMessage,
} from './realtime.js';
export type {
  ElksRealtimeAudioFormat,
  ElksRealtimeAudioMessage,
  ElksRealtimeByeMessage,
  ElksRealtimeHelloMessage,
  ElksRealtimeInboundMessage,
  ElksRealtimeOutboundMessage,
} from './realtime.js';
export {
  TWILIO_MEDIA_SAMPLE_RATE,
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioRealtimeMessage,
} from './twilio-realtime.js';
export type {
  TwilioConnectedMessage,
  TwilioMarkMessage,
  TwilioMediaMessage,
  TwilioRealtimeInboundMessage,
  TwilioRealtimeOutboundMessage,
  TwilioStartMessage,
  TwilioStopMessage,
} from './twilio-realtime.js';
export {
  buildTwilioSignature,
  validateTwilioSignature,
  buildTwilioStreamTwiML,
  buildTwilioSayTwiML,
  escapeXml,
} from './twilio.js';
export type { TwilioStreamTwiMLOptions } from './twilio.js';
export {
  ELKS_REALTIME_WS_PATH,
  TWILIO_REALTIME_WS_PATH,
} from './realtime-paths.js';
export {
  ElksRealtimeTransport,
  TwilioRealtimeTransport,
  createRealtimeTransport,
} from './realtime-transport.js';
export type {
  RealtimeTransportAdapter,
  RealtimeTransportProvider,
  RealtimeInboundEvent,
} from './realtime-transport.js';
export {
  OPENAI_REALTIME_URL,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  DEFAULT_REALTIME_AUDIO_FORMAT,
  REALTIME_AUDIO_SAMPLE_RATE,
  REALTIME_MAX_AUDIO_FRAME_BASE64,
  REALTIME_TOOL_CALL_TIMEOUT_MS,
  RealtimeVoiceBridge,
  buildOpenAIRealtimeUrl,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
} from './realtime-bridge.js';
export type {
  RealtimeBridgePort,
  RealtimeBridgeTranscriptEntry,
  RealtimeInstructionOptions,
  RealtimeSessionConfigOptions,
  RealtimeVoiceBridgeOptions,
  ScheduledCallbackRequest,
} from './realtime-bridge.js';

// v0.9.93 — voice-runtime providers (drop-in plugin directory).
// Side-effect import triggers each provider's registerVoiceProvider()
// call; the named exports give callers the lookup API.
export {
  registerVoiceProvider,
  listVoiceProviders,
  getVoiceProvider,
  resolveVoiceRuntime,
  previewVoice,
  playWav,
  PREVIEW_SAMPLE_RATE,
} from './voice-providers/index.js';
export type {
  VoiceProvider,
  VoiceRuntimeConnection,
  VoicePreviewOptions,
  VoicePreviewResult,
} from './voice-providers/index.js';
export {
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
} from './realtime-tools.js';
export type {
  RealtimeToolDefinition,
  RealtimeToolCall,
  RealtimeToolResult,
  ToolExecutor,
  RealtimeToolHandler,
  MemoryRecaller,
  GetDatetimeOptions,
  WebSearchOptions,
  OperatorQueryPollOptions,
} from './realtime-tools.js';
export {
  PhoneManager,
  PhoneWebhookAuthError,
  PhoneRateLimitError,
  PHONE_RATE_LIMIT_PER_MINUTE,
  PHONE_RATE_LIMIT_PER_HOUR,
  PHONE_MAX_CONCURRENT_MISSIONS,
  PHONE_MIN_WEBHOOK_SECRET_LENGTH,
  PHONE_CALL_CONTROL_PROVIDERS,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
} from './manager.js';
export type {
  PhoneCallMission,
  PhoneMissionTranscriptEntry,
  PhoneOperatorQuery,
  OperatorQueryUrgency,
  PhoneScheduledCallback,
  PhoneTransportConfig,
  PhoneTransportProvider,
  PhoneWebhookResult,
  StartPhoneCallOptions,
  StartPhoneCallResult,
} from './manager.js';
export {
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
  PHONE_TASK_MAX_LENGTH,
  PHONE_MISSION_POLICY_PRESETS,
  buildPhoneMissionPolicy,
  classifyPhoneNumberRisk,
  inferPhoneRegion,
  isPhoneRegionAllowed,
  resolveExtensionPolicy,
  resolveCallbackPolicy,
  validatePhoneMissionPolicy,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
} from './mission.js';
export type {
  OpenClawPhoneMissionPolicy,
  BuildPhoneMissionPolicyInput,
  PhoneAlternativePolicy,
  PhoneCallbackPolicy,
  PhoneConfirmPolicy,
  PhoneExtensionPolicy,
  PhoneMissionState,
  PhoneMissionStartValidationResult,
  PhoneTransportValidationResult,
  PhoneMissionValidationIssue,
  PhoneMissionValidationResult,
  PhoneNumberRisk,
  PhoneRegionScope,
  PhoneMissionPolicyPreset,
  PhoneTransportProfile,
  StartPhoneMissionInput,
  TelephonyTransportCapability,
  ValidatedPhoneMissionStart,
} from './mission.js';
