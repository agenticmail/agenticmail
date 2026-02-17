#!/usr/bin/env node
/**
 * AgenticMail Enterprise CLI
 *
 * Interactive setup wizard that provisions a cloud-hosted
 * enterprise dashboard for managing AI agent identities.
 *
 * Usage: npx @agenticmail/enterprise
 *
 * The wizard is split into modular steps under setup/:
 *   1. Company info   → setup/company.ts
 *   2. Database       → setup/database.ts
 *   3. Deployment     → setup/deployment.ts
 *   4. Custom domain  → setup/domain.ts
 *   → Provisioning    → setup/provision.ts
 *   → Orchestrator    → setup/index.ts
 */

import { runSetupWizard } from './setup/index.js';

runSetupWizard().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
