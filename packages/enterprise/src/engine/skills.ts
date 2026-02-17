/**
 * Skill & Tool Registry + Permission Engine
 *
 * This is the core of enterprise: companies control exactly what their
 * AI agents can and cannot do. Every skill and tool is cataloged,
 * categorized, and gated behind permissions.
 */

// ─── Types ──────────────────────────────────────────────

export interface SkillDefinition {
  id: string;                    // e.g. "github", "imsg", "browser"
  name: string;                  // Human-readable: "GitHub"
  description: string;           // What it does
  category: SkillCategory;
  risk: RiskLevel;               // How dangerous is this skill
  tools: ToolDefinition[];       // Tools this skill provides
  requires?: string[];           // System requirements (e.g. "macos", "docker", "node")
  configSchema?: Record<string, ConfigField>;  // Skill-specific config fields
  icon?: string;                 // Emoji or icon URL
  source?: 'builtin' | 'clawhub' | 'custom';
  version?: string;
  author?: string;
}

export interface ToolDefinition {
  id: string;                    // e.g. "exec", "web_search", "agenticmail_send"
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  skillId: string;               // Parent skill
  parameters?: Record<string, any>;
  sideEffects: SideEffect[];     // What external effects can this tool cause
}

export interface ConfigField {
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  label: string;
  description?: string;
  required?: boolean;
  default?: any;
  options?: { label: string; value: string }[];  // For select type
}

export type SkillCategory =
  | 'communication'    // Email, SMS, messaging
  | 'development'      // GitHub, coding, git
  | 'productivity'     // Calendar, notes, reminders, tasks
  | 'research'         // Web search, web fetch, summarize
  | 'media'            // Image gen, TTS, video, audio
  | 'automation'       // Browser, shell, scripting
  | 'smart-home'       // Hue, Sonos, cameras, Eight Sleep
  | 'data'             // Files, databases, storage
  | 'security'         // 1Password, healthcheck
  | 'social'           // Twitter/X, social media
  | 'platform';        // Core OpenClaw/AgenticMail internals

export type ToolCategory =
  | 'read'             // Read-only, no side effects
  | 'write'            // Creates or modifies data
  | 'execute'          // Runs code/commands
  | 'communicate'      // Sends messages externally
  | 'destroy';         // Deletes data

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type SideEffect =
  | 'sends-email'
  | 'sends-message'
  | 'sends-sms'
  | 'posts-social'
  | 'runs-code'
  | 'modifies-files'
  | 'deletes-data'
  | 'network-request'
  | 'controls-device'
  | 'accesses-secrets'
  | 'financial';

// ─── Agent Permission Profile ───────────────────────────

export interface AgentPermissionProfile {
  id: string;
  name: string;                  // e.g. "Customer Support Agent", "Research Agent"
  description?: string;
  
  // Skill-level controls
  skills: {
    mode: 'allowlist' | 'blocklist';   // Allow only listed, or allow all except listed
    list: string[];                     // Skill IDs
  };
  
  // Tool-level overrides (more granular than skill-level)
  tools: {
    blocked: string[];                 // Always block these tools even if skill is allowed
    allowed: string[];                 // Always allow these tools even if skill is blocked
  };
  
  // Risk threshold — auto-block tools above this level
  maxRiskLevel: RiskLevel;
  
  // Side-effect restrictions
  blockedSideEffects: SideEffect[];    // Block any tool with these side effects
  
  // Approval workflows
  requireApproval: {
    enabled: boolean;
    forRiskLevels: RiskLevel[];        // Which risk levels need human approval
    forSideEffects: SideEffect[];      // Which side effects need approval
    approvers: string[];               // User IDs who can approve
    timeoutMinutes: number;            // Auto-deny after timeout
  };
  
  // Rate limits
  rateLimits: {
    toolCallsPerMinute: number;
    toolCallsPerHour: number;
    toolCallsPerDay: number;
    externalActionsPerHour: number;    // Actions with side effects
  };
  
  // Execution constraints
  constraints: {
    maxConcurrentTasks: number;
    maxSessionDurationMinutes: number;
    allowedWorkingHours?: { start: string; end: string; timezone: string };
    allowedIPs?: string[];             // Restrict to specific networks
    sandboxMode: boolean;              // If true, all external actions are simulated
  };

  createdAt: string;
  updatedAt: string;
}

// ─── Preset Permission Profiles ─────────────────────────

export const PRESET_PROFILES: Omit<AgentPermissionProfile, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Research Assistant',
    description: 'Can search the web, read files, and summarize content. Cannot send messages, run code, or modify anything.',
    skills: { mode: 'allowlist', list: ['research', 'summarize', 'data-read'] },
    tools: { blocked: ['exec', 'write', 'edit'], allowed: ['web_search', 'web_fetch', 'read', 'memory_search', 'memory_get'] },
    maxRiskLevel: 'low',
    blockedSideEffects: ['sends-email', 'sends-message', 'sends-sms', 'posts-social', 'runs-code', 'modifies-files', 'deletes-data', 'controls-device', 'financial'],
    requireApproval: { enabled: false, forRiskLevels: [], forSideEffects: [], approvers: [], timeoutMinutes: 30 },
    rateLimits: { toolCallsPerMinute: 30, toolCallsPerHour: 500, toolCallsPerDay: 5000, externalActionsPerHour: 0 },
    constraints: { maxConcurrentTasks: 3, maxSessionDurationMinutes: 480, sandboxMode: false },
  },
  {
    name: 'Customer Support Agent',
    description: 'Can read/send emails, search knowledge base, and manage tickets. Cannot run code or access files.',
    skills: { mode: 'allowlist', list: ['communication', 'research', 'agenticmail'] },
    tools: { blocked: ['exec', 'browser', 'write', 'edit'], allowed: ['agenticmail_send', 'agenticmail_reply', 'agenticmail_inbox', 'agenticmail_read', 'agenticmail_search', 'web_search', 'web_fetch'] },
    maxRiskLevel: 'medium',
    blockedSideEffects: ['runs-code', 'modifies-files', 'deletes-data', 'controls-device', 'financial', 'posts-social'],
    requireApproval: { enabled: true, forRiskLevels: ['high', 'critical'], forSideEffects: ['sends-email'], approvers: [], timeoutMinutes: 60 },
    rateLimits: { toolCallsPerMinute: 20, toolCallsPerHour: 300, toolCallsPerDay: 3000, externalActionsPerHour: 50 },
    constraints: { maxConcurrentTasks: 5, maxSessionDurationMinutes: 480, sandboxMode: false },
  },
  {
    name: 'Developer Assistant',
    description: 'Full development capabilities: code, git, GitHub, shell. Cannot send external messages or access smart home.',
    skills: { mode: 'allowlist', list: ['development', 'github', 'coding-agent', 'research', 'data'] },
    tools: { blocked: ['agenticmail_send', 'message', 'tts', 'nodes'], allowed: ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser'] },
    maxRiskLevel: 'high',
    blockedSideEffects: ['sends-email', 'sends-message', 'sends-sms', 'posts-social', 'controls-device', 'financial'],
    requireApproval: { enabled: true, forRiskLevels: ['critical'], forSideEffects: [], approvers: [], timeoutMinutes: 15 },
    rateLimits: { toolCallsPerMinute: 60, toolCallsPerHour: 1000, toolCallsPerDay: 10000, externalActionsPerHour: 100 },
    constraints: { maxConcurrentTasks: 3, maxSessionDurationMinutes: 720, sandboxMode: false },
  },
  {
    name: 'Full Access (Owner)',
    description: 'Unrestricted access to all skills and tools. Use with caution.',
    skills: { mode: 'blocklist', list: [] },
    tools: { blocked: [], allowed: [] },
    maxRiskLevel: 'critical',
    blockedSideEffects: [],
    requireApproval: { enabled: false, forRiskLevels: [], forSideEffects: [], approvers: [], timeoutMinutes: 30 },
    rateLimits: { toolCallsPerMinute: 120, toolCallsPerHour: 5000, toolCallsPerDay: 50000, externalActionsPerHour: 500 },
    constraints: { maxConcurrentTasks: 10, maxSessionDurationMinutes: 1440, sandboxMode: false },
  },
  {
    name: 'Sandbox (Testing)',
    description: 'All tools available but in simulation mode. No real external actions are taken.',
    skills: { mode: 'blocklist', list: [] },
    tools: { blocked: [], allowed: [] },
    maxRiskLevel: 'critical',
    blockedSideEffects: [],
    requireApproval: { enabled: false, forRiskLevels: [], forSideEffects: [], approvers: [], timeoutMinutes: 30 },
    rateLimits: { toolCallsPerMinute: 60, toolCallsPerHour: 1000, toolCallsPerDay: 10000, externalActionsPerHour: 500 },
    constraints: { maxConcurrentTasks: 5, maxSessionDurationMinutes: 480, sandboxMode: true },
  },
];

// ─── Built-in Skill Catalog ─────────────────────────────

export const BUILTIN_SKILLS: Omit<SkillDefinition, 'tools'>[] = [
  // Communication
  { id: 'agenticmail', name: 'AgenticMail', description: 'Full email system — send, receive, organize, search, forward, reply. Agent-to-agent messaging and task delegation.', category: 'communication', risk: 'medium', icon: '📧', source: 'builtin' },
  { id: 'imsg', name: 'iMessage', description: 'Send and receive iMessages and SMS via macOS.', category: 'communication', risk: 'high', icon: '💬', source: 'builtin', requires: ['macos'] },
  { id: 'wacli', name: 'WhatsApp', description: 'Send WhatsApp messages and search chat history.', category: 'communication', risk: 'high', icon: '📱', source: 'builtin' },

  // Development
  { id: 'github', name: 'GitHub', description: 'Manage issues, PRs, CI runs, and repositories via gh CLI.', category: 'development', risk: 'medium', icon: '🐙', source: 'builtin' },
  { id: 'coding-agent', name: 'Coding Agent', description: 'Run Codex CLI, Claude Code, or other coding agents as background processes.', category: 'development', risk: 'high', icon: '💻', source: 'builtin' },

  // Productivity
  { id: 'gog', name: 'Google Workspace', description: 'Gmail, Calendar, Drive, Contacts, Sheets, and Docs.', category: 'productivity', risk: 'medium', icon: '📅', source: 'builtin' },
  { id: 'apple-notes', name: 'Apple Notes', description: 'Create, search, edit, and manage Apple Notes.', category: 'productivity', risk: 'low', icon: '📝', source: 'builtin', requires: ['macos'] },
  { id: 'apple-reminders', name: 'Apple Reminders', description: 'Manage Apple Reminders lists and items.', category: 'productivity', risk: 'low', icon: '✅', source: 'builtin', requires: ['macos'] },
  { id: 'bear-notes', name: 'Bear Notes', description: 'Create, search, and manage Bear notes.', category: 'productivity', risk: 'low', icon: '🐻', source: 'builtin', requires: ['macos'] },
  { id: 'obsidian', name: 'Obsidian', description: 'Work with Obsidian vaults and automate via CLI.', category: 'productivity', risk: 'low', icon: '💎', source: 'builtin' },
  { id: 'things-mac', name: 'Things 3', description: 'Manage tasks and projects in Things 3.', category: 'productivity', risk: 'low', icon: '☑️', source: 'builtin', requires: ['macos'] },

  // Research
  { id: 'web-search', name: 'Web Search', description: 'Search the web via Brave Search API.', category: 'research', risk: 'low', icon: '🔍', source: 'builtin' },
  { id: 'web-fetch', name: 'Web Fetch', description: 'Fetch and extract readable content from URLs.', category: 'research', risk: 'low', icon: '🌐', source: 'builtin' },
  { id: 'summarize', name: 'Summarize', description: 'Summarize or transcribe URLs, podcasts, and files.', category: 'research', risk: 'low', icon: '📄', source: 'builtin' },
  { id: 'blogwatcher', name: 'Blog Watcher', description: 'Monitor blogs and RSS/Atom feeds for updates.', category: 'research', risk: 'low', icon: '📡', source: 'builtin' },

  // Media
  { id: 'openai-image-gen', name: 'Image Generation', description: 'Generate images via OpenAI Images API.', category: 'media', risk: 'low', icon: '🎨', source: 'builtin' },
  { id: 'nano-banana-pro', name: 'Gemini Image', description: 'Generate or edit images via Gemini 3 Pro.', category: 'media', risk: 'low', icon: '🖼️', source: 'builtin' },
  { id: 'tts', name: 'Text-to-Speech', description: 'Convert text to speech audio.', category: 'media', risk: 'low', icon: '🔊', source: 'builtin' },
  { id: 'openai-whisper', name: 'Whisper Transcription', description: 'Transcribe audio via OpenAI Whisper API.', category: 'media', risk: 'low', icon: '🎙️', source: 'builtin' },
  { id: 'video-frames', name: 'Video Frames', description: 'Extract frames or clips from videos.', category: 'media', risk: 'low', icon: '🎬', source: 'builtin' },
  { id: 'gifgrep', name: 'GIF Search', description: 'Search and download GIFs.', category: 'media', risk: 'low', icon: '🎭', source: 'builtin' },

  // Automation
  { id: 'browser', name: 'Browser Control', description: 'Automate web browsers — navigate, click, type, screenshot.', category: 'automation', risk: 'high', icon: '🌍', source: 'builtin' },
  { id: 'exec', name: 'Shell Commands', description: 'Execute shell commands on the host machine.', category: 'automation', risk: 'critical', icon: '⚡', source: 'builtin' },
  { id: 'peekaboo', name: 'macOS UI Automation', description: 'Capture and automate macOS UI with Peekaboo.', category: 'automation', risk: 'high', icon: '👁️', source: 'builtin', requires: ['macos'] },
  { id: 'cron', name: 'Scheduled Tasks', description: 'Create and manage cron jobs and reminders.', category: 'automation', risk: 'medium', icon: '⏰', source: 'builtin' },

  // Smart Home
  { id: 'openhue', name: 'Philips Hue', description: 'Control Hue lights and scenes.', category: 'smart-home', risk: 'low', icon: '💡', source: 'builtin' },
  { id: 'sonoscli', name: 'Sonos', description: 'Control Sonos speakers.', category: 'smart-home', risk: 'low', icon: '🔈', source: 'builtin' },
  { id: 'blucli', name: 'BluOS', description: 'Control BluOS speakers.', category: 'smart-home', risk: 'low', icon: '🎵', source: 'builtin' },
  { id: 'eightctl', name: 'Eight Sleep', description: 'Control Eight Sleep pod temperature and alarms.', category: 'smart-home', risk: 'low', icon: '🛏️', source: 'builtin' },
  { id: 'camsnap', name: 'IP Cameras', description: 'Capture frames from RTSP/ONVIF cameras.', category: 'smart-home', risk: 'medium', icon: '📷', source: 'builtin' },

  // Data
  { id: 'files', name: 'File System', description: 'Read, write, and edit files on the host.', category: 'data', risk: 'medium', icon: '📁', source: 'builtin' },
  { id: 'memory', name: 'Agent Memory', description: 'Persistent memory search and storage.', category: 'data', risk: 'low', icon: '🧠', source: 'builtin' },

  // Security
  { id: '1password', name: '1Password', description: 'Read and manage secrets via 1Password CLI.', category: 'security', risk: 'critical', icon: '🔐', source: 'builtin' },
  { id: 'healthcheck', name: 'Security Audit', description: 'Host security hardening and risk checks.', category: 'security', risk: 'medium', icon: '🛡️', source: 'builtin' },

  // Social
  { id: 'twitter', name: 'Twitter/X', description: 'Post tweets, read timeline, manage social presence.', category: 'social', risk: 'high', icon: '🐦', source: 'builtin' },

  // Platform
  { id: 'gateway', name: 'OpenClaw Gateway', description: 'Restart, configure, and update the OpenClaw gateway.', category: 'platform', risk: 'critical', icon: '⚙️', source: 'builtin' },
  { id: 'sessions', name: 'Session Management', description: 'Spawn sub-agents, list sessions, send messages between sessions.', category: 'platform', risk: 'medium', icon: '🔄', source: 'builtin' },
  { id: 'nodes', name: 'Node Control', description: 'Discover and control paired devices (camera, screen, location).', category: 'platform', risk: 'high', icon: '📡', source: 'builtin' },
];

// ─── Permission Engine ──────────────────────────────────

export class PermissionEngine {
  private skills: Map<string, SkillDefinition> = new Map();
  private profiles: Map<string, AgentPermissionProfile> = new Map();

  constructor(skills?: SkillDefinition[]) {
    if (skills) {
      for (const s of skills) this.skills.set(s.id, s);
    }
  }

  registerSkill(skill: SkillDefinition) {
    this.skills.set(skill.id, skill);
  }

  setProfile(agentId: string, profile: AgentPermissionProfile) {
    this.profiles.set(agentId, profile);
  }

  getProfile(agentId: string): AgentPermissionProfile | undefined {
    return this.profiles.get(agentId);
  }

  /**
   * Core permission check: Can this agent use this tool right now?
   * Returns { allowed, reason, requiresApproval }
   */
  checkPermission(
    agentId: string,
    toolId: string,
    context?: { timestamp?: Date; ip?: string }
  ): PermissionResult {
    const profile = this.profiles.get(agentId);
    if (!profile) {
      return { allowed: false, reason: 'No permission profile assigned', requiresApproval: false };
    }

    // 1. Check sandbox mode
    if (profile.constraints.sandboxMode) {
      return { allowed: true, reason: 'Sandbox mode — action will be simulated', requiresApproval: false, sandbox: true };
    }

    // 2. Check working hours
    if (profile.constraints.allowedWorkingHours) {
      const now = context?.timestamp || new Date();
      const { start, end, timezone } = profile.constraints.allowedWorkingHours;
      const hour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(now));
      const startHour = parseInt(start.split(':')[0]);
      const endHour = parseInt(end.split(':')[0]);
      if (hour < startHour || hour >= endHour) {
        return { allowed: false, reason: `Outside working hours (${start}-${end} ${timezone})`, requiresApproval: false };
      }
    }

    // 3. Check IP restrictions
    if (profile.constraints.allowedIPs?.length && context?.ip) {
      if (!profile.constraints.allowedIPs.includes(context.ip)) {
        return { allowed: false, reason: `IP ${context.ip} not in allowlist`, requiresApproval: false };
      }
    }

    // 4. Tool-level explicit overrides (highest priority)
    if (profile.tools.blocked.includes(toolId)) {
      return { allowed: false, reason: `Tool "${toolId}" is explicitly blocked`, requiresApproval: false };
    }
    if (profile.tools.allowed.includes(toolId)) {
      // Explicitly allowed — skip skill checks, but still check approval requirements
      return this._checkApproval(profile, toolId);
    }

    // 5. Find which skill this tool belongs to
    const tool = this._findTool(toolId);
    if (!tool) {
      // Unknown tool — block by default
      return { allowed: false, reason: `Unknown tool "${toolId}"`, requiresApproval: false };
    }

    // 6. Skill-level check
    const skillAllowed = profile.skills.mode === 'allowlist'
      ? profile.skills.list.includes(tool.skillId)
      : !profile.skills.list.includes(tool.skillId);

    if (!skillAllowed) {
      return { allowed: false, reason: `Skill "${tool.skillId}" is not permitted`, requiresApproval: false };
    }

    // 7. Risk level check
    const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const toolRiskIdx = riskOrder.indexOf(tool.risk);
    const maxRiskIdx = riskOrder.indexOf(profile.maxRiskLevel);
    if (toolRiskIdx > maxRiskIdx) {
      return { allowed: false, reason: `Tool risk "${tool.risk}" exceeds max allowed "${profile.maxRiskLevel}"`, requiresApproval: false };
    }

    // 8. Side-effect restrictions
    for (const effect of tool.sideEffects) {
      if (profile.blockedSideEffects.includes(effect)) {
        return { allowed: false, reason: `Side effect "${effect}" is blocked`, requiresApproval: false };
      }
    }

    // 9. Check if approval is required
    return this._checkApproval(profile, toolId, tool);
  }

  private _checkApproval(profile: AgentPermissionProfile, toolId: string, tool?: ToolDefinition): PermissionResult {
    if (!profile.requireApproval.enabled) {
      return { allowed: true, reason: 'Permitted', requiresApproval: false };
    }

    if (tool) {
      // Check risk-level approval
      if (profile.requireApproval.forRiskLevels.includes(tool.risk)) {
        return { allowed: true, reason: 'Requires human approval (risk level)', requiresApproval: true };
      }
      // Check side-effect approval
      for (const effect of tool.sideEffects) {
        if (profile.requireApproval.forSideEffects.includes(effect)) {
          return { allowed: true, reason: `Requires human approval (${effect})`, requiresApproval: true };
        }
      }
    }

    return { allowed: true, reason: 'Permitted', requiresApproval: false };
  }

  private _findTool(toolId: string): ToolDefinition | undefined {
    // Check registered skills first
    for (const skill of this.skills.values()) {
      const tool = skill.tools.find(t => t.id === toolId);
      if (tool) return tool;
    }
    // Fall back to global tool index (real OpenClaw + AgenticMail tools)
    try {
      const { TOOL_INDEX } = require('./tool-catalog.js');
      return TOOL_INDEX.get(toolId);
    } catch {
      return undefined;
    }
  }

  /**
   * Get the full resolved tool list for an agent — what they can actually use
   */
  getAvailableTools(agentId: string): { tool: ToolDefinition; status: 'allowed' | 'approval-required' | 'sandbox' }[] {
    const result: { tool: ToolDefinition; status: 'allowed' | 'approval-required' | 'sandbox' }[] = [];

    for (const skill of this.skills.values()) {
      for (const tool of skill.tools) {
        const perm = this.checkPermission(agentId, tool.id);
        if (perm.allowed) {
          result.push({
            tool,
            status: perm.sandbox ? 'sandbox' : perm.requiresApproval ? 'approval-required' : 'allowed',
          });
        }
      }
    }

    return result;
  }

  /**
   * Generate the OpenClaw tool policy config for an agent based on their profile
   */
  generateToolPolicy(agentId: string): {
    allowedTools: string[];
    blockedTools: string[];
    approvalRequired: string[];
    rateLimits: AgentPermissionProfile['rateLimits'];
  } {
    const profile = this.profiles.get(agentId);
    if (!profile) return { allowedTools: [], blockedTools: [], approvalRequired: [], rateLimits: { toolCallsPerMinute: 10, toolCallsPerHour: 100, toolCallsPerDay: 1000, externalActionsPerHour: 10 } };

    const allowed: string[] = [];
    const blocked: string[] = [];
    const approval: string[] = [];

    for (const skill of this.skills.values()) {
      for (const tool of skill.tools) {
        const perm = this.checkPermission(agentId, tool.id);
        if (perm.allowed) {
          allowed.push(tool.id);
          if (perm.requiresApproval) approval.push(tool.id);
        } else {
          blocked.push(tool.id);
        }
      }
    }

    return { allowedTools: allowed, blockedTools: blocked, approvalRequired: approval, rateLimits: profile.rateLimits };
  }

  getAllSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  getSkillsByCategory(): Record<SkillCategory, SkillDefinition[]> {
    const result = {} as Record<SkillCategory, SkillDefinition[]>;
    for (const skill of this.skills.values()) {
      if (!result[skill.category]) result[skill.category] = [];
      result[skill.category].push(skill);
    }
    return result;
  }
}

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  sandbox?: boolean;
}
