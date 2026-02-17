/**
 * Agent Lifecycle Manager
 *
 * Manages the full lifecycle of an autonomous AI agent employee:
 * create → configure → deploy → running → monitor → update → stop
 *
 * This is the core state machine. Every agent goes through these states
 * and the manager handles transitions, health checks, auto-recovery,
 * and status tracking.
 */

import type { DatabaseAdapter } from '../db/adapter.js';
import type { AgentConfig, DeploymentStatus } from './agent-config.js';
import { AgentConfigGenerator } from './agent-config.js';
import { DeploymentEngine } from './deployer.js';
import { PermissionEngine } from './skills.js';

// ─── Types ──────────────────────────────────────────────

export type AgentState =
  | 'draft'           // Created but not configured
  | 'configuring'     // Skills/permissions/identity being set up
  | 'ready'           // Fully configured, waiting for deploy
  | 'provisioning'    // Infrastructure being created
  | 'deploying'       // Code/config being pushed
  | 'starting'        // Container/process starting up
  | 'running'         // Active and healthy
  | 'degraded'        // Running but with issues
  | 'stopped'         // Intentionally stopped
  | 'error'           // Failed — needs attention
  | 'updating'        // Config/code update in progress
  | 'destroying';     // Being torn down

export interface ManagedAgent {
  id: string;
  orgId: string;                     // Which company owns this agent
  config: AgentConfig;
  state: AgentState;
  stateHistory: StateTransition[];
  health: AgentHealth;
  usage: AgentUsage;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt?: string;
  lastHealthCheckAt?: string;
  version: number;                   // Config version for optimistic locking
}

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  reason: string;
  triggeredBy: string;               // User ID or 'system'
  timestamp: string;
  error?: string;
}

export interface AgentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastCheck: string;
  uptime: number;                    // Seconds since last start
  consecutiveFailures: number;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  timestamp: string;
  durationMs: number;
}

export interface AgentUsage {
  // Token usage
  tokensToday: number;
  tokensThisMonth: number;
  tokenBudgetMonthly: number;        // 0 = unlimited

  // Tool calls
  toolCallsToday: number;
  toolCallsThisMonth: number;

  // External actions (emails sent, messages, etc.)
  externalActionsToday: number;
  externalActionsThisMonth: number;

  // Cost estimate (USD)
  costToday: number;
  costThisMonth: number;
  costBudgetMonthly: number;         // 0 = unlimited

  // Sessions
  activeSessionCount: number;
  totalSessionsToday: number;

  // Errors
  errorsToday: number;
  errorRate1h: number;               // Errors per hour in last hour

  lastUpdated: string;
}

export interface LifecycleEvent {
  id: string;
  agentId: string;
  orgId: string;
  type: LifecycleEventType;
  data: Record<string, any>;
  timestamp: string;
}

export type LifecycleEventType =
  | 'created'
  | 'configured'
  | 'deployed'
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'updated'
  | 'error'
  | 'health_check'
  | 'auto_recovered'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'tool_call'
  | 'approval_requested'
  | 'approval_decided'
  | 'destroyed';

// ─── Lifecycle Manager ──────────────────────────────────

export class AgentLifecycleManager {
  private agents = new Map<string, ManagedAgent>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  private deployer = new DeploymentEngine();
  private configGen = new AgentConfigGenerator();
  private permissions: PermissionEngine;
  private db?: DatabaseAdapter;
  private eventListeners: ((event: LifecycleEvent) => void)[] = [];

  constructor(opts?: { db?: DatabaseAdapter; permissions?: PermissionEngine }) {
    this.db = opts?.db;
    this.permissions = opts?.permissions || new PermissionEngine();
  }

  // ─── Agent CRUD ─────────────────────────────────────

  /**
   * Create a new managed agent (starts in 'draft' state)
   */
  async createAgent(orgId: string, config: AgentConfig, createdBy: string): Promise<ManagedAgent> {
    const agent: ManagedAgent = {
      id: config.id || crypto.randomUUID(),
      orgId,
      config,
      state: 'draft',
      stateHistory: [],
      health: {
        status: 'unknown',
        lastCheck: new Date().toISOString(),
        uptime: 0,
        consecutiveFailures: 0,
        checks: [],
      },
      usage: this.emptyUsage(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    this.agents.set(agent.id, agent);
    await this.persistAgent(agent);
    this.emitEvent(agent, 'created', { createdBy });

    return agent;
  }

  /**
   * Update agent configuration (must be in draft, ready, stopped, or error state)
   */
  async updateConfig(agentId: string, updates: Partial<AgentConfig>, updatedBy: string): Promise<ManagedAgent> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const mutableStates: AgentState[] = ['draft', 'ready', 'stopped', 'error'];
    if (!mutableStates.includes(agent.state)) {
      throw new Error(`Cannot update config in state "${agent.state}". Stop the agent first.`);
    }

    // Merge updates
    agent.config = { ...agent.config, ...updates, updatedAt: new Date().toISOString() };
    agent.updatedAt = new Date().toISOString();
    agent.version++;

    // If all required fields are set, transition to 'ready'
    if (agent.state === 'draft' && this.isConfigComplete(agent.config)) {
      this.transition(agent, 'ready', 'Configuration complete', updatedBy);
    } else if (agent.state !== 'draft') {
      this.transition(agent, 'ready', 'Configuration updated', updatedBy);
    }

    await this.persistAgent(agent);
    this.emitEvent(agent, 'configured', { updatedBy, changes: Object.keys(updates) });

    return agent;
  }

  /**
   * Deploy an agent to its target environment
   */
  async deploy(agentId: string, deployedBy: string): Promise<ManagedAgent> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (!['ready', 'stopped', 'error'].includes(agent.state)) {
      throw new Error(`Cannot deploy from state "${agent.state}"`);
    }

    if (!this.isConfigComplete(agent.config)) {
      throw new Error('Agent configuration is incomplete');
    }

    // Transition: provisioning
    this.transition(agent, 'provisioning', 'Deployment initiated', deployedBy);
    await this.persistAgent(agent);

    try {
      // Run deployment
      this.transition(agent, 'deploying', 'Pushing configuration', 'system');

      const result = await this.deployer.deploy(agent.config, (event) => {
        this.emitEvent(agent, 'deployed', { phase: event.phase, status: event.status, message: event.message });
      });

      if (result.success) {
        this.transition(agent, 'starting', 'Deployment successful, agent starting', 'system');
        agent.lastDeployedAt = new Date().toISOString();

        // Wait for agent to be healthy
        const healthy = await this.waitForHealthy(agent, 60_000);
        if (healthy) {
          this.transition(agent, 'running', 'Agent is healthy and running', 'system');
          this.startHealthCheckLoop(agent);
        } else {
          this.transition(agent, 'degraded', 'Agent started but health check failed', 'system');
          this.startHealthCheckLoop(agent);
        }
      } else {
        this.transition(agent, 'error', `Deployment failed: ${result.error}`, 'system');
      }

      await this.persistAgent(agent);
      return agent;

    } catch (error: any) {
      this.transition(agent, 'error', `Deployment error: ${error.message}`, 'system');
      await this.persistAgent(agent);
      throw error;
    }
  }

  /**
   * Stop a running agent
   */
  async stop(agentId: string, stoppedBy: string, reason?: string): Promise<ManagedAgent> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (!['running', 'degraded', 'starting', 'error'].includes(agent.state)) {
      throw new Error(`Cannot stop from state "${agent.state}"`);
    }

    this.stopHealthCheckLoop(agentId);

    try {
      await this.deployer.stop(agent.config);
      this.transition(agent, 'stopped', reason || 'Stopped by user', stoppedBy);
    } catch (error: any) {
      this.transition(agent, 'stopped', `Stopped with error: ${error.message}`, stoppedBy);
    }

    await this.persistAgent(agent);
    this.emitEvent(agent, 'stopped', { stoppedBy, reason });
    return agent;
  }

  /**
   * Restart a running agent
   */
  async restart(agentId: string, restartedBy: string): Promise<ManagedAgent> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    this.transition(agent, 'updating', 'Restarting', restartedBy);

    try {
      await this.deployer.restart(agent.config);
      const healthy = await this.waitForHealthy(agent, 30_000);
      this.transition(agent, healthy ? 'running' : 'degraded', 'Restarted', 'system');
    } catch (error: any) {
      this.transition(agent, 'error', `Restart failed: ${error.message}`, 'system');
    }

    await this.persistAgent(agent);
    this.emitEvent(agent, 'restarted', { restartedBy });
    return agent;
  }

  /**
   * Hot-update config on a running agent (no full redeploy)
   */
  async hotUpdate(agentId: string, updates: Partial<AgentConfig>, updatedBy: string): Promise<ManagedAgent> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (agent.state !== 'running' && agent.state !== 'degraded') {
      throw new Error(`Hot update only works on running agents (current: "${agent.state}")`);
    }

    const prevState = agent.state;
    this.transition(agent, 'updating', 'Hot config update', updatedBy);

    // Merge config
    agent.config = { ...agent.config, ...updates, updatedAt: new Date().toISOString() };
    agent.version++;

    try {
      await this.deployer.updateConfig(agent.config);
      this.transition(agent, prevState, 'Config updated successfully', 'system');
    } catch (error: any) {
      this.transition(agent, 'degraded', `Config update failed: ${error.message}`, 'system');
    }

    await this.persistAgent(agent);
    this.emitEvent(agent, 'updated', { updatedBy, hotUpdate: true });
    return agent;
  }

  /**
   * Destroy an agent completely (stop + delete all resources)
   */
  async destroy(agentId: string, destroyedBy: string): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    this.transition(agent, 'destroying', 'Agent being destroyed', destroyedBy);
    this.stopHealthCheckLoop(agentId);

    // Stop if running
    if (['running', 'degraded', 'starting'].includes(agent.state)) {
      try { await this.deployer.stop(agent.config); } catch { /* best effort */ }
    }

    this.emitEvent(agent, 'destroyed', { destroyedBy });
    this.agents.delete(agentId);
    // DB cleanup would happen here
  }

  // ─── Monitoring ─────────────────────────────────────

  /**
   * Record a tool call for usage tracking
   */
  recordToolCall(agentId: string, toolId: string, opts?: {
    tokensUsed?: number;
    costUsd?: number;
    isExternalAction?: boolean;
    error?: boolean;
  }) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const usage = agent.usage;
    usage.toolCallsToday++;
    usage.toolCallsThisMonth++;
    if (opts?.tokensUsed) {
      usage.tokensToday += opts.tokensUsed;
      usage.tokensThisMonth += opts.tokensUsed;
    }
    if (opts?.costUsd) {
      usage.costToday += opts.costUsd;
      usage.costThisMonth += opts.costUsd;
    }
    if (opts?.isExternalAction) {
      usage.externalActionsToday++;
      usage.externalActionsThisMonth++;
    }
    if (opts?.error) {
      usage.errorsToday++;
    }
    usage.lastUpdated = new Date().toISOString();

    // Budget checks
    if (usage.tokenBudgetMonthly > 0 && usage.tokensThisMonth >= usage.tokenBudgetMonthly) {
      this.emitEvent(agent, 'budget_exceeded', { type: 'tokens', used: usage.tokensThisMonth, budget: usage.tokenBudgetMonthly });
      // Auto-stop on budget exceeded
      this.stop(agentId, 'system', 'Monthly token budget exceeded').catch(() => {});
    } else if (usage.tokenBudgetMonthly > 0 && usage.tokensThisMonth >= usage.tokenBudgetMonthly * 0.8) {
      this.emitEvent(agent, 'budget_warning', { type: 'tokens', used: usage.tokensThisMonth, budget: usage.tokenBudgetMonthly, percent: 80 });
    }

    if (usage.costBudgetMonthly > 0 && usage.costThisMonth >= usage.costBudgetMonthly) {
      this.emitEvent(agent, 'budget_exceeded', { type: 'cost', used: usage.costThisMonth, budget: usage.costBudgetMonthly });
      this.stop(agentId, 'system', 'Monthly cost budget exceeded').catch(() => {});
    }

    this.emitEvent(agent, 'tool_call', { toolId, ...opts });
  }

  /**
   * Get all agents for an org
   */
  getAgentsByOrg(orgId: string): ManagedAgent[] {
    return Array.from(this.agents.values()).filter(a => a.orgId === orgId);
  }

  /**
   * Get a single agent
   */
  getAgent(agentId: string): ManagedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get org-wide usage summary
   */
  getOrgUsage(orgId: string): {
    totalAgents: number;
    runningAgents: number;
    totalTokensToday: number;
    totalCostToday: number;
    totalToolCallsToday: number;
    totalErrorsToday: number;
    agents: { id: string; name: string; state: AgentState; usage: AgentUsage }[];
  } {
    const agents = this.getAgentsByOrg(orgId);
    return {
      totalAgents: agents.length,
      runningAgents: agents.filter(a => a.state === 'running').length,
      totalTokensToday: agents.reduce((sum, a) => sum + a.usage.tokensToday, 0),
      totalCostToday: agents.reduce((sum, a) => sum + a.usage.costToday, 0),
      totalToolCallsToday: agents.reduce((sum, a) => sum + a.usage.toolCallsToday, 0),
      totalErrorsToday: agents.reduce((sum, a) => sum + a.usage.errorsToday, 0),
      agents: agents.map(a => ({ id: a.id, name: a.config.displayName, state: a.state, usage: a.usage })),
    };
  }

  /**
   * Subscribe to lifecycle events (for dashboard real-time updates)
   */
  onEvent(listener: (event: LifecycleEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => { this.eventListeners = this.eventListeners.filter(l => l !== listener); };
  }

  /**
   * Reset daily counters (call at midnight via cron)
   */
  resetDailyCounters() {
    for (const agent of this.agents.values()) {
      agent.usage.tokensToday = 0;
      agent.usage.toolCallsToday = 0;
      agent.usage.externalActionsToday = 0;
      agent.usage.costToday = 0;
      agent.usage.errorsToday = 0;
      agent.usage.totalSessionsToday = 0;
    }
  }

  /**
   * Reset monthly counters (call on 1st of month)
   */
  resetMonthlyCounters() {
    for (const agent of this.agents.values()) {
      agent.usage.tokensThisMonth = 0;
      agent.usage.toolCallsThisMonth = 0;
      agent.usage.externalActionsThisMonth = 0;
      agent.usage.costThisMonth = 0;
    }
  }

  // ─── Health Check Loop ────────────────────────────────

  private startHealthCheckLoop(agent: ManagedAgent) {
    this.stopHealthCheckLoop(agent.id);

    const interval = setInterval(async () => {
      try {
        const status = await this.deployer.getStatus(agent.config);
        agent.lastHealthCheckAt = new Date().toISOString();

        const check: HealthCheck = {
          name: 'deployment_status',
          status: status.status === 'running' ? 'pass' : 'fail',
          message: `Status: ${status.status}, Health: ${status.healthStatus}`,
          timestamp: new Date().toISOString(),
          durationMs: 0,
        };

        // Keep last 10 checks
        agent.health.checks = [check, ...agent.health.checks].slice(0, 10);

        if (status.status === 'running' && status.healthStatus === 'healthy') {
          agent.health.status = 'healthy';
          agent.health.consecutiveFailures = 0;
          if (status.uptime) agent.health.uptime = status.uptime;
          if (status.metrics) {
            agent.usage.activeSessionCount = status.metrics.activeSessionCount;
          }
          // Recover from degraded
          if (agent.state === 'degraded') {
            this.transition(agent, 'running', 'Health restored', 'system');
            this.emitEvent(agent, 'auto_recovered', {});
          }
        } else {
          agent.health.consecutiveFailures++;
          agent.health.status = agent.health.consecutiveFailures >= 3 ? 'unhealthy' : 'degraded';

          if (agent.state === 'running' && agent.health.consecutiveFailures >= 2) {
            this.transition(agent, 'degraded', `Health degraded: ${agent.health.consecutiveFailures} consecutive failures`, 'system');
          }

          // Auto-restart after 5 consecutive failures
          if (agent.health.consecutiveFailures >= 5 && agent.state !== 'error') {
            this.emitEvent(agent, 'auto_recovered', { action: 'restart', failures: agent.health.consecutiveFailures });
            agent.health.consecutiveFailures = 0;
            try {
              await this.deployer.restart(agent.config);
              this.transition(agent, 'starting', 'Auto-restarted after health failures', 'system');
            } catch {
              this.transition(agent, 'error', 'Auto-restart failed', 'system');
            }
          }
        }

        agent.health.lastCheck = new Date().toISOString();
        await this.persistAgent(agent);

      } catch (error: any) {
        agent.health.consecutiveFailures++;
        agent.health.status = 'unhealthy';
      }
    }, 30_000); // Every 30 seconds

    this.healthCheckIntervals.set(agent.id, interval);
  }

  private stopHealthCheckLoop(agentId: string) {
    const interval = this.healthCheckIntervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(agentId);
    }
  }

  // ─── Private Helpers ──────────────────────────────────

  private transition(agent: ManagedAgent, to: AgentState, reason: string, triggeredBy: string) {
    const from = agent.state;
    agent.stateHistory.push({
      from, to, reason, triggeredBy,
      timestamp: new Date().toISOString(),
    });
    // Keep last 50 transitions
    if (agent.stateHistory.length > 50) agent.stateHistory = agent.stateHistory.slice(-50);
    agent.state = to;
    agent.updatedAt = new Date().toISOString();
  }

  private isConfigComplete(config: AgentConfig): boolean {
    return !!(
      config.name &&
      config.displayName &&
      config.identity?.role &&
      config.model?.modelId &&
      config.deployment?.target &&
      config.permissionProfileId
    );
  }

  private async waitForHealthy(agent: ManagedAgent, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await this.deployer.getStatus(agent.config);
        if (status.status === 'running') return true;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 3000));
    }
    return false;
  }

  private async persistAgent(agent: ManagedAgent) {
    // In production, this writes to the database
    // For now, just update the in-memory map
    this.agents.set(agent.id, agent);
    // TODO: this.db?.upsertManagedAgent(agent);
  }

  private emitEvent(agent: ManagedAgent, type: LifecycleEventType, data: Record<string, any>) {
    const event: LifecycleEvent = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      orgId: agent.orgId,
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  private emptyUsage(): AgentUsage {
    return {
      tokensToday: 0, tokensThisMonth: 0, tokenBudgetMonthly: 0,
      toolCallsToday: 0, toolCallsThisMonth: 0,
      externalActionsToday: 0, externalActionsThisMonth: 0,
      costToday: 0, costThisMonth: 0, costBudgetMonthly: 0,
      activeSessionCount: 0, totalSessionsToday: 0,
      errorsToday: 0, errorRate1h: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Cleanup: stop all health check loops
   */
  shutdown() {
    for (const [id] of this.healthCheckIntervals) {
      this.stopHealthCheckLoop(id);
    }
  }
}
