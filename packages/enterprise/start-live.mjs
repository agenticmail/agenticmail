import { createAdapter, createServer } from './dist/index.js';
import { randomUUID } from 'crypto';

const db = await createAdapter({ type: 'sqlite', connectionString: './enterprise-live-test.db' });
await db.migrate();
console.log('✅ DB migrated');

// Check if admin already exists
let user = await db.getUserByEmail('ope@agenticmail.io');
if (!user) {
  user = await db.createUser({
    email: 'ope@agenticmail.io',
    name: 'Ope Olatunji',
    role: 'owner',
    password: 'Enterprise2026!',
  });
  console.log('✅ Admin created:', user.id);
} else {
  console.log('✅ Admin exists:', user.id);
}

await db.updateSettings({ name: 'AgenticMail', subdomain: 'agenticmail', domain: 'agenticmail.io' });
console.log('✅ Company: AgenticMail / agenticmail.io');

const key = await db.createApiKey({ name: 'live-key', createdBy: user.id, scopes: ['read', 'write', 'admin'] });
console.log('✅ API Key:', key.plaintext);

const jwtSecret = randomUUID() + randomUUID();
const server = createServer({ port: 3200, db, jwtSecret, corsOrigins: ['*'], rateLimit: 200 });
await server.start();

console.log('');
console.log('Login: ope@agenticmail.io / Enterprise2026!');
console.log('Key:  ', key.plaintext);

// Keep process alive
process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nShutting down...'); process.exit(0); });
setInterval(() => {}, 60000);
