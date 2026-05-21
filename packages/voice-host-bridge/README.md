# @agenticmail/voice-host-bridge

Localhost realtime voice host bridge for AgenticMail phone calls.

It exposes an OpenAI-Realtime-compatible WebSocket for AgenticMail's
`host_bridge` voice runtime and opens the upstream realtime provider connection
from the host process. That keeps OpenAI/XAI provider keys in OpenClaw, Codex,
Claude Code, or another host runtime instead of requiring AgenticMail to store
them.

```bash
OPENAI_API_KEY=sk-... agenticmail-voice-host-bridge

AGENTICMAIL_VOICE_RUNTIME=host_bridge
AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime
```

Use `--provider xai` with `XAI_API_KEY` for an XAI-compatible upstream. Use
`--provider custom --upstream-url ws://127.0.0.1:<port>/realtime --upstream-auth none`
for a local no-auth upstream runtime.
