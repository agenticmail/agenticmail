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
      'agenticmail_realtime_conversation_capabilities',
      'agenticmail_realtime_conversation_plan',
      'agenticmail_conversation_list',
      'agenticmail_conversation_get',
      'agenticmail_conversation_context',
      'agenticmail_conversation_start',
      'agenticmail_conversation_send',
      'agenticmail_conversation_messages',
      'agenticmail_conversation_end',
      'agenticmail_call_phone',
      'agenticmail_call_status',
      'agenticmail_call_transcript',
      'agenticmail_call_cancel',
    ]));
  });

  it('keeps high-risk call start fields explicit and required', () => {
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
});
