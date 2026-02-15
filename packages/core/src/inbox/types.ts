import type { ParsedEmail } from '../mail/types.js';

export type InboxEventType = 'new' | 'expunge' | 'flags';

export interface InboxNewEvent {
  type: 'new';
  uid: number;
  message?: ParsedEmail;
}

export interface InboxExpungeEvent {
  type: 'expunge';
  seq: number;
}

export interface InboxFlagsEvent {
  type: 'flags';
  uid: number;
  flags: Set<string>;
}

export type InboxEvent = InboxNewEvent | InboxExpungeEvent | InboxFlagsEvent;

export interface WatcherOptions {
  mailbox?: string;
  autoFetch?: boolean;
}
