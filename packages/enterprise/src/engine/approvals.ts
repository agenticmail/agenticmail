/**
 * Approval Workflow Engine
 *
 * Human-in-the-loop for sensitive agent operations.
 * When a tool requires approval (based on risk level or side effects),
 * the engine queues the request and notifies approvers.
 */

// ─── Types ──────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  toolId: string;
  toolName: string;
  reason: string;                    // Why approval is needed
  riskLevel: string;
  sideEffects: string[];
  parameters?: Record<string, any>; // What the agent wants to do (sanitized)
  context?: string;                  // Brief description of what the agent is working on
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decision?: ApprovalDecision;
  createdAt: string;
  expiresAt: string;                 // Auto-deny after this
}

export interface ApprovalDecision {
  by: string;                        // User ID of approver
  action: 'approve' | 'deny';
  reason?: string;                   // Optional reason for deny
  timestamp: string;
  conditions?: string;               // "Approved with conditions: ..."
}

export interface ApprovalPolicy {
  id: string;
  name: string;
  description?: string;

  // What triggers this policy
  triggers: {
    riskLevels?: string[];
    sideEffects?: string[];
    toolIds?: string[];              // Specific tools
    allExternalActions?: boolean;    // Any action with side effects
  };

  // Who can approve
  approvers: {
    userIds: string[];               // Specific users
    roles: string[];                 // Any user with these roles
    requireMultiple?: number;        // Require N approvals (default: 1)
  };

  // Timing
  timeout: {
    minutes: number;
    defaultAction: 'deny' | 'allow'; // What happens on timeout
  };

  // Notification
  notify: {
    channels: ('email' | 'slack' | 'webhook')[];
    webhookUrl?: string;
    slackChannel?: string;
  };

  enabled: boolean;
}

// ─── Engine ─────────────────────────────────────────────

export class ApprovalEngine {
  private requests = new Map<string, ApprovalRequest>();
  private policies: ApprovalPolicy[] = [];
  private listeners: ((req: ApprovalRequest) => void)[] = [];

  addPolicy(policy: ApprovalPolicy) {
    this.policies.push(policy);
  }

  removePolicy(id: string) {
    this.policies = this.policies.filter(p => p.id !== id);
  }

  getPolicies(): ApprovalPolicy[] {
    return [...this.policies];
  }

  /**
   * Check if a tool call needs approval and create a request if so
   */
  async requestApproval(opts: {
    agentId: string;
    agentName: string;
    toolId: string;
    toolName: string;
    riskLevel: string;
    sideEffects: string[];
    parameters?: Record<string, any>;
    context?: string;
  }): Promise<ApprovalRequest | null> {
    // Find matching policy
    const policy = this.findMatchingPolicy(opts.toolId, opts.riskLevel, opts.sideEffects);
    if (!policy) return null; // No approval needed

    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      agentId: opts.agentId,
      agentName: opts.agentName,
      toolId: opts.toolId,
      toolName: opts.toolName,
      reason: `Policy "${policy.name}" requires approval`,
      riskLevel: opts.riskLevel,
      sideEffects: opts.sideEffects,
      parameters: this.sanitizeParams(opts.parameters),
      context: opts.context,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + policy.timeout.minutes * 60_000).toISOString(),
    };

    this.requests.set(request.id, request);

    // Notify approvers
    await this.notifyApprovers(request, policy);

    // Set expiry timer
    setTimeout(() => {
      const req = this.requests.get(request.id);
      if (req && req.status === 'pending') {
        req.status = 'expired';
        if (policy.timeout.defaultAction === 'allow') {
          req.status = 'approved';
          req.decision = {
            by: 'system',
            action: 'approve',
            reason: 'Auto-approved: approval timeout expired',
            timestamp: new Date().toISOString(),
          };
        }
        this.notifyListeners(req);
      }
    }, policy.timeout.minutes * 60_000);

    // Notify listeners
    this.notifyListeners(request);

    return request;
  }

  /**
   * Approve or deny a pending request
   */
  decide(requestId: string, decision: Omit<ApprovalDecision, 'timestamp'>): ApprovalRequest | null {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return null;

    request.status = decision.action === 'approve' ? 'approved' : 'denied';
    request.decision = { ...decision, timestamp: new Date().toISOString() };

    this.notifyListeners(request);
    return request;
  }

  /**
   * Get all pending requests (for the dashboard)
   */
  getPendingRequests(agentId?: string): ApprovalRequest[] {
    const all = Array.from(this.requests.values()).filter(r => r.status === 'pending');
    return agentId ? all.filter(r => r.agentId === agentId) : all;
  }

  /**
   * Get request by ID
   */
  getRequest(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  /**
   * Get history of all requests
   */
  getHistory(opts?: { agentId?: string; limit?: number; offset?: number }): { requests: ApprovalRequest[]; total: number } {
    let all = Array.from(this.requests.values()).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (opts?.agentId) all = all.filter(r => r.agentId === opts.agentId);
    const total = all.length;
    const offset = opts?.offset || 0;
    const limit = opts?.limit || 25;
    return { requests: all.slice(offset, offset + limit), total };
  }

  /**
   * Wait for a specific request to be decided (for sync approval flows)
   */
  async waitForDecision(requestId: string, timeoutMs: number = 300_000): Promise<ApprovalRequest> {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const req = this.requests.get(requestId);
        if (req && req.status !== 'pending') {
          clearInterval(check);
          clearTimeout(timeout);
          resolve(req);
        }
      }, 1000);

      const timeout = setTimeout(() => {
        clearInterval(check);
        const req = this.requests.get(requestId);
        if (req) {
          req.status = 'expired';
          resolve(req);
        } else {
          reject(new Error('Request not found'));
        }
      }, timeoutMs);
    });
  }

  /**
   * Subscribe to approval request changes
   */
  onRequest(listener: (req: ApprovalRequest) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  // ─── Private ──────────────────────────────────────────

  private findMatchingPolicy(toolId: string, riskLevel: string, sideEffects: string[]): ApprovalPolicy | undefined {
    return this.policies.find(p => {
      if (!p.enabled) return false;
      if (p.triggers.toolIds?.includes(toolId)) return true;
      if (p.triggers.riskLevels?.includes(riskLevel)) return true;
      if (p.triggers.sideEffects?.some(e => sideEffects.includes(e))) return true;
      if (p.triggers.allExternalActions && sideEffects.length > 0) return true;
      return false;
    });
  }

  private sanitizeParams(params?: Record<string, any>): Record<string, any> | undefined {
    if (!params) return undefined;
    // Remove sensitive fields
    const sanitized = { ...params };
    for (const key of ['password', 'token', 'secret', 'key', 'apiKey', 'credential']) {
      if (key in sanitized) sanitized[key] = '***';
    }
    return sanitized;
  }

  private async notifyApprovers(request: ApprovalRequest, policy: ApprovalPolicy) {
    for (const channel of policy.notify.channels) {
      switch (channel) {
        case 'webhook':
          if (policy.notify.webhookUrl) {
            try {
              await fetch(policy.notify.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'approval_request', request }),
              });
            } catch { /* fail silently */ }
          }
          break;
        // Email and Slack notifications would integrate with the existing AgenticMail system
      }
    }
  }

  private notifyListeners(request: ApprovalRequest) {
    for (const listener of this.listeners) {
      try { listener(request); } catch { /* ignore */ }
    }
  }
}
