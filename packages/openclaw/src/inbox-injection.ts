export const INBOX_INJECTION_MODES = ['off', 'count', 'summary', 'required'] as const;

export type InboxInjectionMode = typeof INBOX_INJECTION_MODES[number];

export interface InboxInjectionConfig {
  mode: InboxInjectionMode;
  maxItems: number;
  includePreview: boolean;
}

export interface UnreadMailSummary {
  uid: number;
  from: string;
  subject: string;
  tag: 'agent' | 'external';
  preview?: string;
}

const DEFAULT_INBOX_INJECTION_CONFIG: InboxInjectionConfig = {
  mode: 'summary',
  maxItems: 5,
  includePreview: false,
};

const MAX_INBOX_INJECTION_ITEMS = 25;

function isInboxInjectionMode(value: unknown): value is InboxInjectionMode {
  return typeof value === 'string' && INBOX_INJECTION_MODES.includes(value as InboxInjectionMode);
}

function resolvePositiveInteger(value: unknown, fallback: number): number {
  const candidate = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value;

  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return fallback;
  return Math.min(MAX_INBOX_INJECTION_ITEMS, Math.max(1, Math.floor(candidate)));
}

export function resolveInboxInjectionConfig(config: Record<string, unknown> | undefined): InboxInjectionConfig {
  return {
    mode: isInboxInjectionMode(config?.inboxInjectionMode)
      ? config.inboxInjectionMode
      : DEFAULT_INBOX_INJECTION_CONFIG.mode,
    maxItems: resolvePositiveInteger(
      config?.inboxInjectionMaxItems,
      DEFAULT_INBOX_INJECTION_CONFIG.maxItems,
    ),
    includePreview: config?.inboxInjectionIncludePreview === true,
  };
}

export function sanitizeInboxPreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const preview = value.replace(/\s+/g, ' ').slice(0, 200).trim();
  return preview || undefined;
}

function formatSummary(summary: UnreadMailSummary): string {
  const preview = summary.preview ? `\n    ${summary.preview}` : '';
  return `  - [${summary.tag}] UID ${summary.uid}: from ${summary.from}: "${summary.subject}"${preview}`;
}

export function formatUnreadInboxContext(
  totalUnread: number,
  summaries: UnreadMailSummary[],
  config: InboxInjectionConfig,
): string[] {
  if (config.mode === 'off' || totalUnread <= 0) return [];

  const lines = [
    '<unread-emails>',
    `You have ${totalUnread} unread email(s) in your inbox.`,
  ];

  if (config.mode === 'count') {
    lines.push('Use agenticmail_inbox or agenticmail_read only when the current task requires checking mail.');
    lines.push('</unread-emails>');
    return lines;
  }

  if (summaries.length > 0) {
    lines.push('Unread summary:');
    lines.push(...summaries.map(formatSummary));

    const remaining = totalUnread - summaries.length;
    if (remaining > 0) lines.push(`  (${remaining} more unread messages not shown)`);
  } else {
    lines.push('Unread message summaries are unavailable.');
  }

  lines.push('');

  if (config.mode === 'required') {
    lines.push(
      'ACTION REQUIRED: Read each unread email with agenticmail_read before responding.',
      'Briefly tell the user what each unread email says, then continue with your original task.',
    );
  } else {
    lines.push('Use agenticmail_read when an unread email is relevant to the current task.');
  }

  lines.push('</unread-emails>');
  return lines;
}
