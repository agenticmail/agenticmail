/**
 * Receive SMS verification codes via Google Voice + AgenticMail.
 *
 * AgenticMail is the first platform to give AI agents both
 * email addresses AND phone numbers.
 *
 * Prerequisites:
 *   1. agenticmail setup (choose to set up phone number)
 *   2. Google Voice number with SMS forwarding enabled
 *
 * Run:
 *   npx tsx examples/sms-verification.ts
 */

const API_URL = 'http://127.0.0.1:3100';
const API_KEY = 'ak_your_agent_api_key';

// Check for new SMS messages
const smsResponse = await fetch(`${API_URL}/api/agenticmail/sms/messages`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const messages = await smsResponse.json();
console.log('Recent SMS messages:', messages);

// Extract verification code from the latest SMS
const codeResponse = await fetch(`${API_URL}/api/agenticmail/sms/latest-code`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const code = await codeResponse.json();

if (code.found) {
  console.log(`Verification code: ${code.code}`);
  console.log(`From: ${code.from}`);
  console.log(`Received: ${code.receivedAt}`);
} else {
  console.log('No verification code found in recent messages');
}

// Send an SMS (via Google Voice)
await fetch(`${API_URL}/api/agenticmail/sms/send`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+12125551234',
    text: 'Hello from my AI agent!',
  }),
});
