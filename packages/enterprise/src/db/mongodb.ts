/**
 * MongoDB Database Adapter (stub)
 * Full implementation coming in v0.2.0
 */
import { DatabaseAdapter, DatabaseConfig } from './adapter.js';

export class MongoAdapter extends DatabaseAdapter {
  readonly type = 'mongodb' as const;
  async connect(config: DatabaseConfig): Promise<void> {
    try { await import('mongodb' as any); } catch { throw new Error('MongoDB driver not found. Install: npm install mongodb'); }
    throw new Error('MongoDB adapter: full implementation coming in v0.2.0');
  }
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return false; }
  async migrate(): Promise<void> { throw new Error('Not implemented'); }
  async getSettings(): Promise<any> { throw new Error('Not implemented'); }
  async updateSettings(): Promise<any> { throw new Error('Not implemented'); }
  async createAgent(): Promise<any> { throw new Error('Not implemented'); }
  async getAgent(): Promise<any> { throw new Error('Not implemented'); }
  async getAgentByName(): Promise<any> { throw new Error('Not implemented'); }
  async listAgents(): Promise<any> { throw new Error('Not implemented'); }
  async updateAgent(): Promise<any> { throw new Error('Not implemented'); }
  async archiveAgent(): Promise<any> { throw new Error('Not implemented'); }
  async deleteAgent(): Promise<any> { throw new Error('Not implemented'); }
  async countAgents(): Promise<any> { throw new Error('Not implemented'); }
  async createUser(): Promise<any> { throw new Error('Not implemented'); }
  async getUser(): Promise<any> { throw new Error('Not implemented'); }
  async getUserByEmail(): Promise<any> { throw new Error('Not implemented'); }
  async getUserBySso(): Promise<any> { throw new Error('Not implemented'); }
  async listUsers(): Promise<any> { throw new Error('Not implemented'); }
  async updateUser(): Promise<any> { throw new Error('Not implemented'); }
  async deleteUser(): Promise<any> { throw new Error('Not implemented'); }
  async logEvent(): Promise<any> { throw new Error('Not implemented'); }
  async queryAudit(): Promise<any> { throw new Error('Not implemented'); }
  async createApiKey(): Promise<any> { throw new Error('Not implemented'); }
  async getApiKey(): Promise<any> { throw new Error('Not implemented'); }
  async validateApiKey(): Promise<any> { throw new Error('Not implemented'); }
  async listApiKeys(): Promise<any> { throw new Error('Not implemented'); }
  async revokeApiKey(): Promise<any> { throw new Error('Not implemented'); }
  async createRule(): Promise<any> { throw new Error('Not implemented'); }
  async getRules(): Promise<any> { throw new Error('Not implemented'); }
  async updateRule(): Promise<any> { throw new Error('Not implemented'); }
  async deleteRule(): Promise<any> { throw new Error('Not implemented'); }
  async getRetentionPolicy(): Promise<any> { throw new Error('Not implemented'); }
  async setRetentionPolicy(): Promise<any> { throw new Error('Not implemented'); }
  async getStats(): Promise<any> { throw new Error('Not implemented'); }
}
