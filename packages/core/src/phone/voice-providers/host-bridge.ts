/**
 * Host realtime bridge — lets OpenClaw / Codex / Claude Code / Gemini CLI own
 * the live model session and tool loop.
 *
 * The host bridge must expose an OpenAI-Realtime-compatible websocket. That
 * keeps the existing carrier bridge reusable while moving model-provider keys
 * out of AgenticMail for host-owned deployments.
 */

import { registerVoiceProvider } from './registry.js';

registerVoiceProvider({
  id: 'host_bridge',
  displayName: 'Host Realtime Bridge',
  websocketBaseUrl: '',
  resolveWebsocketBaseUrl: (config) => config.voiceHostBridge?.url,
  defaultModel: 'host-owned',
  apiKeyEnvVar: 'AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN',
  apiKeyRequired: false,
  description:
    'Host-owned OpenAI-Realtime-compatible websocket. AgenticMail bridges carrier media; '
    + 'OpenClaw/CLI owns the live model provider key and tool loop.',
  voices: [],
  defaultVoice: 'host-default',
  customVoicesSupported: true,
});
