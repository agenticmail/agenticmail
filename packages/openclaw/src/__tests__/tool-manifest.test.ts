import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENTICMAIL_API_URL } from '../../index.js';
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

function pluginManifest(): any {
  const manifestUrl = new URL('../../openclaw.plugin.json', import.meta.url);
  return JSON.parse(readFileSync(manifestUrl, 'utf8'));
}

function packageJson(): any {
  const packageUrl = new URL('../../package.json', import.meta.url);
  return JSON.parse(readFileSync(packageUrl, 'utf8'));
}

function manifestToolNames(): string[] {
  return [...pluginManifest().tools].sort();
}

describe('OpenClaw tool manifest', () => {
  it('matches the tools registered at runtime', () => {
    expect(manifestToolNames()).toEqual(registeredToolNames());
  });

  it('keeps plugin manifest metadata in sync with the npm package', () => {
    const manifest = pluginManifest();
    const pkg = packageJson();

    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toContain(`${manifest.tools.length} tools`);
    expect(manifest.configSchema.properties.apiUrl.default).toBe(DEFAULT_AGENTICMAIL_API_URL);
  });

  it('exposes the Telegram channel tools', () => {
    const tools = new Set(registeredToolNames());
    for (const name of [
      'agenticmail_telegram_setup',
      'agenticmail_telegram_config',
      'agenticmail_telegram_send',
      'agenticmail_telegram_messages',
      'agenticmail_telegram_poll',
    ]) {
      expect(tools.has(name), `${name} should be registered`).toBe(true);
    }
  });
});
