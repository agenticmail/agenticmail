import { Router, type Request, type Response } from 'express';
import {
  PhoneManager,
  PhoneWebhookAuthError,
  PhoneRateLimitError,
  buildPhoneTransportConfig,
  redactPhoneTransportConfig,
  type AgenticMailConfig,
  type PhoneMissionState,
} from '@agenticmail/core';

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the per-mission webhook token (#43-H7). 46elks calls our webhook
 * URL back with `?token=<HMAC>`; a header form is also accepted for
 * manual testing / a future provider that can set headers.
 */
function readWebhookToken(req: Request): string {
  return requestString(req.query.token)
    || requestString(req.get('x-agenticmail-webhook-token'))
    || requestString(req.get('x-46elks-token'))
    || requestString((req.body as Record<string, unknown> | undefined)?.token);
}

function readMissionId(req: Request): string {
  return requestString(req.query.missionId)
    || requestString(req.query.mission)
    || requestString((req.body as Record<string, unknown> | undefined)?.missionId)
    || requestString((req.body as Record<string, unknown> | undefined)?.mission);
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function isPhoneWebhookAuthError(err: unknown): boolean {
  return err instanceof PhoneWebhookAuthError || (err as { isPhoneWebhookAuthError?: boolean })?.isPhoneWebhookAuthError === true;
}

function isPhoneRateLimitError(err: unknown): boolean {
  return err instanceof PhoneRateLimitError || (err as { isPhoneRateLimitError?: boolean })?.isPhoneRateLimitError === true;
}

function errorStatus(err: unknown): number {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes('not found')) return 404;
  // Client input-validation errors → 400. buildPhoneTransportConfig and
  // the mission validators phrase every input error with one of these.
  if (msg.includes('Invalid') || msg.includes('required') || msg.includes('not configured')
      || msg.includes('must use') || msg.includes('must be') || msg.includes('must contain')) {
    return 400;
  }
  return 500;
}

/**
 * Centralised phone error responder. Typed errors are mapped to fixed
 * statuses BEFORE any message-substring heuristic runs:
 *   - PhoneWebhookAuthError -> a uniform 403 + generic body. No 404-vs-403
 *     branch on mission existence, so no enumeration oracle (#43-H3).
 *   - PhoneRateLimitError   -> 429 (the message is operator-safe).
 */
function sendPhoneError(res: Response, err: unknown): void {
  if (isPhoneWebhookAuthError(err)) {
    res.status(403).json({ error: 'Invalid phone webhook request' });
    return;
  }
  if (isPhoneRateLimitError(err)) {
    res.status(429).json({ error: (err as Error).message });
    return;
  }
  res.status(errorStatus(err)).json({ error: (err as Error).message });
}

export function createPhoneWebhookRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  // Webhook routes are mounted before bearer auth (the provider must
  // reach them). A missing/unknown missionId or a bad token all funnel
  // into a single uniform 403 via PhoneWebhookAuthError — no early
  // missionId branch, so there is no 404-vs-403 enumeration oracle.
  router.post('/calls/webhook/46elks/voice-start', (req: Request, res: Response) => {
    try {
      const result = phoneManager.handleVoiceStartWebhook(
        readMissionId(req), readWebhookToken(req), req.body ?? {},
      );
      res.json(result.action);
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/webhook/46elks/hangup', (req: Request, res: Response) => {
    try {
      const mission = phoneManager.handleHangupWebhook(
        readMissionId(req), readWebhookToken(req), req.body ?? {},
      );
      res.json({ success: true, mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  return router;
}

export function createPhoneRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);

  router.get('/phone/transport/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        transport: cfg ? redactPhoneTransportConfig(cfg) : null,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/phone/transport/setup', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = buildPhoneTransportConfig(req.body ?? {});
      phoneManager.savePhoneTransportConfig(agent.id, cfg);
      res.json({
        success: true,
        transport: redactPhoneTransportConfig(cfg),
        nextSteps: [
          'Phone transport is configured for call_control.',
          'Calls can now be started with /calls/start or the phone tool surface.',
          'Realtime conversation is not connected in this slice; started calls remain mission-tracked call-control events.',
        ],
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/phone/capabilities', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        provider: cfg?.provider ?? null,
        phoneNumber: cfg?.phoneNumber ?? null,
        capabilities: cfg?.capabilities ?? [],
        supportedRegions: cfg?.supportedRegions ?? [],
        realtimeReady: !!cfg?.capabilities.includes('realtime_media'),
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/start', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const result = await phoneManager.startMission(agent.id, {
        to: req.body?.to,
        task: req.body?.task,
        policy: req.body?.policy,
        voiceRuntimeRef: req.body?.voiceRuntimeRef,
      }, {
        dryRun: req.body?.dryRun === true,
      });

      res.json({
        success: true,
        mission: result.mission,
        providerRequest: result.providerRequest
          ? { ...result.providerRequest, body: { ...result.providerRequest.body, voice_start: '[redacted-url]', whenhangup: '[redacted-url]' } }
          : undefined,
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const status = requestString(req.query.status) as PhoneMissionState;
      const missions = phoneManager.listMissions(agent.id, { limit, offset, status });
      res.json({ missions, count: missions.length });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls/:id', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({ mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls/:id/transcript', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({ missionId: mission.id, transcript: mission.transcript });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  // ─── Operator-query endpoints (ask_operator, plan §5) ───────────
  //
  // Channel-agnostic: the bridge's `ask_operator` tool records a query
  // on the mission and polls it; ANY channel can answer it through the
  // POST endpoint below. The agenticmail product ships the email
  // notifier + this HTTP surface; a host (e.g. Fola's Telegram bridge)
  // can watch the GET endpoint and POST the operator's reply here.
  // Both endpoints are agent-key scoped — an agent only ever sees and
  // answers its own missions' queries.

  router.get('/calls/:id/operator-queries', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({
        missionId: mission.id,
        operatorQueries: phoneManager.listOperatorQueries(mission.id, agent.id),
        callbackPending: mission.metadata.callbackPending === true,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/:id/operator-queries/:queryId/answer', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const answer = requestString(req.body?.answer);
      if (!answer) return res.status(400).json({ error: 'answer is required' });

      const result = phoneManager.answerOperatorQuery(
        req.params.id, req.params.queryId, answer, { via: 'api', agentId: agent.id },
      );
      if (!result) return res.status(404).json({ error: 'Operator query not found' });

      // The answer may unblock a callback-on-disconnect (plan §7). This
      // is best-effort: a failed callback dial (e.g. a rate limit) must
      // not fail the answer submission itself — the answer is recorded.
      let callback: { triggered: boolean; missionId?: string; error?: string } = { triggered: false };
      try {
        const fired = await phoneManager.triggerCallback(req.params.id);
        if (fired) callback = { triggered: true, missionId: fired.callbackMission.id };
      } catch (err) {
        callback = { triggered: false, error: (err as Error)?.message ?? String(err) };
      }

      res.json({
        success: true,
        alreadyAnswered: result.alreadyAnswered,
        query: result.query,
        callback,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/:id/cancel', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.cancelMission(agent.id, req.params.id);
      res.json({ success: true, mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  return router;
}
