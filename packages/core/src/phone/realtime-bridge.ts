/**
 * Realtime voice bridge — wires the OpenAI Realtime API to a 46elks
 * realtime-media WebSocket so a phone mission can actually *converse*.
 *
 * # Shape of the integration
 *
 *   caller  ⇄  46elks  ⇄  (46elks media WebSocket)  ⇄  AgenticMail
 *                                                         │
 *                                          RealtimeVoiceBridge
 *                                                         │
 *                                      (OpenAI Realtime WebSocket)
 *                                                         │
 *                                                   gpt-realtime
 *
 * 46elks streams the live call audio to AgenticMail as JSON `audio`
 * frames (base64 PCM); AgenticMail relays them to OpenAI as
 * `input_audio_buffer.append`; OpenAI streams synthesised speech back
 * as `response.output_audio.delta`; AgenticMail relays that to 46elks
 * as `audio` frames. Server-side VAD on the OpenAI session handles
 * turn-taking — no manual commit / response.create.
 *
 * # Memory injection — the whole point
 *
 * Before the OpenAI session starts, the agent's persistent memory is
 * rendered (`AgentMemoryManager.generateMemoryContext()`) and folded
 * into the Realtime session `instructions`. The model is told to treat
 * that block as *its own* long-term knowledge — so on the call it acts
 * with full continuity, as if it had always known those things.
 *
 * # Why this file is transport-agnostic
 *
 * `RealtimeVoiceBridge` never touches a socket. It takes two abstract
 * {@link RealtimeBridgePort}s (one per side) and is driven by
 * `handle*Message` / `handle*Open` / `handle*Close` calls. The real
 * WebSocket plumbing lives in `@agenticmail/api` (which has the `ws`
 * dependency); tests drive the bridge with in-memory fake ports. This
 * keeps `@agenticmail/core` dependency-free and the bridge logic fully
 * unit-testable without a live OpenAI key or a 46elks websocket number.
 *
 * The exact OpenAI Realtime wire shapes below are the GA `gpt-realtime`
 * protocol (session config nested under `audio.input` / `audio.output`,
 * `format` as an object, `response.output_audio.delta` for output). The
 * legacy beta output event name `response.audio.delta` is also handled
 * defensively — some `gpt-realtime` deployments still emit it.
 */

import {
  buildElksAudioMessage,
  buildElksByeMessage,
  buildElksHandshakeMessages,
  buildElksInterruptMessage,
  parseElksRealtimeMessage,
  type ElksRealtimeAudioFormat,
} from './realtime.js';

// ─── Constants ──────────────────────────────────────────

/** OpenAI Realtime WebSocket base URL (model passed as `?model=`). */
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
/** GA Realtime model. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';
/** Default GA Realtime voice. */
export const DEFAULT_REALTIME_VOICE = 'marin';
/** PCM sample rate shared by 46elks `pcm_24000` and the OpenAI session. */
export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;

/**
 * #46-H1 — hard ceiling on a single inbound audio frame, measured in
 * base64 characters. Realtime frames are tiny (20–100 ms of audio); a
 * frame larger than this is either a buggy or a hostile peer trying to
 * push an unbounded allocation through the bridge. Oversized frames are
 * dropped, never forwarded. ~256 KiB of base64 ≈ 4 s of 24 kHz PCM16 —
 * far above any legitimate realtime frame, so this never trims real
 * speech, it only fences off abuse.
 */
export const REALTIME_MAX_AUDIO_FRAME_BASE64 = 256 * 1024;

/**
 * Cap on audio frames buffered while the OpenAI socket is still
 * connecting. The pre-ready window is normally a few hundred ms; this
 * bounds memory if OpenAI is slow or never opens.
 */
const MAX_PENDING_AUDIO_FRAMES = 200;

// ─── Session config ─────────────────────────────────────

export interface RealtimeInstructionOptions {
  /** The concrete objective of this call. */
  task: string;
  /** Rendered agent memory block (from `generateMemoryContext()`). */
  memoryContext?: string;
  /** The agent's display name, used in the persona line. */
  agentName?: string;
  /** Override the default persona preamble. */
  persona?: string;
}

const DEFAULT_PERSONA =
  'You are a helpful, professional voice assistant making a phone call on behalf of your operator. '
  + 'Speak naturally and concisely, the way a person would on a real call. Listen carefully, do not '
  + 'talk over the other party, and keep each turn short. Never invent facts; if you do not know '
  + 'something, say so. Do not reveal that you are an AI unless you are asked directly.';

/**
 * Compose the Realtime session `instructions` string. The agent's
 * memory is presented as the model's *own* knowledge — not as external
 * notes — so the call feels continuous with everything the agent has
 * learned elsewhere.
 */
export function buildRealtimeInstructions(opts: RealtimeInstructionOptions): string {
  const persona = opts.persona?.trim() || DEFAULT_PERSONA;
  const sections: string[] = [];

  sections.push(opts.agentName ? `${persona}\n\nYour name is ${opts.agentName}.` : persona);

  const task = opts.task?.trim();
  if (task) {
    sections.push(`# Your objective on this call\n${task}`);
  }

  const memory = opts.memoryContext?.trim();
  if (memory) {
    sections.push(
      '# What you already know\n'
      + 'The following is your own long-term memory — knowledge, preferences, and lessons you have '
      + 'accumulated over time. Treat it as your own experience and act on it naturally. Do not read '
      + 'it aloud or mention that it is "memory"; simply know it.\n\n'
      + memory,
    );
  }

  return sections.join('\n\n');
}

export interface RealtimeSessionConfigOptions extends RealtimeInstructionOptions {
  /** OpenAI Realtime voice (default {@link DEFAULT_REALTIME_VOICE}). */
  voice?: string;
  /** OpenAI Realtime model (default {@link DEFAULT_REALTIME_MODEL}). */
  model?: string;
  /** Provide a fully-formed instruction string instead of composing one. */
  instructions?: string;
}

/**
 * Build the `session.update` client event for the GA `gpt-realtime`
 * API. Audio in/out are PCM16 @ 24 kHz (matches 46elks `pcm_24000`),
 * turn-taking is server-side VAD, and the agent's memory is folded into
 * `instructions`.
 */
export function buildRealtimeSessionConfig(
  opts: RealtimeSessionConfigOptions,
): Record<string, unknown> {
  const instructions = (opts.instructions?.trim())
    || buildRealtimeInstructions(opts);

  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: opts.model?.trim() || DEFAULT_REALTIME_MODEL,
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_AUDIO_SAMPLE_RATE },
          turn_detection: { type: 'server_vad' },
        },
        output: {
          format: { type: 'audio/pcm', rate: REALTIME_AUDIO_SAMPLE_RATE },
          voice: opts.voice?.trim() || DEFAULT_REALTIME_VOICE,
        },
      },
    },
  };
}

/** Build the `wss://…/v1/realtime?model=…` URL for a model. */
export function buildOpenAIRealtimeUrl(model: string = DEFAULT_REALTIME_MODEL): string {
  return `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model || DEFAULT_REALTIME_MODEL)}`;
}

// ─── The bridge ─────────────────────────────────────────

/** One side of the bridge — a JSON message sink that can be closed. */
export interface RealtimeBridgePort {
  /** Send one JSON message to the peer. Must not throw. */
  send(message: Record<string, unknown>): void;
  /** Close the underlying connection. Must be idempotent. */
  close(): void;
}

export interface RealtimeBridgeTranscriptEntry {
  source: 'system' | 'provider' | 'agent';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RealtimeVoiceBridgeOptions {
  /** Port to the 46elks realtime-media side. */
  elks: RealtimeBridgePort;
  /** Port to the OpenAI Realtime side. */
  openai: RealtimeBridgePort;
  /** `session.update` payload — sent to OpenAI once its socket opens. */
  sessionConfig: Record<string, unknown>;
  /** Audio format we ask 46elks to send us (default `pcm_24000`). */
  listenFormat?: ElksRealtimeAudioFormat;
  /** Audio format we declare for the audio we send 46elks (default `pcm_24000`). */
  sendFormat?: ElksRealtimeAudioFormat;
  /** Per-frame base64 ceiling (default {@link REALTIME_MAX_AUDIO_FRAME_BASE64}). */
  maxAudioFrameBase64?: number;
  /** Sink for transcript / lifecycle entries worth persisting on the mission. */
  onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  /** Called exactly once when the bridge has fully ended. */
  onEnd?: (summary: { reason: string }) => void;
}

/**
 * Bridges a 46elks realtime-media connection to an OpenAI Realtime
 * connection. Transport-agnostic: the caller pumps raw messages in via
 * `handleElksMessage` / `handleOpenAIMessage` and connection lifecycle
 * via `handle*Open` / `handle*Close`. Every public method is safe to
 * call after the bridge has ended (they become no-ops).
 */
export class RealtimeVoiceBridge {
  private readonly elks: RealtimeBridgePort;
  private readonly openai: RealtimeBridgePort;
  private readonly sessionConfig: Record<string, unknown>;
  private readonly listenFormat: ElksRealtimeAudioFormat;
  private readonly sendFormat: ElksRealtimeAudioFormat;
  private readonly maxAudioFrameBase64: number;
  private readonly onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  private readonly onEnd?: (summary: { reason: string }) => void;

  /** 46elks `hello` received — the call leg is live. */
  private helloSeen = false;
  /** OpenAI socket open + `session.update` sent. */
  private openaiReady = false;
  /** Bridge has ended — all further input is ignored. */
  private ended = false;
  /** 46elks call id from the `hello` frame. */
  private callId = '';
  /** Audio frames received before OpenAI was ready, flushed on open. */
  private readonly pendingAudio: string[] = [];
  /** Oversized-frame counter — reported once, not per frame. */
  private droppedFrames = 0;
  private droppedFramesReported = false;
  /** Accumulated assistant speech transcript for the current response. */
  private assistantTranscript = '';

  constructor(opts: RealtimeVoiceBridgeOptions) {
    this.elks = opts.elks;
    this.openai = opts.openai;
    this.sessionConfig = opts.sessionConfig;
    this.listenFormat = opts.listenFormat ?? 'pcm_24000';
    this.sendFormat = opts.sendFormat ?? 'pcm_24000';
    this.maxAudioFrameBase64 = opts.maxAudioFrameBase64 ?? REALTIME_MAX_AUDIO_FRAME_BASE64;
    this.onTranscript = opts.onTranscript;
    this.onEnd = opts.onEnd;
  }

  /** True once the bridge has ended. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** The 46elks call id, once the `hello` frame has been seen. */
  get currentCallId(): string {
    return this.callId;
  }

  // ─── OpenAI side lifecycle ────────────────────────────

  /** Call when the OpenAI socket opens — sends `session.update`. */
  handleOpenAIOpen(): void {
    if (this.ended || this.openaiReady) return;
    this.openaiReady = true;
    this.safeSend(this.openai, this.sessionConfig);
    // Flush any audio that arrived during the connect window.
    for (const audio of this.pendingAudio.splice(0)) {
      this.safeSend(this.openai, { type: 'input_audio_buffer.append', audio });
    }
  }

  /** Call when the OpenAI socket closes. */
  handleOpenAIClose(): void {
    this.end('openai-closed');
  }

  /** Call when the OpenAI socket errors. */
  handleOpenAIError(err: unknown): void {
    this.emitTranscript('system', `OpenAI Realtime error: ${errorText(err)}`);
    this.end('openai-error');
  }

  // ─── 46elks side lifecycle ────────────────────────────

  /** Call when the 46elks media socket closes. */
  handleElksClose(): void {
    this.end('elks-closed');
  }

  /** Call when the 46elks media socket errors. */
  handleElksError(err: unknown): void {
    this.emitTranscript('system', `46elks media error: ${errorText(err)}`);
    this.end('elks-error');
  }

  // ─── 46elks → OpenAI ──────────────────────────────────

  /**
   * Feed one raw message from the 46elks media socket. Accepts a JSON
   * string or an already-parsed object. Malformed frames are ignored.
   */
  handleElksMessage(raw: string | Record<string, unknown>): void {
    if (this.ended) return;
    let msg;
    try {
      msg = parseElksRealtimeMessage(raw);
    } catch {
      // Unknown / malformed 46elks frame — ignore, do not tear down.
      return;
    }

    if (msg.t === 'hello') {
      if (this.helloSeen) return; // one hello per call leg
      this.helloSeen = true;
      this.callId = msg.callid;
      // Declare our audio formats to 46elks (listening = audio we want
      // to receive, sending = audio we will send).
      for (const handshake of buildElksHandshakeMessages({
        listenFormat: this.listenFormat,
        sendFormat: this.sendFormat,
      })) {
        this.safeSend(this.elks, handshake as unknown as Record<string, unknown>);
      }
      this.emitTranscript('system', 'Realtime voice bridge connected — live conversation started.', {
        callId: this.callId,
        from: msg.from,
        to: msg.to,
      });
      return;
    }

    if (msg.t === 'audio') {
      this.forwardInboundAudio(msg.data);
      return;
    }

    if (msg.t === 'bye') {
      this.emitTranscript('system', 'Caller side ended the call.', {
        reason: msg.reason,
        message: msg.message,
      });
      this.end('elks-bye');
    }
  }

  /** Relay caller audio to OpenAI, enforcing the per-frame size cap. */
  private forwardInboundAudio(base64: string): void {
    if (base64.length > this.maxAudioFrameBase64) {
      this.noteDroppedFrame();
      return;
    }
    if (!this.openaiReady) {
      if (this.pendingAudio.length < MAX_PENDING_AUDIO_FRAMES) {
        this.pendingAudio.push(base64);
      } else {
        this.noteDroppedFrame();
      }
      return;
    }
    this.safeSend(this.openai, { type: 'input_audio_buffer.append', audio: base64 });
  }

  // ─── OpenAI → 46elks ──────────────────────────────────

  /**
   * Feed one raw message from the OpenAI Realtime socket. Accepts a
   * JSON string or an already-parsed object. Unknown event types are
   * ignored.
   */
  handleOpenAIMessage(raw: string | Record<string, unknown>): void {
    if (this.ended) return;
    let event: Record<string, unknown>;
    try {
      event = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      // GA output-audio event; `response.audio.delta` is the legacy
      // beta name — handled defensively (some gpt-realtime deployments
      // still emit it). Both carry the base64 chunk in `delta`.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) this.forwardOutboundAudio(delta);
        return;
      }

      // The caller started talking — barge-in. Tell 46elks to drop any
      // buffered playback so the agent stops mid-sentence.
      case 'input_audio_buffer.speech_started': {
        this.safeSend(this.elks, buildElksInterruptMessage() as unknown as Record<string, unknown>);
        return;
      }

      // Assistant speech transcript — accumulate, flush on response end.
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        if (typeof event.delta === 'string') this.assistantTranscript += event.delta;
        return;
      }

      case 'response.done':
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = this.assistantTranscript.trim();
        if (text) this.emitTranscript('agent', text);
        this.assistantTranscript = '';
        return;
      }

      // Caller speech transcription, when input transcription is on.
      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
        if (text) this.emitTranscript('provider', text, { speaker: 'caller' });
        return;
      }

      case 'error': {
        const errObj = (event.error && typeof event.error === 'object')
          ? event.error as Record<string, unknown>
          : {};
        const message = typeof errObj.message === 'string' ? errObj.message : 'unknown error';
        this.emitTranscript('system', `OpenAI Realtime error: ${message}`, { error: errObj });
        return;
      }

      default:
        return;
    }
  }

  /** Relay synthesised agent audio to 46elks, enforcing the size cap. */
  private forwardOutboundAudio(base64: string): void {
    if (base64.length > this.maxAudioFrameBase64) {
      this.noteDroppedFrame();
      return;
    }
    try {
      this.safeSend(this.elks, buildElksAudioMessage(base64) as unknown as Record<string, unknown>);
    } catch {
      // buildElksAudioMessage rejects non-base64 — drop the frame.
      this.noteDroppedFrame();
    }
  }

  // ─── Teardown ─────────────────────────────────────────

  /**
   * End the bridge. Idempotent — the first call wins, later calls are
   * no-ops. Sends `bye` to 46elks, closes both ports, fires `onEnd`.
   */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.droppedFrames > 0) {
      this.onTranscript?.({
        source: 'system',
        text: `Dropped ${this.droppedFrames} oversized/invalid audio frame(s) during the call.`,
      });
    }
    // Best-effort `bye` to 46elks, then close both sides.
    try { this.elks.send(buildElksByeMessage() as unknown as Record<string, unknown>); } catch { /* ignore */ }
    try { this.elks.close(); } catch { /* ignore */ }
    try { this.openai.close(); } catch { /* ignore */ }
    this.onEnd?.({ reason });
  }

  // ─── Internals ────────────────────────────────────────

  private noteDroppedFrame(): void {
    this.droppedFrames += 1;
    if (!this.droppedFramesReported) {
      this.droppedFramesReported = true;
      this.emitTranscript('system', 'An oversized or invalid audio frame was dropped (size cap enforced).');
    }
  }

  private emitTranscript(
    source: RealtimeBridgeTranscriptEntry['source'],
    text: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      this.onTranscript?.({ source, text, ...(metadata ? { metadata } : {}) });
    } catch {
      // A throwing transcript sink must never break the bridge.
    }
  }

  private safeSend(port: RealtimeBridgePort, message: Record<string, unknown>): void {
    try {
      port.send(message);
    } catch {
      // A dead socket throwing on send must not crash the bridge —
      // the matching close handler will tear things down cleanly.
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
