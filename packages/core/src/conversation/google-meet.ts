export interface ParsedGoogleMeetLink {
  source: string;
  meetingCode: string;
  normalizedUrl: string;
}

export const GOOGLE_MEET_BEHAVIOR_MODES = [
  'listen_only',
  'answer_when_asked',
  'operator_directed',
] as const;

export type GoogleMeetBehaviorMode = typeof GOOGLE_MEET_BEHAVIOR_MODES[number];

export interface GoogleMeetSessionBriefingInput {
  meetingUrl: string;
  meetingCode: string;
  topic?: string;
  projectRef?: string;
  goal?: string;
  operatorInstructions?: string;
  behaviorMode?: string;
}

const MEET_HOSTS = new Set([
  'meet.google.com',
  'www.meet.google.com',
]);

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

function normalizeMeetCode(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeGoogleMeetBehaviorMode(
  value: unknown,
  fallback: GoogleMeetBehaviorMode = 'answer_when_asked',
): GoogleMeetBehaviorMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (GOOGLE_MEET_BEHAVIOR_MODES as readonly string[]).includes(normalized)
    ? normalized as GoogleMeetBehaviorMode
    : fallback;
}

export function parseGoogleMeetLink(input: string): ParsedGoogleMeetLink {
  const source = String(input || '').trim();
  if (!source) throw new Error('Google Meet link is required');

  const directCode = normalizeMeetCode(source);
  if (MEET_CODE_RE.test(directCode)) {
    return {
      source,
      meetingCode: directCode,
      normalizedUrl: `https://meet.google.com/${directCode}`,
    };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Google Meet link must be a meet.google.com URL or meeting code');
  }

  if (!['https:', 'http:'].includes(url.protocol) || !MEET_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Google Meet link must use meet.google.com');
  }

  const code = normalizeMeetCode(url.pathname.split('/').filter(Boolean)[0] || '');
  if (!MEET_CODE_RE.test(code)) {
    throw new Error('Google Meet link does not contain a valid meeting code');
  }

  return {
    source,
    meetingCode: code,
    normalizedUrl: `https://meet.google.com/${code}`,
  };
}

export function buildGoogleMeetSessionBriefing(input: GoogleMeetSessionBriefingInput): string {
  const behaviorMode = normalizeGoogleMeetBehaviorMode(input.behaviorMode);
  const lines = [
    'Google Meet intake session prepared.',
    `meeting: ${input.meetingUrl}`,
    `meeting_code: ${input.meetingCode}`,
    `behavior_mode: ${behaviorMode}`,
  ];
  if (input.topic?.trim()) lines.push(`topic: ${input.topic.trim()}`);
  if (input.projectRef?.trim()) lines.push(`project_ref: ${input.projectRef.trim()}`);
  if (input.goal?.trim()) lines.push(`goal: ${input.goal.trim()}`);
  if (input.operatorInstructions?.trim()) {
    lines.push(`operator_instructions: ${input.operatorInstructions.trim()}`);
  }
  lines.push('live_media_status: not_joined');
  lines.push('next_gate: Google Meet media sidecar / participant runtime');
  return lines.join('\n');
}
