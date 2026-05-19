import { describe, expect, it } from 'vitest';
import {
  RealtimeVoiceBridge,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  buildOpenAIRealtimeUrl,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  type RealtimeBridgePort,
} from '../phone/realtime-bridge.js';

/** A fake bridge port that records every message + whether it was closed. */
class FakePort implements RealtimeBridgePort {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(message: Record<string, unknown>): void { this.sent.push(message); }
  close(): void { this.closed = true; }
  /** Messages of a given `t` (46elks) or `type` (OpenAI). */
  ofKind(kind: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.t === kind || m.type === kind);
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

function helloFrame() {
  return { t: 'hello', callid: 'call-abc', from: '+46766861234', to: '+12125550100' };
}

function makeBridge(opts: Partial<ConstructorParameters<typeof RealtimeVoiceBridge>[0]> = {}) {
  const elks = new FakePort();
  const openai = new FakePort();
  const transcript: { source: string; text: string }[] = [];
  const ends: string[] = [];
  const bridge = new RealtimeVoiceBridge({
    elks,
    openai,
    sessionConfig: buildRealtimeSessionConfig({ task: 'Book a table for two', memoryContext: '' }),
    onTranscript: (e) => transcript.push({ source: e.source, text: e.text }),
    onEnd: ({ reason }) => ends.push(reason),
    ...opts,
  });
  return { bridge, elks, openai, transcript, ends };
}

describe('buildRealtimeInstructions', () => {
  it('folds the task and memory in, framing memory as the agent’s own knowledge', () => {
    const instructions = buildRealtimeInstructions({
      task: 'Confirm the delivery window',
      memoryContext: '## Agent Memory\n### Preferences\n- **Window seats**: operator prefers them',
      agentName: 'Vesper',
    });
    expect(instructions).toContain('Your name is Vesper.');
    expect(instructions).toContain('Confirm the delivery window');
    expect(instructions).toContain('your own long-term memory');
    expect(instructions).toContain('operator prefers them');
    // Memory must not be presented as external notes.
    expect(instructions).not.toContain('the following notes');
  });

  it('omits the memory section entirely when there is no memory', () => {
    const instructions = buildRealtimeInstructions({ task: 'Say hello' });
    expect(instructions).toContain('Say hello');
    expect(instructions).not.toContain('What you already know');
  });
});

describe('buildRealtimeSessionConfig', () => {
  it('produces a GA gpt-realtime session.update with PCM16@24k audio and server VAD', () => {
    const cfg = buildRealtimeSessionConfig({ task: 'Order a pizza' }) as any;
    expect(cfg.type).toBe('session.update');
    expect(cfg.session.type).toBe('realtime');
    expect(cfg.session.model).toBe(DEFAULT_REALTIME_MODEL);
    expect(cfg.session.output_modalities).toEqual(['audio']);
    expect(cfg.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(cfg.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(cfg.session.audio.input.turn_detection).toEqual({ type: 'server_vad' });
    expect(cfg.session.audio.output.voice).toBe(DEFAULT_REALTIME_VOICE);
    expect(cfg.session.instructions).toContain('Order a pizza');
  });

  it('honours voice / model overrides and an explicit instructions string', () => {
    const cfg = buildRealtimeSessionConfig({
      task: 't', voice: 'cedar', model: 'gpt-realtime-2', instructions: 'Be terse.',
    }) as any;
    expect(cfg.session.model).toBe('gpt-realtime-2');
    expect(cfg.session.audio.output.voice).toBe('cedar');
    expect(cfg.session.instructions).toBe('Be terse.');
  });
});

describe('buildOpenAIRealtimeUrl', () => {
  it('builds the realtime URL with the model query param', () => {
    expect(buildOpenAIRealtimeUrl()).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(buildOpenAIRealtimeUrl('gpt-realtime-2')).toContain('?model=gpt-realtime-2');
  });
});

describe('RealtimeVoiceBridge — 46elks → OpenAI', () => {
  it('handshakes 46elks and forwards the session config + buffered audio on OpenAI open', () => {
    const { bridge, elks, openai } = makeBridge();

    bridge.handleElksMessage(helloFrame());
    // 46elks gets a listening + sending handshake at pcm_24000.
    expect(elks.ofKind('listening')[0]).toEqual({ t: 'listening', format: 'pcm_24000' });
    expect(elks.ofKind('sending')[0]).toEqual({ t: 'sending', format: 'pcm_24000' });
    expect(bridge.currentCallId).toBe('call-abc');

    // Audio arriving before OpenAI is ready is buffered, not lost.
    bridge.handleElksMessage({ t: 'audio', data: b64('caller speech one') });
    expect(openai.sent).toHaveLength(0);

    bridge.handleOpenAIOpen();
    // First OpenAI message is the session.update; then the buffered audio.
    expect(openai.sent[0].type).toBe('session.update');
    expect(openai.sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: b64('caller speech one') });

    // Subsequent audio is forwarded immediately.
    bridge.handleElksMessage({ t: 'audio', data: b64('caller speech two') });
    expect(openai.sent[2]).toEqual({ type: 'input_audio_buffer.append', audio: b64('caller speech two') });
  });

  it('only honours the first hello frame', () => {
    const { bridge, elks } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleElksMessage(helloFrame());
    // One handshake pair, not two.
    expect(elks.ofKind('listening')).toHaveLength(1);
  });

  it('drops an oversized inbound audio frame instead of forwarding it', () => {
    const { bridge, openai, transcript } = makeBridge({ maxAudioFrameBase64: 16 });
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    const sessionUpdates = openai.sent.length; // just the session.update
    bridge.handleElksMessage({ t: 'audio', data: b64('this audio frame is definitely too large') });
    expect(openai.sent).toHaveLength(sessionUpdates); // nothing forwarded
    expect(transcript.some((t) => t.text.includes('oversized'))).toBe(true);
  });
});

describe('RealtimeVoiceBridge — OpenAI → 46elks', () => {
  it('relays output audio deltas (GA and legacy event names) to 46elks', () => {
    const { bridge, elks } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();

    bridge.handleOpenAIMessage({ type: 'response.output_audio.delta', delta: b64('agent voice ga') });
    bridge.handleOpenAIMessage({ type: 'response.audio.delta', delta: b64('agent voice legacy') });

    const audio = elks.ofKind('audio');
    expect(audio).toHaveLength(2);
    expect(audio[0]).toEqual({ t: 'audio', data: b64('agent voice ga') });
    expect(audio[1]).toEqual({ t: 'audio', data: b64('agent voice legacy') });
  });

  it('sends a 46elks interrupt on caller barge-in', () => {
    const { bridge, elks } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIMessage({ type: 'input_audio_buffer.speech_started' });
    expect(elks.ofKind('interrupt')).toHaveLength(1);
  });

  it('accumulates the assistant transcript and flushes it on response.done', () => {
    const { bridge, transcript } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIMessage({ type: 'response.output_audio_transcript.delta', delta: 'Table ' });
    bridge.handleOpenAIMessage({ type: 'response.output_audio_transcript.delta', delta: 'for two booked.' });
    bridge.handleOpenAIMessage({ type: 'response.done' });
    const agentLine = transcript.find((t) => t.source === 'agent');
    expect(agentLine?.text).toBe('Table for two booked.');
  });

  it('records an OpenAI error frame without tearing the bridge down', () => {
    const { bridge, transcript } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIMessage({ type: 'error', error: { message: 'rate limit hit' } });
    expect(transcript.some((t) => t.text.includes('rate limit hit'))).toBe(true);
    expect(bridge.isEnded).toBe(false);
  });

  it('ignores malformed OpenAI frames', () => {
    const { bridge } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    expect(() => bridge.handleOpenAIMessage('not json')).not.toThrow();
    expect(bridge.isEnded).toBe(false);
  });
});

describe('RealtimeVoiceBridge — teardown', () => {
  it('ends on a 46elks bye: closes both sides and sends a bye to 46elks', () => {
    const { bridge, elks, openai, ends } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.handleElksMessage({ t: 'bye', reason: 'caller hung up' });

    expect(bridge.isEnded).toBe(true);
    expect(elks.ofKind('bye')).toHaveLength(1);
    expect(elks.closed).toBe(true);
    expect(openai.closed).toBe(true);
    expect(ends).toEqual(['elks-bye']);
  });

  it('end() is idempotent — onEnd fires exactly once', () => {
    const { bridge, ends } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.end('first');
    bridge.end('second');
    bridge.handleOpenAIClose();
    expect(ends).toEqual(['first']);
  });

  it('ignores all input after the bridge has ended', () => {
    const { bridge, openai } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.end('done');
    const before = openai.sent.length;
    bridge.handleElksMessage({ t: 'audio', data: b64('late audio') });
    expect(openai.sent).toHaveLength(before);
  });

  it('ends when the OpenAI socket closes', () => {
    const { bridge, ends } = makeBridge();
    bridge.handleElksMessage(helloFrame());
    bridge.handleOpenAIOpen();
    bridge.handleOpenAIClose();
    expect(bridge.isEnded).toBe(true);
    expect(ends).toEqual(['openai-closed']);
  });
});
