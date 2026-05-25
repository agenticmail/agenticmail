import { Router, type Request, type Response } from 'express';
import {
  ConversationSessionManager,
  GoogleMeetApiError,
  GoogleMeetManager,
  MatrixApiError,
  MatrixManager,
  PhoneManager,
  TelegramApiError,
  TelegramManager,
  buildGoogleMeetSessionBriefing,
  getGoogleMeetReadiness,
  isConversationMessageDirection,
  isRealtimeConversationChannel,
  isTelegramChatAllowed,
  normalizeGoogleMeetBehaviorMode,
  parseGoogleMeetLink,
  planRealtimeConversationStart,
  sendGoogleMeetLiveSidecarControl,
  sendMatrixMessage,
  sendTelegramMessage,
  type AgenticMailConfig,
  type ConversationSession,
  type ConversationSessionStatus,
  type RealtimeConversationChannel,
} from '@agenticmail/core';
import { requestPhonePolicyPreset, resolvePhoneMissionPolicy } from '../phone-policy.js';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requestRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const LIVE_CONTEXT_STRING_FIELDS = [
  'tenantId',
  'accountId',
  'workspaceId',
  'operatorId',
  'operatorChannel',
  'hostIntegration',
  'hostIntegrationId',
  'hostSessionId',
  'projectRef',
  'behaviorMode',
  'approvalScope',
] as const;

function buildLiveSessionMetadata(
  req: Request,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const userMetadata = requestRecord(req.body?.metadata) ?? {};
  const baseLiveContext = requestRecord(base.liveContext) ?? {};
  const baseMetadata = { ...base };
  delete baseMetadata.liveContext;
  const metadataLiveContext = requestRecord(userMetadata.liveContext) ?? {};
  const bodyLiveContext = requestRecord(req.body?.liveContext) ?? {};
  const liveContext: Record<string, unknown> = {
    ...baseLiveContext,
    ...metadataLiveContext,
    ...bodyLiveContext,
  };

  for (const field of LIVE_CONTEXT_STRING_FIELDS) {
    const value = requestString(req.body?.[field] ?? liveContext[field]);
    if (value) liveContext[field] = value;
  }
  const policyScope = requestRecord(req.body?.policyScope) ?? requestRecord(liveContext.policyScope);
  const budgetScope = requestRecord(req.body?.budgetScope) ?? requestRecord(liveContext.budgetScope);
  if (policyScope) liveContext.policyScope = policyScope;
  if (budgetScope) liveContext.budgetScope = budgetScope;

  const out: Record<string, unknown> = {
    ...userMetadata,
    ...baseMetadata,
  };
  if (Object.keys(liveContext).length > 0) out.liveContext = liveContext;
  return out;
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
  const matrixManager = new MatrixManager(db as any, config.masterKey);
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const googleMeetManager = new GoogleMeetManager(db as any, config.masterKey);

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

  router.get('/conversation/sessions/:id/context', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const session = sessions.getSession(agent.id, req.params.id);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      const messageLimit = Math.min(Math.max(Number(req.query.messageLimit) || 50, 1), 200);
      const allMessages = sessions.listMessages(agent.id, req.params.id);
      const messages = allMessages.slice(-messageLimit);
      res.json({
        session,
        messages,
        count: messages.length,
        totalMessages: allMessages.length,
      });
    } catch (err) {
      const status = String((err as Error).message).includes('not found') ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
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
      if (channel === 'matrix') {
        return await startMatrixSession(req, res, agent.id);
      }
      if (channel === 'phone') {
        return await startPhoneSession(req, res, agent.id);
      }
      if (channel === 'google_meet') {
        return startGoogleMeetSession(req, res, agent.id);
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
      const action = requestString(req.body?.action);
      const googleMeetControlOnly = session.channel === 'google_meet' && !!action && action !== 'say';
      if (!text.trim() && !googleMeetControlOnly) return res.status(400).json({ error: 'text is required' });

      if (session.channel === 'matrix') {
        return await sendMatrixSessionMessage(req, res, agent.id, session.id, session.peer, text);
      }

      if (session.channel === 'google_meet') {
        return await sendGoogleMeetSessionMessage(req, res, agent.id, session, text);
      }

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

  router.post('/conversation/sessions/:id/transcript', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const direction = req.body?.direction;
      if (!isConversationMessageDirection(direction)) {
        return res.status(400).json({ error: 'direction must be inbound, outbound, or system' });
      }
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!text.trim()) return res.status(400).json({ error: 'text is required' });

      const message = sessions.recordTranscriptMessage({
        sessionId: req.params.id,
        agentId: agent.id,
        direction,
        text,
        externalMessageId: requestString(req.body?.externalMessageId) || undefined,
        metadata: requestRecord(req.body?.metadata),
      });
      const session = sessions.getSession(agent.id, req.params.id);
      return res.json({ success: true, session, message });
    } catch (err) {
      const msg = String((err as Error).message);
      const status = msg.includes('not found') ? 404
        : msg.includes('not active') || msg.includes('required') || msg.includes('direction') ? 400
          : 500;
      res.status(status).json({ error: (err as Error).message });
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
      metadata: buildLiveSessionMetadata(req, { transport: 'telegram' }),
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

  async function startMatrixSession(req: Request, res: Response, agentId: string): Promise<Response> {
    const cfg = matrixManager.getConfig(agentId);
    const roomId = requestString(req.body?.roomId ?? req.body?.peer);
    const initialMessage = typeof req.body?.initialMessage === 'string' ? req.body.initialMessage : '';
    const roomAllowed = !!cfg && roomId && cfg.allowedRoomIds.concat(cfg.operatorRoomId ? [cfg.operatorRoomId] : [])
      .some((id) => String(id).trim() === roomId);
    const plan = planRealtimeConversationStart({
      channel: 'matrix',
      transportConfigured: !!cfg?.enabled && !!cfg.accessToken,
      userOptedIn: roomAllowed,
    });
    if (!plan.ok) return res.status(400).json({ error: plan.reason, plan });
    if (!roomId) return res.status(400).json({ error: 'roomId is required' });

    const existing = sessions.findActiveSessionByPeer(agentId, 'matrix', roomId);
    const session = existing ?? sessions.createSession({
      agentId,
      channel: 'matrix',
      peer: roomId,
      subject: requestString(req.body?.subject) || undefined,
      goal: requestString(req.body?.goal) || undefined,
      metadata: buildLiveSessionMetadata(req, { transport: 'matrix', homeserverUrl: cfg!.homeserverUrl }),
    });
    if (!initialMessage.trim()) {
      return res.json({ success: true, session, reused: !!existing, plan });
    }
    return sendMatrixSessionMessage(req, res, agentId, session.id, roomId, initialMessage, { session, reused: !!existing, plan });
  }

  async function sendMatrixSessionMessage(
    _req: Request,
    res: Response,
    agentId: string,
    sessionId: string,
    roomId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const cfg = matrixManager.getConfig(agentId);
    if (!cfg?.enabled) {
      return res.status(400).json({ error: 'Matrix not configured or disabled. Use /matrix/setup first.' });
    }
    try {
      const result = await sendMatrixMessage(cfg, roomId, text);
      const matrixRecord = matrixManager.recordOutbound(agentId, {
        roomId,
        text,
        eventId: result.eventId,
        status: 'sent',
      }, {
        conversationSessionId: sessionId,
        txnId: result.txnId,
      });
      const message = sessions.recordMessage({
        sessionId,
        agentId,
        channel: 'matrix',
        direction: 'outbound',
        text,
        externalMessageId: result.eventId,
        metadata: { matrixEventId: result.eventId, txnId: result.txnId },
      });
      return res.json({ success: true, message, matrix: matrixRecord, ...extra });
    } catch (err) {
      const matrixRecord = matrixManager.recordOutbound(agentId, { roomId, text, status: 'failed' }, {
        conversationSessionId: sessionId,
        error: err instanceof MatrixApiError ? err.message : 'send failed',
      });
      return res.status(502).json({
        success: false,
        matrix: matrixRecord,
        error: err instanceof MatrixApiError ? err.message : 'Matrix send failed',
        ...extra,
      });
    }
  }

  async function sendGoogleMeetSessionMessage(
    req: Request,
    res: Response,
    agentId: string,
    session: ConversationSession,
    text: string,
  ): Promise<Response> {
    const cfg = googleMeetManager.getConfig(agentId);
    const readiness = getGoogleMeetReadiness(cfg);
    if (!cfg?.enabled || !readiness.canUseLiveMedia) {
      return res.status(400).json({
        error: 'Google Meet live media is not configured. Use /meet/setup with a live media sidecar first.',
        readiness,
      });
    }

    const action = requestString(req.body?.action) || 'say';
    const controlText = text.trim() ? text : undefined;
    const ledgerText = controlText || `Google Meet control: ${action}`;
    const sessionMetadata = requestRecord(session.metadata) ?? {};
    const controlMetadata = requestRecord(req.body?.metadata);
    try {
      const result = await sendGoogleMeetLiveSidecarControl(cfg, {
        sessionId: session.id,
        action,
        ...(controlText ? { text: controlText } : {}),
        meetingUri: requestString(sessionMetadata.meetLink) || session.peer,
        streamId: requestString(req.body?.streamId) || undefined,
        metadata: controlMetadata,
      });
      const control = requestRecord(result.control);
      const controlId = requestString(control?.id);
      const message = sessions.recordMessage({
        sessionId: session.id,
        agentId,
        channel: 'google_meet',
        direction: 'outbound',
        text: ledgerText,
        externalMessageId: controlId || undefined,
        metadata: {
          kind: 'google_meet_live_control',
          action,
          sidecarStatus: requestString(result.status) || undefined,
          queued: result.queued,
          controlId: controlId || undefined,
          streamId: requestString(req.body?.streamId) || requestString(control?.streamId) || undefined,
          metadata: controlMetadata,
        },
      });
      return res.json({ success: true, message, control: result });
    } catch (err) {
      const message = err instanceof GoogleMeetApiError ? err.message : 'Google Meet live control failed';
      return res.status(502).json({
        success: false,
        error: message,
        details: err instanceof GoogleMeetApiError ? err.details : undefined,
      });
    }
  }

  async function startPhoneSession(req: Request, res: Response, agentId: string): Promise<Response> {
    const phone = phoneManager.getPhoneTransportConfig(agentId);
    const policy = resolvePhoneMissionPolicy(req.body);
    const policyPreset = requestPhonePolicyPreset(req.body);
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
      policy: policy as any,
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
      metadata: buildLiveSessionMetadata(req, {
        transport: 'phone',
        missionId: result.mission.id,
        provider: result.mission.provider,
        dryRun: req.body?.dryRun === true,
        policyPreset,
      }),
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

  function startGoogleMeetSession(req: Request, res: Response, agentId: string): Response {
    const meetLink = requestString(req.body?.meetLink ?? req.body?.meetingUrl ?? req.body?.link ?? req.body?.peer);
    if (!meetLink) return res.status(400).json({ error: 'meetLink is required' });

    let parsed: ReturnType<typeof parseGoogleMeetLink>;
    try {
      parsed = parseGoogleMeetLink(meetLink);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const topic = requestString(req.body?.topic ?? req.body?.subject);
    const projectRef = requestString(req.body?.projectRef);
    const operatorInstructions = requestString(req.body?.operatorInstructions ?? req.body?.instructions);
    const behaviorMode = normalizeGoogleMeetBehaviorMode(
      req.body?.behaviorMode ?? requestRecord(req.body?.liveContext)?.behaviorMode,
    );
    const goal = requestString(req.body?.goal)
      || `Prepare for the meeting, listen, keep notes, and speak only according to behaviorMode=${behaviorMode}.`;
    const plan = planRealtimeConversationStart({
      channel: 'google_meet',
      transportConfigured: getGoogleMeetReadiness(googleMeetManager.getConfig(agentId)).canReadArtifacts,
      userOptedIn: req.body?.userOptedIn === true,
      operatorApproved: req.body?.operatorApproved === true,
    });
    const readiness = getGoogleMeetReadiness(googleMeetManager.getConfig(agentId));

    const existing = sessions.findActiveSessionByExternalRef(agentId, 'google_meet', parsed.meetingCode);
    const metadata = buildLiveSessionMetadata(req, {
      transport: 'google_meet',
      meetLink: parsed.normalizedUrl,
      meetingCode: parsed.meetingCode,
      originalMeetLink: parsed.source,
      adapterStatus: readiness.canReadArtifacts ? 'rest_ready' : 'setup_required',
      liveMediaReady: readiness.canUseLiveMedia,
      intakeStatus: 'briefing_ready',
      liveContext: {
        behaviorMode,
        projectRef,
        hostIntegration: requestString(req.body?.hostIntegration) || undefined,
      },
    });
    metadata.liveContext = {
      ...(requestRecord(metadata.liveContext) ?? {}),
      behaviorMode,
    };
    const session = existing ?? sessions.createSession({
      agentId,
      channel: 'google_meet',
      peer: parsed.normalizedUrl,
      subject: topic || requestString(req.body?.subject) || `Google Meet ${parsed.meetingCode}`,
      goal,
      externalRef: parsed.meetingCode,
      metadata,
    });

    const briefingText = buildGoogleMeetSessionBriefing({
      meetingUrl: parsed.normalizedUrl,
      meetingCode: parsed.meetingCode,
      topic: topic || undefined,
      projectRef: projectRef || undefined,
      goal,
      operatorInstructions: operatorInstructions || undefined,
      behaviorMode,
    });
    const message = sessions.recordMessage({
      sessionId: session.id,
      agentId,
      channel: 'google_meet',
      direction: 'system',
      text: briefingText,
      metadata: {
        kind: 'google_meet_intake_briefing',
        meetingCode: parsed.meetingCode,
        liveMediaReady: readiness.canUseLiveMedia,
        behaviorMode,
      },
    });

    return res.json({
      success: true,
      session,
      reused: !!existing,
      message,
      meet: {
        meetingCode: parsed.meetingCode,
        normalizedUrl: parsed.normalizedUrl,
        behaviorMode,
        liveMediaReady: readiness.canUseLiveMedia,
        readyForLiveJoin: false,
      },
      readiness,
      plan,
    });
  }

  return router;
}
