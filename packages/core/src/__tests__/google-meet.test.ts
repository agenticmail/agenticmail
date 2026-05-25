import { describe, expect, it } from 'vitest';
import {
  buildGoogleMeetSessionBriefing,
  normalizeGoogleMeetBehaviorMode,
  parseGoogleMeetLink,
} from '../conversation/index.js';
import {
  buildGoogleMeetConfig,
  callGoogleMeetApi,
  createGoogleMeetSpace,
  getGoogleMeetReadiness,
  redactGoogleMeetConfig,
  sendGoogleMeetLiveSidecarControl,
  startGoogleMeetLiveSidecar,
} from '../meet/index.js';

describe('Google Meet link intake', () => {
  it('parses and normalizes Meet URLs and bare meeting codes', () => {
    expect(parseGoogleMeetLink('https://meet.google.com/abc-defg-hij?authuser=0')).toEqual({
      source: 'https://meet.google.com/abc-defg-hij?authuser=0',
      meetingCode: 'abc-defg-hij',
      normalizedUrl: 'https://meet.google.com/abc-defg-hij',
    });

    expect(parseGoogleMeetLink('ABC-DEFG-HIJ')).toMatchObject({
      meetingCode: 'abc-defg-hij',
      normalizedUrl: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('rejects non-Meet URLs and malformed codes', () => {
    expect(() => parseGoogleMeetLink('https://example.com/abc-defg-hij')).toThrow(/meet.google.com/);
    expect(() => parseGoogleMeetLink('abc-defg')).toThrow(/meeting code/);
  });

  it('builds a safe first briefing without implying a live bot joined', () => {
    expect(normalizeGoogleMeetBehaviorMode('operator_directed')).toBe('operator_directed');
    expect(normalizeGoogleMeetBehaviorMode('interrupt_everyone')).toBe('answer_when_asked');

    const briefing = buildGoogleMeetSessionBriefing({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
      topic: 'Project Alpha pricing review',
      projectRef: 'project-alpha',
      behaviorMode: 'listen_only',
      operatorInstructions: 'Use OpenViking memory and speak only if asked.',
    });

    expect(briefing).toContain('topic: Project Alpha pricing review');
    expect(briefing).toContain('behavior_mode: listen_only');
    expect(briefing).toContain('live_media_status: not_joined');
    expect(briefing).toContain('Google Meet media sidecar');
  });

  it('builds redacted config and readiness gates for REST and live media', () => {
    const cfg = buildGoogleMeetConfig({
      accessToken: 'ya29.test-token',
      participantName: 'AgenticMail Assistant',
      allowedDomains: ['example.com', 'example.com'],
      defaultBehaviorMode: 'operator_directed',
      mediaApiDeveloperPreview: true,
      mediaSidecarUrl: 'http://127.0.0.1:4999/meet',
      mediaSidecarToken: 'sidecar-secret',
      consentPolicyAccepted: true,
    });

    expect(cfg.allowedDomains).toEqual(['example.com']);
    expect(cfg.defaultBehaviorMode).toBe('operator_directed');
    expect(redactGoogleMeetConfig(cfg).accessToken).toBe('***');
    expect(redactGoogleMeetConfig(cfg).mediaSidecarToken).toBe('***');
    expect(getGoogleMeetReadiness(cfg)).toMatchObject({
      configured: true,
      enabled: true,
      canCreateSpaces: true,
      canReadArtifacts: true,
      canUseLiveMedia: true,
      missing: [],
    });
  });

  it('calls the Meet REST API with bearer auth for space creation', async () => {
    const cfg = buildGoogleMeetConfig({ accessToken: 'ya29.test-token' });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ name: 'spaces/abc', meetingUri: 'https://meet.google.com/abc-defg-hij' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const space = await createGoogleMeetSpace(cfg, { accessType: 'TRUSTED' }, {
      baseUrl: 'https://meet.googleapis.test/v2',
      fetchImpl,
    });

    expect(space.meetingUri).toBe('https://meet.google.com/abc-defg-hij');
    expect(calls[0].url).toBe('https://meet.googleapis.test/v2/spaces');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer ya29.test-token');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ config: { accessType: 'TRUSTED' } });
  });

  it('surfaces Meet REST API errors with status', async () => {
    const cfg = buildGoogleMeetConfig({ accessToken: 'ya29.test-token' });
    const fetchImpl = (async () => new Response(JSON.stringify({
      error: { message: 'insufficient authentication scopes' },
    }), { status: 403 })) as typeof fetch;

    await expect(callGoogleMeetApi(cfg, 'GET', 'spaces/abc-defg-hij', undefined, { fetchImpl }))
      .rejects.toMatchObject({ status: 403, message: 'insufficient authentication scopes' });
  });

  it('starts the configured live media sidecar with meeting context', async () => {
    const cfg = buildGoogleMeetConfig({
      accessToken: 'ya29.test-token',
      mediaSidecarUrl: 'http://127.0.0.1:4999',
      mediaSidecarToken: 'sidecar-secret',
      participantName: 'AgenticMail Assistant',
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, status: 'joining', streamId: 'stream_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await startGoogleMeetLiveSidecar(cfg, {
      sessionId: 'conv_1',
      meetingUri: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
      behaviorMode: 'answer_when_asked',
    }, { fetchImpl });

    expect(result).toMatchObject({ success: true, status: 'joining', streamId: 'stream_1' });
    expect(calls[0].url).toBe('http://127.0.0.1:4999/join');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer ya29.test-token');
    expect((calls[0].init.headers as any)['X-AgenticMail-Meet-Sidecar-Token']).toBe('sidecar-secret');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      sessionId: 'conv_1',
      meetingCode: 'abc-defg-hij',
      participantName: 'AgenticMail Assistant',
      accessToken: 'ya29.test-token',
    });
  });

  it('queues live media sidecar controls without exposing the Google token in the body', async () => {
    const cfg = buildGoogleMeetConfig({
      accessToken: 'ya29.test-token',
      mediaSidecarUrl: 'http://127.0.0.1:4999',
      mediaSidecarToken: 'sidecar-secret',
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, status: 'queued', queued: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await sendGoogleMeetLiveSidecarControl(cfg, {
      sessionId: 'conv_1',
      action: 'say',
      text: 'Answer the pricing question.',
      meetingUri: 'https://meet.google.com/abc-defg-hij',
    }, { fetchImpl });

    expect(result).toMatchObject({ success: true, status: 'queued', queued: 1 });
    expect(calls[0].url).toBe('http://127.0.0.1:4999/control');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer ya29.test-token');
    expect((calls[0].init.headers as any)['X-AgenticMail-Meet-Sidecar-Token']).toBe('sidecar-secret');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      sessionId: 'conv_1',
      action: 'say',
      text: 'Answer the pricing question.',
      meetingUri: 'https://meet.google.com/abc-defg-hij',
    });
  });
});
