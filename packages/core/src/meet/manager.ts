import type { Database } from '../storage/db.js';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../crypto/secrets.js';
import { normalizeGoogleMeetBehaviorMode, type GoogleMeetBehaviorMode } from '../conversation/google-meet.js';

export interface GoogleMeetConfig {
  enabled: boolean;
  accessToken: string;
  workspaceDomain?: string;
  participantName?: string;
  allowedDomains: string[];
  defaultBehaviorMode: GoogleMeetBehaviorMode;
  mediaApiDeveloperPreview: boolean;
  mediaSidecarUrl?: string;
  consentPolicyAccepted: boolean;
  configuredAt: string;
}

export interface GoogleMeetReadiness {
  configured: boolean;
  enabled: boolean;
  canCreateSpaces: boolean;
  canReadArtifacts: boolean;
  canUseLiveMedia: boolean;
  missing: string[];
  warnings: string[];
  requiredScopes: string[];
}

const GOOGLE_MEET_SECRET_FIELDS = ['accessToken'] as const;

export const GOOGLE_MEET_SPACE_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
] as const;

export const GOOGLE_MEET_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/meetings.space.settings';

function parseJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeHttpsUrl(value: unknown, field: string): string | undefined {
  const raw = requestString(value);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`${field} must use https:// unless it is localhost`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function buildGoogleMeetConfig(input: {
  enabled?: unknown;
  accessToken?: unknown;
  workspaceDomain?: unknown;
  participantName?: unknown;
  allowedDomains?: unknown;
  defaultBehaviorMode?: unknown;
  mediaApiDeveloperPreview?: unknown;
  mediaSidecarUrl?: unknown;
  consentPolicyAccepted?: unknown;
  configuredAt?: unknown;
}): GoogleMeetConfig {
  const accessToken = requestString(input.accessToken);
  if (!accessToken) throw new Error('accessToken is required');
  const workspaceDomain = requestString(input.workspaceDomain) || undefined;
  const participantName = requestString(input.participantName) || undefined;
  return {
    enabled: input.enabled === false ? false : true,
    accessToken,
    workspaceDomain,
    participantName,
    allowedDomains: normalizeStringList(input.allowedDomains),
    defaultBehaviorMode: normalizeGoogleMeetBehaviorMode(input.defaultBehaviorMode),
    mediaApiDeveloperPreview: input.mediaApiDeveloperPreview === true,
    mediaSidecarUrl: normalizeHttpsUrl(input.mediaSidecarUrl, 'mediaSidecarUrl'),
    consentPolicyAccepted: input.consentPolicyAccepted === true,
    configuredAt: typeof input.configuredAt === 'string' ? input.configuredAt : new Date().toISOString(),
  };
}

export function redactGoogleMeetConfig(config: GoogleMeetConfig): GoogleMeetConfig {
  return {
    ...config,
    accessToken: config.accessToken ? '***' : config.accessToken,
  };
}

export function getGoogleMeetReadiness(config: GoogleMeetConfig | null): GoogleMeetReadiness {
  const missing: string[] = [];
  const warnings: string[] = [];
  const enabled = !!config?.enabled;
  const hasToken = !!config?.accessToken;
  if (!config) missing.push('Google Meet setup');
  if (config && !enabled) missing.push('Google Meet channel enabled');
  if (!hasToken) missing.push('Google Meet OAuth access token');

  const canUseRest = !!config && enabled && hasToken;
  if (canUseRest && !config.participantName) {
    warnings.push('participantName is not configured; meeting presence will use provider defaults');
  }
  if (canUseRest && config.allowedDomains.length === 0) {
    warnings.push('allowedDomains is empty; meeting intake is not domain-restricted');
  }

  const mediaMissing: string[] = [];
  if (!config?.mediaApiDeveloperPreview) {
    mediaMissing.push('Meet Media API Developer Preview enrollment flag');
  }
  if (!config?.mediaSidecarUrl) {
    mediaMissing.push('Meet media sidecar URL');
  }
  if (!config?.consentPolicyAccepted) {
    mediaMissing.push('participant consent policy');
  }

  return {
    configured: !!config,
    enabled,
    canCreateSpaces: canUseRest,
    canReadArtifacts: canUseRest,
    canUseLiveMedia: canUseRest && mediaMissing.length === 0,
    missing: [...missing, ...mediaMissing],
    warnings,
    requiredScopes: [
      ...GOOGLE_MEET_SPACE_SCOPES,
      GOOGLE_MEET_SETTINGS_SCOPE,
    ],
  };
}

export class GoogleMeetManager {
  constructor(private db: Database, private encryptionKey?: string) {}

  private encryptConfig(config: GoogleMeetConfig): GoogleMeetConfig {
    if (!this.encryptionKey) return config;
    const out: GoogleMeetConfig = { ...config };
    for (const field of GOOGLE_MEET_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  private decryptConfig(config: GoogleMeetConfig): GoogleMeetConfig {
    if (!this.encryptionKey) return config;
    const out: GoogleMeetConfig = { ...config };
    for (const field of GOOGLE_MEET_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try { out[field] = decryptSecret(value, this.encryptionKey); } catch { /* fail closed */ }
      }
    }
    return out;
  }

  private normalizeConfig(raw: Record<string, unknown>): GoogleMeetConfig {
    return buildGoogleMeetConfig({
      enabled: raw.enabled,
      accessToken: raw.accessToken,
      workspaceDomain: raw.workspaceDomain,
      participantName: raw.participantName,
      allowedDomains: raw.allowedDomains,
      defaultBehaviorMode: raw.defaultBehaviorMode,
      mediaApiDeveloperPreview: raw.mediaApiDeveloperPreview,
      mediaSidecarUrl: raw.mediaSidecarUrl,
      consentPolicyAccepted: raw.consentPolicyAccepted,
      configuredAt: raw.configuredAt,
    });
  }

  getConfig(agentId: string): GoogleMeetConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return null;
    const meta = parseJson(row.metadata);
    if (!meta.googleMeet || typeof meta.googleMeet !== 'object' || Array.isArray(meta.googleMeet)) return null;
    try {
      return this.decryptConfig(this.normalizeConfig(meta.googleMeet as Record<string, unknown>));
    } catch {
      return null;
    }
  }

  saveConfig(agentId: string, config: GoogleMeetConfig): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);
    const meta = parseJson(row.metadata);
    meta.googleMeet = this.encryptConfig(config);
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }

  removeConfig(agentId: string): void {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as
      { metadata: string } | undefined;
    if (!row) return;
    const meta = parseJson(row.metadata);
    delete meta.googleMeet;
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
  }
}
