/**
 * OpenClaw Integration Hook
 *
 * This is the bridge between the enterprise engine and a running
 * OpenClaw instance. It intercepts every tool call, checks permissions,
 * records activity, injects knowledge base context, and enforces budgets.
 *
 * How it works:
 * 1. OpenClaw plugin registers this hook on startup
 * 2. Before every tool call → checkPermission + recordStart
 * 3. After every tool call → recordEnd + update usage
 * 4. Before every LLM call → inject KB context if relevant
 * 5. On session start/end → lifecycle events
 *
 * Usage in OpenClaw plugin:
 *   import { createEnterpriseHook } from '@agenticmail/enterprise/hook';
 *   const hook = createEnterpriseHook({ engineUrl: 'http://localhost:4444' });
 *   // Register with OpenClaw's tool pipeline
 */

// ─── Types ──────────────────────────────────────────────

export interface EnterpriseHookConfig {
  /** URL of the enterprise engine API */
  engineUrl: string;

  /** Agent ID in the enterprise system */
  agentId: string;

  /** Organization ID */
  orgId: string;

  /** Auth token for engine API */
  apiToken?: string;

  /** Enable knowledge base context injection */
  knowledgeBaseEnabled?: boolean;

  /** Max tokens for KB context per turn */
  kbMaxTokens?: number;

  /** Enable real-time activity streaming */
  activityStreamEnabled?: boolean;

  /** Fail open (allow) or fail closed (deny) when engine is unreachable */
  failMode?: 'open' | 'closed';

  /** Cache permission checks for N seconds (reduces API calls) */
  permissionCacheTtlSec?: number;
}

export interface ToolCallContext {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
  sessionId: string;
  timestamp?: Date;
}

export interface ToolCallResult {
  success: boolean;
  output?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface HookResult {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  approvalId?: string;
  sandbox?: boolean;
  /** Modified parameters (if hook wants to sanitize/restrict) */
  modifiedParameters?: Record<string, any>;
}

// ─── Enterprise Hook ────────────────────────────────────

export class EnterpriseHook {
  private config: Required<EnterpriseHookConfig>;
  private permissionCache = new Map<string, { result: HookResult; expires: number }>();
  private pendingToolCalls = new Map<string, string>(); // callId → toolCallRecordId
  private connected = false;

  constructor(config: EnterpriseHookConfig) {
    this.config = {
      engineUrl: config.engineUrl,
      agentId: config.agentId,
      orgId: config.orgId,
      apiToken: config.apiToken || '',
      knowledgeBaseEnabled: config.knowledgeBaseEnabled ?? true,
      kbMaxTokens: config.kbMaxTokens ?? 2000,
      activityStreamEnabled: config.activityStreamEnabled ?? true,
      failMode: config.failMode ?? 'open',
      permissionCacheTtlSec: config.permissionCacheTtlSec ?? 30,
    };
  }

  /**
   * BEFORE a tool call — check permissions, record start
   */
  async beforeToolCall(ctx: ToolCallContext): Promise<HookResult> {
    try {
      // Check cache first
      const cached = this.permissionCache.get(ctx.toolId);
      if (cached && cached.expires > Date.now()) {
        // Still record the call even if cached
        await this.recordToolCallStart(ctx);
        return cached.result;
      }

      // Check permission with engine
      const permResult = await this.apiCall('/api/engine/permissions/check', 'POST', {
        agentId: this.config.agentId,
        toolId: ctx.toolId,
      });

      const result: HookResult = {
        allowed: permResult.allowed ?? (this.config.failMode === 'open'),
        reason: permResult.reason || 'Unknown',
        requiresApproval: permResult.requiresApproval || false,
        sandbox: permResult.sandbox || false,
      };

      // Cache the permission result
      this.permissionCache.set(ctx.toolId, {
        result,
        expires: Date.now() + this.config.permissionCacheTtlSec * 1000,
      });

      // If approval required, create approval request and wait
      if (result.requiresApproval && result.allowed) {
        const approval = await this.requestApproval(ctx);
        if (approval) {
          result.approvalId = approval.id;
          if (approval.status === 'denied') {
            result.allowed = false;
            result.reason = `Denied by ${approval.decision?.by}: ${approval.decision?.reason || 'No reason given'}`;
          } else if (approval.status === 'expired') {
            result.allowed = false;
            result.reason = 'Approval request expired';
          }
        }
      }

      // Record the tool call start
      if (result.allowed) {
        await this.recordToolCallStart(ctx);
      } else {
        // Record blocked call
        await this.recordActivity('tool_blocked', {
          toolId: ctx.toolId,
          toolName: ctx.toolName,
          reason: result.reason,
        });
      }

      return result;

    } catch (error: any) {
      // Engine unreachable — use fail mode
      const allowed = this.config.failMode === 'open';
      return {
        allowed,
        reason: allowed
          ? `Engine unreachable (fail-open): ${error.message}`
          : `Engine unreachable (fail-closed): ${error.message}`,
        requiresApproval: false,
      };
    }
  }

  /**
   * AFTER a tool call — record result, update usage
   */
  async afterToolCall(ctx: ToolCallContext, result: ToolCallResult): Promise<void> {
    try {
      // Record usage with lifecycle manager
      await this.apiCall('/api/engine/agents/' + this.config.agentId + '/record-tool-call', 'POST', {
        toolId: ctx.toolId,
        tokensUsed: (result.inputTokens || 0) + (result.outputTokens || 0),
        costUsd: result.costUsd || 0,
        isExternalAction: this.isExternalAction(ctx.toolId),
        error: !result.success,
      });

      // Record activity event
      await this.recordActivity(result.success ? 'tool_call_end' : 'tool_call_error', {
        toolId: ctx.toolId,
        toolName: ctx.toolName,
        success: result.success,
        error: result.error,
        durationMs: ctx.timestamp ? Date.now() - ctx.timestamp.getTime() : undefined,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });
    } catch {
      // Non-blocking — don't break the agent if tracking fails
    }
  }

  /**
   * BEFORE an LLM call — inject knowledge base context
   */
  async getKnowledgeContext(userMessage: string): Promise<string | null> {
    if (!this.config.knowledgeBaseEnabled) return null;

    try {
      const result = await this.apiCall('/api/engine/knowledge-bases/context', 'POST', {
        agentId: this.config.agentId,
        query: userMessage,
        maxTokens: this.config.kbMaxTokens,
      });
      return result.context || null;
    } catch {
      return null;
    }
  }

  /**
   * ON session start
   */
  async onSessionStart(sessionId: string): Promise<void> {
    try {
      await this.recordActivity('session_start', { sessionId });
    } catch { /* non-blocking */ }
  }

  /**
   * ON session end
   */
  async onSessionEnd(sessionId: string): Promise<void> {
    try {
      await this.recordActivity('session_end', { sessionId });
    } catch { /* non-blocking */ }
  }

  /**
   * Record a conversation message
   */
  async recordMessage(opts: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    channel?: string;
    tokenCount: number;
  }): Promise<void> {
    try {
      await this.apiCall('/api/engine/activity/record-message', 'POST', {
        agentId: this.config.agentId,
        ...opts,
      });
    } catch { /* non-blocking */ }
  }

  /**
   * Get the tool policy for this agent (used on startup to configure OpenClaw)
   */
  async getToolPolicy(): Promise<{
    allowedTools: string[];
    blockedTools: string[];
    approvalRequired: string[];
    rateLimits: any;
  } | null> {
    try {
      return await this.apiCall(`/api/engine/permissions/${this.config.agentId}/policy`, 'GET');
    } catch {
      return null;
    }
  }

  /**
   * Check if engine is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.apiCall('/health', 'GET');
      this.connected = result.status === 'ok';
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }

  // ─── Private ──────────────────────────────────────────

  private async requestApproval(ctx: ToolCallContext): Promise<any> {
    try {
      const result = await this.apiCall('/api/engine/approvals/request', 'POST', {
        agentId: this.config.agentId,
        agentName: this.config.agentId,
        toolId: ctx.toolId,
        toolName: ctx.toolName,
        parameters: ctx.parameters,
        context: `Session ${ctx.sessionId}`,
      });

      if (result.request?.id) {
        // Wait for decision (up to 5 minutes)
        const start = Date.now();
        while (Date.now() - start < 300_000) {
          await new Promise(r => setTimeout(r, 3000));
          const check = await this.apiCall(`/api/engine/approvals/${result.request.id}`, 'GET');
          if (check.request?.status !== 'pending') return check.request;
        }
        return { status: 'expired' };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async recordToolCallStart(ctx: ToolCallContext): Promise<void> {
    if (!this.config.activityStreamEnabled) return;
    try {
      await this.recordActivity('tool_call_start', {
        toolId: ctx.toolId,
        toolName: ctx.toolName,
        sessionId: ctx.sessionId,
      });
    } catch { /* non-blocking */ }
  }

  private async recordActivity(type: string, data: Record<string, any>): Promise<void> {
    try {
      await this.apiCall('/api/engine/activity/record', 'POST', {
        agentId: this.config.agentId,
        orgId: this.config.orgId,
        type,
        data,
      });
    } catch { /* non-blocking */ }
  }

  private isExternalAction(toolId: string): boolean {
    const externalTools = [
      'agenticmail_send', 'agenticmail_reply', 'agenticmail_forward',
      'agenticmail_sms_send', 'message', 'tts',
    ];
    return externalTools.includes(toolId);
  }

  private async apiCall(path: string, method: string, body?: any): Promise<any> {
    const opts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiToken ? { 'Authorization': `Bearer ${this.config.apiToken}` } : {}),
      },
      signal: AbortSignal.timeout(5000),
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const resp = await fetch(`${this.config.engineUrl}${path}`, opts);
    return resp.json();
  }
}

// ─── Factory ────────────────────────────────────────────

/**
 * Create an enterprise hook instance for use in OpenClaw plugins
 */
export function createEnterpriseHook(config: EnterpriseHookConfig): EnterpriseHook {
  return new EnterpriseHook(config);
}
