/**
 * Telegram Bot API client — dependency-free (global `fetch`, Node 22+).
 *
 * Ported and MERGED from two already-tuned internal sources (licensing
 * confirmed by Ope, 2026-05-19 — plan §13.5):
 *   - enterprise `agent-tools/tools/messaging/telegram.ts`
 *     (`tgApi`, `stripMarkdown`, webhook management)
 *   - agent-harness `fola-lib/telegram-api.mjs`
 *     (auto-splitting `sendMessage`, the long-poll timeout discipline)
 *
 * Host-specific pieces are intentionally dropped to fit the single-tenant
 * open-source product: the local Bot API server auto-detection
 * (`http://localhost:8081`) and the filesystem media-download paths are
 * Fola-host infrastructure, not channel logic.
 *
 * Secrets: the bot token rides in the request URL path. Every error this
 * module surfaces is scrubbed with {@link redactBotToken} so a token can
 * never reach a log line or an API response — matching the SMS/phone
 * credential-handling bar.
 */

/** Official Telegram Bot API base. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram's hard per-message ceiling is 4096 characters. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** We split below the hard limit, leaving headroom for safety. */
export const TELEGRAM_CHUNK_SIZE = 4000;

/** A failed Telegram Bot API call. `description` is the provider message. */
export class TelegramApiError extends Error {
  readonly isTelegramApiError = true;
  readonly description: string;
  readonly errorCode?: number;

  constructor(method: string, description: string, errorCode?: number) {
    super(`Telegram ${method} failed: ${description}${errorCode ? ` (code ${errorCode})` : ''}`);
    this.name = 'TelegramApiError';
    this.description = description;
    this.errorCode = errorCode;
  }
}

/**
 * Scrub bot tokens from any string before it can be logged or returned.
 *
 * A token looks like `<digits>:<35 url-safe chars>`. We redact both an
 * explicitly-known token (exact match) and anything matching the generic
 * token shape — so a token leaks neither when the caller knows it nor
 * when it is buried in, say, a `fetch` failure message carrying the URL.
 */
export function redactBotToken(text: string, token?: string): string {
  let out = typeof text === 'string' ? text : String(text);
  if (token) out = out.split(token).join('bot***');
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, 'bot***');
}

export interface TelegramApiOptions {
  /**
   * Long-poll requests (`getUpdates` with a non-zero `timeout`) need an
   * HTTP timeout longer than the server-side poll window, or the socket
   * is torn down before Telegram replies.
   */
  longPoll?: boolean;
}

/**
 * POST a Telegram Bot API method with a JSON body and return `result`.
 * Throws {@link TelegramApiError} (token-scrubbed) on any failure.
 */
export async function callTelegramApi<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  options: TelegramApiOptions = {},
): Promise<T> {
  if (!token || typeof token !== 'string') {
    throw new TelegramApiError(method, 'bot token is required');
  }

  const pollTimeout = typeof body?.timeout === 'number' ? body.timeout : 0;
  const timeoutMs = options.longPoll && pollTimeout > 0 ? (pollTimeout + 15) * 1000 : 30_000;

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A network/timeout failure can echo the request URL (with the
    // token) in its message — scrub before it propagates anywhere.
    throw new TelegramApiError(method, redactBotToken((err as Error)?.message ?? String(err), token));
  }

  let json: { ok?: boolean; result?: T; description?: string; error_code?: number };
  try {
    json = await response.json() as typeof json;
  } catch {
    throw new TelegramApiError(method, `non-JSON response (HTTP ${response.status})`);
  }

  if (!json || json.ok !== true) {
    throw new TelegramApiError(
      method,
      redactBotToken(String(json?.description || `HTTP ${response.status}`), token),
      typeof json?.error_code === 'number' ? json.error_code : undefined,
    );
  }
  return json.result as T;
}

/**
 * Strip Markdown so agent replies arrive as clean plain text. Telegram's
 * Markdown parse modes are bypassed entirely (no `parse_mode`) to avoid
 * formatting collisions on arbitrary agent output.
 */
export function stripTelegramMarkdown(text: string): string {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')           // **bold**
    .replace(/\*(.+?)\*/g, '$1')               // *italic*
    .replace(/__(.+?)__/g, '$1')               // __underline__
    .replace(/~~(.+?)~~/g, '$1')               // ~~strike~~
    .replace(/^#{1,6}\s+/gm, '')               // # headings
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim()) // ```blocks```
    .replace(/`([^`]+)`/g, '$1')               // `inline code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [link](url)
    .trim();
}

/**
 * Split text into <= `maxLen` chunks, cutting on a newline boundary when
 * one is reasonably close so messages do not break mid-word.
 */
export function splitTelegramMessage(text: string, maxLen: number = TELEGRAM_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  let rest = text || '';
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface SendTelegramMessageOptions {
  /** Reply to a specific message id in the chat. */
  replyToMessageId?: number;
  /** Deliver silently (no push notification). */
  disableNotification?: boolean;
}

export interface SendTelegramMessageResult {
  /** message_id of each chunk Telegram accepted, in order. */
  messageIds: number[];
  /** Number of chunks the text was split into. */
  chunks: number;
}

/**
 * Send a text message, auto-splitting anything over the per-message
 * ceiling. The reply target (if any) is attached only to the first
 * chunk so a long reply still threads correctly.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string | number,
  text: string,
  options: SendTelegramMessageOptions = {},
): Promise<SendTelegramMessageResult> {
  const clean = stripTelegramMarkdown(text);
  const chunks = splitTelegramMessage(clean);
  if (chunks.length === 0) chunks.push('');

  const messageIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { chat_id: String(chatId), text: chunks[i] };
    if (i === 0 && options.replyToMessageId) {
      body.reply_parameters = { message_id: options.replyToMessageId };
    }
    if (options.disableNotification) body.disable_notification = true;
    const result = await callTelegramApi<{ message_id: number }>(token, 'sendMessage', body);
    messageIds.push(result.message_id);
  }
  return { messageIds, chunks: chunks.length };
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

/** `getMe` — used to validate a token and capture the bot identity. */
export function getTelegramMe(token: string): Promise<TelegramBotInfo> {
  return callTelegramApi<TelegramBotInfo>(token, 'getMe');
}

/** `getChat` — chat metadata (title, type, member count, ...). */
export function getTelegramChat(token: string, chatId: string | number): Promise<Record<string, unknown>> {
  return callTelegramApi<Record<string, unknown>>(token, 'getChat', { chat_id: String(chatId) });
}

export interface GetUpdatesOptions {
  /** Max updates per call (1-100). */
  limit?: number;
  /** Long-poll window in seconds (0 = short poll). */
  timeoutSec?: number;
}

/** `getUpdates` long-poll — the poll-mode transport. */
export function getTelegramUpdates(
  token: string,
  offset: number,
  options: GetUpdatesOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const timeoutSec = Math.max(options.timeoutSec ?? 0, 0);
  return callTelegramApi<Array<Record<string, unknown>>>(token, 'getUpdates', {
    offset,
    limit: Math.min(Math.max(options.limit ?? 100, 1), 100),
    timeout: timeoutSec,
    allowed_updates: ['message'],
  }, { longPoll: timeoutSec > 0 });
}

export interface SetWebhookOptions {
  /**
   * Shared secret echoed by Telegram in the
   * `X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery.
   */
  secretToken?: string;
  /** Drop updates that queued up while no webhook was set. */
  dropPendingUpdates?: boolean;
}

/** `setWebhook` — register the inbound webhook URL (webhook-mode transport). */
export function setTelegramWebhook(token: string, url: string, options: SetWebhookOptions = {}): Promise<boolean> {
  return callTelegramApi<boolean>(token, 'setWebhook', {
    url,
    secret_token: options.secretToken,
    allowed_updates: ['message'],
    drop_pending_updates: options.dropPendingUpdates ?? false,
  });
}

/** `deleteWebhook` — switch back to poll mode. */
export function deleteTelegramWebhook(token: string): Promise<boolean> {
  return callTelegramApi<boolean>(token, 'deleteWebhook', {});
}

/** `getWebhookInfo` — current webhook status. */
export function getTelegramWebhookInfo(token: string): Promise<Record<string, unknown>> {
  return callTelegramApi<Record<string, unknown>>(token, 'getWebhookInfo');
}
