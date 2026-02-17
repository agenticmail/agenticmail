#!/usr/bin/env node
/**
 * AgenticMail Enterprise CLI
 * 
 * Interactive setup wizard that provisions a cloud-hosted
 * enterprise dashboard for managing AI agent identities.
 * 
 * Usage: npx @agenticmail/enterprise
 */

import { randomUUID } from 'crypto';
import { createAdapter, getSupportedDatabases } from './db/factory.js';
import { createServer } from './server.js';
import { deployToCloud, generateDockerCompose, generateFlyToml } from './deploy/managed.js';

async function main() {
  // Dynamic imports for CLI deps
  const { default: inquirer } = await import('inquirer');
  const { default: ora } = await import('ora');
  const { default: chalk } = await import('chalk');

  console.log('');
  console.log(chalk.bold('🏢 AgenticMail Enterprise'));
  console.log(chalk.dim('   AI Agent Identity & Email for Organizations'));
  console.log('');

  // ─── Step 1: Company Info ───────────────────────────────

  const { companyName, adminEmail, adminPassword } = await inquirer.prompt([
    {
      type: 'input',
      name: 'companyName',
      message: 'Company name:',
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'input',
      name: 'adminEmail',
      message: 'Admin email:',
      validate: (v: string) => v.includes('@') || 'Must be a valid email',
    },
    {
      type: 'password',
      name: 'adminPassword',
      message: 'Admin password:',
      mask: '*',
      validate: (v: string) => v.length >= 8 || 'Must be at least 8 characters',
    },
  ]);

  // ─── Step 2: Database ───────────────────────────────────

  const databases = getSupportedDatabases();
  const { dbType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'dbType',
      message: 'Database:',
      choices: databases.map(d => ({
        name: `${d.label}  ${chalk.dim(`(${d.group})`)}`,
        value: d.type,
      })),
    },
  ]);

  let dbConfig: any = { type: dbType };

  if (dbType === 'sqlite') {
    const { dbPath } = await inquirer.prompt([{
      type: 'input',
      name: 'dbPath',
      message: 'Database file path:',
      default: './agenticmail-enterprise.db',
    }]);
    dbConfig.connectionString = dbPath;
  } else if (dbType === 'dynamodb') {
    const { region, accessKeyId, secretAccessKey } = await inquirer.prompt([
      { type: 'input', name: 'region', message: 'AWS Region:', default: 'us-east-1' },
      { type: 'input', name: 'accessKeyId', message: 'AWS Access Key ID:' },
      { type: 'password', name: 'secretAccessKey', message: 'AWS Secret Access Key:', mask: '*' },
    ]);
    dbConfig = { ...dbConfig, region, accessKeyId, secretAccessKey };
  } else if (dbType === 'turso') {
    const { connectionString, authToken } = await inquirer.prompt([
      { type: 'input', name: 'connectionString', message: 'Turso database URL:', placeholder: 'libsql://...' },
      { type: 'password', name: 'authToken', message: 'Turso auth token:', mask: '*' },
    ]);
    dbConfig = { ...dbConfig, connectionString, authToken };
  } else {
    // All other SQL/NoSQL databases use a connection string
    const hints: Record<string, string> = {
      postgres: 'postgresql://user:pass@host:5432/dbname',
      mysql: 'mysql://user:pass@host:3306/dbname',
      mongodb: 'mongodb+srv://user:pass@cluster.mongodb.net/dbname',
      supabase: 'postgresql://postgres:pass@db.xxxx.supabase.co:5432/postgres',
      neon: 'postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/dbname?sslmode=require',
      planetscale: 'mysql://user:pass@aws.connect.psdb.cloud/dbname?ssl={"rejectUnauthorized":true}',
      cockroachdb: 'postgresql://user:pass@cluster.cockroachlabs.cloud:26257/dbname?sslmode=verify-full',
    };
    const { connectionString } = await inquirer.prompt([{
      type: 'input',
      name: 'connectionString',
      message: 'Connection string:',
      suffix: chalk.dim(`  (e.g. ${hints[dbType] || ''})`),
    }]);
    dbConfig.connectionString = connectionString;
  }

  // ─── Step 3: Deployment ─────────────────────────────────

  const { deployTarget } = await inquirer.prompt([{
    type: 'list',
    name: 'deployTarget',
    message: 'Deploy to:',
    choices: [
      { name: `AgenticMail Cloud  ${chalk.dim('(managed, instant URL)')}`, value: 'cloud' },
      { name: `Fly.io  ${chalk.dim('(your account)')}`, value: 'fly' },
      { name: `Railway  ${chalk.dim('(your account)')}`, value: 'railway' },
      { name: `Docker  ${chalk.dim('(self-hosted)')}`, value: 'docker' },
      { name: `Local  ${chalk.dim('(dev/testing, runs here)')}`, value: 'local' },
    ],
  }]);

  // Generate subdomain from company name
  const subdomain = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ─── Step 4: Custom Domain (optional) ──────────────────

  let customDomain: string | undefined;
  if (deployTarget !== 'local') {
    const { wantsDomain } = await inquirer.prompt([{
      type: 'confirm',
      name: 'wantsDomain',
      message: 'Add a custom domain? (can do later)',
      default: false,
    }]);
    if (wantsDomain) {
      const { domain } = await inquirer.prompt([{
        type: 'input',
        name: 'domain',
        message: 'Custom domain:',
        suffix: chalk.dim('  (e.g. agents.acme.com)'),
      }]);
      customDomain = domain;
    }
  }

  // ─── Provisioning ──────────────────────────────────────

  console.log('');
  const spinner = ora('Connecting to database...').start();

  try {
    // Connect to database
    const db = await createAdapter(dbConfig);
    spinner.text = 'Running migrations...';
    await db.migrate();
    spinner.succeed('Database ready');

    // Create company settings
    spinner.start('Creating company...');
    // Insert initial company settings
    // (Using raw SQL since we don't have a createSettings method)
    const settings = await db.updateSettings({
      name: companyName,
      subdomain,
      domain: customDomain,
    });
    spinner.succeed('Company created');

    // Create admin user
    spinner.start('Creating admin account...');
    const admin = await db.createUser({
      email: adminEmail,
      name: 'Admin',
      role: 'owner',
      password: adminPassword,
    });
    await db.logEvent({
      actor: admin.id, actorType: 'system', action: 'setup.complete',
      resource: `company:${subdomain}`,
      details: { dbType, deployTarget, companyName },
    });
    spinner.succeed('Admin account created');

    // Generate JWT secret
    const jwtSecret = randomUUID() + randomUUID();

    // Deploy
    if (deployTarget === 'cloud') {
      spinner.start('Deploying to AgenticMail Cloud...');
      const result = await deployToCloud({ subdomain, plan: 'free' });
      spinner.succeed(`Deployed to ${result.url}`);
      
      console.log('');
      console.log(chalk.green.bold('🎉 Your dashboard is live!'));
      console.log('');
      console.log(`   ${chalk.bold('URL:')}      ${result.url}`);
      console.log(`   ${chalk.bold('Admin:')}    ${adminEmail}`);
      console.log(`   ${chalk.bold('Password:')} (the one you just set)`);
      if (customDomain) {
        console.log('');
        console.log(chalk.dim(`   To use ${customDomain}:`));
        console.log(chalk.dim(`   Add CNAME: ${customDomain} → ${subdomain}.agenticmail.cloud`));
      }

    } else if (deployTarget === 'docker') {
      const compose = generateDockerCompose({
        dbType, dbConnectionString: dbConfig.connectionString || '',
        port: 3000, jwtSecret,
      });
      const { writeFileSync } = await import('fs');
      writeFileSync('docker-compose.yml', compose);
      spinner.succeed('docker-compose.yml generated');
      
      console.log('');
      console.log(chalk.green.bold('🐳 Docker deployment ready!'));
      console.log('');
      console.log('   Run: docker compose up -d');
      console.log('   Dashboard: http://localhost:3000');

    } else if (deployTarget === 'fly') {
      const flyToml = generateFlyToml(`am-${subdomain}`, 'iad');
      const { writeFileSync } = await import('fs');
      writeFileSync('fly.toml', flyToml);
      spinner.succeed('fly.toml generated');
      
      console.log('');
      console.log(chalk.green.bold('🪰 Fly.io deployment ready!'));
      console.log('');
      console.log('   Run: fly launch --copy-config');
      console.log(`   Then: fly secrets set DATABASE_URL="${dbConfig.connectionString}" JWT_SECRET="${jwtSecret}"`);

    } else if (deployTarget === 'local') {
      spinner.start('Starting local server...');
      const server = createServer({ port: 3000, db, jwtSecret });
      server.start();
      spinner.succeed('Server running');
      
      console.log('');
      console.log(chalk.green.bold('🎉 AgenticMail Enterprise is running!'));
      console.log('');
      console.log(`   ${chalk.bold('Dashboard:')}  http://localhost:3000`);
      console.log(`   ${chalk.bold('API:')}        http://localhost:3000/api`);
      console.log(`   ${chalk.bold('Admin:')}      ${adminEmail}`);
      console.log('');
      console.log(chalk.dim('   Press Ctrl+C to stop'));
    }

    console.log('');

  } catch (err: any) {
    spinner.fail(`Setup failed: ${err.message}`);
    console.error('');
    console.error(chalk.dim(err.stack));
    process.exit(1);
  }
}

main().catch(console.error);
