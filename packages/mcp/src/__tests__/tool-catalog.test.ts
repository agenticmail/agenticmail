/**
 * Catalogue ↔ tool-definition consistency tests.
 *
 * These are the only tests this package needs — most of the MCP server is
 * data-shaped (100 tool wrappers around HTTP calls). What CAN silently rot
 * is the link between:
 *
 *   1. The catalogue in tool-catalog.ts (what request_tools advertises).
 *   2. The actual tool definitions in tools.ts (what invoke can dispatch to).
 *
 * If a tool gets added to tools.ts but not to a set, request_tools won't
 * surface it — agents that don't already know its name will never reach it.
 * If a tool gets removed but the catalogue still lists it, agents will get
 * confused by an "Unknown tool" error after a clean `invoke`.
 *
 * This test files locks both directions in.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_SETS, SET_DESCRIPTIONS, TOOL_TO_SET, type ToolSetName } from '../tool-catalog.js';
import { toolDefinitions } from '../tools.js';

const META_TOOLS = new Set(['request_tools', 'invoke']);

describe('tool catalogue ↔ tool definitions', () => {
  const definedNames = new Set(toolDefinitions.map(t => t.name));
  const catalogNames = new Set<string>();
  for (const tools of Object.values(TOOL_SETS)) for (const t of tools) catalogNames.add(t);

  it('every real tool (excluding meta) is in exactly one set', () => {
    const realTools = [...definedNames].filter(n => !META_TOOLS.has(n));
    const missing: string[] = [];
    for (const name of realTools) if (!catalogNames.has(name)) missing.push(name);
    expect(missing, `Tools in tools.ts but missing from catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('every catalogued tool exists in tools.ts', () => {
    const phantoms: string[] = [];
    for (const name of catalogNames) if (!definedNames.has(name)) phantoms.push(name);
    expect(phantoms, `Tools in catalog but not defined in tools.ts: ${phantoms.join(', ')}`).toEqual([]);
  });

  it('no tool appears in more than one set', () => {
    const seen = new Map<string, ToolSetName>();
    const dupes: string[] = [];
    for (const [setName, tools] of Object.entries(TOOL_SETS)) {
      for (const tool of tools) {
        if (seen.has(tool)) {
          dupes.push(`${tool} is in both "${seen.get(tool)}" and "${setName}"`);
        } else {
          seen.set(tool, setName as ToolSetName);
        }
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every set in TOOL_SETS has a description', () => {
    const setNames = Object.keys(TOOL_SETS) as ToolSetName[];
    const missing = setNames.filter(s => !SET_DESCRIPTIONS[s]);
    expect(missing, `Sets missing from SET_DESCRIPTIONS: ${missing.join(', ')}`).toEqual([]);
  });

  it('every description has a corresponding set', () => {
    const descNames = Object.keys(SET_DESCRIPTIONS) as ToolSetName[];
    const phantom = descNames.filter(s => !TOOL_SETS[s]);
    expect(phantom, `SET_DESCRIPTIONS keys with no TOOL_SETS entry: ${phantom.join(', ')}`).toEqual([]);
  });

  it('TOOL_TO_SET reverse index is consistent with TOOL_SETS', () => {
    for (const [setName, tools] of Object.entries(TOOL_SETS)) {
      for (const tool of tools) {
        expect(TOOL_TO_SET[tool]).toBe(setName);
      }
    }
  });

  it('essential set includes call_agent (the headline coordination primitive)', () => {
    expect(TOOL_SETS.essential).toContain('call_agent');
  });

  it('phone set exposes the call-control mission surface', () => {
    expect(TOOL_SETS.phone).toEqual([
      'phone_transport_setup',
      'phone_capabilities',
      'call_phone',
      'call_status',
      'call_transcript',
      'call_cancel',
      // v0.9.97 — operator-query inspection + injection for live calls.
      'call_open_queries',
      'call_answer_query',
    ]);
  });

  it('telegram set exposes the Telegram channel surface', () => {
    expect(TOOL_SETS.telegram).toEqual([
      'telegram_setup',
      'telegram_config',
      'telegram_send',
      'telegram_messages',
      'telegram_poll',
    ]);
  });

  it('realtime set exposes channel-neutral conversation readiness tools', () => {
    expect(TOOL_SETS.realtime).toEqual([
      'realtime_conversation_capabilities',
      'realtime_conversation_plan',
      'conversation_list',
      'conversation_get',
      'conversation_start',
      'conversation_send',
      'conversation_messages',
      'conversation_end',
    ]);
  });

  it('media set exposes the media toolset surface', () => {
    expect(TOOL_SETS.media).toEqual([
      'media_capabilities',
      'media_tts',
      'media_tts_voices',
      'media_image_edit',
      'media_video_edit',
      'media_audio_edit',
      'media_info',
      'media_video_understand',
      'media_voice_clone',
    ]);
  });

  it('phone_transport_setup advertises both 46elks and twilio providers', () => {
    const tool = toolDefinitions.find(t => t.name === 'phone_transport_setup');
    expect(tool, 'phone_transport_setup must be defined').toBeTruthy();
    const provider = (tool!.inputSchema.properties as Record<string, any>).provider;
    expect(provider?.enum).toEqual(['46elks', 'twilio']);
    // Twilio credential aliases must be exposed so an agent can set up
    // Twilio without overloading the generic username/password fields.
    expect((tool!.inputSchema.properties as Record<string, any>).accountSid).toBeTruthy();
    expect((tool!.inputSchema.properties as Record<string, any>).authToken).toBeTruthy();
    expect((tool!.inputSchema.properties as Record<string, any>).realtimeBridgeNumber).toBeTruthy();
  });

  it('total catalogued tool count matches the real tool count minus meta-tools', () => {
    const realToolCount = [...definedNames].filter(n => !META_TOOLS.has(n)).length;
    expect(catalogNames.size).toBe(realToolCount);
  });
});
