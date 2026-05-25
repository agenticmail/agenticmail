/**
 * Telegram channel routes (plan §13.5).
 *
 * Two routers:
 *   - {@link createTelegramWebhookRoutes} — the inbound webhook
 *     (`POST /telegram/webhook`). Mounted BEFORE bearer auth: Telegram
 *     must reach it, and it authenticates itself with the per-agent
 *     `X-Telegram-Bot-Api-Secret-Token` header.
 *   - {@link createTelegramRoutes} — the agent-key-scoped surface
 *     (config / setup / disable / messages / send / poll).
 *
 * Inbound messages from the operator chat are matched against open
 * `ask_operator` queries and answered through the SAME
 * `PhoneManager.answerOperatorQuery` the inbound email-reply hook uses
 * (plan §5 / §13.4) — the operator-query records and the callback path
 * are reused, never duplicated.
 */

import { Router, type Request, type Response } from 'express';
import {
  TelegramManager,
  TelegramApiError,
  PhoneManager,
  ConversationSessionManager,
  getTelegramMe,
  sendTelegramMessage,
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramUpdates,
  parseTelegramUpdate,
  nextTelegramOffset,
  parseTelegramOperatorReply,
  recordTelegramConversationInbound,
  redactTelegramConfig,
  isTelegramChatAllowed,
  TELEGRAM_WEBHOOK_SECRET_RE,
  TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH,
  type AgenticMailConfig,
  type TelegramConfig,
  type ParsedTelegramMessage,
  type GatewayManager,
  type TelegramConversationContext,
} from '@agenticmail/core';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

/** Normalize a list of chat ids from request input to trimmed strings. */
function normalizeChatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''))
    .filter(Boolean);
}

interface InboundResult {
  duplicate: boolean;
  recorded: boolean;
  conversation?: TelegramConversationContext | null;
  /** A reply to send back to the inbound chat, if any. */
  confirmation?: string;
  /** Set when an operator query was answered. */
  answeredQueryId?: string;
}

/**
 * Process one parsed inbound Telegram message: dedup + record it, and —
 * when it comes from the configured operator chat — try to resolve it
 * to an open `ask_operator` query and record the answer.
 *
 * Pure DB work only; sending the `confirmation` back is left to the
 * caller so the transport layer owns all outbound HTTP.
 */
function processInboundMessage(
  telegramManager: TelegramManager,
  phoneManager: PhoneManager,
  conversationManager: ConversationSessionManager,
  agentId: string,
  config: TelegramConfig,
  parsed: ParsedTelegramMessage,
): InboundResult {
  if (telegramManager.inboundMessageExists(agentId, parsed.chatId, parsed.messageId)) {
    return { duplicate: true, recorded: false };
  }

  telegramManager.recordInbound(agentId, {
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
  const conversation = recordTelegramConversationInbound(conversationManager, agentId, parsed);
  const baseResult: InboundResult = { duplicate: false, recorded: true, conversation };

  // Operator-query answering — only ever from the operator's own chat.
  const operatorChatId = config.operatorChatId ? String(config.operatorChatId).trim() : '';
  if (!operatorChatId || parsed.chatId !== operatorChatId) {
    return baseResult;
  }

  const reply = parseTelegramOperatorReply({ text: parsed.text, replyToText: parsed.replyToText });
  if (!reply) return baseResult;

  // Resolve the target query: an explicitly named id, otherwise the
  // sole open query if there is exactly one (a bare reply convenience).
  let queryId = reply.queryId;
  if (!queryId) {
    const open = listOpenOperatorQueries(phoneManager, agentId);
    if (open.length === 1) {
      queryId = open[0].queryId;
    } else if (open.length > 1) {
      return {
        ...baseResult,
        confirmation: `You have ${open.length} open questions — reply with: /answer <queryId> <your answer>`,
      };
    } else {
      // No open query and no id — just a normal message to the agent.
      return baseResult;
    }
  }

  const found = phoneManager.findMissionByOperatorQueryId(queryId);
  // Fail closed: the query must exist AND belong to THIS agent.
  if (!found || found.mission.agentId !== agentId) {
    return {
      ...baseResult,
      confirmation: `Could not find an open question with id ${queryId}.`,
    };
  }

  let answered;
  try {
    answered = phoneManager.answerOperatorQuery(found.mission.id, queryId, reply.answer, {
      via: 'telegram',
      agentId,
    });
  } catch (err) {
    return {
      ...baseResult,
      confirmation: `Could not record that answer: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }
  if (!answered) {
    return {
      ...baseResult,
      confirmation: `Could not find an open question with id ${queryId}.`,
    };
  }

  // An answer may unblock a callback-on-disconnect (plan §7). Best-
  // effort — a failed callback dial must not fail the answer itself.
  void Promise.resolve()
    .then(() => phoneManager.triggerCallback(found.mission.id))
    .catch(() => { /* callback failure is logged inside the manager path */ });

  return {
    ...baseResult,
    answeredQueryId: queryId,
    confirmation: answered.alreadyAnswered
      ? `That question was already answered — keeping the first answer.`
      : `✅ Answer recorded for question ${queryId}.`,
  };
}

/** Open (unanswered) operator queries across all of an agent's missions. */
function listOpenOperatorQueries(
  phoneManager: PhoneManager,
  agentId: string,
): Array<{ missionId: string; queryId: string }> {
  const out: Array<{ missionId: string; queryId: string }> = [];
  const missions = phoneManager.listMissions(agentId, { limit: 100, offset: 0 });
  for (const mission of missions) {
    for (const query of phoneManager.listOperatorQueries(mission.id, agentId)) {
      if (!query.answer) out.push({ missionId: mission.id, queryId: query.id });
    }
  }
  return out;
}

/**
 * Inbound Telegram webhook. Telegram POSTs one update per call and
 * echoes the per-agent secret in `X-Telegram-Bot-Api-Secret-Token`.
 * Every failure mode — missing/unknown secret — funnels into a single
 * uniform 403 so the endpoint is not a secret-probing oracle.
 */
export function createTelegramWebhookRoutes(
  db: Db,
  config: AgenticMailConfig,
  gatewayManager?: GatewayManager,
): Router {
  const router = Router();
  const telegramManager = new TelegramManager(db as any, config.masterKey);
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const conversationManager = new ConversationSessionManager(db as any);

  router.post('/telegram/webhook', async (req: Request, res: Response) => {
    const provided = requestString(req.get('x-telegram-bot-api-secret-token'));
    const match = provided ? telegramManager.findAgentByWebhookSecret(provided) : null;
    if (!match) {
      return res.status(403).json({ error: 'Invalid Telegram webhook request' });
    }

    const parsed = parseTelegramUpdate(req.body ?? {});
    if (!parsed) {
      // A well-formed but non-text update (callbacks, service messages)
      // is acknowledged so Telegram does not redeliver it.
      return res.json({ ok: true, ignored: true });
    }

    // Allow-list gate: only linked chats (or the operator chat) are
    // recorded. Unknown chats are acknowledged but dropped.
    if (!isTelegramChatAllowed(match.config, parsed.chatId)) {
      return res.json({ ok: true, ignored: true });
    }

    let result: InboundResult;
    try {
      result = processInboundMessage(telegramManager, phoneManager, conversationManager, match.agentId, match.config, parsed);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }

    // Acknowledge before the (best-effort) outbound confirmation so a
    // slow Telegram send never delays the webhook response.
    res.json({ ok: true, duplicate: result.duplicate, answered: !!result.answeredQueryId });

    if (result.confirmation && match.config.botToken) {
      void sendTelegramMessage(match.config.botToken, parsed.chatId, result.confirmation, {
        replyToMessageId: parsed.messageId,
      }).catch(() => { /* confirmation is best-effort */ });
    }

    // Auto-wake bridge — fire only on a freshly-recorded message that
    // wasn't an operator-query reply (those already fed the phone
    // bridge directly). Same code path the poller uses, so push-mode
    // and poll-mode wake the agent identically.
    if (gatewayManager && !result.duplicate && !result.answeredQueryId && !result.conversation?.ended) {
      void gatewayManager.bridgeTelegramInbound(match.agentId, parsed, match.config, result.conversation)
        .catch((err) => console.warn(`[telegram-webhook] wake bridge failed: ${(err as Error).message}`));
    }
  });

  return router;
}

/** Agent-key-scoped Telegram routes: config / setup / disable / messages / send / poll. */
export function createTelegramRoutes(
  db: Db,
  config: AgenticMailConfig,
  gatewayManager?: GatewayManager,
): Router {
  const router = Router();
  const telegramManager = new TelegramManager(db as any, config.masterKey);
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const conversationManager = new ConversationSessionManager(db as any);

  // GET /telegram/config — current config (credentials redacted).
  router.get('/telegram/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = telegramManager.getConfig(agent.id);
      res.json({ configured: !!cfg, telegram: cfg ? redactTelegramConfig(cfg) : null });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /telegram/setup — register a bot token + link chats.
  router.post('/telegram/setup', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      // Partial-update support — `setup-telegram` re-runs that only
      // change the operator chat id shouldn't require the user to
      // re-paste the bot token. If the agent already has a Telegram
      // config saved, fall back to the existing bot token when the
      // request body doesn't supply one. Same pattern as the
      // /phone/transport/setup merge.
      const existingTg = telegramManager.getConfig(agent.id);
      const botToken = requestString(req.body?.botToken) || existingTg?.botToken || '';
      if (!botToken) {
        return res.status(400).json({ error: 'botToken is required (from @BotFather)' });
      }

      const mode = req.body?.mode === 'webhook' ? 'webhook' : 'poll';
      const allowedChatIds = normalizeChatIds(req.body?.allowedChatIds);
      const operatorChatId = requestString(
        typeof req.body?.operatorChatId === 'number'
          ? String(req.body.operatorChatId)
          : req.body?.operatorChatId,
      ) || undefined;

      let webhookUrl: string | undefined;
      let webhookSecret: string | undefined;
      if (mode === 'webhook') {
        webhookUrl = requestString(req.body?.webhookUrl);
        webhookSecret = requestString(req.body?.webhookSecret);
        if (!webhookUrl) {
          return res.status(400).json({ error: 'webhookUrl is required for mode "webhook"' });
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(webhookUrl);
        } catch {
          return res.status(400).json({ error: 'webhookUrl must be a valid URL' });
        }
        // Telegram only delivers webhooks over HTTPS; reject anything
        // else so the secret token is never sent in clear text.
        if (parsedUrl.protocol !== 'https:') {
          return res.status(400).json({ error: 'webhookUrl must use https://' });
        }
        if (!webhookSecret) {
          return res.status(400).json({ error: 'webhookSecret is required for mode "webhook"' });
        }
        if (webhookSecret.length < TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH
            || !TELEGRAM_WEBHOOK_SECRET_RE.test(webhookSecret)) {
          return res.status(400).json({
            error: `webhookSecret must be at least ${TELEGRAM_MIN_WEBHOOK_SECRET_LENGTH} characters and use only A-Z, a-z, 0-9, _ and -`,
          });
        }
      }

      // Validate the token with Telegram and capture the bot identity.
      let botInfo;
      try {
        botInfo = await getTelegramMe(botToken);
      } catch (err) {
        if (err instanceof TelegramApiError) {
          return res.status(400).json({
            error: 'Could not verify the bot token with Telegram. Check the token from @BotFather.',
          });
        }
        throw err;
      }

      // Register / clear the webhook to match the chosen mode.
      if (mode === 'webhook') {
        try {
          await setTelegramWebhook(botToken, webhookUrl!, { secretToken: webhookSecret });
        } catch (err) {
          return res.status(502).json({
            error: `Telegram rejected the webhook registration: ${err instanceof TelegramApiError ? err.description : 'unknown error'}`,
          });
        }
      } else {
        // Poll mode — clear any stale webhook so getUpdates is allowed.
        try { await deleteTelegramWebhook(botToken); } catch { /* best-effort */ }
      }

      const telegramConfig: TelegramConfig = {
        enabled: true,
        botToken,
        botUsername: botInfo.username,
        botId: botInfo.id,
        allowedChatIds,
        operatorChatId,
        mode,
        webhookUrl,
        webhookSecret,
        pollOffset: 0,
        configuredAt: new Date().toISOString(),
      };
      telegramManager.saveConfig(agent.id, telegramConfig);

      // Start (or restart) the per-agent long-poll loop immediately so
      // the user doesn't have to restart the server after `/telegram/setup`.
      // Webhook mode doesn't need a poller; the webhook route bridges
      // straight into `gatewayManager.bridgeTelegramInbound`.
      if (mode === 'poll' && gatewayManager) {
        try {
          await gatewayManager.startTelegramPollerForAgent(agent.id, agent.name);
        } catch (err) {
          console.warn(`[telegram] failed to start poller after setup: ${(err as Error).message}`);
        }
      }

      res.json({
        success: true,
        telegram: redactTelegramConfig(telegramConfig),
        bot: { id: botInfo.id, username: botInfo.username },
        nextSteps: mode === 'webhook'
          ? [
              `Webhook registered at ${webhookUrl}.`,
              'Telegram will deliver updates with the secret-token header — the channel is live.',
              allowedChatIds.length === 0
                ? 'No chats are linked yet — add chat ids with another /telegram/setup call so inbound messages are accepted.'
                : `${allowedChatIds.length} chat(s) linked.`,
            ]
          : [
              gatewayManager
                ? 'Poll mode — long-poll loop started. New messages wake the agent automatically.'
                : 'Poll mode — call POST /telegram/poll on a schedule to pull new messages.',
              allowedChatIds.length === 0
                ? 'No chats are linked yet — add chat ids so inbound messages are accepted.'
                : `${allowedChatIds.length} chat(s) linked.`,
            ],
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /telegram/disable — disable the channel.
  router.post('/telegram/disable', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const existing = telegramManager.getConfig(agent.id);
      if (!existing) {
        return res.json({ success: true, message: 'Telegram was not configured' });
      }
      existing.enabled = false;
      telegramManager.saveConfig(agent.id, existing);
      // Stop the running poll loop so we don't keep hammering Telegram
      // with the now-disabled token. The poller itself also self-stops
      // on the next config re-read, but stopping here makes shutdown
      // deterministic.
      if (gatewayManager) {
        try { await gatewayManager.stopTelegramPollerForAgent(agent.id); } catch { /* ignore */ }
      }
      res.json({ success: true, message: 'Telegram channel disabled' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /telegram/messages — list stored Telegram messages.
  router.get('/telegram/messages', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const rawDir = req.query.direction as string | undefined;
      const direction = rawDir === 'inbound' || rawDir === 'outbound' ? rawDir : undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const chatId = requestString(req.query.chatId) || undefined;
      const messages = telegramManager.listMessages(agent.id, { direction, chatId, limit, offset });
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /telegram/send — send a message to a chat.
  router.post('/telegram/send', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = telegramManager.getConfig(agent.id);
      if (!cfg?.enabled) {
        return res.status(400).json({ error: 'Telegram not configured or disabled. Use /telegram/setup first.' });
      }

      const chatId = requestString(typeof req.body?.chatId === 'number' ? String(req.body.chatId) : req.body?.chatId);
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!chatId) return res.status(400).json({ error: 'chatId is required' });
      if (!text.trim()) return res.status(400).json({ error: 'text is required' });

      const replyToMessageId = Number.isInteger(req.body?.replyToMessageId)
        ? req.body.replyToMessageId as number : undefined;

      try {
        const result = await sendTelegramMessage(cfg.botToken, chatId, text, { replyToMessageId });
        const record = telegramManager.recordOutbound(agent.id, {
          chatId,
          text,
          telegramMessageId: result.messageIds[0],
          status: 'sent',
        }, { chunks: result.chunks, messageIds: result.messageIds });
        res.json({ success: true, message: record, chunks: result.chunks });
      } catch (err) {
        const record = telegramManager.recordOutbound(agent.id, { chatId, text, status: 'failed' }, {
          error: err instanceof TelegramApiError ? err.description : 'send failed',
        });
        res.status(502).json({
          success: false,
          message: record,
          error: err instanceof TelegramApiError ? err.description : 'Telegram send failed',
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /telegram/poll — pull + process new updates (poll-mode transport).
  router.post('/telegram/poll', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = telegramManager.getConfig(agent.id);
      if (!cfg?.enabled) {
        return res.status(400).json({ error: 'Telegram not configured or disabled. Use /telegram/setup first.' });
      }

      let updates: Array<Record<string, unknown>>;
      try {
        updates = await getTelegramUpdates(cfg.botToken, cfg.pollOffset ?? 0, { timeoutSec: 0 });
      } catch (err) {
        return res.status(502).json({
          error: `Telegram getUpdates failed: ${err instanceof TelegramApiError ? err.description : 'unknown error'}`,
        });
      }

      let recorded = 0;
      let answered = 0;
      const pendingConfirmations: Array<{ chatId: string; messageId: number; text: string }> = [];
      const pendingBridges: Array<{ parsed: ParsedTelegramMessage; conversation?: TelegramConversationContext | null }> = [];

      for (const update of updates) {
        const parsed = parseTelegramUpdate(update);
        if (!parsed) continue;
        if (!isTelegramChatAllowed(cfg, parsed.chatId)) continue;
        const result = processInboundMessage(telegramManager, phoneManager, conversationManager, agent.id, cfg, parsed);
        if (result.recorded) recorded++;
        if (result.answeredQueryId) answered++;
        if (gatewayManager && !result.duplicate && !result.answeredQueryId && !result.conversation?.ended) {
          pendingBridges.push({ parsed, conversation: result.conversation });
        }
        if (result.confirmation) {
          pendingConfirmations.push({ chatId: parsed.chatId, messageId: parsed.messageId, text: result.confirmation });
        }
      }

      // Advance + persist the offset on the RAW batch so a parse failure
      // on one update cannot wedge the poll on it forever.
      const newOffset = nextTelegramOffset(cfg.pollOffset ?? 0, updates as Array<{ update_id?: unknown }>);
      if (newOffset !== (cfg.pollOffset ?? 0)) {
        telegramManager.updatePollOffset(agent.id, newOffset);
      }

      // Best-effort confirmations for any operator-query answers.
      for (const c of pendingConfirmations) {
        try {
          await sendTelegramMessage(cfg.botToken, c.chatId, c.text, { replyToMessageId: c.messageId });
        } catch { /* best-effort */ }
      }

      for (const bridge of pendingBridges) {
        try {
          await gatewayManager!.bridgeTelegramInbound(agent.id, bridge.parsed, cfg, bridge.conversation);
        } catch (err) {
          console.warn(`[telegram-poll] wake bridge failed: ${(err as Error).message}`);
        }
      }

      res.json({ success: true, fetched: updates.length, recorded, answered, offset: newOffset });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * v0.9.91 — operator-query answer intake from the standalone
   * Telegram bridge. The bridge does its own long-polling (poll mode),
   * so `/telegram/poll` would race against it. This endpoint takes
   * a SINGLE already-parsed Telegram message and runs only the
   * operator-query branch of `processInboundMessage` — no second
   * Telegram fetch. The bridge calls this BEFORE forwarding the
   * message to claudecode; if `answered` comes back true, the
   * bridge sends the confirmation back to the operator and SKIPS
   * the claudecode forward.
   *
   * Body shape mirrors {@link ParsedTelegramMessage} — chatId, text,
   * messageId, replyToText, plus the standard sender fields. Agent
   * is authenticated via the agent-key bearer (same as every other
   * route on this router).
   */
  router.post('/telegram/operator-query/intake', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = telegramManager.getConfig(agent.id);
      if (!cfg?.enabled) {
        return res.status(400).json({ error: 'Telegram not configured for this agent.' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = {
        chatId: String(body.chatId ?? ''),
        chatType: String(body.chatType ?? 'private') as 'private' | 'group' | 'supergroup' | 'channel',
        messageId: Number(body.messageId ?? 0),
        fromId: body.fromId == null ? undefined : String(body.fromId),
        fromName: body.fromName == null ? undefined : String(body.fromName),
        fromUsername: body.fromUsername == null ? undefined : String(body.fromUsername),
        text: String(body.text ?? ''),
        replyToText: body.replyToText == null ? undefined : String(body.replyToText),
        updateId: Number(body.updateId ?? 0),
      };
      if (!parsed.chatId || !parsed.messageId || !parsed.text) {
        return res.status(400).json({ error: 'chatId, messageId and text are required.' });
      }
      const result = processInboundMessage(telegramManager, phoneManager, agent.id, cfg, parsed);
      return res.json({
        recorded: result.recorded,
        answered: Boolean(result.answeredQueryId),
        answeredQueryId: result.answeredQueryId ?? null,
        confirmation: result.confirmation ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
