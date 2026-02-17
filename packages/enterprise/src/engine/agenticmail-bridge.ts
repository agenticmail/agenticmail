/**
 * AgenticMail Bridge
 *
 * Integrates the enterprise engine with AgenticMail's OpenClaw plugin.
 * This is the glue code that makes enterprise features available
 * inside an agent's OpenClaw session.
 *
 * When an enterprise-managed agent boots:
 * 1. Bridge loads agent config from engine
 * 2. Registers permission middleware on every tool call
 * 3. Injects KB context before LLM calls
 * 4. Streams activity events to the engine
 * 5. Enforces rate limits and budgets
 *
 * Usage:
 *   // In OpenClaw plugin init
 *   import { createAgenticMailBridge } from '@agenticmail/enterprise/bridge';
 *   const bridge = await createAgenticMailBridge({
 *     engineUrl: process.env.AGENTICMAIL_ENTERPRISE_URL,
 *     agentId: process.env.AGENTICMAIL_AGENT_ID,
 *     orgId: process.env.AGENTICMAIL_ORG_ID,
 *   });
 *   bridge.install(openclawPlugin);
 */

import { EnterpriseHook, type EnterpriseHookConfig } from './openclaw-hook.js';
import { TOOL_INDEX, generateOpenClawToolPolicy } from './tool-catalog.js';

// ─── Types ──────────────────────────────────────────────

export interface BridgeConfig extends EnterpriseHookConfig {
  /** Auto-configure tool policy on startup */
  autoConfigureTools?: boolean;
  
  /** Inject coordination context about enterprise features */
  injectCoordinationContext?: boolean;

  /** Log enterprise events to console */
  verbose?: boolean;
}

export interface ToolInterceptor {
  /** Called before every tool invocation. Return false to block. */
  beforeTool: (toolId: string, params: Record<string, any>, sessionId: string) => Promise<{
    allowed: boolean;
    reason?: string;
    modifiedParams?: Record<string, any>;
  }>;
  
  /** Called after every tool invocation */
  afterTool: (toolId: string, params: Record<string, any>, result: any, sessionId: string) => Promise<void>;
}

// ─── Bridge ─────────────────────────────────────────────

export class AgenticMailBridge {
  private hook: EnterpriseHook;
  private config: BridgeConfig;
  private toolPolicy: { allowedTools: string[]; blockedTools: string[]; approvalRequired: string[] } | null = null;
  private sessionId: string = '';
  private rateLimiter: { count: number; resetAt: number } = { count: 0, resetAt: 0 };

  constructor(config: BridgeConfig) {
    this.config = config;
    this.hook = new EnterpriseHook(config);
  }

  /**
   * Initialize the bridge — load config, verify connection
   */
  async initialize(): Promise<{ connected: boolean; toolPolicy: any }> {
    const connected = await this.hook.healthCheck();
    
    if (connected && this.config.autoConfigureTools !== false) {
      this.toolPolicy = await this.hook.getToolPolicy();
    }

    if (this.config.verbose) {
      console.log(`[Enterprise] Bridge initialized. Connected: ${connected}`);
      if (this.toolPolicy) {
        console.log(`[Enterprise] Tool policy: ${this.toolPolicy.allowedTools.length} allowed, ${this.toolPolicy.blockedTools.length} blocked`);
      }
    }

    return { connected, toolPolicy: this.toolPolicy };
  }

  /**
   * Get a tool interceptor that can be registered with OpenClaw
   */
  getInterceptor(): ToolInterceptor {
    return {
      beforeTool: async (toolId, params, sessionId) => {
        this.sessionId = sessionId;
        
        // Quick local check first (no API call)
        if (this.toolPolicy?.blockedTools.includes(toolId)) {
          if (this.config.verbose) console.log(`[Enterprise] BLOCKED: ${toolId} (policy)`);
          return { allowed: false, reason: `Tool "${toolId}" is blocked by enterprise policy` };
        }

        // Rate limit check
        const now = Date.now();
        if (now > this.rateLimiter.resetAt) {
          this.rateLimiter = { count: 0, resetAt: now + 60_000 };
        }
        this.rateLimiter.count++;
        // Default 120/min, will be overridden by policy
        const limit = (this.toolPolicy as any)?.rateLimits?.toolCallsPerMinute || 120;
        if (this.rateLimiter.count > limit) {
          return { allowed: false, reason: `Rate limit exceeded: ${this.rateLimiter.count}/${limit} calls/min` };
        }

        // Full permission check via engine API
        const result = await this.hook.beforeToolCall({
          toolId, toolName: toolId, parameters: params, sessionId,
          timestamp: new Date(),
        });

        if (this.config.verbose && !result.allowed) {
          console.log(`[Enterprise] BLOCKED: ${toolId} — ${result.reason}`);
        }

        return {
          allowed: result.allowed,
          reason: result.reason,
          modifiedParams: result.modifiedParameters,
        };
      },

      afterTool: async (toolId, params, result, sessionId) => {
        await this.hook.afterToolCall(
          { toolId, toolName: toolId, parameters: params, sessionId, timestamp: new Date() },
          {
            success: !result?.error,
            output: typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 500),
            error: result?.error,
          },
        );
      },
    };
  }

  /**
   * Get knowledge base context to inject before LLM call
   */
  async getKBContext(userMessage: string): Promise<string | null> {
    return this.hook.getKnowledgeContext(userMessage);
  }

  /**
   * Generate coordination context for the agent's system prompt
   */
  getCoordinationContext(): string {
    if (!this.config.injectCoordinationContext) return '';

    const blocked = this.toolPolicy?.blockedTools || [];
    const needsApproval = this.toolPolicy?.approvalRequired || [];

    let ctx = '\n<enterprise-context>\n';
    ctx += '🏢 This agent is managed by AgenticMail Enterprise.\n';
    
    if (blocked.length > 0) {
      ctx += `⛔ Blocked tools (do not attempt): ${blocked.join(', ')}\n`;
    }
    if (needsApproval.length > 0) {
      ctx += `⚠️ Tools requiring human approval: ${needsApproval.join(', ')}\n`;
      ctx += 'When using these tools, the call will pause until a human approves or denies.\n';
    }

    ctx += '</enterprise-context>\n';
    return ctx;
  }

  /**
   * Notify engine of session lifecycle
   */
  async onSessionStart(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.hook.onSessionStart(sessionId);
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    await this.hook.onSessionEnd(sessionId);
  }

  /**
   * Record a message in the conversation log
   */
  async recordMessage(role: 'user' | 'assistant' | 'system', content: string, opts?: {
    channel?: string;
    tokenCount?: number;
  }): Promise<void> {
    await this.hook.recordMessage({
      sessionId: this.sessionId,
      role,
      content,
      channel: opts?.channel,
      tokenCount: opts?.tokenCount || Math.ceil(content.length / 4),
    });
  }

  /**
   * Get the loaded tool policy
   */
  getToolPolicy() {
    return this.toolPolicy;
  }

  /**
   * Generate OpenClaw-compatible config for tools.allow / tools.deny
   * This is what gets written to the gateway config
   */
  getOpenClawToolConfig(): Record<string, any> {
    if (!this.toolPolicy) return {};
    return generateOpenClawToolPolicy(
      this.toolPolicy.allowedTools,
      this.toolPolicy.blockedTools,
    );
  }
}

// ─── Factory ────────────────────────────────────────────

/**
 * Create and initialize the AgenticMail Enterprise bridge
 */
export async function createAgenticMailBridge(config: BridgeConfig): Promise<AgenticMailBridge> {
  const bridge = new AgenticMailBridge({
    autoConfigureTools: true,
    injectCoordinationContext: true,
    verbose: false,
    failMode: 'open',
    permissionCacheTtlSec: 30,
    kbMaxTokens: 2000,
    knowledgeBaseEnabled: true,
    activityStreamEnabled: true,
    ...config,
  });

  await bridge.initialize();
  return bridge;
}

/**
 * Example integration with OpenClaw plugin:
 *
 * ```typescript
 * // In @agenticmail/openclaw plugin init
 * import { createAgenticMailBridge } from '@agenticmail/enterprise/bridge';
 *
 * export async function initPlugin(openclaw) {
 *   // Check if enterprise mode is enabled
 *   const engineUrl = process.env.AGENTICMAIL_ENTERPRISE_URL;
 *   if (!engineUrl) return; // Not enterprise, skip
 *
 *   const bridge = await createAgenticMailBridge({
 *     engineUrl,
 *     agentId: process.env.AGENTICMAIL_AGENT_ID,
 *     orgId: process.env.AGENTICMAIL_ORG_ID,
 *     apiToken: process.env.AGENTICMAIL_ENTERPRISE_TOKEN,
 *   });
 *
 *   // Register tool interceptor
 *   const interceptor = bridge.getInterceptor();
 *   openclaw.onBeforeToolCall(async (tool, params, session) => {
 *     const result = await interceptor.beforeTool(tool, params, session.id);
 *     if (!result.allowed) throw new Error(`Enterprise: ${result.reason}`);
 *     return result.modifiedParams || params;
 *   });
 *
 *   openclaw.onAfterToolCall(async (tool, params, result, session) => {
 *     await interceptor.afterTool(tool, params, result, session.id);
 *   });
 *
 *   // Inject KB context before LLM
 *   openclaw.onBeforeLLM(async (messages) => {
 *     const lastUserMsg = messages.findLast(m => m.role === 'user');
 *     if (lastUserMsg) {
 *       const kbContext = await bridge.getKBContext(lastUserMsg.content);
 *       if (kbContext) {
 *         messages.push({ role: 'system', content: kbContext });
 *       }
 *     }
 *     return messages;
 *   });
 *
 *   // Add coordination context to system prompt
 *   openclaw.appendSystemPrompt(bridge.getCoordinationContext());
 *
 *   // Session lifecycle
 *   openclaw.onSessionStart((s) => bridge.onSessionStart(s.id));
 *   openclaw.onSessionEnd((s) => bridge.onSessionEnd(s.id));
 * }
 * ```
 */
