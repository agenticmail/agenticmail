import type { ParsedEmail } from './types.js';
import type { SpamResult } from './spam-filter.js';

export type EmailRouteClass =
  | 'ignore_spam'
  | 'ignore_newsletter'
  | 'archive_automated'
  | 'project_update'
  | 'deal_escalation'
  | 'agent_instruction'
  | 'human_private';

export type EmailRouteAction =
  | 'ignore'
  | 'archive'
  | 'notify'
  | 'escalate'
  | 'create_task'
  | 'draft_reply';

export interface EmailRouteAccountContext {
  name?: string;
  email?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailRouteInput {
  email: ParsedEmail;
  spam?: Pick<SpamResult, 'score' | 'isSpam' | 'isWarning' | 'topCategory'>;
  account?: EmailRouteAccountContext;
}

export interface EmailRouteClassification {
  routeClass: EmailRouteClass;
  action: EmailRouteAction;
  gateRequired: boolean;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}

const DEAL_TERMS = [
  'contract', 'proposal', 'quote', 'pricing', 'price', 'budget',
  'purchase order', 'invoice', 'deal', 'renewal', 'msa', 'sow',
  'deadline', 'urgent', 'asap', 'time sensitive',
];

const INSTRUCTION_TERMS = [
  'task', 'instruction', 'please', 'can you', 'could you', 'follow up',
  'draft', 'reply', 'send', 'research', 'summarize', 'investigate',
  'action item', 'todo',
];

const AUTOMATION_SUBJECT_TERMS = [
  'receipt', 'notification', 'alert', 'build', 'deployment', 'backup',
  'statement', 'verification code', 'security code', 'login code',
];

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function textFor(email: ParsedEmail): string {
  return `${email.subject ?? ''}\n${email.text ?? ''}\n${email.html ?? ''}`.toLowerCase();
}

function firstAddress(email: ParsedEmail): string {
  return normalize(email.from[0]?.address);
}

function header(email: ParsedEmail, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of email.headers) {
    if (key.toLowerCase() === wanted) return normalize(value);
  }
  return '';
}

function localPart(address: string): string {
  return address.split('@')[0] ?? '';
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term));
}

function accountPolicy(account: EmailRouteAccountContext | undefined): string {
  const metadata = account?.metadata ?? {};
  const value = metadata.emailRoutePolicy ?? metadata.routePolicy ?? metadata.mailboxPolicy;
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isInternalAddress(address: string): boolean {
  return address.endsWith('@localhost');
}

function isNewsletter(email: ParsedEmail): boolean {
  const from = firstAddress(email);
  const subjectAndBody = textFor(email);

  return Boolean(
    header(email, 'list-unsubscribe') ||
    header(email, 'list-id') ||
    header(email, 'x-campaign-id') ||
    header(email, 'x-mailchimp-campaign') ||
    header(email, 'precedence') === 'list' ||
    localPart(from).includes('newsletter') ||
    subjectAndBody.includes('unsubscribe') ||
    subjectAndBody.includes('newsletter') ||
    subjectAndBody.includes('weekly digest'),
  );
}

function isAutomated(email: ParsedEmail): boolean {
  const from = firstAddress(email);
  const subject = normalize(email.subject);
  const precedence = header(email, 'precedence');
  const autoSubmitted = header(email, 'auto-submitted');

  return Boolean(
    (autoSubmitted && autoSubmitted !== 'no') ||
    precedence === 'bulk' ||
    precedence === 'auto' ||
    localPart(from).includes('no-reply') ||
    localPart(from).includes('noreply') ||
    localPart(from).includes('donotreply') ||
    containsAny(subject, AUTOMATION_SUBJECT_TERMS),
  );
}

export function classifyEmailRoute(input: EmailRouteInput): EmailRouteClassification {
  const { email, spam, account } = input;
  const policy = accountPolicy(account);
  const from = firstAddress(email);
  const allText = textFor(email);

  if (spam?.isSpam) {
    return {
      routeClass: 'ignore_spam',
      action: 'ignore',
      gateRequired: false,
      confidence: 'high',
      reason: `Spam score ${spam.score} exceeded the spam threshold`,
    };
  }

  if (policy === 'human' || policy === 'private') {
    return {
      routeClass: 'human_private',
      action: 'notify',
      gateRequired: true,
      confidence: 'high',
      reason: 'Account policy marks this mailbox as human/private',
    };
  }

  if (isNewsletter(email)) {
    return {
      routeClass: 'ignore_newsletter',
      action: 'ignore',
      gateRequired: false,
      confidence: 'high',
      reason: 'Newsletter headers or unsubscribe signals were detected',
    };
  }

  if (isAutomated(email) && !containsAny(allText, DEAL_TERMS)) {
    return {
      routeClass: 'archive_automated',
      action: 'archive',
      gateRequired: false,
      confidence: 'medium',
      reason: 'Automated sender or notification pattern detected',
    };
  }

  if ((policy === 'agent' || isInternalAddress(from)) && containsAny(allText, INSTRUCTION_TERMS)) {
    return {
      routeClass: 'agent_instruction',
      action: 'create_task',
      gateRequired: true,
      confidence: isInternalAddress(from) ? 'high' : 'medium',
      reason: 'Instruction-like content for an agent mailbox was detected',
    };
  }

  if (containsAny(allText, DEAL_TERMS)) {
    return {
      routeClass: 'deal_escalation',
      action: 'escalate',
      gateRequired: true,
      confidence: 'medium',
      reason: 'Commercial, deadline, or negotiation language was detected',
    };
  }

  if (spam?.isWarning) {
    return {
      routeClass: 'project_update',
      action: 'notify',
      gateRequired: true,
      confidence: 'low',
      reason: `Spam warning category ${spam.topCategory ?? 'unknown'} requires cautious handling`,
    };
  }

  return {
    routeClass: 'project_update',
    action: 'notify',
    gateRequired: false,
    confidence: 'low',
    reason: 'Default route for non-spam, non-automated email',
  };
}
