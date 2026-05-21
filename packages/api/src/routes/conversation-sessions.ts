import { Router, type Request, type Response } from 'express';
import {
  ConversationSessionManager,
  PhoneManager,
  TelegramApiError,
  TelegramManager,
  isRealtimeConversationChannel,
  isTelegramChatAllowed,
  planRealtimeConversationStart,
  sendTelegramMessage,
  type AgenticMailConfig,
  type ConversationSessionStatus,
  type RealtimeConversationChannel,
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

function phoneRealtimeMediaConfigured(phone: ReturnType<PhoneManager['getPhoneTransportConfig']>): boolean {
  return !!phone?.capabilities.includes('realtime_media')
    && (phone.provider === '46elks' ? !!phone.realtimeBridgeNumber : phone.provider === 'twilio');
}

function normalizeStatus(value: unknown): ConversationSessionStatus | undefined {
  return value === 'active' || value === 'ended' || value === 'failed'
    ? value
    : undefined;
}

function normalizeChannel(value: unknown): RealtimeConversationChannel | undefined {
  return isRealtimeConversationChannel(value) ? value : undefined;
}

export function createConversationSessionRoutes(
  db: Db,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const sessions = new ConversationSessionManager(db as any);
  const telegramManager = new TelegramManager(db as any, config.masterKey);
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  router.get('/conversation/sessions', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const status = normalizeStatus(req.query.status);
      const channel = normalizeChannel(req.query.channel);
      const rows = sessions.listSessions(agent.id, { status, channel, limit, offset });
      res.json({ sessions: rows, count: rows.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/conversation/sessions/:id', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const session = sessions.getSession(agent.id, req.params.id);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      res.json({ session });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/conversation/sessions/:id/messages', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const messages = sessions.listMessages(agent.id, req.params.id);
      res.json({ messages, count: messages.length });
    } catch (err) {
      const status = String((err as Error).message).includes('not found') ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  router.post('/conversation/sessions/start', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const channel = requestString(req.body?.channel);
      if (!isRealtimeConversationChannel(channel)) {
        return res.status(400).json({ error: `Unsupported realtime conversation channel: ${channel || '(missing)'}` });
      }

      if (channel === 'telegram') {
        return await startTelegramSession(req, res, agent.id);
      }
      if (channel === 'phone') {
        return await startPhoneSession(req, res, agent.id);
      }

      const plan = planRealtimeConversationStart({
        channel,
        transportConfigured: false,
        userOptedIn: req.body?.userOptedIn === true,
        operatorApproved: req.body?.operatorApproved === true,
      });
      return res.status(400).json({ error: plan.reason, plan });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/conversation/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const session = sessions.getSession(agent.id, req.params.id);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      if (session.status !== 'active') return res.status(400).json({ error: 'conversation session is not active' });
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!text.trim()) return res.status(400).json({ error: 'text is required' });

      if (session.channel !== 'telegram') {
        return res.status(400).json({
          error: `${session.channel} sessions do not accept text messages through this endpoint yet`,
        });
      }
      const cfg = telegramManager.getConfig(agent.id);
      if (!cfg?.enabled) {
        return res.status(400).json({ error: 'Telegram not configured or disabled. Use /telegram/setup first.' });
      }

      try {
        const result = await sendTelegramMessage(cfg.botToken, session.peer, text);
        const telegramRecord = telegramManager.recordOutbound(agent.id, {
          chatId: session.peer,
          text,
          telegramMessageId: result.messageIds[0],
          status: 'sent',
        }, {
          conversationSessionId: session.id,
          chunks: result.chunks,
          messageIds: result.messageIds,
        });
        const message = sessions.recordMessage({
          sessionId: session.id,
          agentId: agent.id,
          channel: 'telegram',
          direction: 'outbound',
          text,
          externalMessageId: result.messageIds[0] ? String(result.messageIds[0]) : undefined,
          metadata: { telegramMessageId: telegramRecord.telegramMessageId, chunks: result.chunks },
        });
        return res.json({ success: true, message, telegram: telegramRecord });
      } catch (err) {
        const telegramRecord = telegramManager.recordOutbound(agent.id, {
          chatId: session.peer,
          text,
          status: 'failed',
        }, {
          conversationSessionId: session.id,
          error: err instanceof TelegramApiError ? err.description : 'send failed',
        });
        return res.status(502).json({
          success: false,
          telegram: telegramRecord,
          error: err instanceof TelegramApiError ? err.description : 'Telegram send failed',
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/conversation/sessions/:id/end', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const status = req.body?.status === 'failed' ? 'failed' : 'ended';
      const session = sessions.endSession(agent.id, req.params.id, status);
      res.json({ success: true, session });
    } catch (err) {
      const code = String((err as Error).message).includes('not found') ? 404 : 500;
      res.status(code).json({ error: (err as Error).message });
    }
  });

  async function startTelegramSession(req: Request, res: Response, agentId: string): Promise<Response> {
    const cfg = telegramManager.getConfig(agentId);
    const chatId = requestString(typeof req.body?.chatId === 'number'
      ? String(req.body.chatId)
      : (req.body?.chatId ?? req.body?.peer));
    const initialMessage = typeof req.body?.initialMessage === 'string' ? req.body.initialMessage : '';
    const plan = planRealtimeConversationStart({
      channel: 'telegram',
      transportConfigured: !!cfg?.enabled && !!cfg.botToken,
      userOptedIn: !!cfg && chatId ? isTelegramChatAllowed(cfg, chatId) : false,
    });
    if (!plan.ok) return res.status(400).json({ error: plan.reason, plan });
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });

    const existing = sessions.findActiveSessionByPeer(agentId, 'telegram', chatId);
    const session = existing ?? sessions.createSession({
      agentId,
      channel: 'telegram',
      peer: chatId,
      subject: requestString(req.body?.subject) || undefined,
      goal: requestString(req.body?.goal) || undefined,
      metadata: { transport: 'telegram' },
    });

    if (!initialMessage.trim()) {
      return res.json({ success: true, session, reused: !!existing, plan });
    }

    try {
      const result = await sendTelegramMessage(cfg!.botToken, chatId, initialMessage);
      const telegramRecord = telegramManager.recordOutbound(agentId, {
        chatId,
        text: initialMessage,
        telegramMessageId: result.messageIds[0],
        status: 'sent',
      }, {
        conversationSessionId: session.id,
        chunks: result.chunks,
        messageIds: result.messageIds,
      });
      const message = sessions.recordMessage({
        sessionId: session.id,
        agentId,
        channel: 'telegram',
        direction: 'outbound',
        text: initialMessage,
        externalMessageId: result.messageIds[0] ? String(result.messageIds[0]) : undefined,
        metadata: { telegramMessageId: telegramRecord.telegramMessageId, chunks: result.chunks },
      });
      return res.json({ success: true, session, reused: !!existing, message, telegram: telegramRecord, plan });
    } catch (err) {
      if (!existing) sessions.endSession(agentId, session.id, 'failed');
      return res.status(502).json({
        success: false,
        session,
        error: err instanceof TelegramApiError ? err.description : 'Telegram send failed',
      });
    }
  }

  async function startPhoneSession(req: Request, res: Response, agentId: string): Promise<Response> {
    const phone = phoneManager.getPhoneTransportConfig(agentId);
    const policy = req.body?.policy;
    const plan = planRealtimeConversationStart({
      channel: 'phone',
      transportConfigured: !!phone,
      realtimeMediaConfigured: phoneRealtimeMediaConfigured(phone),
      openaiRealtimeConfigured: !!config.openaiApiKey || req.body?.dryRun === true,
      policyProvided: !!policy,
    });
    if (!plan.ok) return res.status(400).json({ error: plan.reason, plan });

    const to = requestString(req.body?.to ?? req.body?.peer);
    const task = requestString(req.body?.task ?? req.body?.goal);
    if (!to) return res.status(400).json({ error: 'to is required' });
    if (!task) return res.status(400).json({ error: 'task is required' });

    const result = await phoneManager.startMission(agentId, {
      to,
      task,
      policy,
      voiceRuntimeRef: requestString(req.body?.voiceRuntimeRef) || undefined,
    }, {
      dryRun: req.body?.dryRun === true,
    });
    const session = sessions.createSession({
      agentId,
      channel: 'phone',
      peer: to,
      subject: requestString(req.body?.subject) || undefined,
      goal: task,
      externalRef: result.mission.id,
      metadata: {
        transport: 'phone',
        missionId: result.mission.id,
        provider: result.mission.provider,
        dryRun: req.body?.dryRun === true,
      },
    });
    const message = sessions.recordMessage({
      sessionId: session.id,
      agentId,
      channel: 'phone',
      direction: 'system',
      text: `Phone mission ${result.mission.id} started for ${to}.`,
      metadata: { missionId: result.mission.id, status: result.mission.status },
    });
    return res.json({ success: true, session, message, mission: result.mission, plan });
  }

  return router;
}
