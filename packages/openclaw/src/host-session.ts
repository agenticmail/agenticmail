import { saveHostSession, type HostSession } from '@agenticmail/core';

export type OpenClawHostSessionSurface =
  | 'before_agent_start'
  | 'before_prompt_build'
  | 'before_tool_call';

type HostSessionDraft = Omit<HostSession, 'lastSeenMs'>;

const SESSION_KEY_FIELDS = ['sessionKey', 'SessionKey'] as const;
const WORKSPACE_FIELDS = ['workspace', 'cwd', 'projectRoot', 'workingDirectory'] as const;
const MODEL_FIELDS = ['model', 'modelName'] as const;
const AGENT_ID_FIELDS = ['agentId', 'agentID'] as const;
const AGENT_NAME_FIELDS = ['agentName', 'name'] as const;
const CHANNEL_FIELDS = ['channel', 'surface', 'originatingChannel', 'OriginatingChannel'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function withDefinedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function isOpenClawSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('subagent:') || sessionKey.includes(':subagent:');
}

export function isOpenClawMailChannelSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('mail:');
}

export function isOpenClawHostSessionKey(sessionKey: string): boolean {
  return sessionKey !== ''
    && !isOpenClawSubagentSessionKey(sessionKey)
    && !isOpenClawMailChannelSessionKey(sessionKey);
}

export function buildOpenClawHostSession(
  context: unknown,
  surface: OpenClawHostSessionSurface,
  fallbackWorkspace = process.cwd(),
): HostSessionDraft | null {
  if (!isRecord(context)) return null;

  const sessionKey = readStringField(context, SESSION_KEY_FIELDS) ?? '';
  if (!isOpenClawHostSessionKey(sessionKey)) return null;

  const workspace = readStringField(context, WORKSPACE_FIELDS) ?? fallbackWorkspace;
  const model = readStringField(context, MODEL_FIELDS);

  return {
    sessionId: sessionKey,
    workspace,
    model,
    resumeMode: 'wake-only',
    hostMetadata: withDefinedValues({
      sessionKey,
      surface,
      agentId: readStringField(context, AGENT_ID_FIELDS),
      agentName: readStringField(context, AGENT_NAME_FIELDS),
      channel: readStringField(context, CHANNEL_FIELDS),
    }),
  };
}

export function recordOpenClawHostSession(
  context: unknown,
  surface: OpenClawHostSessionSurface,
): void {
  const session = buildOpenClawHostSession(context, surface);
  if (!session) return;
  saveHostSession('openclaw', session);
}
