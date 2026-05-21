/**
 * TelegramPoller — long-poll loop that pulls Telegram updates for ONE
 * agent and fires an `onInbound` callback for every new, allow-listed
 * message that isn't already in the database.
 *
 * Why this exists. The Telegram channel until v0.9.59 was capture-only:
 * inbound messages were recorded by the `/telegram/poll` HTTP route, but
 * nothing ever called that route. The result was that the user DM'd the
 * bot and got silence. This poller closes the loop by running
 * continuously inside the API server and handing each new inbound
 * message to a delivery callback — the `GatewayManager` plugs that
 * callback in and synthesises an email into the agent's INBOX, which
 * trips the existing IMAP IDLE → claudecode dispatcher path and wakes
 * the agent for a real host turn.
 *
 * Long-poll, not short-poll. Telegram's `getUpdates` supports a long-
 * poll `timeout` parameter — the request blocks on the server side for
 * up to N seconds waiting for a new update, then returns. Latency from
 * "user hits send" to "agent gets a turn" is <1s in the best case and
 * bounded by the timeout in the worst case. We use 25s (well under the
 * 30s nginx/cloudflared default request cap) and immediately re-fire on
 * return, so the next message is picked up the moment Telegram queues
 * it. Compared to short polling every 5s this is both lower-latency AND
 * uses an order of magnitude less of the bot's API budget.
 *
 * Operator-query replies are NOT bridged. When a Telegram message comes
 * from the operator's own chat and looks like an answer to an in-flight
 * phone call's `ask_operator` query (per
 * {@link parseTelegramOperatorReply}), the existing route hands it to
 * the phone manager and that's the end of the line — the agent does NOT
 * need a turn, the voice bridge already has what it was waiting for.
 * Everything else (free-form chat, "call my dentist") is what we wake
 * the agent for.
 */

import {
  getTelegramUpdates,
  TelegramApiError,
} from './client.js';
import {
  parseTelegramUpdate,
  nextTelegramOffset,
  type ParsedTelegramMessage,
} from './update.js';
import {
  TelegramManager,
  isTelegramChatAllowed,
  type TelegramConfig,
} from './manager.js';
import {
  recordTelegramConversationInbound,
  type TelegramConversationContext,
} from './conversation.js';
import type { ConversationSessionManager } from '../conversation/session.js';

/** Default long-poll timeout in seconds — well under proxy/CDN caps. */
export const TELEGRAM_LONG_POLL_TIMEOUT_SEC = 25;

/** Backoff cap when Telegram errors (matches Twilio/IMAP code). */
const ERROR_BACKOFF_MAX_MS = 60_000;
const ERROR_BACKOFF_BASE_MS = 2_000;

export interface TelegramInboundEvent {
  /** The agent the message is addressed to (config owner). */
  agentId: string;
  /** Parsed Telegram message — sender, chat, text, IDs, etc. */
  message: ParsedTelegramMessage;
  /** The live Telegram config (decrypted) used to send the reply. */
  config: TelegramConfig;
  /** Active conversation session context when this message belongs to one. */
  conversation?: TelegramConversationContext | null;
}

export interface TelegramPollerOptions {
  /** How long to long-poll each `getUpdates` call. */
  timeoutSec?: number;
  /** Min log-suppress window — duplicated warnings collapse to one log line. */
  suppressDuplicateLogsMs?: number;
  /** Optional active-session ledger writer for poll-mode inbound messages. */
  conversationManager?: ConversationSessionManager;
}

/**
 * One poller per agent. Construct, set `onInbound`, call `start()` —
 * the loop runs until `stop()` resolves. Safe to call `start()` again
 * after `stop()`.
 */
export class TelegramPoller {
  private running = false;
  private currentAbort: AbortController | null = null;
  /** Wakes a sleeping backoff so `stop()` returns quickly. */
  private wakeStop: (() => void) | null = null;
  private lastErrorLogAt = 0;
  private lastErrorMessage = '';

  /**
   * Set by the caller. Fired for every new inbound message that isn't a
   * duplicate and is in the allow-list. The callback's return value
   * gates record-as-handled (errors propagate as failures the loop
   * tolerates — the poll offset is STILL advanced so a single bad
   * message doesn't wedge the agent forever).
   */
  onInbound: ((event: TelegramInboundEvent) => void | Promise<void>) | null = null;

  constructor(
    private readonly telegramManager: TelegramManager,
    private readonly agentId: string,
    private readonly options: TelegramPollerOptions = {},
  ) {}

  /** Has `start()` been called and is the loop still running? */
  get isRunning(): boolean { return this.running; }

  /** Resolves when the background loop has fully exited. */
  private loopPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Catch the loop's own promise so an unexpected throw inside the
    // loop never bubbles up as an unhandled rejection — the loop body
    // already swallows known errors, but a programmer mistake (e.g.
    // accessing a property on undefined) shouldn't crash the API.
    this.loopPromise = this.loop().catch((err) => {
      this.running = false;
      console.warn(`[TelegramPoller:${this.agentId.slice(0, 8)}] loop crashed: ${(err as Error)?.message ?? err}`);
    });
  }

  /** Cancel the in-flight long-poll and wait for the loop to exit. */
  async stop(): Promise<void> {
    this.running = false;
    try { this.currentAbort?.abort(); } catch { /* ignore */ }
    if (this.wakeStop) { try { this.wakeStop(); } catch { /* ignore */ } }
    // Awaiting the loop's exit makes `stop()` deterministic for tests
    // and for shutdown ordering — the caller can know the in-flight
    // fetch and any pending DB writes have settled before returning.
    if (this.loopPromise) {
      try { await this.loopPromise; } catch { /* loop already caught */ }
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    const timeoutSec = Math.max(1, this.options.timeoutSec ?? TELEGRAM_LONG_POLL_TIMEOUT_SEC);
    let backoff = ERROR_BACKOFF_BASE_MS;

    while (this.running) {
      // Re-read the config each iteration so we pick up token changes,
      // disable toggles, and updated allow-lists without restarting.
      const config = this.telegramManager.getConfig(this.agentId);
      if (!config?.enabled || config.mode !== 'poll' || !config.botToken) {
        // Channel was disabled / switched to webhook out from under us.
        this.running = false;
        return;
      }

      const offset = config.pollOffset ?? 0;

      // Per-iteration AbortController — `stop()` calls `abort()` so a
      // 25-second long-poll returns within milliseconds of shutdown.
      const controller = new AbortController();
      this.currentAbort = controller;

      try {
        const updates = await getTelegramUpdates(config.botToken, offset, {
          timeoutSec,
          signal: controller.signal,
        });
        backoff = ERROR_BACKOFF_BASE_MS;

        // Defensive: a misbehaving stub or a Telegram quirk could
        // return instantly with no updates and no error. Avoid a hot
        // CPU loop by yielding at least a microtask, plus a short
        // sleep when long-poll-mode returned faster than 100ms with
        // nothing — that's never the real protocol.
        if (updates.length === 0 && timeoutSec > 0) {
          // Microtask yield is enough for tests; production long-poll
          // already blocks for `timeoutSec` so we never reach here.
          await new Promise((r) => setImmediate(r));
        }

        for (const update of updates) {
          if (!this.running) break;
          const parsed = parseTelegramUpdate(update);
          if (!parsed) continue;
          if (!isTelegramChatAllowed(config, parsed.chatId)) continue;

          // De-dup. Telegram returns updates with monotonically
          // increasing `update_id`, and we advance the offset after the
          // batch — but a process restart that crashed before the
          // offset advance will replay the batch. Skip messages we
          // already have for this chat+message id.
          if (this.telegramManager.inboundMessageExists(this.agentId, parsed.chatId, parsed.messageId)) {
            continue;
          }

          this.telegramManager.recordInbound(this.agentId, {
            chatId: parsed.chatId,
            telegramMessageId: parsed.messageId,
            fromId: parsed.fromId,
            text: parsed.text,
            createdAt: parsed.date,
          }, {
            chatType: parsed.chatType,
            fromName: parsed.fromName,
            fromUsername: parsed.fromUsername,
            updateId: parsed.updateId,
          });
          const conversation = this.options.conversationManager
            ? recordTelegramConversationInbound(this.options.conversationManager, this.agentId, parsed)
            : null;

          // Fire the bridge. Errors here must NOT wedge the loop — the
          // worst case is a missed agent wake on one message, which the
          // user will simply not notice on the next reply.
          if (this.onInbound) {
            try {
              await this.onInbound({ agentId: this.agentId, message: parsed, config, conversation });
            } catch (err) {
              this.logError('inbound bridge failed', err);
            }
          }
        }

        // Advance the persisted offset on the RAW batch so a single
        // parse failure can't wedge us on it forever — mirrors the
        // route's behaviour exactly.
        const newOffset = nextTelegramOffset(offset, updates as Array<{ update_id?: unknown }>);
        if (newOffset !== offset) {
          this.telegramManager.updatePollOffset(this.agentId, newOffset);
        }
      } catch (err) {
        if (!this.running) return;
        // An aborted long-poll on shutdown is expected — exit quietly.
        if (controller.signal.aborted) return;
        // 401/404 token errors are permanent — surface and exit; we
        // wouldn't want to hammer Telegram with the wrong token.
        if (err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404)) {
          this.logError('bot token rejected — stopping poller', err);
          this.running = false;
          return;
        }
        this.logError('getUpdates failed', err);
        await this.backoff(backoff);
        backoff = Math.min(backoff * 2, ERROR_BACKOFF_MAX_MS);
      } finally {
        if (this.currentAbort === controller) this.currentAbort = null;
      }
    }
  }

  /** Sleep that returns early on `stop()`. */
  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.wakeStop = null; resolve(); }, ms);
      this.wakeStop = () => { clearTimeout(t); this.wakeStop = null; resolve(); };
    });
  }

  /** Collapse identical errors fired in close succession to one log line. */
  private logError(prefix: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const suppressMs = this.options.suppressDuplicateLogsMs ?? 30_000;
    const now = Date.now();
    if (msg === this.lastErrorMessage && now - this.lastErrorLogAt < suppressMs) return;
    this.lastErrorLogAt = now;
    this.lastErrorMessage = msg;
    console.warn(`[TelegramPoller:${this.agentId.slice(0, 8)}] ${prefix}: ${msg}`);
  }
}
