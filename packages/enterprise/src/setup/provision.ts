/**
 * Setup Wizard — Provisioning
 *
 * Connects to the database, runs migrations, creates the admin account,
 * and deploys to the selected target. This is the "do the work" step
 * after all prompts are collected.
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../db/adapter.js';
import type { CompanyInfo } from './company.js';
import type { DatabaseSelection } from './database.js';
import type { DeployTarget } from './deployment.js';
import type { DomainSelection } from './domain.js';

export interface ProvisionConfig {
  company: CompanyInfo;
  database: DatabaseSelection;
  deployTarget: DeployTarget;
  domain: DomainSelection;
}

export interface ProvisionResult {
  success: boolean;
  url?: string;
  error?: string;
  jwtSecret: string;
  db: DatabaseAdapter;
  serverClose?: () => void;
}

export async function provision(
  config: ProvisionConfig,
  ora: any,
  chalk: any,
): Promise<ProvisionResult> {
  const spinner = ora('Connecting to database...').start();
  const jwtSecret = randomUUID() + randomUUID();

  try {
    // ─── Database ──────────────────────────────────
    const { createAdapter } = await import('../db/factory.js');
    const db = await createAdapter(config.database as any);
    spinner.text = 'Running migrations...';
    await db.migrate();
    spinner.succeed('Database ready');

    // ─── Company Settings ──────────────────────────
    spinner.start('Creating company...');
    await db.updateSettings({
      name: config.company.companyName,
      subdomain: config.company.subdomain,
      domain: config.domain.customDomain,
    });
    spinner.succeed('Company created');

    // ─── Admin Account ─────────────────────────────
    spinner.start('Creating admin account...');
    const admin = await db.createUser({
      email: config.company.adminEmail,
      name: 'Admin',
      role: 'owner',
      password: config.company.adminPassword,
    });
    await db.logEvent({
      actor: admin.id,
      actorType: 'system',
      action: 'setup.complete',
      resource: `company:${config.company.subdomain}`,
      details: {
        dbType: config.database.type,
        deployTarget: config.deployTarget,
        companyName: config.company.companyName,
      },
    });
    spinner.succeed('Admin account created');

    // ─── Deploy ────────────────────────────────────
    const result = await deploy(config, db, jwtSecret, spinner, chalk);

    return {
      success: true,
      url: result.url,
      jwtSecret,
      db,
      serverClose: result.close,
    };
  } catch (err: any) {
    spinner.fail(`Setup failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      jwtSecret,
      db: null as any,
    };
  }
}

// ─── Deploy to selected target ──────────────────────

interface DeployResult {
  url?: string;
  close?: () => void;
}

async function deploy(
  config: ProvisionConfig,
  db: DatabaseAdapter,
  jwtSecret: string,
  spinner: any,
  chalk: any,
): Promise<DeployResult> {
  const { deployTarget, company, database, domain } = config;

  // ── Cloud ─────────────────────────────────────────
  if (deployTarget === 'cloud') {
    spinner.start('Deploying to AgenticMail Cloud...');
    const { deployToCloud } = await import('../deploy/managed.js');
    const result = await deployToCloud({
      subdomain: company.subdomain,
      plan: 'free',
      dbType: database.type,
      dbConnectionString: database.connectionString || '',
      jwtSecret,
    });
    spinner.succeed(`Deployed to ${result.url}`);

    printCloudSuccess(chalk, result.url, company.adminEmail, domain.customDomain, company.subdomain);
    return { url: result.url };
  }

  // ── Docker ────────────────────────────────────────
  if (deployTarget === 'docker') {
    const { generateDockerCompose } = await import('../deploy/managed.js');
    const compose = generateDockerCompose({
      dbType: database.type,
      dbConnectionString: database.connectionString || '',
      port: 3000,
      jwtSecret,
    });
    const { writeFileSync } = await import('fs');
    writeFileSync('docker-compose.yml', compose);
    spinner.succeed('docker-compose.yml generated');

    console.log('');
    console.log(chalk.green.bold('  Docker deployment ready!'));
    console.log('');
    console.log(`  Run:       ${chalk.cyan('docker compose up -d')}`);
    console.log(`  Dashboard: ${chalk.cyan('http://localhost:3000')}`);
    return { url: 'http://localhost:3000' };
  }

  // ── Fly.io ────────────────────────────────────────
  if (deployTarget === 'fly') {
    const { generateFlyToml } = await import('../deploy/managed.js');
    const flyToml = generateFlyToml(`am-${company.subdomain}`, 'iad');
    const { writeFileSync } = await import('fs');
    writeFileSync('fly.toml', flyToml);
    spinner.succeed('fly.toml generated');

    console.log('');
    console.log(chalk.green.bold('  Fly.io deployment ready!'));
    console.log('');
    console.log(`  1. ${chalk.cyan('fly launch --copy-config')}`);
    console.log(`  2. ${chalk.cyan(`fly secrets set DATABASE_URL="${database.connectionString}" JWT_SECRET="${jwtSecret}"`)}`);
    console.log(`  3. ${chalk.cyan('fly deploy')}`);
    return {};
  }

  // ── Railway ───────────────────────────────────────
  if (deployTarget === 'railway') {
    const { generateRailwayConfig } = await import('../deploy/managed.js');
    const railwayConfig = generateRailwayConfig();
    const { writeFileSync } = await import('fs');
    writeFileSync('railway.toml', railwayConfig);
    spinner.succeed('railway.toml generated');

    console.log('');
    console.log(chalk.green.bold('  Railway deployment ready!'));
    console.log('');
    console.log(`  1. ${chalk.cyan('railway init')}`);
    console.log(`  2. ${chalk.cyan('railway link')}`);
    console.log(`  3. ${chalk.cyan('railway up')}`);
    return {};
  }

  // ── Local ─────────────────────────────────────────
  spinner.start('Starting local server...');
  const { createServer } = await import('../server.js');
  const server = createServer({ port: 3000, db, jwtSecret });
  const handle = await server.start();
  spinner.succeed('Server running');

  console.log('');
  console.log(chalk.green.bold('  AgenticMail Enterprise is running!'));
  console.log('');
  console.log(`  ${chalk.bold('Dashboard:')}  ${chalk.cyan('http://localhost:3000')}`);
  console.log(`  ${chalk.bold('API:')}        ${chalk.cyan('http://localhost:3000/api')}`);
  console.log(`  ${chalk.bold('Admin:')}      ${company.adminEmail}`);
  console.log('');
  console.log(chalk.dim('  Press Ctrl+C to stop'));

  return { url: 'http://localhost:3000', close: handle.close };
}

// ─── Success Messages ───────────────────────────────

function printCloudSuccess(
  chalk: any,
  url: string,
  adminEmail: string,
  customDomain?: string,
  subdomain?: string,
) {
  console.log('');
  console.log(chalk.green.bold('  Your dashboard is live!'));
  console.log('');
  console.log(`  ${chalk.bold('URL:')}      ${chalk.cyan(url)}`);
  console.log(`  ${chalk.bold('Admin:')}    ${adminEmail}`);
  console.log(`  ${chalk.bold('Password:')} (the one you just set)`);
  if (customDomain) {
    console.log('');
    console.log(chalk.dim(`  To use ${customDomain}:`));
    console.log(chalk.dim(`  Add CNAME: ${customDomain} → ${subdomain}.agenticmail.cloud`));
  }
}
