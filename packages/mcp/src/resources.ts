const API_URL = process.env.AGENTICMAIL_API_URL ?? 'http://127.0.0.1:3100';
const API_KEY = process.env.AGENTICMAIL_API_KEY ?? '';

async function apiRequest(path: string): Promise<any> {
  if (!API_KEY) {
    throw new Error('API key is not configured. Set AGENTICMAIL_API_KEY.');
  }

  const response = await fetch(`${API_URL}/api/agenticmail${path}`, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    let text: string;
    try { text = await response.text(); } catch { text = '(could not read response body)'; }
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      throw new Error(`API returned invalid JSON from ${path}`);
    }
  }
  return null;
}

export const resourceDefinitions = [
  {
    uri: 'agenticmail://inbox',
    name: 'Agent Inbox',
    description: 'Browse the current agent\'s email inbox',
    mimeType: 'text/plain',
  },
];

export async function handleResourceRead(uri: string): Promise<string> {
  if (uri === 'agenticmail://inbox') {
    const result = await apiRequest('/mail/inbox?limit=20');
    if (!result?.messages?.length) {
      return 'Inbox is empty.';
    }
    const lines = result.messages.map((m: any, i: number) =>
      `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | ${m.date}`,
    );
    return `Inbox:\n${lines.join('\n')}`;
  }

  throw new Error(`Unknown resource: ${uri}`);
}
