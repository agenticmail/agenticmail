import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** Deep merge source into target, preserving nested objects */
function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(source)) {
    // Prevent prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

export interface AgenticMailConfig {
  stalwart: {
    url: string;
    adminUser: string;
    adminPassword: string;
  };
  smtp: {
    host: string;
    port: number;
  };
  imap: {
    host: string;
    port: number;
  };
  api: {
    port: number;
    host: string;
  };
  gateway?: {
    mode?: 'relay' | 'domain' | 'none';
    autoResume?: boolean;
  };
  sms?: {
    enabled?: boolean;
    phoneNumber?: string;
    forwardingEmail?: string;
    provider?: 'google_voice';
    configuredAt?: string;
  };
  masterKey: string;
  dataDir: string;
}

const DEFAULT_CONFIG: AgenticMailConfig = {
  stalwart: {
    url: 'http://localhost:8080',
    adminUser: 'admin',
    adminPassword: 'changeme',
  },
  smtp: {
    host: 'localhost',
    port: 587,
  },
  imap: {
    host: 'localhost',
    port: 143,
  },
  api: {
    port: 3100,
    host: '127.0.0.1',
  },
  masterKey: '',
  dataDir: join(homedir(), '.agenticmail'),
};

export function resolveConfig(overrides?: Partial<AgenticMailConfig>): AgenticMailConfig {
  const env = process.env;
  const config: AgenticMailConfig = {
    stalwart: {
      url: env.STALWART_URL ?? DEFAULT_CONFIG.stalwart.url,
      adminUser: env.STALWART_ADMIN_USER ?? DEFAULT_CONFIG.stalwart.adminUser,
      adminPassword: env.STALWART_ADMIN_PASSWORD ?? DEFAULT_CONFIG.stalwart.adminPassword,
    },
    smtp: {
      host: env.SMTP_HOST ?? DEFAULT_CONFIG.smtp.host,
      port: (() => { const p = parseInt(env.SMTP_PORT ?? ''); return isNaN(p) ? DEFAULT_CONFIG.smtp.port : p; })(),
    },
    imap: {
      host: env.IMAP_HOST ?? DEFAULT_CONFIG.imap.host,
      port: (() => { const p = parseInt(env.IMAP_PORT ?? ''); return isNaN(p) ? DEFAULT_CONFIG.imap.port : p; })(),
    },
    api: {
      port: (() => { const p = parseInt(env.AGENTICMAIL_API_PORT ?? ''); return isNaN(p) ? DEFAULT_CONFIG.api.port : p; })(),
      host: env.AGENTICMAIL_API_HOST ?? DEFAULT_CONFIG.api.host,
    },
    masterKey: env.AGENTICMAIL_MASTER_KEY ?? DEFAULT_CONFIG.masterKey,
    dataDir: env.AGENTICMAIL_DATA_DIR?.replace(/^~(?=\/|$)/, homedir()) ?? DEFAULT_CONFIG.dataDir,
  };

  // Merge file-based config if it exists (deep merge to preserve nested objects)
  const configPath = join(config.dataDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      deepMerge(config, fileConfig);
    } catch {
      console.warn('[agenticmail] Ignoring malformed config file:', configPath);
    }
  }

  // Apply explicit overrides last (deep merge)
  if (overrides) {
    deepMerge(config, overrides);
  }

  return config;
}

export function ensureDataDir(config: AgenticMailConfig): void {
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }
}

export function saveConfig(config: AgenticMailConfig): void {
  ensureDataDir(config);
  const configPath = join(config.dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
