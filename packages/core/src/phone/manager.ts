import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../storage/db.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../crypto/secrets.js';
import { normalizePhoneNumber } from '../sms/manager.js';
import { buildTwilioStreamTwiML } from './twilio.js';
import { TWILIO_REALTIME_WS_PATH } from './realtime-paths.js';
import {
  PHONE_MISSION_STATES,
  PHONE_SERVER_MAX_CALL_DURATION_SECONDS,
  PHONE_TASK_MAX_LENGTH,
  validatePhoneMissionStart,
  validatePhoneTransportProfile,
  type OpenClawPhoneMissionPolicy,
  type PhoneMissionState,
  type PhoneTransportProfile,
  type StartPhoneMissionInput,
  type TelephonyTransportCapability,
} from './mission.js';

export type PhoneTransportProvider = '46elks' | 'twilio';

/** Providers that support starting outbound call-control missions. */
export const PHONE_CALL_CONTROL_PROVIDERS: readonly PhoneTransportProvider[] = ['46elks', 'twilio'];

/**
 * Abuse / cost controls for the call-control surface. A phone mission
 * places a real, billed outbound call, so /calls/start needs hard limits
 * that the caller cannot raise (see #43-H1).
 */
export const PHONE_RATE_LIMIT_PER_MINUTE = 5;
export const PHONE_RATE_LIMIT_PER_HOUR = 30;
export const PHONE_MAX_CONCURRENT_MISSIONS = 3;
/** Minimum entropy for an agent-supplied webhook secret (#43-H8). */
export const PHONE_MIN_WEBHOOK_SECRET_LENGTH = 24;

/** Terminal mission states — no further status transition is permitted. */
const TERMINAL_MISSION_STATES: readonly PhoneMissionState[] = ['completed', 'failed', 'cancelled'];

/**
 * Thrown by the webhook handlers for ANY authentication failure —
 * unknown mission, missing token, or wrong token alike. Uniform on
 * purpose: the route maps it to a single 403 + generic body so an
 * unauthenticated caller cannot tell a real missionId from a fake one
 * (#43-H3 — the 404-vs-403 enumeration oracle).
 */
export class PhoneWebhookAuthError extends Error {
  readonly isPhoneWebhookAuthError = true;
  constructor() {
    super('Invalid phone webhook request');
    this.name = 'PhoneWebhookAuthError';
  }
}

/** Thrown when /calls/start is refused by a rate/concurrency limit (#43-H1). */
export class PhoneRateLimitError extends Error {
  readonly isPhoneRateLimitError = true;
  constructor(message: string) {
    super(message);
    this.name = 'PhoneRateLimitError';
  }
}

export interface PhoneTransportConfig extends PhoneTransportProfile {
  provider: PhoneTransportProvider;
  username: string;
  password: string;
  webhookBaseUrl: string;
  webhookSecret: string;
  apiUrl?: string;
  configuredAt: string;
}

export interface PhoneMissionTranscriptEntry {
  at: string;
  source: 'system' | 'provider' | 'agent' | 'operator';
  text: string;
  metadata?: Record<string, unknown>;
}

export type OperatorQueryUrgency = 'normal' | 'high';

/**
 * A question the voice agent put to its human operator mid-call via the
 * `ask_operator` tool (plan §4 / §5). Persisted on the mission under
 * `metadata.operatorQueries[]` and exposed by the operator-query API
 * endpoints. The bridge's `ask_operator` tool blocks polling this
 * record until `answer` is set or the hard timeout elapses.
 */
export interface PhoneOperatorQuery {
  /** `oq_<uuid>` — unique across all missions. */
  id: string;
  /** The question, sanitised + length-bounded. */
  question: string;
  /** One-line context on the call, if the agent supplied it. */
  callContext?: string;
  urgency: OperatorQueryUrgency;
  askedAt: string;
  /** The operator's answer — set once, never overwritten (idempotent). */
  answer?: string;
  answeredAt?: string;
  /** Channel the answer arrived on (e.g. `api`, `email`). */
  answeredVia?: string;
}

export interface PhoneCallMission {
  id: string;
  agentId: string;
  status: PhoneMissionState;
  from: string;
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  transport: PhoneTransportProfile;
  provider: PhoneTransportProvider;
  providerCallId?: string;
  transcript: PhoneMissionTranscriptEntry[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StartPhoneCallOptions {
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface StartPhoneCallResult {
  mission: PhoneCallMission;
  providerRequest?: {
    url: string;
    body: Record<string, string>;
  };
  providerResponse?: unknown;
}

export interface PhoneWebhookResult {
  mission: PhoneCallMission;
  action: Record<string, unknown>;
}

const PHONE_SECRET_FIELDS = ['password', 'webhookSecret'] as const;
const MAX_PHONE_WEBHOOK_EVENT_KEYS = 50;

/**
 * Bounds on operator-query free text. The `question` rides into the
 * notification + a `function_call` output; the `answer` rides back into
 * the model and (on a callback) into the session instructions. Both are
 * attacker-influenceable (question from the model, answer from whoever
 * hits the answer endpoint), so strip control characters and bound the
 * length — same discipline as the mission `task` (#42-H2).
 */
const OPERATOR_QUERY_QUESTION_MAX_LENGTH = 2000;
const OPERATOR_QUERY_ANSWER_MAX_LENGTH = 4000;
const OPERATOR_QUERY_CONTEXT_MAX_LENGTH = 500;
/** Cap on operator-query records kept per mission. */
const MAX_OPERATOR_QUERIES = 50;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Default 46elks REST API root. */
const ELKS_DEFAULT_API_URL = 'https://api.46elks.com/a1';
/** Twilio REST API root — the `{AccountSid}` segment is appended per call. */
const TWILIO_DEFAULT_API_URL = 'https://api.twilio.com/2010-04-01';

function defaultApiUrl(config: PhoneTransportConfig): string {
  const fallback = config.provider === 'twilio' ? TWILIO_DEFAULT_API_URL : ELKS_DEFAULT_API_URL;
  const url = (config.apiUrl || fallback).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`${config.provider} apiUrl must use https:// — refusing to send credentials over a non-TLS connection`);
  }
  return url;
}

function basicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function apiBaseUrl(webhookBaseUrl: string): string {
  const root = webhookBaseUrl.replace(/\/+$/, '');
  return root.endsWith('/api/agenticmail') ? root : `${root}/api/agenticmail`;
}

/**
 * Per-mission webhook token (#43-H7). The webhook URL we hand to 46elks
 * carries `token = HMAC-SHA256(webhookSecret, missionId)` instead of the
 * raw shared `webhookSecret`. Two wins over carrying the secret directly:
 *   1. The shared secret never appears in a URL / provider logs / proxies.
 *   2. A leaked webhook URL exposes exactly ONE mission's token — it can't
 *      be used to forge webhooks for any other mission of that agent.
 * The webhook handler recomputes the token from the mission's config
 * secret + the mission id and compares it timing-safe.
 */
function webhookToken(webhookSecret: string, missionId: string): string {
  return createHmac('sha256', webhookSecret).update(missionId).digest('hex');
}

function buildWebhookUrl(config: PhoneTransportConfig, path: string, missionId: string): string {
  const url = new URL(`${apiBaseUrl(config.webhookBaseUrl)}${path}`);
  url.searchParams.set('missionId', missionId);
  url.searchParams.set('token', webhookToken(config.webhookSecret, missionId));
  return url.toString();
}

/**
 * Build the `wss://…` URL a Twilio `<Connect><Stream>` connects to —
 * the realtime voice WebSocket carrying the mission id + per-mission
 * token (#43-H7) as query params. The scheme is upgraded from the
 * configured `webhookBaseUrl` (`https://` → `wss://`, `http://` →
 * `ws://` for a localhost dev base).
 */
function buildRealtimeStreamUrl(webhookBaseUrl: string, missionId: string, token: string): string {
  // `TWILIO_REALTIME_WS_PATH` already includes the `/api/agenticmail` prefix
  // (it is mounted on the root server, not under the api-base sub-app), so we
  // join it directly onto `webhookBaseUrl` — going through `apiBaseUrl()`
  // would double-prefix the path (`/api/agenticmail/api/agenticmail/...`) and
  // Twilio's `<Stream>` would 404 on connect, dropping the call on pickup.
  const root = webhookBaseUrl.replace(/\/+$/, '');
  const url = new URL(`${root}${TWILIO_REALTIME_WS_PATH}`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('missionId', missionId);
  url.searchParams.set('token', token);
  return url.toString();
}

function redactWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    // Redact both the per-mission token and any legacy `secret` param.
    if (url.searchParams.has('token')) url.searchParams.set('token', '***');
    if (url.searchParams.has('secret')) url.searchParams.set('secret', '***');
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

/** Body keys that carry a token-bearing webhook URL — redacted for storage/output. */
const WEBHOOK_URL_BODY_KEYS = ['voice_start', 'whenhangup', 'Url', 'StatusCallback'] as const;

/**
 * Redact every token-bearing webhook URL in a provider request body.
 * Provider-agnostic — handles both the 46elks (`voice_start` /
 * `whenhangup`) and Twilio (`Url` / `StatusCallback`) body shapes; keys
 * absent for a given provider are simply skipped.
 */
function redactProviderRequest(request: { url: string; body: Record<string, string> }): { url: string; body: Record<string, string> } {
  const body = { ...request.body };
  for (const key of WEBHOOK_URL_BODY_KEYS) {
    if (typeof body[key] === 'string') body[key] = redactWebhookUrl(body[key]);
  }
  return { url: request.url, body };
}

function stableFlatJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function phoneWebhookEventKey(kind: 'voice_start' | 'hangup', payload: Record<string, unknown>): string {
  const callId = asString(payload.callid) || asString(payload.id) || asString(payload.call_id);
  const result = asString(payload.result) || asString(payload.status) || asString(payload.why);
  const fingerprint = createHash('sha256').update(stableFlatJson(payload)).digest('hex').slice(0, 16);
  return [kind, callId || fingerprint, result].filter(Boolean).join(':');
}

function processedWebhookEventKeys(mission: PhoneCallMission): string[] {
  const value = mission.metadata.phoneWebhookEvents;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function hasProcessedWebhookEvent(mission: PhoneCallMission, eventKey: string): boolean {
  return processedWebhookEventKeys(mission).includes(eventKey);
}

function appendProcessedWebhookEvent(mission: PhoneCallMission, eventKey: string): string[] {
  return [...processedWebhookEventKeys(mission), eventKey].slice(-MAX_PHONE_WEBHOOK_EVENT_KEYS);
}

/**
 * Strip control characters (keep tab/newline) and bound the length of
 * an operator-query free-text field. Mirrors the mission-`task`
 * sanitisation (#42-H2) — these strings flow into model output and, on
 * a callback, into session instructions, so a control-laced or
 * unbounded string must not ride through.
 */
function sanitizeOperatorText(value: unknown, maxLength: number): string {
  const raw = typeof value === 'string' ? value : '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Read the well-formed operator-query records off a mission. */
function readOperatorQueries(mission: PhoneCallMission): PhoneOperatorQuery[] {
  const value = mission.metadata.operatorQueries;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PhoneOperatorQuery => (
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    && typeof (item as PhoneOperatorQuery).id === 'string'
    && typeof (item as PhoneOperatorQuery).question === 'string'
  ));
}

/**
 * Read the callback chain depth from a mission's metadata. Depth 0
 * means "this is not a callback" (a brand-new mission); depth 1 is
 * "this mission was itself spawned by a scheduled callback"; depth N
 * means N hops removed from the original. We store the depth on the
 * NEW (callback) mission's metadata as `callbackChainDepth` so we
 * don't have to walk the parent chain.
 */
function readChainDepth(mission: PhoneCallMission): number {
  const raw = mission.metadata.callbackChainDepth;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  // If the parent mission itself has a `scheduledCallback` record that
  // was already fired, take its chainDepth — defence in depth for
  // missions written before callbackChainDepth was a metadata key.
  const sc = mission.metadata.scheduledCallback as PhoneScheduledCallback | undefined;
  if (sc && Number.isFinite(sc.chainDepth)) return Math.floor(sc.chainDepth);
  return 0;
}

/** Escape SQL `LIKE` metacharacters so a value is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Compose the continuation `task` for a callback-on-disconnect (plan
 * §7): the original objective, a note that the call was cut off, and
 * the operator's answer the agent was waiting for. Bounded to
 * {@link PHONE_TASK_MAX_LENGTH} so it always clears mission validation.
 */
function buildCallbackTask(originalTask: string, query: PhoneOperatorQuery): string {
  const continuity = [
    '# Call continuity',
    'You were already on this call and paused to check something with your operator. The call was '
    + 'disconnected before you had the answer, so you are now calling the person back. Open by '
    + 'acknowledging it — e.g. "Sorry we got cut off — I have that answer for you now."',
    '',
    `Your operator's answer to "${query.question}" is: ${query.answer ?? ''}`,
    '',
    'Use that answer to finish the original task below.',
    '',
    '# Original task',
  ].join('\n');
  // Reserve room for the continuity block; trim the original task if needed.
  const room = Math.max(0, PHONE_TASK_MAX_LENGTH - continuity.length - 1);
  return `${continuity}\n${originalTask.slice(0, room)}`.slice(0, PHONE_TASK_MAX_LENGTH);
}

/**
 * Persisted shape of a `schedule_callback` request. Stored verbatim
 * on `mission.metadata.scheduledCallback`; the scheduler reads it back
 * when the wall-clock reaches `at`.
 *
 *   - `at`         — when to dial back, ISO timestamp
 *   - `reason`     — short audit string
 *   - `agentSummary` — what the next call needs to know (model-provided)
 *   - `transcriptDigest` — bridge-built rolling transcript snapshot
 *   - `chainDepth` — 0 for first scheduled callback, 1 if THIS mission
 *                   was itself a callback, 2 if its parent was too, …
 *                   Used to enforce `policy.callbackPolicy.maxCallbackChain`
 *                   without re-walking the chain at dial time.
 *   - `status`     — pending → dialing → fired (mission spawned) | failed
 *   - `callbackMissionId` — id of the new mission once dialing happens
 *   - `armedAt`    — when this record was written, audit only
 *   - `firedAt`    — when the scheduler actually dialed
 *   - `lastError`  — last dial-failure message (the scheduler retries
 *                   inside the manager; this is the visibility hook)
 */
export interface PhoneScheduledCallback {
  at: string;
  reason: string;
  agentSummary: string;
  transcriptDigest: string;
  chainDepth: number;
  status: 'pending' | 'dialing' | 'fired' | 'failed';
  callbackMissionId?: string;
  armedAt: string;
  firedAt?: string;
  lastError?: string;
}

/**
 * Compose the continuation task for a SCHEDULED callback (the
 * `schedule_callback` tool path, separate from the operator-query
 * callback path above). The next call's agent sees:
 *
 *   - what happened on the prior call (reason + agent's own summary)
 *   - a rolling transcript digest from the bridge (the actual lines)
 *   - the original task
 *
 * Bounded to {@link PHONE_TASK_MAX_LENGTH}; the original task is
 * trimmed last to make room for the continuity context (which is the
 * whole point of the callback).
 */
function buildScheduledCallbackTask(
  originalTask: string,
  payload: { reason: string; agentSummary: string; transcriptDigest: string },
): string {
  const continuity = [
    '# Call continuity — auto-callback',
    'You were on a call with this person earlier and scheduled this follow-up before signing off. '
    + 'Open by acknowledging it naturally — e.g. "Hi, this is <your name> calling back as I said I '
    + 'would." Then continue the conversation from where you left off.',
    '',
    `## Why you arranged this callback\n${payload.reason}`,
    '',
    `## Notes you left for yourself (your own summary at the end of the prior call)\n${payload.agentSummary}`,
    '',
    `## What was actually said on the prior call (verbatim digest)\n${payload.transcriptDigest}`,
    '',
    '# Original task',
  ].join('\n');
  const room = Math.max(0, PHONE_TASK_MAX_LENGTH - continuity.length - 1);
  return `${continuity}\n${originalTask.slice(0, room)}`.slice(0, PHONE_TASK_MAX_LENGTH);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMission(row: any): PhoneCallMission {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    from: row.from_phone,
    to: row.to_phone,
    task: row.task,
    policy: parseJson(row.policy_json, {} as OpenClawPhoneMissionPolicy),
    transport: parseJson(row.transport_json, {} as PhoneTransportProfile),
    provider: row.provider,
    providerCallId: row.provider_call_id ?? undefined,
    transcript: parseJson(row.transcript_json, []),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function redactPhoneTransportConfig(config: PhoneTransportConfig): PhoneTransportConfig {
  return {
    ...config,
    password: config.password ? '***' : '',
    webhookSecret: config.webhookSecret ? '***' : '',
  };
}

export class PhoneManager {
  private initialized = false;
  /** Per-agent outbound-call timestamps (ms) for the in-memory rate limiter. */
  private readonly callTimestamps = new Map<string, number[]>();

  constructor(private db: Database, private encryptionKey?: string) {
    this.ensureTables();
  }

  /**
   * Abuse / cost gate for /calls/start (#43-H1). Each non-dry-run call is
   * a real billed outbound call, so before dialing we enforce:
   *   - a hard cap on concurrently-active (non-terminal) missions, and
   *   - a per-agent token-bucket rate limit (per-minute + per-hour).
   * Throws {@link PhoneRateLimitError} (-> HTTP 429) when a limit is hit.
   * Call only on the real path — dry runs place no call and are exempt.
   */
  private enforceCallLimits(agentId: string, nowMs: number): void {
    const activeRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM phone_missions
       WHERE agent_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
    ).get(agentId) as { cnt: number } | undefined;
    if ((activeRow?.cnt ?? 0) >= PHONE_MAX_CONCURRENT_MISSIONS) {
      throw new PhoneRateLimitError(
        `Too many active phone missions (max ${PHONE_MAX_CONCURRENT_MISSIONS}). Wait for an active call to end before starting another.`,
      );
    }

    const recent = (this.callTimestamps.get(agentId) ?? []).filter((ts) => nowMs - ts < 3_600_000);
    const lastMinute = recent.filter((ts) => nowMs - ts < 60_000).length;
    if (lastMinute >= PHONE_RATE_LIMIT_PER_MINUTE) {
      throw new PhoneRateLimitError(
        `Phone call rate limit reached (max ${PHONE_RATE_LIMIT_PER_MINUTE}/minute). Try again shortly.`,
      );
    }
    if (recent.length >= PHONE_RATE_LIMIT_PER_HOUR) {
      throw new PhoneRateLimitError(
        `Phone call rate limit reached (max ${PHONE_RATE_LIMIT_PER_HOUR}/hour). Try again later.`,
      );
    }
    recent.push(nowMs);
    this.callTimestamps.set(agentId, recent);
  }

  private encryptConfig(config: PhoneTransportConfig): PhoneTransportConfig {
    if (!this.encryptionKey) return config;
    const out: PhoneTransportConfig = { ...config };
    for (const field of PHONE_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !isEncryptedSecret(value)) {
        out[field] = encryptSecret(value, this.encryptionKey);
      }
    }
    return out;
  }

  private decryptConfig(config: PhoneTransportConfig): PhoneTransportConfig {
    if (!this.encryptionKey) return config;
    const out: PhoneTransportConfig = { ...config };
    for (const field of PHONE_SECRET_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && isEncryptedSecret(value)) {
        try {
          out[field] = decryptSecret(value, this.encryptionKey);
        } catch {
          // Leave ciphertext in place; downstream validation fails closed.
        }
      }
    }
    return out;
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phone_missions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        from_phone TEXT NOT NULL,
        to_phone TEXT NOT NULL,
        task TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        transport_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_call_id TEXT,
        transcript_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_phone_missions_agent ON phone_missions(agent_id)'); } catch {}
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_phone_missions_status ON phone_missions(status)'); } catch {}
    this.initialized = true;
  }

  getPhoneTransportConfig(agentId: string): PhoneTransportConfig | null {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) return null;
    const meta = parseJson<Record<string, unknown>>(row.metadata, {});
    const config = meta.phoneTransport;
    if (!config || typeof config !== 'object') return null;
    return this.decryptConfig(config as PhoneTransportConfig);
  }

  savePhoneTransportConfig(agentId: string, config: PhoneTransportConfig): PhoneTransportConfig {
    const row = this.db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId) as { metadata: string } | undefined;
    if (!row) throw new Error(`Agent ${agentId} not found`);

    const transportCheck = validatePhoneTransportProfile(config);
    if (!transportCheck.ok) {
      throw new Error(`Invalid phone transport config: ${transportCheck.issues.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
    }

    const meta = parseJson<Record<string, unknown>>(row.metadata, {});
    meta.phoneTransport = this.encryptConfig({
      ...config,
      phoneNumber: transportCheck.transport.phoneNumber,
      capabilities: transportCheck.transport.capabilities,
      supportedRegions: transportCheck.transport.supportedRegions,
    });
    this.db.prepare("UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(meta), agentId);
    return config;
  }

  getMission(missionId: string, agentId?: string): PhoneCallMission | null {
    const row = agentId
      ? this.db.prepare('SELECT * FROM phone_missions WHERE id = ? AND agent_id = ?').get(missionId, agentId)
      : this.db.prepare('SELECT * FROM phone_missions WHERE id = ?').get(missionId);
    return row ? rowToMission(row) : null;
  }

  listMissions(agentId: string, opts: { limit?: number; offset?: number; status?: PhoneMissionState } = {}): PhoneCallMission[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: (string | number)[] = [agentId];
    let sql = 'SELECT * FROM phone_missions WHERE agent_id = ?';
    if (opts.status && (PHONE_MISSION_STATES as readonly string[]).includes(opts.status)) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToMission);
  }

  async startMission(
    agentId: string,
    input: StartPhoneMissionInput,
    options: StartPhoneCallOptions = {},
  ): Promise<StartPhoneCallResult> {
    const config = this.getPhoneTransportConfig(agentId);
    if (!config) {
      throw new Error('Phone transport is not configured. Use phone_transport_setup first.');
    }
    if (!PHONE_CALL_CONTROL_PROVIDERS.includes(config.provider)) {
      throw new Error(`Phone provider ${config.provider} does not support call_control yet`);
    }

    const validation = validatePhoneMissionStart(input, config);
    if (!validation.ok) {
      throw new Error(`Invalid phone mission: ${validation.issues.map((item) => `${item.code} (${item.field})`).join(', ')}`);
    }

    const now = options.now ?? new Date();

    // Abuse / cost gate (#43-H1) — a real (non-dry-run) call must pass
    // the concurrency cap + per-agent rate limit BEFORE a mission row is
    // created or the carrier is dialled. Dry runs place no call: exempt.
    if (!options.dryRun) {
      this.enforceCallLimits(agentId, now.getTime());
    }

    const missionId = `call_${randomUUID()}`;
    const transcript: PhoneMissionTranscriptEntry[] = [{
      at: now.toISOString(),
      source: 'system',
      text: 'Phone mission created; outbound carrier call requested.',
    }];
    const metadata: Record<string, unknown> = {
      voiceRuntimeRef: validation.mission.voiceRuntimeRef,
      targetRegion: validation.mission.targetRegion,
      dryRun: !!options.dryRun,
      // Attempt counter (#43-H2) — wired for breach detection; there is
      // no automatic retry loop today, so a fresh mission is attempt 1.
      attempts: 1,
    };

    const mission: PhoneCallMission = {
      id: missionId,
      agentId,
      status: 'dialing',
      from: config.phoneNumber,
      to: validation.mission.to,
      task: validation.mission.task,
      policy: validation.mission.policy,
      transport: validation.mission.transport,
      provider: config.provider,
      transcript,
      metadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.insertMission(mission);

    // Dispatch to the provider's outbound-call request builder. Both
    // providers authenticate with HTTP Basic + an x-www-form-urlencoded
    // body, so the actual fetch below is provider-agnostic.
    const providerRequest = config.provider === 'twilio'
      ? this.buildTwilioCallRequest(config, mission)
      : this.build46ElksCallRequest(config, mission);
    if (options.dryRun) {
      const updated = this.updateProviderCall(missionId, 'dryrun-call', {
        dryRun: true,
        providerRequest: redactProviderRequest(providerRequest),
      });
      return { mission: updated, providerRequest };
    }

    const fetchFn = options.fetchFn ?? fetch;
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchFn(providerRequest.url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth(config.username, config.password)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(providerRequest.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Fail-closed (#43-H4) — the row was inserted as `dialing` before
      // the provider call. A thrown fetch (network error, DNS failure,
      // the 15s AbortSignal timeout) would otherwise leave the mission
      // stuck in `dialing` forever. Transition it to `failed` before
      // rethrowing so the mission state always reflects reality.
      const message = (err as Error)?.message ?? String(err);
      this.updateMissionStatus(missionId, 'failed', {
        providerError: message,
      }, [{
        at: new Date().toISOString(),
        source: 'provider',
        text: `${config.provider} call start failed — the provider request threw before any response.`,
        metadata: { error: message },
      }]);
      throw err;
    }

    const text = await response.text();
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep provider response as raw text.
    }

    if (!response.ok) {
      const failed = this.updateMissionStatus(missionId, 'failed', {
        providerStatus: response.status,
        providerResponse: raw,
      }, [{
        at: new Date().toISOString(),
        source: 'provider',
        text: `${config.provider} call start failed with HTTP ${response.status}.`,
        metadata: { providerResponse: raw },
      }]);
      throw new Error(`${config.provider} call start failed (${response.status}) for mission ${failed.id}`);
    }

    // The provider call id field differs by provider: 46elks returns
    // `id`, Twilio's Calls.json returns `sid`. Accept either.
    const rawRecord = asRecord(raw);
    const rawCallId = rawRecord.sid ?? rawRecord.id;
    const providerCallId = rawCallId ? String(rawCallId) : undefined;
    const updated = this.updateProviderCall(missionId, providerCallId, { providerResponse: raw });
    return { mission: updated, providerRequest, providerResponse: raw };
  }

  /**
   * Verify a webhook request and return the mission, or throw a uniform
   * {@link PhoneWebhookAuthError} for ANY failure (unknown mission, no
   * token, wrong token). Uniform on purpose — no 404-vs-403 oracle.
   */
  private authenticateWebhook(missionId: string, providedToken: string): PhoneCallMission {
    const mission = missionId ? this.getMission(missionId) : null;
    const config = mission ? this.getPhoneTransportConfig(mission.agentId) : null;
    if (!mission || !config || !providedToken
        || !secretMatches(providedToken, webhookToken(config.webhookSecret, mission.id))) {
      throw new PhoneWebhookAuthError();
    }
    return mission;
  }

  handleVoiceStartWebhook(missionId: string, providedToken: string, payload: Record<string, unknown> = {}): PhoneWebhookResult {
    const mission = this.authenticateWebhook(missionId, providedToken);

    // Terminal-state guard (#43-H5) — a late or replayed voice_start must
    // not resurrect a mission that already reached completed/failed/
    // cancelled. handleHangupWebhook already guards terminal states;
    // voice_start did not. Acknowledge the provider, change nothing.
    if (TERMINAL_MISSION_STATES.includes(mission.status)) {
      return { mission, action: this.buildVoiceStartAction() };
    }

    const eventKey = phoneWebhookEventKey('voice_start', payload);
    if (hasProcessedWebhookEvent(mission, eventKey)) {
      return {
        mission,
        action: this.buildVoiceStartAction(),
      };
    }

    const updated = this.updateMissionStatus(mission.id, 'connected', {
      lastVoiceStartPayload: payload,
      phoneWebhookEvents: appendProcessedWebhookEvent(mission, eventKey),
    }, [{
      at: new Date().toISOString(),
      source: 'provider',
      text: '46elks voice_start webhook received. Realtime voice runtime is not connected in this slice.',
      metadata: { payload },
    }]);

    return {
      mission: updated,
      action: this.buildVoiceStartAction(),
    };
  }

  handleHangupWebhook(missionId: string, providedToken: string, payload: Record<string, unknown> = {}): PhoneCallMission {
    const mission = this.authenticateWebhook(missionId, providedToken);

    const eventKey = phoneWebhookEventKey('hangup', payload);
    if (hasProcessedWebhookEvent(mission, eventKey)) {
      return mission;
    }

    // Cost accumulation (#43-H2) — 46elks reports the call cost on hangup.
    // Record it against the mission and flag if it breached the policy cap.
    const costPatch = this.buildCostMetadataPatch(mission, payload);

    const nextStatus: PhoneMissionState = TERMINAL_MISSION_STATES.includes(mission.status)
      ? mission.status
      : 'failed';
    const transcript: PhoneMissionTranscriptEntry[] = [{
      at: new Date().toISOString(),
      source: 'provider',
      text: nextStatus === 'failed'
        ? '46elks hangup webhook received before a conversation runtime completed the mission.'
        : '46elks hangup webhook received.',
      metadata: { payload },
    }];
    if (costPatch.costExceeded) {
      transcript.push({
        at: new Date().toISOString(),
        source: 'system',
        text: `Mission cost ${costPatch.totalCost} exceeded the policy cap of ${mission.policy.maxCostPerMission}.`,
      });
    }
    return this.updateMissionStatus(mission.id, nextStatus, {
      lastHangupPayload: payload,
      hangupReason: nextStatus === 'failed' ? 'call-ended-before-conversation-runtime' : undefined,
      phoneWebhookEvents: appendProcessedWebhookEvent(mission, eventKey),
      ...costPatch,
    }, transcript);
  }

  /**
   * Handle Twilio's voice webhook — the `Url` Twilio fetches when the
   * outbound call connects. The mirror of {@link handleVoiceStartWebhook}
   * for Twilio: it authenticates the per-mission token, transitions the
   * mission to `connected`, and returns the TwiML to send back.
   *
   * `twiml` is a `<Connect><Stream>` document that wires the call's
   * audio to the realtime voice WebSocket — the same realtime path the
   * 46elks websocket-number uses. The route serves it with
   * `Content-Type: text/xml`.
   *
   * Like the 46elks handler this is terminal-state-guarded (#43-H5,
   * a late/replayed webhook cannot resurrect a finished mission) and
   * idempotent (a duplicate is acknowledged with the same TwiML but
   * changes nothing).
   */
  handleTwilioVoiceWebhook(
    missionId: string,
    providedToken: string,
    payload: Record<string, unknown> = {},
  ): { mission: PhoneCallMission; twiml: string } {
    const mission = this.authenticateWebhook(missionId, providedToken);
    const config = this.getPhoneTransportConfig(mission.agentId)!;
    const twiml = this.buildTwilioVoiceTwiML(config, mission);

    if (TERMINAL_MISSION_STATES.includes(mission.status)) {
      return { mission, twiml };
    }

    const eventKey = phoneWebhookEventKey('voice_start', payload);
    if (hasProcessedWebhookEvent(mission, eventKey)) {
      return { mission, twiml };
    }

    const updated = this.updateMissionStatus(mission.id, 'connected', {
      lastVoiceStartPayload: payload,
      phoneWebhookEvents: appendProcessedWebhookEvent(mission, eventKey),
    }, [{
      at: new Date().toISOString(),
      source: 'provider',
      text: 'Twilio voice webhook received — connecting the call to the realtime voice stream.',
      metadata: { payload },
    }]);

    return { mission: updated, twiml };
  }

  /**
   * Handle Twilio's status callback — the `StatusCallback` Twilio POSTs
   * with the terminal call status. The mirror of
   * {@link handleHangupWebhook} for Twilio. Idempotent + terminal-state
   * guarded; records the reported `CallDuration` and accumulates cost
   * from `Price` when Twilio supplied it (Twilio reports the final
   * price asynchronously, so it may be absent on the first callback —
   * the duration ceiling / rate limit / concurrency cap remain the
   * preventive cost controls, #43-H2).
   */
  handleTwilioStatusWebhook(
    missionId: string,
    providedToken: string,
    payload: Record<string, unknown> = {},
  ): PhoneCallMission {
    const mission = this.authenticateWebhook(missionId, providedToken);

    const eventKey = phoneWebhookEventKey('hangup', payload);
    if (hasProcessedWebhookEvent(mission, eventKey)) {
      return mission;
    }

    const costPatch = this.buildTwilioCostMetadataPatch(mission, payload);

    const nextStatus: PhoneMissionState = TERMINAL_MISSION_STATES.includes(mission.status)
      ? mission.status
      : 'failed';
    const transcript: PhoneMissionTranscriptEntry[] = [{
      at: new Date().toISOString(),
      source: 'provider',
      text: nextStatus === 'failed'
        ? 'Twilio status callback received before a conversation runtime completed the mission.'
        : 'Twilio status callback received.',
      metadata: { payload },
    }];
    if (costPatch.costExceeded) {
      transcript.push({
        at: new Date().toISOString(),
        source: 'system',
        text: `Mission cost ${costPatch.totalCost} exceeded the policy cap of ${mission.policy.maxCostPerMission}.`,
      });
    }
    return this.updateMissionStatus(mission.id, nextStatus, {
      lastHangupPayload: payload,
      hangupReason: nextStatus === 'failed' ? 'call-ended-before-conversation-runtime' : undefined,
      phoneWebhookEvents: appendProcessedWebhookEvent(mission, eventKey),
      ...costPatch,
    }, transcript);
  }

  /**
   * Build the TwiML for the Twilio voice webhook — a `<Connect><Stream>`
   * pointing at the realtime voice WebSocket. The `<Stream>` URL is
   * derived from `webhookBaseUrl` (https → wss); the per-mission token
   * (#43-H7) rides as both a `<Parameter>` and a query param so the
   * media socket can be matched to its mission.
   */
  private buildTwilioVoiceTwiML(config: PhoneTransportConfig, mission: PhoneCallMission): string {
    const token = webhookToken(config.webhookSecret, mission.id);
    return buildTwilioStreamTwiML({
      streamUrl: buildRealtimeStreamUrl(config.webhookBaseUrl, mission.id, token),
      parameters: { missionId: mission.id, token },
    });
  }

  /**
   * Read the call cost off a Twilio status callback (`Price`, a
   * negative or string number), add it to the mission's running total,
   * and flag a policy-cap breach (#43-H2). Twilio prices are reported
   * as a negative amount (a debit); we use the absolute value.
   */
  private buildTwilioCostMetadataPatch(
    mission: PhoneCallMission,
    payload: Record<string, unknown>,
  ): { totalCost: number; costExceeded: boolean } {
    const rawPrice = payload.Price ?? payload.price;
    const parsed = typeof rawPrice === 'number'
      ? rawPrice
      : Number.parseFloat(asString(rawPrice));
    const callCost = Number.isFinite(parsed) ? Math.abs(parsed) : 0;
    const priorCost = typeof mission.metadata.totalCost === 'number' ? mission.metadata.totalCost : 0;
    const totalCost = Math.round((priorCost + callCost) * 1e6) / 1e6;
    const cap = mission.policy?.maxCostPerMission;
    const costExceeded = typeof cap === 'number' && totalCost > cap;
    return { totalCost, costExceeded };
  }

  /**
   * Read the call cost off a 46elks hangup payload, add it to the
   * mission's running total, and flag a policy-cap breach (#43-H2).
   * Cost is only knowable post-call from the provider — the preventive
   * cost controls are the duration ceiling, rate limit, and concurrency
   * cap; this is the after-the-fact accounting + alerting.
   */
  private buildCostMetadataPatch(
    mission: PhoneCallMission,
    payload: Record<string, unknown>,
  ): { totalCost: number; costExceeded: boolean } {
    const rawCost = payload.cost;
    const callCost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
      ? rawCost
      : Number.parseFloat(asString(rawCost)) || 0;
    const priorCost = typeof mission.metadata.totalCost === 'number' ? mission.metadata.totalCost : 0;
    const totalCost = Math.round((priorCost + callCost) * 1e6) / 1e6;
    const cap = mission.policy?.maxCostPerMission;
    const costExceeded = typeof cap === 'number' && totalCost > cap;
    return { totalCost, costExceeded };
  }

  private buildVoiceStartAction(): Record<string, unknown> {
    return {
      play: 'AgenticMail has received this call mission. The live voice runtime is not connected yet; the operator will follow up.',
    };
  }

  cancelMission(agentId: string, missionId: string): PhoneCallMission {
    const mission = this.getMission(missionId, agentId);
    if (!mission) throw new Error('Phone mission not found');
    return this.updateMissionStatus(mission.id, 'cancelled', {}, [{
      at: new Date().toISOString(),
      source: 'operator',
      text: 'Phone mission cancelled.',
    }]);
  }

  /**
   * Resolve a mission by the provider's call id (the 46elks `callid`).
   * The realtime voice bridge uses this to match an inbound 46elks
   * realtime-media WebSocket — whose `hello` frame carries `callid` —
   * back to the mission that placed the call, so the right agent's
   * memory and task can be loaded into the OpenAI Realtime session.
   */
  findMissionByProviderCallId(providerCallId: string, agentId?: string): PhoneCallMission | null {
    if (!providerCallId) return null;
    const row = agentId
      ? this.db.prepare('SELECT * FROM phone_missions WHERE provider_call_id = ? AND agent_id = ?').get(providerCallId, agentId)
      : this.db.prepare('SELECT * FROM phone_missions WHERE provider_call_id = ?').get(providerCallId);
    return row ? rowToMission(row) : null;
  }

  /**
   * Append transcript entries produced by the realtime voice bridge and
   * optionally transition the mission status. A mission already in a
   * terminal state keeps that state — a late bridge event must not
   * resurrect a completed/failed/cancelled mission (mirrors the
   * terminal-state guard on the webhook handlers). No-op if the mission
   * no longer exists.
   */
  recordRealtimeActivity(
    missionId: string,
    entries: PhoneMissionTranscriptEntry[],
    status?: PhoneMissionState,
  ): PhoneCallMission | null {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    const nextStatus = TERMINAL_MISSION_STATES.includes(mission.status)
      ? mission.status
      : (status ?? mission.status);
    return this.updateMissionStatus(mission.id, nextStatus, {}, entries);
  }

  // ─── Operator queries (ask_operator) ──────────────────

  /**
   * Record an operator query against a mission — the first step of the
   * `ask_operator` tool (plan §4). Returns the persisted query; the
   * bridge then polls {@link getOperatorQuery} for an answer. Throws on
   * an unknown mission or an empty question.
   */
  addOperatorQuery(
    missionId: string,
    input: { question: string; callContext?: string; urgency?: string },
  ): { mission: PhoneCallMission; query: PhoneOperatorQuery } {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');

    const question = sanitizeOperatorText(input.question, OPERATOR_QUERY_QUESTION_MAX_LENGTH);
    if (!question) throw new Error('Operator query question is required');
    const callContext = sanitizeOperatorText(input.callContext, OPERATOR_QUERY_CONTEXT_MAX_LENGTH);

    const query: PhoneOperatorQuery = {
      id: `oq_${randomUUID()}`,
      question,
      ...(callContext ? { callContext } : {}),
      urgency: input.urgency === 'high' ? 'high' : 'normal',
      askedAt: new Date().toISOString(),
    };
    const queries = [...readOperatorQueries(mission), query].slice(-MAX_OPERATOR_QUERIES);
    const updated = this.updateMissionStatus(mission.id, mission.status, {
      operatorQueries: queries,
    }, [{
      at: query.askedAt,
      source: 'agent',
      text: `Asked the operator: ${question}`,
      metadata: { queryId: query.id, urgency: query.urgency },
    }]);
    return { mission: updated, query };
  }

  /** List the operator queries recorded on a mission. */
  listOperatorQueries(missionId: string, agentId?: string): PhoneOperatorQuery[] {
    const mission = this.getMission(missionId, agentId);
    return mission ? readOperatorQueries(mission) : [];
  }

  /** Read one operator query, or null if the mission/query is unknown. */
  getOperatorQuery(missionId: string, queryId: string, agentId?: string): PhoneOperatorQuery | null {
    const mission = this.getMission(missionId, agentId);
    if (!mission) return null;
    return readOperatorQueries(mission).find((query) => query.id === queryId) ?? null;
  }

  /**
   * Resolve a mission + query by the query id alone — used by the
   * inbound email-reply hook, which only has the id parsed out of the
   * reply subject. A LIKE prefilter (id escaped so its `_`/`-` are
   * literal) narrows the scan; the match is then verified exactly.
   */
  findMissionByOperatorQueryId(
    queryId: string,
  ): { mission: PhoneCallMission; query: PhoneOperatorQuery } | null {
    const id = asString(queryId);
    if (!id) return null;
    const rows = this.db.prepare(
      "SELECT * FROM phone_missions WHERE metadata_json LIKE ? ESCAPE '\\'",
    ).all(`%${escapeLike(id)}%`) as any[];
    for (const row of rows) {
      const mission = rowToMission(row);
      const query = readOperatorQueries(mission).find((item) => item.id === id);
      if (query) return { mission, query };
    }
    return null;
  }

  /**
   * Record the operator's answer to a query. Idempotent — the first
   * answer wins; a later answer for the same query returns the existing
   * record unchanged with `alreadyAnswered: true`, so a duplicate
   * (e.g. an email reply AND an API POST) cannot fight. Returns null if
   * the mission/query is unknown; throws on an empty answer.
   */
  answerOperatorQuery(
    missionId: string,
    queryId: string,
    answer: string,
    options: { via?: string; agentId?: string } = {},
  ): { mission: PhoneCallMission; query: PhoneOperatorQuery; alreadyAnswered: boolean } | null {
    const mission = this.getMission(missionId, options.agentId);
    if (!mission) return null;
    const queries = readOperatorQueries(mission);
    const index = queries.findIndex((query) => query.id === queryId);
    if (index < 0) return null;
    if (queries[index].answer) {
      return { mission, query: queries[index], alreadyAnswered: true };
    }

    const cleanAnswer = sanitizeOperatorText(answer, OPERATOR_QUERY_ANSWER_MAX_LENGTH);
    if (!cleanAnswer) throw new Error('Operator answer is required');

    const answered: PhoneOperatorQuery = {
      ...queries[index],
      answer: cleanAnswer,
      answeredAt: new Date().toISOString(),
      answeredVia: sanitizeOperatorText(options.via, 40) || 'api',
    };
    const nextQueries = [...queries];
    nextQueries[index] = answered;
    const updated = this.updateMissionStatus(mission.id, mission.status, {
      operatorQueries: nextQueries,
    }, [{
      at: answered.answeredAt!,
      source: 'operator',
      text: `Operator answered: ${cleanAnswer}`,
      metadata: { queryId, via: answered.answeredVia },
    }]);
    return { mission: updated, query: answered, alreadyAnswered: false };
  }

  /**
   * v0.9.92 — auto-close stale operator queries.
   *
   * An operator query is "stale" when:
   *   - it's unanswered, AND
   *   - either (a) the mission is no longer live (status in
   *     {completed, failed, cancelled}), OR (b) the query is older
   *     than `maxAgeSeconds`.
   *
   * The sweeper marks each stale query as answered with a synthetic
   * "[auto-closed: ...]" answer + `answeredVia: 'auto-sweeper'`. This
   * (a) gets the query out of `listOpenOperatorQueries`, (b) clears
   * the bridge's "you have N open questions" hint to the operator,
   * and (c) leaves a permanent audit trail of WHY the query was
   * closed.
   *
   * Returns the count of queries closed + a per-mission breakdown
   * for logging.
   */
  sweepStaleOperatorQueries(opts: { maxAgeSeconds?: number; nowMs?: number } = {}): {
    closed: number;
    missionsTouched: number;
    breakdown: Array<{ missionId: string; closed: number; reason: 'mission-terminal' | 'age' }>;
  } {
    // Default: a query is stale if its mission has already terminated
    // (we close immediately), OR the query is more than 1 hour old
    // (a live call won't keep one open that long without ending). The
    // ask_operator tool's own timeout is 5 minutes — so 1h is a
    // generous safety net for the bridge-side timer, not the model's
    // patience.
    const maxAgeMs = (opts.maxAgeSeconds ?? 3600) * 1000;
    const nowMs = opts.nowMs ?? Date.now();
    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

    // LIKE on metadata_json keeps the scan cheap — only missions
    // that have any `operatorQueries` content at all enter the loop.
    const rows = this.db.prepare(
      "SELECT * FROM phone_missions WHERE metadata_json LIKE '%\"operatorQueries\"%'",
    ).all() as any[];

    const breakdown: Array<{ missionId: string; closed: number; reason: 'mission-terminal' | 'age' }> = [];
    let totalClosed = 0;
    let missionsTouched = 0;

    for (const row of rows) {
      const mission = rowToMission(row);
      const queries = readOperatorQueries(mission);
      const open = queries.filter((q) => !q.answer);
      if (open.length === 0) continue;

      const reason: 'mission-terminal' | 'age' | null = TERMINAL.has(mission.status)
        ? 'mission-terminal'
        : null;

      const closedAt = new Date(nowMs).toISOString();
      const nextQueries = queries.map((q): PhoneOperatorQuery => {
        if (q.answer) return q;
        const askedAtMs = Date.parse(q.askedAt);
        const tooOld = Number.isFinite(askedAtMs) && (nowMs - askedAtMs) >= maxAgeMs;
        const queryReason = reason ?? (tooOld ? 'age' : null);
        if (!queryReason) return q;  // still inside the age window AND mission still live ⇒ leave alone
        return {
          ...q,
          answer: queryReason === 'mission-terminal'
            ? `[auto-closed: mission ended (${mission.status}) before this question was answered]`
            : `[auto-closed: question went unanswered for over ${Math.round(maxAgeMs / 60_000)} minutes]`,
          answeredAt: closedAt,
          answeredVia: 'auto-sweeper',
        };
      });

      const closedHere = nextQueries.filter((q, i) =>
        q.answer && !queries[i].answer && q.answeredVia === 'auto-sweeper',
      ).length;
      if (closedHere === 0) continue;

      this.updateMissionStatus(mission.id, mission.status, {
        operatorQueries: nextQueries,
      }, [{
        at: closedAt,
        source: 'system',
        text: `Auto-closed ${closedHere} stale operator query(ies): ${reason ?? 'aged out'}.`,
        metadata: { closedCount: closedHere, reason: reason ?? 'age' },
      }]);

      totalClosed += closedHere;
      missionsTouched += 1;
      breakdown.push({ missionId: mission.id, closed: closedHere, reason: reason ?? 'age' });
    }

    return { closed: totalClosed, missionsTouched, breakdown };
  }

  // ─── Callback on disconnect (plan §7) ─────────────────

  /**
   * Flag a mission for callback-on-disconnect: the call dropped while
   * an operator query was still unanswered, so once the operator
   * answers the API should dial the caller back. Returns the mission
   * unchanged (not flagged) if every query is already answered; null if
   * the mission is unknown.
   */
  flagCallbackPending(missionId: string): PhoneCallMission | null {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    if (!readOperatorQueries(mission).some((query) => !query.answer)) return mission;
    return this.updateMissionStatus(mission.id, mission.status, {
      callbackPending: true,
    }, [{
      at: new Date().toISOString(),
      source: 'system',
      text: 'Call ended with an unanswered operator query — a callback is pending the operator answer.',
    }]);
  }

  /** Missions currently flagged for callback-on-disconnect. */
  findCallbackPendingMissions(agentId?: string): PhoneCallMission[] {
    const rows = (agentId
      ? this.db.prepare("SELECT * FROM phone_missions WHERE agent_id = ? AND metadata_json LIKE '%callbackPending%'").all(agentId)
      : this.db.prepare("SELECT * FROM phone_missions WHERE metadata_json LIKE '%callbackPending%'").all()) as any[];
    return rows.map(rowToMission).filter((mission) => mission.metadata.callbackPending === true);
  }

  /**
   * Trigger a callback (plan §7) when a callback-pending mission now has
   * an answered query: re-dial the same number with a continuation task
   * carrying the operator's answer. Returns the (updated) original
   * mission + the new callback mission, or null if no callback is due.
   *
   * `callbackPending` is cleared BEFORE dialing so a concurrent second
   * answer cannot double-dial; if the dial throws it is restored so the
   * callback is not silently lost, and the error is rethrown.
   */
  async triggerCallback(
    missionId: string,
    options: StartPhoneCallOptions = {},
  ): Promise<{ mission: PhoneCallMission; callbackMission: PhoneCallMission } | null> {
    const mission = this.getMission(missionId);
    if (!mission || mission.metadata.callbackPending !== true) return null;
    const answered = readOperatorQueries(mission).filter((query) => query.answer);
    if (answered.length === 0) return null;
    const latest = answered[answered.length - 1];

    // Clear the flag first — a concurrent answer must not double-dial.
    this.updateMissionStatus(mission.id, mission.status, {
      callbackPending: false,
      callbackTriggeredAt: new Date().toISOString(),
    }, [{
      at: new Date().toISOString(),
      source: 'system',
      text: 'Operator answered a pending query — dialing the caller back.',
    }]);

    try {
      const result = await this.startMission(mission.agentId, {
        to: mission.to,
        task: buildCallbackTask(mission.task, latest),
        policy: mission.policy,
      }, options);
      const linked = this.updateMissionStatus(mission.id, mission.status, {
        callbackMissionId: result.mission.id,
      }, []);
      return { mission: linked, callbackMission: result.mission };
    } catch (err) {
      // Dial failed — restore the flag so the callback can be retried.
      const message = (err as Error)?.message ?? String(err);
      this.updateMissionStatus(mission.id, mission.status, {
        callbackPending: true,
        callbackError: message,
      }, [{
        at: new Date().toISOString(),
        source: 'system',
        text: `Callback dial failed (${message}) — it remains pending.`,
      }]);
      throw err;
    }
  }

  // ─── Scheduled callbacks (v0.9.81 — schedule_callback tool) ──────────

  /**
   * Persist a `schedule_callback` request to the mission. Called from
   * the realtime bridge's `onCallbackScheduled` hook. The scheduler
   * picks this up later when `payload.at <= now`. ChainDepth is
   * computed from the parent's metadata so {@link triggerScheduledCallback}
   * can enforce policy.callbackPolicy.maxCallbackChain without
   * walking back through the mission history.
   *
   * Returns the updated mission, or null if the mission isn't known.
   * Idempotent on the `mission.metadata.scheduledCallback.at` key: if
   * a scheduled callback already exists on the mission this writes a
   * SECOND copy on `scheduledCallbacks` as an audit trail but does
   * NOT overwrite the active record (the bridge only allows one per
   * call anyway; the audit log is a belt-and-braces guard against
   * the unusual case where a server restart re-runs the bridge logic).
   */
  armScheduledCallback(
    missionId: string,
    payload: {
      at: string;
      reason: string;
      agentSummary: string;
      transcriptDigest: string;
    },
  ): PhoneCallMission | null {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    const parentDepth = readChainDepth(mission);
    const record: PhoneScheduledCallback = {
      at: payload.at,
      reason: payload.reason,
      agentSummary: payload.agentSummary,
      transcriptDigest: payload.transcriptDigest,
      chainDepth: parentDepth + 1,
      status: 'pending',
      armedAt: new Date().toISOString(),
    };
    return this.updateMissionStatus(mission.id, mission.status, {
      scheduledCallback: record,
    }, [{
      at: record.armedAt,
      source: 'system',
      text: `Scheduled callback armed for ${record.at} (chain depth ${record.chainDepth}). Reason: ${record.reason}`,
      metadata: { scheduledAt: record.at, chainDepth: record.chainDepth },
    }]);
  }

  /**
   * All missions with a `scheduledCallback.status === 'pending'` whose
   * `at` is <= now. The scheduler's per-tick worklist. Pass an upper
   * bound on count so a backlog doesn't dial every overdue callback in
   * one frame.
   */
  findDueScheduledCallbacks(nowIso: string, limit = 16): PhoneCallMission[] {
    // metadata_json is a LIKE-indexed string column; this is a coarse
    // first-cut filter, then we re-check in JS. Cheap on small DBs;
    // if the per-call mission count grows large enough to matter we
    // can promote `scheduled_callback_at` to a real column.
    const rows = this.db.prepare(
      "SELECT * FROM phone_missions WHERE metadata_json LIKE '%scheduledCallback%' AND metadata_json LIKE '%pending%' LIMIT ?",
    ).all(limit * 4) as any[];
    return rows
      .map(rowToMission)
      .filter((mission) => {
        const sc = mission.metadata.scheduledCallback as PhoneScheduledCallback | undefined;
        return sc && sc.status === 'pending' && sc.at <= nowIso;
      })
      .slice(0, limit);
  }

  /**
   * Dial a due scheduled callback. Mirrors {@link triggerCallback} for
   * the operator-query path:
   *
   *   1. Reject if the mission's policy.callbackPolicy disallows it OR
   *      `chainDepth > maxCallbackChain` (no infinite chains).
   *   2. Transition status pending → dialing BEFORE dialing so a
   *      concurrent tick can't double-dial.
   *   3. Build the continuation task with prior-call context and dial.
   *   4. On success: write `status: 'fired'` + the new mission id.
   *   5. On failure: write `status: 'pending'` + `lastError` so the
   *      next tick can retry, then rethrow.
   *
   * Returns `null` if the mission isn't known or has no due callback.
   */
  async triggerScheduledCallback(
    missionId: string,
    options: StartPhoneCallOptions = {},
  ): Promise<{ mission: PhoneCallMission; callbackMission: PhoneCallMission } | null> {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    const sc = mission.metadata.scheduledCallback as PhoneScheduledCallback | undefined;
    if (!sc) return null;
    if (sc.status !== 'pending') return null;

    // Policy gates: callbacks must be allowed AND the next dial must
    // not exceed the chain cap. Caller is the agent — the policy is
    // the only thing protecting the operator from a runaway chain.
    const callbackPol = mission.policy.callbackPolicy;
    if (!callbackPol || !callbackPol.allowAutoCallback || sc.chainDepth > callbackPol.maxCallbackChain) {
      const updated = this.updateMissionStatus(mission.id, mission.status, {
        scheduledCallback: { ...sc, status: 'failed', lastError: 'policy denies callback (chain or disabled)' },
      }, [{
        at: new Date().toISOString(),
        source: 'system',
        text: `Scheduled callback denied by policy (chainDepth=${sc.chainDepth}, max=${callbackPol?.maxCallbackChain ?? 0}).`,
      }]);
      return updated ? { mission: updated, callbackMission: updated } : null;
    }

    // Transition pending → dialing BEFORE the dial. A concurrent tick
    // hitting this mission MUST see status:dialing and skip.
    this.updateMissionStatus(mission.id, mission.status, {
      scheduledCallback: { ...sc, status: 'dialing' },
    }, [{
      at: new Date().toISOString(),
      source: 'system',
      text: `Dialing scheduled callback (chain depth ${sc.chainDepth}).`,
    }]);

    try {
      const result = await this.startMission(mission.agentId, {
        to: mission.to,
        task: buildScheduledCallbackTask(mission.task, {
          reason: sc.reason,
          agentSummary: sc.agentSummary,
          transcriptDigest: sc.transcriptDigest,
        }),
        policy: mission.policy,
      }, options);
      // Stamp the chain depth onto the NEW mission so any callback IT
      // schedules can compute parentDepth + 1 without re-walking parents.
      const callbackMission = this.updateMissionStatus(result.mission.id, result.mission.status, {
        callbackChainDepth: sc.chainDepth,
        callbackParentMissionId: mission.id,
      }, []) ?? result.mission;
      const linked = this.updateMissionStatus(mission.id, mission.status, {
        scheduledCallback: {
          ...sc,
          status: 'fired',
          firedAt: new Date().toISOString(),
          callbackMissionId: result.mission.id,
        },
      }, []);
      return { mission: linked!, callbackMission };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.updateMissionStatus(mission.id, mission.status, {
        scheduledCallback: { ...sc, status: 'pending', lastError: message },
      }, [{
        at: new Date().toISOString(),
        source: 'system',
        text: `Scheduled callback dial failed (${message}); will retry on next scheduler tick.`,
      }]);
      throw err;
    }
  }

  private build46ElksCallRequest(config: PhoneTransportConfig, mission: PhoneCallMission): { url: string; body: Record<string, string> } {
    // Duration ceiling (#43-H6) — clamp the carrier call `timeout` to the
    // server hard cap (1h), not 24h. validatePhoneMissionPolicy already
    // clamps the policy value; this re-clamps at the point of use as
    // defence-in-depth in case a mission row predates that validation.
    const timeout = Math.min(Math.max(mission.policy.maxCallDurationSeconds, 1), PHONE_SERVER_MAX_CALL_DURATION_SECONDS);
    return {
      url: `${defaultApiUrl(config)}/calls`,
      body: {
        from: config.phoneNumber,
        to: mission.to,
        voice_start: buildWebhookUrl(config, '/calls/webhook/46elks/voice-start', mission.id),
        whenhangup: buildWebhookUrl(config, '/calls/webhook/46elks/hangup', mission.id),
        timeout: String(timeout),
      },
    };
  }

  /**
   * Build the Twilio outbound-call request — the mirror of
   * {@link build46ElksCallRequest} for Twilio's Calls.json endpoint:
   *
   *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json
   *
   * with an `application/x-www-form-urlencoded` body. `From`/`To` are
   * the numbers; `Url` is a TwiML webhook Twilio fetches when the call
   * connects — it points at our voice-start webhook, which returns the
   * `<Connect><Stream>` TwiML that wires the call's audio to the
   * realtime voice WebSocket. `StatusCallback` is Twilio's hangup-
   * equivalent — fired with the final call status (the analogue of the
   * 46elks `whenhangup`). `TimeLimit` caps the call duration, re-clamped
   * to the server ceiling (#43-H6) exactly as the 46elks `timeout` is.
   *
   * Both webhook URLs carry the per-mission HMAC token (#43-H7), never
   * the raw `webhookSecret`. The Twilio `AccountSid` is `config.username`
   * and the `AuthToken` is `config.password` (HTTP Basic on the request,
   * and the key Twilio signs `X-Twilio-Signature` with).
   *
   * > The Calls.json endpoint path, the `From`/`To`/`Url`/
   * > `StatusCallback`/`TimeLimit` body fields, and the `<Connect>
   * > <Stream>` TwiML are per Twilio's public Programmable Voice docs;
   * > verify against current docs before the live smoke-test.
   */
  private buildTwilioCallRequest(config: PhoneTransportConfig, mission: PhoneCallMission): { url: string; body: Record<string, string> } {
    const accountSid = config.username;
    if (!accountSid) {
      throw new Error('Twilio account SID (username) is required to place a call');
    }
    const timeLimit = Math.min(Math.max(mission.policy.maxCallDurationSeconds, 1), PHONE_SERVER_MAX_CALL_DURATION_SECONDS);
    return {
      url: `${defaultApiUrl(config)}/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
      body: {
        From: config.phoneNumber,
        To: mission.to,
        // Twilio fetches this on answer; the route returns TwiML.
        Url: buildWebhookUrl(config, '/calls/webhook/twilio/voice', mission.id),
        // Twilio POSTs the terminal call status here (hangup-equivalent).
        StatusCallback: buildWebhookUrl(config, '/calls/webhook/twilio/status', mission.id),
        StatusCallbackEvent: 'completed',
        TimeLimit: String(timeLimit),
      },
    };
  }

  private insertMission(mission: PhoneCallMission): void {
    this.db.prepare(`
      INSERT INTO phone_missions (
        id, agent_id, status, from_phone, to_phone, task,
        policy_json, transport_json, provider, provider_call_id,
        transcript_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mission.id,
      mission.agentId,
      mission.status,
      mission.from,
      mission.to,
      mission.task,
      JSON.stringify(mission.policy),
      JSON.stringify(mission.transport),
      mission.provider,
      mission.providerCallId ?? null,
      JSON.stringify(mission.transcript),
      JSON.stringify(mission.metadata),
      mission.createdAt,
      mission.updatedAt,
    );
  }

  private updateProviderCall(missionId: string, providerCallId: string | undefined, metadata: Record<string, unknown>): PhoneCallMission {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const nextMetadata = { ...mission.metadata, ...metadata };
    this.db.prepare(`
      UPDATE phone_missions
      SET provider_call_id = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(providerCallId ?? null, JSON.stringify(nextMetadata), new Date().toISOString(), missionId);
    return this.getMission(missionId)!;
  }

  private updateMissionStatus(
    missionId: string,
    status: PhoneMissionState,
    metadata: Record<string, unknown>,
    transcriptEntries: PhoneMissionTranscriptEntry[] = [],
  ): PhoneCallMission {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Phone mission not found');
    const nextTranscript = [...mission.transcript, ...transcriptEntries];
    const nextMetadata = Object.fromEntries(
      Object.entries({ ...mission.metadata, ...metadata }).filter(([, value]) => value !== undefined),
    );
    this.db.prepare(`
      UPDATE phone_missions
      SET status = ?, transcript_json = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(nextTranscript), JSON.stringify(nextMetadata), new Date().toISOString(), missionId);
    return this.getMission(missionId)!;
  }
}

export function buildPhoneTransportConfig(input: {
  provider?: unknown;
  phoneNumber?: unknown;
  username?: unknown;
  password?: unknown;
  /** Twilio alias for {@link username} — the account SID. */
  accountSid?: unknown;
  /** Twilio alias for {@link password} — the account auth token. */
  authToken?: unknown;
  webhookBaseUrl?: unknown;
  webhookSecret?: unknown;
  apiUrl?: unknown;
  capabilities?: unknown;
  supportedRegions?: unknown;
  configuredAt?: string;
}): PhoneTransportConfig {
  const provider = asString(input.provider) || '46elks';
  if (provider !== '46elks' && provider !== 'twilio') {
    throw new Error('provider must be "46elks" or "twilio"');
  }
  const isTwilio = provider === 'twilio';

  const phoneNumber = normalizePhoneNumber(asString(input.phoneNumber));
  if (!phoneNumber) throw new Error('phoneNumber must be a valid E.164 phone number');

  // Both providers authenticate with HTTP Basic. For Twilio the
  // credential pair is the account SID + auth token — accepted under
  // either the generic `username`/`password` keys or the friendlier
  // `accountSid`/`authToken` aliases.
  const username = asString(input.username) || asString(input.accountSid);
  const password = asString(input.password) || asString(input.authToken);
  const webhookBaseUrl = asString(input.webhookBaseUrl);
  const webhookSecret = asString(input.webhookSecret);
  if (!username || !password) {
    throw new Error(isTwilio
      ? 'accountSid and authToken are required for provider "twilio"'
      : 'username and password are required for provider "46elks"');
  }
  if (!webhookBaseUrl) throw new Error('webhookBaseUrl is required');
  if (!webhookSecret) throw new Error('webhookSecret is required');
  // Entropy floor (#43-H8) — the webhook secret is the ONLY auth on the
  // pre-bearer webhook routes (every per-mission token is derived from
  // it). A short secret makes those tokens forgeable. Require real
  // entropy; reject a trivially-guessable secret outright.
  if (webhookSecret.length < PHONE_MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(`webhookSecret must be at least ${PHONE_MIN_WEBHOOK_SECRET_LENGTH} characters`);
  }

  const parsedWebhookBaseUrl = new URL(webhookBaseUrl);
  if (parsedWebhookBaseUrl.protocol !== 'https:' && parsedWebhookBaseUrl.hostname !== '127.0.0.1' && parsedWebhookBaseUrl.hostname !== 'localhost') {
    throw new Error('webhookBaseUrl must use https:// unless it points at localhost');
  }

  const apiUrl = asString(input.apiUrl);
  if (apiUrl) {
    const parsedApiUrl = new URL(apiUrl);
    if (parsedApiUrl.protocol !== 'https:') {
      throw new Error('apiUrl must use https:// — credentials are sent on every request');
    }
  }

  const capabilities: TelephonyTransportCapability[] = Array.isArray(input.capabilities)
    ? input.capabilities.filter((item): item is TelephonyTransportCapability => (
      typeof item === 'string' && ['sms', 'call_control', 'realtime_media', 'recording_supported'].includes(item)
    ))
    : ['call_control'];
  // Default supportedRegions is provider-aware: Twilio is a global
  // carrier (US + international), so calls to a US/non-EU destination
  // must not be blocked by the mission gate. 46elks is EU-only, so
  // its default stays ['EU']. The historic blanket-['EU'] default
  // bit us in v0.9.78 when a US Twilio install couldn't dial a US
  // number — the mission gate rejected it as transport-region-unsupported
  // even though Twilio could obviously place the call.
  const defaultRegions: PhoneTransportConfig['supportedRegions'] = isTwilio ? ['WORLD'] : ['EU'];
  const supportedRegions: PhoneTransportConfig['supportedRegions'] = Array.isArray(input.supportedRegions)
    ? input.supportedRegions.filter((item): item is PhoneTransportConfig['supportedRegions'][number] => (
      typeof item === 'string' && ['AT', 'DE', 'EU', 'WORLD'].includes(item)
    ))
    : defaultRegions;

  const config: PhoneTransportConfig = {
    provider,
    phoneNumber,
    username,
    password,
    webhookBaseUrl,
    webhookSecret,
    apiUrl: apiUrl || undefined,
    capabilities: Array.from(new Set<TelephonyTransportCapability>(['call_control', ...capabilities])),
    supportedRegions: supportedRegions.length ? Array.from(new Set<PhoneTransportConfig['supportedRegions'][number]>(supportedRegions)) : defaultRegions,
    configuredAt: input.configuredAt ?? new Date().toISOString(),
  };

  const validation = validatePhoneTransportProfile(config);
  if (!validation.ok) {
    throw new Error(`Invalid phone transport config: ${validation.issues.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
  }
  return config;
}
