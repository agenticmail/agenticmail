import type { GoogleMeetConfig } from './manager.js';

export const GOOGLE_MEET_API_BASE = 'https://meet.googleapis.com/v2';

export class GoogleMeetApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
    this.name = 'GoogleMeetApiError';
  }
}

export interface GoogleMeetSpace {
  name?: string;
  meetingUri?: string;
  meetingCode?: string;
  activeConference?: { conferenceRecord?: string };
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GoogleMeetTranscriptEntry {
  name: string;
  participant?: string;
  text: string;
  languageCode?: string;
  startTime?: string;
  endTime?: string;
}

export interface GoogleMeetTranscriptEntriesResponse {
  transcriptEntries?: GoogleMeetTranscriptEntry[];
  nextPageToken?: string;
}

export interface GoogleMeetLiveJoinRequest {
  sessionId: string;
  meetingUri: string;
  meetingCode?: string;
  participantName?: string;
  behaviorMode?: string;
  topic?: string;
  goal?: string;
  accessToken: string;
  liveContext?: Record<string, unknown>;
}

export interface GoogleMeetLiveJoinResponse {
  success?: boolean;
  status?: string;
  participantId?: string;
  streamId?: string;
  message?: string;
  [key: string]: unknown;
}

export interface GoogleMeetTranscriptResponse {
  transcripts?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface GoogleMeetConferenceRecordsResponse {
  conferenceRecords?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function assertMeetResource(name: string, prefix: string): string {
  const normalized = trimSlashes(String(name || '').trim());
  if (!normalized || !normalized.startsWith(`${prefix}/`)) {
    throw new Error(`${prefix} resource name is required`);
  }
  if (normalized.includes('..')) throw new Error('resource name must not contain ..');
  return normalized.split('/').map(encodeURIComponent).join('/');
}

async function parseGoogleMeetResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function callGoogleMeetApi<T = unknown>(
  config: GoogleMeetConfig,
  method: string,
  path: string,
  body?: unknown,
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<T> {
  const fetchImpl = init?.fetchImpl ?? fetch;
  const baseUrl = (init?.baseUrl || GOOGLE_MEET_API_BASE).replace(/\/+$/, '');
  const url = `${baseUrl}/${trimSlashes(path)}`;
  const resp = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await parseGoogleMeetResponse(resp);
  if (!resp.ok) {
    const message = typeof (data as any)?.error?.message === 'string'
      ? (data as any).error.message
      : `Google Meet API returned HTTP ${resp.status}`;
    throw new GoogleMeetApiError(message, resp.status, data);
  }
  return data as T;
}

export async function startGoogleMeetLiveSidecar(
  config: GoogleMeetConfig,
  request: Omit<GoogleMeetLiveJoinRequest, 'accessToken'>,
  init?: { fetchImpl?: typeof fetch },
): Promise<GoogleMeetLiveJoinResponse> {
  if (!config.mediaSidecarUrl) throw new Error('mediaSidecarUrl is required');
  const fetchImpl = init?.fetchImpl ?? fetch;
  const url = new URL(config.mediaSidecarUrl);
  if (!url.pathname || url.pathname === '/') url.pathname = '/join';
  const resp = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.accessToken}`,
      ...(config.mediaSidecarToken ? { 'X-AgenticMail-Meet-Sidecar-Token': config.mediaSidecarToken } : {}),
    },
    body: JSON.stringify({
      ...request,
      accessToken: config.accessToken,
      participantName: request.participantName || config.participantName,
    }),
  });
  const data = await parseGoogleMeetResponse(resp);
  if (!resp.ok) {
    const message = typeof (data as any)?.error === 'string'
      ? (data as any).error
      : typeof (data as any)?.message === 'string'
        ? (data as any).message
        : `Google Meet media sidecar returned HTTP ${resp.status}`;
    throw new GoogleMeetApiError(message, resp.status, data);
  }
  return data as GoogleMeetLiveJoinResponse;
}

export async function createGoogleMeetSpace(
  config: GoogleMeetConfig,
  options: {
    accessType?: string;
    entryPointAccess?: string;
    artifactConfig?: Record<string, unknown>;
  } = {},
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<GoogleMeetSpace> {
  const request: Record<string, unknown> = {};
  const spaceConfig: Record<string, unknown> = {};
  if (options.accessType) spaceConfig.accessType = options.accessType;
  if (options.entryPointAccess) spaceConfig.entryPointAccess = options.entryPointAccess;
  if (options.artifactConfig) spaceConfig.artifactConfig = options.artifactConfig;
  if (Object.keys(spaceConfig).length > 0) request.config = spaceConfig;
  return callGoogleMeetApi<GoogleMeetSpace>(config, 'POST', 'spaces', request, init);
}

export async function getGoogleMeetSpace(
  config: GoogleMeetConfig,
  spaceOrCode: string,
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<GoogleMeetSpace> {
  const raw = String(spaceOrCode || '').trim();
  const resource = raw.startsWith('spaces/') ? raw : `spaces/${raw}`;
  return callGoogleMeetApi<GoogleMeetSpace>(config, 'GET', assertMeetResource(resource, 'spaces'), undefined, init);
}

export async function listGoogleMeetConferenceRecords(
  config: GoogleMeetConfig,
  options: { space?: string; pageSize?: number; pageToken?: string } = {},
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<GoogleMeetConferenceRecordsResponse> {
  const query = new URLSearchParams();
  if (options.space) query.set('filter', `space="${String(options.space).trim()}"`);
  if (options.pageSize) query.set('pageSize', String(Math.min(Math.max(options.pageSize, 1), 100)));
  if (options.pageToken) query.set('pageToken', options.pageToken);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return callGoogleMeetApi<GoogleMeetConferenceRecordsResponse>(config, 'GET', `conferenceRecords${suffix}`, undefined, init);
}

export async function listGoogleMeetTranscripts(
  config: GoogleMeetConfig,
  conferenceRecord: string,
  options: { pageSize?: number; pageToken?: string } = {},
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<GoogleMeetTranscriptResponse> {
  const parent = assertMeetResource(conferenceRecord, 'conferenceRecords');
  const query = new URLSearchParams();
  if (options.pageSize) query.set('pageSize', String(Math.min(Math.max(options.pageSize, 1), 100)));
  if (options.pageToken) query.set('pageToken', options.pageToken);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return callGoogleMeetApi<GoogleMeetTranscriptResponse>(config, 'GET', `${parent}/transcripts${suffix}`, undefined, init);
}

export async function listGoogleMeetTranscriptEntries(
  config: GoogleMeetConfig,
  transcript: string,
  options: { pageSize?: number; pageToken?: string } = {},
  init?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<GoogleMeetTranscriptEntriesResponse> {
  const parent = assertMeetResource(transcript, 'conferenceRecords');
  if (!parent.includes('/transcripts/')) throw new Error('transcript must be conferenceRecords/{id}/transcripts/{id}');
  const query = new URLSearchParams();
  if (options.pageSize) query.set('pageSize', String(Math.min(Math.max(options.pageSize, 1), 100)));
  if (options.pageToken) query.set('pageToken', options.pageToken);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return callGoogleMeetApi<GoogleMeetTranscriptEntriesResponse>(config, 'GET', `${parent}/entries${suffix}`, undefined, init);
}
