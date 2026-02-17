/**
 * AgenticMail Cloud (Managed Deployment)
 * 
 * Orchestrates deployment to various targets.
 * "Cloud" mode uses Fly.io under the agenticmail org.
 * Also generates Docker Compose and Fly.toml for self-hosted.
 */

import { randomUUID } from 'crypto';
import { deployToFly, type FlyConfig, type AppConfig } from './fly.js';

export interface DeployConfig {
  subdomain: string;
  region?: string;
  plan: 'free' | 'team' | 'enterprise';
  dbType: string;
  dbConnectionString: string;
  jwtSecret: string;
}

export interface DeployResult {
  url: string;
  appName: string;
  region: string;
  status: 'deployed' | 'pending' | 'error';
  error?: string;
}

/**
 * Deploy to AgenticMail Cloud (managed Fly.io).
 * 
 * Requires FLY_API_TOKEN env var or explicit token.
 */
export async function deployToCloud(
  config: DeployConfig,
  flyToken?: string,
): Promise<DeployResult> {
  const token = flyToken || process.env.FLY_API_TOKEN;
  if (!token) {
    return {
      url: `https://${config.subdomain}.agenticmail.cloud`,
      appName: `am-${config.subdomain}`,
      region: config.region || 'iad',
      status: 'pending',
      error: 'FLY_API_TOKEN not set. Set it to enable cloud deployment.',
    };
  }

  const flyConfig: FlyConfig = {
    apiToken: token,
    org: process.env.FLY_ORG || 'agenticmail',
    regions: [config.region || 'iad'],
  };

  const appConfig: AppConfig = {
    subdomain: config.subdomain,
    dbType: config.dbType,
    dbConnectionString: config.dbConnectionString,
    jwtSecret: config.jwtSecret,
    memoryMb: config.plan === 'free' ? 256 : config.plan === 'team' ? 512 : 1024,
    cpuKind: config.plan === 'enterprise' ? 'performance' : 'shared',
    cpus: config.plan === 'enterprise' ? 2 : 1,
  };

  const result = await deployToFly(appConfig, flyConfig);

  return {
    url: result.url,
    appName: result.appName,
    region: result.region,
    status: result.status === 'error' ? 'error' : 'deployed',
    error: result.error,
  };
}

/**
 * Generate a Docker Compose file for self-hosted deployment.
 */
export function generateDockerCompose(opts: {
  dbType: string;
  dbConnectionString: string;
  port: number;
  jwtSecret: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}): string {
  const env: string[] = [
    `      - NODE_ENV=production`,
    `      - DATABASE_TYPE=${opts.dbType}`,
    `      - DATABASE_URL=${opts.dbConnectionString}`,
    `      - JWT_SECRET=${opts.jwtSecret}`,
    `      - PORT=3000`,
  ];

  if (opts.smtpHost) {
    env.push(`      - SMTP_HOST=${opts.smtpHost}`);
    env.push(`      - SMTP_PORT=${opts.smtpPort || 587}`);
    if (opts.smtpUser) env.push(`      - SMTP_USER=${opts.smtpUser}`);
    if (opts.smtpPass) env.push(`      - SMTP_PASS=${opts.smtpPass}`);
  }

  return `# AgenticMail Enterprise — Docker Compose
# Generated at ${new Date().toISOString()}
#
# Usage:
#   docker compose up -d
#   open http://localhost:${opts.port}

version: "3.8"

services:
  agenticmail:
    image: agenticmail/enterprise:latest
    ports:
      - "${opts.port}:3000"
    environment:
${env.join('\n')}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
        reservations:
          memory: 128M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`;
}

/**
 * Generate a Fly.toml for customer self-deployment.
 */
export function generateFlyToml(appName: string, region: string): string {
  return `# AgenticMail Enterprise — Fly.io Config
# Generated at ${new Date().toISOString()}
#
# Deploy:
#   fly launch --copy-config
#   fly secrets set DATABASE_URL="..." JWT_SECRET="..."
#   fly deploy

app = "${appName}"
primary_region = "${region}"

[build]
  image = "agenticmail/enterprise:latest"

[env]
  PORT = "3000"
  NODE_ENV = "production"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 100
    soft_limit = 80

[checks]
  [checks.health]
    type = "http"
    port = 3000
    path = "/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
`;
}

/**
 * Generate a Railway deployment config.
 */
export function generateRailwayConfig(): string {
  return `# AgenticMail Enterprise — Railway Config
# Generated at ${new Date().toISOString()}
#
# Deploy:
#   railway init
#   railway link
#   railway up

[build]
  builder = "DOCKERFILE"
  dockerfilePath = "Dockerfile"

[deploy]
  healthcheckPath = "/health"
  healthcheckTimeout = 10
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3
`;
}
