import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerTools } from '../tools.js';

function registeredToolNames(): string[] {
  const tools: string[] = [];
  registerTools({
    registerTool(factory: any) {
      tools.push(factory({ sessionKey: 'agent:main' }).name);
    },
  }, {
    config: {
      apiUrl: 'http://127.0.0.1:3102',
      apiKey: 'ak_test',
    },
  });
  return tools.sort();
}

function manifestToolNames(): string[] {
  const manifestUrl = new URL('../../openclaw.plugin.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  return [...manifest.tools].sort();
}

describe('OpenClaw tool manifest', () => {
  it('matches the tools registered at runtime', () => {
    expect(manifestToolNames()).toEqual(registeredToolNames());
  });
});
