# @agenticmail/hermes

Hermes host helpers for AgenticMail.

The full Hermes integration can remain Python-native. This package makes the
shared AgenticMail host-side utilities available under Hermes-named bins, so
Hermes deployments can use the same phone `host_bridge` runtime as OpenClaw,
Codex, and Claude Code.

```bash
OPENAI_API_KEY=sk-... agenticmail-hermes-voice-host-bridge

AGENTICMAIL_VOICE_RUNTIME=host_bridge
AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime
```

Use `--provider xai` with `XAI_API_KEY` for an XAI-compatible realtime
upstream, or `--provider custom --upstream-url ... --upstream-auth none` for a
local Hermes-owned realtime runtime.
