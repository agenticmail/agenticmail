export interface ParsedGoogleMeetLink {
  source: string;
  meetingCode: string;
  normalizedUrl: string;
}

const MEET_HOSTS = new Set([
  'meet.google.com',
  'www.meet.google.com',
]);

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

function normalizeMeetCode(value: string): string {
  return value.trim().toLowerCase();
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
