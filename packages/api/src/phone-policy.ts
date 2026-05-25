import {
  buildPhoneMissionPolicy,
  type OpenClawPhoneMissionPolicy,
} from '@agenticmail/core';

function requestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function requestPhonePolicyPreset(value: unknown): string | undefined {
  const body = requestRecord(value);
  const preset = body.policyPreset;
  return typeof preset === 'string' && preset.trim() ? preset.trim() : undefined;
}

/**
 * Resolve the phone mission policy supplied by API clients. Raw policy
 * remains supported for advanced callers; policyPreset is the host-tool
 * path used by OpenClaw/MCP so agents do not have to handcraft the full
 * safety envelope.
 */
export function resolvePhoneMissionPolicy(value: unknown): OpenClawPhoneMissionPolicy | undefined {
  const body = requestRecord(value);
  if (body.policy !== undefined && body.policy !== null) return body.policy as OpenClawPhoneMissionPolicy;
  if (!Object.prototype.hasOwnProperty.call(body, 'policyPreset')) return undefined;

  return buildPhoneMissionPolicy({
    preset: body.policyPreset as any,
    regionAllowlist: body.regionAllowlist as any,
    maxCallDurationSeconds: body.maxCallDurationSeconds as any,
    maxCostPerMission: body.maxCostPerMission as any,
    maxAttempts: body.maxAttempts as any,
    transcriptEnabled: body.transcriptEnabled as any,
    recordingEnabled: body.recordingEnabled as any,
    maxTimeShiftMinutes: body.maxTimeShiftMinutes as any,
    extensionPolicy: body.extensionPolicy as any,
    callbackPolicy: body.callbackPolicy as any,
    voiceRuntime: body.voiceRuntime as any,
    voiceModel: body.voiceModel as any,
    voice: body.voice as any,
  });
}
