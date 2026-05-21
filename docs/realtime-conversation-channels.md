# Realtime Conversation Channels

AgenticMail's live-conversation work starts with phone calls, but the contract must not become phone-only. The core capability map in `packages/core/src/conversation/realtime.ts` defines the channel targets and their readiness gates.

The next execution plan is tracked in
[`live-communications-factory-line.md`](./live-communications-factory-line.md):
phone `host_bridge`, OpenClaw-owned realtime brain, WhatsApp provider adapters,
and Google Meet media/space adapters.

## Channel Matrix

| Channel | Status | Mode | Notes |
| --- | --- | --- | --- |
| Phone | Available | Duplex audio | Current executable path: phone mission -> carrier media stream -> `RealtimeVoiceBridge`. Requires realtime media, an embedded realtime provider or `host_bridge`, and a per-mission policy. |
| Telegram | Available | Near-realtime text | Already usable as a user/agent message channel and operator escalation path. It is text-turn realtime, not audio realtime. |
| Matrix | Available | Near-realtime text | Plain-text Matrix bot adapter over the Client-Server API: homeserver/token setup, allowed rooms, `m.room.message` send, `/sync` poll ingestion, transcript mirroring, and host wake prompts. E2EE rooms need a separate E2EE-capable bot runtime. |
| WhatsApp | Planned | Near-realtime text | Must be opt-in and WhatsApp Business/template/session-window aware. It must not be treated as free-form SMS. |
| Google Meet | Planned | Meeting AV | Needs a meeting bot/join authority, audio capture/playback bridge, transcript, and participant consent policy. It is not a phone carrier. |

## Start Gate

Use `planRealtimeConversationStart()` before claiming a channel can start:

- Unknown channels fail closed.
- Planned adapters fail closed until their implementation exists.
- Opt-in channels require user opt-in.
- Matrix requires a configured homeserver/access token and a linked/allowed room.
- Phone requires a configured transport, realtime media, an embedded realtime provider key or `host_bridge`, and mission policy.
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
`conversation_end` for active sessions. For ordinary phone calls, MCP hosts can
use `call_phone_safe` to start a mission with a built-in safe policy preset
instead of handcrafting the full policy JSON.
OpenClaw hosts use `agenticmail_realtime_conversation_capabilities` and
`agenticmail_realtime_conversation_plan`.
They use `agenticmail_conversation_list`, `agenticmail_conversation_get`,
`agenticmail_conversation_context`, `agenticmail_conversation_start`,
`agenticmail_conversation_send`, `agenticmail_conversation_messages`, and
`agenticmail_conversation_end` for active sessions. For ordinary calls,
OpenClaw hosts should prefer `agenticmail_call_phone_safe`; `agenticmail_call_phone`
remains the raw-policy escape hatch.

Voice runtime selection is provider-registry based. `GET
/api/agenticmail/phone/voice/providers`, `phone_voice_providers`, and
`agenticmail_phone_voice_providers` list the registered phone voice runtimes,
default models, voice catalogue, and key readiness without returning secrets.
Per-call `voiceRuntime`, `voiceModel`, and `voice` fields can be passed through
`call_phone_safe`, raw `call_phone`, or `conversation_start(channel: "phone")`.
For host-owned provider keys, run a local bridge and select `host_bridge`:

```bash
OPENAI_API_KEY=sk-... agenticmail-voice-host-bridge

AGENTICMAIL_VOICE_RUNTIME=host_bridge
AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime
```

The same runner is available from host packages as
`agenticmail-openclaw-voice-host-bridge`,
`agenticmail-codex-voice-host-bridge`, and
`agenticmail-claudecode-voice-host-bridge`, plus the Hermes helper
`agenticmail-hermes-voice-host-bridge`. Add
`AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN` on both sides if the bridge should reject
unauthenticated local clients. `phone_readiness` also checks the bridge's
derived `/health` endpoint, so a configured URL does not count as ready unless
the local bridge process is actually reachable.

OpenClaw setup shape:

1. Start the bridge next to OpenClaw:
   `OPENAI_API_KEY=sk-... agenticmail-openclaw-voice-host-bridge --token <shared-token>`.
2. Put `AGENTICMAIL_VOICE_RUNTIME=host_bridge`,
   `AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime`, and the
   same `AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN` into the AgenticMail API service
   environment.
3. Restart AgenticMail API, then run
   `agenticmail_phone_readiness({ "voiceRuntime": "host_bridge" })` from
   OpenClaw. Only `canHoldRealtimeConversation: true` means the live call path
   is usable.

Hermes uses the same contract. The Hermes-named bin is intentionally just a
thin wrapper around `@agenticmail/voice-host-bridge`, so a future Python-native
Hermes plugin can keep using the same AgenticMail env, health check, and
`host_bridge` runtime.

For an operator-facing "can I make a real live call now?" check, use `GET
/api/agenticmail/phone/readiness`, `phone_readiness`, or
`agenticmail_phone_readiness`. The response separates tracked call-control from
full realtime conversation readiness, lists exact missing setup items, and
returns a safe `call_phone_safe` test-call template.

## Conversation Sessions

Conversation sessions are the runtime ledger above the individual transports:

- `POST /conversation/sessions/:id/messages` means "deliver this text through
  the channel transport". Today that is executable for Telegram and Matrix text
  sessions.
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
- Matrix sessions are executable now for plain-text bot rooms. `matrix_setup`
  / `agenticmail_matrix_setup` stores the homeserver, access token, and allowed
  rooms. Starting a Matrix conversation can send an initial message, later
  `conversation_send` calls send `m.room.message` events, and `matrix_poll` /
  `agenticmail_matrix_poll` ingests `/sync` message events into the same
  conversation transcript. Fresh inbound Matrix messages also wake the host via
  the same synthetic-inbox bridge as Telegram. When a Matrix message belongs to
  an active session, the wake prompt instructs MCP/OpenClaw hosts to answer with
  `conversation_send` / `agenticmail_conversation_send`; otherwise it routes
  replies through `matrix_send` / `agenticmail_matrix_send`.
- Phone sessions wrap a tracked phone mission and record the mission id as the
  session's external reference. They are created both by
  `conversation_start(channel: "phone")` and by the legacy `/calls/start`
  / `call_phone` path, so older host tools still get the same ledger. Phone
  starts can pass either a full raw `policy` or a safe `policyPreset`
  (`safe_default`, `reservation`, `support`) plus optional limits such as
  `regionAllowlist`, `maxCostPerMission`, and `maxTimeShiftMinutes`. The audio
  conversation still runs through the carrier WebSocket -> `RealtimeVoiceBridge`
  path. Realtime bridge transcript entries are mirrored into the active
  conversation session so `conversation_context` can show caller, agent, and
  system turns. Provider hangups and operator cancellations close the active
  phone session instead of leaving stale live conversations behind. `GET
  /calls/:id` includes the linked `conversationSession`, so hosts can recover
  the ledger from a mission id.
- WhatsApp and Google Meet remain planned and fail closed through the same start
  gate until their adapters exist.

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
