/**
 * Setup Wizard — Orchestrator
 *
 * Runs the 4-step interactive setup wizard by composing
 * the individual step modules. Each step is in its own file
 * so the wizard logic stays manageable.
 *
 * Steps:
 *   1. Company Info   (setup/company.ts)
 *   2. Database       (setup/database.ts)
 *   3. Deployment     (setup/deployment.ts)
 *   4. Custom Domain  (setup/domain.ts)
 *   → Provision       (setup/provision.ts)
 */

import { promptCompanyInfo } from './company.js';
import { promptDatabase } from './database.js';
import { promptDeployment } from './deployment.js';
import { promptDomain } from './domain.js';
import { provision } from './provision.js';

export { promptCompanyInfo } from './company.js';
export { promptDatabase } from './database.js';
export { promptDeployment } from './deployment.js';
export { promptDomain } from './domain.js';
export { provision } from './provision.js';
export type { CompanyInfo } from './company.js';
export type { DatabaseSelection } from './database.js';
export type { DeployTarget, DeploymentSelection } from './deployment.js';
export type { DomainSelection } from './domain.js';
export type { ProvisionConfig, ProvisionResult } from './provision.js';

/**
 * Run the full interactive setup wizard.
 * Returns when provisioning is complete (or the local server is running).
 */
export async function runSetupWizard(): Promise<void> {
  // Dynamic imports — these are optional CLI deps
  const { default: inquirer } = await import('inquirer');
  const { default: ora } = await import('ora');
  const { default: chalk } = await import('chalk');

  // ─── Banner ──────────────────────────────────────
  console.log('');
  console.log(chalk.bold('  AgenticMail Enterprise'));
  console.log(chalk.dim('  AI Agent Identity & Email for Organizations'));
  console.log('');
  console.log(chalk.dim('  ─────────────────────────────────────────'));
  console.log('');

  // ─── Step 1: Company ─────────────────────────────
  const company = await promptCompanyInfo(inquirer, chalk);

  // ─── Step 2: Database ────────────────────────────
  const database = await promptDatabase(inquirer, chalk);

  // ─── Step 3: Deployment ──────────────────────────
  const { target: deployTarget } = await promptDeployment(inquirer, chalk);

  // ─── Step 4: Custom Domain ───────────────────────
  const domain = await promptDomain(inquirer, chalk, deployTarget);

  // ─── Provision ───────────────────────────────────
  console.log('');
  console.log(chalk.dim('  ─────────────────────────────────────────'));
  console.log('');

  const result = await provision(
    { company, database, deployTarget, domain },
    ora,
    chalk,
  );

  if (!result.success) {
    console.error('');
    console.error(chalk.red(`  Setup failed: ${result.error}`));
    console.error(chalk.dim('  Check your database connection and try again.'));
    process.exit(1);
  }

  console.log('');
}
