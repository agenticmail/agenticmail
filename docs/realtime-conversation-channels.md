# Realtime Conversation Channels

AgenticMail's live-conversation work starts with phone calls, but the contract must not become phone-only. The core capability map in `packages/core/src/conversation/realtime.ts` defines the channel targets and their readiness gates.

## Channel Matrix

| Channel | Status | Mode | Notes |
| --- | --- | --- | --- |
| Phone | Available | Duplex audio | Current executable path: phone mission -> carrier media stream -> `RealtimeVoiceBridge`. Requires realtime media, OpenAI Realtime, and a per-mission policy. |
| Telegram | Available | Near-realtime text | Already usable as a user/agent message channel and operator escalation path. It is text-turn realtime, not audio realtime. |
| Matrix | Planned | Near-realtime text | Should reuse the Telegram-style channel contract: room membership, message event bridge, transcript, tool loop. |
| WhatsApp | Planned | Near-realtime text | Must be opt-in and WhatsApp Business/template/session-window aware. It must not be treated as free-form SMS. |
| Google Meet | Planned | Meeting AV | Needs a meeting bot/join authority, audio capture/playback bridge, transcript, and participant consent policy. It is not a phone carrier. |

## Start Gate

Use `planRealtimeConversationStart()` before claiming a channel can start:

- Unknown channels fail closed.
- Planned adapters fail closed until their implementation exists.
- Opt-in channels require user opt-in.
- Phone requires a configured transport, realtime media, OpenAI Realtime, and mission policy.
- 46elks phone realtime also requires `realtimeBridgeNumber`, the 46elks websocket-number that outbound calls connect to.
- WhatsApp additionally requires template/session-window approval.
- Google Meet additionally requires operator approval to join or create a meeting.

The API exposes the same gate for host integrations:

- `GET /api/agenticmail/conversation/realtime/capabilities`
- `GET /api/agenticmail/conversation/realtime/capabilities?channel=phone`
- `POST /api/agenticmail/conversation/realtime/plan`

MCP hosts use `realtime_conversation_capabilities` and `realtime_conversation_plan`.
OpenClaw hosts use `agenticmail_realtime_conversation_capabilities` and
`agenticmail_realtime_conversation_plan`.

## 46elks Realtime Bridge Number

For 46elks, `realtime_media` is not enough by itself. The provider expects a
normal voice number to connect to a separate websocket-number. Configure the
phone transport with:

- `capabilities: ["call_control", "realtime_media"]`
- `realtimeBridgeNumber: "+46..."` pointing at the 46elks websocket-number
- the websocket-number's `voice_start` set to `wss://<host>/api/agenticmail/calls/realtime?token=<webhookSecret>`

Twilio does not need this bridge-number field because its voice webhook returns
TwiML with `<Connect><Stream>` directly.

This keeps the roadmap broad enough for Telegram, Matrix, WhatsApp, and Google Meet while the actual product path remains honest: phone realtime first, then channel adapters.
