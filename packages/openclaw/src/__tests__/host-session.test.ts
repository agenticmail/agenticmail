import { describe, expect, it } from 'vitest';
import {
  buildOpenClawHostSession,
  isOpenClawHostSessionKey,
  isOpenClawMailChannelSessionKey,
  isOpenClawSubagentSessionKey,
} from '../host-session.js';

describe('OpenClaw host session capture', () => {
  it('identifies host session keys without treating sub-agents or mail channels as operators', () => {
    expect(isOpenClawHostSessionKey('agent:main')).toBe(true);
    expect(isOpenClawHostSessionKey('agent:main:subagent:abc')).toBe(false);
    expect(isOpenClawHostSessionKey('subagent:agenticmail-task-1')).toBe(false);
    expect(isOpenClawHostSessionKey('mail:thread:<message-id>')).toBe(false);
    expect(isOpenClawHostSessionKey('')).toBe(false);
  });

  it('keeps the narrower key predicates available for hook routing', () => {
    expect(isOpenClawSubagentSessionKey('agent:main:subagent:abc')).toBe(true);
    expect(isOpenClawSubagentSessionKey('subagent:agenticmail-task-1')).toBe(true);
    expect(isOpenClawMailChannelSessionKey('mail:sender@example.com')).toBe(true);
    expect(isOpenClawMailChannelSessionKey('agent:main')).toBe(false);
  });

  it('builds wake-only host sessions from OpenClaw hook context', () => {
    const session = buildOpenClawHostSession({
      sessionKey: 'agent:main',
      cwd: '/work/project',
      model: 'anthropic/claude-sonnet-4',
      agentId: 'main',
      agentName: 'operator',
      channel: 'terminal',
    }, 'before_prompt_build');

    expect(session).toEqual({
      sessionId: 'agent:main',
      workspace: '/work/project',
      model: 'anthropic/claude-sonnet-4',
      resumeMode: 'wake-only',
      hostMetadata: {
        sessionKey: 'agent:main',
        surface: 'before_prompt_build',
        agentId: 'main',
        agentName: 'operator',
        channel: 'terminal',
      },
    });
  });

  it('falls back to the current workspace when OpenClaw omits cwd data', () => {
    const session = buildOpenClawHostSession(
      { sessionKey: 'agent:main' },
      'before_tool_call',
      '/fallback/workspace',
    );

    expect(session?.workspace).toBe('/fallback/workspace');
  });

  it('returns null for non-capturable contexts', () => {
    expect(buildOpenClawHostSession({}, 'before_agent_start')).toBeNull();
    expect(buildOpenClawHostSession(null, 'before_agent_start')).toBeNull();
    expect(buildOpenClawHostSession({ sessionKey: 'mail:thread:abc' }, 'before_agent_start')).toBeNull();
    expect(buildOpenClawHostSession({ sessionKey: 'subagent:agenticmail-task' }, 'before_agent_start')).toBeNull();
  });
});
