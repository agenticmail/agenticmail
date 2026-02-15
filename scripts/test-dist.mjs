/**
 * Test the built dist output — simulates what an npm user gets.
 * Imports from compiled dist/ files, not source.
 */

import {
  AgenticMailClient,
  resolveConfig,
  AccountManager,
  MailSender,
  MailReceiver,
  InboxWatcher,
  DomainManager,
  GatewayManager,
  RelayGateway,
  CloudflareClient,
  DomainPurchaser,
  DNSConfigurator,
  TunnelManager,
  RELAY_PRESETS,
  createTestDatabase,
} from '../packages/core/dist/index.js';

console.log('=== Testing dist/ build output ===\n');

// Verify all exports
const exports = {
  AgenticMailClient,
  resolveConfig,
  AccountManager,
  MailSender,
  MailReceiver,
  InboxWatcher,
  DomainManager,
  GatewayManager,
  RelayGateway,
  CloudflareClient,
  DomainPurchaser,
  DNSConfigurator,
  TunnelManager,
  RELAY_PRESETS,
  createTestDatabase,
};

let ok = 0;
for (const [name, val] of Object.entries(exports)) {
  if (val === undefined) {
    console.error(`❌ ${name} is undefined`);
    process.exit(1);
  }
  ok++;
}
console.log(`✅ All ${ok} exports present from dist/index.js`);

// Test DB from dist
const db = createTestDatabase();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`✅ createTestDatabase() works: ${tables.length} tables created`);

// Test relay presets from dist
console.log(`✅ RELAY_PRESETS.gmail.smtpHost = ${RELAY_PRESETS.gmail.smtpHost}`);

// Test instantiation from dist
const relay = new RelayGateway();
console.log(`✅ new RelayGateway() — configured=${relay.isConfigured()}`);

const gw = new GatewayManager({
  db,
  stalwart: { createPrincipal: async () => {}, deletePrincipal: async () => {} },
});
console.log(`✅ new GatewayManager() — mode=${gw.getMode()}`);

db.close();

console.log('\n🎉 dist/ build output works correctly!');
