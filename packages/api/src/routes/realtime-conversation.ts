import { Router, type Request, type Response } from 'express';
import {
  PhoneManager,
  TelegramManager,
  GoogleMeetManager,
  getGoogleMeetReadiness,
  getRealtimeConversationCapability,
  isRealtimeConversationChannel,
  listRealtimeConversationCapabilities,
  planRealtimeConversationStart,
  type AgenticMailConfig,
} from '@agenticmail/core';

type Db = ReturnType<typeof import('@agenticmail/core').getDatabase>;

function requestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requestBool(req: Request, key: string): boolean | undefined {
  const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
  const value = body[key] ?? req.query[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return undefined;
}

function getAgent(req: Request, res: Response): { id: string; email: string } | null {
  const agent = (req as any).agent;
  if (!agent) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return agent;
}

function channelFromRequest(req: Request): string {
  const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
  return requestString(body.channel) || requestString(req.query.channel);
}

function createRealtimeConversationPlan(
  req: Request,
  agentId: string,
  config: AgenticMailConfig,
  phoneManager: PhoneManager,
  telegramManager: TelegramManager,
  googleMeetManager: GoogleMeetManager,
  channel: string,
) {
  const phone = phoneManager.getPhoneTransportConfig(agentId);
  const telegram = telegramManager.getConfig(agentId);
  const phoneRealtimeMediaConfigured = !!phone?.capabilities.includes('realtime_media')
    && (phone.provider === '46elks' ? !!phone.realtimeBridgeNumber : phone.provider === 'twilio');
  const selectedVoiceRuntime = (config.voiceRuntime && config.voiceRuntime.trim()) || 'openai';
  const hostBridgeConfigured = selectedVoiceRuntime === 'host_bridge'
    && !!requestString(config.voiceHostBridge?.url);
  const embeddedVoiceRuntimeConfigured = !!config.openaiApiKey
    || !!config.voiceProviderKeys?.[selectedVoiceRuntime]
    || !!process.env.OPENAI_API_KEY
    || (selectedVoiceRuntime === 'grok' && !!process.env.XAI_API_KEY);
  const voiceRuntimeConfigured = selectedVoiceRuntime === 'host_bridge'
    ? hostBridgeConfigured
    : embeddedVoiceRuntimeConfigured;
  const telegramLinked = !!telegram?.enabled
    && !!telegram.botToken
    && (!!telegram.operatorChatId || telegram.allowedChatIds.length > 0);
  const googleMeetReadiness = getGoogleMeetReadiness(googleMeetManager.getConfig(agentId));

  return planRealtimeConversationStart({
    channel,
    transportConfigured: requestBool(req, 'transportConfigured') ?? (
      channel === 'phone' ? !!phone
        : channel === 'telegram' ? !!telegram?.enabled && !!telegram.botToken
          : channel === 'google_meet' ? googleMeetReadiness.canReadArtifacts
          : false
    ),
    realtimeMediaConfigured: requestBool(req, 'realtimeMediaConfigured')
      ?? (channel === 'phone' ? phoneRealtimeMediaConfigured : false),
    voiceRuntimeConfigured: requestBool(req, 'voiceRuntimeConfigured')
      ?? (channel === 'phone' ? voiceRuntimeConfigured : false),
    openaiRealtimeConfigured: requestBool(req, 'openaiRealtimeConfigured') ?? !!config.openaiApiKey,
    policyProvided: requestBool(req, 'policyProvided')
      ?? !!((req.body as Record<string, unknown> | undefined)?.policy),
    operatorApproved: requestBool(req, 'operatorApproved') ?? false,
    userOptedIn: requestBool(req, 'userOptedIn') ?? (channel === 'telegram' ? telegramLinked : false),
  });
}

export function createRealtimeConversationRoutes(
  db: Db,
  config: AgenticMailConfig,
): Router {
  const router = Router();
  const phoneManager = new PhoneManager(db as any, config.masterKey);
  const telegramManager = new TelegramManager(db as any, config.masterKey);
  const googleMeetManager = new GoogleMeetManager(db as any, config.masterKey);

  router.get('/conversation/realtime/capabilities', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const channel = channelFromRequest(req);
      if (channel) {
        const plan = createRealtimeConversationPlan(req, agent.id, config, phoneManager, telegramManager, googleMeetManager, channel);
        res.json({
          capability: isRealtimeConversationChannel(channel)
            ? getRealtimeConversationCapability(channel)
            : null,
          startPlan: plan,
        });
        return;
      }

      const capabilities = listRealtimeConversationCapabilities();
      const startPlans = Object.fromEntries(capabilities.map((capability) => [
        capability.channel,
        createRealtimeConversationPlan(
          req, agent.id, config, phoneManager, telegramManager, googleMeetManager,
          capability.channel,
        ),
      ]));

      res.json({ capabilities, startPlans });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/conversation/realtime/plan', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req, res);
      if (!agent) return;

      const channel = channelFromRequest(req);
      const plan = createRealtimeConversationPlan(req, agent.id, config, phoneManager, telegramManager, googleMeetManager, channel);
      res.json({
        capability: isRealtimeConversationChannel(channel)
          ? getRealtimeConversationCapability(channel)
          : null,
        plan,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
