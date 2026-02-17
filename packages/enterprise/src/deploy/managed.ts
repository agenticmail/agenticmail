/**
 * AgenticMail Cloud (Managed Deployment)
 * 
 * Deploys to Fly.io under the agenticmail org.
 * Each customer gets an isolated app: <subdomain>.agenticmail.cloud
 */

export interface DeployConfig {
  subdomain: string;
  region?: string;    // Default: 'iad' (US East)
  plan: 'free' | 'team' | 'enterprise';
}

export interface DeployResult {
  url: string;
  appName: string;
  region: string;
  status: 'deployed' | 'pending';
}

/**
 * Deploy a new enterprise instance to AgenticMail Cloud.
 * 
 * In v1, this creates a Fly.io app via the Machines API.
 * Each customer gets:
 * - Isolated Fly.io machine
 * - <subdomain>.agenticmail.cloud domain
 * - Auto-TLS via Fly.io
 * - Their DB connection (passed as secret)
 */
export async function deployToCloud(config: DeployConfig): Promise<DeployResult> {
  const appName = `am-${config.subdomain}`;
  const region = config.region || 'iad';

  // TODO: Implement Fly.io Machines API deployment
  // For now, return the expected structure
  
  console.log(`\n☁️  Deploying to AgenticMail Cloud...`);
  console.log(`   App: ${appName}`);
  console.log(`   Region: ${region}`);
  console.log(`   URL: https://${config.subdomain}.agenticmail.cloud`);

  return {
    url: `https://${config.subdomain}.agenticmail.cloud`,
    appName,
    region,
    status: 'pending',
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
}): string {
  return `version: "3.8"

services:
  agenticmail-enterprise:
    image: agenticmail/enterprise:latest
    ports:
      - "${opts.port}:3000"
    environment:
      - DATABASE_TYPE=${opts.dbType}
      - DATABASE_URL=${opts.dbConnectionString}
      - JWT_SECRET=${opts.jwtSecret}
      - PORT=3000
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
`;
}

/**
 * Generate a Fly.io config for customer self-deployment.
 */
export function generateFlyToml(appName: string, region: string): string {
  return `app = "${appName}"
primary_region = "${region}"

[build]
  image = "agenticmail/enterprise:latest"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

[checks]
  [checks.health]
    type = "http"
    port = 3000
    path = "/health"
    interval = "30s"
    timeout = "5s"
`;
}
