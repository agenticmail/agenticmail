/**
 * Enterprise Engine — Public API
 *
 * The complete engine powering managed OpenClaw+AgenticMail deployment:
 *
 * 1. Skill Registry + Permission Engine — what tools each agent can use
 * 2. Agent Config Generator — workspace files, gateway config, deploy scripts
 * 3. Deployment Engine — Docker, VPS, Fly.io, Railway provisioning
 * 4. Approval Workflows — human-in-the-loop for sensitive operations
 * 5. Agent Lifecycle Manager — state machine, health checks, auto-recovery
 * 6. Knowledge Base — document ingestion, chunking, RAG retrieval
 * 7. Multi-Tenant Isolation — org limits, quotas, billing, plan enforcement
 * 8. Real-Time Activity Tracking — live tool calls, conversations, cost tracking
 */

// 1. Skills & Permissions
export {
  PermissionEngine,
  BUILTIN_SKILLS,
  PRESET_PROFILES,
  type SkillDefinition,
  type ToolDefinition,
  type ConfigField,
  type SkillCategory,
  type ToolCategory,
  type RiskLevel,
  type SideEffect,
  type AgentPermissionProfile,
  type PermissionResult,
} from './skills.js';

// 2. Agent Configuration
export {
  AgentConfigGenerator,
  type AgentConfig,
  type ChannelConfig,
  type DeploymentTarget,
  type DeploymentConfig,
  type DeploymentStatus,
  type WorkspaceFiles,
  type GatewayConfig,
} from './agent-config.js';

// 3. Deployment Engine
export {
  DeploymentEngine,
  type DeploymentEvent,
  type DeploymentPhase,
  type DeploymentResult,
  type LiveAgentStatus,
} from './deployer.js';

// 4. Approval Workflows
export {
  ApprovalEngine,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalPolicy,
} from './approvals.js';

// 5. Agent Lifecycle Manager
export {
  AgentLifecycleManager,
  type ManagedAgent,
  type AgentState,
  type StateTransition,
  type AgentHealth,
  type AgentUsage,
  type LifecycleEvent,
  type LifecycleEventType,
} from './lifecycle.js';

// 6. Knowledge Base
export {
  KnowledgeBaseEngine,
  type KnowledgeBase,
  type KBDocument,
  type KBChunk,
  type KBConfig,
  type SearchResult,
} from './knowledge.js';

// 7. Multi-Tenant Isolation
export {
  TenantManager,
  PLAN_LIMITS,
  type Organization,
  type OrgPlan,
  type OrgLimits,
  type OrgUsage,
  type OrgFeature,
  type SSOConfig,
} from './tenant.js';

// 8. Real-Time Activity Tracking
export {
  ActivityTracker,
  type ActivityEvent,
  type ActivityType,
  type ToolCallRecord,
  type ConversationEntry,
  type AgentTimeline,
  type TimelineEntry,
} from './activity.js';

// 9. Tool Catalog (real OpenClaw + AgenticMail tool IDs)
export {
  OPENCLAW_CORE_TOOLS,
  AGENTICMAIL_TOOLS,
  ALL_TOOLS,
  TOOL_INDEX,
  getToolsBySkill,
  generateOpenClawToolPolicy,
} from './tool-catalog.js';

// 10. Database Persistence + Migration System
export { EngineDatabase, type EngineDB } from './db-adapter.js';
export {
  ENGINE_TABLES,
  ENGINE_TABLES_POSTGRES,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  MIGRATIONS_TABLE_POSTGRES,
  sqliteToPostgres,
  sqliteToMySQL,
  type Migration,
  type DynamicTableDef,
} from './db-schema.js';

// 10. OpenClaw Integration Hook
export { EnterpriseHook, createEnterpriseHook, type EnterpriseHookConfig, type HookResult } from './openclaw-hook.js';

// 11. AgenticMail Bridge
export { AgenticMailBridge, createAgenticMailBridge, type BridgeConfig, type ToolInterceptor } from './agenticmail-bridge.js';
