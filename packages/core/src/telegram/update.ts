/**
 * Telegram update parsing — pure, dependency-free.
 *
 * Ported from the inbound-message handling in the agent-harness Fola
 * bridge (`fola-telegram-bridge.mjs` — the `formatPrompt` header fields
 * and the `STOP_WORDS` abort set), stripped of every Fola-host specific
 * (session routing, the fola-claude prompt envelope, media downloads).
 */

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';

/** A normalized inbound Telegram text message. */
export interface ParsedTelegramMessage {
  /** Telegram `update_id` — drives the poll offset. */
  updateId: number;
  /** `message_id` within the chat. */
  messageId: number;
  /** Chat id as a string (Telegram ids are 64-bit; strings avoid loss). */
  chatId: string;
  chatType: TelegramChatType;
  chatTitle?: string;
  /** Sender id as a string; falls back to the chat id for channel posts. */
  fromId: string;
  fromName: string;
  fromUsername?: string;
  /** Message text (or media caption). Always non-empty for a parsed result. */
  text: string;
  /** `message_id` of the message this one replies to, if any. */
  replyToMessageId?: number;
  /** Text of the replied-to message, when Telegram included it. */
  replyToText?: string;
  /** ISO-8601 timestamp derived from the Telegram `date` epoch. */
  date: string;
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChatType(type: unknown): TelegramChatType {
  return type === 'private' || type === 'group' || type === 'supergroup' || type === 'channel'
    ? type
    : 'unknown';
}

/**
 * Normalize a raw Telegram update into a {@link ParsedTelegramMessage},
 * or `null` when it carries no usable text (callback queries, service
 * messages, edits with no text, non-text media without a caption).
 * Handles both `message` and `channel_post` envelopes.
 */
export function parseTelegramUpdate(update: unknown): ParsedTelegramMessage | null {
  if (!update || typeof update !== 'object') return null;
  const u = update as Record<string, any>;
  if (typeof u.update_id !== 'number') return null;

  const msg = u.message || u.channel_post;
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.message_id !== 'number') return null;

  const chat = msg.chat || {};
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return null;

  const text = asTrimmed(msg.text) || asTrimmed(msg.caption);
  if (!text) return null;

  const from = msg.from || {};
  const fromName =
    [from.first_name, from.last_name].filter((p: unknown) => typeof p === 'string' && p).join(' ')
    || asTrimmed(from.username)
    || asTrimmed(chat.title)
    || 'User';

  const replyTo = msg.reply_to_message;

  return {
    updateId: u.update_id,
    messageId: msg.message_id,
    chatId: String(chat.id),
    chatType: normalizeChatType(chat.type),
    chatTitle: asTrimmed(chat.title) || undefined,
    fromId: from.id != null ? String(from.id) : String(chat.id),
    fromName,
    fromUsername: asTrimmed(from.username) || undefined,
    text,
    replyToMessageId: replyTo && typeof replyTo.message_id === 'number' ? replyTo.message_id : undefined,
    replyToText: replyTo ? (asTrimmed(replyTo.text) || asTrimmed(replyTo.caption) || undefined) : undefined,
    date: typeof msg.date === 'number'
      ? new Date(msg.date * 1000).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Words that, sent alone (case-insensitive, optional trailing
 * punctuation), signal "abort whatever you are doing for me". Kept
 * deliberately narrow — anything longer or ambiguous is a normal
 * message. Ported verbatim from the Fola bridge.
 */
export const TELEGRAM_STOP_WORDS: ReadonlySet<string> = new Set([
  'stop', 'abort', 'kill', 'cancel', 'halt',
]);

/** True when `text` is a bare stop command. */
export function isTelegramStopCommand(text: string): boolean {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase().replace(/^\//, '').replace(/[!.?]+$/, '');
  return TELEGRAM_STOP_WORDS.has(cleaned);
}

/**
 * Compute the next `getUpdates` offset from a batch: one past the
 * highest `update_id` seen. Advancing the offset is what acknowledges
 * updates to Telegram, so this must run on the raw batch even if
 * individual updates fail to parse.
 */
export function nextTelegramOffset(currentOffset: number, updates: Array<{ update_id?: unknown }>): number {
  let next = currentOffset;
  for (const u of updates) {
    if (u && typeof u.update_id === 'number' && u.update_id >= next) {
      next = u.update_id + 1;
    }
  }
  return next;
}
