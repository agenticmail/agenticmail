/**
 * Realtime voice WebSocket endpoint.
 *
 * This is the live-conversation half of the phone feature. A phone
 * carrier streams a call's audio to a WebSocket, which this module
 * accepts, matches to the phone mission that placed the call, loads
 * that agent's persistent memory, opens an OpenAI Realtime
 * (`gpt-realtime`) session with the memory folded into its
 * instructions, and runs a {@link RealtimeVoiceBridge} between the two.
 *
 * Two carriers are supported, on two paths:
 *
 *   - 46elks ({@link ELKS_REALTIME_WS_PATH}) — 46elks opens a socket to
 *     a "websocket number" whose `websocket_url` points here. The
 *     mission is resolved from the `hello` frame's `callid`; the static
 *     `?token=` on the URL is verified against the mission agent's
 *     webhook secret. Audio is linear PCM @ 24 kHz.
 *
 *   - Twilio ({@link TWILIO_REALTIME_WS_PATH}) — a Twilio
 *     `<Connect><Stream>` opens a Media Streams socket here. The
 *     mission id + per-mission token ride on the connection URL query
 *     string (placed there by the TwiML the phone webhook returned), so
 *     the mission is resolved + authenticated UP FRONT, before Twilio's
 *     `start` frame even arrives. Audio is G.711 µ-law @ 8 kHz —
 *     OpenAI's GA Realtime API speaks µ-law natively, so the bridge
 *     does NO transcoding for a Twilio call.
 *
 * Everything protocol-level lives in `@agenticmail/core` — the
 * provider-pluggable `RealtimeVoiceBridge` plus its per-carrier
 * {@link RealtimeTransportAdapter} (transport-agnostic, unit-tested).
 * This file is the thin `ws` plumbing: upgrade handling, mission
 * resolution, token auth, OpenAI socket creation, transcript
 * persistence.
 *
 * Testing boundary: the end-to-end path needs a live `OPENAI_API_KEY`
 * and a provisioned carrier number, so it cannot be exercised in CI.
 * The bridge logic it depends on IS covered by unit tests
 * (packages/core realtime-bridge tests). The glue here is deliberately
 * minimal so it is correct by inspection.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PhoneManager,
  ConversationSessionManager,
  AgentMemoryManager,
  MailSender,
  RealtimeVoiceBridge,
  buildRealtimeSessionConfig,
  resolveVoiceRuntime,
  DEFAULT_REALTIME_MODEL,
  parseElksRealtimeMessage,
  createRealtimeTransport,
  ELKS_REALTIME_WS_PATH,
  TWILIO_REALTIME_WS_PATH,
  createToolExecutor,
  getDatetime,
  recallMemory,
  webSearch,
  pollForOperatorAnswer,
  operatorQuerySubject,
  TelegramManager,
  sendTelegramMessage,
  formatOperatorQueryTelegramMessage,
  OPERATOR_QUERY_TIMEOUT_SENTINEL,
  ASK_OPERATOR_TOOL,
  WEB_SEARCH_TOOL,
  RECALL_MEMORY_TOOL,
  GET_DATETIME_TOOL,
  SEARCH_SKILLS_TOOL,
  LOAD_SKILL_TOOL,
  GET_CALL_STATUS_TOOL,
  EXTEND_CALL_TIME_TOOL,
  SCHEDULE_CALLBACK_TOOL,
  END_CALL_TOOL,
  resolveExtensionPolicy,
  resolveCallbackPolicy,
  PHONE_SERVER_MAX_CALL_DURATION_SECONDS,
  loadAgentPersona,
  readAgentPersonaFile,
  type AgenticMailConfig,
  type RealtimeBridgePort,
  type RealtimeToolDefinition,
  type RealtimeToolHandler,
  type RealtimeTransportAdapter,
  type RealtimeTransportProvider,
  type ToolExecutor,
  type PhoneCallMission,
  type PhoneMissionTranscriptEntry,
} from '@agenticmail/core';
import { notifyCallEnded } from './notifications/end-of-call.js';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

/**
 * Path the 46elks websocket number's `websocket_url` should point at.
 * Re-exported from core so the API entry point keeps importing it from
 * here unchanged.
 */
export const REALTIME_WS_PATH = ELKS_REALTIME_WS_PATH;
export { ELKS_REALTIME_WS_PATH, TWILIO_REALTIME_WS_PATH } from '@agenticmail/core';

/** A carrier connection that never sends its first frame is dropped after this. */
const HELLO_TIMEOUT_MS = 15_000;
/** OpenAI socket must open within this window or the call is failed. */
const OPENAI_CONNECT_TIMEOUT_MS = 15_000;

export function mirrorPhoneTranscriptEntryToConversation(
  conversationManager: ConversationSessionManager,
  mission: Pick<PhoneCallMission, 'id' | 'agentId'>,
  entry: PhoneMissionTranscriptEntry,
  conversationSessionId?: string | null,
): string | null {
  const sessionId = conversationSessionId ?? conversationManager
    .findActiveSessionByExternalRef(mission.agentId, 'phone', mission.id)?.id ?? null;
  if (!sessionId) return null;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return sessionId;

  conversationManager.recordMessage({
    sessionId,
    agentId: mission.agentId,
    channel: 'phone',
    direction: entry.source === 'agent' ? 'outbound' : entry.source === 'provider' ? 'inbound' : 'system',
    text,
    metadata: {
      missionId: mission.id,
      source: entry.source,
      at: entry.at,
      ...(entry.metadata ?? {}),
    },
  });
  return sessionId;
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface RealtimeVoiceServer {
  /**
   * Try to handle an HTTP upgrade as a realtime-voice WebSocket.
   * Returns true if the request path matched a carrier endpoint and was
   * handled (the socket is now owned by this server); false if it
   * should be left for another handler.
   */
  tryHandleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Close the WebSocket server and every active bridge. */
  close(): void;
}

/**
 * Build the realtime voice WebSocket server. Mounted on the HTTP
 * server's `upgrade` event by the API entry point. Serves both the
 * 46elks and the Twilio Media Streams carrier paths.
 */
export function createRealtimeVoiceServer(db: Db, config: AgenticMailConfig): RealtimeVoiceServer {
  const wss = new WebSocketServer({ noServer: true });
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const memory = new AgentMemoryManager(db as any);

  wss.on('connection', (carrierWs: WebSocket, req: IncomingMessage) => {
    const path = (req.url ?? '').split('?')[0];
    const provider: RealtimeTransportProvider = path === TWILIO_REALTIME_WS_PATH ? 'twilio' : '46elks';
    const handler = provider === 'twilio' ? handleTwilioConnection : handleElksConnection;
    handler(carrierWs, req, { config, phoneManager, memory, db }).catch((err) => {
      console.error('[realtime-voice] connection handler failed:', (err as Error)?.message ?? err);
      try { carrierWs.close(); } catch { /* ignore */ }
    });
  });

  return {
    tryHandleUpgrade(req, socket, head) {
      const path = (req.url ?? '').split('?')[0];
      if (path !== ELKS_REALTIME_WS_PATH && path !== TWILIO_REALTIME_WS_PATH) return false;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return true;
    },
    close() {
      try { wss.close(); } catch { /* ignore */ }
    },
  };
}

interface ConnectionDeps {
  config: AgenticMailConfig;
  phoneManager: PhoneManager;
  memory: AgentMemoryManager;
  db: Db;
}

// ─── 46elks connection ──────────────────────────────────

/**
 * Drive one 46elks media connection: buffer frames until the `hello`
 * arrives, resolve + authorise the mission from its `callid`, open
 * OpenAI, and run the bridge. The whole thing fails closed — any
 * resolution/auth failure just closes the carrier socket (the caller
 * hears the call drop).
 */
async function handleElksConnection(
  carrierWs: WebSocket,
  req: IncomingMessage,
  deps: ConnectionDeps,
): Promise<void> {
  const { phoneManager } = deps;

  // The static token on the websocket_url query string. 46elks sends no
  // auth of its own, so this — plus an unguessable URL path — is the
  // gate. It is verified against the resolved mission's agent secret
  // once `hello` tells us which agent this call belongs to.
  const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token') ?? '';

  // Frames that arrive before the bridge exists are buffered, then
  // replayed into the bridge in order once it is constructed.
  const buffered: string[] = [];
  let bridge: RealtimeVoiceBridge | null = null;
  let resolving = false;

  const helloTimer = setTimeout(() => {
    if (!bridge) {
      console.warn('[realtime-voice] no hello frame — closing idle connection');
      try { carrierWs.close(); } catch { /* ignore */ }
    }
  }, HELLO_TIMEOUT_MS);

  carrierWs.on('message', (data) => {
    const raw = data.toString();
    if (bridge) {
      bridge.handleCarrierMessage(raw);
      return;
    }
    buffered.push(raw);
    if (resolving) return;
    // First frame must be `hello` — peek it to resolve the mission.
    resolving = true;
    void resolveAndStart(raw).catch((err) => {
      console.error('[realtime-voice] failed to start bridge:', (err as Error)?.message ?? err);
      try { carrierWs.close(); } catch { /* ignore */ }
    });
  });

  carrierWs.on('close', () => {
    clearTimeout(helloTimer);
    bridge?.handleCarrierClose();
  });
  carrierWs.on('error', (err) => {
    clearTimeout(helloTimer);
    bridge?.handleCarrierError(err);
  });

  async function resolveAndStart(firstFrame: string): Promise<void> {
    let hello;
    try {
      hello = parseElksRealtimeMessage(firstFrame);
    } catch {
      throw new Error('first frame was not a valid 46elks realtime message');
    }
    if (hello.t !== 'hello') {
      throw new Error(`expected a hello frame first, got "${hello.t}"`);
    }

    const mission = phoneManager.findMissionByProviderCallId(hello.callid);
    if (!mission) {
      throw new Error(`no phone mission matches 46elks callid ${hello.callid}`);
    }

    // Token auth — must match the mission agent's phone transport
    // webhook secret. Uniform failure (just close) so an attacker
    // cannot tell a wrong token from an unknown mission.
    const transport = phoneManager.getPhoneTransportConfig(mission.agentId);
    if (!transport || !token || !safeEqual(token, transport.webhookSecret)) {
      throw new Error('realtime voice connection failed token authentication');
    }

    // v0.9.93 — preflight is now provider-aware. The resolver throws a
    // clear error if the selected provider's key is missing; we let
    // that error propagate (handled below by the carrier-side abort).
    // Still keep a fast OpenAI-key check for the default-provider case
    // to preserve the existing exact error message.
    if (!deps.config.voiceRuntime && !deps.config.openaiApiKey && !process.env.OPENAI_API_KEY) {
      phoneManager.recordRealtimeActivity(mission.id, [systemEntry(
        'Realtime voice could not start — no OpenAI API key is configured (set OPENAI_API_KEY).',
      )]);
      throw new Error('OPENAI_API_KEY is not configured — cannot open a Realtime session');
    }

    clearTimeout(helloTimer);
    bridge = await startBridge({
      mission,
      carrierWs,
      transport: createRealtimeTransport('46elks'),
      deps,
      getBridge: () => bridge,
    });
    // Replay buffered frames (the hello + anything that arrived during
    // resolution) into the bridge, in order.
    for (const frame of buffered.splice(0)) {
      bridge.handleCarrierMessage(frame);
    }
  }
}

// ─── Twilio connection ──────────────────────────────────

/**
 * Drive one Twilio Media Streams connection. Unlike 46elks, the mission
 * is resolved UP FRONT from the connection URL query string: the TwiML
 * the Twilio voice webhook returned put the mission id + per-mission
 * token in the `<Stream>` URL. So we authenticate before a single
 * media frame arrives, then run the bridge — Twilio's `connected` and
 * `start` frames flow straight into it.
 *
 * Fails closed: a missing/forged token, an unknown mission, or a
 * non-Twilio transport just closes the socket (the call drops).
 */
async function handleTwilioConnection(
  carrierWs: WebSocket,
  req: IncomingMessage,
  deps: ConnectionDeps,
): Promise<void> {
  const { phoneManager } = deps;

  // Twilio Media Streams DROPS the query string from the `<Stream url=…>`
  // when it opens the WebSocket — only the path survives. The mission id +
  // per-mission token therefore have to ride on the `<Parameter>` tags the
  // voice webhook embedded in the TwiML, which Twilio delivers inside the
  // `start` event as `start.customParameters`. We defer mission resolution
  // until that frame arrives. URL query is kept as a fallback for clients /
  // tests that DO include it.
  const buffered: string[] = [];
  let bridge: RealtimeVoiceBridge | null = null;
  let resolving = false;

  // Idle-timeout: if no `start` frame arrives we are not on a real Twilio
  // call — close the socket so we don't leak a connection.
  const startTimer = setTimeout(() => {
    if (!bridge) {
      console.warn('[realtime-voice] Twilio: no start frame — closing idle connection');
      try { carrierWs.close(); } catch { /* ignore */ }
    }
  }, HELLO_TIMEOUT_MS);

  carrierWs.on('message', (data) => {
    const raw = data.toString();
    if (bridge) { bridge.handleCarrierMessage(raw); return; }
    buffered.push(raw);
    if (resolving) return;
    // Only the `start` frame carries customParameters — earlier `connected`
    // frames are buffered and replayed once the bridge exists.
    let parsed: Record<string, unknown> | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (parsed?.event !== 'start') return;
    resolving = true;
    void resolveAndStart(parsed).catch((err) => {
      console.error('[realtime-voice] Twilio connection handler failed:', (err as Error)?.message ?? err);
      try { carrierWs.close(); } catch { /* ignore */ }
    });
  });
  carrierWs.on('close', () => { clearTimeout(startTimer); bridge?.handleCarrierClose(); });
  carrierWs.on('error', (err) => { clearTimeout(startTimer); bridge?.handleCarrierError(err); });

  async function resolveAndStart(startMsg: Record<string, unknown>): Promise<void> {
    // Twilio Media Streams payload: `start.customParameters` is a flat
    // string→string map populated from the TwiML `<Parameter>` tags.
    const start = (startMsg.start && typeof startMsg.start === 'object')
      ? startMsg.start as Record<string, unknown>
      : {};
    const cp = (start.customParameters && typeof start.customParameters === 'object')
      ? start.customParameters as Record<string, unknown>
      : {};
    const urlQuery = new URL(req.url ?? '', 'http://localhost').searchParams;
    const missionId = (typeof cp.missionId === 'string' ? cp.missionId : urlQuery.get('missionId')) ?? '';
    const token = (typeof cp.token === 'string' ? cp.token : urlQuery.get('token')) ?? '';

    const mission = missionId ? phoneManager.getMission(missionId) : null;
    if (!mission) {
      throw new Error(`no phone mission matches Twilio stream missionId ${missionId || '(missing)'}`);
    }

    const transport = phoneManager.getPhoneTransportConfig(mission.agentId);
    if (!transport || transport.provider !== 'twilio') {
      throw new Error('Twilio realtime stream: mission has no Twilio transport configured');
    }
    if (!token || !safeEqual(token, missionWebhookToken(transport.webhookSecret, mission.id))) {
      throw new Error('Twilio realtime stream failed token authentication');
    }

    // v0.9.93 — preflight is now provider-aware. The resolver throws a
    // clear error if the selected provider's key is missing; we let
    // that error propagate (handled below by the carrier-side abort).
    // Still keep a fast OpenAI-key check for the default-provider case
    // to preserve the existing exact error message.
    if (!deps.config.voiceRuntime && !deps.config.openaiApiKey && !process.env.OPENAI_API_KEY) {
      phoneManager.recordRealtimeActivity(mission.id, [systemEntry(
        'Realtime voice could not start — no OpenAI API key is configured (set OPENAI_API_KEY).',
      )]);
      throw new Error('OPENAI_API_KEY is not configured — cannot open a Realtime session');
    }

    clearTimeout(startTimer);
    bridge = await startBridge({
      mission,
      carrierWs,
      transport: createRealtimeTransport('twilio'),
      deps,
      getBridge: () => bridge,
    });
    for (const frame of buffered.splice(0)) {
      bridge.handleCarrierMessage(frame);
    }
  }
}

/**
 * Recompute the per-mission webhook token (#43-H7) the
 * {@link PhoneManager} derives — `HMAC-SHA256(webhookSecret, missionId)`.
 * Kept in lockstep with the manager's `webhookToken`.
 */
function missionWebhookToken(webhookSecret: string, missionId: string): string {
  return createHmac('sha256', webhookSecret).update(missionId).digest('hex');
}

// ─── Shared bridge startup ──────────────────────────────

interface StartBridgeParams {
  mission: PhoneCallMission;
  carrierWs: WebSocket;
  transport: RealtimeTransportAdapter;
  deps: ConnectionDeps;
  /** Late-bound getter — the bridge ref the caller is about to assign. */
  getBridge: () => RealtimeVoiceBridge | null;
}

/**
 * Construct the OpenAI side + the {@link RealtimeVoiceBridge} for a
 * resolved mission. Provider-neutral — the only carrier-specific input
 * is the {@link RealtimeTransportAdapter}, which also dictates the
 * OpenAI session audio format (linear PCM @ 24 kHz for 46elks, µ-law @
 * 8 kHz for Twilio, so no transcoding either way).
 *
 * Async: the agent's persistent memory is rendered BEFORE the OpenAI
 * session config is built, so the memory is folded into the session
 * `instructions` the model receives on its very first turn. Memory
 * rendering is best-effort — a failure just proceeds with the base
 * instructions.
 */
async function startBridge(params: StartBridgeParams): Promise<RealtimeVoiceBridge> {
  const { mission, carrierWs, transport, deps, getBridge } = params;
  const { config, phoneManager, memory, db } = deps;

  // v0.9.93 — resolve the voice runtime through the drop-in provider
  // registry (packages/core/src/phone/voice-providers/). Priority:
  //   1. mission.policy.voiceRuntime — per-call override
  //   2. config.voiceRuntime         — install-wide default
  //   3. 'openai'                    — fall-through default
  // Plus an optional .voiceModel field on policy lets the caller pin
  // a specific model (e.g. 'gpt-realtime-mini', 'grok-voice-fast').
  const missionPolicyRuntime = (mission.policy as any)?.voiceRuntime as string | undefined;
  const missionPolicyModel = (mission.policy as any)?.voiceModel as string | undefined;
  const missionPolicyVoice = (mission.policy as any)?.voice as string | undefined;

  // v0.9.95 — voice resolution. Priority for the character voice:
  //   1. mission.policy.voice
  //   2. agent persona frontmatter `voice:` (per-agent default)
  //   3. config.voiceProviderVoices[<providerId>] (install default)
  //   4. provider's own defaultVoice (e.g. OpenAI "marin", Grok "ara")
  // Same shape as the runtime resolution above.
  let personaVoice: string | undefined;
  let personaVoiceRuntime: string | undefined;
  try {
    const row0 = db.prepare('SELECT name FROM agents WHERE id = ?').get(mission.agentId) as { name?: string } | undefined;
    const name0 = (row0?.name || '').trim();
    if (name0) {
      const { frontmatter } = readAgentPersonaFile(name0);
      personaVoice = frontmatter.voice;
      personaVoiceRuntime = frontmatter.voiceRuntime;
    }
  } catch { /* persona is best-effort; bridge still works without it */ }

  const providerId = missionPolicyRuntime || personaVoiceRuntime || config.voiceRuntime || 'openai';
  const runtime = resolveVoiceRuntime(providerId, config, {
    model: missionPolicyModel,
    voice: missionPolicyVoice || personaVoice,
  });
  const model = runtime.model;

  // Render the agent's persistent memory and fold it + the mission task
  // into the OpenAI Realtime session instructions. The model is told to
  // treat the block as its own knowledge — so the call feels continuous
  // with everything the agent has learned elsewhere.
  let memoryContext = '';
  try {
    memoryContext = await memory.generateMemoryContext(mission.agentId, mission.task);
  } catch (err) {
    console.warn('[realtime-voice] memory context unavailable:', (err as Error)?.message ?? err);
  }

  // v0.9.85 — load the agent's persona ("soul file") so the voice
  // model has a real identity instead of falling back to the generic
  // "I'm an assistant" default. Auto-creates ~/.agenticmail/agents/
  // <name>/persona.md with a sensible seed on first read. The agent's
  // display name is pulled from the DB; if absent we fall back to the
  // agent id (rare — bootstrap always sets a name).
  let agentName = '';
  let agentPersona = '';
  try {
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(mission.agentId) as { name?: string } | undefined;
    agentName = (row?.name || '').trim();
    if (agentName) {
      agentPersona = loadAgentPersona(agentName);
    }
  } catch (err) {
    console.warn('[realtime-voice] persona load failed:', (err as Error)?.message ?? err);
  }

  // Build this connection's tool layer. `tools` is declared on the
  // OpenAI session; `executor` dispatches the model's calls to real
  // implementations. The executor's `ask_operator` poll needs to abort
  // if the call drops — `isCallEnded` lets it see the bridge state.
  const tools = buildVoiceTools();
  // Resolve the per-call budget envelopes so we can hand them to BOTH
  // the session config (instructions get the "you have N minutes" line)
  // and the bridge (which enforces the timer + extension caps). The
  // resolve functions clamp to server ceilings and default if missing.
  const extensionPolicy = resolveExtensionPolicy(mission.policy.extensionPolicy);
  const callbackPolicy = resolveCallbackPolicy(mission.policy.callbackPolicy);
  const callBudgetSeconds = Math.min(
    mission.policy.maxCallDurationSeconds,
    PHONE_SERVER_MAX_CALL_DURATION_SECONDS,
  );
  const transcript: PhoneMissionTranscriptEntry[] = [];
  const conversationManager = new ConversationSessionManager(db as any);
  let conversationSessionId: string | null | undefined;
  const recordConversationTranscript = (entry: PhoneMissionTranscriptEntry) => {
    try {
      conversationSessionId = mirrorPhoneTranscriptEntryToConversation(
        conversationManager,
        mission,
        entry,
        conversationSessionId,
      );
    } catch (err) {
      console.warn('[realtime-voice] conversation transcript persist failed:', (err as Error)?.message ?? err);
    }
  };
  const record = (entry: PhoneMissionTranscriptEntry) => {
    transcript.push(entry);
    recordConversationTranscript(entry);
  };

  const executor = createVoiceToolExecutor({
    mission, phoneManager, memory, config, db,
    isCallEnded: () => getBridge()?.isEnded ?? false,
    getBridge,
    recordTranscript: record,
  });

  // v0.9.93 — open against whichever provider the resolver picked.
  // Variable name kept as `openaiWs` for diff-friendliness; the bridge
  // class still refers to its OpenAI-side port by that field name since
  // the wire protocol is the same regardless of who's terminating it.
  const openaiWs = new WebSocket(runtime.url, {
    headers: { Authorization: `Bearer ${runtime.apiKey}` },
  });
  console.log(`[realtime-voice] mission=${mission.id} voice-runtime=${runtime.providerId} model=${runtime.model} voice=${runtime.voice} (${runtime.voiceSource}) key=${runtime.apiKeySource}`);

  const bridge = new RealtimeVoiceBridge({
    carrier: portFor(carrierWs),
    openai: portFor(openaiWs),
    transport,
    sessionConfig: buildRealtimeSessionConfig({
      task: mission.task,
      memoryContext,
      // v0.9.85 — agent identity. agentName drops in "Your name is X"
      // line; persona overrides the generic DEFAULT_PERSONA. Empty
      // strings fall through to the bridge's defaults (the legacy path).
      agentName: agentName || undefined,
      persona: agentPersona || undefined,
      // v0.9.95 — voice character. Resolver picked it per priority
      // (mission policy > persona frontmatter > install default >
      // provider default) and it's already validated against the
      // provider's catalogue.
      voice: runtime.voice,
      model,
      tools,
      // v0.9.81 — fold the time-budget preamble into the instructions so
      // the agent reads "you have ~N minutes" + the extend / callback
      // tips alongside the rest of its persona / tool guidance.
      callBudget: {
        seconds: callBudgetSeconds,
        extensionEnabled: extensionPolicy.maxRequestsPerCall > 0,
        callbackEnabled: callbackPolicy.allowAutoCallback && callbackPolicy.maxCallbackChain > 0,
      },
      // Carrier-driven audio format — no transcoding end to end.
      // 46elks → audio/pcm @ 24 kHz; Twilio → audio/pcmu @ 8 kHz.
      audioFormat: transport.openaiAudioFormat,
    }),
    toolExecutor: executor,
    // v0.9.81 — soft-deadline timer, extension envelope, scheduled
    // callback callback. The bridge enforces the soft cap; the
    // mission's `maxCallDurationSeconds` is still the hard ceiling
    // imposed by the carrier.
    callBudgetSeconds,
    extensionPolicy,
    callbackPolicy,
    onCallbackScheduled: (req) => {
      try {
        phoneManager.armScheduledCallback(mission.id, req);
      } catch (err) {
        console.error('[realtime-voice] scheduled callback persist failed:', (err as Error)?.message ?? err);
        throw err;  // rethrow so the bridge can refuse the tool call cleanly
      }
    },
    onTranscript: (e) => record({ at: new Date().toISOString(), source: e.source, text: e.text, metadata: e.metadata }),
    onEnd: ({ reason, pendingToolCalls, endedByTimeBudget }) => {
      record({
        at: new Date().toISOString(),
        source: 'system',
        text: `Realtime voice bridge ended (${reason}).`,
        metadata: endedByTimeBudget ? { endedByTimeBudget: true } : undefined,
      });
      // Snapshot the transcript BEFORE persistRealtimeActivity drains
      // it — we need the agent's last few turns to compose the
      // end-of-call Telegram summary below.
      const finalTranscript = [...transcript];
      try {
        phoneManager.recordRealtimeActivity(mission.id, transcript.splice(0), 'completed');
      } catch (err) {
        console.error('[realtime-voice] transcript persist failed:', (err as Error)?.message ?? err);
      }
      if (conversationSessionId) {
        try {
          conversationManager.endSession(mission.agentId, conversationSessionId, 'ended');
        } catch (err) {
          console.warn('[realtime-voice] conversation session end failed:', (err as Error)?.message ?? err);
        }
      }
      // Skip the legacy operator-query callback flag when the agent
      // has already scheduled its OWN callback. The two paths would
      // otherwise dial twice for the same call.
      if (pendingToolCalls > 0 && !bridge.isCallbackArmed) {
        try {
          phoneManager.flagCallbackPending(mission.id);
        } catch (err) {
          console.error('[realtime-voice] callback flag failed:', (err as Error)?.message ?? err);
        }
      }
      // v0.9.85 — DM the operator a summary of how the call went.
      // Without this, the operator's only feedback was the dispatcher
      // saying "dialing now"; once the agent hung up they never heard
      // a word about what happened. Best-effort: no telegram config /
      // no operator chat ⇒ silently skipped. The mission itself is
      // still persisted to the DB regardless.
      void notifyCallEnded({
        mission,
        config,
        db,
        reason,
        endedByTimeBudget: !!endedByTimeBudget,
        pendingToolCalls,
        callbackArmed: bridge.isCallbackArmed,
        transcript: finalTranscript,
      }).catch((err) => console.warn('[realtime-voice] end-of-call notify failed:', (err as Error)?.message ?? err));
    },
  });

  // Mark the mission connected up front so /calls reflects the live
  // call even before the first transcript flush.
  try { phoneManager.recordRealtimeActivity(mission.id, [], 'connected'); } catch { /* best effort */ }

  const openaiConnectTimer = setTimeout(() => {
    if (openaiWs.readyState === WebSocket.CONNECTING) {
      console.warn('[realtime-voice] OpenAI Realtime socket did not open in time');
      bridge.handleOpenAIError(new Error('OpenAI Realtime connection timed out'));
    }
  }, OPENAI_CONNECT_TIMEOUT_MS);

  openaiWs.on('open', () => { clearTimeout(openaiConnectTimer); bridge.handleOpenAIOpen(); });
  openaiWs.on('message', (data) => bridge.handleOpenAIMessage(data.toString()));
  openaiWs.on('close', () => { clearTimeout(openaiConnectTimer); bridge.handleOpenAIClose(); });
  openaiWs.on('error', (err) => { clearTimeout(openaiConnectTimer); bridge.handleOpenAIError(err); });

  return bridge;
}

/** Wrap a `ws` socket as a {@link RealtimeBridgePort} — JSON sink + close. */
function portFor(ws: WebSocket): RealtimeBridgePort {
  return {
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

function systemEntry(text: string): PhoneMissionTranscriptEntry {
  return { at: new Date().toISOString(), source: 'system', text };
}

// ─── Realtime voice tools ───────────────────────────────

/**
 * The tool set declared on a realtime voice session. All four are
 * always available: `web_search` uses keyless DuckDuckGo, so there is
 * no configuration that can make a tool unfulfillable.
 */
function buildVoiceTools(): RealtimeToolDefinition[] {
  return [
    ASK_OPERATOR_TOOL,
    RECALL_MEMORY_TOOL,
    GET_DATETIME_TOOL,
    WEB_SEARCH_TOOL,
    SEARCH_SKILLS_TOOL,
    LOAD_SKILL_TOOL,
    // v0.9.81 — time-budget self-awareness tools. Always exposed when
    // the bridge has a soft budget configured (always, in practice;
    // every mission has a maxCallDurationSeconds).
    GET_CALL_STATUS_TOOL,
    EXTEND_CALL_TIME_TOOL,
    SCHEDULE_CALLBACK_TOOL,
    // v0.9.82 — the missing piece: the agent now has a tool to actually
    // hang up. Without this the model says "goodbye" but the line
    // stays open until carrier/human teardown.
    END_CALL_TOOL,
  ];
}

interface VoiceToolExecutorParams {
  mission: PhoneCallMission;
  phoneManager: PhoneManager;
  memory: AgentMemoryManager;
  config: AgenticMailConfig;
  db: Db;
  /** True once the call has ended — aborts a pending ask_operator poll. */
  isCallEnded: () => boolean;
  /**
   * Late-bound bridge accessor — the bridge isn't constructed until
   * AFTER this executor (the executor is one of the bridge's options),
   * so the time-budget tools resolve it lazily via this closure. May
   * return null briefly during construction; handlers guard for that.
   */
  getBridge: () => RealtimeVoiceBridge | null;
  /**
   * v0.9.92 — append a transcript entry from inside a tool handler.
   * Used by `search_skills` to record what results the model saw, so
   * post-call review can tell apart "ranking missed" from "model
   * looked and chose not to load". Routes to the same persistence
   * path the bridge's own emitTranscript uses.
   */
  recordTranscript: (entry: PhoneMissionTranscriptEntry) => void;
}

/**
 * Build the per-connection {@link ToolExecutor} — wires each declared
 * tool to its real implementation. Every handler is soft-failing
 * (`createToolExecutor` catches throws), so the worst case a tool can
 * produce is a model-readable error string, never a wedged call.
 */
function createVoiceToolExecutor(params: VoiceToolExecutorParams): ToolExecutor {
  const { mission, phoneManager, memory, config, db, isCallEnded, getBridge, recordTranscript } = params;

  const askOperator: RealtimeToolHandler = async (args) => {
    const question = typeof args.question === 'string' ? args.question : '';
    const callContext = typeof args.call_context === 'string' ? args.call_context : undefined;
    const urgency = args.urgency === 'high' ? 'high' : 'normal';

    let queryId: string;
    try {
      const { query } = phoneManager.addOperatorQuery(mission.id, { question, callContext, urgency });
      queryId = query.id;
    } catch (err) {
      console.warn('[realtime-voice] could not record operator query:', (err as Error)?.message ?? err);
      return 'I could not record that question for my operator just now. '
        + 'Tell the caller you will follow up another way.';
    }

    void notifyOperator({ mission, config, db, queryId, question, callContext, urgency })
      .catch((err) => console.warn('[realtime-voice] operator notification failed:', (err as Error)?.message ?? err));

    void notifyOperatorViaTelegram({ mission, config, db, queryId, question, callContext, urgency })
      .catch((err) => console.warn('[realtime-voice] telegram operator notification failed:', (err as Error)?.message ?? err));

    const answer = await pollForOperatorAnswer(
      () => phoneManager.getOperatorQuery(mission.id, queryId)?.answer ?? null,
      { signal: { get aborted() { return isCallEnded(); } } },
    );
    return answer ?? OPERATOR_QUERY_TIMEOUT_SENTINEL;
  };

  return createToolExecutor({
    ask_operator: askOperator,
    recall_memory: (args) => recallMemory(
      memory, mission.agentId, typeof args.query === 'string' ? args.query : '',
    ),
    get_datetime: (args) => getDatetime({
      timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
    }),
    web_search: (args) => webSearch(typeof args.query === 'string' ? args.query : ''),

    // Skill library (Phase 2). `search_skills` is pure file-on-disk
    // ranking — fast, no API server roundtrip. `load_skill` requires
    // the live bridge instance (it has to issue a partial
    // session.update on the OpenAI Realtime socket), which we get
    // through the same `getBridge()` closure `ask_operator` uses to
    // check `isCallEnded`.
    search_skills: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) {
        return { error: 'search_skills requires a non-empty `query` describing the situation.' };
      }
      const { searchSkills } = await import('@agenticmail/core');
      // v0.9.92 — robustness pass. Earlier versions returned the top 3
      // results with `name + 120-char description` only. The model
      // searched (correctly) but rarely followed through with
      // load_skill — telemetry showed 1 search across 8 calls, 0
      // loads. Root cause: the description is for browsing, not
      // matching. `when_to_use` and `first_principle` are the actually-
      // diagnostic fields. Surface them, surface the BM25 score, and
      // give the model an explicit decision rule.
      const TOP_N = 5;
      const results = searchSkills(query, TOP_N);
      if (results.length === 0) {
        recordTranscript({
          at: new Date().toISOString(),
          source: 'system',
          text: `search_skills: 0 results for "${query}"`,
        });
        return {
          query, count: 0,
          message: 'No matching skills in the library. Re-search with a different query phrasing, or improvise within the call\'s overall task and the operator\'s instructions.',
        };
      }

      const topScore = results[0].score ?? 0;
      const runnerScore = results[1]?.score ?? 0;
      // Decision heuristic the agent should follow:
      //   - top score < 0.15        ⇒ weak match, re-search instead
      //   - top > 0.3 OR top is 2× runner ⇒ load the top hit, it's clearly right
      //   - otherwise read when_to_use carefully and pick deliberately
      const ratio = runnerScore > 0 ? topScore / runnerScore : Infinity;
      let recommendation: string;
      if (topScore < 0.15) {
        recommendation = `Top score is only ${topScore.toFixed(2)} — weak match. RE-SEARCH with a different phrasing (the situation in plain words) before loading anything.`;
      } else if (topScore >= 0.3 || ratio >= 2) {
        recommendation = `Top hit "${results[0].id}" is a clear winner (score ${topScore.toFixed(2)}${runnerScore > 0 ? `, ${ratio.toFixed(1)}× runner-up` : ''}). LOAD IT NOW: load_skill({ id: "${results[0].id}" }).`;
      } else {
        recommendation = `Top hits are close (${topScore.toFixed(2)} vs ${runnerScore.toFixed(2)}). Read each \`when_to_use\` carefully and load the one whose situation actually matches the call.`;
      }

      const out = {
        query,
        count: results.length,
        skills: results.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          score: s.score ?? 0,
          // Truncate but keep the diagnostic fields in full where they
          // earn their tokens. `when_to_use` is the headline match
          // signal; `first_principle` shows the playbook's posture.
          summary: s.description.length > 140 ? s.description.slice(0, 137) + '...' : s.description,
          when_to_use: s.when_to_use.length > 200 ? s.when_to_use.slice(0, 197) + '...' : s.when_to_use,
          first_principle: s.first_principle.length > 160 ? s.first_principle.slice(0, 157) + '...' : s.first_principle,
          tags: s.tags.slice(0, 6),  // first six only — keeps response tight
          disclaimer_required: s.disclaimer_required,
          estimated_call_duration_minutes: s.estimated_call_duration_minutes,
        })),
        recommendation,
        next_step: 'Say "hold on one moment" to the caller, then act on the recommendation above. If you load a skill, its playbook will be in your instructions for the rest of the call.',
      };

      // v0.9.92 — log the result LIST to the mission transcript so the
      // post-call review (and future debugging) can see WHAT the
      // model saw and decide whether the lack of follow-up load_skill
      // was a ranking gap or a model judgement call.
      try {
        const summary = results.map((r) => `${r.id}@${(r.score ?? 0).toFixed(2)}`).join(', ');
        recordTranscript({
          at: new Date().toISOString(),
          source: 'system',
          text: `search_skills "${query}" → ${results.length} results: ${summary}`,
          metadata: { topScore, runnerScore, recommendation },
        });
      } catch { /* transcript persistence is best-effort */ }

      return out;
    },
    load_skill: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id.trim()) {
        return { error: 'load_skill requires `id` (get one from search_skills).' };
      }
      const bridge = getBridge();
      if (!bridge) {
        return { error: 'Bridge not available — load_skill can only run on a live call.' };
      }
      const result = await bridge.loadSkillIntoSession(id);
      // Pass the result through to the model. On success, the
      // session.update has already shipped — the model's NEXT turn
      // will see the loaded skill in its instructions. We tell it
      // that explicitly so it doesn't ask "did you load it?"
      if (result.ok) {
        return {
          ok: true,
          loaded: { name: result.name, version: result.version },
          message: `${result.message}. The playbook is now in your instructions — use it for the rest of the call. Continue the conversation now (the caller is waiting).`,
        };
      }
      return { ok: false, message: result.message };
    },

    // ─── v0.9.81 time-budget self-awareness tools ───────────────────
    //
    // get_call_status: cheap status snapshot. Pure read off bridge state;
    //   the model can call it whenever to decide whether to keep going.
    // extend_call_time: ask for more time, auto-approved within policy.
    // schedule_callback: arrange an auto-redial with prior-call context.
    //
    // All three are bridge-bound — they need the live bridge instance,
    // not just DB state. We resolve via `getBridge()` so the closure
    // always sees the current bridge (the executor is built BEFORE the
    // bridge exists, so the reference must be late-bound).

    get_call_status: () => {
      const bridge = getBridge();
      if (!bridge) return { error: 'Bridge not available — call status unavailable.' };
      return bridge.getCallStatus();
    },

    extend_call_time: (args) => {
      const bridge = getBridge();
      if (!bridge) return { error: 'Bridge not available — cannot extend a call that has no live session.' };
      const seconds = typeof args.seconds === 'number' ? args.seconds : Number(args.seconds);
      const reason = typeof args.reason === 'string' ? args.reason : undefined;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { error: 'extend_call_time requires a positive integer `seconds`.' };
      }
      const result = bridge.extendCallTime(Math.floor(seconds), reason);
      return result;
    },

    schedule_callback: (args) => {
      const bridge = getBridge();
      if (!bridge) return { error: 'Bridge not available — cannot schedule a callback off a non-live call.' };
      const delaySeconds = typeof args.delay_seconds === 'number' ? args.delay_seconds : Number(args.delay_seconds);
      const reason = typeof args.reason === 'string' ? args.reason : '';
      const summary = typeof args.summary_for_next_call === 'string' ? args.summary_for_next_call : '';
      if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
        return { error: 'schedule_callback requires a positive `delay_seconds`.' };
      }
      if (!summary.trim()) {
        return { error: 'schedule_callback requires a non-empty `summary_for_next_call`.' };
      }
      return bridge.scheduleCallback({
        delaySeconds: Math.floor(delaySeconds),
        reason,
        summary,
      });
    },

    // v0.9.82 — hangup. The bridge actually drops the call (carrier
    // bye frame + close both sockets). The model's tool-call return
    // gets through the WS before the close completes, so the model
    // sees the {ok: true} and won't retry.
    end_call: (args) => {
      const bridge = getBridge();
      if (!bridge) return { error: 'Bridge not available — cannot hang up a non-live call.' };
      const reason = typeof args.reason === 'string' ? args.reason : '';
      return bridge.endByAgentRequest(reason);
    },
  });
}

interface NotifyOperatorParams {
  mission: PhoneCallMission;
  config: AgenticMailConfig;
  db: Db;
  queryId: string;
  question: string;
  callContext?: string;
  urgency: string;
}

/**
 * Email the operator that the voice agent needs an answer mid-call.
 * Best-effort: with no `operatorEmail`, no agent password, or an SMTP
 * failure this just returns — the query is still recorded, still
 * polled, and still answerable through the HTTP endpoint.
 */
async function notifyOperator(params: NotifyOperatorParams): Promise<void> {
  const operatorEmail = params.config.operatorEmail?.trim();
  if (!operatorEmail) return; // no notification channel configured

  const row = params.db.prepare(
    'SELECT email, stalwart_principal, metadata FROM agents WHERE id = ?',
  ).get(params.mission.agentId) as
    { email: string; stalwart_principal: string; metadata: string } | undefined;
  if (!row) return;

  let password = '';
  try { password = String(JSON.parse(row.metadata || '{}')?._password ?? ''); } catch { /* no password */ }
  if (!password) return;

  const sender = new MailSender({
    host: params.config.smtp.host,
    port: params.config.smtp.port,
    email: row.email,
    password,
    authUser: row.stalwart_principal || row.email,
  });
  try {
    await sender.send({
      to: operatorEmail,
      subject: operatorQuerySubject(params.queryId, params.callContext),
      text: [
        `Your voice agent needs an answer to continue a live phone call`
          + `${params.urgency === 'high' ? ' (URGENT)' : ''}.`,
        '',
        `Question: ${params.question}`,
        ...(params.callContext ? ['', `Call context: ${params.callContext}`] : []),
        '',
        'Reply to this email with your answer — keep the subject line intact so the reply',
        'can be matched back to the call. The agent will hold the line for a few minutes.',
        '',
        `(Mission ${params.mission.id} · query ${params.queryId})`,
      ].join('\n'),
    });
  } finally {
    sender.close();
  }
}

/**
 * Notify the operator over Telegram that the voice agent needs an
 * answer. Best-effort: no Telegram config, no linked operator chat, or
 * a send failure just returns — the query is still answerable from any
 * channel (email / HTTP / Telegram).
 */
async function notifyOperatorViaTelegram(params: NotifyOperatorParams): Promise<void> {
  const telegramManager = new TelegramManager(params.db as any, params.config.masterKey);
  const cfg = telegramManager.getConfig(params.mission.agentId);
  if (!cfg?.enabled || !cfg.operatorChatId || !cfg.botToken) return;

  await sendTelegramMessage(
    cfg.botToken,
    cfg.operatorChatId,
    formatOperatorQueryTelegramMessage({
      queryId: params.queryId,
      question: params.question,
      callContext: params.callContext,
      urgency: params.urgency,
      missionId: params.mission.id,
    }),
  );
}

// v0.9.90 — `notifyCallEnded` + the end-of-call digest formatter
// moved to `./notifications/end-of-call.ts` so this file stays focused
// on WS plumbing + tool dispatch.
