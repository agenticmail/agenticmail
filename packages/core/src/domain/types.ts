export interface DomainInfo {
  domain: string;
  stalwartPrincipal: string;
  dkimSelector?: string;
  dkimPublicKey?: string;
  verified: boolean;
  createdAt: string;
}

export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  purpose: string;
}

export interface DomainSetupResult {
  domain: string;
  dnsRecords: DnsRecord[];
}

export interface DomainRow {
  domain: string;
  stalwart_principal: string;
  dkim_selector: string | null;
  dkim_public_key: string | null;
  verified: number;
  created_at: string;
}
