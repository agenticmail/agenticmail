/**
 * Multi-Tenant Isolation (OPTIONAL)
 *
 * For SaaS deployments: Companies sharing infrastructure need strict separation.
 * For self-hosted / open-source: Single-tenant mode uses a default org with no limits.
 *
 * - Data isolation (each org sees only their data)
 * - Resource quotas (CPU, memory, API calls per org)
 * - Billing boundaries
 * - Network isolation between agents from different orgs
 *
 * When running single-tenant (open-source), call:
 *   tenants.createDefaultOrg() → creates one org with self-hosted (unlimited) plan
 */

// ─── Types ──────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;                      // URL-safe identifier
  plan: OrgPlan;
  
  // Limits
  limits: OrgLimits;
  
  // Usage (current period)
  usage: OrgUsage;
  
  // Auth
  ssoConfig?: SSOConfig;
  allowedDomains: string[];          // Auto-join for these email domains
  
  // Billing
  billing?: {
    customerId: string;              // Stripe/billing provider ID
    subscriptionId?: string;
    currentPeriodEnd: string;
  };
  
  // Settings
  settings: {
    defaultModel: string;
    defaultPermissionProfile: string;
    requireApprovalForDeploy: boolean;
    auditRetentionDays: number;
    dataRegion: string;              // Where data is stored
    customDomain?: string;           // company.agenticmail.cloud or custom
  };

  createdAt: string;
  updatedAt: string;
}

export type OrgPlan = 'free' | 'team' | 'enterprise' | 'self-hosted';

export interface OrgLimits {
  maxAgents: number;                 // Free: 3, Team: 25, Enterprise: unlimited
  maxUsers: number;                  // Free: 5, Team: 50, Enterprise: unlimited
  maxKnowledgeBases: number;
  maxDocumentsPerKB: number;
  maxStorageMb: number;
  tokenBudgetMonthly: number;       // 0 = unlimited
  apiCallsPerMinute: number;
  deploymentTargets: string[];       // Which targets are allowed
  features: OrgFeature[];
}

export type OrgFeature =
  | 'custom-skills'                 // Can create custom skills
  | 'sso'                           // SAML/OIDC SSO
  | 'audit-export'                  // Export audit logs
  | 'api-access'                    // REST API keys
  | 'webhooks'                      // Webhook integrations
  | 'custom-domain'                 // Custom domain
  | 'priority-support'
  | 'sla'                           // SLA guarantees
  | 'data-residency'               // Choose data region
  | 'ip-allowlist'                  // IP-based access control
  | 'approval-workflows'
  | 'knowledge-base'
  | 'multi-deploy'                  // Deploy to multiple targets
  | 'white-label';                  // Remove AgenticMail branding

export interface OrgUsage {
  agents: number;
  users: number;
  tokensThisMonth: number;
  costThisMonth: number;
  storageMb: number;
  apiCallsToday: number;
  deploymentsThisMonth: number;
  lastUpdated: string;
}

export interface SSOConfig {
  provider: 'saml' | 'oidc';
  issuerUrl: string;
  clientId?: string;
  clientSecret?: string;
  certificate?: string;
  metadataUrl?: string;
  allowedGroups?: string[];         // Only these IdP groups can access
  roleMapping?: Record<string, string>;  // IdP group → org role
}

// ─── Plan Definitions ───────────────────────────────────

export const PLAN_LIMITS: Record<OrgPlan, OrgLimits> = {
  free: {
    maxAgents: 3,
    maxUsers: 5,
    maxKnowledgeBases: 1,
    maxDocumentsPerKB: 10,
    maxStorageMb: 100,
    tokenBudgetMonthly: 1_000_000,
    apiCallsPerMinute: 30,
    deploymentTargets: ['docker', 'local'],
    features: ['knowledge-base'],
  },
  team: {
    maxAgents: 25,
    maxUsers: 50,
    maxKnowledgeBases: 10,
    maxDocumentsPerKB: 100,
    maxStorageMb: 5_000,
    tokenBudgetMonthly: 10_000_000,
    apiCallsPerMinute: 120,
    deploymentTargets: ['docker', 'vps', 'fly', 'railway', 'local'],
    features: ['knowledge-base', 'api-access', 'webhooks', 'approval-workflows', 'sso', 'audit-export', 'custom-skills'],
  },
  enterprise: {
    maxAgents: 999_999,
    maxUsers: 999_999,
    maxKnowledgeBases: 999,
    maxDocumentsPerKB: 10_000,
    maxStorageMb: 100_000,
    tokenBudgetMonthly: 0,          // Unlimited
    apiCallsPerMinute: 600,
    deploymentTargets: ['docker', 'vps', 'fly', 'railway', 'aws', 'gcp', 'azure', 'local'],
    features: ['knowledge-base', 'api-access', 'webhooks', 'approval-workflows', 'sso', 'audit-export', 'custom-skills', 'custom-domain', 'priority-support', 'sla', 'data-residency', 'ip-allowlist', 'multi-deploy', 'white-label'],
  },
  'self-hosted': {
    maxAgents: 999_999,
    maxUsers: 999_999,
    maxKnowledgeBases: 999,
    maxDocumentsPerKB: 10_000,
    maxStorageMb: 999_999,
    tokenBudgetMonthly: 0,
    apiCallsPerMinute: 999,
    deploymentTargets: ['docker', 'vps', 'fly', 'railway', 'aws', 'gcp', 'azure', 'local'],
    features: ['knowledge-base', 'api-access', 'webhooks', 'approval-workflows', 'sso', 'audit-export', 'custom-skills', 'custom-domain', 'data-residency', 'ip-allowlist', 'multi-deploy', 'white-label'],
  },
};

// ─── Tenant Manager ─────────────────────────────────────

export class TenantManager {
  private orgs = new Map<string, Organization>();

  /**
   * Create a new organization
   */
  createOrg(opts: {
    name: string;
    slug: string;
    plan: OrgPlan;
    adminEmail: string;
    settings?: Partial<Organization['settings']>;
  }): Organization {
    if (this.orgs.has(opts.slug)) {
      throw new Error(`Organization slug "${opts.slug}" already exists`);
    }

    const limits = { ...PLAN_LIMITS[opts.plan] };

    const org: Organization = {
      id: crypto.randomUUID(),
      name: opts.name,
      slug: opts.slug,
      plan: opts.plan,
      limits,
      usage: {
        agents: 0, users: 1, tokensThisMonth: 0, costThisMonth: 0,
        storageMb: 0, apiCallsToday: 0, deploymentsThisMonth: 0,
        lastUpdated: new Date().toISOString(),
      },
      allowedDomains: [],
      settings: {
        defaultModel: 'anthropic/claude-sonnet-4-20250514',
        defaultPermissionProfile: 'Customer Support Agent',
        requireApprovalForDeploy: true,
        auditRetentionDays: opts.plan === 'free' ? 30 : opts.plan === 'team' ? 90 : 365,
        dataRegion: 'us-east-1',
        ...opts.settings,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.orgs.set(org.id, org);
    return org;
  }

  /**
   * Check if an org can perform an action (within limits)
   */
  checkLimit(orgId: string, resource: keyof OrgLimits, currentCount?: number): {
    allowed: boolean;
    limit: number;
    current: number;
    remaining: number;
  } {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Organization ${orgId} not found`);

    const limit = org.limits[resource];
    if (typeof limit !== 'number') return { allowed: true, limit: 0, current: 0, remaining: 0 };

    let current = currentCount ?? 0;
    if (!currentCount) {
      // Infer current from usage
      switch (resource) {
        case 'maxAgents': current = org.usage.agents; break;
        case 'maxUsers': current = org.usage.users; break;
        case 'tokenBudgetMonthly': current = org.usage.tokensThisMonth; break;
        case 'maxStorageMb': current = org.usage.storageMb; break;
      }
    }

    const remaining = Math.max(0, (limit as number) - current);
    return {
      allowed: limit === 0 || current < (limit as number),  // 0 = unlimited
      limit: limit as number,
      current,
      remaining,
    };
  }

  /**
   * Check if an org has a specific feature
   */
  hasFeature(orgId: string, feature: OrgFeature): boolean {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    return org.limits.features.includes(feature);
  }

  /**
   * Check if a deployment target is allowed for this org's plan
   */
  canDeployTo(orgId: string, target: string): boolean {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    return org.limits.deploymentTargets.includes(target);
  }

  /**
   * Record usage (tokens, API calls, etc.)
   */
  recordUsage(orgId: string, update: Partial<OrgUsage>) {
    const org = this.orgs.get(orgId);
    if (!org) return;

    if (update.tokensThisMonth) org.usage.tokensThisMonth += update.tokensThisMonth;
    if (update.costThisMonth) org.usage.costThisMonth += update.costThisMonth;
    if (update.apiCallsToday) org.usage.apiCallsToday += update.apiCallsToday;
    if (update.storageMb) org.usage.storageMb = update.storageMb;
    if (update.deploymentsThisMonth) org.usage.deploymentsThisMonth += update.deploymentsThisMonth;
    org.usage.lastUpdated = new Date().toISOString();
  }

  /**
   * Upgrade/downgrade org plan
   */
  changePlan(orgId: string, newPlan: OrgPlan): Organization {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Organization ${orgId} not found`);

    org.plan = newPlan;
    org.limits = { ...PLAN_LIMITS[newPlan] };
    org.updatedAt = new Date().toISOString();

    // Adjust retention based on plan
    org.settings.auditRetentionDays = newPlan === 'free' ? 30 : newPlan === 'team' ? 90 : 365;

    return org;
  }

  getOrg(id: string): Organization | undefined {
    return this.orgs.get(id);
  }

  getOrgBySlug(slug: string): Organization | undefined {
    return Array.from(this.orgs.values()).find(o => o.slug === slug);
  }

  listOrgs(): Organization[] {
    return Array.from(this.orgs.values());
  }

  /**
   * Single-tenant mode: create default org with unlimited (self-hosted) plan.
   * For open-source / self-hosted deployments that don't need multi-tenancy.
   */
  createDefaultOrg(name: string = 'Default'): Organization {
    const existing = this.getOrgBySlug('default');
    if (existing) return existing;
    return this.createOrg({
      name,
      slug: 'default',
      plan: 'self-hosted',
      adminEmail: 'admin@localhost',
      settings: { requireApprovalForDeploy: false },
    });
  }

  /**
   * Is this a single-tenant deployment?
   */
  isSingleTenant(): boolean {
    const orgs = this.listOrgs();
    return orgs.length === 1 && orgs[0].slug === 'default';
  }

  /**
   * Reset daily counters for all orgs
   */
  resetDailyCounters() {
    for (const org of this.orgs.values()) {
      org.usage.apiCallsToday = 0;
    }
  }

  /**
   * Reset monthly counters for all orgs
   */
  resetMonthlyCounters() {
    for (const org of this.orgs.values()) {
      org.usage.tokensThisMonth = 0;
      org.usage.costThisMonth = 0;
      org.usage.deploymentsThisMonth = 0;
    }
  }
}
