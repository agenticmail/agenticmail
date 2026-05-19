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
  RealtimeVoiceBridge,
  buildRealtimeSessionConfig,
  buildOpenAIRealtimeUrl,
  DEFAULT_REALTIME_MODEL,
  parseElksRealtimeMessage,
  type AgenticMailConfig,
  type RealtimeBridgePort,
  type PhoneCallMission,
  type PhoneMissionTranscriptEntry,
} from '@agenticmail/core';

/** Path the 46elks websocket number's `websocket_url` should point at. */
export const REALTIME_WS_PATH = '/api/agenticmail/calls/realtime';

/** A 46elks connection that never sends `hello` is dropped after this. */
const HELLO_TIMEOUT_MS = 15_000;
/** OpenAI socket must open within this window or the call is failed. */
const OPENAI_CONNECT_TIMEOUT_MS = 15_000;

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

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
    handleConnection(elksWs, req, { config, phoneManager, memory }).catch((err) => {
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
  const { config, phoneManager, memory } = deps;

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
    const sessionConfig = buildRealtimeSessionConfig({
      task: mission.task,
      memoryContext,
      model,
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
      onTranscript: (e) => record({ at: new Date().toISOString(), source: e.source, text: e.text, metadata: e.metadata }),
      onEnd: ({ reason }) => {
        record({ at: new Date().toISOString(), source: 'system', text: `Realtime voice bridge ended (${reason}).` });
        // Persist the whole transcript + mark the mission completed
        // (the conversation actually happened). recordRealtimeActivity
        // keeps a terminal mission terminal — no resurrection.
        try {
          phoneManager.recordRealtimeActivity(mission!.id, transcript.splice(0), 'completed');
        } catch (err) {
          console.error('[realtime-voice] transcript persist failed:', (err as Error)?.message ?? err);
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
