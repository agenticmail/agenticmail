/**
 * Voice-provider registry — the drop-in plugin directory the realtime
 * voice bridge consults to open a session against OpenAI, Grok, or
 * any future backend that registers itself in
 * `packages/core/src/phone/voice-providers/`.
 *
 * The registry is populated at module load by side-effect imports in
 * `voice-providers/index.ts`. These tests assume that's already
 * happened (it is — the barrel imports run when @agenticmail/core is
 * first imported).
 */
import { describe, expect, it } from 'vitest';
import {
  getVoiceProvider,
  listVoiceProviders,
  resolveVoiceRuntime,
  type AgenticMailConfig,
} from '../index.js';

function baseConfig(overrides: Partial<AgenticMailConfig> = {}): AgenticMailConfig {
  return {
    api: { port: 3829, host: '127.0.0.1' },
    smtp: { host: 'localhost', port: 587 },
    imap: { host: 'localhost', port: 143 },
    stalwart: { url: 'http://localhost:8080', adminUser: 'admin', adminPassword: 'x' },
    masterKey: 'mk_test',
    dataDir: '/tmp/voice-providers-test',
    ...overrides,
  };
}

describe('voice-provider registry — bundled providers', () => {
  it('registers OpenAI, Grok, and host bridge at module load', () => {
    const ids = listVoiceProviders().map((p) => p.id).sort();
    expect(ids).toContain('openai');
    expect(ids).toContain('grok');
    expect(ids).toContain('host_bridge');
  });

  it('OpenAI uses the gpt-realtime endpoint + legacy openaiApiKey config field', () => {
    const p = getVoiceProvider('openai');
    expect(p).toBeDefined();
    expect(p!.websocketBaseUrl).toBe('wss://api.openai.com/v1/realtime');
    expect(p!.defaultModel).toBe('gpt-realtime');
    expect(p!.apiKeyEnvVar).toBe('OPENAI_API_KEY');
    expect(p!.apiKeyConfigField).toBe('openaiApiKey');
  });

  it('Grok uses the xAI endpoint + XAI_API_KEY', () => {
    const p = getVoiceProvider('grok');
    expect(p).toBeDefined();
    expect(p!.websocketBaseUrl).toBe('wss://api.x.ai/v1/realtime');
    expect(p!.defaultModel).toBe('grok-voice-latest');
    expect(p!.apiKeyEnvVar).toBe('XAI_API_KEY');
    expect(p!.apiKeyConfigField).toBeUndefined();
  });

  it('host_bridge is key-optional and config-url driven', () => {
    const p = getVoiceProvider('host_bridge');
    expect(p).toBeDefined();
    expect(p!.apiKeyEnvVar).toBe('AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN');
    expect(p!.apiKeyRequired).toBe(false);
    expect(p!.defaultModel).toBe('host-owned');
  });
});

describe('resolveVoiceRuntime — key resolution', () => {
  const PRIOR_OPENAI = process.env.OPENAI_API_KEY;
  const PRIOR_XAI = process.env.XAI_API_KEY;
  const PRIOR_HOST_TOKEN = process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN;

  afterEach(() => {
    if (PRIOR_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = PRIOR_OPENAI;
    if (PRIOR_XAI === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = PRIOR_XAI;
    if (PRIOR_HOST_TOKEN === undefined) delete process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN;
    else process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN = PRIOR_HOST_TOKEN;
  });

  it('default provider id "openai" wins when no id is passed', () => {
    const cfg = baseConfig({ openaiApiKey: 'sk-from-cfg' });
    const r = resolveVoiceRuntime(undefined, cfg);
    expect(r.providerId).toBe('openai');
    expect(r.model).toBe('gpt-realtime');
    expect(r.url).toContain('wss://api.openai.com/v1/realtime');
    expect(r.url).toContain('model=gpt-realtime');
    expect(r.apiKey).toBe('sk-from-cfg');
    expect(r.apiKeySource).toBe('config.openaiApiKey');
  });

  it('legacy openaiApiKey config field beats voiceProviderKeys.openai (backcompat)', () => {
    const cfg = baseConfig({
      openaiApiKey: 'sk-legacy',
      voiceProviderKeys: { openai: 'sk-new-map' },
    });
    const r = resolveVoiceRuntime('openai', cfg);
    expect(r.apiKey).toBe('sk-legacy');
    expect(r.apiKeySource).toBe('config.openaiApiKey');
  });

  it('falls through to the env var when neither config field is set', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const cfg = baseConfig({});
    const r = resolveVoiceRuntime('openai', cfg);
    expect(r.apiKey).toBe('sk-from-env');
    expect(r.apiKeySource).toBe('env OPENAI_API_KEY');
  });

  it('Grok resolves through voiceProviderKeys.grok', () => {
    const cfg = baseConfig({ voiceProviderKeys: { grok: 'xai-key-from-cfg' } });
    const r = resolveVoiceRuntime('grok', cfg);
    expect(r.providerId).toBe('grok');
    expect(r.url).toContain('wss://api.x.ai/v1/realtime');
    expect(r.url).toContain('model=grok-voice-latest');
    expect(r.apiKey).toBe('xai-key-from-cfg');
    expect(r.apiKeySource).toBe('config.voiceProviderKeys.grok');
  });

  it('Grok falls back to XAI_API_KEY env var', () => {
    process.env.XAI_API_KEY = 'xai-from-env';
    const r = resolveVoiceRuntime('grok', baseConfig({}));
    expect(r.apiKey).toBe('xai-from-env');
    expect(r.apiKeySource).toBe('env XAI_API_KEY');
  });

  it('caller-supplied model overrides the provider default', () => {
    process.env.OPENAI_API_KEY = 'sk';
    const r = resolveVoiceRuntime('openai', baseConfig({}), { model: 'gpt-realtime-mini' });
    expect(r.model).toBe('gpt-realtime-mini');
    expect(r.url).toContain('model=gpt-realtime-mini');
  });

  it('host_bridge resolves to a configured host websocket without a model provider key', () => {
    delete process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN;
    const cfg = baseConfig({
      voiceHostBridge: {
        url: 'ws://127.0.0.1:3999/realtime',
      },
    });
    const r = resolveVoiceRuntime('host_bridge', cfg);
    expect(r.providerId).toBe('host_bridge');
    expect(r.url).toBe('ws://127.0.0.1:3999/realtime?model=host-owned');
    expect(r.apiKey).toBe('');
    expect(r.apiKeySource).toBe('not required');
  });

  it('host_bridge can pass an optional bearer token to the host bridge', () => {
    const cfg = baseConfig({
      voiceHostBridge: {
        url: 'ws://127.0.0.1:3999/realtime?tenant=ralf',
        token: 'bridge-token-secret',
      },
    });
    const r = resolveVoiceRuntime('host_bridge', cfg);
    expect(r.url).toBe('ws://127.0.0.1:3999/realtime?tenant=ralf&model=host-owned');
    expect(r.apiKey).toBe('bridge-token-secret');
    expect(r.apiKeySource).toBe('config.voiceHostBridge.token');
  });

  it('throws a clear error for unknown provider ids', () => {
    expect(() => resolveVoiceRuntime('cartesia', baseConfig({}))).toThrow(/Unknown voice runtime/);
  });

  it('throws when host_bridge is selected but no bridge URL is configured', () => {
    expect(() => resolveVoiceRuntime('host_bridge', baseConfig({}))).toThrow(/no websocket URL is configured/);
  });

  it('throws when the selected provider has no key configured anywhere', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => resolveVoiceRuntime('openai', baseConfig({}))).toThrow(/no API key is configured/);
  });

  it('throws when Grok is selected but XAI_API_KEY is absent', () => {
    delete process.env.XAI_API_KEY;
    expect(() => resolveVoiceRuntime('grok', baseConfig({}))).toThrow(/XAI_API_KEY/);
  });
});

// vitest's afterEach lives at the file scope when imported separately
import { afterEach } from 'vitest';
