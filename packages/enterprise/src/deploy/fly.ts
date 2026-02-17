/**
 * Fly.io Deployment Module
 * 
 * Provisions isolated Fly.io apps for enterprise customers
 * using the Machines API (REST, no flyctl needed).
 * 
 * Each customer gets:
 * - Isolated Fly.io machine
 * - <subdomain>.agenticmail.cloud domain
 * - Auto-TLS via Fly.io
 * - Secrets injected as env vars
 */

import { withRetry } from '../lib/resilience.js';

const FLY_API = 'https://api.machines.dev';
const DEFAULT_IMAGE = 'agenticmail/enterprise:latest';

export interface FlyConfig {
  /** Fly.io API token */
  apiToken: string;
  /** Fly.io organization slug (default: 'personal') */
  org?: string;
  /** Docker image to deploy (default: agenticmail/enterprise:latest) */
  image?: string;
  /** Regions to deploy to */
  regions?: string[];
}

export interface AppConfig {
  subdomain: string;
  dbType: string;
  dbConnectionString: string;
  jwtSecret: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  /** RAM in MB (default: 256) */
  memoryMb?: number;
  /** CPU kind (default: shared, 1 CPU) */
  cpuKind?: 'shared' | 'performance';
  cpus?: number;
}

export interface DeployResult {
  appName: string;
  url: string;
  ipv4?: string;
  ipv6?: string;
  region: string;
  machineId: string;
  status: 'created' | 'started' | 'error';
  error?: string;
}

async function flyRequest(
  path: string,
  opts: { method?: string; body?: any; apiToken: string },
): Promise<any> {
  const resp = await fetch(`${FLY_API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${opts.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => 'Unknown error');
    throw new Error(`Fly.io API error (${resp.status}): ${text}`);
  }

  return resp.json();
}

/**
 * Create a new Fly.io app.
 */
async function createApp(name: string, fly: FlyConfig): Promise<void> {
  await flyRequest('/v1/apps', {
    method: 'POST',
    apiToken: fly.apiToken,
    body: {
      app_name: name,
      org_slug: fly.org || 'personal',
    },
  });
}

/**
 * Set secrets (environment variables) on a Fly.io app.
 */
async function setSecrets(
  appName: string,
  secrets: Record<string, string>,
  fly: FlyConfig,
): Promise<void> {
  // Fly Machines API doesn't have a direct "set secrets" endpoint
  // like flyctl does. Secrets are passed as env vars in machine config.
  // We store them for use when creating the machine.
  // This is a no-op — secrets are injected in createMachine().
}

/**
 * Create and start a Fly.io machine.
 */
async function createMachine(
  appName: string,
  config: AppConfig,
  fly: FlyConfig,
): Promise<{ id: string; region: string }> {
  const region = fly.regions?.[0] || 'iad';

  const env: Record<string, string> = {
    PORT: '3000',
    NODE_ENV: 'production',
    DATABASE_TYPE: config.dbType,
    DATABASE_URL: config.dbConnectionString,
    JWT_SECRET: config.jwtSecret,
  };

  if (config.smtpHost) env.SMTP_HOST = config.smtpHost;
  if (config.smtpPort) env.SMTP_PORT = String(config.smtpPort);
  if (config.smtpUser) env.SMTP_USER = config.smtpUser;
  if (config.smtpPass) env.SMTP_PASS = config.smtpPass;

  const result = await flyRequest(`/v1/apps/${appName}/machines`, {
    method: 'POST',
    apiToken: fly.apiToken,
    body: {
      name: `${appName}-web`,
      region,
      config: {
        image: fly.image || DEFAULT_IMAGE,
        env,
        services: [
          {
            ports: [
              { port: 443, handlers: ['tls', 'http'] },
              { port: 80, handlers: ['http'] },
            ],
            protocol: 'tcp',
            internal_port: 3000,
            concurrency: {
              type: 'connections',
              hard_limit: 100,
              soft_limit: 80,
            },
          },
        ],
        checks: {
          health: {
            type: 'http',
            port: 3000,
            path: '/health',
            interval: '30s',
            timeout: '5s',
            grace_period: '10s',
          },
        },
        guest: {
          cpu_kind: config.cpuKind || 'shared',
          cpus: config.cpus || 1,
          memory_mb: config.memoryMb || 256,
        },
        auto_destroy: false,
        restart: {
          policy: 'always',
          max_retries: 5,
        },
      },
    },
  });

  return { id: result.id, region: result.region || region };
}

/**
 * Allocate a dedicated IPv4 address for the app.
 */
async function allocateIp(appName: string, fly: FlyConfig): Promise<{ v4?: string; v6?: string }> {
  try {
    // Fly.io GraphQL API for IP allocation
    const resp = await fetch('https://api.fly.io/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fly.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `mutation($input: AllocateIPAddressInput!) {
          allocateIpAddress(input: $input) {
            ipAddress { id address type region createdAt }
          }
        }`,
        variables: {
          input: { appId: appName, type: 'v4', region: '' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await resp.json();
    const v4 = data?.data?.allocateIpAddress?.ipAddress?.address;
    return { v4 };
  } catch {
    return {};
  }
}

/**
 * Set up a custom certificate for the app.
 */
async function addCertificate(
  appName: string,
  hostname: string,
  fly: FlyConfig,
): Promise<void> {
  await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fly.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `mutation($appId: ID!, $hostname: String!) {
        addCertificate(appId: $appId, hostname: $hostname) {
          certificate { hostname configured }
        }
      }`,
      variables: { appId: appName, hostname },
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

// ─── Main Deploy Function ────────────────────────────────

export async function deployToFly(
  config: AppConfig,
  fly: FlyConfig,
): Promise<DeployResult> {
  const appName = `am-${config.subdomain}`;
  const domain = `${config.subdomain}.agenticmail.cloud`;

  try {
    // Step 1: Create app
    console.log(`  Creating app: ${appName}...`);
    await withRetry(() => createApp(appName, fly), {
      maxAttempts: 2,
      retryableErrors: (err) => !err.message.includes('already exists'),
    });

    // Step 2: Create machine
    console.log(`  Deploying machine...`);
    const machine = await withRetry(() => createMachine(appName, config, fly), {
      maxAttempts: 3,
      baseDelayMs: 2000,
    });

    // Step 3: Allocate IP
    console.log(`  Allocating IP address...`);
    const ips = await allocateIp(appName, fly);

    // Step 4: Add TLS certificate
    console.log(`  Setting up TLS for ${domain}...`);
    await addCertificate(appName, domain, fly).catch(() => {
      // Non-critical — can be added later
    });

    return {
      appName,
      url: `https://${domain}`,
      ipv4: ips.v4,
      ipv6: ips.v6,
      region: machine.region,
      machineId: machine.id,
      status: 'started',
    };
  } catch (err: any) {
    return {
      appName,
      url: `https://${domain}`,
      region: fly.regions?.[0] || 'iad',
      machineId: '',
      status: 'error',
      error: err.message,
    };
  }
}

/**
 * Check the status of a deployed app.
 */
export async function getAppStatus(
  appName: string,
  fly: FlyConfig,
): Promise<{ running: boolean; machines: any[] }> {
  try {
    const machines = await flyRequest(`/v1/apps/${appName}/machines`, {
      apiToken: fly.apiToken,
    });
    const running = machines.some((m: any) => m.state === 'started');
    return { running, machines };
  } catch {
    return { running: false, machines: [] };
  }
}

/**
 * Destroy a deployed app and all its machines.
 */
export async function destroyApp(
  appName: string,
  fly: FlyConfig,
): Promise<void> {
  // List and stop all machines first
  const { machines } = await getAppStatus(appName, fly);
  for (const m of machines) {
    try {
      await flyRequest(`/v1/apps/${appName}/machines/${m.id}/stop`, {
        method: 'POST',
        apiToken: fly.apiToken,
      });
    } catch { /* ignore */ }
  }

  // Delete app via GraphQL
  await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fly.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `mutation($appId: ID!) { deleteApp(appId: $appId) { organization { id } } }`,
      variables: { appId: appName },
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Scale a machine (change CPU/memory).
 */
export async function scaleMachine(
  appName: string,
  machineId: string,
  opts: { memoryMb?: number; cpuKind?: string; cpus?: number },
  fly: FlyConfig,
): Promise<void> {
  const machine = await flyRequest(`/v1/apps/${appName}/machines/${machineId}`, {
    apiToken: fly.apiToken,
  });

  const config = machine.config || {};
  if (opts.memoryMb) config.guest = { ...config.guest, memory_mb: opts.memoryMb };
  if (opts.cpuKind) config.guest = { ...config.guest, cpu_kind: opts.cpuKind };
  if (opts.cpus) config.guest = { ...config.guest, cpus: opts.cpus };

  await flyRequest(`/v1/apps/${appName}/machines/${machineId}`, {
    method: 'PATCH',
    apiToken: fly.apiToken,
    body: { config },
  });
}
