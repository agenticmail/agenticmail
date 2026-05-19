/**
 * Realtime voice WebSocket endpoint.
 *
 * This is the live-conversation half of the phone feature. 46elks
 * streams a phone call's audio to a "websocket number" whose
 * `websocket_url` points here; for each call 46elks opens a WebSocket
 * to `/api/agenticmail/calls/realtime`. This module accepts that
 * socket, matches it to the phone mission that placed the call, loads
 * that agent's persistent memory, opens an OpenAI Realtime
 * (`gpt-realtime`) session with the memory folded into its
 * instructions, and runs a {@link RealtimeVoiceBridge} between the two.
 *
 * Everything protocol-level lives in `@agenticmail/core`'s
 * `RealtimeVoiceBridge` (transport-agnostic, unit-tested). This file is
 * the thin `ws` plumbing: upgrade handling, mission resolution, token
 * auth, OpenAI socket creation, transcript persistence.
 *
 * Testing boundary: the end-to-end path needs a live `OPENAI_API_KEY`
 * and a provisioned 46elks websocket number, so it cannot be exercised
 * in CI. The bridge logic it depends on IS covered by unit tests
 * (packages/core realtime-bridge tests). The glue here is deliberately
 * minimal so it is correct by inspection.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PhoneManager,
  AgentMemoryManager,
  MailSender,
  RealtimeVoiceBridge,
  buildRealtimeSessionConfig,
  buildOpenAIRealtimeUrl,
  DEFAULT_REALTIME_MODEL,
  parseElksRealtimeMessage,
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
  type AgenticMailConfig,
  type RealtimeBridgePort,
  type RealtimeToolDefinition,
  type RealtimeToolHandler,
  type ToolExecutor,
  type PhoneCallMission,
  type PhoneMissionTranscriptEntry,
} from '@agenticmail/core';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

/** Path the 46elks websocket number's `websocket_url` should point at. */
export const REALTIME_WS_PATH = '/api/agenticmail/calls/realtime';

/** A 46elks connection that never sends `hello` is dropped after this. */
const HELLO_TIMEOUT_MS = 15_000;
/** OpenAI socket must open within this window or the call is failed. */
const OPENAI_CONNECT_TIMEOUT_MS = 15_000;

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
   * Returns true if the request path matched and was handled (the
   * socket is now owned by this server); false if it should be left
   * for another handler.
   */
  tryHandleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Close the WebSocket server and every active bridge. */
  close(): void;
}

/**
 * Build the realtime voice WebSocket server. Mounted on the HTTP
 * server's `upgrade` event by the API entry point.
 */
export function createRealtimeVoiceServer(db: Db, config: AgenticMailConfig): RealtimeVoiceServer {
  const wss = new WebSocketServer({ noServer: true });
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const memory = new AgentMemoryManager(db as any);

  wss.on('connection', (elksWs: WebSocket, req: IncomingMessage) => {
    handleConnection(elksWs, req, { config, phoneManager, memory, db }).catch((err) => {
      console.error('[realtime-voice] connection handler failed:', (err as Error)?.message ?? err);
      try { elksWs.close(); } catch { /* ignore */ }
    });
  });

  return {
    tryHandleUpgrade(req, socket, head) {
      const path = (req.url ?? '').split('?')[0];
      if (path !== REALTIME_WS_PATH) return false;
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

/**
 * Drive one 46elks media connection: buffer frames until the `hello`
 * arrives, resolve + authorise the mission, open OpenAI, and run the
 * bridge. The whole thing fails closed — any resolution/auth failure
 * just closes the 46elks socket (the caller hears the call drop).
 */
async function handleConnection(
  elksWs: WebSocket,
  req: IncomingMessage,
  deps: ConnectionDeps,
): Promise<void> {
  const { config, phoneManager, memory, db } = deps;

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
      try { elksWs.close(); } catch { /* ignore */ }
    }
  }, HELLO_TIMEOUT_MS);

  elksWs.on('message', (data) => {
    const raw = data.toString();
    if (bridge) {
      bridge.handleElksMessage(raw);
      return;
    }
    buffered.push(raw);
    if (resolving) return;
    // First frame must be `hello` — peek it to resolve the mission.
    resolving = true;
    void resolveAndStart(raw).catch((err) => {
      console.error('[realtime-voice] failed to start bridge:', (err as Error)?.message ?? err);
      try { elksWs.close(); } catch { /* ignore */ }
    });
  });

  elksWs.on('close', () => {
    clearTimeout(helloTimer);
    bridge?.handleElksClose();
  });
  elksWs.on('error', (err) => {
    clearTimeout(helloTimer);
    bridge?.handleElksError(err);
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

    if (!config.openaiApiKey) {
      phoneManager.recordRealtimeActivity(mission.id, [systemEntry(
        'Realtime voice could not start — no OpenAI API key is configured (set OPENAI_API_KEY).',
      )]);
      throw new Error('OPENAI_API_KEY is not configured — cannot open a Realtime session');
    }

    clearTimeout(helloTimer);
    await startBridge(mission);
  }

  async function startBridge(mission: PhoneCallMission): Promise<void> {
    // Render the agent's persistent memory and fold it + the mission
    // task into the OpenAI Realtime session instructions. The model is
    // told to treat the block as its own knowledge — so the call feels
    // continuous with everything the agent has learned elsewhere.
    let memoryContext = '';
    try {
      memoryContext = await memory.generateMemoryContext(mission.agentId, mission.task);
    } catch (err) {
      console.warn('[realtime-voice] memory context unavailable:', (err as Error)?.message ?? err);
    }

    const model = DEFAULT_REALTIME_MODEL;

    // Build this connection's tool layer (v0.9.53). `tools` is declared
    // on the OpenAI session; `executor` dispatches the model's calls to
    // real implementations (ask_operator, web_search, recall_memory,
    // get_datetime). The executor's `ask_operator` poll needs to abort
    // if the call drops — `isCallEnded` lets it see the bridge state.
    const tools = buildVoiceTools();
    const executor = createVoiceToolExecutor({
      mission, phoneManager, memory, config, db,
      isCallEnded: () => bridge?.isEnded ?? false,
    });

    const sessionConfig = buildRealtimeSessionConfig({
      task: mission.task,
      memoryContext,
      model,
      tools,
    });

    const openaiWs = new WebSocket(buildOpenAIRealtimeUrl(model), {
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    });

    const transcript: PhoneMissionTranscriptEntry[] = [];
    const record = (entry: PhoneMissionTranscriptEntry) => transcript.push(entry);

    bridge = new RealtimeVoiceBridge({
      elks: portFor(elksWs),
      openai: portFor(openaiWs),
      sessionConfig,
      toolExecutor: executor,
      onTranscript: (e) => record({ at: new Date().toISOString(), source: e.source, text: e.text, metadata: e.metadata }),
      onEnd: ({ reason, pendingToolCalls }) => {
        record({ at: new Date().toISOString(), source: 'system', text: `Realtime voice bridge ended (${reason}).` });
        // Persist the whole transcript + mark the mission completed
        // (the conversation actually happened). recordRealtimeActivity
        // keeps a terminal mission terminal — no resurrection.
        try {
          phoneManager.recordRealtimeActivity(mission!.id, transcript.splice(0), 'completed');
        } catch (err) {
          console.error('[realtime-voice] transcript persist failed:', (err as Error)?.message ?? err);
        }
        // Callback-on-disconnect (plan §7): the call dropped with a tool
        // call (an unanswered ask_operator query) still in flight. Flag
        // the mission so the answer endpoint dials the caller back once
        // the operator responds. flagCallbackPending re-checks for an
        // actually-unanswered query, so this is safe to call broadly.
        if (pendingToolCalls > 0) {
          try {
            phoneManager.flagCallbackPending(mission!.id);
          } catch (err) {
            console.error('[realtime-voice] callback flag failed:', (err as Error)?.message ?? err);
          }
        }
      },
    });

    // Mark the mission connected up front so /calls reflects the live
    // call even before the first transcript flush.
    try { phoneManager.recordRealtimeActivity(mission.id, [], 'connected'); } catch { /* best effort */ }

    const openaiConnectTimer = setTimeout(() => {
      if (openaiWs.readyState === WebSocket.CONNECTING) {
        console.warn('[realtime-voice] OpenAI Realtime socket did not open in time');
        bridge?.handleOpenAIError(new Error('OpenAI Realtime connection timed out'));
      }
    }, OPENAI_CONNECT_TIMEOUT_MS);

    openaiWs.on('open', () => { clearTimeout(openaiConnectTimer); bridge?.handleOpenAIOpen(); });
    openaiWs.on('message', (data) => bridge?.handleOpenAIMessage(data.toString()));
    openaiWs.on('close', () => { clearTimeout(openaiConnectTimer); bridge?.handleOpenAIClose(); });
    openaiWs.on('error', (err) => { clearTimeout(openaiConnectTimer); bridge?.handleOpenAIError(err); });

    // Replay buffered 46elks frames (the hello + anything that arrived
    // during resolution) into the bridge, in order.
    for (const frame of buffered.splice(0)) {
      bridge.handleElksMessage(frame);
    }
  }
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

// ─── Realtime voice tools (v0.9.53) ─────────────────────

/**
 * The Phase 1+2 tool set declared on a realtime voice session. All four
 * are always available: `web_search` uses keyless DuckDuckGo (plan
 * §13.1), so there is no configuration that can make a tool unfulfillable.
 */
function buildVoiceTools(): RealtimeToolDefinition[] {
  return [
    ASK_OPERATOR_TOOL,
    RECALL_MEMORY_TOOL,
    GET_DATETIME_TOOL,
    WEB_SEARCH_TOOL,
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
}

/**
 * Build the per-connection {@link ToolExecutor} — wires each declared
 * tool to its real implementation. Every handler is soft-failing
 * (`createToolExecutor` catches throws), so the worst case a tool can
 * produce is a model-readable error string, never a wedged call.
 */
function createVoiceToolExecutor(params: VoiceToolExecutorParams): ToolExecutor {
  const { mission, phoneManager, memory, config, db, isCallEnded } = params;

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

    // Notify the operator out-of-band (email — the channel-agnostic
    // default, plan §5). Fire-and-forget: a slow / failing SMTP must not
    // delay the poll, and the query is answerable via the API endpoint
    // regardless of whether the email got through.
    void notifyOperator({ mission, config, db, queryId, question, callContext, urgency })
      .catch((err) => console.warn('[realtime-voice] operator notification failed:', (err as Error)?.message ?? err));

    // Telegram is a first-class operator channel too (plan §13.5). Same
    // fire-and-forget contract as the email notifier: an unconfigured or
    // failing Telegram path must not delay the poll — the query is
    // answerable from any channel regardless.
    void notifyOperatorViaTelegram({ mission, config, db, queryId, question, callContext, urgency })
      .catch((err) => console.warn('[realtime-voice] telegram operator notification failed:', (err as Error)?.message ?? err));

    // Block, polling the query record, until the operator answers or the
    // hard timeout elapses. Abort early if the call drops — the now-
    // unanswered query is what arms callback-on-disconnect (plan §7).
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
 * Email the operator that the voice agent needs an answer mid-call
 * (plan §5 — the channel-agnostic default notifier). The query id is
 * embedded in the subject so the operator can simply *reply*; the
 * inbound mail hook (`routes/inbound.ts`) parses that reply back into
 * the query record.
 *
 * Best-effort: with no `operatorEmail`, no agent password, or an SMTP
 * failure this just returns — the query is still recorded, still
 * polled, and still answerable through the HTTP endpoint.
 *
 * Testing boundary: like the live OpenAI ⇄ 46elks path, the actual SMTP
 * send is not exercised in CI. The pieces it composes ARE unit-tested
 * (`operatorQuerySubject`, the operator-query manager methods, the
 * answer endpoint, and `parseOperatorQueryReply`).
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
 * answer (plan §13.5 — Telegram as a first-class `ask_operator` channel,
 * complementing the email default in {@link notifyOperator}). The
 * operator can answer or approve straight from the Telegram chat; that
 * reply is routed back through the Telegram webhook to the SAME
 * operator-query record this notification references.
 *
 * Best-effort: no Telegram config, no linked operator chat, or a send
 * failure just returns — the query is still recorded, still polled, and
 * still answerable from any channel (email / HTTP / Telegram).
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
