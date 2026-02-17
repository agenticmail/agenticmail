/**
 * Agent Configuration Builder
 *
 * Generates the full OpenClaw workspace config for a deployed agent:
 * SOUL.md, USER.md, AGENTS.md, HEARTBEAT.md, gateway config, etc.
 * Everything needed to spin up a fully configured agent from the admin dashboard.
 */

// ─── Types ──────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;                    // Human-facing name
  
  // Identity
  identity: {
    personality: string;                  // SOUL.md content — who the agent IS
    role: string;                         // e.g. "Customer Support Lead"
    tone: 'formal' | 'casual' | 'professional' | 'friendly' | 'custom';
    customTone?: string;
    language: string;                     // Primary language (e.g. "en", "es", "fr")
    avatar?: string;                      // URL or base64
  };

  // Model
  model: {
    provider: 'anthropic' | 'openai' | 'google' | 'custom';
    modelId: string;                      // e.g. "claude-sonnet-4-20250514", "gpt-4o"
    thinkingLevel: 'off' | 'low' | 'medium' | 'high';
    temperature?: number;
    maxTokens?: number;
    fallbackModelId?: string;             // Fallback if primary is down
  };

  // Communication channels
  channels: {
    enabled: ChannelConfig[];
    primaryChannel: string;               // Which channel is default
  };

  // Email
  email: {
    enabled: boolean;
    provider: 'relay' | 'domain' | 'none';
    address?: string;                     // e.g. "support@acme.com"
    relayConfig?: { email: string; appPassword: string; provider: 'gmail' | 'outlook' };
    domainConfig?: { domain: string; cloudflareToken: string };
    signature?: string;
    autoReply?: { enabled: boolean; message: string; afterHours: boolean };
  };

  // Workspace
  workspace: {
    persistentMemory: boolean;            // Keep memory across restarts
    memoryMaxSizeMb: number;
    workingDirectory: string;             // Where the agent's files live
    sharedDirectories: string[];          // Directories shared between agents
    gitEnabled: boolean;                  // Auto-commit workspace changes
  };

  // Heartbeat & scheduling
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    checks: string[];                     // What to check: ['email', 'calendar', 'tickets']
  };

  // Context
  context: {
    userInfo?: string;                    // USER.md content — info about the user/company
    customInstructions?: string;          // Additional AGENTS.md instructions
    knowledgeBase?: string[];             // Paths or URLs to reference docs
  };

  // Permission profile
  permissionProfileId: string;

  // Deployment
  deployment: {
    target: DeploymentTarget;
    config: DeploymentConfig;
    status: DeploymentStatus;
  };

  createdAt: string;
  updatedAt: string;
}

export interface ChannelConfig {
  type: 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'email' | 'web' | 'api';
  enabled: boolean;
  config: Record<string, any>;           // Channel-specific config (tokens, webhook URLs, etc.)
}

export type DeploymentTarget = 'docker' | 'vps' | 'fly' | 'railway' | 'aws' | 'gcp' | 'azure' | 'local';

export interface DeploymentConfig {
  // Docker
  docker?: {
    image: string;
    tag: string;
    ports: number[];
    volumes: string[];
    env: Record<string, string>;
    resources: { cpuLimit: string; memoryLimit: string };
    restart: 'always' | 'unless-stopped' | 'on-failure' | 'no';
    network?: string;
  };

  // VPS / bare metal
  vps?: {
    host: string;
    port: number;
    user: string;
    authMethod: 'key' | 'password';
    sshKeyPath?: string;
    installPath: string;                  // Where to install on the VPS
    systemd: boolean;                     // Use systemd for process management
    sudo: boolean;
  };

  // Cloud platforms
  cloud?: {
    provider: 'fly' | 'railway' | 'aws' | 'gcp' | 'azure';
    region: string;
    size: string;                         // Instance size / machine type
    apiToken: string;
    appName?: string;                     // Auto-generated if not set
    customDomain?: string;
  };
}

export type DeploymentStatus =
  | 'not-deployed'
  | 'provisioning'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'error'
  | 'updating';

// ─── Config Generator ───────────────────────────────────

export class AgentConfigGenerator {

  /**
   * Generate the complete workspace files for an agent
   */
  generateWorkspace(config: AgentConfig): WorkspaceFiles {
    return {
      'SOUL.md': this.generateSoul(config),
      'USER.md': this.generateUser(config),
      'AGENTS.md': this.generateAgents(config),
      'IDENTITY.md': this.generateIdentity(config),
      'HEARTBEAT.md': this.generateHeartbeat(config),
      'TOOLS.md': this.generateTools(config),
      'MEMORY.md': `# MEMORY.md — ${config.displayName}'s Long-Term Memory\n\n_Created ${new Date().toISOString()}_\n`,
    };
  }

  /**
   * Generate the OpenClaw gateway config for this agent
   */
  generateGatewayConfig(config: AgentConfig): GatewayConfig {
    const channels: Record<string, any> = {};

    for (const ch of config.channels.enabled) {
      if (!ch.enabled) continue;
      channels[ch.type] = ch.config;
    }

    return {
      model: `${config.model.provider}/${config.model.modelId}`,
      thinking: config.model.thinkingLevel,
      temperature: config.model.temperature,
      maxTokens: config.model.maxTokens,
      channels,
      heartbeat: config.heartbeat.enabled ? {
        intervalMinutes: config.heartbeat.intervalMinutes,
      } : undefined,
      workspace: config.workspace.workingDirectory,
    };
  }

  /**
   * Generate a docker-compose.yml for this agent
   */
  generateDockerCompose(config: AgentConfig): string {
    const dc = config.deployment.config.docker;
    if (!dc) throw new Error('No Docker config');

    const env = { ...dc.env };
    // Inject standard vars
    env['OPENCLAW_MODEL'] = `${config.model.provider}/${config.model.modelId}`;
    env['OPENCLAW_THINKING'] = config.model.thinkingLevel;
    if (config.email.enabled && config.email.address) {
      env['AGENTICMAIL_EMAIL'] = config.email.address;
    }

    const envLines = Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`).join('\n');
    const volumes = dc.volumes.map(v => `      - ${v}`).join('\n');
    const ports = dc.ports.map(p => `      - "${p}:${p}"`).join('\n');

    return `version: "3.8"

services:
  ${config.name}:
    image: ${dc.image}:${dc.tag}
    container_name: agenticmail-${config.name}
    restart: ${dc.restart}
    ports:
${ports}
    volumes:
${volumes}
    environment:
${envLines}
    deploy:
      resources:
        limits:
          cpus: "${dc.resources.cpuLimit}"
          memory: ${dc.resources.memoryLimit}
${dc.network ? `    networks:\n      - ${dc.network}\n\nnetworks:\n  ${dc.network}:\n    external: true` : ''}
`;
  }

  /**
   * Generate a systemd service file for VPS deployment
   */
  generateSystemdUnit(config: AgentConfig): string {
    const vps = config.deployment.config.vps;
    if (!vps) throw new Error('No VPS config');

    return `[Unit]
Description=AgenticMail Agent: ${config.displayName}
After=network.target

[Service]
Type=simple
User=${vps.user}
WorkingDirectory=${vps.installPath}
ExecStart=/usr/bin/env node ${vps.installPath}/node_modules/.bin/openclaw gateway start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=OPENCLAW_MODEL=${config.model.provider}/${config.model.modelId}
Environment=OPENCLAW_THINKING=${config.model.thinkingLevel}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${vps.installPath}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
  }

  /**
   * Generate a deployment script for VPS
   */
  generateVPSDeployScript(config: AgentConfig): string {
    const vps = config.deployment.config.vps;
    if (!vps) throw new Error('No VPS config');

    return `#!/bin/bash
set -euo pipefail

# AgenticMail Agent Deployment Script
# Agent: ${config.displayName}
# Target: ${vps.host}

echo "🚀 Deploying ${config.displayName} to ${vps.host}..."

INSTALL_PATH="${vps.installPath}"
${vps.sudo ? 'SUDO="sudo"' : 'SUDO=""'}

# 1. Install Node.js if needed
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi

# 2. Create workspace
mkdir -p "$INSTALL_PATH/workspace"
cd "$INSTALL_PATH"

# 3. Install OpenClaw + AgenticMail
echo "📦 Installing packages..."
npm init -y 2>/dev/null || true
npm install openclaw agenticmail @agenticmail/core @agenticmail/openclaw

# 4. Write workspace files
echo "📝 Writing agent configuration..."
${Object.entries(this.generateWorkspace(config)).map(([file, content]) =>
  `cat > "$INSTALL_PATH/workspace/${file}" << 'WORKSPACE_EOF'\n${content}\nWORKSPACE_EOF`
).join('\n\n')}

# 5. Write gateway config
cat > "$INSTALL_PATH/config.yaml" << 'CONFIG_EOF'
${JSON.stringify(this.generateGatewayConfig(config), null, 2)}
CONFIG_EOF

# 6. Install systemd service
echo "⚙️ Installing systemd service..."
$SUDO tee /etc/systemd/system/agenticmail-${config.name}.service > /dev/null << 'SERVICE_EOF'
${this.generateSystemdUnit(config)}
SERVICE_EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable agenticmail-${config.name}
$SUDO systemctl start agenticmail-${config.name}

echo "✅ ${config.displayName} deployed and running!"
echo "   Status: systemctl status agenticmail-${config.name}"
echo "   Logs:   journalctl -u agenticmail-${config.name} -f"
`;
  }

  // ─── Private Generators ─────────────────────────────

  private generateSoul(config: AgentConfig): string {
    if (config.identity.personality) return config.identity.personality;

    const toneMap = {
      formal: 'Be professional and precise. Use proper grammar. Avoid slang or casual language.',
      casual: 'Be relaxed and conversational. Use contractions. Feel free to be informal.',
      professional: 'Be competent and clear. Direct communication without being stiff.',
      friendly: 'Be warm and approachable. Show genuine interest. Use a positive tone.',
      custom: config.identity.customTone || '',
    };

    return `# SOUL.md — Who You Are

## Role
You are **${config.displayName}**, a ${config.identity.role}.

## Communication Style
${toneMap[config.identity.tone]}

## Language
Primary language: ${config.identity.language}

## Core Principles
- Be genuinely helpful, not performatively helpful
- Be resourceful — try to figure things out before asking
- Earn trust through competence
- Keep private information private

## Boundaries
- Never share confidential company information
- Ask before taking irreversible actions
- Stay within your assigned role and permissions
`;
  }

  private generateUser(config: AgentConfig): string {
    return config.context?.userInfo || `# USER.md — About Your Organization\n\n_Configure this from the admin dashboard._\n`;
  }

  private generateAgents(config: AgentConfig): string {
    const customInstructions = config.context?.customInstructions || '';
    return `# AGENTS.md — Your Workspace

## Every Session
1. Read SOUL.md — this is who you are
2. Read USER.md — this is who you're helping
3. Check memory/ for recent context

## Memory
- Daily notes: memory/YYYY-MM-DD.md
- Long-term: MEMORY.md

## Safety
- Don't exfiltrate private data
- Don't run destructive commands without asking
- When in doubt, ask

${customInstructions}
`;
  }

  private generateIdentity(config: AgentConfig): string {
    return `# IDENTITY.md

- **Name:** ${config.displayName}
- **Role:** ${config.identity.role}
- **Tone:** ${config.identity.tone}
`;
  }

  private generateHeartbeat(config: AgentConfig): string {
    if (!config.heartbeat.enabled) return '# HEARTBEAT.md\n# Heartbeat disabled\n';

    const checks = config.heartbeat.checks.map(c => `- Check ${c}`).join('\n');
    return `# HEARTBEAT.md

## Periodic Checks
${checks}

## Schedule
Check every ${config.heartbeat.intervalMinutes} minutes during active hours.
`;
  }

  private generateTools(config: AgentConfig): string {
    return `# TOOLS.md — Local Notes

_Add environment-specific notes here (camera names, SSH hosts, etc.)_
`;
  }
}

// ─── Output Types ───────────────────────────────────────

export type WorkspaceFiles = Record<string, string>;

export interface GatewayConfig {
  model: string;
  thinking: string;
  temperature?: number;
  maxTokens?: number;
  channels: Record<string, any>;
  heartbeat?: { intervalMinutes: number };
  workspace: string;
}
