import { normalizePhoneNumber } from '../sms/manager.js';

export const PHONE_REGION_SCOPES = ['AT', 'DE', 'EU', 'WORLD'] as const;
export type PhoneRegionScope = typeof PHONE_REGION_SCOPES[number];

export const TELEPHONY_TRANSPORT_CAPABILITIES = [
  'sms',
  'call_control',
  'realtime_media',
  'recording_supported',
] as const;
export type TelephonyTransportCapability = typeof TELEPHONY_TRANSPORT_CAPABILITIES[number];

export const PHONE_MISSION_STATES = [
  'draft',
  'approved',
  'dialing',
  'connected',
  'conversing',
  'needs_operator',
  'completed',
  'failed',
  'cancelled',
] as const;
export type PhoneMissionState = typeof PHONE_MISSION_STATES[number];

export type PhoneNumberRisk = 'invalid' | 'standard' | 'premium_or_special';

/**
 * Server-side hard ceilings for a phone mission policy.
 *
 * Hardening (#42-H1 / #43-H2) — `policy` is supplied by the calling agent,
 * so a caller-set `maxCallDurationSeconds: 999999` or `maxCostPerMission:
 * 1e9` is self-authorized and meaningless as a limit. These constants are
 * the real ceiling: `validatePhoneMissionPolicy` clamps every caller value
 * down to (at most) the server cap, so the effective policy can only ever
 * be MORE restrictive than the server, never less. A phone mission places
 * real, billed calls — these bounds are the financial blast-radius cap.
 */
// Real-world calls (insurance, government services, customer support
// queues) often run 45–90 minutes including hold time. v0.9.81 set
// this at 1h which was too tight — bumped to 2h in v0.9.82 so a single
// long call doesn't need to be artificially split. Carrier billing
// still applies at the per-second rate; the cap is a SAFETY net, not
// a cost-optimization knob.
export const PHONE_SERVER_MAX_CALL_DURATION_SECONDS = 7200;   // 2 hours
export const PHONE_SERVER_MAX_COST_PER_MISSION = 5;           // currency units (e.g. USD/EUR)
export const PHONE_SERVER_MAX_ATTEMPTS = 3;
/** Hard cap on the free-text `task` fed to the voice runtime. */
export const PHONE_TASK_MAX_LENGTH = 2000;

/**
 * Server-side ceilings for the extension policy. Like the duration /
 * cost caps above, these are the financial blast-radius bound — a
 * caller can ask for a stricter extension policy but never a looser
 * one. The defaults err on the side of "give the agent a fighting
 * chance to finish a real call" without letting it sit on the line
 * forever. v0.9.82 bumped these substantially after field reports of
 * agents running out of time on legitimately long calls (15-25 min
 * hold queues, 30 min explanations from the rep):
 *
 *   - per-request cap raised 5 min → 15 min so a single "I need more
 *     time on hold" request can carry the agent through a queue
 *   - per-call cap raised 4 → 8 so chained extensions don't run dry
 *     on a long bureaucracy call
 *   - total cap raised 10 min → 1 hour so the absolute add can match
 *     a long-tail call without artificial chunking
 *
 * The TOTAL also can't push the call past
 * PHONE_SERVER_MAX_CALL_DURATION_SECONDS — that ceiling still wins.
 */
export const PHONE_SERVER_MAX_EXTENSION_SECONDS_PER_REQUEST = 900;    // 15 min
export const PHONE_SERVER_MAX_EXTENSION_REQUESTS_PER_CALL = 8;
export const PHONE_SERVER_MAX_TOTAL_EXTENSION_SECONDS = 3600;         // 1 hour

/** Default per-call extension envelope when the caller doesn't set one.
 *  Bumped in v0.9.82 — 5 min × 4 = 20 min of headroom is a much more
 *  realistic out-of-the-box budget for the kinds of calls operators
 *  actually use this for (bills, bookings, customer support). */
export const DEFAULT_EXTENSION_POLICY: PhoneExtensionPolicy = {
  maxSecondsPerRequest: 300,     // 5 minutes
  maxRequestsPerCall: 4,
  maxTotalExtensionSeconds: 1200, // 20 minutes
};

/**
 * Server-side ceiling on how deep a callback chain can go. Each call
 * counts; a brand-new mission is depth 0, its callback is depth 1, the
 * callback's callback is depth 2. Prevents an agent + bot operator on
 * the other end from getting stuck in an infinite re-dial loop.
 */
export const PHONE_SERVER_MAX_CALLBACK_CHAIN = 3;

/** Default callback envelope when the caller doesn't set one. */
export const DEFAULT_CALLBACK_POLICY: PhoneCallbackPolicy = {
  allowAutoCallback: true,
  maxCallbackChain: 2,
};

/**
 * Floor + ceiling on how far into the future a `schedule_callback` may
 * defer. Lower bound prevents instant re-dial loops (give the human a
 * breath); upper bound bounds the staging window so a scheduled
 * callback can't sit in the DB forever.
 */
export const PHONE_CALLBACK_MIN_DELAY_SECONDS = 30;
export const PHONE_CALLBACK_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;   // 7 days

export interface PhoneConfirmPolicy {
  paymentDetails: 'never';
  contractCommitment: 'never';
  costOverLimit: 'needs_operator';
  sensitivePersonalData: 'needs_operator';
  unclearAlternative: 'needs_operator';
}

export interface PhoneAlternativePolicy {
  maxTimeShiftMinutes: number;
}

/**
 * How aggressively the voice agent is allowed to ask for more time on a
 * live call. Three independently-enforced caps:
 *
 *   - maxSecondsPerRequest: ceiling on a SINGLE `extend_call_time` call.
 *     The agent can ask for less; it cannot ask for more.
 *   - maxRequestsPerCall: how many times it may invoke the tool at all.
 *     Once exhausted, further requests are denied even if there is
 *     budget left in the total ceiling.
 *   - maxTotalExtensionSeconds: TOTAL extra seconds across all granted
 *     requests for this single call. A safety net under
 *     `maxRequestsPerCall × maxSecondsPerRequest` in case the math
 *     drifts. The call cannot run past
 *     PHONE_SERVER_MAX_CALL_DURATION_SECONDS regardless of this.
 *
 * Auto-approved within these bounds — the agent does NOT need to bother
 * the operator for routine "5 more minutes" requests. The whole point
 * is to keep the agent agentic without making it ask permission every
 * time it needs more line time to finish the job it was sent to do.
 */
export interface PhoneExtensionPolicy {
  maxSecondsPerRequest: number;
  maxRequestsPerCall: number;
  maxTotalExtensionSeconds: number;
}

/**
 * Whether (and how) the agent may schedule an automatic callback when
 * it can't finish the call in time, hits a context limit, gets cut off,
 * or just wants to follow up later.
 *
 *   - allowAutoCallback: master switch. False disables `schedule_callback`
 *     entirely (the tool is still callable but it returns a denial).
 *   - maxCallbackChain: how many re-dials can chain off this mission.
 *     0 means "no callbacks at all" (equivalent to allowAutoCallback=false
 *     for this purpose); 1 means one callback is permitted but the
 *     callback itself cannot schedule another; 2 means two hops are
 *     allowed; etc. Bounded by PHONE_SERVER_MAX_CALLBACK_CHAIN.
 */
export interface PhoneCallbackPolicy {
  allowAutoCallback: boolean;
  maxCallbackChain: number;
}

export interface OpenClawPhoneMissionPolicy {
  policyVersion: 1;
  regionAllowlist: PhoneRegionScope[];
  maxCallDurationSeconds: number;
  maxCostPerMission: number;
  maxAttempts: number;
  transcriptEnabled: boolean;
  recordingEnabled: boolean;
  confirmPolicy: PhoneConfirmPolicy;
  alternativePolicy: PhoneAlternativePolicy;
  /**
   * NEW in v0.9.81 — extension envelope. Optional for backward
   * compatibility; falls back to {@link DEFAULT_EXTENSION_POLICY} when
   * the caller omits it.
   */
  extensionPolicy?: PhoneExtensionPolicy;
  /**
   * NEW in v0.9.81 — callback envelope. Optional; falls back to
   * {@link DEFAULT_CALLBACK_POLICY} when omitted.
   */
  callbackPolicy?: PhoneCallbackPolicy;
}

export interface StartPhoneMissionInput {
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  voiceRuntimeRef?: string;
}

export interface PhoneTransportProfile {
  provider: string;
  phoneNumber: string;
  capabilities: TelephonyTransportCapability[];
  supportedRegions: PhoneRegionScope[];
}

export interface PhoneMissionValidationIssue {
  code: string;
  field: string;
  message: string;
}

export type PhoneMissionValidationResult =
  | { ok: true; policy: OpenClawPhoneMissionPolicy; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

export type PhoneTransportValidationResult =
  | { ok: true; transport: PhoneTransportProfile; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

export interface ValidatedPhoneMissionStart {
  to: string;
  task: string;
  policy: OpenClawPhoneMissionPolicy;
  targetRegion: PhoneRegionScope;
  transport: PhoneTransportProfile;
  voiceRuntimeRef?: string;
}

export type PhoneMissionStartValidationResult =
  | { ok: true; mission: ValidatedPhoneMissionStart; issues: [] }
  | { ok: false; issues: PhoneMissionValidationIssue[] };

const EU_DIAL_PREFIXES = [
  '+30', '+31', '+32', '+33', '+34', '+351', '+352', '+353', '+354', '+356',
  '+357', '+358', '+359', '+36', '+370', '+371', '+372', '+385', '+386', '+39',
  '+40', '+420', '+421', '+43', '+45', '+46', '+48', '+49',
] as const;

const PREMIUM_OR_SPECIAL_PREFIXES = [
  '+1900',
  '+1976',
  '+43810',
  '+43820',
  '+43821',
  '+43828',
  '+43900',
  '+43901',
  '+43930',
  '+43931',
  '+49190',
  '+49900',
] as const;

function issue(code: string, field: string, message: string): PhoneMissionValidationIssue {
  return { code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPhoneRegionScope(value: unknown): value is PhoneRegionScope {
  return typeof value === 'string' && (PHONE_REGION_SCOPES as readonly string[]).includes(value);
}

function isTelephonyTransportCapability(value: unknown): value is TelephonyTransportCapability {
  return typeof value === 'string' && (TELEPHONY_TRANSPORT_CAPABILITIES as readonly string[]).includes(value);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readRegionList(value: unknown): PhoneRegionScope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const regions = value.filter(isPhoneRegionScope);
  if (regions.length !== value.length) return null;
  return Array.from(new Set(regions));
}

function readCapabilityList(value: unknown): TelephonyTransportCapability[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const capabilities = value.filter(isTelephonyTransportCapability);
  if (capabilities.length !== value.length) return null;
  return Array.from(new Set(capabilities));
}

function validateConfirmPolicy(value: unknown): PhoneMissionValidationIssue[] {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(value)) {
    return [issue('confirm-policy-required', 'policy.confirmPolicy', 'confirmPolicy is required')];
  }

  const required: PhoneConfirmPolicy = {
    paymentDetails: 'never',
    contractCommitment: 'never',
    costOverLimit: 'needs_operator',
    sensitivePersonalData: 'needs_operator',
    unclearAlternative: 'needs_operator',
  };

  for (const [field, expected] of Object.entries(required)) {
    if (value[field] !== expected) {
      issues.push(issue(
        'unsafe-confirm-policy',
        `policy.confirmPolicy.${field}`,
        `${field} must be ${expected}`,
      ));
    }
  }

  return issues;
}

function validateAlternativePolicy(value: unknown): PhoneMissionValidationIssue[] {
  if (!isRecord(value)) {
    return [issue('alternative-policy-required', 'policy.alternativePolicy', 'alternativePolicy is required')];
  }
  const maxTimeShiftMinutes = readNonNegativeNumber(value.maxTimeShiftMinutes);
  if (maxTimeShiftMinutes === null || !Number.isInteger(maxTimeShiftMinutes)) {
    return [issue(
      'invalid-alternative-policy',
      'policy.alternativePolicy.maxTimeShiftMinutes',
      'maxTimeShiftMinutes must be a non-negative integer',
    )];
  }
  return [];
}

/**
 * Validate an OPTIONAL extensionPolicy block. Missing entirely is fine —
 * the caller gets {@link DEFAULT_EXTENSION_POLICY}. If supplied, the
 * three fields must all be present + sensible; any rejection causes
 * mission validation to fail (defaults DO NOT silently paper over a
 * malformed caller value).
 */
function validateExtensionPolicy(value: unknown): PhoneMissionValidationIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return [issue('invalid-extension-policy', 'policy.extensionPolicy', 'extensionPolicy must be an object')];
  }
  const issues: PhoneMissionValidationIssue[] = [];
  const perReq = readPositiveInteger(value.maxSecondsPerRequest);
  if (perReq === null) {
    issues.push(issue(
      'invalid-extension-per-request',
      'policy.extensionPolicy.maxSecondsPerRequest',
      'maxSecondsPerRequest must be a positive integer',
    ));
  }
  const requests = readPositiveInteger(value.maxRequestsPerCall);
  if (requests === null) {
    issues.push(issue(
      'invalid-extension-requests',
      'policy.extensionPolicy.maxRequestsPerCall',
      'maxRequestsPerCall must be a positive integer',
    ));
  }
  const total = readPositiveInteger(value.maxTotalExtensionSeconds);
  if (total === null) {
    issues.push(issue(
      'invalid-extension-total',
      'policy.extensionPolicy.maxTotalExtensionSeconds',
      'maxTotalExtensionSeconds must be a positive integer',
    ));
  }
  return issues;
}

/**
 * Validate an OPTIONAL callbackPolicy block. Same semantics as
 * extensionPolicy — missing is fine + defaulted; malformed is an error.
 * maxCallbackChain = 0 is permitted (it disables chaining), so this
 * uses readNonNegativeNumber + integer check, not readPositiveInteger.
 */
function validateCallbackPolicy(value: unknown): PhoneMissionValidationIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return [issue('invalid-callback-policy', 'policy.callbackPolicy', 'callbackPolicy must be an object')];
  }
  const issues: PhoneMissionValidationIssue[] = [];
  if (readBoolean(value.allowAutoCallback) === null) {
    issues.push(issue(
      'invalid-callback-allow',
      'policy.callbackPolicy.allowAutoCallback',
      'allowAutoCallback must be boolean',
    ));
  }
  const chain = readNonNegativeNumber(value.maxCallbackChain);
  if (chain === null || !Number.isInteger(chain)) {
    issues.push(issue(
      'invalid-callback-chain',
      'policy.callbackPolicy.maxCallbackChain',
      'maxCallbackChain must be a non-negative integer',
    ));
  }
  return issues;
}

/**
 * Resolve the effective extension policy: caller's value (if any),
 * clamped DOWN to the server ceiling on each field. The server cap
 * always wins — a caller asking for `maxSecondsPerRequest: 999_999`
 * gets {@link PHONE_SERVER_MAX_EXTENSION_SECONDS_PER_REQUEST}.
 */
export function resolveExtensionPolicy(input: PhoneExtensionPolicy | undefined): PhoneExtensionPolicy {
  const src = input ?? DEFAULT_EXTENSION_POLICY;
  return {
    maxSecondsPerRequest: Math.min(src.maxSecondsPerRequest, PHONE_SERVER_MAX_EXTENSION_SECONDS_PER_REQUEST),
    maxRequestsPerCall: Math.min(src.maxRequestsPerCall, PHONE_SERVER_MAX_EXTENSION_REQUESTS_PER_CALL),
    maxTotalExtensionSeconds: Math.min(src.maxTotalExtensionSeconds, PHONE_SERVER_MAX_TOTAL_EXTENSION_SECONDS),
  };
}

/** Resolve the effective callback policy with server-ceiling clamping. */
export function resolveCallbackPolicy(input: PhoneCallbackPolicy | undefined): PhoneCallbackPolicy {
  const src = input ?? DEFAULT_CALLBACK_POLICY;
  return {
    allowAutoCallback: src.allowAutoCallback,
    maxCallbackChain: Math.min(src.maxCallbackChain, PHONE_SERVER_MAX_CALLBACK_CHAIN),
  };
}

export function validatePhoneMissionPolicy(policy: unknown): PhoneMissionValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(policy)) {
    return { ok: false, issues: [issue('policy-required', 'policy', 'policy is required')] };
  }

  if (policy.policyVersion !== 1) {
    issues.push(issue('unsupported-policy-version', 'policy.policyVersion', 'policyVersion must be 1'));
  }

  const regionAllowlist = readRegionList(policy.regionAllowlist);
  if (!regionAllowlist) {
    issues.push(issue('invalid-region-allowlist', 'policy.regionAllowlist', 'regionAllowlist must contain at least one supported region'));
  }

  const maxCallDurationSeconds = readPositiveInteger(policy.maxCallDurationSeconds);
  if (maxCallDurationSeconds === null) {
    issues.push(issue('invalid-max-duration', 'policy.maxCallDurationSeconds', 'maxCallDurationSeconds must be a positive integer'));
  }

  const maxCostPerMission = readNonNegativeNumber(policy.maxCostPerMission);
  if (maxCostPerMission === null) {
    issues.push(issue('invalid-max-cost', 'policy.maxCostPerMission', 'maxCostPerMission must be a non-negative number'));
  }

  const maxAttempts = readPositiveInteger(policy.maxAttempts);
  if (maxAttempts === null) {
    issues.push(issue('invalid-max-attempts', 'policy.maxAttempts', 'maxAttempts must be a positive integer'));
  }

  const transcriptEnabled = readBoolean(policy.transcriptEnabled);
  if (transcriptEnabled === null) {
    issues.push(issue('invalid-transcript-enabled', 'policy.transcriptEnabled', 'transcriptEnabled must be boolean'));
  }

  const recordingEnabled = readBoolean(policy.recordingEnabled);
  if (recordingEnabled === null) {
    issues.push(issue('invalid-recording-enabled', 'policy.recordingEnabled', 'recordingEnabled must be boolean'));
  }

  issues.push(...validateConfirmPolicy(policy.confirmPolicy));
  issues.push(...validateAlternativePolicy(policy.alternativePolicy));
  issues.push(...validateExtensionPolicy(policy.extensionPolicy));
  issues.push(...validateCallbackPolicy(policy.callbackPolicy));

  if (issues.length > 0) return { ok: false, issues };

  // Hardening (#42-H1 / #43-H2) — clamp the caller-supplied limits DOWN to
  // the server-side hard ceilings. The caller may ask for a stricter limit
  // than the server cap (that wins), but never a looser one.
  return {
    ok: true,
    policy: {
      policyVersion: 1,
      regionAllowlist: regionAllowlist!,
      maxCallDurationSeconds: Math.min(maxCallDurationSeconds!, PHONE_SERVER_MAX_CALL_DURATION_SECONDS),
      maxCostPerMission: Math.min(maxCostPerMission!, PHONE_SERVER_MAX_COST_PER_MISSION),
      maxAttempts: Math.min(maxAttempts!, PHONE_SERVER_MAX_ATTEMPTS),
      transcriptEnabled: transcriptEnabled!,
      recordingEnabled: recordingEnabled!,
      confirmPolicy: policy.confirmPolicy as unknown as PhoneConfirmPolicy,
      alternativePolicy: {
        maxTimeShiftMinutes: (policy.alternativePolicy as { maxTimeShiftMinutes: number }).maxTimeShiftMinutes,
      },
      // The extension + callback policies are optional in the caller's
      // input but we ALWAYS materialise them in the resolved policy so
      // every downstream consumer (the bridge, the scheduler, the
      // manager) can read a concrete value without juggling undefined.
      // Caller-omitted → DEFAULT_*. Caller-set → clamped to server caps.
      extensionPolicy: resolveExtensionPolicy(policy.extensionPolicy as PhoneExtensionPolicy | undefined),
      callbackPolicy: resolveCallbackPolicy(policy.callbackPolicy as PhoneCallbackPolicy | undefined),
    },
    issues: [],
  };
}

export function validatePhoneTransportProfile(transport: unknown): PhoneTransportValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(transport)) {
    return { ok: false, issues: [issue('transport-required', 'transport', 'transport profile is required')] };
  }

  const provider = typeof transport.provider === 'string' ? transport.provider.trim() : '';
  if (!provider) {
    issues.push(issue('invalid-provider', 'transport.provider', 'provider is required'));
  }

  const phoneNumber = typeof transport.phoneNumber === 'string' ? normalizePhoneNumber(transport.phoneNumber) : null;
  if (!phoneNumber) {
    issues.push(issue('invalid-transport-number', 'transport.phoneNumber', 'transport phoneNumber must be valid E.164'));
  }

  const capabilities = readCapabilityList(transport.capabilities);
  if (!capabilities) {
    issues.push(issue('invalid-capabilities', 'transport.capabilities', 'capabilities must contain supported transport capabilities'));
  } else if (!capabilities.includes('call_control')) {
    issues.push(issue('missing-call-control', 'transport.capabilities', 'transport must support call_control to start phone missions'));
  }

  const supportedRegions = readRegionList(transport.supportedRegions);
  if (!supportedRegions) {
    issues.push(issue('invalid-supported-regions', 'transport.supportedRegions', 'supportedRegions must contain at least one supported region'));
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    transport: {
      provider,
      phoneNumber: phoneNumber!,
      capabilities: capabilities!,
      supportedRegions: supportedRegions!,
    },
    issues: [],
  };
}

export function inferPhoneRegion(phoneNumber: string): PhoneRegionScope | null {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;
  if (normalized.startsWith('+43')) return 'AT';
  if (normalized.startsWith('+49')) return 'DE';
  if (EU_DIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'EU';
  return 'WORLD';
}

export function isPhoneRegionAllowed(region: PhoneRegionScope, allowlist: readonly PhoneRegionScope[]): boolean {
  if (allowlist.includes('WORLD')) return true;
  if (allowlist.includes(region)) return true;
  if ((region === 'AT' || region === 'DE' || region === 'EU') && allowlist.includes('EU')) return true;
  return false;
}

export function classifyPhoneNumberRisk(phoneNumber: string): PhoneNumberRisk {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return 'invalid';
  if (PREMIUM_OR_SPECIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'premium_or_special';
  }
  return 'standard';
}

export function validatePhoneMissionStart(
  input: unknown,
  transport: unknown,
  options: { allowPremiumOrSpecialNumbers?: boolean } = {},
): PhoneMissionStartValidationResult {
  const issues: PhoneMissionValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('start-input-required', 'input', 'start input is required')] };
  }

  const to = typeof input.to === 'string' ? normalizePhoneNumber(input.to) : null;
  if (!to) {
    issues.push(issue('invalid-target-number', 'input.to', 'target number must be valid E.164'));
  }

  // Hardening (#42-H2) — `task` becomes the call objective handed to a
  // voice runtime. Strip control characters (keep tab/newline) and bound
  // the length so an unbounded or control-laced string can't ride through.
  const rawTask = typeof input.task === 'string' ? input.task : '';
  const task = rawTask.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!task) {
    issues.push(issue('task-required', 'input.task', 'task is required'));
  } else if (task.length > PHONE_TASK_MAX_LENGTH) {
    issues.push(issue('task-too-long', 'input.task', `task must be ${PHONE_TASK_MAX_LENGTH} characters or fewer`));
  }

  const policyResult = validatePhoneMissionPolicy(input.policy);
  if (!policyResult.ok) issues.push(...policyResult.issues);

  const transportResult = validatePhoneTransportProfile(transport);
  if (!transportResult.ok) issues.push(...transportResult.issues);

  const risk = typeof input.to === 'string' ? classifyPhoneNumberRisk(input.to) : 'invalid';
  if (risk === 'premium_or_special' && !options.allowPremiumOrSpecialNumbers) {
    issues.push(issue('premium-number-blocked', 'input.to', 'premium or special-rate numbers require an explicit allowlist'));
  }

  const targetRegion = to ? inferPhoneRegion(to) : null;
  if (!targetRegion) {
    issues.push(issue('unknown-target-region', 'input.to', 'target region could not be inferred'));
  }

  if (policyResult.ok && targetRegion && !isPhoneRegionAllowed(targetRegion, policyResult.policy.regionAllowlist)) {
    issues.push(issue('region-not-allowed', 'input.to', 'target number is outside the mission policy regionAllowlist'));
  }

  if (transportResult.ok && targetRegion && !isPhoneRegionAllowed(targetRegion, transportResult.transport.supportedRegions)) {
    issues.push(issue('transport-region-unsupported', 'transport.supportedRegions', 'target number is outside the transport supportedRegions'));
  }

  const capabilities = transportResult.ok ? transportResult.transport.capabilities : [];
  if (policyResult.ok && policyResult.policy.recordingEnabled && !capabilities.includes('recording_supported')) {
    issues.push(issue('recording-unsupported', 'policy.recordingEnabled', 'recordingEnabled requires transport recording_supported capability'));
  }

  if (issues.length > 0 || !policyResult.ok || !transportResult.ok || !to || !targetRegion) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    mission: {
      to,
      task,
      policy: policyResult.policy,
      targetRegion,
      transport: transportResult.transport,
      voiceRuntimeRef: typeof input.voiceRuntimeRef === 'string' && input.voiceRuntimeRef.trim()
        ? input.voiceRuntimeRef.trim()
        : undefined,
    },
    issues: [],
  };
}
