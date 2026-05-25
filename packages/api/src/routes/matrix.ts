import { Router, type Request, type Response } from 'express';
import {
  ConversationSessionManager,
  MatrixApiError,
  MatrixManager,
  buildMatrixConfig,
  getMatrixSync,
  getMatrixWhoami,
  isMatrixRoomAllowed,
  parseMatrixSyncMessages,
  recordMatrixConversationInbound,
  redactMatrixConfig,
  sendMatrixMessage,
  type AgenticMailConfig,
  type GatewayManager,
  type MatrixConversationContext,
} from '@agenticmail/core';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function matrixError(res: Response, err: unknown): void {
  if (err instanceof MatrixApiError) {
    res.status(err.status && err.status >= 400 ? 502 : 500).json({
      error: err.message,
      matrixStatus: err.status,
      errcode: err.errcode,
    });
    return;
  }
  const msg = (err as Error)?.message ?? String(err);
  const status = msg.includes('required') || msg.includes('must ') ? 400 : 500;
  res.status(status).json({ error: msg });
}

function linkedRooms(config: ReturnType<MatrixManager['getConfig']>): string[] {
  if (!config) return [];
  return [...new Set([
    ...config.allowedRoomIds,
    ...(config.operatorRoomId ? [config.operatorRoomId] : []),
  ])];
}

export function createMatrixRoutes(
  db: Db,
  config: AgenticMailConfig,
  gatewayManager?: GatewayManager,
): Router {
  const router = Router();
  const matrixManager = new MatrixManager(db as any, config.masterKey);
  const conversations = new ConversationSessionManager(db as any);

  router.get('/matrix/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = matrixManager.getConfig(agent.id);
      res.json({ configured: !!cfg, matrix: cfg ? redactMatrixConfig(cfg) : null });
    } catch (err) {
      matrixError(res, err);
    }
  });

  router.post('/matrix/setup', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const existing = matrixManager.getConfig(agent.id);
      const merged = {
        homeserverUrl: requestString(req.body?.homeserverUrl) || existing?.homeserverUrl,
        accessToken: requestString(req.body?.accessToken) || existing?.accessToken,
        userId: requestString(req.body?.userId) || existing?.userId,
        deviceId: requestString(req.body?.deviceId) || existing?.deviceId,
        allowedRoomIds: req.body?.allowedRoomIds !== undefined
          ? requestStringList(req.body.allowedRoomIds)
          : existing?.allowedRoomIds,
        operatorRoomId: requestString(req.body?.operatorRoomId) || existing?.operatorRoomId,
        syncToken: requestString(req.body?.syncToken) || existing?.syncToken,
        enabled: req.body?.enabled,
      };
      let cfg = buildMatrixConfig(merged);
      if (req.body?.verify !== false) {
        const whoami = await getMatrixWhoami(cfg);
        cfg = { ...cfg, userId: whoami.userId, deviceId: whoami.deviceId ?? cfg.deviceId };
      }
      matrixManager.saveConfig(agent.id, cfg);
      res.json({
        success: true,
        matrix: redactMatrixConfig(cfg),
        nextSteps: [
          linkedRooms(cfg).length > 0
            ? `${linkedRooms(cfg).length} Matrix room(s) linked.`
            : 'No Matrix rooms are linked yet — add allowedRoomIds before inbound messages are accepted.',
          'Use conversation_start with channel "matrix" to start a Matrix-backed live text session.',
          'Call /matrix/poll on a schedule to ingest inbound room messages.',
        ],
      });
    } catch (err) {
      matrixError(res, err);
    }
  });

  router.post('/matrix/disable', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = matrixManager.getConfig(agent.id);
      if (!cfg) return res.json({ success: true, message: 'Matrix was not configured' });
      cfg.enabled = false;
      matrixManager.saveConfig(agent.id, cfg);
      res.json({ success: true, message: 'Matrix channel disabled' });
    } catch (err) {
      matrixError(res, err);
    }
  });

  router.get('/matrix/messages', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const rawDir = requestString(req.query.direction);
      const direction = rawDir === 'inbound' || rawDir === 'outbound' ? rawDir : undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const roomId = requestString(req.query.roomId) || undefined;
      const messages = matrixManager.listMessages(agent.id, { direction, roomId, limit, offset });
      res.json({ messages, count: messages.length });
    } catch (err) {
      matrixError(res, err);
    }
  });

  router.post('/matrix/send', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = matrixManager.getConfig(agent.id);
      if (!cfg?.enabled) return res.status(400).json({ error: 'Matrix not configured or disabled. Use /matrix/setup first.' });
      const roomId = requestString(req.body?.roomId);
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!roomId) return res.status(400).json({ error: 'roomId is required' });
      if (!isMatrixRoomAllowed(cfg, roomId)) return res.status(403).json({ error: 'Matrix room is not allowed for this agent' });
      if (!text.trim()) return res.status(400).json({ error: 'text is required' });
      try {
        const sent = await sendMatrixMessage(cfg, roomId, text);
        const message = matrixManager.recordOutbound(agent.id, {
          roomId,
          text,
          eventId: sent.eventId,
          status: 'sent',
        }, { txnId: sent.txnId });
        res.json({ success: true, message, eventId: sent.eventId, txnId: sent.txnId });
      } catch (err) {
        const message = matrixManager.recordOutbound(agent.id, { roomId, text, status: 'failed' }, {
          error: err instanceof MatrixApiError ? err.message : 'send failed',
        });
        res.status(502).json({ success: false, message, error: (err as Error).message });
      }
    } catch (err) {
      matrixError(res, err);
    }
  });

  router.post('/matrix/poll', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = matrixManager.getConfig(agent.id);
      if (!cfg?.enabled) return res.status(400).json({ error: 'Matrix not configured or disabled. Use /matrix/setup first.' });
      const sync = await getMatrixSync(cfg, {
        since: req.body?.since === null ? undefined : (requestString(req.body?.since) || cfg.syncToken),
        timeoutMs: Math.min(Math.max(Number(req.body?.timeoutMs) || 0, 0), 30_000),
      });
      const parsed = parseMatrixSyncMessages(sync, {
        ownUserId: cfg.userId,
        allowedRoomIds: linkedRooms(cfg),
      });
      let recorded = 0;
      let mirrored = 0;
      const pendingBridges: Array<{ event: (typeof parsed)[number]; conversation?: MatrixConversationContext | null }> = [];
      for (const event of parsed) {
        if (matrixManager.inboundMessageExists(agent.id, event.roomId, event.eventId)) continue;
        matrixManager.recordInbound(agent.id, {
          roomId: event.roomId,
          eventId: event.eventId,
          sender: event.sender,
          text: event.text,
          createdAt: event.createdAt,
        }, event.metadata);
        recorded++;
        const conversation = recordMatrixConversationInbound(conversations, agent.id, event);
        if (conversation) mirrored++;
        if (gatewayManager) pendingBridges.push({ event, conversation });
      }
      const nextBatch = typeof sync.next_batch === 'string' ? sync.next_batch : undefined;
      if (nextBatch) matrixManager.updateSyncToken(agent.id, nextBatch);
      for (const bridge of pendingBridges) {
        try {
          await gatewayManager!.bridgeMatrixInbound(agent.id, bridge.event, cfg, bridge.conversation);
        } catch (err) {
          console.warn(`[matrix-poll] wake bridge failed: ${(err as Error).message}`);
        }
      }
      res.json({ success: true, fetched: parsed.length, recorded, mirrored, nextBatch });
    } catch (err) {
      matrixError(res, err);
    }
  });

  return router;
}
