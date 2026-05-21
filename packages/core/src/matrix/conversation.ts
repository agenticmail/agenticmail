import type { ConversationSessionManager } from '../conversation/session.js';
import type { ParsedMatrixMessage } from './client.js';

export interface MatrixConversationContext {
  sessionId: string;
  messageId: string;
  channel: 'matrix';
  roomId: string;
  peer: string;
  goal?: string;
  subject?: string;
  latestText: string;
  eventId: string;
  sender?: string;
}

export function recordMatrixConversationInbound(
  conversationManager: ConversationSessionManager,
  agentId: string,
  parsed: ParsedMatrixMessage,
): MatrixConversationContext | null {
  const session = conversationManager.findActiveSessionByPeer(agentId, 'matrix', parsed.roomId);
  if (!session) return null;

  const message = conversationManager.recordMessage({
    sessionId: session.id,
    agentId,
    channel: 'matrix',
    direction: 'inbound',
    text: parsed.text,
    externalMessageId: parsed.eventId,
    metadata: { ...parsed.metadata, sender: parsed.sender, roomId: parsed.roomId },
  });

  return {
    sessionId: session.id,
    messageId: message.id,
    channel: 'matrix',
    roomId: parsed.roomId,
    peer: session.peer,
    goal: session.goal,
    subject: session.subject,
    latestText: parsed.text,
    eventId: parsed.eventId,
    sender: parsed.sender,
  };
}
