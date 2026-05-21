import type { ConversationSessionManager } from '../conversation/session.js';
import { isTelegramStopCommand, type ParsedTelegramMessage } from './update.js';

export interface TelegramConversationContext {
  sessionId: string;
  messageId: string;
  channel: 'telegram';
  chatId: string;
  peer: string;
  goal?: string;
  subject?: string;
  latestText: string;
  telegramMessageId: number;
  ended?: boolean;
}

export function recordTelegramConversationInbound(
  conversationManager: ConversationSessionManager,
  agentId: string,
  parsed: ParsedTelegramMessage,
): TelegramConversationContext | null {
  const session = conversationManager.findActiveSessionByPeer(agentId, 'telegram', parsed.chatId);
  if (!session) return null;

  const message = conversationManager.recordMessage({
    sessionId: session.id,
    agentId,
    channel: 'telegram',
    direction: 'inbound',
    text: parsed.text,
    externalMessageId: String(parsed.messageId),
    metadata: {
      telegramMessageId: parsed.messageId,
      fromId: parsed.fromId,
      updateId: parsed.updateId,
    },
  });
  const ended = isTelegramStopCommand(parsed.text);
  if (ended) {
    conversationManager.endSession(agentId, session.id, 'ended');
  }

  return {
    sessionId: session.id,
    messageId: message.id,
    channel: 'telegram',
    chatId: parsed.chatId,
    peer: session.peer,
    goal: session.goal,
    subject: session.subject,
    latestText: parsed.text,
    telegramMessageId: parsed.messageId,
    ended,
  };
}
