import { CloudflareClient } from './cloudflare.js';
import type { CloudflareDomainAvailability } from './types.js';

export interface DomainSearchResult {
  domain: string;
  available: boolean;
  premium: boolean;
  price?: number;
}

export interface DomainPurchaseResult {
  domain: string;
  status: string;
}

/**
 * DomainPurchaser handles searching for and purchasing domains
 * via Cloudflare Registrar.
 */
export class DomainPurchaser {
  constructor(private cf: CloudflareClient) {}

  /**
   * Search for available domains matching the given keywords.
   * Appends common TLDs to keywords and checks availability.
   */
  async searchAvailable(keywords: string[], tlds: string[] = ['.com', '.net', '.io', '.dev']): Promise<DomainSearchResult[]> {
    const results: DomainSearchResult[] = [];

    for (const keyword of keywords) {
      for (const tld of tlds) {
        const domain = keyword.includes('.') ? keyword : `${keyword}${tld}`;
        try {
          const availability = await this.cf.checkAvailability(domain);
          results.push({
            domain,
            available: availability.available,
            premium: availability.premium,
            price: availability.price,
          });
        } catch {
          // Domain check may fail for some TLDs, skip
          results.push({
            domain,
            available: false,
            premium: false,
          });
        }
      }
    }

    return results;
  }

  /**
   * Purchase a domain via Cloudflare Registrar.
   * Requires a payment method pre-configured in the Cloudflare account.
   */
  async purchase(domain: string, autoRenew = true): Promise<DomainPurchaseResult> {
    // First verify availability
    const check = await this.cf.checkAvailability(domain);
    if (!check.available) {
      throw new Error(`Domain ${domain} is not available for purchase`);
    }

    const result = await this.cf.purchaseDomain(domain, autoRenew);
    return {
      domain: result.domain,
      status: result.status,
    };
  }

  /**
   * Check the registration status of a purchased domain.
   */
  async getStatus(domain: string): Promise<{ domain: string; status: string }> {
    const result = await this.cf.checkAvailability(domain);
    return {
      domain,
      status: result.available ? 'not_registered' : 'registered',
    };
  }

  /**
   * List all domains registered under the Cloudflare account.
   */
  async listRegistered(): Promise<Array<{ domain: string; status: string }>> {
    return this.cf.listRegisteredDomains();
  }
}
