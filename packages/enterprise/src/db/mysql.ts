/**
 * MySQL Database Adapter (also works with PlanetScale)
 * 
 * Uses mysql2 driver — user must install: npm install mysql2
 * TODO: Full implementation (mirrors postgres.ts pattern)
 */

import { DatabaseAdapter, DatabaseConfig } from './adapter.js';

export class MysqlAdapter extends DatabaseAdapter {
  readonly type = 'mysql' as const;
  private pool: any = null;

  async connect(config: DatabaseConfig): Promise<void> {
    try {
      const mysql = await import('mysql2/promise' as any);
      this.pool = mysql.createPool(config.connectionString || {
        host: config.host, port: config.port, database: config.database,
        user: config.username, password: config.password,
      });
      const conn = await this.pool.getConnection();
      conn.release();
    } catch (e: any) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error('MySQL driver not found. Install it: npm install mysql2');
      }
      throw e;
    }
  }

  async disconnect(): Promise<void> { if (this.pool) await this.pool.end(); }
  isConnected(): boolean { return this.pool !== null; }
  async migrate(): Promise<void> { throw new Error('MySQL adapter: full implementation coming in v0.2.0'); }

  // All methods throw "not yet implemented" for now
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
