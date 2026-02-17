/**
 * Check your AI agent's inbox using AgenticMail.
 *
 * Run:
 *   npx tsx examples/check-inbox.ts
 */
import { AgenticMailClient } from 'agenticmail';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3100',
  apiKey: 'ak_your_agent_api_key',
});

// List the last 10 emails
const inbox = await client.listInbox(10);
console.log(`You have ${inbox.length} emails:\n`);

for (const msg of inbox) {
  const status = msg.seen ? '  ' : '★ ';
  console.log(`${status}${msg.from} — ${msg.subject}`);
}

// Read a specific email
if (inbox.length > 0) {
  const email = await client.readMessage(inbox[0].uid);
  console.log('\n--- Latest email ---');
  console.log('From:', email.from);
  console.log('Subject:', email.subject);
  console.log('Body:', email.text?.slice(0, 200));
}

// Search for specific emails
const results = await client.search({ from: 'important@example.com' });
console.log(`\nFound ${results.length} emails from important@example.com`);
