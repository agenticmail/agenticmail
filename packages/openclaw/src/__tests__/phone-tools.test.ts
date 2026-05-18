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
  });
});
