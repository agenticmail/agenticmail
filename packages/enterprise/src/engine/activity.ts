/**
 * Real-Time Activity & Observability
 *
 * See what every agent is doing RIGHT NOW:
 * - Live tool call stream
 * - Conversation logs
 * - Error tracking
 * - Cost tracking per call
 * - Session timeline
 *
 * This powers the "live view" in the dashboard where admins
 * can watch their agent employee work in real-time.
 */

// ─── Types ──────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  agentId: string;
  orgId: string;
  sessionId?: string;
  timestamp: string;
  type: ActivityType;
  data: Record<string, any>;
}

export type ActivityType =
  | 'session_start'
  | 'session_end'
  | 'message_received'      // Agent received a message from user/channel
  | 'message_sent'          // Agent sent a reply
  | 'tool_call_start'       // Agent is calling a tool
  | 'tool_call_end'         // Tool returned result
  | 'tool_call_error'       // Tool call failed
  | 'tool_blocked'          // Permission engine blocked a tool
  | 'approval_requested'    // Waiting for human approval
  | 'approval_decided'      // Human approved/denied
  | 'email_received'
  | 'email_sent'
  | 'task_assigned'         // Agent assigned to another agent
  | 'task_completed'
  | 'error'                 // General error
  | 'warning'               // Non-fatal issue
  | 'heartbeat'             // Periodic check-in
  | 'memory_write'          // Agent wrote to memory
  | 'budget_alert';         // Approaching or exceeding budget

export interface ToolCallRecord {
  id: string;
  agentId: string;
  orgId: string;
  sessionId: string;
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;  // Sanitized (no secrets)
  result?: {
    success: boolean;
    truncatedOutput?: string;        // First 500 chars
    error?: string;
  };
  timing: {
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
  };
  cost?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  permission: {
    allowed: boolean;
    reason: string;
    requiredApproval: boolean;
    approvalId?: string;
  };
}

export interface ConversationEntry {
  id: string;
  agentId: string;
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;                   // Truncated for storage
  channel?: string;                  // Which channel (email, whatsapp, slack, etc.)
  tokenCount: number;
  toolCalls?: string[];              // Tool call IDs referenced in this turn
}

export interface AgentTimeline {
  agentId: string;
  date: string;                      // YYYY-MM-DD
  events: TimelineEntry[];
  summary: {
    totalSessions: number;
    totalMessages: number;
    totalToolCalls: number;
    totalErrors: number;
    totalTokens: number;
    totalCostUsd: number;
    topTools: { toolId: string; count: number }[];
    activeHours: number[];           // Which hours the agent was active (0-23)
  };
}

export interface TimelineEntry {
  timestamp: string;
  type: ActivityType;
  summary: string;                   // Human-readable one-liner
  details?: Record<string, any>;
  durationMs?: number;
}

// ─── Activity Tracker ───────────────────────────────────

export class ActivityTracker {
  private events: ActivityEvent[] = [];
  private toolCalls = new Map<string, ToolCallRecord>();
  private conversations: ConversationEntry[] = [];
  private listeners: ((event: ActivityEvent) => void)[] = [];
  private sseClients = new Set<(event: ActivityEvent) => void>();

  // Buffer settings
  private maxEvents = 10_000;        // Keep last N events in memory
  private maxToolCalls = 5_000;
  private maxConversations = 5_000;

  // ─── Record Events ───────────────────────────────────

  /**
   * Record a generic activity event
   */
  record(event: Omit<ActivityEvent, 'id' | 'timestamp'>): ActivityEvent {
    const full: ActivityEvent = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(full); } catch { /* ignore */ }
    }
    for (const client of this.sseClients) {
      try { client(full); } catch { this.sseClients.delete(client); }
    }

    return full;
  }

  /**
   * Record a tool call starting
   */
  startToolCall(opts: {
    agentId: string;
    orgId: string;
    sessionId: string;
    toolId: string;
    toolName: string;
    parameters: Record<string, any>;
    permission: ToolCallRecord['permission'];
  }): ToolCallRecord {
    const record: ToolCallRecord = {
      id: crypto.randomUUID(),
      agentId: opts.agentId,
      orgId: opts.orgId,
      sessionId: opts.sessionId,
      toolId: opts.toolId,
      toolName: opts.toolName,
      parameters: this.sanitizeParams(opts.parameters),
      timing: { startedAt: new Date().toISOString() },
      permission: opts.permission,
    };

    this.toolCalls.set(record.id, record);
    if (this.toolCalls.size > this.maxToolCalls) {
      // Remove oldest entries
      const keys = Array.from(this.toolCalls.keys());
      for (let i = 0; i < 1000; i++) this.toolCalls.delete(keys[i]);
    }

    this.record({
      agentId: opts.agentId,
      orgId: opts.orgId,
      sessionId: opts.sessionId,
      type: opts.permission.allowed ? 'tool_call_start' : 'tool_blocked',
      data: { toolCallId: record.id, toolId: opts.toolId, toolName: opts.toolName },
    });

    return record;
  }

  /**
   * Record a tool call completing
   */
  endToolCall(toolCallId: string, result: {
    success: boolean;
    output?: string;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }) {
    const record = this.toolCalls.get(toolCallId);
    if (!record) return;

    record.timing.completedAt = new Date().toISOString();
    record.timing.durationMs = new Date(record.timing.completedAt).getTime() -
      new Date(record.timing.startedAt).getTime();

    record.result = {
      success: result.success,
      truncatedOutput: result.output?.slice(0, 500),
      error: result.error,
    };

    if (result.inputTokens || result.outputTokens || result.costUsd) {
      record.cost = {
        inputTokens: result.inputTokens || 0,
        outputTokens: result.outputTokens || 0,
        estimatedCostUsd: result.costUsd || 0,
      };
    }

    this.record({
      agentId: record.agentId,
      orgId: record.orgId,
      sessionId: record.sessionId,
      type: result.success ? 'tool_call_end' : 'tool_call_error',
      data: {
        toolCallId, toolId: record.toolId,
        durationMs: record.timing.durationMs,
        success: result.success,
        error: result.error,
      },
    });
  }

  /**
   * Record a conversation message
   */
  recordMessage(entry: Omit<ConversationEntry, 'id' | 'timestamp'>): ConversationEntry {
    const full: ConversationEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      content: entry.content.slice(0, 2000), // Truncate
    };

    this.conversations.push(full);
    if (this.conversations.length > this.maxConversations) {
      this.conversations = this.conversations.slice(-this.maxConversations);
    }

    this.record({
      agentId: entry.agentId,
      orgId: '',
      sessionId: entry.sessionId,
      type: entry.role === 'user' ? 'message_received' : 'message_sent',
      data: { messageId: full.id, role: entry.role, channel: entry.channel, tokenCount: entry.tokenCount },
    });

    return full;
  }

  // ─── Query ──────────────────────────────────────────

  /**
   * Get recent events for an agent
   */
  getEvents(opts: {
    agentId?: string;
    orgId?: string;
    types?: ActivityType[];
    since?: string;
    limit?: number;
  }): ActivityEvent[] {
    let events = [...this.events];

    if (opts.agentId) events = events.filter(e => e.agentId === opts.agentId);
    if (opts.orgId) events = events.filter(e => e.orgId === opts.orgId);
    if (opts.types?.length) events = events.filter(e => opts.types!.includes(e.type));
    if (opts.since) {
      const sinceTs = new Date(opts.since).getTime();
      events = events.filter(e => new Date(e.timestamp).getTime() >= sinceTs);
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return events.slice(0, opts.limit || 50);
  }

  /**
   * Get tool call history for an agent
   */
  getToolCalls(opts: {
    agentId?: string;
    orgId?: string;
    toolId?: string;
    limit?: number;
  }): ToolCallRecord[] {
    let calls = Array.from(this.toolCalls.values());
    if (opts.agentId) calls = calls.filter(c => c.agentId === opts.agentId);
    if (opts.orgId) calls = calls.filter(c => c.orgId === opts.orgId);
    if (opts.toolId) calls = calls.filter(c => c.toolId === opts.toolId);
    calls.sort((a, b) => new Date(b.timing.startedAt).getTime() - new Date(a.timing.startedAt).getTime());
    return calls.slice(0, opts.limit || 50);
  }

  /**
   * Get conversation history for a session
   */
  getConversation(sessionId: string, limit: number = 50): ConversationEntry[] {
    return this.conversations
      .filter(c => c.sessionId === sessionId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-limit);
  }

  /**
   * Generate a daily timeline for an agent
   */
  getTimeline(agentId: string, date: string): AgentTimeline {
    const dayStart = new Date(date + 'T00:00:00Z');
    const dayEnd = new Date(date + 'T23:59:59Z');

    const dayEvents = this.events.filter(e => {
      if (e.agentId !== agentId) return false;
      const ts = new Date(e.timestamp).getTime();
      return ts >= dayStart.getTime() && ts <= dayEnd.getTime();
    });

    const dayToolCalls = Array.from(this.toolCalls.values()).filter(tc => {
      if (tc.agentId !== agentId) return false;
      const ts = new Date(tc.timing.startedAt).getTime();
      return ts >= dayStart.getTime() && ts <= dayEnd.getTime();
    });

    // Compute tool usage stats
    const toolCounts = new Map<string, number>();
    let totalTokens = 0, totalCost = 0, totalErrors = 0;
    const activeHours = new Set<number>();

    for (const tc of dayToolCalls) {
      toolCounts.set(tc.toolId, (toolCounts.get(tc.toolId) || 0) + 1);
      if (tc.cost) {
        totalTokens += tc.cost.inputTokens + tc.cost.outputTokens;
        totalCost += tc.cost.estimatedCostUsd;
      }
      if (tc.result && !tc.result.success) totalErrors++;
      activeHours.add(new Date(tc.timing.startedAt).getUTCHours());
    }

    const topTools = Array.from(toolCounts.entries())
      .map(([toolId, count]) => ({ toolId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const totalMessages = dayEvents.filter(e =>
      e.type === 'message_received' || e.type === 'message_sent'
    ).length;

    const totalSessions = new Set(dayEvents.filter(e => e.sessionId).map(e => e.sessionId)).size;

    return {
      agentId,
      date,
      events: dayEvents.map(e => ({
        timestamp: e.timestamp,
        type: e.type,
        summary: this.summarizeEvent(e),
        details: e.data,
      })),
      summary: {
        totalSessions,
        totalMessages,
        totalToolCalls: dayToolCalls.length,
        totalErrors,
        totalTokens,
        totalCostUsd: totalCost,
        topTools,
        activeHours: Array.from(activeHours).sort((a, b) => a - b),
      },
    };
  }

  // ─── Real-time Streaming (SSE) ────────────────────────

  /**
   * Subscribe to real-time events (for SSE endpoint)
   */
  subscribe(callback: (event: ActivityEvent) => void): () => void {
    this.sseClients.add(callback);
    return () => this.sseClients.delete(callback);
  }

  /**
   * Subscribe to events (general listener)
   */
  onEvent(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  // ─── Stats ──────────────────────────────────────────

  /**
   * Get real-time stats for dashboard
   */
  getStats(orgId?: string): {
    eventsLast5min: number;
    toolCallsLast5min: number;
    errorsLast5min: number;
    activeAgents: string[];
    activeSessions: number;
  } {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    let recent = this.events.filter(e => e.timestamp >= fiveMinAgo);
    if (orgId) recent = recent.filter(e => e.orgId === orgId);

    const toolCalls = recent.filter(e => e.type === 'tool_call_start' || e.type === 'tool_call_end');
    const errors = recent.filter(e => e.type === 'tool_call_error' || e.type === 'error');
    const activeAgents = [...new Set(recent.map(e => e.agentId))];
    const activeSessions = new Set(recent.filter(e => e.sessionId).map(e => e.sessionId)).size;

    return {
      eventsLast5min: recent.length,
      toolCallsLast5min: toolCalls.length,
      errorsLast5min: errors.length,
      activeAgents,
      activeSessions,
    };
  }

  // ─── Private ──────────────────────────────────────────

  private sanitizeParams(params: Record<string, any>): Record<string, any> {
    const sanitized = { ...params };
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'apiKey', 'credential', 'authorization'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        sanitized[key] = '***';
      }
      // Truncate large values
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 200) {
        sanitized[key] = sanitized[key].slice(0, 200) + '...';
      }
    }
    return sanitized;
  }

  private summarizeEvent(event: ActivityEvent): string {
    switch (event.type) {
      case 'session_start': return 'Session started';
      case 'session_end': return 'Session ended';
      case 'message_received': return `Received message via ${event.data.channel || 'unknown'}`;
      case 'message_sent': return `Sent reply via ${event.data.channel || 'unknown'}`;
      case 'tool_call_start': return `Called ${event.data.toolName || event.data.toolId}`;
      case 'tool_call_end': return `${event.data.toolName || event.data.toolId} completed (${event.data.durationMs}ms)`;
      case 'tool_call_error': return `${event.data.toolName || event.data.toolId} failed: ${event.data.error}`;
      case 'tool_blocked': return `Blocked: ${event.data.toolName || event.data.toolId}`;
      case 'email_received': return 'Received email';
      case 'email_sent': return 'Sent email';
      case 'error': return `Error: ${event.data.message || 'Unknown'}`;
      case 'heartbeat': return 'Heartbeat check';
      default: return event.type;
    }
  }
}
