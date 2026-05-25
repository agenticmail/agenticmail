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

  it('exposes the Matrix channel tools', () => {
    const tools = new Set(registeredToolNames());
    for (const name of [
      'agenticmail_matrix_setup',
      'agenticmail_matrix_config',
      'agenticmail_matrix_send',
      'agenticmail_matrix_messages',
      'agenticmail_matrix_poll',
    ]) {
      expect(tools.has(name), `${name} should be registered`).toBe(true);
    }
  });

  it('exposes the Google Meet channel tools', () => {
    const tools = new Set(registeredToolNames());
    for (const name of [
      'agenticmail_meet_setup',
      'agenticmail_meet_config',
      'agenticmail_meet_readiness',
      'agenticmail_meet_disable',
      'agenticmail_meet_space_create',
      'agenticmail_meet_space_get',
      'agenticmail_meet_conference_records',
      'agenticmail_meet_transcripts',
      'agenticmail_meet_artifacts_import',
      'agenticmail_meet_live_join',
    ]) {
      expect(tools.has(name), `${name} should be registered`).toBe(true);
    }
  });
});
