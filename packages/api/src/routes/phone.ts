import { Router, urlencoded, type Request, type Response } from 'express';
import {
  ConversationSessionManager,
  PhoneManager,
  PhoneWebhookAuthError,
  PhoneRateLimitError,
  buildPhoneTransportConfig,
  listVoiceProviders,
  redactPhoneTransportConfig,
  validateTwilioSignature,
  type AgenticMailConfig,
  type PhoneMissionState,
  type PhoneCallMission,
  type PhoneTransportConfig,
  type VoiceProvider,
} from '@agenticmail/core';
import { requestPhonePolicyPreset, resolvePhoneMissionPolicy } from '../phone-policy.js';

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the per-mission webhook token (#43-H7). 46elks calls our webhook
 * URL back with `?token=<HMAC>`; a header form is also accepted for
 * manual testing / a future provider that can set headers.
 */
function readWebhookToken(req: Request): string {
  return requestString(req.query.token)
    || requestString(req.get('x-agenticmail-webhook-token'))
    || requestString(req.get('x-46elks-token'))
    || requestString((req.body as Record<string, unknown> | undefined)?.token);
}

function readMissionId(req: Request): string {
  return requestString(req.query.missionId)
    || requestString(req.query.mission)
    || requestString((req.body as Record<string, unknown> | undefined)?.missionId)
    || requestString((req.body as Record<string, unknown> | undefined)?.mission);
}

/**
 * Reconstruct the absolute URL Twilio requested — the string Twilio
 * computed its `X-Twilio-Signature` over. Twilio signs the exact URL it
 * was configured with (scheme + host + path + query). We hand Twilio a
 * URL rooted at the agent's configured `webhookBaseUrl`, so that base
 * is the source of truth for scheme + host; the path and query come
 * from the inbound request. This avoids trusting a proxy-mangled
 * `Host` header.
 */
function twilioRequestUrl(req: Request, webhookBaseUrl: string): string {
  const base = new URL(webhookBaseUrl);
  const requested = new URL(req.originalUrl, `${base.protocol}//${base.host}`);
  return requested.toString();
}

/**
 * Collect a Twilio webhook's POST parameters as a flat string map — the
 * input to the signature computation. Twilio sends
 * `application/x-www-form-urlencoded`, so `req.body` is a flat object;
 * array/object values (which Twilio never sends for a signed webhook)
 * are coerced to strings defensively.
 */
function twilioFormParams(req: Request): Record<string, string> {
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    params[key] = typeof value === 'string' ? value : String(value);
  }
  return params;
}

/** Body keys carrying a token-bearing webhook URL (46elks + Twilio). */
const WEBHOOK_URL_KEYS = ['voice_start', 'whenhangup', 'Url', 'StatusCallback'] as const;

/**
 * Replace every token-bearing webhook URL in an echoed provider-request
 * body with a `[redacted-url]` placeholder, so a `/calls/start`
 * response never leaks a per-mission webhook token. Provider-agnostic —
 * keys absent for a given provider are skipped.
 */
function redactWebhookBody(body: Record<string, string>): Record<string, string> {
  const out = { ...body };
  for (const key of WEBHOOK_URL_KEYS) {
    if (typeof out[key] === 'string') out[key] = '[redacted-url]';
  }
  return out;
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function isPhoneWebhookAuthError(err: unknown): boolean {
  return err instanceof PhoneWebhookAuthError || (err as { isPhoneWebhookAuthError?: boolean })?.isPhoneWebhookAuthError === true;
}

function isPhoneRateLimitError(err: unknown): boolean {
  return err instanceof PhoneRateLimitError || (err as { isPhoneRateLimitError?: boolean })?.isPhoneRateLimitError === true;
}

function errorStatus(err: unknown): number {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes('not found')) return 404;
  // Client input-validation errors → 400. buildPhoneTransportConfig and
  // the mission validators phrase every input error with one of these.
  if (msg.includes('Invalid') || msg.includes('required') || msg.includes('not configured')
      || msg.includes('must use') || msg.includes('must be') || msg.includes('must contain')) {
    return 400;
  }
  return 500;
}

/**
 * Centralised phone error responder. Typed errors are mapped to fixed
 * statuses BEFORE any message-substring heuristic runs:
 *   - PhoneWebhookAuthError -> a uniform 403 + generic body. No 404-vs-403
 *     branch on mission existence, so no enumeration oracle (#43-H3).
 *   - PhoneRateLimitError   -> 429 (the message is operator-safe).
 */
function sendPhoneError(res: Response, err: unknown): void {
  if (isPhoneWebhookAuthError(err)) {
    res.status(403).json({ error: 'Invalid phone webhook request' });
    return;
  }
  if (isPhoneRateLimitError(err)) {
    res.status(429).json({ error: (err as Error).message });
    return;
  }
  res.status(errorStatus(err)).json({ error: (err as Error).message });
}

function phoneRealtimeReady(cfg: ReturnType<PhoneManager['getPhoneTransportConfig']>): boolean {
  if (!cfg?.capabilities.includes('realtime_media')) return false;
  if (cfg.provider === '46elks') return !!cfg.realtimeBridgeNumber;
  return cfg.provider === 'twilio';
}

function voiceProviderConfigured(provider: VoiceProvider, config: AgenticMailConfig): {
  configured: boolean;
  sources: { legacyConfig: boolean; voiceProviderKeys: boolean; env: boolean };
} {
  const legacyConfig = provider.apiKeyConfigField
    ? !!requestString((config as any)[provider.apiKeyConfigField])
    : false;
  const voiceProviderKeys = !!requestString(config.voiceProviderKeys?.[provider.id]);
  const env = !!requestString(process.env[provider.apiKeyEnvVar]);
  return {
    configured: legacyConfig || voiceProviderKeys || env,
    sources: { legacyConfig, voiceProviderKeys, env },
  };
}

function redactEndpoint(endpoint?: string): string | undefined {
  const raw = requestString(endpoint);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|secret|key|auth|password/i.test(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return raw.replace(/(token|secret|key|auth|password)=([^&\s]+)/gi, '$1=***');
  }
}

interface HostBridgeHealth {
  checked: boolean;
  reachable: boolean;
  healthUrl?: string;
  status?: number;
  error?: string;
}

function hostBridgeHealthUrl(endpoint?: string): string | undefined {
  const raw = requestString(endpoint);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.pathname = '/health';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function checkHostBridgeHealth(endpoint?: string): Promise<HostBridgeHealth> {
  const healthUrl = hostBridgeHealthUrl(endpoint);
  if (!healthUrl) return { checked: false, reachable: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    return {
      checked: true,
      reachable: res.ok,
      healthUrl,
      status: res.status,
    };
  } catch (err) {
    return {
      checked: true,
      reachable: false,
      healthUrl,
      error: (err as Error).name === 'AbortError' ? 'timeout' : ((err as Error).message || 'unreachable'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildPhoneReadiness(
  cfg: PhoneTransportConfig | null,
  config: AgenticMailConfig,
  requestedRuntime?: string,
): Promise<Record<string, unknown>> {
  const defaultRuntime = (config.voiceRuntime && config.voiceRuntime.trim()) || 'openai';
  const voiceRuntime = requestString(requestedRuntime) || defaultRuntime;
  const providers = listVoiceProviders();
  const provider = providers.find((item) => item.id === voiceRuntime);
  const providerKeys = provider ? voiceProviderConfigured(provider, config) : null;
  const providerKeyRequired = provider?.apiKeyRequired !== false;
  const hostBridgeEndpoint = requestString(config.voiceHostBridge?.url);
  const hostBridgeTokenConfigured = !!requestString(config.voiceHostBridge?.token)
    || !!requestString(process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN);
  const hostBridgeConfigured = voiceRuntime === 'host_bridge' && !!hostBridgeEndpoint;
  const hostBridgeHealth = hostBridgeConfigured
    ? await checkHostBridgeHealth(hostBridgeEndpoint)
    : { checked: false, reachable: false } satisfies HostBridgeHealth;
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!cfg) {
    missing.push('phone transport');
  } else {
    if (!cfg.capabilities.includes('call_control')) missing.push('phone transport with call_control');
    if (!cfg.capabilities.includes('realtime_media')) missing.push('phone transport with realtime_media');
    if (cfg.provider === '46elks' && !cfg.realtimeBridgeNumber) missing.push('46elks realtimeBridgeNumber');
    if (!cfg.webhookBaseUrl.startsWith('https://')) warnings.push('webhookBaseUrl should be public HTTPS for provider callbacks');
  }
  if (!provider) {
    missing.push(`known voice runtime provider "${voiceRuntime}"`);
  } else if (voiceRuntime === 'host_bridge') {
    if (!hostBridgeEndpoint) missing.push('AGENTICMAIL_VOICE_HOST_BRIDGE_URL or voiceHostBridge.url');
    else if (!hostBridgeHealth.reachable) missing.push('reachable voice host bridge health endpoint');
  } else if (providerKeyRequired && !providerKeys?.configured) {
    missing.push(`${provider.apiKeyEnvVar} or voiceProviderKeys.${provider.id}`);
  }

  const canPlaceTrackedCalls = !!cfg && cfg.capabilities.includes('call_control');
  const realtimeTransportReady = phoneRealtimeReady(cfg);
  const runtimeReady = voiceRuntime === 'host_bridge' ? hostBridgeConfigured && hostBridgeHealth.reachable : !!providerKeys?.configured;
  const canHoldRealtimeConversation = canPlaceTrackedCalls && realtimeTransportReady && runtimeReady;
  const testRegionAllowlist = cfg?.supportedRegions?.length ? cfg.supportedRegions : ['WORLD'];
  const runtimeSetupAction = voiceRuntime === 'host_bridge'
    ? 'Configure AGENTICMAIL_VOICE_HOST_BRIDGE_URL or voiceHostBridge.url for an OpenClaw/CLI-owned realtime websocket.'
    : provider
      ? `Configure ${provider.apiKeyEnvVar} or voiceProviderKeys.${provider.id} for the selected voice runtime.`
      : 'Select a registered voice runtime such as "openai" or "grok".';
  return {
    ready: canHoldRealtimeConversation,
    canPlaceTrackedCalls,
    canHoldRealtimeConversation,
    voiceRuntimeMode: voiceRuntime === 'host_bridge' ? 'host_bridge' : 'embedded_realtime',
    missing,
    warnings,
    transport: cfg ? redactPhoneTransportConfig(cfg) : null,
    voiceRuntime: provider ? {
      id: provider.id,
      displayName: provider.displayName,
      defaultModel: provider.defaultModel,
      apiKeyEnvVar: provider.apiKeyEnvVar,
      keyRequiredInAgenticMail: providerKeyRequired,
      keyConfigured: providerKeyRequired ? (providerKeys?.configured ?? false) : hostBridgeTokenConfigured,
      keySources: providerKeys?.sources,
      defaultVoice: provider.defaultVoice,
      configuredVoice: requestString(config.voiceProviderVoices?.[provider.id]) || undefined,
      customVoicesSupported: !!provider.customVoicesSupported,
    } : { id: voiceRuntime, keyConfigured: false },
    hostBridge: voiceRuntime === 'host_bridge'
      ? {
          configured: hostBridgeConfigured,
          endpoint: redactEndpoint(hostBridgeEndpoint),
          reachable: hostBridgeHealth.reachable,
          healthUrl: redactEndpoint(hostBridgeHealth.healthUrl),
          healthStatus: hostBridgeHealth.status,
          healthError: hostBridgeHealth.error,
          tokenConfigured: hostBridgeTokenConfigured,
          wireProtocol: 'openai_realtime_compatible_websocket',
        }
      : undefined,
    nextActions: canHoldRealtimeConversation
      ? [
          'Start a real test call with agenticmail_call_phone_safe / call_phone_safe.',
          'Use policyPreset "safe_default" or "reservation"; keep dryRun false for a real call.',
          'Use agenticmail_conversation_context or agenticmail_call_transcript to inspect the live call ledger.',
        ]
      : [
          'Run agenticmail_phone_transport_setup with provider credentials, public webhookBaseUrl, webhookSecret, capabilities ["call_control","realtime_media"], and supportedRegions.',
          'For 46elks realtime, also set realtimeBridgeNumber to your 46elks websocket-number.',
          runtimeSetupAction,
          voiceRuntime === 'host_bridge'
            ? 'Start the local bridge with agenticmail-voice-host-bridge or the OpenClaw/Codex/Claude Code/Hermes wrapper bin.'
            : undefined,
          'Run agenticmail_phone_readiness again until ready=true.',
        ].filter(Boolean),
    testCallTemplate: {
      tool: 'agenticmail_call_phone_safe',
      mcpTool: 'call_phone_safe',
      params: {
        to: '+43123456789',
        task: 'Say hello, confirm you can hear the other party, then end the call.',
        policyPreset: 'safe_default',
        regionAllowlist: testRegionAllowlist,
        maxCostPerMission: 1,
        maxCallDurationSeconds: 180,
        dryRun: false,
      },
    },
  };
}

function phoneSetupNextSteps(cfg: ReturnType<PhoneManager['getPhoneTransportConfig']>): string[] {
  const steps = [
    'Phone transport is configured for call_control.',
    'Calls can now be started with /calls/start or the phone tool surface.',
  ];
  if (!cfg?.capabilities.includes('realtime_media')) {
    steps.push('Realtime media is not enabled on this transport config.');
    return steps;
  }
  if (cfg.provider === 'twilio') {
    steps.push('Twilio calls will stream through the realtime voice WebSocket when OPENAI_API_KEY is configured.');
    return steps;
  }
  if (cfg.provider === '46elks' && cfg.realtimeBridgeNumber) {
    steps.push('46elks outbound calls will connect to the configured realtimeBridgeNumber.');
    steps.push('Configure that 46elks websocket-number voice_start to wss://<your-host>/api/agenticmail/calls/realtime?token=<webhookSecret>.');
    return steps;
  }
  steps.push('For 46elks realtime outbound calls, set realtimeBridgeNumber to your 46elks websocket-number.');
  return steps;
}

function closePhoneConversationForMission(
  conversations: ConversationSessionManager,
  mission: PhoneCallMission,
  reason: string,
): void {
  const session = conversations.findActiveSessionByExternalRef(mission.agentId, 'phone', mission.id);
  if (!session) return;
  conversations.recordTranscriptMessage({
    sessionId: session.id,
    agentId: mission.agentId,
    direction: 'system',
    text: `Phone mission ${mission.id} ${reason}.`,
    metadata: {
      missionId: mission.id,
      status: mission.status,
      reason,
    },
  });
  conversations.endSession(
    mission.agentId,
    session.id,
    mission.status === 'failed' ? 'failed' : 'ended',
  );
}

export function createPhoneWebhookRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const conversations = new ConversationSessionManager(db as any);

  // Webhook routes are mounted before bearer auth (the provider must
  // reach them). A missing/unknown missionId or a bad token all funnel
  // into a single uniform 403 via PhoneWebhookAuthError — no early
  // missionId branch, so there is no 404-vs-403 enumeration oracle.
  router.post('/calls/webhook/46elks/voice-start', (req: Request, res: Response) => {
    try {
      const result = phoneManager.handleVoiceStartWebhook(
        readMissionId(req), readWebhookToken(req), req.body ?? {},
      );
      res.json(result.action);
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/webhook/46elks/hangup', (req: Request, res: Response) => {
    try {
      const mission = phoneManager.handleHangupWebhook(
        readMissionId(req), readWebhookToken(req), req.body ?? {},
      );
      closePhoneConversationForMission(conversations, mission, 'ended by 46elks hangup');
      res.json({ success: true, mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  // ─── Twilio webhooks ────────────────────────────────────────────
  //
  // Twilio POSTs `application/x-www-form-urlencoded` (not JSON), so
  // these routes carry their own `urlencoded` body parser. Two auth
  // gates run in series, both fail-closed:
  //   1. The per-mission HMAC token (#43-H7) on the URL — same gate the
  //      46elks webhooks use; resolves + authenticates the mission and
  //      funnels every failure into a uniform 403 (no enumeration
  //      oracle, #43-H3).
  //   2. The `X-Twilio-Signature` header — HMAC-SHA1 over the request
  //      URL + sorted POST params, keyed by the Twilio auth token.
  //      Validated timing-safe; a missing/forged signature is the SAME
  //      uniform 403.
  // The signature check needs the resolved mission's auth token, so it
  // runs after token auth resolves the mission.
  const twilioBody = urlencoded({ extended: false });

  /**
   * Resolve + fully authenticate a Twilio webhook: the per-mission
   * token, then the `X-Twilio-Signature`. Throws {@link PhoneWebhookAuthError}
   * for ANY failure so the responder maps it to a uniform 403.
   */
  function authenticateTwilioWebhook(req: Request): { missionId: string; token: string } {
    const missionId = readMissionId(req);
    const token = readWebhookToken(req);
    // Resolve the mission's transport so we can verify the Twilio
    // signature. getMission/getPhoneTransportConfig failing all collapse
    // into the same uniform auth error the manager throws.
    const mission = missionId ? phoneManager.getMission(missionId) : null;
    const transport = mission ? phoneManager.getPhoneTransportConfig(mission.agentId) : null;
    if (!mission || !transport || transport.provider !== 'twilio') {
      throw new PhoneWebhookAuthError();
    }
    const signature = requestString(req.get('x-twilio-signature'));
    const ok = validateTwilioSignature(
      transport.password,
      twilioRequestUrl(req, transport.webhookBaseUrl),
      twilioFormParams(req),
      signature,
    );
    if (!ok) throw new PhoneWebhookAuthError();
    // The manager re-checks the per-mission token itself; pass it on.
    return { missionId, token };
  }

  router.post('/calls/webhook/twilio/voice', twilioBody, (req: Request, res: Response) => {
    try {
      const { missionId, token } = authenticateTwilioWebhook(req);
      const result = phoneManager.handleTwilioVoiceWebhook(missionId, token, req.body ?? {});
      // Twilio expects a TwiML (XML) document back, not JSON.
      res.type('text/xml').send(result.twiml);
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/webhook/twilio/status', twilioBody, (req: Request, res: Response) => {
    try {
      const { missionId, token } = authenticateTwilioWebhook(req);
      const mission = phoneManager.handleTwilioStatusWebhook(missionId, token, req.body ?? {});
      closePhoneConversationForMission(conversations, mission, 'ended by Twilio status webhook');
      res.json({ success: true, mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  return router;
}

export function createPhoneRoutes(
  db: ReturnType<typeof import('@agenticmail/core').getDatabase>,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const conversations = new ConversationSessionManager(db as any);

  router.get('/phone/transport/config', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        transport: cfg ? redactPhoneTransportConfig(cfg) : null,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/phone/transport/setup', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      // Partial-update support — `setup-phone` re-runs that only
      // change e.g. the phone number shouldn't require the user to
      // re-paste the auth token. If a transport config already
      // exists for this agent, merge the incoming body OVER the
      // current values: any field omitted (or sent as empty string /
      // null / undefined) inherits the existing encrypted-at-rest
      // value. Twilio aliases (`accountSid` / `authToken`) are
      // normalised against the canonical `username` / `password`
      // pair so a body using either spelling overrides cleanly.
      const existing = phoneManager.getPhoneTransportConfig(agent.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = existing ? { ...existing } : {};
      if (body.accountSid && !body.username) body.username = body.accountSid;
      if (body.authToken && !body.password) body.password = body.authToken;
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.length === 0) continue;
        merged[k] = v;
      }
      const cfg = buildPhoneTransportConfig(merged);
      phoneManager.savePhoneTransportConfig(agent.id, cfg);
      res.json({
        success: true,
        transport: redactPhoneTransportConfig(cfg),
        nextSteps: phoneSetupNextSteps(cfg),
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/phone/capabilities', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json({
        configured: !!cfg,
        provider: cfg?.provider ?? null,
        phoneNumber: cfg?.phoneNumber ?? null,
        capabilities: cfg?.capabilities ?? [],
        supportedRegions: cfg?.supportedRegions ?? [],
        realtimeBridgeNumber: cfg?.realtimeBridgeNumber ?? null,
        realtimeBridgeConfigured: cfg?.provider === '46elks'
          ? !!cfg?.realtimeBridgeNumber
          : !!cfg?.capabilities.includes('realtime_media'),
        realtimeReady: phoneRealtimeReady(cfg),
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/phone/readiness', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const cfg = phoneManager.getPhoneTransportConfig(agent.id);
      res.json(await buildPhoneReadiness(cfg, config, requestString(req.query.voiceRuntime)));
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/phone/voice/providers', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const defaultRuntime = (config.voiceRuntime && config.voiceRuntime.trim()) || 'openai';
      const providers = listVoiceProviders().map((provider) => {
        const keyState = voiceProviderConfigured(provider, config);
        const configuredVoice = requestString(config.voiceProviderVoices?.[provider.id]) || undefined;
        const isHostBridge = provider.id === 'host_bridge';
        return {
          id: provider.id,
          displayName: provider.displayName,
          description: provider.description,
          websocketBaseUrl: isHostBridge
            ? redactEndpoint(provider.resolveWebsocketBaseUrl?.(config))
            : provider.websocketBaseUrl,
          defaultModel: provider.defaultModel,
          apiKeyEnvVar: provider.apiKeyEnvVar,
          keyRequiredInAgenticMail: provider.apiKeyRequired !== false,
          keyConfigured: provider.apiKeyRequired === false
            ? !!requestString(config.voiceHostBridge?.token)
              || !!requestString(process.env.AGENTICMAIL_VOICE_HOST_BRIDGE_TOKEN)
            : keyState.configured,
          keySources: keyState.sources,
          voices: provider.voices,
          defaultVoice: provider.defaultVoice,
          configuredVoice,
          customVoicesSupported: !!provider.customVoicesSupported,
          selectedDefault: provider.id === defaultRuntime,
        };
      });
      res.json({ providers, defaultRuntime });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/start', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;
      const policy = resolvePhoneMissionPolicy(req.body);
      const policyPreset = requestPhonePolicyPreset(req.body);

      const result = await phoneManager.startMission(agent.id, {
        to: req.body?.to,
        task: req.body?.task,
        policy: policy as any,
        voiceRuntimeRef: req.body?.voiceRuntimeRef,
      }, {
        dryRun: req.body?.dryRun === true,
      });
      const conversationSession = conversations.createSession({
        agentId: agent.id,
        channel: 'phone',
        peer: result.mission.to,
        subject: requestString(req.body?.subject) || undefined,
        goal: result.mission.task,
        externalRef: result.mission.id,
        metadata: {
          transport: 'phone',
          missionId: result.mission.id,
          provider: result.mission.provider,
          dryRun: req.body?.dryRun === true,
          policyPreset,
        },
      });
      const conversationMessage = conversations.recordMessage({
        sessionId: conversationSession.id,
        agentId: agent.id,
        channel: 'phone',
        direction: 'system',
        text: `Phone mission ${result.mission.id} started for ${result.mission.to}.`,
        metadata: { missionId: result.mission.id, status: result.mission.status },
      });

      res.json({
        success: true,
        mission: result.mission,
        conversationSession,
        conversationMessage,
        // Redact every token-bearing webhook URL in the echoed request,
        // provider-agnostically: 46elks uses `voice_start`/`whenhangup`,
        // Twilio uses `Url`/`StatusCallback`.
        providerRequest: result.providerRequest
          ? { ...result.providerRequest, body: redactWebhookBody(result.providerRequest.body) }
          : undefined,
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const status = requestString(req.query.status) as PhoneMissionState;
      const missions = phoneManager.listMissions(agent.id, { limit, offset, status });
      res.json({ missions, count: missions.length });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls/:id', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({
        mission,
        conversationSession: conversations.findSessionByExternalRef(agent.id, 'phone', mission.id),
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.get('/calls/:id/transcript', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({ missionId: mission.id, transcript: mission.transcript });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  // ─── Operator-query endpoints (ask_operator, plan §5) ───────────
  //
  // Channel-agnostic: the bridge's `ask_operator` tool records a query
  // on the mission and polls it; ANY channel can answer it through the
  // POST endpoint below. The agenticmail product ships the email
  // notifier + this HTTP surface; a host (e.g. Fola's Telegram bridge)
  // can watch the GET endpoint and POST the operator's reply here.
  // Both endpoints are agent-key scoped — an agent only ever sees and
  // answers its own missions' queries.

  router.get('/calls/:id/operator-queries', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.getMission(req.params.id, agent.id);
      if (!mission) return res.status(404).json({ error: 'Phone mission not found' });
      res.json({
        missionId: mission.id,
        operatorQueries: phoneManager.listOperatorQueries(mission.id, agent.id),
        callbackPending: mission.metadata.callbackPending === true,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/:id/operator-queries/:queryId/answer', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const answer = requestString(req.body?.answer);
      if (!answer) return res.status(400).json({ error: 'answer is required' });

      const result = phoneManager.answerOperatorQuery(
        req.params.id, req.params.queryId, answer, { via: 'api', agentId: agent.id },
      );
      if (!result) return res.status(404).json({ error: 'Operator query not found' });

      // The answer may unblock a callback-on-disconnect (plan §7). This
      // is best-effort: a failed callback dial (e.g. a rate limit) must
      // not fail the answer submission itself — the answer is recorded.
      let callback: { triggered: boolean; missionId?: string; error?: string } = { triggered: false };
      try {
        const fired = await phoneManager.triggerCallback(req.params.id);
        if (fired) callback = { triggered: true, missionId: fired.callbackMission.id };
      } catch (err) {
        callback = { triggered: false, error: (err as Error)?.message ?? String(err) };
      }

      res.json({
        success: true,
        alreadyAnswered: result.alreadyAnswered,
        query: result.query,
        callback,
      });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  router.post('/calls/:id/cancel', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const mission = phoneManager.cancelMission(agent.id, req.params.id);
      closePhoneConversationForMission(conversations, mission, 'cancelled by operator');
      res.json({ success: true, mission });
    } catch (err) {
      sendPhoneError(res, err);
    }
  });

  return router;
}
