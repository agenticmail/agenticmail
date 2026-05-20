/**
 * Realtime voice bridge — wires the OpenAI Realtime API to a phone
 * carrier's realtime-media WebSocket so a phone mission can actually
 * *converse*.
 *
 * # Shape of the integration
 *
 *   caller  ⇄  carrier  ⇄  (carrier media WebSocket)  ⇄  AgenticMail
 *                                                         │
 *                                          RealtimeVoiceBridge
 *                                                         │
 *                                      (OpenAI Realtime WebSocket)
 *                                                         │
 *                                                   gpt-realtime
 *
 * The carrier streams the live call audio to AgenticMail as JSON frames
 * (base64 audio); AgenticMail relays them to OpenAI as
 * `input_audio_buffer.append`; OpenAI streams synthesised speech back
 * as `response.output_audio.delta`; AgenticMail relays that to the
 * carrier. Server-side VAD on the OpenAI session handles turn-taking —
 * no manual commit / response.create.
 *
 * # Provider-pluggable transport
 *
 * The carrier side speaks a provider-specific wire protocol — 46elks
 * (`hello`/`audio`/`bye`, linear PCM) and Twilio Media Streams
 * (`connected`/`start`/`media`/`stop`, G.711 µ-law). Those differences
 * are isolated behind a {@link RealtimeTransportAdapter}: the bridge
 * itself — OpenAI session lifecycle, function calling, barge-in,
 * transcript, teardown — is identical across providers and lives here
 * once. The bridge defaults to the 46elks adapter, so existing callers
 * that pass no `transport` keep their exact prior behaviour.
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
 * unit-testable without a live OpenAI key or a carrier websocket number.
 *
 * The exact OpenAI Realtime wire shapes below are the GA `gpt-realtime`
 * protocol (session config nested under `audio.input` / `audio.output`,
 * `format` as an object, `response.output_audio.delta` for output). The
 * legacy beta output event name `response.audio.delta` is also handled
 * defensively — some `gpt-realtime` deployments still emit it.
 */

import type { ElksRealtimeAudioFormat } from './realtime.js';
import {
  ElksRealtimeTransport,
  type RealtimeTransportAdapter,
} from './realtime-transport.js';
import {
  buildRealtimeToolGuidance,
  type RealtimeToolCall,
  type RealtimeToolDefinition,
  type ToolExecutor,
} from './realtime-tools.js';
// Value import for the runtime ceiling used by extendCallTime. mission.ts
// has no bridge imports, so this introduces no cycle.
import { PHONE_SERVER_MAX_CALL_DURATION_SECONDS } from './mission.js';

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

/**
 * Bridge-side safety net for a slow tool call (plan §6). The model-side
 * keeps the line warm (it announces a hold and reassures the caller);
 * this is the floor under that — if a tool's `execute()` never settles
 * (a hung `ask_operator`, a wedged search) the bridge still answers the
 * model after this long so the call cannot be wedged forever. It is set
 * deliberately ABOVE `OPERATOR_QUERY_TIMEOUT_MS` (5 min) so the tool's
 * own graceful timeout sentinel normally wins the race; this only fires
 * if the executor itself hangs.
 */
export const REALTIME_TOOL_CALL_TIMEOUT_MS = 6 * 60_000;

/**
 * Maximum number of skill playbooks the bridge will keep loaded into a
 * single Realtime session at once. Two is the sweet spot: it covers the
 * "primary skill + a complementary one" pattern (e.g. negotiate-bill
 * loaded for the main task + handle-supervisor-escalation loaded mid-
 * call), without diluting the model's working memory across competing
 * playbooks that may disagree on tactics or boundaries. A third load
 * FIFO-evicts the oldest — see {@link RealtimeVoiceBridge.loadSkillIntoSession}.
 */
export const MAX_LOADED_SKILLS = 2;

/**
 * Hard ceiling on how many tool calls the bridge will track in flight
 * at once. The model rarely fans out more than one or two; a flood is
 * either a buggy or a hostile peer, so excess calls are answered with a
 * refusal rather than dispatched.
 */
const MAX_IN_FLIGHT_TOOL_CALLS = 8;

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
  /**
   * Natural-language tool-use guidance, appended as its own section.
   * Normally produced by `buildRealtimeToolGuidance()` and folded in
   * automatically by `buildRealtimeSessionConfig()` when tools are set.
   */
  toolGuidance?: string;
  /**
   * v0.9.81 — when set, the agent gets an explicit "you have N minutes"
   * preamble so it can pace the conversation. Pulled into the
   * instructions even when the bridge itself isn't enforcing a soft
   * deadline (e.g. for downstream voice runtimes that consume the
   * same instructions string).
   */
  callBudget?: {
    /** Total budget for this call in seconds. */
    seconds: number;
    /**
     * True when extend_call_time + schedule_callback are wired to the
     * session. Toggles a separate "if you need more time" hint into
     * the preamble. False ⇒ the agent should manage strictly within
     * its budget.
     */
    extensionEnabled: boolean;
    callbackEnabled: boolean;
  };
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

  // v0.9.81 — time budget preamble. Drop in BEFORE tool guidance so
  // the agent reads "you have ~10 min" before learning the extend /
  // callback tools that act on that budget.
  const budget = opts.callBudget;
  if (budget && budget.seconds > 0) {
    const mins = Math.round(budget.seconds / 60);
    const human = mins >= 1 ? `about ${mins} minute(s)` : `${budget.seconds} seconds`;
    const tips: string[] = [];
    if (budget.extensionEnabled) {
      tips.push(
        'If you need more time, call extend_call_time({ seconds, reason }) BEFORE you run out. '
        + 'Auto-approved within the call\'s extension policy.',
      );
    }
    if (budget.callbackEnabled) {
      tips.push(
        'If you cannot finish in time, the caller wants you to ring back later, or the conversation '
        + 'naturally pauses for a follow-up, call schedule_callback({ delay_seconds, reason, '
        + 'summary_for_next_call }) BEFORE signing off. The next call automatically picks up with '
        + 'your summary and the transcript so far.',
      );
    }
    sections.push(
      `# Your time on this call\nYou have ${human} for this call. The system will quietly remind you `
      + 'at the 2-minute and 30-second marks — pace the conversation so you can wrap up cleanly.'
      + (tips.length > 0 ? '\n\n' + tips.join('\n') : ''),
    );
  }

  const toolGuidance = opts.toolGuidance?.trim();
  if (toolGuidance) {
    sections.push(toolGuidance);
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
  /**
   * Function tools to declare on the session. When present they are
   * emitted under `session.tools` with a `tool_choice`, and (unless
   * `instructions` is overridden) tool-use guidance is folded into the
   * composed instructions automatically.
   */
  tools?: RealtimeToolDefinition[];
  /** `tool_choice` override — defaults to `'auto'` when tools are set. */
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * OpenAI Realtime audio format for the session's input AND output.
   * Defaults to linear PCM @ 24 kHz (`{ type: 'audio/pcm', rate: 24000 }`)
   * — the format a 46elks `pcm_24000` call needs. A Twilio call must
   * pass `{ type: 'audio/pcmu', rate: 8000 }` (G.711 µ-law @ 8 kHz) so
   * the OpenAI session speaks the carrier's native codec with NO
   * transcoding. Normally sourced from a {@link RealtimeTransportAdapter}'s
   * `openaiAudioFormat`.
   */
  audioFormat?: { type: string; rate?: number };
}

/** Default OpenAI Realtime audio format — linear PCM @ 24 kHz (46elks). */
// OpenAI's current Realtime API rejects `session.audio.input.format.rate` with
// "Unknown parameter" — the format object is `{type}` only. `audio/pcm` is
// implicitly 24 kHz mono PCM16, `audio/pcmu` is implicitly 8 kHz G.711 µ-law.
export const DEFAULT_REALTIME_AUDIO_FORMAT = { type: 'audio/pcm' } as const;

/**
 * Build the `session.update` client event for the GA `gpt-realtime`
 * API. Audio in/out default to PCM16 @ 24 kHz (matches 46elks
 * `pcm_24000`); a Twilio call passes `audioFormat: { type: 'audio/pcmu',
 * rate: 8000 }` so the session speaks G.711 µ-law natively. Turn-taking
 * is server-side VAD, and the agent's memory is folded into
 * `instructions`.
 *
 * When `tools` are supplied they are declared under `session.tools`
 * with a `tool_choice` (default `'auto'`), and — unless the caller
 * passed an explicit `instructions` string — natural-language tool-use
 * guidance is appended to the composed instructions so the model knows
 * to put the caller on hold before a slow tool (plan §6).
 *
 * > The `session.tools` / `tool_choice` field names follow the OpenAI
 * > Realtime function-calling protocol per the plan §3, and the
 * > `audio/pcmu` µ-law format token follows the OpenAI GA Realtime
 * > audio-format protocol; verify both against current OpenAI docs
 * > before the live smoke test.
 */
export function buildRealtimeSessionConfig(
  opts: RealtimeSessionConfigOptions,
): Record<string, unknown> {
  const tools = opts.tools ?? [];
  // Fold tool-use guidance into the composed instructions — but only
  // when we are composing them; an explicit `instructions` override is
  // taken verbatim, the caller owns it.
  const instructions = (opts.instructions?.trim())
    || buildRealtimeInstructions({
      ...opts,
      toolGuidance: opts.toolGuidance ?? buildRealtimeToolGuidance(tools),
    });

  // Audio format shared by the session's input + output. The carrier's
  // codec drives this: 46elks → linear PCM @ 24 kHz, Twilio → µ-law @
  // 8 kHz. Matching it end to end means the bridge never transcodes.
  const audioFormat = opts.audioFormat ?? DEFAULT_REALTIME_AUDIO_FORMAT;

  const session: Record<string, unknown> = {
    type: 'realtime',
    model: opts.model?.trim() || DEFAULT_REALTIME_MODEL,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { ...audioFormat },
        turn_detection: { type: 'server_vad' },
      },
      output: {
        format: { ...audioFormat },
        voice: opts.voice?.trim() || DEFAULT_REALTIME_VOICE,
      },
    },
  };

  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = opts.toolChoice ?? 'auto';
  }

  return { type: 'session.update', session };
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
  /**
   * Port to the carrier realtime-media side. Named `elks` for backward
   * compatibility (it predates the Twilio transport); `carrier` is the
   * provider-neutral alias and takes precedence if both are given.
   */
  elks?: RealtimeBridgePort;
  /** Provider-neutral alias for {@link elks} — the carrier media port. */
  carrier?: RealtimeBridgePort;
  /** Port to the OpenAI Realtime side. */
  openai: RealtimeBridgePort;
  /** `session.update` payload — sent to OpenAI once its socket opens. */
  sessionConfig: Record<string, unknown>;
  /**
   * Carrier transport adapter — encodes/decodes the provider's wire
   * protocol (46elks vs Twilio Media Streams). Defaults to the 46elks
   * adapter, so callers that omit it keep the original behaviour.
   */
  transport?: RealtimeTransportAdapter;
  /**
   * 46elks-only: audio format we ask 46elks to send us (default
   * `pcm_24000`). Ignored unless the default 46elks transport is used
   * and no explicit `transport` was supplied.
   */
  listenFormat?: ElksRealtimeAudioFormat;
  /**
   * 46elks-only: audio format we declare for the audio we send 46elks
   * (default `pcm_24000`). Ignored unless the default 46elks transport
   * is used and no explicit `transport` was supplied.
   */
  sendFormat?: ElksRealtimeAudioFormat;
  /** Per-frame base64 ceiling (default {@link REALTIME_MAX_AUDIO_FRAME_BASE64}). */
  maxAudioFrameBase64?: number;
  /**
   * Dispatches the model's function calls. When omitted the bridge has
   * no tools — a function call from the model is acknowledged with a
   * "no tools available" output rather than left to wedge the model.
   */
  toolExecutor?: ToolExecutor;
  /**
   * Bridge-side safety-net timeout for a single tool call (default
   * {@link REALTIME_TOOL_CALL_TIMEOUT_MS}). If the executor does not
   * settle within this window the bridge answers the model itself so
   * the call cannot be wedged by a hung tool.
   */
  maxToolCallMs?: number;
  /** Sink for transcript / lifecycle entries worth persisting on the mission. */
  onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  /**
   * Called exactly once when the bridge has fully ended. `pendingToolCalls`
   * is how many tool calls were still in flight at teardown — non-zero
   * means the call dropped mid-tool (e.g. an unanswered `ask_operator`),
   * which is the signal the API layer uses to arm callback-on-disconnect
   * (plan §7). `endedByTimeBudget` is true when the bridge itself ended
   * the call because the soft deadline elapsed and the grace period
   * expired — the API layer uses this to log a different teardown
   * reason and to skip "callback flagged" if the agent already used
   * `schedule_callback` itself.
   */
  onEnd?: (summary: { reason: string; pendingToolCalls: number; endedByTimeBudget?: boolean }) => void;
  /**
   * NEW in v0.9.81 — initial soft time budget for the call, in seconds.
   * When set, the bridge schedules a graceful-end timer with reminders
   * (T-120s, T-30s) and a final 30s grace window after the budget
   * elapses. The carrier-level hard cap (Twilio `TimeLimit` / 46elks
   * `timeout`) still applies on top; this is the AGENT's view of how
   * long it has, which it can grow via {@link extendCallTime}.
   * Omitted ⇒ no bridge-level timer (legacy behaviour).
   */
  callBudgetSeconds?: number;
  /**
   * NEW in v0.9.81 — extension policy for {@link extendCallTime}. When
   * the agent asks for more time, every request is auto-approved up to
   * these caps. Omitted ⇒ extensions are denied.
   */
  extensionPolicy?: import('./mission.js').PhoneExtensionPolicy;
  /**
   * NEW in v0.9.81 — callback policy for {@link scheduleCallback}.
   * Omitted ⇒ scheduled callbacks are denied.
   */
  callbackPolicy?: import('./mission.js').PhoneCallbackPolicy;
  /**
   * NEW in v0.9.81 — fires when the agent calls schedule_callback and the
   * bridge has approved it against the policy. The API layer persists
   * the request to mission metadata and the scheduler dials the
   * callback when the requested `at` timestamp arrives. `priorContext`
   * is the model-supplied summary plus a system-built transcript
   * digest the bridge composed at request-time.
   */
  onCallbackScheduled?: (req: ScheduledCallbackRequest) => void;
  /**
   * NEW in v0.9.81 — injectable wall-clock + timer functions so unit
   * tests can fast-forward the deadline without sleeping. Defaults to
   * the real `Date.now` / `setTimeout` / `clearTimeout`.
   */
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Captures everything the API layer needs to honour a `schedule_callback`
 * tool call: when to dial, why, what the model wants to remember about
 * the conversation so far, and a transcript digest the bridge composed
 * at the moment of the request. The digest is the "context from the
 * previous call" the operator asked for — without it, the next call's
 * agent would start cold.
 */
export interface ScheduledCallbackRequest {
  /** Wall-clock ISO timestamp when the callback should fire. */
  at: string;
  /** Free-text reason from the agent (transcribed verbatim to logs). */
  reason: string;
  /**
   * The agent's own summary of what the next-call agent should know.
   * Trimmed to {@link MAX_CALLBACK_SUMMARY_LENGTH} chars.
   */
  agentSummary: string;
  /**
   * System-built digest of the assistant + system transcript so far,
   * trimmed to {@link MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH} chars.
   * The next call sees this verbatim under "# What you said before".
   */
  transcriptDigest: string;
}

/** Hard cap on the model-provided callback summary. */
export const MAX_CALLBACK_SUMMARY_LENGTH = 1500;
/** Hard cap on the bridge-built transcript digest carried into the callback. */
export const MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH = 2500;
/**
 * Reminder marks (seconds remaining) that trigger a system-message
 * injection telling the agent "you have ~N left, start wrapping up".
 * Sorted descending so the soonest-to-fire is last. Any mark less than
 * 5 seconds is suppressed (too close to the grace window to be useful).
 */
export const CALL_BUDGET_REMINDER_MARKS_SECONDS = [120, 30] as const;
/**
 * How long after the soft deadline the agent has to wrap up before the
 * bridge ends the call itself. Long enough to say goodbye, short
 * enough that the operator isn't paying for a runaway model.
 */
export const CALL_BUDGET_GRACE_SECONDS = 30;

/**
 * Bridges a phone carrier's realtime-media connection to an OpenAI
 * Realtime connection. Provider-pluggable: the carrier wire protocol
 * (46elks vs Twilio Media Streams) is isolated in a
 * {@link RealtimeTransportAdapter}; the conversation logic here is
 * provider-neutral. The caller pumps raw messages in via
 * `handleCarrierMessage` / `handleOpenAIMessage` and connection
 * lifecycle via `handle*Open` / `handle*Close`. Every public method is
 * safe to call after the bridge has ended (they become no-ops).
 *
 * The legacy `handleElks*` method names remain as thin aliases for the
 * `handleCarrier*` methods so existing 46elks call sites and tests do
 * not break.
 */
export class RealtimeVoiceBridge {
  private readonly carrier: RealtimeBridgePort;
  private readonly openai: RealtimeBridgePort;
  private readonly sessionConfig: Record<string, unknown>;
  private readonly transport: RealtimeTransportAdapter;
  private readonly maxAudioFrameBase64: number;
  private readonly toolExecutor?: ToolExecutor;
  private readonly maxToolCallMs: number;
  private readonly onTranscript?: (entry: RealtimeBridgeTranscriptEntry) => void;
  private readonly onEnd?: (summary: { reason: string; pendingToolCalls: number; endedByTimeBudget?: boolean }) => void;

  /** Injectable clock + timers (tests substitute fakes). */
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  /** v0.9.81 — extension / callback state. */
  private readonly extensionPolicy?: import('./mission.js').PhoneExtensionPolicy;
  private readonly callbackPolicy?: import('./mission.js').PhoneCallbackPolicy;
  private readonly onCallbackScheduled?: (req: ScheduledCallbackRequest) => void;
  /** Initial soft budget, in seconds. 0 = no bridge-side timer (legacy). */
  private readonly initialBudgetSeconds: number;
  /** Wall-clock ms when the call started, set on first carrier hello. */
  private callStartedAtMs: number | null = null;
  /** Wall-clock ms when the soft deadline fires. Bumped by extensions. */
  private softDeadlineMs: number | null = null;
  /** Soft-end timer (fires once, then schedules the grace timer). */
  private softEndTimer: ReturnType<typeof setTimeout> | null = null;
  /** Final hard-end timer that fires after the grace window. */
  private graceEndTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reminder timers for the T-N marks. Cleared/re-armed on extensions. */
  private reminderTimers: ReturnType<typeof setTimeout>[] = [];
  /** Marks (in seconds-remaining) we've already fired this call. Dedup
   *  prevents re-injecting the same reminder after an extension if the
   *  new deadline still has us past the same mark. */
  private firedReminderMarks = new Set<number>();
  /** Count of extensions granted this call. */
  private extensionsUsed = 0;
  /** Total extra seconds granted across all extensions this call. */
  private extensionSecondsUsed = 0;
  /** True once the agent's schedule_callback request was accepted. */
  private callbackArmed = false;
  /** Captured for the API layer when the soft deadline fires. */
  private endedByTimeBudgetFlag = false;
  /**
   * Sliding window of recent assistant + system utterances, used to
   * build the transcript digest carried into a scheduled callback.
   * Capped at {@link MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH} chars so
   * the digest itself can always be produced cheaply even on a long
   * call.
   */
  private readonly recentUtterances: string[] = [];

  /** Carrier `hello`/`start` received — the call leg is live. */
  private helloSeen = false;
  /** OpenAI socket open + `session.update` sent. */
  private openaiReady = false;
  /** Bridge has ended — all further input is ignored. */
  private ended = false;
  /** Carrier call id from the `hello` event (46elks `callid` / Twilio `callSid`). */
  private callId = '';
  /** Audio frames received before OpenAI was ready, flushed on open. */
  private readonly pendingAudio: string[] = [];
  /** Oversized-frame counter — reported once, not per frame. */
  private droppedFrames = 0;
  private droppedFramesReported = false;
  /** Accumulated assistant speech transcript for the current response. */
  private assistantTranscript = '';
  /**
   * Function-call name keyed by `call_id`, captured from
   * `response.output_item.added`. The later `*.arguments.done` event is
   * not guaranteed to echo the tool name, so we remember it here.
   */
  private readonly toolCallNames = new Map<string, string>();
  /** `call_id`s whose tool call is currently executing. */
  private readonly inFlightToolCalls = new Set<string>();

  /**
   * Mid-call skills loaded into the session so far, FIFO. Earliest at
   * index 0; cap at {@link MAX_LOADED_SKILLS}. When a (cap+1)th skill
   * is loaded the oldest one drops out — the model can't usefully
   * hold five playbooks in working memory at once, so we keep the
   * working set narrow on purpose.
   */
  private readonly loadedSkills: Array<{ id: string; version: string; renderedPrompt: string }> = [];

  /**
   * The original `instructions` string from the session.update sent at
   * open. We keep a private copy because every mid-call skill load
   * issues a fresh `session.update` whose `instructions` is built as:
   *
   *     baseInstructions + "\n\n" + renderedSkill1 + "\n\n" + renderedSkill2 …
   *
   * Without this snapshot, successive loads would compound — the second
   * load would see "base + skill1" as the base and append skill2 to
   * THAT, eventually drifting unboundedly.
   */
  private baseInstructions = '';

  constructor(opts: RealtimeVoiceBridgeOptions) {
    const carrier = opts.carrier ?? opts.elks;
    if (!carrier) {
      throw new Error('RealtimeVoiceBridge requires a carrier (or elks) port');
    }
    this.carrier = carrier;
    this.openai = opts.openai;
    this.sessionConfig = opts.sessionConfig;
    // Default to the 46elks transport so callers that pass no `transport`
    // keep their exact prior behaviour. The 46elks `listen`/`send` format
    // options only apply to that default adapter.
    this.transport = opts.transport
      ?? new ElksRealtimeTransport(opts.listenFormat ?? 'pcm_24000', opts.sendFormat ?? 'pcm_24000');
    this.maxAudioFrameBase64 = opts.maxAudioFrameBase64 ?? REALTIME_MAX_AUDIO_FRAME_BASE64;
    this.toolExecutor = opts.toolExecutor;
    this.maxToolCallMs = opts.maxToolCallMs ?? REALTIME_TOOL_CALL_TIMEOUT_MS;
    this.onTranscript = opts.onTranscript;
    this.onEnd = opts.onEnd;
    // v0.9.81 — call-budget / extension / callback wiring. All optional;
    // defaults preserve the pre-0.9.81 behaviour (no bridge timer, no
    // extension/callback tools active).
    this.nowFn = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.initialBudgetSeconds = opts.callBudgetSeconds && opts.callBudgetSeconds > 0
      ? Math.floor(opts.callBudgetSeconds)
      : 0;
    this.extensionPolicy = opts.extensionPolicy;
    this.callbackPolicy = opts.callbackPolicy;
    this.onCallbackScheduled = opts.onCallbackScheduled;
  }

  /** True once the bridge has ended. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** The carrier call id, once the `hello`/`start` event has been seen. */
  get currentCallId(): string {
    return this.callId;
  }

  /** The carrier transport provider this bridge is running for. */
  get provider(): string {
    return this.transport.provider;
  }

  /** How many tool calls are executing right now. */
  get pendingToolCalls(): number {
    return this.inFlightToolCalls.size;
  }

  // ─── OpenAI side lifecycle ────────────────────────────

  /** Call when the OpenAI socket opens — sends `session.update`. */
  handleOpenAIOpen(): void {
    if (this.ended || this.openaiReady) return;
    this.openaiReady = true;
    // Snapshot the base instructions BEFORE sending so future
    // mid-call `loadSkillIntoSession` calls can rebuild the merged
    // instructions string against an unchanging baseline. The
    // sessionConfig shape is `{ type: 'session.update', session:
    // {..., instructions: '...'} }` — extract carefully and fall
    // back to the empty string if the shape ever drifts.
    const sess = (this.sessionConfig as any)?.session;
    if (sess && typeof sess.instructions === 'string') {
      this.baseInstructions = sess.instructions;
    }
    this.safeSend(this.openai, this.sessionConfig);
    // Kick the model to speak first. This is an outbound call — the agent is
    // calling the operator — so the agent should greet, not wait for the
    // caller. With `server_vad` turn_detection, OpenAI does not emit a
    // response until the user speaks, unless we explicitly create one.
    this.safeSend(this.openai, { type: 'response.create' });
    // Flush any audio that arrived during the connect window.
    for (const audio of this.pendingAudio.splice(0)) {
      this.safeSend(this.openai, { type: 'input_audio_buffer.append', audio });
    }
  }

  /** Call when the OpenAI socket closes. */
  handleOpenAIClose(): void {
    this.end('openai-closed');
  }

  /**
   * Load a skill playbook into the live OpenAI Realtime session for
   * the rest of the call.
   *
   * Mechanics:
   *   1. Resolve the skill JSON via the skills registry (file on disk).
   *   2. Append the rendered skill text to the agent's working
   *      instructions and re-send a `session.update` carrying ONLY
   *      the new `instructions` field. The OpenAI Realtime API
   *      supports partial session.update — we don't have to re-send
   *      audio config, tools, voice, etc.
   *   3. Track which skills are loaded so we (a) FIFO-evict the
   *      oldest when the cap is hit and (b) include every still-
   *      loaded skill in the next composed instructions.
   *   4. Emit a transcript marker so the mission record shows the
   *      adaptation ("[skill loaded: Negotiate a Bill Reduction
   *      v1.0.0]"). Useful for post-call review and for the build
   *      farm's telemetry on which skills actually got reached for.
   *
   * Returns an object the {@link load_skill} tool handler can serialise
   * back to the model: `ok: true` plus the skill name + version on
   * success, `ok: false` plus a short reason on failure (unknown id,
   * call ended, registry I/O error). Never throws — a buggy registry
   * or a missing file must not crash the bridge mid-call.
   *
   * Phase 2 of the skill library (`docs/skill-library-plan.md`).
   */
  async loadSkillIntoSession(skillId: string): Promise<{ ok: boolean; message: string; name?: string; version?: string }> {
    if (this.ended) return { ok: false, message: 'Call has already ended; cannot load a skill now.' };
    if (!this.openaiReady) return { ok: false, message: 'Session is not ready yet; try again in a moment.' };

    // De-dup — loading the same skill twice is a no-op success. Don't
    // grow the loaded-list and don't re-issue session.update; nothing
    // would change.
    if (this.loadedSkills.some((s) => s.id === skillId)) {
      const existing = this.loadedSkills.find((s) => s.id === skillId)!;
      return { ok: true, message: `Skill "${skillId}" is already loaded.`, name: skillId, version: existing.version };
    }

    // Dynamic import — `../skills/index.js` is a sibling subpackage
    // within @agenticmail/core. Static `import` would pull skills into
    // every build of the phone module even for deployments that never
    // use them; dynamic keeps the dependency cost on-demand only.
    let loadSkill: typeof import('../skills/index.js').loadSkill;
    let renderSkillAsPrompt: typeof import('../skills/index.js').renderSkillAsPrompt;
    try {
      ({ loadSkill, renderSkillAsPrompt } = await import('../skills/index.js'));
    } catch (err) {
      return { ok: false, message: `Skill registry unavailable: ${errorText(err)}` };
    }

    const skill = loadSkill(skillId);
    if (!skill) {
      return { ok: false, message: `No skill found with id "${skillId}". Call search_skills first to find the right id.` };
    }

    const rendered = renderSkillAsPrompt(skill);

    // FIFO-evict the oldest loaded skill when we'd exceed the cap.
    // Two concurrent playbooks is plenty; three diverges fast.
    while (this.loadedSkills.length >= MAX_LOADED_SKILLS) {
      const dropped = this.loadedSkills.shift();
      if (dropped) {
        this.emitTranscript('system', `[skill unloaded for working-memory limit: ${dropped.id} v${dropped.version}]`);
      }
    }
    this.loadedSkills.push({ id: skill.id, version: skill.version, renderedPrompt: rendered });

    // Compose the new instructions = original baseline + every loaded
    // skill, in load order. Re-issue session.update with ONLY the
    // instructions field (partial update — saves the round-trip cost
    // of re-sending audio config etc).
    const composed = [
      this.baseInstructions,
      ...this.loadedSkills.map((s) => s.renderedPrompt),
    ].filter((s) => s && s.length > 0).join('\n\n');
    this.safeSend(this.openai, {
      type: 'session.update',
      session: { instructions: composed },
    });

    this.emitTranscript('system', `[skill loaded: ${skill.name} v${skill.version}]`);
    return { ok: true, message: `Loaded skill: ${skill.name} (v${skill.version})`, name: skill.name, version: skill.version };
  }

  /** The list of skills currently loaded into the session (FIFO-ordered). */
  get loadedSkillIds(): readonly string[] {
    return this.loadedSkills.map((s) => s.id);
  }

  /** Call when the OpenAI socket errors. */
  handleOpenAIError(err: unknown): void {
    this.emitTranscript('system', `OpenAI Realtime error: ${errorText(err)}`);
    this.end('openai-error');
  }

  // ─── Carrier side lifecycle ───────────────────────────

  /**
   * Call when the carrier media socket closes. The `onEnd` reason is
   * `<prefix>-closed`, where the prefix comes from the transport adapter
   * (`elks` for 46elks, `twilio` for Twilio) — so historical 46elks
   * reason strings (`elks-closed`) are preserved.
   */
  handleCarrierClose(): void {
    this.end(`${this.transport.endReasonPrefix}-closed`);
  }

  /** Call when the carrier media socket errors. */
  handleCarrierError(err: unknown): void {
    this.emitTranscript('system', `${this.transport.provider} media error: ${errorText(err)}`);
    this.end(`${this.transport.endReasonPrefix}-error`);
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierClose}. */
  handleElksClose(): void {
    this.handleCarrierClose();
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierError}. */
  handleElksError(err: unknown): void {
    this.handleCarrierError(err);
  }

  // ─── Carrier → OpenAI ─────────────────────────────────

  /**
   * Feed one raw message from the carrier media socket. Accepts a JSON
   * string or an already-parsed object. The transport adapter
   * normalises the provider-specific frame; malformed frames throw out
   * of the adapter and are ignored here (the bridge is never torn down
   * for one bad frame).
   */
  handleCarrierMessage(raw: string | Record<string, unknown>): void {
    if (this.ended) return;
    let event;
    try {
      event = this.transport.parseInbound(raw);
    } catch {
      // Unknown / malformed carrier frame — ignore, do not tear down.
      return;
    }

    if (event.kind === 'hello') {
      if (this.helloSeen) return; // one hello per call leg
      this.helloSeen = true;
      this.callId = event.callId;
      // Send any carrier-side handshake (46elks negotiates audio
      // formats; Twilio needs nothing — its handshake list is empty).
      for (const handshake of this.transport.buildHandshake()) {
        this.safeSend(this.carrier, handshake);
      }
      this.emitTranscript('system', 'Realtime voice bridge connected — live conversation started.', {
        provider: this.transport.provider,
        callId: this.callId,
        from: event.from,
        to: event.to,
      });
      // v0.9.81 — arm the call-budget timers as soon as we know the call
      // is live. Hello is the right moment: the carrier has answered,
      // the model is about to speak, and any earlier arming would have
      // counted setup latency against the agent's budget.
      this.startCallBudget();
      return;
    }

    if (event.kind === 'audio') {
      this.forwardInboundAudio(event.data);
      return;
    }

    if (event.kind === 'bye') {
      this.emitTranscript('system', 'Caller side ended the call.', {
        reason: event.reason,
        message: event.message,
      });
      this.end(`${this.transport.endReasonPrefix}-bye`);
      return;
    }

    // event.kind === 'ignore' — a known-but-uninteresting carrier frame.
  }

  /** @deprecated 46elks-era alias for {@link handleCarrierMessage}. */
  handleElksMessage(raw: string | Record<string, unknown>): void {
    this.handleCarrierMessage(raw);
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

      // The caller started talking — barge-in. Tell the carrier to drop
      // any buffered playback so the agent stops mid-sentence (46elks
      // `interrupt` / Twilio `clear`).
      case 'input_audio_buffer.speech_started': {
        this.safeSend(this.carrier, this.transport.buildInterrupt());
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
        if (text) {
          this.emitTranscript('agent', text);
          // Capture for the callback transcript digest. We tag with
          // role so the next call's continuation prompt can render
          // "Agent: ..." / "Caller: ..." in the digest.
          this.noteUtterance(`Agent: ${text}`);
        }
        this.assistantTranscript = '';
        return;
      }

      // Caller speech transcription, when input transcription is on.
      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
        if (text) {
          this.emitTranscript('provider', text, { speaker: 'caller' });
          this.noteUtterance(`Caller: ${text}`);
        }
        return;
      }

      // A new output item was added to the response. When it is a
      // function call we capture `name` keyed by `call_id` here, because
      // the later `response.function_call_arguments.done` event is not
      // guaranteed to echo the tool name.
      case 'response.output_item.added': {
        const item = asRecord(event.item);
        if (item.type === 'function_call') {
          const callId = asString(item.call_id);
          const name = asString(item.name);
          if (callId && name) this.toolCallNames.set(callId, name);
        }
        return;
      }

      // Streamed function-call arguments. GA emits a `.delta` stream
      // then a single `.done` carrying the complete `arguments` JSON
      // string — we dispatch on `.done` and ignore the deltas.
      //
      // > Event names (`response.function_call_arguments.delta` /
      // > `.done`) and the `{ call_id, name, arguments }` fields follow
      // > the OpenAI Realtime function-calling protocol per the plan §3.
      // > Verify against current OpenAI docs before the live smoke test
      // > (same discipline as `response.output_audio.delta` in v0.9.52).
      case 'response.function_call_arguments.delta':
        return;
      case 'response.function_call_arguments.done': {
        this.dispatchToolCall(event);
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

  /** Relay synthesised agent audio to the carrier, enforcing the size cap. */
  private forwardOutboundAudio(base64: string): void {
    if (base64.length > this.maxAudioFrameBase64) {
      this.noteDroppedFrame();
      return;
    }
    try {
      this.safeSend(this.carrier, this.transport.buildAudio(base64));
    } catch {
      // The adapter rejects non-base64 (or a Twilio frame before its
      // streamSid is known) — drop the frame rather than crash.
      this.noteDroppedFrame();
    }
  }

  // ─── Function calling ─────────────────────────────────

  /**
   * Parse a `response.function_call_arguments.done` event and dispatch
   * the tool call. Resolves `name` from the event or the map captured
   * on `response.output_item.added`; parses `arguments` (a JSON string)
   * defensively. Always answers the model — an unknown name, missing
   * executor, or oversized fan-out each gets a model-readable output
   * rather than being dropped (a dropped `call_id` wedges the model,
   * which waits forever for its `function_call_output`).
   */
  private dispatchToolCall(event: Record<string, unknown>): void {
    const callId = asString(event.call_id);
    if (!callId) return; // cannot answer a call with no id — nothing to key on
    const name = asString(event.name) || this.toolCallNames.get(callId) || '';

    if (this.inFlightToolCalls.has(callId)) return; // duplicate `.done` — ignore

    if (!name) {
      this.answerToolCall(callId, 'Tool call ignored — no tool name was provided.');
      return;
    }
    if (!this.toolExecutor) {
      this.answerToolCall(callId, `No tools are available on this call, so "${name}" cannot run.`);
      return;
    }
    if (this.inFlightToolCalls.size >= MAX_IN_FLIGHT_TOOL_CALLS) {
      this.answerToolCall(callId, `Too many tool calls are already in flight; "${name}" was refused.`);
      return;
    }

    const args = parseToolArguments(event.arguments);
    this.inFlightToolCalls.add(callId);
    this.emitTranscript('system', `Tool call: ${name}`, { callId, arguments: args });
    void this.runToolCall({ callId, name, arguments: args });
  }

  /** Execute one tool call, racing the executor against the safety-net timeout. */
  private async runToolCall(call: RealtimeToolCall): Promise<void> {
    let output: string;
    try {
      const result = await withTimeout(
        Promise.resolve(this.toolExecutor!.execute(call)),
        this.maxToolCallMs,
      );
      output = result.output;
    } catch (err) {
      // The executor itself never rejects (createToolExecutor catches),
      // so reaching here means the safety-net timeout fired — the tool
      // hung. Give the model something it can gracefully recover from.
      output = `The "${call.name}" tool did not finish in time (${errorText(err)}). `
        + 'Tell the caller you could not complete that just now and will follow up.';
    }
    this.inFlightToolCalls.delete(call.callId);
    this.toolCallNames.delete(call.callId);
    // The call may have ended while the tool ran (caller hung up). The
    // OpenAI socket is gone — sending a result would throw; and an
    // unanswered query is exactly what arms callback-on-disconnect.
    if (this.ended) return;
    this.emitTranscript('system', `Tool result: ${truncate(output, 240)}`, { callId: call.callId });
    this.answerToolCall(call.callId, output);
  }

  /**
   * Send a tool result back to OpenAI: a `function_call_output`
   * conversation item, then `response.create` so the model resumes
   * speaking with the result in hand.
   *
   * > `conversation.item.create` with `{ type: 'function_call_output',
   * > call_id, output }` followed by `response.create` is the OpenAI
   * > Realtime function-calling return path per the plan §3. Verify
   * > against current OpenAI docs before the live smoke test.
   */
  private answerToolCall(callId: string, output: string): void {
    this.safeSend(this.openai, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.safeSend(this.openai, { type: 'response.create' });
  }

  // ─── Call-budget timers / extensions / callback (v0.9.81) ─────────

  /** True if the agent's `schedule_callback` request has been accepted. */
  get isCallbackArmed(): boolean {
    return this.callbackArmed;
  }

  /**
   * Seconds remaining on the current soft deadline, floored at 0. Returns
   * the initial budget if hello hasn't fired yet, and `Infinity` if no
   * call budget was configured (legacy mode). Used by `get_call_status`.
   */
  getTimeRemainingSeconds(): number {
    if (this.initialBudgetSeconds <= 0) return Number.POSITIVE_INFINITY;
    if (this.callStartedAtMs == null || this.softDeadlineMs == null) {
      return this.initialBudgetSeconds;
    }
    return Math.max(0, Math.ceil((this.softDeadlineMs - this.nowFn()) / 1000));
  }

  /**
   * Public extension state snapshot for `get_call_status`. Each value is
   * "what the agent has left" so the model can decide whether to call
   * `extend_call_time` at all — exposing both the per-request cap AND
   * the remaining budget makes greedy / unbounded extension attempts
   * impossible.
   */
  getExtensionStatus(): {
    extensionsUsed: number;
    extensionsRemaining: number;
    secondsUsedSoFar: number;
    secondsAvailable: number;
    maxSecondsPerRequest: number;
  } {
    const pol = this.extensionPolicy;
    if (!pol) {
      return {
        extensionsUsed: 0,
        extensionsRemaining: 0,
        secondsUsedSoFar: 0,
        secondsAvailable: 0,
        maxSecondsPerRequest: 0,
      };
    }
    return {
      extensionsUsed: this.extensionsUsed,
      extensionsRemaining: Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed),
      secondsUsedSoFar: this.extensionSecondsUsed,
      secondsAvailable: Math.max(0, pol.maxTotalExtensionSeconds - this.extensionSecondsUsed),
      maxSecondsPerRequest: pol.maxSecondsPerRequest,
    };
  }

  /**
   * Grant (or refuse) more time on the call. Auto-approved within all
   * three policy caps; the granted amount is the min of:
   *
   *   - the agent's requested seconds (positive integer, clamped > 0)
   *   - policy.maxSecondsPerRequest
   *   - policy.maxTotalExtensionSeconds − seconds already granted
   *
   * AND we won't push the new deadline past the hard ceiling
   * (PHONE_SERVER_MAX_CALL_DURATION_SECONDS from call start). The
   * returned shape always includes a model-readable `reason` so a
   * partial grant ("you asked for 5 min, you got 2 min") doesn't
   * confuse the agent.
   *
   * Failure modes (granted: 0):
   *   - no extension policy on this call
   *   - max requests already used
   *   - max total seconds already used
   *   - call already ended
   *   - non-positive `seconds`
   */
  extendCallTime(requestedSeconds: number, reason?: string): {
    granted: boolean;
    secondsGranted: number;
    secondsRemaining: number;
    extensionsRemaining: number;
    message: string;
  } {
    if (this.ended) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: 0,
        extensionsRemaining: 0,
        message: 'The call has already ended; no more extensions can be granted.',
      };
    }
    const pol = this.extensionPolicy;
    if (!pol) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: this.getTimeRemainingSeconds(),
        extensionsRemaining: 0,
        message: 'Extensions are not enabled for this call.',
      };
    }
    if (this.initialBudgetSeconds <= 0 || this.softDeadlineMs == null || this.callStartedAtMs == null) {
      // No active soft-budget timer — nothing to extend. (Shouldn't
      // happen in practice if hello has fired, but the guard keeps the
      // bridge honest if a caller sets extensionPolicy without a budget.)
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: Number.POSITIVE_INFINITY,
        extensionsRemaining: pol.maxRequestsPerCall - this.extensionsUsed,
        message: 'This call has no soft time budget, so extensions are a no-op.',
      };
    }
    if (this.extensionsUsed >= pol.maxRequestsPerCall) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: this.getTimeRemainingSeconds(),
        extensionsRemaining: 0,
        message: `Out of extensions — already used ${pol.maxRequestsPerCall}/${pol.maxRequestsPerCall} this call. Wrap up or schedule a callback.`,
      };
    }
    const remainingBudgetSeconds = Math.max(0, pol.maxTotalExtensionSeconds - this.extensionSecondsUsed);
    if (remainingBudgetSeconds <= 0) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: this.getTimeRemainingSeconds(),
        extensionsRemaining: Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed),
        message: `Out of extension time — already granted ${this.extensionSecondsUsed}s of the ${pol.maxTotalExtensionSeconds}s cap.`,
      };
    }
    const asked = Math.floor(requestedSeconds);
    if (!Number.isFinite(asked) || asked <= 0) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: this.getTimeRemainingSeconds(),
        extensionsRemaining: Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed),
        message: 'extend_call_time requires a positive integer number of seconds.',
      };
    }

    // Compute the granted amount: bounded by (1) requested, (2) per-
    // request cap, (3) total remaining cap, (4) hard call-duration
    // ceiling. Whichever is smallest wins.
    let granted = Math.min(asked, pol.maxSecondsPerRequest, remainingBudgetSeconds);
    const elapsedSeconds = Math.floor((this.nowFn() - this.callStartedAtMs) / 1000);
    const hardCeilingRoom = Math.max(
      0,
      PHONE_SERVER_MAX_CALL_DURATION_SECONDS - (elapsedSeconds + this.getTimeRemainingSeconds()),
    );
    granted = Math.min(granted, hardCeilingRoom);
    if (granted <= 0) {
      return {
        granted: false,
        secondsGranted: 0,
        secondsRemaining: this.getTimeRemainingSeconds(),
        extensionsRemaining: Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed),
        message: 'No extension granted — the call is already at the hard duration ceiling.',
      };
    }

    // Commit the grant: push the deadline + re-arm timers + log.
    this.extensionsUsed += 1;
    this.extensionSecondsUsed += granted;
    this.softDeadlineMs = this.softDeadlineMs + granted * 1000;
    this.rearmBudgetTimers();
    this.emitTranscript('system', `Granted ${granted}s extension (#${this.extensionsUsed}). Reason: ${truncate(asString(reason) || 'unspecified', 120)}`, {
      extensionsUsed: this.extensionsUsed,
      extensionSecondsUsed: this.extensionSecondsUsed,
      softDeadlineMs: this.softDeadlineMs,
    });

    return {
      granted: true,
      secondsGranted: granted,
      secondsRemaining: this.getTimeRemainingSeconds(),
      extensionsRemaining: Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed),
      message: `Granted ${granted} more seconds (${this.getTimeRemainingSeconds()}s now remaining). ${Math.max(0, pol.maxRequestsPerCall - this.extensionsUsed)} extension(s) left after this one.`,
    };
  }

  /**
   * Capture the agent's `schedule_callback` request. The bridge VALIDATES
   * (policy allows it, delay is in the legal window, summary present),
   * builds a transcript digest from {@link recentUtterances}, then fires
   * {@link onCallbackScheduled} so the API layer can persist + arm the
   * scheduler. The bridge does NOT itself dial — that's the scheduler's
   * job, fired at the requested wall-clock time.
   *
   * Returning `{ accepted: true }` arms `isCallbackArmed`, which the
   * end-of-call path uses to skip the legacy operator-query callback
   * flag (the agent has already declared its own follow-up plan).
   */
  scheduleCallback(req: {
    delaySeconds: number;
    reason?: string;
    summary: string;
  }): { accepted: boolean; at?: string; message: string } {
    if (this.ended) {
      return { accepted: false, message: 'Cannot schedule a callback — the call has already ended.' };
    }
    if (this.callbackArmed) {
      return { accepted: false, message: 'A callback has already been scheduled for this call. Stick with that plan.' };
    }
    const pol = this.callbackPolicy;
    if (!pol || !pol.allowAutoCallback || pol.maxCallbackChain <= 0) {
      return {
        accepted: false,
        message: 'Auto-callbacks are disabled by policy on this call. Tell the caller you will follow up another way.',
      };
    }
    const delay = Math.floor(req.delaySeconds);
    // PHONE_CALLBACK_MIN_DELAY_SECONDS / _MAX_ pulled in by literal —
    // avoids a circular import between bridge + mission.
    const minDelay = 30;
    const maxDelay = 7 * 24 * 60 * 60;
    if (!Number.isFinite(delay) || delay < minDelay) {
      return {
        accepted: false,
        message: `Callbacks must be scheduled at least ${minDelay}s in the future.`,
      };
    }
    if (delay > maxDelay) {
      return {
        accepted: false,
        message: `Callbacks must be scheduled within ${Math.floor(maxDelay / 86400)} days.`,
      };
    }
    const summary = asString(req.summary);
    if (!summary) {
      return {
        accepted: false,
        message: 'schedule_callback requires a non-empty `summary` for the next call to pick up from.',
      };
    }

    const at = new Date(this.nowFn() + delay * 1000).toISOString();
    const digest = this.composeTranscriptDigest();
    const payload: ScheduledCallbackRequest = {
      at,
      reason: truncate(asString(req.reason) || 'no reason given', 240),
      agentSummary: truncate(summary, MAX_CALLBACK_SUMMARY_LENGTH),
      transcriptDigest: digest,
    };
    try {
      this.onCallbackScheduled?.(payload);
    } catch (err) {
      // The persister threw — surface the failure to the agent so it
      // doesn't tell the caller a callback is locked in when it isn't.
      return { accepted: false, message: `Could not arm callback: ${errorText(err)}` };
    }
    this.callbackArmed = true;
    this.emitTranscript('system', `Callback scheduled for ${at}. Reason: ${payload.reason}`, {
      scheduledAt: at,
      summaryLength: payload.agentSummary.length,
      digestLength: digest.length,
    });
    return {
      accepted: true,
      at,
      message: `Callback scheduled for ${at}. The next call will pick up with your summary + the transcript so far.`,
    };
  }

  /**
   * Public time-budget snapshot for `get_call_status`. Bundles
   * everything the agent needs to decide whether to keep going, ask
   * for more time, or schedule a callback.
   */
  getCallStatus(): {
    secondsRemaining: number;
    softDeadlineAt: string | null;
    extension: ReturnType<RealtimeVoiceBridge['getExtensionStatus']>;
    callbackAvailable: boolean;
    callbackArmed: boolean;
  } {
    return {
      secondsRemaining: this.getTimeRemainingSeconds(),
      softDeadlineAt: this.softDeadlineMs ? new Date(this.softDeadlineMs).toISOString() : null,
      extension: this.getExtensionStatus(),
      callbackAvailable: !!this.callbackPolicy?.allowAutoCallback
        && (this.callbackPolicy?.maxCallbackChain ?? 0) > 0
        && !this.callbackArmed,
      callbackArmed: this.callbackArmed,
    };
  }

  /**
   * Arm the soft-deadline timer + reminder timers. Called once at hello.
   * No-op when the bridge has no budget configured.
   */
  private startCallBudget(): void {
    if (this.initialBudgetSeconds <= 0) return;
    const nowMs = this.nowFn();
    this.callStartedAtMs = nowMs;
    this.softDeadlineMs = nowMs + this.initialBudgetSeconds * 1000;
    this.emitTranscript('system', `Call budget armed: ${this.initialBudgetSeconds}s, soft deadline ${new Date(this.softDeadlineMs).toISOString()}.`, {
      budgetSeconds: this.initialBudgetSeconds,
    });
    this.rearmBudgetTimers();
  }

  /**
   * Cancel all existing budget timers and re-arm them against
   * {@link softDeadlineMs}. Called at startCallBudget time AND after
   * every successful {@link extendCallTime} grant — the timers always
   * reflect the CURRENT deadline.
   */
  private rearmBudgetTimers(): void {
    this.clearBudgetTimers();
    if (this.softDeadlineMs == null) return;
    const nowMs = this.nowFn();
    const msToDeadline = this.softDeadlineMs - nowMs;

    // Reminder injections at T-N marks. Skip a mark we've already fired
    // (extension after T-120 fired shouldn't re-fire T-120 unless the
    // new deadline pushes us back PAST it; cleaner to just dedup via
    // firedReminderMarks).
    for (const mark of CALL_BUDGET_REMINDER_MARKS_SECONDS) {
      const msUntilMark = msToDeadline - mark * 1000;
      if (msUntilMark <= 0) continue;
      if (this.firedReminderMarks.has(mark)) continue;
      const t = this.setTimeoutFn(() => {
        this.firedReminderMarks.add(mark);
        this.injectReminder(mark);
      }, msUntilMark);
      this.reminderTimers.push(t);
    }

    // Soft-end timer — fires once at the deadline, injects the "wrap up
    // NOW" system message, then schedules the grace-window hard end.
    const msUntilSoftEnd = Math.max(0, msToDeadline);
    this.softEndTimer = this.setTimeoutFn(() => {
      this.softEndTimer = null;
      this.onSoftDeadline();
    }, msUntilSoftEnd);
  }

  /** Cancel all currently-armed budget timers. Idempotent. */
  private clearBudgetTimers(): void {
    if (this.softEndTimer) {
      this.clearTimeoutFn(this.softEndTimer);
      this.softEndTimer = null;
    }
    if (this.graceEndTimer) {
      this.clearTimeoutFn(this.graceEndTimer);
      this.graceEndTimer = null;
    }
    for (const t of this.reminderTimers) {
      this.clearTimeoutFn(t);
    }
    this.reminderTimers = [];
  }

  /**
   * Inject a "you have ~N seconds left" system message into the live
   * OpenAI session. The model receives it as a `conversation.item.create`
   * with role:`system`, followed by `response.create` so it can decide
   * whether to acknowledge it out loud (often it just naturally
   * accelerates wrap-up; we don't force a verbal "I have 30 seconds").
   */
  private injectReminder(secondsRemaining: number): void {
    if (this.ended || !this.openaiReady) return;
    const text = secondsRemaining >= 60
      ? `[system] About ${Math.round(secondsRemaining / 60)} minute(s) left on this call. Start wrapping up — if you need more time, call extend_call_time; if you can't finish, call schedule_callback before signing off.`
      : `[system] About ${secondsRemaining}s left on this call. Wrap up now: thank the caller, give a clear next step, and sign off.`;
    this.safeSend(this.openai, {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    this.safeSend(this.openai, { type: 'response.create' });
    this.emitTranscript('system', `Time reminder injected at T-${secondsRemaining}s.`);
  }

  /**
   * Fires once the soft deadline elapses. Injects a "your time is up"
   * system message + schedules the grace-window hard end. If the agent
   * uses the grace window to call `schedule_callback` or `extend_call_time`
   * the latter can push the deadline forward again — that's fine, the
   * grace timer is cancelled by {@link extendCallTime} via rearmBudgetTimers.
   */
  private onSoftDeadline(): void {
    if (this.ended) return;
    if (this.openaiReady) {
      const text = `[system] Your time on this call is up. You have ~${CALL_BUDGET_GRACE_SECONDS} seconds to wrap up. `
        + 'If you need to continue with this person, call schedule_callback NOW with the time and a summary. '
        + 'Then thank them, give a clear next step, and sign off. The line will close at the end of the grace window.';
      this.safeSend(this.openai, {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
      });
      this.safeSend(this.openai, { type: 'response.create' });
    }
    this.emitTranscript('system', `Soft deadline reached; ${CALL_BUDGET_GRACE_SECONDS}s grace window started.`);
    this.endedByTimeBudgetFlag = true;
    this.graceEndTimer = this.setTimeoutFn(() => {
      this.graceEndTimer = null;
      if (this.ended) return;
      this.emitTranscript('system', 'Grace window elapsed — bridge ending call.');
      this.end('time-budget-exceeded');
    }, CALL_BUDGET_GRACE_SECONDS * 1000);
  }

  /**
   * Add an utterance to the rolling buffer used for the callback
   * transcript digest. Bounded by char count, not entry count, so a
   * burst of short turns doesn't get pruned prematurely.
   */
  private noteUtterance(line: string): void {
    if (!line) return;
    this.recentUtterances.push(line);
    let total = this.recentUtterances.reduce((n, s) => n + s.length, 0);
    while (total > MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH * 2 && this.recentUtterances.length > 1) {
      const dropped = this.recentUtterances.shift()!;
      total -= dropped.length;
    }
  }

  /**
   * Compose a transcript digest from the rolling buffer. Used as the
   * "context from the previous call" payload in {@link scheduleCallback}.
   * Always honours {@link MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH}.
   */
  private composeTranscriptDigest(): string {
    const joined = this.recentUtterances.join('\n');
    if (joined.length <= MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH) return joined;
    // Tail-bias the digest — the recent turns matter more than the
    // opening pleasantries when reconstructing context for the callback.
    return '…\n' + joined.slice(joined.length - MAX_CALLBACK_TRANSCRIPT_DIGEST_LENGTH + 2);
  }

  // ─── Teardown ─────────────────────────────────────────

  /**
   * v0.9.82 — agent-initiated hangup. Called when the `end_call` tool
   * fires. Logs a marker, then routes through {@link end} so the
   * carrier sees the bye frame and `onEnd` fires exactly once (the
   * same teardown path the human-hangup case takes). The "agent-
   * requested" reason flows through to the mission transcript so a
   * post-call audit can tell apart "agent hung up" from "human hung
   * up" from "time budget exceeded".
   *
   * Returns the structured result the tool handler echoes back to the
   * model — even though by the time the model receives it the line
   * will already be closed, keeping a consistent return shape lets the
   * executor JSON-stringify deterministically.
   */
  endByAgentRequest(reason?: string): { ok: boolean; message: string } {
    if (this.ended) {
      return { ok: false, message: 'Call has already ended.' };
    }
    const trimmed = (reason ?? '').trim();
    this.emitTranscript('system', `Agent requested hangup. Reason: ${trimmed || 'unspecified'}`, {
      endedByAgent: true,
    });
    this.end('agent-requested');
    return { ok: true, message: 'Call ended.' };
  }

  /**
   * End the bridge. Idempotent — the first call wins, later calls are
   * no-ops. Sends the carrier's end-of-call frame (if it has one — 46elks
   * `bye`; Twilio has none), closes both ports, fires `onEnd`.
   */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    // Cancel any armed budget timers — they MUST NOT fire after end()
    // (would inject a system message into a closed socket and could
    // double-trigger onEnd via the grace timer).
    this.clearBudgetTimers();
    if (this.droppedFrames > 0) {
      this.onTranscript?.({
        source: 'system',
        text: `Dropped ${this.droppedFrames} oversized/invalid audio frame(s) during the call.`,
      });
    }
    // Tool calls still running at teardown — the call dropped mid-tool.
    // Surface it on the transcript; `onEnd.pendingToolCalls` is the
    // signal the API layer uses to arm callback-on-disconnect (plan §7).
    const pendingToolCalls = this.inFlightToolCalls.size;
    if (pendingToolCalls > 0) {
      this.onTranscript?.({
        source: 'system',
        text: `Call ended with ${pendingToolCalls} tool call(s) still pending (e.g. an unanswered operator query).`,
      });
    }
    // Best-effort end-of-call frame to the carrier (if the protocol has
    // one), then close both sides.
    const byeFrame = this.transport.buildBye();
    if (byeFrame) {
      try { this.carrier.send(byeFrame); } catch { /* ignore */ }
    }
    try { this.carrier.close(); } catch { /* ignore */ }
    try { this.openai.close(); } catch { /* ignore */ }
    // Omit endedByTimeBudget when false — keeps the onEnd shape
    // strictly backward-compatible for legacy callers that match the
    // payload exactly (existing realtime-bridge.test.ts and
    // twilio-bridge.test.ts both assert `toEqual({ reason, pendingToolCalls })`).
    if (this.endedByTimeBudgetFlag) {
      this.onEnd?.({ reason, pendingToolCalls, endedByTimeBudget: true });
    } else {
      this.onEnd?.({ reason, pendingToolCalls });
    }
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

/** Coerce a value to a plain object, or `{}` for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Coerce a value to a trimmed string, or `''` for a non-string. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Truncate a string for transcript lines, adding an ellipsis if cut. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Parse the `arguments` field of a function-call event — a JSON string
 * per the OpenAI Realtime protocol. Returns `{}` for anything that is
 * not a JSON object, so a buggy/hostile payload can never inject a
 * non-object into a tool handler.
 */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  const text = asString(raw);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Race a promise against a timeout. Rejects with a timeout error if the
 * promise has not settled within `ms`; the pending timer is always
 * cleared so it cannot keep the event loop alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`tool call exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
