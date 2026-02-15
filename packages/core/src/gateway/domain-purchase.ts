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
   * NOTE: Cloudflare API tokens only support READ access for registrar.
   * Domain purchases must be done manually via the Cloudflare dashboard
   * or another registrar (then point nameservers to Cloudflare).
   */
  async purchase(_domain: string, _autoRenew = true): Promise<DomainPurchaseResult> {
    throw new Error(
      'Cloudflare API does not support domain purchases programmatically (tokens only get READ access). ' +
      'Please purchase the domain manually:\n' +
      '  Option A: Buy on Cloudflare → https://dash.cloudflare.com/?to=/:account/domain-registration\n' +
      '  Option B: Buy from Namecheap/GoDaddy/etc → then add to Cloudflare and point nameservers'
    );
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
