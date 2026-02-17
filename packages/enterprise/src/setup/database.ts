/**
 * Setup Wizard — Step 2: Database Selection
 *
 * Lets the user pick from 10 database backends and
 * collects the connection details specific to each one.
 */

import { getSupportedDatabases } from '../db/factory.js';

export interface DatabaseSelection {
  type: string;
  connectionString?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  authToken?: string;
}

const CONNECTION_HINTS: Record<string, string> = {
  postgres: 'postgresql://user:pass@host:5432/dbname',
  mysql: 'mysql://user:pass@host:3306/dbname',
  mongodb: 'mongodb+srv://user:pass@cluster.mongodb.net/dbname',
  supabase: 'postgresql://postgres:pass@db.xxxx.supabase.co:5432/postgres',
  neon: 'postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/dbname?sslmode=require',
  planetscale: 'mysql://user:pass@aws.connect.psdb.cloud/dbname?ssl={"rejectUnauthorized":true}',
  cockroachdb: 'postgresql://user:pass@cluster.cockroachlabs.cloud:26257/dbname?sslmode=verify-full',
};

export async function promptDatabase(
  inquirer: any,
  chalk: any,
): Promise<DatabaseSelection> {
  console.log('');
  console.log(chalk.bold.cyan('  Step 2 of 4: Database'));
  console.log(chalk.dim('  Where should your data live?\n'));

  const databases = getSupportedDatabases();
  const { dbType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'dbType',
      message: 'Database backend:',
      choices: databases.map((d: any) => ({
        name: `${d.label}  ${chalk.dim(`(${d.group})`)}`,
        value: d.type,
      })),
    },
  ]);

  // ─── SQLite ────────────────────────────────────────
  if (dbType === 'sqlite') {
    const { dbPath } = await inquirer.prompt([{
      type: 'input',
      name: 'dbPath',
      message: 'Database file path:',
      default: './agenticmail-enterprise.db',
    }]);
    return { type: dbType, connectionString: dbPath };
  }

  // ─── DynamoDB ──────────────────────────────────────
  if (dbType === 'dynamodb') {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'region',
        message: 'AWS Region:',
        default: 'us-east-1',
      },
      {
        type: 'input',
        name: 'accessKeyId',
        message: 'AWS Access Key ID:',
        validate: (v: string) => v.length > 0 || 'Required',
      },
      {
        type: 'password',
        name: 'secretAccessKey',
        message: 'AWS Secret Access Key:',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'Required',
      },
    ]);
    return { type: dbType, ...answers };
  }

  // ─── Turso / LibSQL ────────────────────────────────
  if (dbType === 'turso') {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'connectionString',
        message: 'Turso database URL:',
        suffix: chalk.dim('  (e.g. libsql://db-org.turso.io)'),
        validate: (v: string) => v.length > 0 || 'Required',
      },
      {
        type: 'password',
        name: 'authToken',
        message: 'Turso auth token:',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'Required',
      },
    ]);
    return { type: dbType, connectionString: answers.connectionString, authToken: answers.authToken };
  }

  // ─── All others (connection string) ────────────────
  const hint = CONNECTION_HINTS[dbType] || '';
  const { connectionString } = await inquirer.prompt([{
    type: 'input',
    name: 'connectionString',
    message: 'Connection string:',
    suffix: hint ? chalk.dim(`  (e.g. ${hint})`) : '',
    validate: (v: string) => v.length > 0 || 'Connection string is required',
  }]);

  return { type: dbType, connectionString };
}
