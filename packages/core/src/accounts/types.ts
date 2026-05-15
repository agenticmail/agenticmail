/** Predefined agent roles.
 *
 * `bridge` is the host-bridge identity — the account that represents an
 * external LLM host (Claude Code, Codex, Hermes, …) inside AgenticMail.
 * It owns its own inbox + API key like any other account but is logically
 * special: it's not a teammate the user assigns work to, it's the host
 * itself acting on behalf of itself. The web UI / list_agents / wake
 * gating SHOULD treat bridge accounts distinctly (they aren't typically
 * spawned as subagents; they don't show up in coordination team pickers
 * by default). The host-integration packages (@agenticmail/claudecode,
 * @agenticmail/codex) use this role when provisioning their bridge.
 */
export type AgentRole = 'secretary' | 'assistant' | 'researcher' | 'writer' | 'custom' | 'bridge';

export const AGENT_ROLES: readonly AgentRole[] = ['secretary', 'assistant', 'researcher', 'writer', 'custom', 'bridge'] as const;
export const DEFAULT_AGENT_ROLE: AgentRole = 'secretary';
export const DEFAULT_AGENT_NAME = 'secretary';

export interface Agent {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  stalwartPrincipal: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  role: AgentRole;
  /** Per-agent wake preference. When false, the dispatcher SKIPS
   *  this agent on every CC-only delivery regardless of the
   *  sender's `wake` list. Coder/silent-observer agents register
   *  with `wake_on_cc: false` so a designer's `cc:` accidentally
   *  including them never wastes a Claude turn. Defaults to true
   *  (preserves the 0.9.0 wake-list-respecting behaviour). */
  wakeOnCc?: boolean;
}

export interface CreateAgentOptions {
  name: string;
  domain?: string;
  password?: string;
  metadata?: Record<string, unknown>;
  gateway?: 'relay' | 'domain';
  role?: AgentRole;
}

export interface AgentRow {
  id: string;
  name: string;
  email: string;
  api_key: string;
  stalwart_principal: string;
  created_at: string;
  updated_at: string;
  metadata: string;
  role: string;
  wake_on_cc?: number;
}
