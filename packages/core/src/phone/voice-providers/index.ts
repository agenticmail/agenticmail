/**
 * Voice-provider registry — public entry point.
 *
 * The side-effect imports below pull each provider file in for its
 * `registerVoiceProvider()` call. Adding a new provider:
 *
 *   1. Create `./<id>.ts` exporting nothing — it just calls
 *      `registerVoiceProvider({ id, displayName, websocketBaseUrl,
 *      defaultModel, apiKeyEnvVar, ... })` at module load.
 *   2. Add a single `import './<id>.js';` line below.
 *   3. Done — the rest of the codebase discovers the provider by id
 *      through `listVoiceProviders` / `resolveVoiceRuntime`.
 *
 * Order doesn't matter; the registry rejects duplicate ids so a
 * copy-paste collision is loud.
 */

// Side-effect imports — each file calls registerVoiceProvider at load.
import './openai.js';
import './grok.js';
import './host-bridge.js';

// Public re-exports.
export {
  registerVoiceProvider,
  listVoiceProviders,
  getVoiceProvider,
  resolveVoiceRuntime,
} from './registry.js';
export type { VoiceProvider, VoiceRuntimeConnection } from './types.js';
export { previewVoice, playWav, PREVIEW_SAMPLE_RATE } from './preview.js';
export type { VoicePreviewOptions, VoicePreviewResult } from './preview.js';
