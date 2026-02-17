/**
 * Enterprise Engine — Public API
 *
 * The engine that powers enterprise agent deployment:
 * 1. Skill Registry + Permission Engine — what tools can each agent use
 * 2. Agent Config Generator — workspace files, gateway config, deploy scripts
 * 3. Deployment Engine — Docker, VPS, Fly.io, Railway provisioning
 * 4. Approval Workflow — human-in-the-loop for sensitive operations
 */

export {
  // Skill & Permission System
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

export {
  // Agent Configuration
  AgentConfigGenerator,
  type AgentConfig,
  type ChannelConfig,
  type DeploymentTarget,
  type DeploymentConfig,
  type DeploymentStatus,
  type WorkspaceFiles,
  type GatewayConfig,
} from './agent-config.js';

export {
  // Deployment Engine
  DeploymentEngine,
  type DeploymentEvent,
  type DeploymentPhase,
  type DeploymentResult,
  type LiveAgentStatus,
} from './deployer.js';

export {
  // Approval Workflows
  ApprovalEngine,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalPolicy,
} from './approvals.js';
