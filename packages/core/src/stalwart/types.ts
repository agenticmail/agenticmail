export interface StalwartPrincipal {
  type: 'individual' | 'group' | 'domain' | 'list' | 'apiKey';
  name: string;
  secrets?: string[];
  emails?: string[];
  description?: string;
  quota?: number;
  memberOf?: string[];
  members?: string[];
  roles?: string[];
}

export interface StalwartListResponse {
  data: {
    items: string[];
    total: number;
  };
}

export interface StalwartPrincipalResponse {
  data: StalwartPrincipal;
}

export interface StalwartDkimSignature {
  id: string;
  algorithm: string;
  domain: string;
  selector: string;
  publicKey: string;
}
