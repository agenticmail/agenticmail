import { describe, expect, it } from 'vitest';
import {
  getRealtimeConversationCapability,
  isRealtimeConversationChannel,
  listRealtimeConversationCapabilities,
  planRealtimeConversationStart,
} from '../conversation/index.js';

describe('realtime conversation capabilities', () => {
  it('lists the channel targets without claiming every adapter is shipped', () => {
    const channels = listRealtimeConversationCapabilities().map((cap) => cap.channel);

    expect(channels).toEqual(['phone', 'telegram', 'matrix', 'whatsapp', 'google_meet']);
    expect(getRealtimeConversationCapability('phone')).toMatchObject({
      status: 'available',
      mode: 'duplex_audio',
      supportsToolLoop: true,
    });
    expect(getRealtimeConversationCapability('matrix')).toMatchObject({
      status: 'available',
      mode: 'near_realtime_text',
      supportsTranscript: true,
    });
    expect(getRealtimeConversationCapability('whatsapp').requiresOptIn).toBe(true);
    expect(getRealtimeConversationCapability('google_meet').mode).toBe('meeting_av');
  });

  it('validates channel names fail-closed', () => {
    expect(isRealtimeConversationChannel('telegram')).toBe(true);
    expect(isRealtimeConversationChannel('discord')).toBe(false);

    expect(planRealtimeConversationStart({ channel: 'discord' })).toMatchObject({
      ok: false,
      missing: ['supported realtime conversation channel'],
    });
  });

  it('allows phone realtime only when media, voice runtime, transport, and policy are present', () => {
    const blocked = planRealtimeConversationStart({
      channel: 'phone',
      transportConfigured: true,
      realtimeMediaConfigured: false,
      voiceRuntimeConfigured: false,
      policyProvided: false,
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toEqual(expect.arrayContaining([
      'realtime media transport',
      'realtime voice runtime',
      'per-mission policy',
    ]));

    expect(planRealtimeConversationStart({
      channel: 'phone',
      transportConfigured: true,
      realtimeMediaConfigured: true,
      voiceRuntimeConfigured: true,
      policyProvided: true,
    })).toMatchObject({ ok: true, mode: 'duplex_audio' });
  });

  it('models Telegram and Matrix as available text conversations and future channels as gated', () => {
    expect(planRealtimeConversationStart({
      channel: 'telegram',
      transportConfigured: true,
      userOptedIn: true,
    })).toMatchObject({ ok: true, mode: 'near_realtime_text' });

    const matrix = planRealtimeConversationStart({
      channel: 'matrix',
      transportConfigured: true,
      userOptedIn: true,
    });
    expect(matrix).toMatchObject({ ok: true, mode: 'near_realtime_text' });

    const whatsapp = planRealtimeConversationStart({
      channel: 'whatsapp',
      transportConfigured: true,
      userOptedIn: true,
    });
    expect(whatsapp.ok).toBe(false);
    expect(whatsapp.missing).toEqual(expect.arrayContaining([
      'WhatsApp adapter implementation',
      'WhatsApp template/session-window approval',
    ]));

    const meet = planRealtimeConversationStart({
      channel: 'google_meet',
      transportConfigured: true,
      userOptedIn: true,
      operatorApproved: true,
    });
    expect(meet.ok).toBe(false);
    expect(meet.missing).toContain('Google Meet live media runtime');
  });
});
