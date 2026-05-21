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
    expect(getRealtimeConversationCapability('matrix').status).toBe('planned');
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

  it('allows phone realtime only when media, OpenAI, transport, and policy are present', () => {
    const blocked = planRealtimeConversationStart({
      channel: 'phone',
      transportConfigured: true,
      realtimeMediaConfigured: false,
      openaiRealtimeConfigured: false,
      policyProvided: false,
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toEqual(expect.arrayContaining([
      'realtime media transport',
      'OpenAI Realtime API key',
      'per-mission policy',
    ]));

    expect(planRealtimeConversationStart({
      channel: 'phone',
      transportConfigured: true,
      realtimeMediaConfigured: true,
      openaiRealtimeConfigured: true,
      policyProvided: true,
    })).toMatchObject({ ok: true, mode: 'duplex_audio' });
  });

  it('models Telegram as available text conversation and future channels as gated', () => {
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
    expect(matrix.ok).toBe(false);
    expect(matrix.missing).toContain('Matrix adapter implementation');

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
  });
});
