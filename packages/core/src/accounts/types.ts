/** Predefined agent roles */
export type AgentRole = 'secretary' | 'assistant' | 'researcher' | 'writer' | 'custom';

export const AGENT_ROLES: readonly AgentRole[] = ['secretary', 'assistant', 'researcher', 'writer', 'custom'] as const;
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
}
