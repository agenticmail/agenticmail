export type GatewayMode = 'relay' | 'domain' | 'none';

export type RelayProvider = 'gmail' | 'outlook' | 'custom';

export interface RelayConfig {
  provider: RelayProvider;
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface DomainModeConfig {
  domain: string;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  tunnelId?: string;
  tunnelToken?: string;
  /** URL of the Cloudflare Worker outbound relay (e.g. https://agenticmail-outbound.xxx.workers.dev) */
  outboundWorkerUrl?: string;
  /** Shared secret for authenticating with the outbound Worker */
  outboundSecret?: string;
  /** Shared secret for authenticating inbound webhook from Email Worker */
  inboundSecret?: string;
  /** Name of the deployed Email Worker */
  emailWorkerName?: string;
}

export interface GatewayConfig {
  mode: GatewayMode;
  relay?: RelayConfig;
  domain?: DomainModeConfig;
}

export interface GatewayStatus {
  mode: GatewayMode;
  healthy: boolean;
  relay?: {
    provider: RelayProvider;
    email: string;
    polling: boolean;
  };
  domain?: {
    domain: string;
    dnsConfigured: boolean;
    tunnelActive: boolean;
  };
}

export interface PurchasedDomain {
  domain: string;
  registrar: string;
  cloudflareZoneId?: string;
  tunnelId?: string;
  dnsConfigured: boolean;
  tunnelActive: boolean;
  purchasedAt: string;
}

export interface PurchasedDomainRow {
  domain: string;
  registrar: string;
  cloudflare_zone_id: string | null;
  tunnel_id: string | null;
  dns_configured: number;
  tunnel_active: number;
  purchased_at: string;
}

export interface GatewayConfigRow {
  id: string;
  mode: string;
  config: string;
  created_at: string;
}

/** Relay provider presets for SMTP/IMAP connection details */
export const RELAY_PRESETS: Record<'gmail' | 'outlook', Pick<RelayConfig, 'smtpHost' | 'smtpPort' | 'imapHost' | 'imapPort'>> = {
  gmail: {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
  },
  outlook: {
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
  },
};

/** Cloudflare API response types */
export interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
}

export interface CloudflareTunnel {
  id: string;
  name: string;
  status: string;
  created_at: string;
  deleted_at?: string | null;
  connections: Array<{ id: string }>;
}

export interface CloudflareDomainAvailability {
  name: string;
  available: boolean;
  premium: boolean;
  price?: number;
}
