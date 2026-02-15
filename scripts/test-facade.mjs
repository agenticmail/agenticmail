/**
 * Test the agenticmail facade package — the exact import path users will use:
 *   import { ... } from 'agenticmail'
 *
 * In the monorepo, workspace resolution makes this resolve to agenticmail/dist/index.js
 */

import {
  AgenticMailClient,
  resolveConfig,
  GatewayManager,
  RelayGateway,
  CloudflareClient,
  DomainPurchaser,
  DNSConfigurator,
  TunnelManager,
  RELAY_PRESETS,
  createTestDatabase,
} from 'agenticmail';

console.log('=== Testing "agenticmail" facade package ===\n');

const db = createTestDatabase();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`✅ import from 'agenticmail' works`);
console.log(`✅ createTestDatabase() — ${tables.length} tables`);
console.log(`✅ RELAY_PRESETS.gmail = ${RELAY_PRESETS.gmail.smtpHost}:${RELAY_PRESETS.gmail.smtpPort}`);
console.log(`✅ RelayGateway, CloudflareClient, DomainPurchaser, DNSConfigurator, TunnelManager all present`);

const relay = new RelayGateway();
console.log(`✅ new RelayGateway() — configured=${relay.isConfigured()}`);

const config = resolveConfig({ dataDir: '/tmp/test-facade' });
console.log(`✅ resolveConfig() — api port=${config.api.port}`);

db.close();
console.log('\n🎉 Facade package works! Users can: npm install agenticmail');
