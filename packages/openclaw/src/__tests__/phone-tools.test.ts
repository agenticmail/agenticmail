import { describe, expect, it } from 'vitest';
import { registerTools } from '../tools.js';

function collectRegisteredTools(): any[] {
  const tools: any[] = [];
  registerTools({
    registerTool(factory: any) {
      tools.push(factory({ sessionKey: 'agent:main' }));
    },
  }, {
    config: {
      apiUrl: 'http://127.0.0.1:3102',
      apiKey: 'ak_test',
    },
  });
  return tools;
}

describe('OpenClaw phone tool surface', () => {
  it('registers call-control tools for OpenClaw agents', () => {
    const names = collectRegisteredTools().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'agenticmail_phone_transport_setup',
      'agenticmail_phone_capabilities',
      'agenticmail_phone_readiness',
      'agenticmail_phone_voice_providers',
      'agenticmail_realtime_conversation_capabilities',
      'agenticmail_realtime_conversation_plan',
      'agenticmail_conversation_list',
      'agenticmail_conversation_get',
      'agenticmail_conversation_context',
      'agenticmail_conversation_start',
      'agenticmail_conversation_send',
      'agenticmail_conversation_messages',
      'agenticmail_conversation_end',
      'agenticmail_call_phone_safe',
      'agenticmail_call_phone',
      'agenticmail_call_status',
      'agenticmail_call_transcript',
      'agenticmail_call_cancel',
      'agenticmail_matrix_setup',
      'agenticmail_matrix_config',
      'agenticmail_matrix_send',
      'agenticmail_matrix_messages',
      'agenticmail_matrix_poll',
    ]));
  });

  it('keeps high-risk call start fields explicit and required', () => {
    const safeCallTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_call_phone_safe');
    expect(safeCallTool.parameters.required).toEqual(expect.arrayContaining(['to', 'task']));
    expect(safeCallTool.parameters.properties.policyPreset.type).toBe('string');
    expect(safeCallTool.parameters.properties.regionAllowlist.type).toBe('array');
    const readinessTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_phone_readiness');
    expect(readinessTool.parameters.properties.voiceRuntime.type).toBe('string');
    const voiceProviderTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_phone_voice_providers');
    expect(voiceProviderTool.parameters.properties._account.type).toBe('string');

    const callTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_call_phone');

    expect(callTool.parameters.required).toEqual(expect.arrayContaining(['to', 'task', 'policy']));
    expect(callTool.parameters.properties.dryRun.type).toBe('boolean');
    expect(callTool.parameters.properties._account.type).toBe('string');
    const setupTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_phone_transport_setup');
    expect(setupTool.parameters.properties.realtimeBridgeNumber.type).toBe('string');
  });

  it('exposes channel-neutral realtime conversation gates', () => {
    const planTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_realtime_conversation_plan');

    expect(planTool.parameters.required).toEqual(expect.arrayContaining(['channel']));
    expect(planTool.parameters.properties.policyProvided.type).toBe('boolean');
    expect(planTool.parameters.properties.operatorApproved.type).toBe('boolean');
    const listTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_conversation_list');
    expect(listTool.parameters.properties.status.type).toBe('string');
    const getTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_conversation_get');
    expect(getTool.parameters.required).toEqual(expect.arrayContaining(['sessionId']));
    const contextTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_conversation_context');
    expect(contextTool.parameters.required).toEqual(expect.arrayContaining(['sessionId']));
    expect(contextTool.parameters.properties.messageLimit.type).toBe('number');
    const startTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_conversation_start');
    expect(startTool.parameters.required).toEqual(expect.arrayContaining(['channel']));
  });

  it('exposes Matrix channel setup and poll tools', () => {
    const setupTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_matrix_setup');
    expect(setupTool.parameters.required).toEqual(expect.arrayContaining(['homeserverUrl', 'accessToken']));
    expect(setupTool.parameters.properties.allowedRoomIds.type).toBe('array');
    const sendTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_matrix_send');
    expect(sendTool.parameters.required).toEqual(expect.arrayContaining(['roomId', 'text']));
    const pollTool = collectRegisteredTools().find((tool) => tool.name === 'agenticmail_matrix_poll');
    expect(pollTool.parameters.properties.timeoutMs.type).toBe('number');
  });
});
