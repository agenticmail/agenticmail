/**
 * Deployment Engine
 *
 * Handles provisioning and deploying agents to any target:
 * Docker containers, VPS via SSH, Fly.io, Railway, etc.
 *
 * The admin clicks "Deploy" in the dashboard → this engine does the rest.
 */

import type { AgentConfig, DeploymentTarget, DeploymentStatus } from './agent-config.js';
import { AgentConfigGenerator } from './agent-config.js';

// ─── Types ──────────────────────────────────────────────

export interface DeploymentEvent {
  timestamp: string;
  phase: DeploymentPhase;
  status: 'started' | 'completed' | 'failed';
  message: string;
  details?: any;
}

export type DeploymentPhase =
  | 'validate'
  | 'provision'
  | 'configure'
  | 'upload'
  | 'install'
  | 'start'
  | 'healthcheck'
  | 'complete';

export interface DeploymentResult {
  success: boolean;
  url?: string;               // Agent's accessible URL
  sshCommand?: string;        // For VPS: how to SSH in
  containerId?: string;       // For Docker
  appId?: string;             // For cloud platforms
  events: DeploymentEvent[];
  error?: string;
}

export interface LiveAgentStatus {
  agentId: string;
  name: string;
  status: DeploymentStatus;
  uptime?: number;             // Seconds
  lastHealthCheck?: string;
  healthStatus?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  metrics?: {
    cpuPercent: number;
    memoryMb: number;
    toolCallsToday: number;
    activeSessionCount: number;
    errorRate: number;          // Last hour
  };
  endpoint?: string;
  version?: string;
}

// ─── Deployment Engine ──────────────────────────────────

export class DeploymentEngine {
  private configGen = new AgentConfigGenerator();
  private deployments = new Map<string, DeploymentResult>();
  private liveStatus = new Map<string, LiveAgentStatus>();

  /**
   * Deploy an agent to its configured target
   */
  async deploy(config: AgentConfig, onEvent?: (event: DeploymentEvent) => void): Promise<DeploymentResult> {
    const events: DeploymentEvent[] = [];
    const emit = (phase: DeploymentPhase, status: DeploymentEvent['status'], message: string, details?: any) => {
      const event: DeploymentEvent = { timestamp: new Date().toISOString(), phase, status, message, details };
      events.push(event);
      onEvent?.(event);
    };

    try {
      // 1. Validate
      emit('validate', 'started', 'Validating agent configuration...');
      this.validateConfig(config);
      emit('validate', 'completed', 'Configuration valid');

      // 2. Route to target-specific deployer
      let result: DeploymentResult;
      switch (config.deployment.target) {
        case 'docker':
          result = await this.deployDocker(config, emit);
          break;
        case 'vps':
          result = await this.deployVPS(config, emit);
          break;
        case 'fly':
          result = await this.deployFly(config, emit);
          break;
        case 'railway':
          result = await this.deployRailway(config, emit);
          break;
        default:
          throw new Error(`Unsupported deployment target: ${config.deployment.target}`);
      }

      result.events = events;
      this.deployments.set(config.id, result);
      return result;

    } catch (error: any) {
      emit('complete', 'failed', `Deployment failed: ${error.message}`);
      const result: DeploymentResult = { success: false, events, error: error.message };
      this.deployments.set(config.id, result);
      return result;
    }
  }

  /**
   * Stop a running agent
   */
  async stop(config: AgentConfig): Promise<{ success: boolean; message: string }> {
    switch (config.deployment.target) {
      case 'docker':
        return this.execCommand(`docker stop agenticmail-${config.name} && docker rm agenticmail-${config.name}`);
      case 'vps':
        return this.execSSH(config, `sudo systemctl stop agenticmail-${config.name}`);
      case 'fly':
        return this.execCommand(`fly apps destroy agenticmail-${config.name} --yes`);
      default:
        return { success: false, message: `Cannot stop: unsupported target ${config.deployment.target}` };
    }
  }

  /**
   * Restart a running agent
   */
  async restart(config: AgentConfig): Promise<{ success: boolean; message: string }> {
    switch (config.deployment.target) {
      case 'docker':
        return this.execCommand(`docker restart agenticmail-${config.name}`);
      case 'vps':
        return this.execSSH(config, `sudo systemctl restart agenticmail-${config.name}`);
      case 'fly':
        return this.execCommand(`fly apps restart agenticmail-${config.name}`);
      default:
        return { success: false, message: `Cannot restart: unsupported target ${config.deployment.target}` };
    }
  }

  /**
   * Get live status of a deployed agent
   */
  async getStatus(config: AgentConfig): Promise<LiveAgentStatus> {
    const base: LiveAgentStatus = {
      agentId: config.id,
      name: config.displayName,
      status: 'not-deployed',
      healthStatus: 'unknown',
    };

    try {
      switch (config.deployment.target) {
        case 'docker':
          return await this.getDockerStatus(config, base);
        case 'vps':
          return await this.getVPSStatus(config, base);
        case 'fly':
          return await this.getCloudStatus(config, base);
        default:
          return base;
      }
    } catch {
      return { ...base, status: 'error', healthStatus: 'unhealthy' };
    }
  }

  /**
   * Stream logs from a deployed agent
   */
  async getLogs(config: AgentConfig, lines: number = 100): Promise<string> {
    switch (config.deployment.target) {
      case 'docker':
        return (await this.execCommand(`docker logs --tail ${lines} agenticmail-${config.name}`)).message;
      case 'vps':
        return (await this.execSSH(config, `journalctl -u agenticmail-${config.name} --no-pager -n ${lines}`)).message;
      case 'fly':
        return (await this.execCommand(`fly logs -a agenticmail-${config.name} -n ${lines}`)).message;
      default:
        return 'Log streaming not supported for this target';
    }
  }

  /**
   * Update a deployed agent's configuration without full redeployment
   */
  async updateConfig(config: AgentConfig): Promise<{ success: boolean; message: string }> {
    const workspace = this.configGen.generateWorkspace(config);
    const gatewayConfig = this.configGen.generateGatewayConfig(config);

    switch (config.deployment.target) {
      case 'docker': {
        // Write config files into the container
        for (const [file, content] of Object.entries(workspace)) {
          const escaped = content.replace(/'/g, "'\\''");
          await this.execCommand(`docker exec agenticmail-${config.name} sh -c 'echo "${Buffer.from(content).toString('base64')}" | base64 -d > /workspace/${file}'`);
        }
        // Restart gateway inside container
        await this.execCommand(`docker exec agenticmail-${config.name} openclaw gateway restart`);
        return { success: true, message: 'Configuration updated and gateway restarted' };
      }
      case 'vps': {
        const vps = config.deployment.config.vps!;
        for (const [file, content] of Object.entries(workspace)) {
          await this.execSSH(config, `cat > ${vps.installPath}/workspace/${file} << 'EOF'\n${content}\nEOF`);
        }
        await this.execSSH(config, `sudo systemctl restart agenticmail-${config.name}`);
        return { success: true, message: 'Configuration updated and service restarted' };
      }
      default:
        return { success: false, message: 'Hot config update not supported for this target' };
    }
  }

  // ─── Docker Deployment ────────────────────────────────

  private async deployDocker(config: AgentConfig, emit: Function): Promise<DeploymentResult> {
    const dc = config.deployment.config.docker;
    if (!dc) throw new Error('Docker config missing');

    // Generate docker-compose
    emit('provision', 'started', 'Generating Docker configuration...');
    const compose = this.configGen.generateDockerCompose(config);
    emit('provision', 'completed', 'Docker Compose generated');

    // Generate workspace files
    emit('configure', 'started', 'Generating agent workspace...');
    const workspace = this.configGen.generateWorkspace(config);
    emit('configure', 'completed', `Generated ${Object.keys(workspace).length} workspace files`);

    // Pull image
    emit('install', 'started', `Pulling image ${dc.image}:${dc.tag}...`);
    await this.execCommand(`docker pull ${dc.image}:${dc.tag}`);
    emit('install', 'completed', 'Image pulled');

    // Start container
    emit('start', 'started', 'Starting container...');

    // Build env args
    const envArgs = Object.entries(dc.env).map(([k, v]) => `-e ${k}="${v}"`).join(' ');
    const volumeArgs = dc.volumes.map(v => `-v ${v}`).join(' ');
    const portArgs = dc.ports.map(p => `-p ${p}:${p}`).join(' ');

    const runCmd = `docker run -d --name agenticmail-${config.name} --restart ${dc.restart} ${portArgs} ${volumeArgs} ${envArgs} ${dc.resources ? `--cpus="${dc.resources.cpuLimit}" --memory="${dc.resources.memoryLimit}"` : ''} ${dc.image}:${dc.tag}`;
    const runResult = await this.execCommand(runCmd);

    if (!runResult.success) {
      throw new Error(`Container failed to start: ${runResult.message}`);
    }

    const containerId = runResult.message.trim().substring(0, 12);
    emit('start', 'completed', `Container ${containerId} running`);

    // Write workspace files into container
    emit('upload', 'started', 'Writing workspace files...');
    for (const [file, content] of Object.entries(workspace)) {
      await this.execCommand(`docker exec agenticmail-${config.name} sh -c 'echo "${Buffer.from(content).toString('base64')}" | base64 -d > /workspace/${file}'`);
    }
    emit('upload', 'completed', 'Workspace configured');

    // Health check
    emit('healthcheck', 'started', 'Checking agent health...');
    let healthy = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await this.execCommand(`docker exec agenticmail-${config.name} openclaw status 2>/dev/null || echo "not ready"`);
      if (check.success && !check.message.includes('not ready')) {
        healthy = true;
        break;
      }
    }

    if (healthy) {
      emit('healthcheck', 'completed', 'Agent is healthy');
      emit('complete', 'completed', `Agent "${config.displayName}" deployed successfully`);
    } else {
      emit('healthcheck', 'failed', 'Agent did not become healthy within 30s');
    }

    return {
      success: healthy,
      containerId,
      url: `http://localhost:${dc.ports[0]}`,
      events: [],
    };
  }

  // ─── VPS Deployment ───────────────────────────────────

  private async deployVPS(config: AgentConfig, emit: Function): Promise<DeploymentResult> {
    const vps = config.deployment.config.vps;
    if (!vps) throw new Error('VPS config missing');

    // Generate deploy script
    emit('provision', 'started', `Connecting to ${vps.host}...`);
    const script = this.configGen.generateVPSDeployScript(config);
    emit('provision', 'completed', 'Deploy script generated');

    // Test SSH connection
    emit('configure', 'started', 'Testing SSH connection...');
    const sshTest = await this.execSSH(config, 'echo "ok"');
    if (!sshTest.success) {
      throw new Error(`SSH connection failed: ${sshTest.message}`);
    }
    emit('configure', 'completed', 'SSH connection verified');

    // Upload and run deploy script
    emit('upload', 'started', 'Uploading deployment script...');
    const scriptB64 = Buffer.from(script).toString('base64');
    await this.execSSH(config, `echo "${scriptB64}" | base64 -d > /tmp/deploy-agenticmail.sh && chmod +x /tmp/deploy-agenticmail.sh`);
    emit('upload', 'completed', 'Script uploaded');

    emit('install', 'started', 'Running deployment (this may take a few minutes)...');
    const deployResult = await this.execSSH(config, 'bash /tmp/deploy-agenticmail.sh');
    if (!deployResult.success) {
      throw new Error(`Deployment script failed: ${deployResult.message}`);
    }
    emit('install', 'completed', 'Installation complete');

    // Verify service is running
    emit('healthcheck', 'started', 'Verifying service status...');
    await new Promise(r => setTimeout(r, 5000));
    const statusCheck = await this.execSSH(config, `systemctl is-active agenticmail-${config.name}`);
    const isActive = statusCheck.success && statusCheck.message.trim() === 'active';

    if (isActive) {
      emit('healthcheck', 'completed', 'Service is active');
      emit('complete', 'completed', `Agent deployed to ${vps.host}`);
    } else {
      emit('healthcheck', 'failed', 'Service not active');
    }

    return {
      success: isActive,
      sshCommand: `ssh ${vps.user}@${vps.host}${vps.port !== 22 ? ` -p ${vps.port}` : ''}`,
      events: [],
    };
  }

  // ─── Fly.io Deployment ────────────────────────────────

  private async deployFly(config: AgentConfig, emit: Function): Promise<DeploymentResult> {
    const cloud = config.deployment.config.cloud;
    if (!cloud || cloud.provider !== 'fly') throw new Error('Fly.io config missing');

    const appName = cloud.appName || `agenticmail-${config.name}`;

    emit('provision', 'started', `Creating Fly.io app ${appName}...`);
    await this.execCommand(`fly apps create ${appName} --org personal`, { FLY_API_TOKEN: cloud.apiToken });
    emit('provision', 'completed', `App ${appName} created`);

    // Generate Dockerfile
    emit('configure', 'started', 'Generating Dockerfile...');
    const dockerfile = this.generateDockerfile(config);
    const workspace = this.configGen.generateWorkspace(config);

    // Write temp build context
    const buildDir = `/tmp/agenticmail-build-${config.name}`;
    await this.execCommand(`mkdir -p ${buildDir}/workspace`);
    await this.writeFile(`${buildDir}/Dockerfile`, dockerfile);
    for (const [file, content] of Object.entries(workspace)) {
      await this.writeFile(`${buildDir}/workspace/${file}`, content);
    }

    // Write fly.toml
    const flyToml = `
app = "${appName}"
primary_region = "${cloud.region || 'iad'}"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  size = "${cloud.size || 'shared-cpu-1x'}"
  memory = "512mb"
`;
    await this.writeFile(`${buildDir}/fly.toml`, flyToml);
    emit('configure', 'completed', 'Build context ready');

    // Deploy
    emit('install', 'started', 'Deploying to Fly.io (building + pushing)...');
    const deployResult = await this.execCommand(`cd ${buildDir} && fly deploy --now`, { FLY_API_TOKEN: cloud.apiToken });
    emit('install', deployResult.success ? 'completed' : 'failed', deployResult.message);

    // Cleanup
    await this.execCommand(`rm -rf ${buildDir}`);

    const url = cloud.customDomain || `https://${appName}.fly.dev`;

    if (deployResult.success) {
      emit('complete', 'completed', `Agent live at ${url}`);
    }

    return {
      success: deployResult.success,
      url,
      appId: appName,
      events: [],
    };
  }

  // ─── Railway Deployment ───────────────────────────────

  private async deployRailway(config: AgentConfig, emit: Function): Promise<DeploymentResult> {
    const cloud = config.deployment.config.cloud;
    if (!cloud || cloud.provider !== 'railway') throw new Error('Railway config missing');

    emit('provision', 'started', 'Creating Railway project...');
    // Railway CLI deployment
    const appName = cloud.appName || `agenticmail-${config.name}`;
    const result = await this.execCommand(`railway init --name ${appName}`, { RAILWAY_TOKEN: cloud.apiToken });
    emit('provision', result.success ? 'completed' : 'failed', result.message);

    return {
      success: result.success,
      url: `https://${appName}.up.railway.app`,
      appId: appName,
      events: [],
    };
  }

  // ─── Status Checkers ──────────────────────────────────

  private async getDockerStatus(config: AgentConfig, base: LiveAgentStatus): Promise<LiveAgentStatus> {
    const inspect = await this.execCommand(`docker inspect agenticmail-${config.name} --format '{{.State.Status}} {{.State.StartedAt}}'`);
    if (!inspect.success) return { ...base, status: 'not-deployed' };

    const [status, startedAt] = inspect.message.trim().split(' ');
    const running = status === 'running';
    const uptime = running ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;

    // Get resource usage
    let metrics: LiveAgentStatus['metrics'] = undefined;
    if (running) {
      const stats = await this.execCommand(`docker stats agenticmail-${config.name} --no-stream --format '{{.CPUPerc}} {{.MemUsage}}'`);
      if (stats.success) {
        const parts = stats.message.trim().split(' ');
        metrics = {
          cpuPercent: parseFloat(parts[0]) || 0,
          memoryMb: parseFloat(parts[1]) || 0,
          toolCallsToday: 0,
          activeSessionCount: 0,
          errorRate: 0,
        };
      }
    }

    return {
      ...base,
      status: running ? 'running' : 'stopped',
      uptime,
      healthStatus: running ? 'healthy' : 'unhealthy',
      lastHealthCheck: new Date().toISOString(),
      metrics,
    };
  }

  private async getVPSStatus(config: AgentConfig, base: LiveAgentStatus): Promise<LiveAgentStatus> {
    const result = await this.execSSH(config, `systemctl is-active agenticmail-${config.name}`);
    const active = result.success && result.message.trim() === 'active';

    let uptime = 0;
    if (active) {
      const uptimeResult = await this.execSSH(config, `systemctl show agenticmail-${config.name} --property=ActiveEnterTimestamp --value`);
      if (uptimeResult.success) {
        uptime = Math.floor((Date.now() - new Date(uptimeResult.message.trim()).getTime()) / 1000);
      }
    }

    return {
      ...base,
      status: active ? 'running' : 'stopped',
      uptime,
      healthStatus: active ? 'healthy' : 'unhealthy',
      lastHealthCheck: new Date().toISOString(),
    };
  }

  private async getCloudStatus(config: AgentConfig, base: LiveAgentStatus): Promise<LiveAgentStatus> {
    const cloud = config.deployment.config.cloud;
    if (!cloud) return base;

    const appName = cloud.appName || `agenticmail-${config.name}`;
    const result = await this.execCommand(`fly status -a ${appName} --json`, { FLY_API_TOKEN: cloud.apiToken });

    if (!result.success) return { ...base, status: 'error' };

    try {
      const status = JSON.parse(result.message);
      return {
        ...base,
        status: status.Deployed ? 'running' : 'stopped',
        healthStatus: status.Deployed ? 'healthy' : 'unhealthy',
        endpoint: `https://${appName}.fly.dev`,
        version: status.Version?.toString(),
      };
    } catch {
      return { ...base, status: 'error' };
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private validateConfig(config: AgentConfig) {
    if (!config.name) throw new Error('Agent name is required');
    if (!config.identity.role) throw new Error('Agent role is required');
    if (!config.model.modelId) throw new Error('Model ID is required');
    if (!config.deployment.target) throw new Error('Deployment target is required');

    switch (config.deployment.target) {
      case 'docker':
        if (!config.deployment.config.docker) throw new Error('Docker configuration missing');
        break;
      case 'vps':
        if (!config.deployment.config.vps?.host) throw new Error('VPS host is required');
        break;
      case 'fly':
      case 'railway':
        if (!config.deployment.config.cloud?.apiToken) throw new Error('Cloud API token is required');
        break;
    }
  }

  private generateDockerfile(config: AgentConfig): string {
    return `FROM node:22-slim

WORKDIR /app

RUN npm install -g openclaw agenticmail @agenticmail/core @agenticmail/openclaw

COPY workspace/ /workspace/

ENV NODE_ENV=production
ENV OPENCLAW_MODEL=${config.model.provider}/${config.model.modelId}
ENV OPENCLAW_THINKING=${config.model.thinkingLevel}

EXPOSE 3000

CMD ["openclaw", "gateway", "start"]
`;
  }

  private async execCommand(cmd: string, env?: Record<string, string>): Promise<{ success: boolean; message: string }> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 300_000, // 5 min max
        env: { ...process.env, ...env },
      });
      return { success: true, message: stdout || stderr };
    } catch (error: any) {
      return { success: false, message: error.stderr || error.message };
    }
  }

  private async execSSH(config: AgentConfig, command: string): Promise<{ success: boolean; message: string }> {
    const vps = config.deployment.config.vps;
    if (!vps) return { success: false, message: 'No VPS config' };

    const sshArgs = [
      '-o StrictHostKeyChecking=no',
      `-p ${vps.port || 22}`,
      vps.sshKeyPath ? `-i ${vps.sshKeyPath}` : '',
      `${vps.user}@${vps.host}`,
      `"${command.replace(/"/g, '\\"')}"`,
    ].filter(Boolean).join(' ');

    return this.execCommand(`ssh ${sshArgs}`);
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const { writeFile } = await import('fs/promises');
    const { dirname } = await import('path');
    const { mkdir } = await import('fs/promises');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }
}
