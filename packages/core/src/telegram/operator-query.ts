/**
 * Telegram ⇄ `ask_operator` bridge (plan §13.4 / §13.5) — pure helpers.
 *
 * The realtime voice agent's `ask_operator` tool records an *operator
 * query* on the phone mission; the API exposes it through the
 * operator-query endpoints. Email is the channel-agnostic default
 * notifier (plan §5). This module makes Telegram a first-class
 * notification + approval channel WITHOUT duplicating any of that
 * machinery — it only:
 *
 *   1. {@link formatOperatorQueryTelegramMessage} — renders the
 *      notification text the operator receives.
 *   2. {@link parseTelegramOperatorReply} — parses the operator's
 *      Telegram reply back into a `{ queryId, answer }`.
 *
 * The caller feeds the parsed result straight into the SAME
 * `PhoneManager.answerOperatorQuery` the inbound email-reply hook uses.
 */

/**
 * Token embedded in a notification so the operator's reply can be
 * matched back to a query. Kept short — the operator may see it.
 */
export const TELEGRAM_OPERATOR_QUERY_TAG = 'AMQ';

// Operator query ids are `oq_<uuid>` — letters, digits, hyphens only.
const QUERY_ID_RE = /(oq_[A-Za-z0-9-]+)/;
const QUERY_TAG_RE = new RegExp(`\\[${TELEGRAM_OPERATOR_QUERY_TAG}\\s+(oq_[A-Za-z0-9-]+)\\]`);

export interface OperatorQueryNotificationInput {
  queryId: string;
  question: string;
  callContext?: string;
  urgency?: string;
  missionId?: string;
}

/**
 * Render the Telegram message body for an `ask_operator` notification.
 * The trailing `[AMQ <id>]` token lets a reply be matched to the query
 * even when the operator does not use Telegram's native reply gesture.
 */
export function formatOperatorQueryTelegramMessage(input: OperatorQueryNotificationInput): string {
  const lines: string[] = [];
  lines.push(input.urgency === 'high'
    ? '🔴 Your agent needs an answer to continue a live call (URGENT).'
    : '🟡 Your agent needs an answer to continue a live call.');
  lines.push('');
  lines.push(`Question: ${input.question}`);
  if (input.callContext) lines.push(`Context: ${input.callContext}`);
  lines.push('');
  lines.push('Reply to this message with your answer. You can also send:');
  lines.push(`  /answer ${input.queryId} <your answer>`);
  lines.push(`  /approve ${input.queryId}   ·   /deny ${input.queryId}`);
  lines.push('');
  lines.push(`[${TELEGRAM_OPERATOR_QUERY_TAG} ${input.queryId}]`);
  return lines.join('\n');
}

/** A `kind` of `approve`/`deny` is a decision; `answer` is free-form. */
export type OperatorReplyKind = 'answer' | 'approve' | 'deny';

export interface ParsedOperatorReply {
  /**
   * Query id when the reply names one — explicitly (`/answer <id>`,
   * an inline `oq_…` token) or implicitly (a native Telegram reply
   * quoting a `[AMQ <id>]`-tagged notification). `undefined` when the
   * reply is a bare message and the caller must resolve the target.
   */
  queryId?: string;
  /** The answer text to record against the query. Always non-empty. */
  answer: string;
  kind: OperatorReplyKind;
}

/**
 * Parse an operator's Telegram message into a {@link ParsedOperatorReply},
 * or `null` when it carries no usable answer.
 *
 * Recognized forms (most explicit first):
 *   - `/answer <queryId> <text>`
 *   - `/approve [<queryId>] [note]` · `/deny [<queryId>] [note]`
 *   - a plain message — `queryId` is taken from a quoted tagged
 *     notification (`replyToText`) or an inline `oq_…` / `[AMQ …]` token,
 *     and is otherwise left `undefined` for the caller to resolve.
 *
 * The `@botname` suffix Telegram appends to commands in groups
 * (`/approve@mybot`) is tolerated.
 */
export function parseTelegramOperatorReply(input: { text: string; replyToText?: string }): ParsedOperatorReply | null {
  const text = (input.text ?? '').trim();
  if (!text) return null;

  // A native Telegram reply to the notification carries its tagged
  // text — pull the query id straight out of the quote.
  const quotedTag = input.replyToText ? QUERY_TAG_RE.exec(input.replyToText) : null;
  const quotedQueryId = quotedTag?.[1];

  // /answer <queryId> <text>
  const answerCmd = /^\/answer(?:@\w+)?\s+(oq_[A-Za-z0-9-]+)\s+([\s\S]+)$/i.exec(text);
  if (answerCmd) {
    return { queryId: answerCmd[1], answer: answerCmd[2].trim(), kind: 'answer' };
  }

  // /approve [queryId] [note]  ·  /deny [queryId] [note]
  const decisionCmd = /^\/(approve|deny)(?:@\w+)?\b([\s\S]*)$/i.exec(text);
  if (decisionCmd) {
    const kind: OperatorReplyKind = decisionCmd[1].toLowerCase() === 'approve' ? 'approve' : 'deny';
    const rest = decisionCmd[2].trim();
    const inlineId = QUERY_ID_RE.exec(rest)?.[1];
    const note = rest.replace(QUERY_ID_RE, '').trim();
    const answer = (kind === 'approve' ? 'Approved' : 'Denied') + (note ? `: ${note}` : '.');
    return { queryId: inlineId ?? quotedQueryId, answer, kind };
  }

  // Plain message — usable as an answer; query id is best-effort.
  const inlineId = QUERY_TAG_RE.exec(text)?.[1] ?? QUERY_ID_RE.exec(text)?.[1];
  const answer = text.replace(QUERY_TAG_RE, '').trim();
  if (!answer) return null;
  return { queryId: quotedQueryId ?? inlineId, answer, kind: 'answer' };
}
