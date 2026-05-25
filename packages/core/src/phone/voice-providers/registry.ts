/**
 * Voice-provider registry — drop-in plugin discovery.
 *
 * Providers register themselves at module-load time via
 * {@link registerVoiceProvider}. The barrel `voice-providers/index.ts`
 * imports each provider file for its side effect, populating this map
 * before any caller asks for one.
 *
 * No reflection, no filesystem scan, no decorator magic — adding a
 * provider is "create a file + add one import line". That gives us
 * both first-class TypeScript types AND the file-drop ergonomics.
 */

import type { AgenticMailConfig } from '../../config.js';
import type { VoiceProvider, VoiceRuntimeConnection } from './types.js';

/** id → provider, populated by side-effect imports in index.ts. */
const PROVIDERS = new Map<string, VoiceProvider>();

/**
 * Register a provider. Called once per file at module load. Throws on
 * duplicate id so an accidental copy-paste collision is loud, not
 * silently overriding.
 */
export function registerVoiceProvider(provider: VoiceProvider): void {
  if (PROVIDERS.has(provider.id)) {
    throw new Error(`Voice provider "${provider.id}" registered twice — id collision.`);
  }
  PROVIDERS.set(provider.id, provider);
}

/** All registered providers — for `agenticmail voice list` / web UI menus. */
export function listVoiceProviders(): VoiceProvider[] {
  return Array.from(PROVIDERS.values());
}

/** Look up a provider by id. Returns undefined for unknown ids. */
export function getVoiceProvider(id: string): VoiceProvider | undefined {
  return PROVIDERS.get(id);
}

function appendModelParam(baseUrl: string, model: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}model=${encodeURIComponent(model)}`;
}

/**
 * Resolve a provider id + the runtime's config / overrides into the
 * connection struct the bridge consumes (URL with model, api key,
 * source). Throws if the provider id is unknown or its API key isn't
 * configured — the realtime-ws layer turns the throw into a clear
 * startup error instead of a mid-call surprise.
 */
export function resolveVoiceRuntime(
  providerId: string | undefined,
  config: AgenticMailConfig,
  options: { model?: string; voice?: string } = {},
): VoiceRuntimeConnection {
  const id = (providerId || 'openai').trim() || 'openai';
  const provider = PROVIDERS.get(id);
  if (!provider) {
    const known = Array.from(PROVIDERS.keys()).join(', ') || '(none registered)';
    throw new Error(
      `Unknown voice runtime "${id}". Known providers: ${known}. `
      + `Add a new one by dropping a file into packages/core/src/phone/voice-providers/.`,
    );
  }

  const baseUrl = (provider.resolveWebsocketBaseUrl?.(config) || provider.websocketBaseUrl || '').trim();
  if (!baseUrl) {
    throw new Error(
      `Voice provider "${provider.id}" (${provider.displayName}) selected, but no websocket URL is configured. `
      + `Set ${provider.apiKeyEnvVar === 'AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN'
        ? 'AGENTICMAIL_VOICE_HOST_BRIDGE_URL'
        : `${provider.id}.websocketBaseUrl`}.`,
    );
  }

  // Key resolution priority: legacy dedicated config field (so an
  // existing install with `config.openaiApiKey` keeps working), then
  // the generic `voiceProviderKeys[<id>]` map, then the env var.
  let apiKey = '';
  let apiKeySource = '';
  if (provider.apiKeyConfigField) {
    const legacy = (config as any)[provider.apiKeyConfigField] as string | undefined;
    if (legacy && legacy.trim()) {
      apiKey = legacy.trim();
      apiKeySource = `config.${provider.apiKeyConfigField}`;
    }
  }
  if (!apiKey) {
    const fromMap = config.voiceProviderKeys?.[provider.id];
    if (fromMap && fromMap.trim()) {
      apiKey = fromMap.trim();
      apiKeySource = `config.voiceProviderKeys.${provider.id}`;
    }
  }
  if (!apiKey && provider.id === 'host_bridge') {
    const fromHostBridge = config.voiceHostBridge?.token;
    if (fromHostBridge && fromHostBridge.trim()) {
      apiKey = fromHostBridge.trim();
      apiKeySource = 'config.voiceHostBridge.token';
    }
  }
  if (!apiKey) {
    const fromEnv = process.env[provider.apiKeyEnvVar];
    if (fromEnv && fromEnv.trim()) {
      apiKey = fromEnv.trim();
      apiKeySource = `env ${provider.apiKeyEnvVar}`;
    }
  }
  if (!apiKey && provider.apiKeyRequired !== false) {
    throw new Error(
      `Voice provider "${provider.id}" (${provider.displayName}) selected, but no API key is configured. `
      + `Set ${provider.apiKeyEnvVar} in your environment or save it to `
      + `~/.agenticmail/config.json under voiceProviderKeys.${provider.id}.`,
    );
  }
  if (!apiKey && provider.apiKeyRequired === false) {
    apiKeySource = 'not required';
  }

  const model = (options.model && options.model.trim()) || provider.defaultModel;
  const url = appendModelParam(baseUrl, model);

  // v0.9.95 — voice resolution. Priority: option > install default
  // > provider default. Unknown voice names against a provider with
  // a fixed catalogue + no customVoicesSupported get logged-and-
  // ignored (resolver returns the provider's default), so a stale
  // mission policy can't wedge a call.
  let voice = '';
  let voiceSource = '';
  const requested = (options.voice || '').trim();
  if (requested) {
    if (provider.voices.includes(requested) || provider.customVoicesSupported) {
      voice = requested;
      voiceSource = 'mission policy';
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[voice-providers] Voice "${requested}" is not in ${provider.id}'s catalogue `
        + `(${provider.voices.join(', ')}). Falling through to ${provider.defaultVoice}.`,
      );
    }
  }
  if (!voice) {
    const installDefault = config.voiceProviderVoices?.[provider.id];
    if (installDefault && installDefault.trim()) {
      const v = installDefault.trim();
      if (provider.voices.includes(v) || provider.customVoicesSupported) {
        voice = v;
        voiceSource = `config.voiceProviderVoices.${provider.id}`;
      }
    }
  }
  if (!voice) {
    voice = provider.defaultVoice;
    voiceSource = `${provider.id} default`;
  }

  return {
    providerId: provider.id,
    providerDisplayName: provider.displayName,
    url,
    model,
    apiKey,
    apiKeySource,
    voice,
    voiceSource,
  };
}
