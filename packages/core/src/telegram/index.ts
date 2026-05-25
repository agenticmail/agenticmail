// @agenticmail/core — Telegram channel (plan §13.5)
//
// A first-class Telegram integration: a user registers a bot token,
// links a chat, and messages their AgenticMail agent over Telegram —
// and the same channel carries `ask_operator` notifications + approvals
// (plan §13.4). Ported + merged from the tuned enterprise Telegram tools
// and the agent-harness Fola bridge, stripped of host/multi-tenant
// specifics. The HTTP transport (webhook route + poll endpoint) lives in
// @agenticmail/api; this module is dependency-free.

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
} from './client.js';
export type {
  TelegramApiOptions,
  TelegramBotInfo,
  GetUpdatesOptions,
  SetWebhookOptions,
  SendTelegramMessageOptions,
  SendTelegramMessageResult,
} from './client.js';

export {
  parseTelegramUpdate,
  isTelegramStopCommand,
  nextTelegramOffset,
  TELEGRAM_STOP_WORDS,
} from './update.js';
export type { ParsedTelegramMessage, TelegramChatType } from './update.js';

export {
  TelegramManager,
  redactTelegramConfig,
  isTelegramChatAllowed,
  TELEGRAM_WEBHOOK_SECRET_RE,
  TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH,
} from './manager.js';
export type { TelegramConfig, TelegramMessage, TelegramMode } from './manager.js';

export {
  TelegramPoller,
  TELEGRAM_LONG_POLL_TIMEOUT_SEC,
} from './poller.js';
export type {
  TelegramPollerOptions,
  TelegramInboundEvent,
} from './poller.js';

export {
  recordTelegramConversationInbound,
} from './conversation.js';
export type {
  TelegramConversationContext,
} from './conversation.js';

export {
  formatOperatorQueryTelegramMessage,
  parseTelegramOperatorReply,
  TELEGRAM_OPERATOR_QUERY_TAG,
} from './operator-query.js';
export type {
  OperatorQueryNotificationInput,
  ParsedOperatorReply,
  OperatorReplyKind,
} from './operator-query.js';
