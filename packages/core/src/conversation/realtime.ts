export const REALTIME_CONVERSATION_CHANNELS = [
  'phone',
  'telegram',
  'matrix',
  'whatsapp',
  'google_meet',
] as const;

export type RealtimeConversationChannel = typeof REALTIME_CONVERSATION_CHANNELS[number];

export type RealtimeConversationStatus = 'available' | 'planned';

export type RealtimeConversationMode =
  | 'duplex_audio'
  | 'near_realtime_text'
  | 'meeting_av';

export interface RealtimeConversationCapability {
  channel: RealtimeConversationChannel;
  displayName: string;
  status: RealtimeConversationStatus;
  mode: RealtimeConversationMode;
  supportsOutboundStart: boolean;
  supportsInboundStart: boolean;
  supportsToolLoop: boolean;
  supportsOperatorEscalation: boolean;
  supportsTranscript: boolean;
  requiresOptIn: boolean;
  requiredRuntime: string[];
  notes: string[];
}

export interface RealtimeConversationStartContext {
  channel: string;
  voiceRuntimeConfigured?: boolean;
  openaiRealtimeConfigured?: boolean;
  transportConfigured?: boolean;
  realtimeMediaConfigured?: boolean;
  policyProvided?: boolean;
  operatorApproved?: boolean;
  userOptedIn?: boolean;
}

export interface RealtimeConversationStartPlan {
  ok: boolean;
  channel?: RealtimeConversationChannel;
  status?: RealtimeConversationStatus;
  mode?: RealtimeConversationMode;
  missing: string[];
  reason: string;
}

const CAPABILITIES: Record<RealtimeConversationChannel, RealtimeConversationCapability> = {
  phone: {
    channel: 'phone',
    displayName: 'Phone call',
    status: 'available',
    mode: 'duplex_audio',
    supportsOutboundStart: true,
    supportsInboundStart: true,
    supportsToolLoop: true,
    supportsOperatorEscalation: true,
    supportsTranscript: true,
    requiresOptIn: false,
    requiredRuntime: [
      'phone transport with realtime_media',
      'embedded realtime provider key or host_bridge websocket',
      'per-mission call policy',
    ],
    notes: [
      'Current executable path: phone mission -> carrier media stream -> RealtimeVoiceBridge.',
      'AgenticMail owns transport, mission state, transcript, callbacks, and policy enforcement.',
    ],
  },
  telegram: {
    channel: 'telegram',
    displayName: 'Telegram',
    status: 'available',
    mode: 'near_realtime_text',
    supportsOutboundStart: true,
    supportsInboundStart: true,
    supportsToolLoop: true,
    supportsOperatorEscalation: true,
    supportsTranscript: true,
    requiresOptIn: true,
    requiredRuntime: [
      'Telegram bot token',
      'linked operator or allowed chat',
    ],
    notes: [
      'Telegram is already a message channel and operator escalation path.',
      'It is not an audio realtime transport; agent replies are text turns via Telegram tools.',
    ],
  },
  matrix: {
    channel: 'matrix',
    displayName: 'Matrix',
    status: 'available',
    mode: 'near_realtime_text',
    supportsOutboundStart: true,
    supportsInboundStart: true,
    supportsToolLoop: true,
    supportsOperatorEscalation: true,
    supportsTranscript: true,
    requiresOptIn: true,
    requiredRuntime: [
      'Matrix homeserver credentials',
      'room membership or invite flow',
      'message event bridge',
    ],
    notes: [
      'Executable text adapter: AgenticMail sends m.room.message events and polls /sync for allowed rooms.',
      'Encrypted Matrix rooms require a separate E2EE-capable bot runtime and are not handled by this adapter.',
    ],
  },
  whatsapp: {
    channel: 'whatsapp',
    displayName: 'WhatsApp',
    status: 'planned',
    mode: 'near_realtime_text',
    supportsOutboundStart: true,
    supportsInboundStart: true,
    supportsToolLoop: true,
    supportsOperatorEscalation: true,
    supportsTranscript: true,
    requiresOptIn: true,
    requiredRuntime: [
      'WhatsApp Business provider',
      'user opt-in',
      'template or session-window policy',
      'message event bridge',
    ],
    notes: [
      'WhatsApp must stay opt-in and template/session-window aware; do not model it as free-form SMS.',
    ],
  },
  google_meet: {
    channel: 'google_meet',
    displayName: 'Google Meet',
    status: 'planned',
    mode: 'meeting_av',
    supportsOutboundStart: true,
    supportsInboundStart: true,
    supportsToolLoop: true,
    supportsOperatorEscalation: true,
    supportsTranscript: true,
    requiresOptIn: true,
    requiredRuntime: [
      'meeting link intake or calendar/space authority',
      'meeting bot runtime',
      'audio capture/playback bridge',
      'participant consent policy',
    ],
    notes: [
      'Google Meet is a meeting runtime, not a phone carrier. Target flow: an operator sends a Meet link plus topic, the agent prepares from context, joins as a named participant, listens, records notes, and only speaks when addressed or operator-directed.',
    ],
  },
};

export function isRealtimeConversationChannel(value: unknown): value is RealtimeConversationChannel {
  return typeof value === 'string'
    && (REALTIME_CONVERSATION_CHANNELS as readonly string[]).includes(value);
}

function copyCapability(capability: RealtimeConversationCapability): RealtimeConversationCapability {
  return {
    ...capability,
    requiredRuntime: [...capability.requiredRuntime],
    notes: [...capability.notes],
  };
}

export function listRealtimeConversationCapabilities(): RealtimeConversationCapability[] {
  return REALTIME_CONVERSATION_CHANNELS.map((channel) => copyCapability(CAPABILITIES[channel]));
}

export function getRealtimeConversationCapability(
  channel: RealtimeConversationChannel,
): RealtimeConversationCapability {
  return copyCapability(CAPABILITIES[channel]);
}

export function planRealtimeConversationStart(
  context: RealtimeConversationStartContext,
): RealtimeConversationStartPlan {
  if (!isRealtimeConversationChannel(context.channel)) {
    return {
      ok: false,
      missing: ['supported realtime conversation channel'],
      reason: `Unsupported realtime conversation channel: ${context.channel || '(missing)'}`,
    };
  }

  const capability = CAPABILITIES[context.channel];
  const missing: string[] = [];

  if (capability.status !== 'available') {
    missing.push(
      context.channel === 'google_meet'
        ? 'Google Meet live media runtime'
        : `${capability.displayName} adapter implementation`,
    );
  }

  if (capability.requiresOptIn && !context.userOptedIn) {
    missing.push('user opt-in');
  }

  if (!context.transportConfigured) {
    missing.push(`${capability.displayName} transport configuration`);
  }

  if (capability.mode === 'duplex_audio') {
    if (!context.realtimeMediaConfigured) missing.push('realtime media transport');
    if (!(context.voiceRuntimeConfigured || context.openaiRealtimeConfigured)) {
      missing.push('realtime voice runtime');
    }
    if (!context.policyProvided) missing.push('per-mission policy');
  }

  if (context.channel === 'whatsapp' && !context.operatorApproved) {
    missing.push('WhatsApp template/session-window approval');
  }

  if (context.channel === 'google_meet' && !context.operatorApproved) {
    missing.push('operator approval to join or create a meeting');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      channel: capability.channel,
      status: capability.status,
      mode: capability.mode,
      missing,
      reason: `${capability.displayName} realtime conversation is not ready: ${missing.join(', ')}`,
    };
  }

  return {
    ok: true,
    channel: capability.channel,
    status: capability.status,
    mode: capability.mode,
    missing: [],
    reason: `${capability.displayName} realtime conversation can start.`,
  };
}
