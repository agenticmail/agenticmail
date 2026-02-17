/**
 * Multi-agent collaboration with AgenticMail.
 *
 * Agents can email each other, assign tasks, and make RPC calls.
 *
 * Run:
 *   npx tsx examples/multi-agent.ts
 */

const API_URL = 'http://127.0.0.1:3100';
const MASTER_KEY = 'mk_your_master_key';

// Create two agents
const createAgent = async (name: string) => {
  const res = await fetch(`${API_URL}/api/agenticmail/accounts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MASTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, role: 'agent' }),
  });
  return res.json();
};

const researcher = await createAgent('researcher');
const writer = await createAgent('writer');

console.log('Created agents:');
console.log(`  researcher: ${researcher.email} (key: ${researcher.apiKey})`);
console.log(`  writer: ${writer.email} (key: ${writer.apiKey})`);

// Researcher assigns a task to the writer
await fetch(`${API_URL}/api/agenticmail/tasks/assign`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${researcher.apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: 'writer',
    task: 'Write a blog post about AI email infrastructure',
    priority: 'high',
  }),
});

console.log('\nTask assigned: researcher → writer');

// Writer checks pending tasks
const tasks = await fetch(`${API_URL}/api/agenticmail/tasks/pending`, {
  headers: { Authorization: `Bearer ${writer.apiKey}` },
}).then(r => r.json());

console.log(`Writer has ${tasks.length} pending tasks`);

// Synchronous RPC call (researcher asks writer, waits for response)
// In a real setup, the writer would have a listener that auto-responds
console.log('\nRPC example: researcher calls writer synchronously');
console.log('(In production, use call_agent for smart orchestration)');
