# Live Communications Factory Line

Status: execution plan for PR #48 follow-up work.
Scope: AgenticMail as the channel, transport, session, readiness, and policy
gateway for live agent communications. OpenClaw, Codex CLI, Claude Code,
Gemini CLI, Hermes, or another host remains the agent brain.

## Current Truth

PR #48 now has the shared live-conversation substrate:

- Conversation sessions and transcript ledger.
- Telegram and Matrix text-turn sessions.
- Phone sessions linked to call missions.
- Safe phone-call policy presets.
- Phone voice-runtime provider listing.
- Phone readiness doctor for "can this deployment place a real tracked call?"
  and "can it hold a realtime spoken conversation?"

What is now executable:

- AgenticMail exposes a `host_bridge` voice runtime contract.
- `@agenticmail/voice-host-bridge` runs the localhost WebSocket bridge that
  AgenticMail connects to in `host_bridge` mode.
- `phone_readiness` checks the bridge `/health` endpoint instead of treating a
  configured URL as enough.
- `@agenticmail/cli`, `@agenticmail/openclaw`, `@agenticmail/codex`,
  `@agenticmail/claudecode`, and `@agenticmail/hermes` expose wrapper bins for
  the same bridge runner.

What is not done yet:

- The first bridge runner is an OpenAI-Realtime-compatible proxy. It moves the
  live provider key into the host process and works with OpenAI/XAI-compatible
  realtime providers, but it does not yet implement a custom Codex/OpenClaw
  speech pipeline from STT + host LLM + TTS.
- WhatsApp and Google Meet adapters are still planned, not executable.

## Boundary Decision

The right product boundary is:

| Layer | Owns |
| --- | --- |
| AgenticMail | Channel setup, provider webhooks, carrier media streams, message send/receive, session ledger, transcripts, consent/policy logs, readiness checks, redacted config reporting. |
| Host runtime | Agent identity, live reasoning loop, model/provider keys where possible, tool use, booking/browser actions, operator policy decisions. |
| Provider adapter | Provider-specific auth, protocol quirks, webhook verification, message/media shape conversion. |

So the objection is correct: OpenClaw should not be forced to put every live
conversation AI key into AgenticMail. The current embedded mode exists because
the phone bridge opens the realtime provider websocket server-side. That is a
useful default for standalone AgenticMail installs, but it is not the best
boundary for OpenClaw.

## Runtime Modes

AgenticMail should support two voice runtime modes:

| Mode | AgenticMail key needed? | Purpose |
| --- | --- | --- |
| `embedded_realtime` | Yes | Standalone install. AgenticMail connects carrier audio directly to an OpenAI/XAI-compatible realtime provider. This keeps demos and simple deployments working. |
| `host_bridge` | No for the model key | OpenClaw/CLI owns the live AI session. AgenticMail bridges carrier/meeting/channel events to a local or remote host bridge, receives audio/control responses, and stores the ledger. This is the target for OpenClaw. |

The readiness doctor must report both modes separately. A deployment can be
"transport ready" while still not "live conversation ready" because neither an
embedded provider key nor a host bridge is reachable.

## Provider Expansion

Do not fake provider support by forcing every vendor into the current
OpenAI-style websocket interface. Introduce protocol-level runtime adapters:

| Adapter protocol | Examples | Notes |
| --- | --- | --- |
| `openai_realtime_ws` | OpenAI-compatible realtime websocket, XAI if protocol-compatible | Already closest to current implementation. |
| `host_bridge` | OpenClaw, Codex CLI, Claude Code, Gemini CLI, Hermes | AgenticMail streams normalized events; host returns audio/text/control events. |
| `speech_pipeline` | STT + LLM + TTS stacks, local or hosted | Lets users combine Deepgram/Whisper, Claude/Gemini/local LLMs, ElevenLabs/Cartesia/Piper/etc. |
| `conversation_api` | Vendor-hosted conversation products | Useful when a provider owns the whole realtime dialog loop. Keep it behind the same session ledger and policy gates. |
| `webrtc_media` | LiveKit/Daily/Meet-style media clients | Required for meeting/video channels where audio arrives over WebRTC rather than telephony websockets. |

The user-facing setup should ask for a runtime mode and provider, but the
internal contract is protocol first. That keeps the product open instead of
hard-coding one AI vendor.

## Channel Plan

### Phone

Goal: OpenClaw can say "call this place, reserve X, ask me if the alternative
is materially different", and the call actually happens.

Factory slices:

1. Keep PR #48 readiness doctor green and visible.
2. Add `host_bridge` runtime mode to phone config and readiness.
3. Add the local host bridge runner:
   - `agenticmail-voice-host-bridge`
   - `agenticmail-openclaw-voice-host-bridge`
   - `agenticmail-codex-voice-host-bridge`
   - `agenticmail-claudecode-voice-host-bridge`
   - `agenticmail-hermes-voice-host-bridge`
4. Configure AgenticMail for the runner:
   - `AGENTICMAIL_VOICE_RUNTIME=host_bridge`
   - `AGENTICMAIL_VOICE_HOST_BRIDGE_URL=ws://127.0.0.1:3999/realtime`
   - optional `AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN=<shared token>`
5. Add a normalized realtime event protocol:
   - inbound audio frame
   - outbound audio frame
   - partial/final transcript
   - tool request
   - policy/approval request
   - hangup/cancel/summary
6. Add an OpenClaw-native bridge runner mode that receives phone events, owns
   the live AI/tool loop, and returns audio/control events without requiring an
   OpenAI-compatible upstream.
7. Add operator query/approval endpoints and wire them into phone sessions.
8. Add a guided test call command that runs readiness, starts a safe call, and
   prints the linked conversation session id.

Definition of done:

- `agenticmail_phone_readiness` says `canHoldRealtimeConversation: true`.
- `agenticmail_call_phone_safe` starts a call.
- OpenClaw, not AgenticMail, can own the live AI provider key in `host_bridge`
  mode.
- Transcript, decisions, operator questions, and summary are recoverable from
  the conversation session.

### WhatsApp

Goal: WhatsApp becomes a first-class near-realtime text/media channel with the
same session ledger, wake behavior, policy gates, and provider abstraction.

Official direct path: Meta WhatsApp Cloud API:

- Send messages through the Cloud API message endpoint.
- Receive inbound messages and status updates through webhooks.
- Respect templates, opt-in, and customer-service/session-window rules.

References:

- https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates

Provider adapter path:

| Adapter | Why |
| --- | --- |
| `meta_cloud` | First direct implementation, no third-party dependency. |
| `twilio_whatsapp` | Useful for users who already run Twilio phone/SMS. |
| `360dialog` | Common EU WhatsApp Business provider path. |
| `messagebird` / Bird | Common multi-channel provider path. |

Factory slices:

1. Add `WhatsAppAdapter` interface: setup, readiness, webhook verify, send,
   normalize inbound, template metadata, session-window metadata.
2. Add `whatsapp_setup`, `whatsapp_readiness`, `whatsapp_send`,
   `whatsapp_poll` or webhook ingestion, and conversation-session wiring.
3. Add OpenClaw/MCP tools mirroring the Telegram/Matrix shape.
4. Add tests with webhook fixtures and send-message request assertions.

Do not promise WhatsApp voice/video calls unless a provider exposes a supported
business API for that. The first WhatsApp deliverable is conversational
text/media, not a WhatsApp call bot.

### Google Meet

Goal: Meet becomes a managed meeting channel, then a live AV participant
channel.

Product shape:

The operator can send AgenticMail/OpenClaw a Telegram message like:

```text
Here is the Google Meet link: https://meet.google.com/abc-defg-hij
Topic: Project Alpha pricing review.
Prepare from the project memory, join, listen, keep notes, update the task log,
and only speak when someone asks you or when I explicitly tell you to.
```

The agent should then:

1. Parse the Meet link and create a `google_meet` conversation session.
2. Load project context through the normal host memory/context tools.
3. Join the meeting as a clearly named participant.
4. Consume live audio, speaker metadata, and later artifacts.
5. Produce a running transcript/notes stream into the conversation ledger.
6. Offer facts, task updates, links, or short spoken answers when addressed.
7. Escalate to the operator over Telegram before commitments, sensitive
   disclosures, or unclear tradeoffs.
8. Close with a meeting recap, changed tasks, open questions, and evidence
   links.

This is a meeting participant product, not only a transcript fetcher. REST
artifacts are useful after the call, but the product value is the live
"prepared colleague in the room" loop.

What is direct:

- The Google Meet REST API can create/manage meeting spaces and fetch meeting
  artifacts such as transcripts/recordings.
- The Google Meet Media API can access realtime meeting media, but it is
  Developer Preview and requires the project, OAuth principal, and participants
  to be enrolled.

References:

- https://developers.google.com/meet/api/guides/overview
- https://developers.google.com/workspace/meet/api/guides/meeting-spaces
- https://developers.google.com/workspace/meet/api/guides/artifacts
- https://developers.google.com/workspace/meet/media-api/guides/overview
- https://developers.google.com/workspace/meet/media-api/guides/get-started

Factory slices:

1. `meet_setup`: OAuth scopes, workspace/project config, participant naming,
   consent wording, allowed domains, and operator approval policy.
2. `meet_link_intake`: parse a Meet URL from Telegram/Matrix/email, store the
   topic, project hint, operator instructions, and desired behavior mode
   (`listen_only`, `answer_when_asked`, `operator_directed`).
3. `meet_session_prepare`: build the session briefing from AgenticMail memory,
   project context, prior emails, prior conversation sessions, and explicit
   operator notes.
4. `meet_space_create` / `meet_space_get` / `meet_space_end`: managed spaces
   for meetings the agent creates itself.
5. Artifact ingestion: transcript/recording metadata and transcript entries
   into conversation sessions.
6. Live media sidecar: WebRTC client that joins/consumes media and streams it
   through the same `host_bridge` protocol used by phone.
7. Live note stream: speaker-attributed partial/final transcript events,
   action items, decisions, questions, and source links mirrored to the
   conversation ledger.
8. Speak-back path: only after join/media capture is proven and consent policy
   is explicit. The first mode should be "answer when asked", not free-form
   interruption.
9. Operator side channel: Telegram commands such as `say: ...`, `mute`,
   `leave`, `summarize`, `ask me before answering`, and `approve answer`.

REST alone does not make the agent "speak in a meeting". The live bot requires
a join/media runtime. Google now has a path through the Meet Media API, but it
must be implemented as a real media sidecar, not as a fake REST wrapper.

First credible MVP:

1. Telegram intake accepts a Meet link plus project/topic instructions.
2. Agent creates a `google_meet` session and prepares a briefing.
3. If live Media API access is unavailable, the session fails closed with the
   exact missing Google Workspace/Developer Preview/OAuth requirements.
4. If live Media API access is available, the sidecar joins in listen-only mode,
   streams transcript notes into the ledger, and posts periodic Telegram
   summaries.
5. Speaking is a second gate: the agent can only speak when addressed by name
   or when the operator sends an explicit `say:` command.

## Implementation Order

| Order | Slice | Outcome |
| --- | --- | --- |
| 1 | Commit and keep PR #48 readiness doctor green | We can diagnose real phone readiness from OpenClaw/MCP. |
| 2 | Phone `host_bridge` runtime contract | Done: AgenticMail no longer has to own the live AI key for OpenClaw deployments. |
| 3 | Local host bridge runner | Done: localhost WebSocket proxy with CLI/OpenClaw/Codex/Claude Code wrapper bins. |
| 4 | Host-native speech pipeline | OpenClaw/Codex/Claude Code can act as the live conversation brain without an OpenAI-compatible upstream. |
| 5 | Operator query/approval flow | The agent can pause, ask the operator, resume, and record approvals. |
| 6 | Guided phone smoke test | One command proves "this install can call and converse". |
| 7 | WhatsApp `meta_cloud` adapter | First non-Telegram/non-Matrix external messaging channel. |
| 8 | Google Meet link intake + briefing | Telegram-to-Meet handoff creates a session, loads context, and produces an honest readiness result. |
| 9 | Google Meet space + artifact adapter | Meeting setup/transcript value without pretending live AV is done. |
| 10 | Google Meet media sidecar | Real live meeting audio path into the same host bridge. |
| 11 | Google Meet speak-back policy | The agent can answer when addressed or operator-directed, with consent and approval gates. |

## Testing Gate

Every slice needs:

- Unit tests for adapter normalization and policy/readiness gates.
- MCP/OpenClaw tool tests for request/response shape.
- `git diff --check`.
- Workspace build for touched packages.
- Live smoke only when credentials/provider setup exist.

The live smoke definition for phone is:

1. Run `agenticmail_phone_readiness`.
2. Confirm no missing transport/runtime item for the selected mode.
3. Start `agenticmail_call_phone_safe` with a harmless test number/task.
4. Confirm transcript entries appear in `agenticmail_conversation_context`.
5. End/hang up and confirm the conversation session closes cleanly.

## Contributor Handling

Keep this as contributor work:

- Feature work goes through public PRs.
- Sensitive/security material stays in GitHub private vulnerability reporting.
- Do not open public issues for private security details.
- Keep commits small enough for maintainers to review, but large enough that
  each commit has a working test boundary.
