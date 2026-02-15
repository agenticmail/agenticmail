export interface SendMailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Attachment[];
  headers?: Record<string, string>;
  /** Display name for the From header, e.g. "Fola from Astrum" */
  fromName?: string;
}

export interface Attachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
  encoding?: string;
}

export interface SendResult {
  messageId: string;
  envelope: {
    from: string;
    to: string[];
  };
}

export interface EmailEnvelope {
  uid: number;
  seq: number;
  messageId: string;
  subject: string;
  from: AddressInfo[];
  to: AddressInfo[];
  date: Date;
  flags: Set<string>;
  size: number;
}

export interface AddressInfo {
  name?: string;
  address: string;
}

export interface ParsedEmail {
  messageId: string;
  subject: string;
  from: AddressInfo[];
  to: AddressInfo[];
  cc?: AddressInfo[];
  replyTo?: AddressInfo[];
  date: Date;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: ParsedAttachment[];
  headers: Map<string, string>;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface MailboxInfo {
  name: string;
  exists: number;
  recent: number;
  unseen: number;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  since?: Date;
  before?: Date;
  seen?: boolean;
  text?: string;
}
