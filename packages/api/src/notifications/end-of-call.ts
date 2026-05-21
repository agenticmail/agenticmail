/**
 * End-of-call Telegram digest.
 *
 * Fires once when the realtime voice bridge ends — any reason. Sends
 * the operator a chat-friendly summary so they don't have to dig
 * into the web UI to see how a delegated call went. Best-effort:
 * no telegram config on the agent ⇒ silently skipped.
 *
 * Why this lives in its own file (since v0.9.90):
 *
 *   - The original v0.9.85 implementation only showed the agent's
 *     last 3 turns + the caller's last 2 turns as separate blocks.
 *     Operators reading the digest had to mentally reconstruct who
 *     said what when. v0.9.90 interleaves both sides chronologically,
 *     which is how the operator would have heard the call anyway.
 *   - Pulling the formatter out of `realtime-ws.ts` keeps that file
 *     focused on the WebSocket plumbing + tool dispatch, and lets us
 *     unit-test the digest text purely without spinning up a bridge.
 *   - Future notification channels (email digest, Slack, push) can
 *     reuse `formatEndOfCallDigest` directly.
 */

import {
  TelegramManager,
  sendTelegramMessage,
  type AgenticMailConfig,
  type PhoneCallMission,
  type PhoneMissionTranscriptEntry,
} from '@agenticmail/core';
import type { getDatabase } from '@agenticmail/core';

type Db = ReturnType<typeof getDatabase>;

export interface NotifyCallEndedParams {
  mission: PhoneCallMission;
  config: AgenticMailConfig;
  db: Db;
  reason: string;
  endedByTimeBudget: boolean;
  pendingToolCalls: number;
  callbackArmed: boolean;
  transcript: PhoneMissionTranscriptEntry[];
}

/** Inputs the pure formatter needs — same shape minus the side-effecty handles. */
export interface FormatEndOfCallInput {
  missionId: string;
  to: string;
  task: string;
  reason: string;
  endedByTimeBudget: boolean;
  pendingToolCalls: number;
  callbackArmed: boolean;
  transcript: PhoneMissionTranscriptEntry[];
}

/**
 * How many of the most-recent CONVERSATIONAL turns to include in the
 * digest (agent + caller, interleaved). Tuned to roughly the back end
 * of the call — usually contains the outcome, the wrap-up, and the
 * caller's final acknowledgement.
 */
export const DEFAULT_END_OF_CALL_TURN_BUDGET = 8;

/** Per-turn character cap, so a chatty turn doesn't blow the message budget. */
export const DEFAULT_END_OF_CALL_PER_TURN_CHARS = 320;

/**
 * Pure: compose the Telegram-ready digest string from mission + transcript.
 * No I/O. Unit-testable.
 */
export function formatEndOfCallDigest(
  input: FormatEndOfCallInput,
  options: { turnBudget?: number; perTurnChars?: number } = {},
): string {
  const turnBudget = options.turnBudget ?? DEFAULT_END_OF_CALL_TURN_BUDGET;
  const perTurnChars = options.perTurnChars ?? DEFAULT_END_OF_CALL_PER_TURN_CHARS;

  const headline = classifyEndHeadline(input.reason, input.endedByTimeBudget);

  // Interleaved tail of the transcript — both sides in time order. The
  // previous version showed agent and caller in two separate blocks,
  // which made the digest read like two parallel monologues instead of
  // the back-and-forth it actually was.
  const conversational = input.transcript.filter((e) => e.source === 'agent' || e.source === 'provider');
  const tail = conversational.slice(-turnBudget);

  const lines: string[] = [headline, ''];
  lines.push(`Number: ${input.to}`);
  lines.push(`Task: ${truncateLine(input.task, 200)}`);

  if (input.callbackArmed) {
    lines.push('', '🔁 A callback was scheduled — you\'ll get another notification when it dials.');
  }
  if (input.pendingToolCalls > 0 && !input.callbackArmed) {
    lines.push('', `⚠️ The call dropped while ${input.pendingToolCalls} tool call(s) were still in flight — likely an unanswered operator query.`);
  }

  if (tail.length > 0) {
    lines.push('', `Last ${tail.length} exchange(s):`);
    for (const t of tail) {
      const speaker = t.source === 'agent' ? 'Agent' : 'Other party';
      lines.push(`• ${speaker}: ${truncateLine(t.text, perTurnChars)}`);
    }
  }

  lines.push('', `Mission: ${input.missionId}`);
  return lines.join('\n');
}

/**
 * Map the bridge's `end` reason + the time-budget flag into one of a
 * small set of headlines. Order matters — `endedByTimeBudget` wins
 * because it carries more meaning than `agent-requested` even when
 * both are technically true (the agent calls end_call during the
 * grace window).
 */
function classifyEndHeadline(reason: string, endedByTimeBudget: boolean): string {
  if (endedByTimeBudget) return '⏰ Call ended — time budget reached';
  if (reason === 'agent-requested') return '✅ Call ended — agent wrapped up';
  if (/twilio-bye|elks-bye/.test(reason)) return '📞 Call ended — other party hung up';
  if (reason === 'openai-closed') return '⚠️ Call ended — voice runtime disconnected';
  return '📞 Call ended';
}

/** Compress whitespace + truncate for chat-friendly display. */
function truncateLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + '…';
}

/**
 * Side-effecting: load the agent's Telegram config, render the digest,
 * deliver it. The only function the bridge's `onEnd` needs to call.
 */
export async function notifyCallEnded(params: NotifyCallEndedParams): Promise<void> {
  const telegramManager = new TelegramManager(params.db as any, params.config.masterKey);
  const cfg = telegramManager.getConfig(params.mission.agentId);
  if (!cfg?.enabled || !cfg.operatorChatId || !cfg.botToken) return;

  const body = formatEndOfCallDigest({
    missionId: params.mission.id,
    to: params.mission.to,
    task: params.mission.task,
    reason: params.reason,
    endedByTimeBudget: params.endedByTimeBudget,
    pendingToolCalls: params.pendingToolCalls,
    callbackArmed: params.callbackArmed,
    transcript: params.transcript,
  });

  await sendTelegramMessage(cfg.botToken, cfg.operatorChatId, body);
}
