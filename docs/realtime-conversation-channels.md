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
- `GET /api/agenticmail/conversation/sessions`
- `GET /api/agenticmail/conversation/sessions/:id`
- `GET /api/agenticmail/conversation/sessions/:id/context`
- `POST /api/agenticmail/conversation/sessions/start`
- `POST /api/agenticmail/conversation/sessions/:id/messages`
- `POST /api/agenticmail/conversation/sessions/:id/transcript`
- `GET /api/agenticmail/conversation/sessions/:id/messages`
- `POST /api/agenticmail/conversation/sessions/:id/end`

MCP hosts use `realtime_conversation_capabilities` and `realtime_conversation_plan`.
They use `conversation_list`, `conversation_get`, `conversation_context`,
`conversation_start`, `conversation_send`, `conversation_messages`, and
`conversation_end` for active sessions.
OpenClaw hosts use `agenticmail_realtime_conversation_capabilities` and
`agenticmail_realtime_conversation_plan`.
They use `agenticmail_conversation_list`, `agenticmail_conversation_get`,
`agenticmail_conversation_context`, `agenticmail_conversation_start`,
`agenticmail_conversation_send`, `agenticmail_conversation_messages`, and
`agenticmail_conversation_end` for active sessions.

## Conversation Sessions

Conversation sessions are the runtime ledger above the individual transports:

- `POST /conversation/sessions/:id/messages` means "deliver this text through
  the channel transport". Today that is executable for Telegram text sessions.
- `POST /conversation/sessions/:id/transcript` means "mirror an already
  observed event into the ledger". It records inbound, outbound, or system
  turns against the session's existing channel and does not send anything over
  Matrix, WhatsApp, Meet, phone, or Telegram.
- Telegram sessions are executable now. Starting a session can send an initial
  message, later `conversation_send` calls send more text turns, and inbound
  Telegram webhooks/polls append replies to the same session transcript. When
  a sleeping host is woken by Telegram, the wake message includes the active
  `sessionId` and tells MCP/OpenClaw hosts to answer with `conversation_send`
  / `agenticmail_conversation_send`. A bare Telegram stop command such as
  `/stop` is recorded in the transcript and closes the active session without
  waking the host for another turn.
- Phone sessions wrap a tracked phone mission and record the mission id as the
  session's external reference. They are created both by
  `conversation_start(channel: "phone")` and by the legacy `/calls/start`
  / `call_phone` path, so older host tools still get the same ledger. The audio
  conversation still runs through the carrier WebSocket -> `RealtimeVoiceBridge`
  path. Realtime bridge transcript entries are mirrored into the active
  conversation session so `conversation_context` can show caller, agent, and
  system turns. Provider hangups and operator cancellations close the active
  phone session instead of leaving stale live conversations behind. `GET
  /calls/:id` includes the linked `conversationSession`, so hosts can recover
  the ledger from a mission id.
- Matrix, WhatsApp, and Google Meet remain planned and fail closed through the
  same start gate until their adapters exist.

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
