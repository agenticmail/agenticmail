import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  ConversationSessionManager,
  isConversationMessageDirection,
  GoogleMeetApiError,
  GoogleMeetManager,
  buildGoogleMeetConfig,
  createGoogleMeetSpace,
  getGoogleMeetReadiness,
  getGoogleMeetSpace,
  listGoogleMeetConferenceRecords,
  listGoogleMeetTranscriptEntries,
  listGoogleMeetTranscripts,
  redactGoogleMeetConfig,
  startGoogleMeetLiveSidecar,
  type AgenticMailConfig,
  type ConversationMessageDirection,
  type GoogleMeetTranscriptEntry,
} from '@agenticmail/core';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function requestRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function sidecarTokenHeader(req: Request): string {
  return requestString(req.headers['x-agenticmail-meet-sidecar-token']);
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requestOrigin(req: Request): string {
  const proto = requestString(req.headers['x-forwarded-proto']).split(',')[0] || req.protocol || 'http';
  const host = requestString(req.headers['x-forwarded-host']).split(',')[0] || req.get('host') || '127.0.0.1';
  return `${proto}://${host}`;
}

function replaceOriginalUrlSuffix(req: Request, from: string, to: string): string {
  const original = req.originalUrl || req.url || from;
  return original.endsWith(from)
    ? `${original.slice(0, -from.length)}${to}`
    : to;
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function meetError(res: Response, err: unknown): void {
  if (err instanceof GoogleMeetApiError) {
    res.status(err.status && err.status >= 400 ? 502 : 500).json({
      error: err.message,
      googleStatus: err.status,
      details: err.details,
    });
    return;
  }
  const msg = (err as Error)?.message ?? String(err);
  const status = msg.includes('required') || msg.includes('must ') ? 400 : 500;
  res.status(status).json({ error: msg });
}

function normalizeTranscriptEntry(value: unknown): GoogleMeetTranscriptEntry | null {
  const row = requestRecord(value);
  if (!row) return null;
  const name = requestString(row.name);
  const text = requestString(row.text);
  if (!text) return null;
  return {
    name: name || `manual:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    participant: requestString(row.participant) || undefined,
    text,
    languageCode: requestString(row.languageCode) || undefined,
    startTime: requestString(row.startTime) || undefined,
    endTime: requestString(row.endTime) || undefined,
  };
}

function findSessionOwner(db: Db, sessionId: string): { agentId: string } | null {
  const row = (db as any).prepare(
    'SELECT agent_id FROM conversation_sessions WHERE id = ? LIMIT 1',
  ).get(sessionId) as { agent_id?: string } | undefined;
  return row?.agent_id ? { agentId: row.agent_id } : null;
}

function getEventAgent(
  req: Request,
  res: Response,
  db: Db,
  meetManager: GoogleMeetManager,
  sessionId: string,
): { id: string; email?: string } | null {
  const existingAgent = (req as any).agent;
  if (existingAgent?.id) return existingAgent;
  const token = sidecarTokenHeader(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const owner = findSessionOwner(db, sessionId);
  if (!owner) {
    res.status(404).json({ error: 'conversation session not found' });
    return null;
  }
  const cfg = meetManager.getConfig(owner.agentId);
  if (!cfg?.mediaSidecarToken || !safeEquals(token, cfg.mediaSidecarToken)) {
    res.status(401).json({ error: 'invalid Meet sidecar token' });
    return null;
  }
  return { id: owner.agentId };
}

function normalizeMeetLiveEvent(value: unknown): {
  type: string;
  direction: ConversationMessageDirection;
  text: string;
  externalMessageId?: string;
  metadata: Record<string, unknown>;
  final: boolean;
} | null {
  const row = requestRecord(value);
  if (!row) return null;
  const type = requestString(row.type || row.kind || row.eventType) || 'status';
  const final = row.final === true || row.isFinal === true || type.endsWith('.final');
  const speaker = requestString(row.speaker || row.participant || row.participantName);
  const status = requestString(row.status);
  const explicitDirection = requestString(row.direction);
  const direction: ConversationMessageDirection = isConversationMessageDirection(explicitDirection)
    ? explicitDirection
    : type.startsWith('transcript.')
      ? 'inbound'
      : 'system';
  const text = requestString(row.text || row.message || row.note || row.summary)
    || (status ? `Google Meet live status: ${status}` : '')
    || (type === 'participant_joined' && speaker ? `${speaker} joined the Google Meet.` : '')
    || (type === 'participant_left' && speaker ? `${speaker} left the Google Meet.` : '');
  if (!text) return null;
  const eventId = requestString(row.eventId || row.id || row.externalMessageId);
  return {
    type,
    direction,
    text,
    externalMessageId: eventId || undefined,
    final,
    metadata: {
      kind: 'google_meet_live_event',
      eventType: type,
      speaker: speaker || undefined,
      participant: requestString(row.participant) || speaker || undefined,
      participantId: requestString(row.participantId) || undefined,
      streamId: requestString(row.streamId) || undefined,
      languageCode: requestString(row.languageCode) || undefined,
      startTime: requestString(row.startTime) || undefined,
      endTime: requestString(row.endTime) || undefined,
      status: status || undefined,
      final,
      payload: requestRecord(row.payload),
    },
  };
}

export function createGoogleMeetRoutes(
  db: Db,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const meetManager = new GoogleMeetManager(db as any, config.masterKey);
  const conversations = new ConversationSessionManager(db as any);

  router.get('/meet/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      res.json({
        configured: !!cfg,
        googleMeet: cfg ? redactGoogleMeetConfig(cfg) : null,
        readiness: getGoogleMeetReadiness(cfg),
      });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.get('/meet/readiness', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      res.json({ readiness: getGoogleMeetReadiness(cfg) });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/setup', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const existing = meetManager.getConfig(agent.id);
      const cfg = buildGoogleMeetConfig({
        enabled: req.body?.enabled,
        accessToken: requestString(req.body?.accessToken) || existing?.accessToken,
        workspaceDomain: requestString(req.body?.workspaceDomain) || existing?.workspaceDomain,
        participantName: requestString(req.body?.participantName) || existing?.participantName,
        allowedDomains: req.body?.allowedDomains !== undefined
          ? requestStringList(req.body.allowedDomains)
          : existing?.allowedDomains,
        defaultBehaviorMode: requestString(req.body?.defaultBehaviorMode) || existing?.defaultBehaviorMode,
        mediaApiDeveloperPreview: req.body?.mediaApiDeveloperPreview ?? existing?.mediaApiDeveloperPreview,
        mediaSidecarUrl: requestString(req.body?.mediaSidecarUrl) || existing?.mediaSidecarUrl,
        mediaSidecarToken: requestString(req.body?.mediaSidecarToken) || existing?.mediaSidecarToken,
        consentPolicyAccepted: req.body?.consentPolicyAccepted ?? existing?.consentPolicyAccepted,
        configuredAt: existing?.configuredAt,
      });
      const verifySpace = requestString(req.body?.verifySpace ?? req.body?.meetingCode);
      const verified = req.body?.verify === false || !verifySpace
        ? null
        : await getGoogleMeetSpace(cfg, verifySpace);
      meetManager.saveConfig(agent.id, cfg);
      res.json({
        success: true,
        googleMeet: redactGoogleMeetConfig(cfg),
        readiness: getGoogleMeetReadiness(cfg),
        verifiedSpace: verified,
      });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/disable', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      if (!cfg) return res.json({ success: true, message: 'Google Meet was not configured' });
      cfg.enabled = false;
      meetManager.saveConfig(agent.id, cfg);
      res.json({ success: true, message: 'Google Meet channel disabled', readiness: getGoogleMeetReadiness(cfg) });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/spaces/create', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      const readiness = getGoogleMeetReadiness(cfg);
      if (!cfg?.enabled || !readiness.canCreateSpaces) {
        return res.status(400).json({ error: 'Google Meet space creation is not configured', readiness });
      }
      const space = await createGoogleMeetSpace(cfg, {
        accessType: requestString(req.body?.accessType) || undefined,
        entryPointAccess: requestString(req.body?.entryPointAccess) || undefined,
        artifactConfig: requestRecord(req.body?.artifactConfig),
      });
      res.json({ success: true, space });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.get('/meet/spaces/:spaceOrCode', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      const readiness = getGoogleMeetReadiness(cfg);
      if (!cfg?.enabled || !readiness.canReadArtifacts) {
        return res.status(400).json({ error: 'Google Meet read access is not configured', readiness });
      }
      const space = await getGoogleMeetSpace(cfg, req.params.spaceOrCode);
      res.json({ space });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.get('/meet/conference-records', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      const readiness = getGoogleMeetReadiness(cfg);
      if (!cfg?.enabled || !readiness.canReadArtifacts) {
        return res.status(400).json({ error: 'Google Meet artifact access is not configured', readiness });
      }
      const result = await listGoogleMeetConferenceRecords(cfg, {
        space: requestString(req.query.space) || undefined,
        pageSize: Number(req.query.pageSize) || undefined,
        pageToken: requestString(req.query.pageToken) || undefined,
      });
      res.json(result);
    } catch (err) {
      meetError(res, err);
    }
  });

  router.get('/meet/transcripts', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = meetManager.getConfig(agent.id);
      const readiness = getGoogleMeetReadiness(cfg);
      if (!cfg?.enabled || !readiness.canReadArtifacts) {
        return res.status(400).json({ error: 'Google Meet artifact access is not configured', readiness });
      }
      const conferenceRecord = requestString(req.query.conferenceRecord);
      if (!conferenceRecord) return res.status(400).json({ error: 'conferenceRecord is required' });
      const result = await listGoogleMeetTranscripts(cfg, conferenceRecord, {
        pageSize: Number(req.query.pageSize) || undefined,
        pageToken: requestString(req.query.pageToken) || undefined,
      });
      res.json(result);
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/artifacts/import', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const sessionId = requestString(req.body?.sessionId);
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const session = conversations.getSession(agent.id, sessionId);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      if (session.channel !== 'google_meet') {
        return res.status(400).json({ error: 'session is not a Google Meet conversation' });
      }

      let entries = Array.isArray(req.body?.entries)
        ? req.body.entries.map(normalizeTranscriptEntry).filter(Boolean) as GoogleMeetTranscriptEntry[]
        : [];
      const transcript = requestString(req.body?.transcript);
      let nextPageToken: string | undefined;
      if (entries.length === 0 && transcript) {
        const cfg = meetManager.getConfig(agent.id);
        const readiness = getGoogleMeetReadiness(cfg);
        if (!cfg?.enabled || !readiness.canReadArtifacts) {
          return res.status(400).json({ error: 'Google Meet artifact access is not configured', readiness });
        }
        const result = await listGoogleMeetTranscriptEntries(cfg, transcript, {
          pageSize: Number(req.body?.pageSize) || undefined,
          pageToken: requestString(req.body?.pageToken) || undefined,
        });
        entries = result.transcriptEntries ?? [];
        nextPageToken = result.nextPageToken;
      }
      if (entries.length === 0) {
        return res.status(400).json({ error: 'entries or transcript is required' });
      }

      const existingExternalIds = new Set(
        conversations.listMessages(agent.id, sessionId)
          .map((message) => message.externalMessageId)
          .filter(Boolean),
      );
      const imported = [];
      let skipped = 0;
      for (const entry of entries) {
        if (entry.name && existingExternalIds.has(entry.name)) {
          skipped++;
          continue;
        }
        const message = conversations.recordTranscriptMessage({
          sessionId,
          agentId: agent.id,
          direction: 'inbound',
          text: entry.text,
          externalMessageId: entry.name,
          metadata: {
            kind: 'google_meet_transcript_entry',
            participant: entry.participant,
            languageCode: entry.languageCode,
            startTime: entry.startTime,
            endTime: entry.endTime,
            source: transcript ? 'google_meet_api' : 'provided_entries',
          },
        });
        existingExternalIds.add(entry.name);
        imported.push(message);
      }
      res.json({ success: true, imported, importedCount: imported.length, skipped, nextPageToken });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/live/join', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const sessionId = requestString(req.body?.sessionId);
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const session = conversations.getSession(agent.id, sessionId);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      if (session.channel !== 'google_meet') {
        return res.status(400).json({ error: 'session is not a Google Meet conversation' });
      }
      const cfg = meetManager.getConfig(agent.id);
      const readiness = getGoogleMeetReadiness(cfg);
      if (!cfg?.enabled || !readiness.canUseLiveMedia) {
        return res.status(400).json({ error: 'Google Meet live media is not configured', readiness });
      }
      const metadata = session.metadata || {};
      const liveContext = requestRecord(metadata.liveContext) ?? {};
      const meetingUri = requestString(req.body?.meetingUri) || requestString(metadata.meetLink) || session.peer;
      const result = await startGoogleMeetLiveSidecar(cfg, {
        sessionId: session.id,
        meetingUri,
        meetingCode: requestString(req.body?.meetingCode) || requestString(metadata.meetingCode) || session.externalRef,
        participantName: requestString(req.body?.participantName) || cfg.participantName,
        behaviorMode: requestString(req.body?.behaviorMode) || requestString(liveContext.behaviorMode) || cfg.defaultBehaviorMode,
        topic: requestString(req.body?.topic) || session.subject,
        goal: requestString(req.body?.goal) || session.goal,
        eventCallbackUrl: `${requestOrigin(req)}${replaceOriginalUrlSuffix(req, '/meet/live/join', '/meet/live/events')}`,
        eventCallbackToken: cfg.mediaSidecarToken,
        liveContext,
      });
      const message = conversations.recordTranscriptMessage({
        sessionId: session.id,
        agentId: agent.id,
        direction: 'system',
        text: `Google Meet live media join requested for ${meetingUri}.`,
        metadata: {
          kind: 'google_meet_live_join',
          sidecarStatus: result.status,
          participantId: result.participantId,
          streamId: result.streamId,
        },
      });
      res.json({ success: true, result, message });
    } catch (err) {
      meetError(res, err);
    }
  });

  router.post('/meet/live/events', (req: Request, res: Response) => {
    try {
      const sessionId = requestString(req.body?.sessionId);
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const agent = getEventAgent(req, res, db, meetManager, sessionId);
      if (!agent) return;
      const session = conversations.getSession(agent.id, sessionId);
      if (!session) return res.status(404).json({ error: 'conversation session not found' });
      if (session.channel !== 'google_meet') {
        return res.status(400).json({ error: 'session is not a Google Meet conversation' });
      }

      const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body];
      const recordPartial = requestBoolean(req.body?.recordPartial);
      const existingExternalIds = new Set(
        conversations.listMessages(agent.id, sessionId)
          .map((message) => message.externalMessageId)
          .filter(Boolean),
      );
      const recorded = [];
      let skipped = 0;
      for (const raw of rawEvents) {
        const event = normalizeMeetLiveEvent(raw);
        if (!event) {
          skipped++;
          continue;
        }
        if (event.type === 'transcript.partial' && !recordPartial) {
          skipped++;
          continue;
        }
        if (event.externalMessageId && existingExternalIds.has(event.externalMessageId)) {
          skipped++;
          continue;
        }
        const message = conversations.recordTranscriptMessage({
          sessionId,
          agentId: agent.id,
          direction: event.direction,
          text: event.text,
          externalMessageId: event.externalMessageId,
          metadata: event.metadata,
        });
        if (event.externalMessageId) existingExternalIds.add(event.externalMessageId);
        recorded.push(message);
      }

      const terminalStatus = requestString(req.body?.status);
      let ended = null;
      if (terminalStatus === 'ended' || terminalStatus === 'left') {
        ended = conversations.endSession(agent.id, sessionId, 'ended');
      } else if (terminalStatus === 'failed') {
        ended = conversations.endSession(agent.id, sessionId, 'failed');
      }

      res.json({ success: true, recorded, recordedCount: recorded.length, skipped, session: ended });
    } catch (err) {
      meetError(res, err);
    }
  });

  return router;
}
