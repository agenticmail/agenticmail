/**
 * Send an email using AgenticMail.
 *
 * Prerequisites:
 *   npm install -g agenticmail
 *   agenticmail setup
 *
 * Run:
 *   npx tsx examples/send-email.ts
 */
import { AgenticMailClient } from 'agenticmail';

const client = new AgenticMailClient({
  apiUrl: 'http://127.0.0.1:3100',
  apiKey: 'ak_your_agent_api_key', // from agenticmail setup
});

// Send a simple text email
const result = await client.send({
  to: 'someone@example.com',
  subject: 'Hello from my AI agent',
  text: 'This email was sent by an AI agent using AgenticMail.',
});

console.log('Sent! Message ID:', result.messageId);

// Send an HTML email with attachments
await client.send({
  to: 'team@example.com',
  subject: 'Weekly Report',
  html: '<h1>Weekly Report</h1><p>Everything is on track.</p>',
  cc: 'manager@example.com',
  attachments: [
    {
      filename: 'report.pdf',
      content: Buffer.from('...').toString('base64'),
      contentType: 'application/pdf',
    },
  ],
});
