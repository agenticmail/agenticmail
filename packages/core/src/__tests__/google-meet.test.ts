import { describe, expect, it } from 'vitest';
import {
  buildGoogleMeetSessionBriefing,
  normalizeGoogleMeetBehaviorMode,
  parseGoogleMeetLink,
} from '../conversation/index.js';

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
});
