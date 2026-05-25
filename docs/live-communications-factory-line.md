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
- WhatsApp is still planned, not executable.
- Google Meet is executable as link intake, session briefing, REST artifact
  import, and live sidecar handoff. Actual meeting audio depends on a configured
  Media API/WebRTC driver behind the sidecar.

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

## Multi-Tenant Target

The live layer must be able to run as a hosted service, not only as one local
operator install. Every live session carries a tenant-aware context in
`session.metadata.liveContext`:

- `tenantId` / `accountId` / `workspaceId`
- `agentId` from the authenticated AgenticMail API key
- `hostIntegration` such as `openclaw`, `hermes`, `codex`, or `claudecode`
- `hostSessionId` for trace correlation
- `operatorId` and `operatorChannel`
- `projectRef`
- `behaviorMode` such as `listen_only`, `answer_when_asked`, or
  `operator_directed`
- `policyScope` and `budgetScope`

This gives the hosted version the room to:

- choose the cheapest allowed phone provider per tenant, region, and task
- rotate across multiple tenant-owned phone numbers
- keep tenant budgets and approval rules separate
- route Telegram, Matrix, WhatsApp, phone, and Meet through one ledger
- let OpenViking/OpenClaw bring project knowledge into live calls or meetings
- audit which host/session/operator caused a message, call, or spoken answer

Google Meet should use this as a knowledge participant, not just a note taker:
the session prepares from the tenant's project knowledge, listens, records
decisions, and speaks only when addressed or explicitly operator-directed.

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

Build steps:

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
6. Keep the product CLI centralized:
   - `agenticmail live setup`
   - `agenticmail live doctor`
   - `agenticmail live bridge --for openclaw`
   - host package binaries stay convenience aliases only.
7. Make every live session tenant-aware:
   - tenant/account id
   - agent id
   - host integration id (`openclaw`, `hermes`, `codex`, `claudecode`)
   - channel/session id
   - operator approval scope
   - budget/policy scope
8. Add an OpenClaw-native bridge runner mode that receives phone events, owns
   the live AI/tool loop, and returns audio/control events without requiring an
   OpenAI-compatible upstream.
9. Add operator query/approval endpoints and wire them into phone sessions.
10. Add a guided test call command that runs readiness, starts a safe call, and
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

Build steps:

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

Build steps:

1. `meet_setup`: done for API/MCP/OpenClaw. Stores OAuth access token
   encrypted, participant naming, workspace/domain hints, allowed domains,
   default behavior mode, consent flag, Developer Preview flag, and media
   sidecar URL. `meet_readiness` reports REST-space/artifact access and live
   media readiness separately.
2. `meet_link_intake`: done for direct API/tool/CLI intake. It parses a Meet
   URL or code, normalizes it, creates/reuses a `google_meet` conversation
   session, stores the
   topic, project hint, operator instructions, and desired behavior mode
   (`listen_only`, `answer_when_asked`, `operator_directed`).
3. `meet_session_prepare`: done for the first meeting handoff. The session records a system briefing
   with meeting URL/code, topic, project reference, operator instructions,
   behavior mode, and the explicit `live_media_status: not_joined` gate.
   Deeper project-context hydration remains a host/runtime responsibility.
4. `meet_space_create` / `meet_space_get`: done for managed spaces the agent
   creates or inspects through the Meet REST API.
5. Artifact discovery and ingestion: conference records, transcripts, and
   transcript entries can be listed/imported through `meet_conference_records`,
   `meet_transcripts`, and `meet_artifacts_import`.
6. Live media sidecar handoff: done through `meet_live_join`. AgenticMail
   validates the session/config gates and hands meeting context plus the
   OAuth token to a trusted HTTPS/localhost sidecar. The sidecar owns the
   actual WebRTC/Media API runtime. Host packages expose wrapper bins:
   `agenticmail-meet-sidecar`, `agenticmail-openclaw-meet-sidecar`,
   `agenticmail-codex-meet-sidecar`, `agenticmail-claudecode-meet-sidecar`,
   and `agenticmail-hermes-meet-sidecar`.
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

Current implementation:

1. MCP/OpenClaw/CLI intake accepts a Meet link plus project/topic instructions.
2. AgenticMail creates a `google_meet` session and prepares a briefing.
3. `meet_setup`, `meet_readiness`, `meet_space_create`, `meet_space_get`,
   `meet_conference_records`, `meet_transcripts`, `meet_artifacts_import`,
   `meet_live_join`, and `meet_disable` are exposed in MCP/OpenClaw.
4. If live Media API access is unavailable, the response fails live-join closed
   with `readyForLiveJoin: false` and exact missing requirements.
5. If live Media API access is available, the configured sidecar receives a
   live-join request with the meeting URI/code, behavior mode, topic, goal,
   participant name, session id, and an authenticated event callback.
   `/meet/live/events` accepts sidecar-token-authenticated status, transcript,
   note, action-item, question, and error events and writes them into the
   conversation ledger with duplicate protection. The local sidecar also
   exposes `/events/<sessionId>`, so a WebRTC driver can post locally and let
   the sidecar forward to AgenticMail with the stored callback token.
6. Speaking is a second gate: the agent can only speak when addressed by name
   or when the operator sends an explicit `say:` command.

Local sidecar smoke:

```bash
agenticmail-openclaw-meet-sidecar --token <shared-token>
```

Then configure the agent with `meet_setup`:

```json
{
  "accessToken": "<google-oauth-token>",
  "mediaApiDeveloperPreview": true,
  "mediaSidecarUrl": "http://127.0.0.1:4999",
  "mediaSidecarToken": "<shared-token>",
  "consentPolicyAccepted": true
}
```

Current test hook:

```bash
agenticmail live test meet \
  --link https://meet.google.com/abc-defg-hij \
  --topic "Project Alpha pricing review" \
  --project-ref project-alpha \
  --behavior-mode answer_when_asked \
  --instructions "Use OpenViking memory and speak only when asked."
```

Add `--start` to create the intake session through the local API. This proves
the session ledger and briefing path; it deliberately does not claim a live
Meet bot exists yet.

## Implementation Order

| Order | Work | Outcome |
| --- | --- | --- |
| 1 | Commit and keep PR #48 readiness doctor green | We can diagnose real phone readiness from OpenClaw/MCP. |
| 2 | Phone `host_bridge` runtime contract | Done: AgenticMail no longer has to own the live AI key for OpenClaw deployments. |
| 3 | Local host bridge runner | Done: localhost WebSocket proxy with CLI/OpenClaw/Codex/Claude Code wrapper bins. |
| 4 | Host-native speech pipeline | OpenClaw/Codex/Claude Code can act as the live conversation brain without an OpenAI-compatible upstream. |
| 5 | Operator query/approval flow | The agent can pause, ask the operator, resume, and record approvals. |
| 6 | Guided phone smoke test | One command proves "this install can call and converse". |
| 7 | WhatsApp `meta_cloud` adapter | First non-Telegram/non-Matrix external messaging channel. |
| 8 | Google Meet link intake + briefing | Done for API/MCP/OpenClaw/CLI intake: creates a session, stores context, and produces an honest readiness result. |
| 9 | Google Meet space + artifact adapter | Done: setup/readiness, space create/get, transcript entry import. |
| 10 | Google Meet media sidecar | Real live meeting audio path into the same host bridge. |
| 11 | Google Meet speak-back policy | The agent can answer when addressed or operator-directed, with consent and approval gates. |

## Testing Gate

Every work item needs:

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
