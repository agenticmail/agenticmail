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

## Google Meet sidecar

The package also ships `agenticmail-meet-sidecar`, an HTTP sidecar for Google
Meet live-session handoff:

```bash
agenticmail-meet-sidecar --token local-secret
```

Configure the agent with:

```json
{
  "mediaSidecarUrl": "http://127.0.0.1:4999",
  "mediaSidecarToken": "local-secret"
}
```

The sidecar accepts `/join`, stores non-secret session status under
`/sessions`, and can delegate the real Google Meet Media API/WebRTC work to a
local executable via `--driver-command` plus repeated `--driver-arg` flags.
The join JSON passed to the driver includes `eventCallbackUrl` and
`eventCallbackToken`; drivers should POST live status/transcript/note events
to the local sidecar `/events/<sessionId>` endpoint. The sidecar forwards them
to AgenticMail with the token in `x-agenticmail-meet-sidecar-token`.
