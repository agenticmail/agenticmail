import { scheduleFollowUp, drainFollowUps, cancelFollowUp } from './pending-followup.js';

const API_URL = process.env.AGENTICMAIL_API_URL ?? 'http://127.0.0.1:3100';
const API_KEY = process.env.AGENTICMAIL_API_KEY ?? '';
const MASTER_KEY = process.env.AGENTICMAIL_MASTER_KEY ?? '';

if (!API_KEY && !MASTER_KEY) {
  console.error('[agenticmail-mcp] Warning: Neither AGENTICMAIL_API_KEY nor AGENTICMAIL_MASTER_KEY is set');
}

/** Build a check function that returns true if a pending email is still awaiting approval. */
function makePendingCheck(pendingId: string): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetch(`${API_URL}/api/agenticmail/mail/pending/${encodeURIComponent(pendingId)}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const data: any = await res.json();
      return data?.status === 'pending';
    } catch {
      return true;
    }
  };
}

/** Attach any queued follow-up reminders to a text response. */
function withReminders(text: string): string {
  const reminders = drainFollowUps();
  if (reminders.length === 0) return text;
  return text + '\n\n' + reminders.map(r => r.message).join('\n\n');
}

async function apiRequest(method: string, path: string, body?: unknown, useMasterKey = false, timeoutMs = 30_000): Promise<any> {
  const key = useMasterKey && MASTER_KEY ? MASTER_KEY : API_KEY;
  if (!key) {
    throw new Error(useMasterKey
      ? 'Master key is required for this operation. Set AGENTICMAIL_MASTER_KEY.'
      : 'API key is not configured. Set AGENTICMAIL_API_KEY.');
  }

  const headers: Record<string, string> = { 'Authorization': `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_URL}/api/agenticmail${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

export const toolDefinitions = [
  {
    name: 'send_email',
    description: 'Send an email from the agent\'s mailbox. External emails are scanned for sensitive content. HIGH severity detections are BLOCKED and held for owner approval. Your owner will be notified and must approve blocked emails. You CANNOT bypass the outbound guard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        text: { type: 'string', description: 'Plain text body' },
        html: { type: 'string', description: 'HTML body (optional)' },
        cc: { type: 'string', description: 'CC recipients (optional)' },
        inReplyTo: { type: 'string', description: 'Message-ID to reply to (optional)' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message-IDs for threading (optional)',
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Attachment filename' },
              content: { type: 'string', description: 'File content as text string (for text files) or base64-encoded string (for binary files)' },
              contentType: { type: 'string', description: 'MIME type (e.g. text/plain, application/pdf)' },
              encoding: { type: 'string', description: 'Set to "base64" only if content is base64-encoded' },
            },
            required: ['filename', 'content'],
          },
          description: 'File attachments',
        },
      },
      required: ['to', 'subject'],
    },
  },
  {
    name: 'list_inbox',
    description: 'List recent emails in the agent\'s inbox',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Maximum number of messages to return (default: 20)' },
        offset: { type: 'number', description: 'Number of messages to skip (default: 0)' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its UID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The UID of the email to read' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'delete_email',
    description: 'Delete an email by its UID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The UID of the email to delete' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails by criteria (from, to, subject, text, date range). By default searches the local inbox only. Set searchRelay=true to also search the connected Gmail/Outlook account — results include relay UIDs that can be imported with import_relay_email.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Filter by sender address' },
        to: { type: 'string', description: 'Filter by recipient address' },
        subject: { type: 'string', description: 'Filter by subject keyword' },
        text: { type: 'string', description: 'Search body text' },
        since: { type: 'string', description: 'Messages since date (ISO 8601)' },
        before: { type: 'string', description: 'Messages before date (ISO 8601)' },
        seen: { type: 'boolean', description: 'Filter by read/unread status' },
        searchRelay: { type: 'boolean', description: 'Also search the connected Gmail/Outlook account (default: false). Use this to find past emails from the user\'s main inbox.' },
      },
    },
  },
  {
    name: 'import_relay_email',
    description: 'Import an email from the connected Gmail/Outlook account into the agent\'s local inbox. This downloads the full message with all headers (Message-ID, In-Reply-To, References) so you can continue the thread using reply_email. Use search_emails with searchRelay=true first to find the relay UID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'The relay UID of the email to import (from search_emails relay results)' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'reply_email',
    description: 'Reply to an email. Fetches the original message, auto-fills To, Subject (Re:), In-Reply-To, and References, then sends with quoted body. Outbound guard applies — HIGH severity content is held for review.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to reply to' },
        text: { type: 'string', description: 'Your reply text' },
        html: { type: 'string', description: 'HTML reply (optional)' },
        replyAll: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
      },
      required: ['uid', 'text'],
    },
  },
  {
    name: 'forward_email',
    description: 'Forward an email to another recipient. Outbound guard applies — HIGH severity content is held for review.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to forward' },
        to: { type: 'string', description: 'Recipient to forward to' },
        text: { type: 'string', description: 'Additional message (optional)' },
      },
      required: ['uid', 'to'],
    },
  },
  {
    name: 'move_email',
    description: 'Move an email to another folder (e.g., Trash, Archive)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email to move' },
        to: { type: 'string', description: 'Destination folder (e.g., Trash, Archive)' },
        from: { type: 'string', description: 'Source folder (default: INBOX)' },
      },
      required: ['uid', 'to'],
    },
  },
  {
    name: 'mark_unread',
    description: 'Mark an email as unread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'mark_read',
    description: 'Mark an email as read',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uid: { type: 'number', description: 'UID of the email' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'list_folders',
    description: 'List all mail folders/mailboxes',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_folder',
    description: 'List messages in a specific folder',
    inputSchema: {
      type: 'object' as const,
      properties: {
        folder: { type: 'string', description: 'Folder path (e.g., INBOX, Trash, Sent)' },
        limit: { type: 'number', description: 'Max messages (default: 20)' },
        offset: { type: 'number', description: 'Skip messages (default: 0)' },
      },
      required: ['folder'],
    },
  },
  {
    name: 'batch_delete',
    description: 'Delete multiple emails by UIDs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to delete' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'batch_mark_read',
    description: 'Mark multiple emails as read',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to mark as read' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'manage_contacts',
    description: 'List, add, or delete contacts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'delete'], description: 'Action to perform' },
        email: { type: 'string', description: 'Contact email (for add)' },
        name: { type: 'string', description: 'Contact name (for add)' },
        id: { type: 'string', description: 'Contact ID (for delete)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_drafts',
    description: 'List, create, update, send, or delete drafts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'send', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Draft ID (for update/send/delete)' },
        to: { type: 'string', description: 'Recipient (for create/update)' },
        subject: { type: 'string', description: 'Subject (for create/update)' },
        text: { type: 'string', description: 'Body text (for create/update)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_scheduled',
    description: 'Manage scheduled emails: create a new scheduled email, list pending ones, or cancel one. Accepts flexible time formats for create: ISO 8601, relative ("in 30 minutes"), named ("tomorrow 8am"), day-based ("next monday 9am"), or human-friendly ("02-14-2026 3:30 PM EST").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'Action to perform (default: create)' },
        to: { type: 'string', description: 'Recipient email (for create)' },
        subject: { type: 'string', description: 'Email subject (for create)' },
        text: { type: 'string', description: 'Body text (for create)' },
        sendAt: { type: 'string', description: 'When to send (for create)' },
        id: { type: 'string', description: 'Scheduled email ID (for cancel)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new mail folder for organizing emails',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Folder name (e.g., Projects, Clients, Newsletters)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'manage_tags',
    description: 'Create, list, delete tags, tag/untag messages, get messages by tag, or get all tags for a specific message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete', 'tag_message', 'untag_message', 'get_messages', 'get_message_tags'], description: 'Action to perform' },
        name: { type: 'string', description: 'Tag name (for create)' },
        color: { type: 'string', description: 'Tag color hex code (for create, e.g. #ff0000)' },
        id: { type: 'string', description: 'Tag ID (for delete, tag_message, untag_message, get_messages)' },
        uid: { type: 'number', description: 'Message UID (for tag_message, untag_message)' },
        folder: { type: 'string', description: 'Folder the message is in (default: INBOX)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_account',
    description: 'Create a new agent email account (requires master API key)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent name (will be used as email local part)' },
        domain: { type: 'string', description: 'Email domain (default: localhost)' },
        role: { type: 'string', enum: ['secretary', 'assistant', 'researcher', 'writer', 'custom'], description: 'Agent role (default: secretary)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'setup_email_relay',
    description: 'Configure Gmail/Outlook relay for sending real internet email (requires master API key). BEGINNER-FRIENDLY: Just needs a Gmail/Outlook email + app password. Agents send as user+agentname@gmail.com. Automatically creates a default agent (secretary) unless skipped. Best for: quick setup, personal use, no domain needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        provider: { type: 'string', enum: ['gmail', 'outlook', 'custom'], description: 'Email provider (gmail, outlook, or custom)' },
        email: { type: 'string', description: 'Your real email address (e.g., user@gmail.com)' },
        password: { type: 'string', description: 'App password (not your regular password)' },
        smtpHost: { type: 'string', description: 'SMTP host (auto-filled for gmail/outlook)' },
        smtpPort: { type: 'number', description: 'SMTP port (auto-filled for gmail/outlook)' },
        imapHost: { type: 'string', description: 'IMAP host (auto-filled for gmail/outlook)' },
        imapPort: { type: 'number', description: 'IMAP port (auto-filled for gmail/outlook)' },
        agentName: { type: 'string', description: 'Name for the default agent (default: secretary). This becomes the email sub-address, e.g., user+secretary@gmail.com' },
        agentRole: { type: 'string', enum: ['secretary', 'assistant', 'researcher', 'writer', 'custom'], description: 'Role for the default agent (default: secretary)' },
        skipDefaultAgent: { type: 'boolean', description: 'Skip creating the default agent (default: false)' },
      },
      required: ['provider', 'email', 'password'],
    },
  },
  {
    name: 'setup_email_domain',
    description: 'Set up a custom domain for real internet email via Cloudflare (requires master API key). ADVANCED: Requires Cloudflare account, API token, and a domain. Emails send from agent@yourdomain.com with full DKIM/SPF/DMARC. Optionally configures Gmail SMTP as outbound relay (recommended for residential IPs). After setup with gmailRelay, use setup_gmail_alias for each agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cloudflareToken: { type: 'string', description: 'Cloudflare API token (Zone>Zone>Read, Zone>DNS>Edit, Zone>Email Routing Rules>Edit, Account>Cloudflare Tunnel>Edit, Account>Workers Scripts>Edit; optional: Account>Registrar: Domains>Edit for domain purchase)' },
        cloudflareAccountId: { type: 'string', description: 'Cloudflare account ID' },
        domain: { type: 'string', description: 'Domain to use (if already owned)' },
        purchase: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for available domains' },
            tld: { type: 'string', description: 'Preferred TLD (e.g., .com, .io)' },
          },
          description: 'Purchase a new domain (if domain not provided)',
        },
        gmailRelay: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Gmail address for SMTP relay (e.g., you@gmail.com)' },
            appPassword: { type: 'string', description: 'Gmail app password (from https://myaccount.google.com/apppasswords)' },
          },
          description: 'Gmail SMTP relay for outbound delivery (recommended for residential IPs without PTR records)',
        },
      },
      required: ['cloudflareToken', 'cloudflareAccountId'],
    },
  },
  {
    name: 'setup_guide',
    description: 'Get a comparison of email setup modes (Relay vs Domain) with difficulty levels, requirements, pros/cons, and step-by-step instructions. Show this to users who want to set up real internet email.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'setup_gmail_alias',
    description: 'Get step-by-step instructions (with exact field values) to add an agent email as a Gmail "Send mail as" alias. Returns the Gmail settings URL and all field values. Required after domain mode setup with gmailRelay to show correct From address. The agent can automate this via browser tools or present instructions to the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentEmail: { type: 'string', description: 'Agent email to add as alias (e.g., secretary@yourdomain.com)' },
        agentDisplayName: { type: 'string', description: 'Display name for the alias (defaults to agent name)' },
      },
      required: ['agentEmail'],
    },
  },
  {
    name: 'setup_payment',
    description: 'Get instructions for adding a payment method to Cloudflare (required before purchasing domains). Returns Option A (self-service link) and Option B (browser automation steps). Card details go directly to Cloudflare — never stored by AgenticMail.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'purchase_domain',
    description: 'Search for available domains via Cloudflare Registrar (requires master API key). NOTE: Cloudflare API only supports READ access — domains must be purchased manually at https://dash.cloudflare.com or from another registrar (then point nameservers to Cloudflare).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for (e.g., ["mybot", "aimail"])' },
        tld: { type: 'string', description: 'Preferred TLD (default: checks .com, .net, .io, .dev)' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'check_gateway_status',
    description: 'Check the current email gateway status — relay mode, domain mode, or not configured',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'send_test_email',
    description: 'Send a test email through the gateway to verify configuration (requires master API key)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Email address to send the test to' },
      },
      required: ['to'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all AI agents in the system with their email addresses and roles. Use this to discover which agents you can communicate with via message_agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'message_agent',
    description: 'Send a message to another AI agent by name. The message is delivered to their email inbox. Use list_agents first to see available agents. This is the primary way for agents to coordinate and share information with each other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Name of the recipient agent (e.g. "researcher", "writer")' },
        subject: { type: 'string', description: 'Message subject — describe the purpose clearly' },
        text: { type: 'string', description: 'Message body' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'Priority level (default: normal)' },
      },
      required: ['agent', 'subject', 'text'],
    },
  },
  {
    name: 'check_messages',
    description: 'Check for new unread messages from other agents or external senders. Returns a summary of pending communications. Use this to stay aware of requests and coordinate with other agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_agent',
    description: 'Delete an agent account. Archives all emails and generates a deletion report before removing the account permanently. Returns the deletion summary. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the agent to delete' },
        reason: { type: 'string', description: 'Reason for deletion (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deletion_reports',
    description: 'List past agent deletion reports or retrieve a specific report by ID. Shows archived email summaries from deleted agents. Requires master API key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Deletion report ID (omit to list all reports)' },
      },
    },
  },
  {
    name: 'manage_signatures',
    description: 'List, create, or delete email signatures',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Signature ID (for delete)' },
        name: { type: 'string', description: 'Signature name (for create)' },
        text: { type: 'string', description: 'Signature text content (for create)' },
        isDefault: { type: 'boolean', description: 'Set as default signature (for create)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_templates',
    description: 'List, create, or delete email templates',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Template ID (for delete)' },
        name: { type: 'string', description: 'Template name (for create)' },
        subject: { type: 'string', description: 'Template subject (for create)' },
        text: { type: 'string', description: 'Template body text (for create)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'batch_mark_unread',
    description: 'Mark multiple emails as unread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to mark as unread' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'batch_move',
    description: 'Move multiple emails to another folder',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to move' },
        from: { type: 'string', description: 'Source folder (default: INBOX)' },
        to: { type: 'string', description: 'Destination folder (e.g., Trash, Archive)' },
      },
      required: ['uids', 'to'],
    },
  },
  {
    name: 'whoami',
    description: 'Get the current agent\'s account info — name, email, role, and metadata',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'update_metadata',
    description: 'Update the current agent\'s metadata. Merges provided keys with existing metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        metadata: { type: 'object', description: 'Metadata key-value pairs to set or update' },
      },
      required: ['metadata'],
    },
  },
  {
    name: 'check_health',
    description: 'Check AgenticMail server health status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'wait_for_email',
    description: 'Wait for a new email or task notification using push notifications (SSE). Blocks until an email arrives, a task is assigned to you, or timeout is reached. Much more efficient than polling — use this when waiting for a reply or a task from another agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        timeout: { type: 'number', description: 'Max seconds to wait (default: 120, max: 300)' },
      },
    },
  },
  {
    name: 'batch_read',
    description: 'Read multiple emails at once by UIDs. Returns full parsed content for each message in a single call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uids: { type: 'array', items: { type: 'number' }, description: 'Array of UIDs to read' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
      },
      required: ['uids'],
    },
  },
  {
    name: 'inbox_digest',
    description: 'Get a compact inbox digest with subject, sender, date, flags and text preview for each message. More efficient than listing then reading individually.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max messages (default: 20, max: 50)' },
        offset: { type: 'number', description: 'Skip messages (default: 0)' },
        folder: { type: 'string', description: 'Folder (default: INBOX)' },
        previewLength: { type: 'number', description: 'Preview text length (default: 200, max: 500)' },
      },
    },
  },
  {
    name: 'template_send',
    description: 'Send an email using a saved template with variable substitution. Variables like {{name}} are replaced.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Template ID' },
        to: { type: 'string', description: 'Recipient email' },
        variables: { type: 'object', description: 'Variables to substitute: { name: "Alice" }' },
        cc: { type: 'string', description: 'CC recipients' },
        bcc: { type: 'string', description: 'BCC recipients' },
      },
      required: ['id', 'to'],
    },
  },
  {
    name: 'manage_rules',
    description: 'Manage server-side email rules that auto-process incoming messages (move, tag, mark read, delete).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Rule ID (for delete)' },
        name: { type: 'string', description: 'Rule name (for create)' },
        priority: { type: 'number', description: 'Higher priority rules match first (for create)' },
        conditions: { type: 'object', description: 'Match conditions: { from_contains?, subject_contains?, subject_regex?, to_contains?, has_attachment? }' },
        actions: { type: 'object', description: 'Actions on match: { move_to?, mark_read?, delete?, add_tags? }' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cleanup_agents',
    description: 'List or remove inactive non-persistent agent accounts (requires master API key)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list_inactive', 'cleanup', 'set_persistent'], description: 'Action to perform' },
        hours: { type: 'number', description: 'Inactivity threshold in hours (default: 24)' },
        dryRun: { type: 'boolean', description: 'Preview without deleting (for cleanup)' },
        agentId: { type: 'string', description: 'Agent ID (for set_persistent)' },
        persistent: { type: 'boolean', description: 'Set persistent flag (for set_persistent)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'assign_task',
    description: 'Assign a task to another agent via the task queue',
    inputSchema: {
      type: 'object' as const,
      properties: {
        assignee: { type: 'string', description: 'Agent name to assign the task to' },
        taskType: { type: 'string', description: 'Task category (default: generic)' },
        payload: { type: 'object', description: 'Task data/instructions' },
        expiresInSeconds: { type: 'number', description: 'Task expiry in seconds' },
      },
      required: ['assignee'],
    },
  },
  {
    name: 'check_tasks',
    description: 'Check for pending tasks assigned to you (or a specific agent) or tasks you assigned to others',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', enum: ['incoming', 'outgoing'], description: 'incoming (assigned to me) or outgoing (I assigned)' },
        assignee: { type: 'string', description: 'Check tasks for a specific agent by name (only for incoming direction)' },
      },
    },
  },
  {
    name: 'claim_task',
    description: 'Claim a pending task assigned to you',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID to claim' },
      },
      required: ['id'],
    },
  },
  {
    name: 'submit_result',
    description: 'Submit the result for a claimed task, marking it as completed',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID' },
        result: { type: 'object', description: 'Task result data' },
      },
      required: ['id'],
    },
  },
  {
    name: 'call_agent',
    description: 'Synchronous RPC: assign a task to another agent, notify them via email (wakes wait_for_email), and wait for the result. Times out after specified duration.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Name of the agent to call' },
        task: { type: 'string', description: 'Task description' },
        payload: { type: 'object', description: 'Additional data' },
        timeout: { type: 'number', description: 'Max seconds to wait (default: 180, max: 300)' },
      },
      required: ['target', 'task'],
    },
  },
  {
    name: 'manage_spam',
    description: 'Manage spam: list spam folder, report a message as spam, mark as not-spam, or get the spam score of a message. Emails are auto-scored on arrival; high-scoring messages are moved to Spam automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'report', 'not_spam', 'score'], description: 'Action to perform' },
        uid: { type: 'number', description: 'Message UID (for report, not_spam, score)' },
        folder: { type: 'string', description: 'Source folder (for report/score, default: INBOX)' },
        limit: { type: 'number', description: 'Max messages to list (for list, default: 20)' },
        offset: { type: 'number', description: 'Skip messages (for list, default: 0)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_pending_emails',
    description: 'Check the status of pending outbound emails blocked by the outbound guard. You can list all your pending emails or get details of a specific one. You CANNOT approve or reject — only the owner can do that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'Action to perform (list or get only — approve/reject require owner)' },
        id: { type: 'string', description: 'Pending email ID (required for get)' },
      },
      required: ['action'],
    },
  },
];

// Tools that require master key access
const MASTER_KEY_TOOLS = new Set([
  'create_account', 'setup_email_relay', 'setup_email_domain',
  'setup_guide', 'setup_gmail_alias', 'setup_payment',
  'purchase_domain', 'check_gateway_status', 'send_test_email',
  'delete_agent', 'deletion_reports', 'cleanup_agents',
]);

// ─── Inline Inbound Security Advisory ─────────────────────────────────

const MCP_EXEC_EXTS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.scr', '.com', '.vbs', '.js', '.wsf', '.hta', '.cpl', '.jar', '.app', '.dmg', '.run']);
const MCP_ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.cab', '.iso']);

function mcpBuildSecuritySection(security: any, attachments: any[]): string {
  const lines: string[] = [];

  if (security?.isSpam) {
    lines.push(`[SPAM] Score: ${security.score}, Category: ${security.topCategory ?? security.category} — This email was flagged as spam`);
  } else if (security?.isWarning) {
    lines.push(`[WARNING] Score: ${security.score}, Category: ${security.topCategory ?? security.category} — Treat with caution`);
  }

  if (security?.sanitized && security.sanitizeDetections?.length) {
    lines.push(`Content sanitized: ${security.sanitizeDetections.map((d: any) => d.type).join(', ')}`);
  }

  if (attachments?.length) {
    for (const att of attachments) {
      const name = att.filename ?? 'unknown';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
      const parts = lower.split('.');
      if (parts.length > 2 && MCP_EXEC_EXTS.has('.' + parts[parts.length - 1])) {
        lines.push(`  [CRITICAL] "${name}": DOUBLE EXTENSION — Disguised executable`);
      } else if (MCP_EXEC_EXTS.has(ext)) {
        lines.push(`  [HIGH] "${name}": EXECUTABLE file — DO NOT open or trust`);
      } else if (MCP_ARCHIVE_EXTS.has(ext)) {
        lines.push(`  [MEDIUM] "${name}": ARCHIVE — May contain malware`);
      } else if (ext === '.html' || ext === '.htm') {
        lines.push(`  [HIGH] "${name}": HTML file — May contain phishing/scripts`);
      }
    }
  }

  const matches: Array<{ ruleId: string }> = security?.spamMatches ?? security?.matches ?? [];
  for (const m of matches) {
    if (m.ruleId === 'ph_mismatched_display_url') lines.push('  [!] Mismatched display URL — PHISHING');
    else if (m.ruleId === 'ph_data_uri') lines.push('  [!] data: URI in link — may execute code');
    else if (m.ruleId === 'ph_homograph') lines.push('  [!] Homograph domain — mimicking legitimate domain');
    else if (m.ruleId === 'ph_spoofed_sender') lines.push('  [!] Spoofed brand sender');
    else if (m.ruleId === 'de_webhook_exfil') lines.push('  [!] Suspicious webhook URL — data exfiltration risk');
    else if (m.ruleId === 'pi_invisible_unicode') lines.push('  [!] Invisible unicode — hidden instructions');
  }

  if (lines.length === 0) return '';
  return `\n--- Security ---\n${lines.join('\n')}`;
}

// ─── Inline Outbound Guard (defense-in-depth) ────────────────────────

interface McpOutboundWarning { category: string; severity: 'high' | 'medium'; ruleId: string; description: string; match: string; }
interface McpOutboundScanResult { warnings: McpOutboundWarning[]; blocked: boolean; summary: string; }

const MCP_OB_RULES: Array<{ id: string; cat: string; sev: 'high' | 'medium'; desc: string; test: (t: string) => string | null; }> = [
  // PII
  { id: 'ob_ssn', cat: 'pii', sev: 'high', desc: 'SSN', test: t => { const m = t.match(/\b\d{3}-\d{2}-\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_ssn_obfuscated', cat: 'pii', sev: 'high', desc: 'SSN (obfuscated)', test: t => {
    const m1 = t.match(/\b\d{3}\.\d{2}\.\d{4}\b/); if (m1) return m1[0];
    const m2 = t.match(/\b\d{3}\s\d{2}\s\d{4}\b/); if (m2) return m2[0];
    const m3 = t.match(/\b(?:ssn|social\s*security|soc\s*sec)\s*(?:#|number|num|no)?[\s:]*\d{9}\b/i); if (m3) return m3[0];
    return null;
  } },
  { id: 'ob_credit_card', cat: 'pii', sev: 'high', desc: 'Credit card', test: t => { const m = t.match(/\b(?:\d{4}[-\s]?){3}\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_phone', cat: 'pii', sev: 'medium', desc: 'Phone number', test: t => { const m = t.match(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/); return m ? m[0] : null; } },
  { id: 'ob_bank_routing', cat: 'pii', sev: 'high', desc: 'Bank routing/account', test: t => { const m = t.match(/\b(?:routing|account|acct)\s*(?:#|number|num|no)?[\s:]*\d{6,17}\b/i); return m ? m[0] : null; } },
  { id: 'ob_drivers_license', cat: 'pii', sev: 'high', desc: "Driver's license", test: t => { const m = t.match(/\b(?:driver'?s?\s*(?:license|licence|lic)|DL)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9][A-Z0-9-]{4,14}\b/i); return m ? m[0] : null; } },
  { id: 'ob_dob', cat: 'pii', sev: 'medium', desc: 'Date of birth', test: t => { const m = t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/i) ?? t.match(/\b(?:date\s+of\s+birth|DOB|born\s+on|birthday|birthdate)\s*[:=]?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i); return m ? m[0] : null; } },
  { id: 'ob_passport', cat: 'pii', sev: 'high', desc: 'Passport number', test: t => { const m = t.match(/\b(?:passport)\s*(?:#|number|num|no)?[\s:]*[A-Z0-9]{6,12}\b/i); return m ? m[0] : null; } },
  { id: 'ob_tax_id', cat: 'pii', sev: 'high', desc: 'Tax ID / EIN', test: t => { const m = t.match(/\b(?:EIN|TIN|tax\s*(?:id|identification)|employer\s*id)\s*(?:#|number|num|no)?[\s:]*\d{2}-?\d{7}\b/i); return m ? m[0] : null; } },
  { id: 'ob_itin', cat: 'pii', sev: 'high', desc: 'ITIN', test: t => { const m = t.match(/\bITIN\s*(?:#|number|num|no)?[\s:]*9\d{2}-?\d{2}-?\d{4}\b/i); return m ? m[0] : null; } },
  { id: 'ob_medicare', cat: 'pii', sev: 'high', desc: 'Medicare/Medicaid ID', test: t => { const m = t.match(/\b(?:medicare|medicaid|health\s*(?:insurance|plan))\s*(?:#|id|number|num|no)?[\s:]*[A-Z0-9]{8,14}\b/i); return m ? m[0] : null; } },
  { id: 'ob_immigration', cat: 'pii', sev: 'high', desc: 'Immigration A-number', test: t => { const m = t.match(/\b(?:A-?number|alien\s*(?:#|number|num|no)?|USCIS)\s*[:=\s]*A?-?\d{8,9}\b/i); return m ? m[0] : null; } },
  { id: 'ob_pin', cat: 'pii', sev: 'medium', desc: 'PIN code', test: t => { const m = t.match(/\b(?:PIN|pin\s*code|pin\s*number)\s*[:=]\s*\d{4,8}\b/i); return m ? m[0] : null; } },
  { id: 'ob_security_qa', cat: 'pii', sev: 'medium', desc: 'Security Q&A', test: t => { const m = t.match(/\b(?:security\s*question|secret\s*question|challenge\s*question)\s*[:=]?\s*.{5,80}(?:answer|response)\s*[:=]?\s*\S+/i) ?? t.match(/\b(?:security\s*(?:answer|response)|mother'?s?\s*maiden\s*name|first\s*pet'?s?\s*name)\s*[:=]?\s*\S{2,}/i); return m ? m[0].slice(0, 80) : null; } },
  // Financial
  { id: 'ob_iban', cat: 'pii', sev: 'high', desc: 'IBAN', test: t => { const m = t.match(/\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/); return m ? m[0] : null; } },
  { id: 'ob_swift', cat: 'pii', sev: 'medium', desc: 'SWIFT/BIC', test: t => { const m = t.match(/\b(?:SWIFT|BIC|swift\s*code|bic\s*code)\s*[:=]?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/i); return m ? m[0] : null; } },
  { id: 'ob_crypto_wallet', cat: 'pii', sev: 'high', desc: 'Crypto wallet', test: t => { const m = t.match(/\b(?:bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/); return m ? m[0] : null; } },
  { id: 'ob_wire_transfer', cat: 'pii', sev: 'high', desc: 'Wire transfer', test: t => { if (/\bwire\s+(?:transfer|funds?|payment|to)\b/i.test(t) && /\b(?:routing|account|swift|iban|beneficiary)\b/i.test(t)) return 'wire transfer instructions'; return null; } },
  // Credentials
  { id: 'ob_api_key', cat: 'credential', sev: 'high', desc: 'API key', test: t => { const m = t.match(/\b(?:sk_|pk_|rk_|api_key_|apikey_)[a-zA-Z0-9_]{20,}\b/i) ?? t.match(/\b(?:sk-(?:proj|ant|live|test)-)[a-zA-Z0-9_-]{20,}/); return m ? m[0] : null; } },
  { id: 'ob_aws_key', cat: 'credential', sev: 'high', desc: 'AWS key', test: t => { const m = t.match(/\bAKIA[A-Z0-9]{16}\b/); return m ? m[0] : null; } },
  { id: 'ob_password_value', cat: 'credential', sev: 'high', desc: 'Password', test: t => { const m = t.match(/\bp[a@4]ss(?:w[o0]rd)?\s*[:=]\s*\S+/i); return m ? m[0] : null; } },
  { id: 'ob_private_key', cat: 'credential', sev: 'high', desc: 'Private key', test: t => { const m = t.match(/-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i); return m ? m[0] : null; } },
  { id: 'ob_bearer_token', cat: 'credential', sev: 'high', desc: 'Bearer token', test: t => { const m = t.match(/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_connection_string', cat: 'credential', sev: 'high', desc: 'Connection string', test: t => { const m = t.match(/\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s]+/i); return m ? m[0] : null; } },
  { id: 'ob_github_token', cat: 'credential', sev: 'high', desc: 'GitHub token', test: t => { const m = t.match(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[a-zA-Z0-9_]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_stripe_key', cat: 'credential', sev: 'high', desc: 'Stripe key', test: t => { const m = t.match(/\b(?:sk_live_|pk_live_|rk_live_|sk_test_|pk_test_|rk_test_)[a-zA-Z0-9]{20,}\b/); return m ? m[0] : null; } },
  { id: 'ob_jwt', cat: 'credential', sev: 'high', desc: 'JWT token', test: t => { const m = t.match(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_webhook_url', cat: 'credential', sev: 'high', desc: 'Webhook URL', test: t => { const m = t.match(/\bhttps?:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|[\w.-]+\.webhook\.site)\/\S+/i); return m ? m[0] : null; } },
  { id: 'ob_env_block', cat: 'credential', sev: 'high', desc: '.env block', test: t => { const lines = t.split('\n'); let c = 0, f = ''; for (const l of lines) { if (/^[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(l.trim())) { if (++c === 1) f = l.trim(); if (c >= 3) return f + '...'; } else if (l.trim() !== '' && !l.trim().startsWith('#')) c = 0; } return null; } },
  { id: 'ob_seed_phrase', cat: 'credential', sev: 'high', desc: 'Seed/recovery phrase', test: t => { const m = t.match(/\b(?:seed\s*phrase|recovery\s*phrase|mnemonic|backup\s*words)\s*[:=]?\s*.{10,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_2fa_codes', cat: 'credential', sev: 'high', desc: '2FA codes', test: t => { const m = t.match(/\b(?:2fa|two.factor|backup|recovery)\s*(?:code|key)s?\s*[:=]?\s*(?:[A-Z0-9]{4,8}[\s,;-]+){2,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_credential_pair', cat: 'credential', sev: 'high', desc: 'Username+password pair', test: t => { const m = t.match(/\b(?:user(?:name)?|email|login)\s*[:=]\s*\S+[\s,;]+(?:password|passwd|pass|pwd)\s*[:=]\s*\S+/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_oauth_token', cat: 'credential', sev: 'high', desc: 'OAuth token', test: t => { const m = t.match(/\b(?:access_token|refresh_token|oauth_token)\s*[:=]\s*[a-zA-Z0-9_\-.]{20,}/i); return m ? m[0].slice(0, 80) : null; } },
  { id: 'ob_vpn_creds', cat: 'credential', sev: 'high', desc: 'VPN credentials', test: t => { const m = t.match(/\b(?:vpn|openvpn|wireguard|ipsec)\b.*\b(?:password|key|secret|credential|pre.?shared)\b/i); return m ? m[0].slice(0, 80) : null; } },
  // System internals
  { id: 'ob_private_ip', cat: 'system_internal', sev: 'medium', desc: 'Private IP', test: t => { const m = t.match(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/); return m ? m[0] : null; } },
  { id: 'ob_file_path', cat: 'system_internal', sev: 'medium', desc: 'File path', test: t => { const m = t.match(/(?:\/Users\/|\/home\/|\/etc\/|\/var\/|C:\\Users\\|C:\\Windows\\)\S+/i); return m ? m[0] : null; } },
  { id: 'ob_env_variable', cat: 'system_internal', sev: 'medium', desc: 'Env variable', test: t => { const m = t.match(/\b[A-Z][A-Z0-9_]{2,}(?:_URL|_KEY|_SECRET|_TOKEN|_PASSWORD|_HOST|_PORT|_DSN)\s*=\s*\S+/); return m ? m[0] : null; } },
  // Owner privacy
  { id: 'ob_owner_info', cat: 'owner_privacy', sev: 'high', desc: 'Owner info', test: t => { const m = t.match(/\b(?:my\s+)?owner'?s?\s+(?:name|address|phone|email|password|social|ssn|credit\s+card|bank|account)\b/i); return m ? m[0] : null; } },
  { id: 'ob_personal_reveal', cat: 'owner_privacy', sev: 'high', desc: 'Personal reveal', test: t => { const m = t.match(/\b(?:the\s+person\s+who\s+(?:owns|runs|operates)\s+me|my\s+(?:human|creator|operator)\s+(?:is|lives|works|named))\b/i); return m ? m[0] : null; } },
];

const MCP_OB_HIGH_RISK_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.env', '.credentials', '.keystore', '.jks', '.p8']);
const MCP_OB_MEDIUM_RISK_EXT = new Set(['.db', '.sqlite', '.sqlite3', '.sql', '.csv', '.tsv', '.json', '.yml', '.yaml', '.conf', '.config', '.ini']);

function mcpStripHtml(h: string): string { return h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' '); }

function mcpScanOutbound(to: string | string[], subject?: string, text?: string, html?: string, attachments?: Array<{ filename?: string }>): McpOutboundScanResult {
  const recipients = Array.isArray(to) ? to : [to];
  if (recipients.every(r => r.endsWith('@localhost'))) return { warnings: [], blocked: false, summary: '' };
  const warnings: McpOutboundWarning[] = [];
  const combined = [subject ?? '', text ?? '', html ? mcpStripHtml(html) : ''].join('\n');
  if (combined.trim()) {
    for (const rule of MCP_OB_RULES) {
      const match = rule.test(combined);
      if (match) warnings.push({ category: rule.cat, severity: rule.sev, ruleId: rule.id, description: rule.desc, match: match.length > 80 ? match.slice(0, 80) + '...' : match });
    }
  }
  if (attachments?.length) {
    for (const att of attachments) {
      const name = att.filename ?? '';
      const lower = name.toLowerCase();
      const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
      if (MCP_OB_HIGH_RISK_EXT.has(ext)) warnings.push({ category: 'attachment_risk', severity: 'high', ruleId: 'ob_sensitive_file', description: `Sensitive file: ${ext}`, match: name });
      else if (MCP_OB_MEDIUM_RISK_EXT.has(ext)) warnings.push({ category: 'attachment_risk', severity: 'medium', ruleId: 'ob_data_file', description: `Data file: ${ext}`, match: name });
    }
  }
  const hasHigh = warnings.some(w => w.severity === 'high');
  return {
    warnings, blocked: hasHigh,
    summary: warnings.length === 0 ? '' : hasHigh
      ? `OUTBOUND GUARD BLOCKED: ${warnings.length} warning(s) with HIGH severity. Email NOT sent.`
      : `OUTBOUND GUARD: ${warnings.length} warning(s). Review before sending.`,
  };
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  const useMaster = MASTER_KEY_TOOLS.has(name);

  switch (name) {
    case 'send_email': {
      const sendBody: Record<string, unknown> = {
        to: args.to,
        subject: args.subject,
        text: args.text ?? '',
        html: args.html,
        cc: args.cc,
        inReplyTo: args.inReplyTo,
        references: args.references,
      };
      if (Array.isArray(args.attachments) && args.attachments.length > 0) {
        sendBody.attachments = (args.attachments as any[]).map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          ...(a.encoding ? { encoding: a.encoding } : {}),
        }));
      }
      const result = await apiRequest('POST', '/mail/send', sendBody);

      // Check if API held the email for review
      if (result?.blocked && result?.pendingId) {
        scheduleFollowUp(result.pendingId, String(args.to), String(args.subject || '(no subject)'), makePendingCheck(result.pendingId));
        return `Email NOT sent — blocked by outbound guard.\n${result.summary}\n\nPending ID: ${result.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the email was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this email is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Email sent successfully. Message ID: ${result?.messageId ?? 'unknown'}`;
      if (result?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n[WARNING] ${result.outboundWarnings.length} potential issue(s):\n${result.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}: ${w.match}`).join('\n')}`;
      }
      return response;
    }

    case 'list_inbox': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const result = await apiRequest('GET', `/mail/inbox?limit=${limit}&offset=${offset}`);
      if (!result?.messages?.length) {
        return 'Inbox is empty.';
      }
      const lines = result.messages.map((m: any, i: number) =>
        `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`,
      );
      return `Inbox (${result.messages.length} messages):\n${lines.join('\n')}`;
    }

    case 'read_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer');
      }
      const result = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!result) throw new Error('Email not found or empty response');
      const lines: (string | null)[] = [
        `From: ${result.from?.map((a: any) => a.address).join(', ') ?? 'unknown'}`,
        `To: ${result.to?.map((a: any) => a.address).join(', ') ?? 'unknown'}`,
        `Subject: ${result.subject}`,
        `Date: ${result.date}`,
        `Message-ID: ${result.messageId}`,
        result.inReplyTo ? `In-Reply-To: ${result.inReplyTo}` : null,
        '---',
        result.text ?? result.html ?? '(no body)',
      ];
      if (result.attachments?.length) {
        lines.push('---');
        lines.push(`Attachments (${result.attachments.length}):`);
        for (const att of result.attachments) {
          lines.push(`  - ${att.filename} (${att.contentType}, ${Math.round(att.size / 1024)}KB)`);
        }
      }
      const secSection = mcpBuildSecuritySection(result.security, result.attachments);
      if (secSection) lines.push(secSection);
      return lines.filter(line => line !== null).join('\n');
    }

    case 'delete_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer');
      }
      await apiRequest('DELETE', `/mail/messages/${uid}`);
      return `Email UID ${uid} deleted successfully.`;
    }

    case 'search_emails': {
      const { from, to, subject, text, since, before, seen, searchRelay } = args;
      const result = await apiRequest('POST', '/mail/search', { from, to, subject, text, since, before, seen, searchRelay });
      const lines: string[] = [];

      if (result?.uids?.length) {
        lines.push(`Local inbox: ${result.uids.length} match${result.uids.length !== 1 ? 'es' : ''}. UIDs: ${result.uids.join(', ')}`);
      }

      if (result?.relayResults?.length) {
        lines.push(`\nConnected account (${result.relayResults[0].account}): ${result.relayResults.length} match${result.relayResults.length !== 1 ? 'es' : ''}`);
        for (const r of result.relayResults.slice(0, 20)) {
          const fromAddr = r.from?.[0]?.address ?? 'unknown';
          const date = r.date ? new Date(r.date).toLocaleDateString() : '';
          lines.push(`  [relay UID:${r.uid}] From: ${fromAddr} | Subject: ${r.subject} | Date: ${date}`);
        }
        lines.push('\nTo continue a thread from the connected account, use import_relay_email with the relay UID, then reply_email as normal.');
      }

      if (lines.length === 0) {
        return searchRelay
          ? 'No matching emails found in local inbox or connected account.'
          : 'No matching emails found. Tip: set searchRelay=true to also search your connected Gmail/Outlook account.';
      }
      return lines.join('\n');
    }

    case 'import_relay_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1 || !Number.isInteger(uid)) {
        throw new Error('uid must be a positive integer (relay UID from search results)');
      }
      const result = await apiRequest('POST', '/mail/import-relay', { uid });
      return result?.ok
        ? 'Email imported to local inbox. You can now use list_inbox to find it and reply_email to continue the thread.'
        : `Import failed: ${result?.error || 'unknown error'}`;
    }

    case 'reply_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      const original = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!original) throw new Error('Original email not found');
      const replyTo = original.replyTo?.[0]?.address || original.from?.[0]?.address;
      if (!replyTo) throw new Error('Original email has no sender address — cannot reply');
      const origSubject = original.subject ?? '';
      const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
      const refs = Array.isArray(original.references) ? [...original.references] : [];
      if (original.messageId) refs.push(original.messageId);
      const quotedBody = (original.text || '').split('\n').map((l: string) => `> ${l}`).join('\n');
      const fullText = `${args.text}\n\nOn ${original.date}, ${replyTo} wrote:\n${quotedBody}`;
      let to = replyTo;
      if (args.replyAll) {
        const allTo = [...(original.to || []), ...(original.cc || [])].map((a: any) => a.address).filter(Boolean);
        to = [replyTo, ...allTo].filter((v: string, i: number, a: string[]) => v && a.indexOf(v) === i).join(', ');
      }

      const replySendBody: Record<string, unknown> = {
        to, subject, text: fullText, html: args.html,
        inReplyTo: original.messageId, references: refs,
      };

      const sendResult = await apiRequest('POST', '/mail/send', replySendBody);

      if (sendResult?.blocked && sendResult?.pendingId) {
        scheduleFollowUp(sendResult.pendingId, to, String(replySendBody.subject || '(no subject)'), makePendingCheck(sendResult.pendingId));
        return `Reply NOT sent — blocked by outbound guard.\n${sendResult.summary}\n\nPending ID: ${sendResult.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the reply was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this reply is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Reply sent to ${to}. Message ID: ${sendResult?.messageId ?? 'unknown'}`;
      if (sendResult?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n${sendResult.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}`).join('\n')}`;
      }
      return response;
    }

    case 'forward_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      const orig = await apiRequest('GET', `/mail/messages/${uid}`);
      if (!orig) throw new Error('Email not found');
      const fwdSubject = (orig.subject ?? '').startsWith('Fwd:') ? orig.subject : `Fwd: ${orig.subject}`;
      const origFrom = orig.from?.[0]?.address ?? 'unknown';
      const origTo = (orig.to || []).map((a: any) => a.address).join(', ');
      const fwdBody = `${args.text ? args.text + '\n\n' : ''}---------- Forwarded message ----------\nFrom: ${origFrom}\nTo: ${origTo}\nDate: ${orig.date}\nSubject: ${orig.subject}\n\n${orig.text || ''}`;

      const fwdSendBody: Record<string, unknown> = { to: args.to, subject: fwdSubject, text: fwdBody };

      // Include original attachments in the forward
      if (Array.isArray(orig.attachments) && orig.attachments.length > 0) {
        fwdSendBody.attachments = orig.attachments.map((a: any) => ({
          filename: a.filename,
          content: a.content?.data ? Buffer.from(a.content.data).toString('base64') : a.content,
          contentType: a.contentType,
          encoding: 'base64',
        }));
      }

      const fwdResult = await apiRequest('POST', '/mail/send', fwdSendBody);

      if (fwdResult?.blocked && fwdResult?.pendingId) {
        scheduleFollowUp(fwdResult.pendingId, String(args.to), fwdSubject, makePendingCheck(fwdResult.pendingId));
        return `Forward NOT sent — blocked by outbound guard.\n${fwdResult.summary}\n\nPending ID: ${fwdResult.pendingId}\nYour owner has been notified via email with the full content for review.\n\nYou MUST now:\n1. Inform your owner in this conversation that the forward was blocked and needs their approval.\n2. Mention the recipient, subject, and why it was flagged.\n3. If this forward is urgent or has a deadline, tell your owner about the time sensitivity.\n4. Periodically check with manage_pending_emails(action='list') and follow up with your owner if still pending.`;
      }

      let response = `Forwarded to ${args.to}. Message ID: ${fwdResult?.messageId ?? 'unknown'}`;
      if (fwdResult?.outboundWarnings?.length) {
        response += `\n\n--- Outbound Guard ---\n${fwdResult.outboundWarnings.map((w: any) => `  [${w.severity?.toUpperCase()}] ${w.description}`).join('\n')}`;
      }
      return response;
    }

    case 'move_email': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/move`, { from: args.from || 'INBOX', to: args.to });
      return `Moved message UID ${uid} to ${args.to}`;
    }

    case 'mark_unread': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/unseen`);
      return `Marked message UID ${uid} as unread`;
    }

    case 'mark_read': {
      const uid = Number(args.uid);
      if (!uid || uid < 1) throw new Error('uid must be a positive integer');
      await apiRequest('POST', `/mail/messages/${uid}/seen`);
      return `Marked message UID ${uid} as read`;
    }

    case 'list_folders': {
      const result = await apiRequest('GET', '/mail/folders');
      if (!result?.folders?.length) return 'No folders found.';
      return result.folders.map((f: any) => `${f.path}${f.specialUse ? ` (${f.specialUse})` : ''}`).join('\n');
    }

    case 'list_folder': {
      const folder = encodeURIComponent(String(args.folder));
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const result = await apiRequest('GET', `/mail/folders/${folder}?limit=${limit}&offset=${offset}`);
      if (!result?.messages?.length) return `Folder "${args.folder}" is empty.`;
      const lines = result.messages.map((m: any, i: number) =>
        `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`);
      return `${args.folder} (${result.total} total):\n${lines.join('\n')}`;
    }

    case 'batch_delete': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/delete', { uids, folder: args.folder });
      return `Deleted ${uids.length} messages.`;
    }

    case 'batch_mark_read': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/seen', { uids, folder: args.folder });
      return `Marked ${uids.length} messages as read.`;
    }

    case 'manage_contacts': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/contacts');
        if (!r?.contacts?.length) return 'No contacts.';
        return r.contacts.map((c: any) => `${c.name || '(no name)'} <${c.email}>`).join('\n');
      }
      if (args.action === 'add') {
        if (!args.email) throw new Error('email is required');
        await apiRequest('POST', '/contacts', { email: args.email, name: args.name });
        return `Contact added: ${args.name || ''} <${args.email}>`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/contacts/${args.id}`);
        return 'Contact deleted.';
      }
      throw new Error('Invalid action');
    }

    case 'manage_drafts': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/drafts');
        if (!r?.drafts?.length) return 'No drafts.';
        return r.drafts.map((d: any) => `[${d.id}] To: ${d.to_addr || '?'} | Subject: ${d.subject || '?'}`).join('\n');
      }
      if (args.action === 'create') {
        const r = await apiRequest('POST', '/drafts', { to: args.to, subject: args.subject, text: args.text });
        return `Draft created: ${r?.id}`;
      }
      if (args.action === 'update') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('PUT', `/drafts/${args.id}`, { to: args.to, subject: args.subject, text: args.text });
        return `Draft ${args.id} updated.`;
      }
      if (args.action === 'send') {
        if (!args.id) throw new Error('id is required');
        const r = await apiRequest('POST', `/drafts/${args.id}/send`);
        return `Draft sent. Message ID: ${r?.messageId ?? 'unknown'}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/drafts/${args.id}`);
        return 'Draft deleted.';
      }
      throw new Error('Invalid action');
    }

    case 'manage_scheduled': {
      const action = args.action || 'create';
      if (action === 'list') {
        const r = await apiRequest('GET', '/scheduled');
        if (!r?.scheduled?.length) return 'No scheduled emails.';
        return r.scheduled.map((s: any) =>
          `[${s.id}] To: ${s.to_addr} | Subject: ${s.subject} | Send at: ${s.send_at} | Status: ${s.status}`
        ).join('\n');
      }
      if (action === 'cancel') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/scheduled/${args.id}`);
        return 'Scheduled email cancelled.';
      }
      // create
      const r = await apiRequest('POST', '/scheduled', {
        to: args.to, subject: args.subject, text: args.text, sendAt: args.sendAt,
      });
      return `Email scheduled for ${r?.sendAt}. ID: ${r?.id}`;
    }

    case 'create_folder': {
      if (!args.name) throw new Error('name is required');
      await apiRequest('POST', '/mail/folders', { name: args.name });
      return `Folder "${args.name}" created successfully.`;
    }

    case 'manage_tags': {
      const action = args.action as string;
      if (action === 'list') {
        const r = await apiRequest('GET', '/tags');
        if (!r?.tags?.length) return 'No tags.';
        return r.tags.map((t: any) => `[${t.id.slice(0, 8)}] ${t.name} (${t.color})`).join('\n');
      }
      if (action === 'create') {
        if (!args.name) throw new Error('name is required');
        const r = await apiRequest('POST', '/tags', { name: args.name, color: args.color });
        return `Tag "${args.name}" created (${r?.color}). ID: ${r?.id}`;
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/tags/${args.id}`);
        return 'Tag deleted.';
      }
      if (action === 'tag_message') {
        if (!args.id || !args.uid) throw new Error('id and uid are required');
        await apiRequest('POST', `/tags/${args.id}/messages`, { uid: args.uid, folder: args.folder });
        return `Tagged message UID ${args.uid} with tag ${args.id}`;
      }
      if (action === 'untag_message') {
        if (!args.id || !args.uid) throw new Error('id and uid are required');
        const folder = args.folder || 'INBOX';
        await apiRequest('DELETE', `/tags/${args.id}/messages/${args.uid}?folder=${encodeURIComponent(folder)}`);
        return `Removed tag from message UID ${args.uid} in ${folder}`;
      }
      if (action === 'get_messages') {
        if (!args.id) throw new Error('id is required');
        const r = await apiRequest('GET', `/tags/${args.id}/messages`);
        if (!r?.messages?.length) return `No messages with this tag.`;
        return `Tag "${r.tag.name}" — ${r.messages.length} messages:\n${r.messages.map((m: any) => `  UID ${m.uid} (${m.folder})`).join('\n')}`;
      }
      if (action === 'get_message_tags') {
        if (!args.uid) throw new Error('uid is required');
        const r = await apiRequest('GET', `/messages/${args.uid}/tags`);
        if (!r?.tags?.length) return 'No tags on this message.';
        return r.tags.map((t: any) => `[${t.id.slice(0, 8)}] ${t.name} (${t.color})`).join('\n');
      }
      throw new Error('Invalid action');
    }

    case 'create_account': {
      const result = await apiRequest('POST', '/accounts', {
        name: args.name,
        domain: args.domain,
        role: args.role,
      }, useMaster);
      if (!result) throw new Error('No response from account creation');
      return [
        `Account created successfully!`,
        `  Name: ${result.name}`,
        `  Email: ${result.email}`,
        `  Role: ${result.role}`,
        `  API Key: ${result.apiKey}`,
        `  ID: ${result.id}`,
      ].join('\n');
    }

    case 'setup_email_relay': {
      const result = await apiRequest('POST', '/gateway/relay', {
        provider: args.provider,
        email: args.email,
        password: args.password,
        smtpHost: args.smtpHost,
        smtpPort: args.smtpPort,
        imapHost: args.imapHost,
        imapPort: args.imapPort,
        agentName: args.agentName,
        agentRole: args.agentRole,
        skipDefaultAgent: args.skipDefaultAgent,
      }, useMaster);
      if (!result) throw new Error('No response from relay setup');
      const lines = [
        `Email relay configured!`,
        `  Mode: ${result.mode}`,
        `  Provider: ${result.provider}`,
        `  Email: ${result.email}`,
      ];
      if (result.agent) {
        lines.push(
          `  Default agent: ${result.agent.name} (${result.agent.role})`,
          `  Agent email: ${result.agent.subAddress}`,
          `  Agent API Key: ${result.agent.apiKey}`,
        );
      }
      return lines.join('\n');
    }

    case 'setup_email_domain': {
      const result = await apiRequest('POST', '/gateway/domain', {
        cloudflareToken: args.cloudflareToken,
        cloudflareAccountId: args.cloudflareAccountId,
        domain: args.domain,
        purchase: args.purchase,
        gmailRelay: args.gmailRelay,
      }, useMaster);
      if (!result) throw new Error('No response from domain setup');
      const lines = [
        `Domain email configured!`,
        `  Domain: ${result.domain}`,
        `  DNS: ${result.dnsConfigured ? 'configured' : 'pending'}`,
        `  Tunnel: ${result.tunnelId}`,
      ];
      if (result.outboundRelay) {
        lines.push(`  Outbound relay: ${result.outboundRelay.configured ? 'configured' : 'failed'} (${result.outboundRelay.provider})`);
      }
      if (result.nextSteps?.length) {
        lines.push('', 'Next steps:');
        for (const step of result.nextSteps) {
          lines.push(`  ${step}`);
        }
      }
      return lines.join('\n');
    }

    case 'setup_guide': {
      const result = await apiRequest('GET', '/gateway/setup-guide', undefined, useMaster);
      if (!result?.modes) throw new Error('No response from setup guide');
      const lines: string[] = ['Email Setup Options:', ''];
      for (const mode of result.modes) {
        lines.push(`=== ${mode.mode.toUpperCase()} MODE (${mode.difficulty}) ===`);
        lines.push(mode.description);
        lines.push(`From address: ${mode.fromAddress}`);
        lines.push('Requirements:');
        for (const req of mode.requirements) lines.push(`  - ${req}`);
        lines.push('Pros:');
        for (const pro of mode.pros) lines.push(`  + ${pro}`);
        lines.push('Cons:');
        for (const con of mode.cons) lines.push(`  - ${con}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    case 'setup_gmail_alias': {
      const result = await apiRequest('POST', '/gateway/domain/alias-setup', {
        agentEmail: args.agentEmail,
        agentDisplayName: args.agentDisplayName,
      }, useMaster);
      if (!result?.instructions) throw new Error('No response from alias setup');
      const lines = [
        result.instructions.summary,
        '',
        'Steps:',
      ];
      for (const step of result.instructions.steps) {
        lines.push(`${step.step}. ${step.action}`);
        if (step.fields) {
          for (const [k, v] of Object.entries(step.fields)) {
            lines.push(`   ${k}: ${v}`);
          }
        }
        if (step.url) lines.push(`   URL: ${step.url}`);
      }
      return lines.join('\n');
    }

    case 'setup_payment': {
      const result = await apiRequest('GET', '/gateway/domain/payment-setup', undefined, useMaster);
      if (!result?.instructions) throw new Error('No response from payment setup');
      const lines = [result.instructions.summary, ''];
      for (const opt of result.instructions.options) {
        lines.push(`=== Option ${opt.option}: ${opt.label} ===`);
        if (opt.securityNote) lines.push(`Security: ${opt.securityNote}`);
        for (const step of opt.steps) {
          lines.push(`  ${step.step}. ${step.action}`);
          if (step.url) lines.push(`     URL: ${step.url}`);
          if (step.note) lines.push(`     Note: ${step.note}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    case 'purchase_domain': {
      const result = await apiRequest('POST', '/gateway/domain/purchase', {
        keywords: args.keywords,
        tld: args.tld,
      }, useMaster);
      if (!result?.domains?.length) return 'No domains found.';
      const lines = result.domains.map((d: any) =>
        `  ${d.domain}: ${d.available ? 'available' : 'taken'}${d.price ? ` ($${d.price})` : ''}${d.premium ? ' (premium)' : ''}`,
      );
      return `Domain search results:\n${lines.join('\n')}`;
    }

    case 'check_gateway_status': {
      const result = await apiRequest('GET', '/gateway/status', undefined, useMaster);
      if (!result) throw new Error('No response from gateway status');
      const lines = [`Gateway mode: ${result.mode}`, `Healthy: ${result.healthy}`];
      if (result.relay) {
        lines.push(`Relay provider: ${result.relay.provider}`, `Relay email: ${result.relay.email}`, `Polling: ${result.relay.polling}`);
      }
      if (result.domain) {
        lines.push(`Domain: ${result.domain.domain}`, `DNS: ${result.domain.dnsConfigured}`, `Tunnel: ${result.domain.tunnelActive}`);
      }
      return lines.join('\n');
    }

    case 'send_test_email': {
      const result = await apiRequest('POST', '/gateway/test', { to: args.to }, useMaster);
      return `Test email sent! Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'list_agents': {
      const result = await apiRequest('GET', '/accounts/directory');
      const agents = result?.agents ?? [];
      if (agents.length === 0) return 'No agents found.';
      const lines = agents.map((a: any) => `  ${a.name} (${a.email}) — ${a.role}`);
      return `Agents in the system:\n${lines.join('\n')}`;
    }

    case 'message_agent': {
      const agentName = String(args.agent ?? '').toLowerCase().trim();
      if (!agentName) throw new Error('agent name is required');

      // Validate the target agent exists
      try {
        await apiRequest('GET', `/accounts/directory/${encodeURIComponent(agentName)}`);
      } catch {
        throw new Error(`Agent "${agentName}" not found. Use list_agents to see available agents.`);
      }

      const to = `${agentName}@localhost`;
      const priority = String(args.priority ?? 'normal');
      const subject = priority === 'urgent'
        ? `[URGENT] ${args.subject}`
        : priority === 'high'
          ? `[HIGH] ${args.subject}`
          : String(args.subject);
      const result = await apiRequest('POST', '/mail/send', { to, subject, text: args.text });
      return `Message sent to ${to}. Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'check_messages': {
      const searchResult = await apiRequest('POST', '/mail/search', { seen: false });
      const uids: number[] = searchResult?.uids ?? [];
      if (uids.length === 0) return 'No unread messages.';
      const details: string[] = [];
      for (const uid of uids.slice(0, 10)) {
        try {
          const email = await apiRequest('GET', `/mail/messages/${uid}`);
          if (!email) continue;
          const from = email.from?.[0]?.address ?? 'unknown';
          const subject = email.subject ?? '(no subject)';
          const tag = from.endsWith('@localhost') ? '[agent]' : '[external]';
          details.push(`  ${tag} UID ${uid}: from ${from} — "${subject}"`);
        } catch { /* skip */ }
      }
      const more = uids.length > 10 ? `\n  (${uids.length - 10} more not shown)` : '';
      return `${uids.length} unread message(s):\n${details.join('\n')}${more}`;
    }

    case 'delete_agent': {
      const agentName = String(args.name ?? '').trim();
      if (!agentName) throw new Error('name is required');

      // Look up agent by name to get ID
      const agents = await apiRequest('GET', '/accounts', undefined, true);
      const fullAgent = agents?.agents?.find((a: any) => a.name === agentName);
      if (!fullAgent) throw new Error(`Agent "${agentName}" not found`);

      const qs = new URLSearchParams({ archive: 'true', deletedBy: 'mcp-tool' });
      if (args.reason) qs.set('reason', String(args.reason));

      const report = await apiRequest('DELETE', `/accounts/${fullAgent.id}?${qs.toString()}`, undefined, true);
      const lines = [
        `Agent "${agentName}" deleted successfully.`,
        `  Deletion ID: ${report?.id}`,
        `  Emails archived: ${report?.summary?.totalEmails ?? 0}`,
        `  Deleted at: ${report?.deletedAt}`,
      ];
      if (report?.summary?.topCorrespondents?.length) {
        lines.push(`  Top correspondents: ${report.summary.topCorrespondents.map((c: any) => c.address).join(', ')}`);
      }
      return lines.join('\n');
    }

    case 'deletion_reports': {
      if (args.id) {
        const report = await apiRequest('GET', `/accounts/deletions/${encodeURIComponent(String(args.id))}`, undefined, true);
        if (!report) throw new Error('Deletion report not found');
        const lines = [
          `Deletion Report: ${report.id}`,
          `  Agent: ${report.agent.name} (${report.agent.email})`,
          `  Role: ${report.agent.role}`,
          `  Deleted: ${report.deletedAt}`,
          `  By: ${report.deletedBy}`,
          report.reason ? `  Reason: ${report.reason}` : null,
          `  Total emails: ${report.summary.totalEmails}`,
          `  Inbox: ${report.summary.inboxCount}, Sent: ${report.summary.sentCount}, Other: ${report.summary.otherCount}`,
        ];
        if (report.summary.firstEmailDate) {
          lines.push(`  Date range: ${report.summary.firstEmailDate} → ${report.summary.lastEmailDate}`);
        }
        if (report.summary.topCorrespondents?.length) {
          lines.push(`  Top correspondents: ${report.summary.topCorrespondents.map((c: any) => `${c.address} (${c.count})`).join(', ')}`);
        }
        return lines.filter(Boolean).join('\n');
      }
      const result = await apiRequest('GET', '/accounts/deletions', undefined, true);
      const deletions = result?.deletions ?? [];
      if (deletions.length === 0) return 'No deletion reports found.';
      const lines = deletions.map((d: any) =>
        `  [${d.id}] ${d.agentName} (${d.agentEmail}) — deleted ${d.deletedAt}, ${d.emailCount} emails archived`);
      return `Deletion reports:\n${lines.join('\n')}`;
    }

    case 'manage_signatures': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/signatures');
        if (!r?.signatures?.length) return 'No signatures.';
        return r.signatures.map((s: any) => `[${s.id}] ${s.name}${s.isDefault ? ' (default)' : ''}: ${s.text}`).join('\n');
      }
      if (args.action === 'create') {
        if (!args.name || !args.text) throw new Error('name and text are required');
        const r = await apiRequest('POST', '/signatures', { name: args.name, text: args.text, isDefault: args.isDefault });
        return `Signature "${args.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/signatures/${args.id}`);
        return 'Signature deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'manage_templates': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/templates');
        if (!r?.templates?.length) return 'No templates.';
        return r.templates.map((t: any) => `[${t.id}] ${t.name}: ${t.subject}`).join('\n');
      }
      if (args.action === 'create') {
        if (!args.name || !args.subject || !args.text) throw new Error('name, subject, and text are required');
        const r = await apiRequest('POST', '/templates', { name: args.name, subject: args.subject, text: args.text });
        return `Template "${args.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/templates/${args.id}`);
        return 'Template deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'batch_mark_unread': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/unseen', { uids, folder: args.folder });
      return `Marked ${uids.length} messages as unread.`;
    }

    case 'batch_move': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      await apiRequest('POST', '/mail/batch/move', { uids, from: args.from || 'INBOX', to: args.to });
      return `Moved ${uids.length} messages to ${args.to}.`;
    }

    case 'whoami': {
      const result = await apiRequest('GET', '/accounts/me');
      if (!result) throw new Error('Could not retrieve agent info');
      return [
        `Name: ${result.name}`,
        `Email: ${result.email}`,
        `Role: ${result.role}`,
        `ID: ${result.id}`,
        `Created: ${result.createdAt}`,
        result.metadata && Object.keys(result.metadata).length > 0
          ? `Metadata: ${JSON.stringify(result.metadata)}`
          : null,
      ].filter(Boolean).join('\n');
    }

    case 'update_metadata': {
      if (!args.metadata || typeof args.metadata !== 'object') throw new Error('metadata object is required');
      const result = await apiRequest('PATCH', '/accounts/me', { metadata: args.metadata });
      return `Metadata updated successfully. Agent: ${result?.name ?? 'unknown'}`;
    }

    case 'check_health': {
      const result = await apiRequest('GET', '/health');
      if (!result) throw new Error('No response from health check');
      return `AgenticMail server: ${result.status ?? 'ok'}${result.stalwart ? `, Stalwart: ${result.stalwart}` : ''}`;
    }

    case 'wait_for_email': {
      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 120, 5), 300);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

      try {
        const res = await fetch(`${API_URL}/api/agenticmail/events`, {
          headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'text/event-stream' },
          signal: controller.signal,
        });

        if (!res.ok) {
          clearTimeout(timer);
          // Fallback: if SSE not available, do a single poll
          const search = await apiRequest('POST', '/mail/search', { seen: false });
          const uids: number[] = search?.uids ?? [];
          if (uids.length > 0) {
            const email = await apiRequest('GET', `/mail/messages/${uids[0]}`);
            return JSON.stringify({
              arrived: true,
              mode: 'poll-fallback',
              email: email ? {
                uid: uids[0],
                from: email.from?.[0]?.address ?? '',
                subject: email.subject ?? '(no subject)',
                date: email.date,
                preview: (email.text ?? '').slice(0, 300),
              } : null,
              totalUnread: uids.length,
            });
          }
          return JSON.stringify({ arrived: false, reason: 'SSE unavailable and no unread emails', timedOut: true });
        }

        if (!res.body) {
          clearTimeout(timer);
          return JSON.stringify({ arrived: false, reason: 'SSE response has no body' });
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);

              for (const line of frame.split('\n')) {
                if (line.startsWith('data: ')) {
                  try {
                    const event = JSON.parse(line.slice(6));

                    // Task event — pushed directly by the task assign/RPC endpoints
                    if (event.type === 'task' && event.taskId) {
                      clearTimeout(timer);
                      try { reader.cancel(); } catch { /* ignore */ }
                      return JSON.stringify({
                        arrived: true,
                        mode: 'push',
                        eventType: 'task',
                        task: {
                          taskId: event.taskId,
                          taskType: event.taskType,
                          description: event.task,
                          from: event.from,
                        },
                        hint: 'You have a new task. Use check_tasks(action="pending") to see and claim it.',
                      });
                    }

                    // New email event — from IMAP IDLE
                    if (event.type === 'new' && event.uid) {
                      clearTimeout(timer);
                      try { reader.cancel(); } catch { /* ignore */ }
                      const email = await apiRequest('GET', `/mail/messages/${event.uid}`);
                      const fromAddr = email?.from?.[0]?.address ?? '';
                      return JSON.stringify({
                        arrived: true,
                        mode: 'push',
                        eventType: 'email',
                        email: email ? {
                          uid: event.uid,
                          from: fromAddr,
                          fromName: email.from?.[0]?.name ?? fromAddr,
                          subject: email.subject ?? '(no subject)',
                          date: email.date,
                          preview: (email.text ?? '').slice(0, 300),
                          messageId: email.messageId,
                          isInterAgent: fromAddr.endsWith('@localhost'),
                        } : null,
                      });
                    }
                  } catch { /* skip malformed JSON */ }
                }
              }
            }
          }
        } finally {
          try { reader.cancel(); } catch { /* ignore */ }
        }

        clearTimeout(timer);
        return JSON.stringify({ arrived: false, reason: 'SSE connection closed', timedOut: false });

      } catch (err) {
        clearTimeout(timer);
        if ((err as Error).name === 'AbortError') {
          return JSON.stringify({ arrived: false, reason: `No email received within ${timeoutSec}s`, timedOut: true });
        }
        return JSON.stringify({ arrived: false, reason: (err as Error).message });
      }
    }

    case 'batch_read': {
      const uids = args.uids as number[];
      if (!Array.isArray(uids) || uids.length === 0) throw new Error('uids array required');
      const result = await apiRequest('POST', '/mail/batch/read', { uids, folder: args.folder });
      if (!result?.messages?.length) return 'No messages found for the given UIDs.';
      const lines = result.messages.map((m: any) => {
        const from = m.from?.map((a: any) => a.address).join(', ') ?? 'unknown';
        return `[UID:${m.uid}] From: ${from} | Subject: ${m.subject}\n${(m.text ?? '').slice(0, 500)}`;
      });
      return `${result.count} messages:\n\n${lines.join('\n\n---\n\n')}`;
    }

    case 'inbox_digest': {
      const qs = new URLSearchParams();
      if (args.limit) qs.set('limit', String(args.limit));
      if (args.offset) qs.set('offset', String(args.offset));
      if (args.folder) qs.set('folder', String(args.folder));
      if (args.previewLength) qs.set('previewLength', String(args.previewLength));
      const query = qs.toString();
      const result = await apiRequest('GET', `/mail/digest${query ? '?' + query : ''}`);
      if (!result?.messages?.length) return 'Inbox is empty.';
      const lines = result.messages.map((m: any, i: number) => {
        const from = m.from?.[0]?.address ?? 'unknown';
        const flags = m.flags?.length ? ` [${m.flags.join(', ')}]` : '';
        return `${i + 1}. [UID:${m.uid}] From: ${from} | Subject: ${m.subject}${flags}\n   ${m.preview || '(no preview)'}`;
      });
      return `Inbox digest (${result.count}/${result.total}):\n${lines.join('\n')}`;
    }

    case 'template_send': {
      const result = await apiRequest('POST', `/templates/${args.id}/send`, {
        to: args.to, variables: args.variables, cc: args.cc, bcc: args.bcc,
      });
      return `Template email sent. Message ID: ${result?.messageId ?? 'unknown'}`;
    }

    case 'manage_rules': {
      if (args.action === 'list') {
        const r = await apiRequest('GET', '/rules');
        if (!r?.rules?.length) return 'No email rules configured.';
        return r.rules.map((rule: any) =>
          `[${rule.id.slice(0, 8)}] ${rule.name} (priority: ${rule.priority}, enabled: ${rule.enabled})\n  Conditions: ${JSON.stringify(rule.conditions)}\n  Actions: ${JSON.stringify(rule.actions)}`
        ).join('\n');
      }
      if (args.action === 'create') {
        const r = await apiRequest('POST', '/rules', {
          name: args.name, priority: args.priority, conditions: args.conditions, actions: args.actions,
        });
        return `Rule "${r?.name}" created. ID: ${r?.id}`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('id is required');
        await apiRequest('DELETE', `/rules/${args.id}`);
        return 'Rule deleted.';
      }
      throw new Error('Invalid action. Use: list, create, or delete');
    }

    case 'cleanup_agents': {
      if (args.action === 'list_inactive') {
        const qs = args.hours ? `?hours=${args.hours}` : '';
        const r = await apiRequest('GET', `/accounts/inactive${qs}`, undefined, true);
        if (!r?.agents?.length) return 'No inactive agents found. All agents are either active or persistent.';
        return `${r.count} inactive agent(s):\n${r.agents.map((a: any) =>
          `  ${a.name} (${a.email}) — last active: ${a.last_activity_at || 'never'}, persistent: ${a.persistent}`
        ).join('\n')}`;
      }
      if (args.action === 'cleanup') {
        const r = await apiRequest('POST', '/accounts/cleanup', { hours: args.hours, dryRun: args.dryRun }, true);
        if (r?.dryRun) {
          if (!r.count) return 'No inactive agents to clean up. All agents are either active or persistent.';
          return `Would delete ${r.count} agent(s): ${r.wouldDelete.map((a: any) => a.name).join(', ')}`;
        }
        if (!r?.count) return 'No inactive agents to clean up. All agents are either active or persistent.';
        return `Deleted ${r.count} agent(s): ${r.deleted.join(', ')}`;
      }
      if (args.action === 'set_persistent') {
        if (!args.agentId) throw new Error('agentId is required');
        await apiRequest('PATCH', `/accounts/${args.agentId}/persistent`, { persistent: args.persistent !== false }, true);
        return `Agent ${args.agentId} persistent flag set to ${args.persistent !== false}`;
      }
      throw new Error('Invalid action. Use: list_inactive, cleanup, or set_persistent');
    }

    case 'assign_task': {
      const result = await apiRequest('POST', '/tasks/assign', {
        assignee: args.assignee, taskType: args.taskType,
        payload: args.payload, expiresInSeconds: args.expiresInSeconds,
      });
      return `Task assigned to ${result?.assignee}. Task ID: ${result?.id}`;
    }

    case 'check_tasks': {
      let endpoint = args.direction === 'outgoing' ? '/tasks/assigned' : '/tasks/pending';
      if (args.direction !== 'outgoing' && args.assignee) {
        endpoint += `?assignee=${encodeURIComponent(args.assignee)}`;
      }
      const r = await apiRequest('GET', endpoint);
      if (!r?.tasks?.length) return args.direction === 'outgoing' ? 'No tasks assigned by you.' : 'No pending tasks.';
      return `${r.count} tasks:\n${r.tasks.map((t: any) =>
        `  [${t.id.slice(0, 8)}] ${t.taskType} — status: ${t.status}, payload: ${JSON.stringify(t.payload).slice(0, 100)}`
      ).join('\n')}`;
    }

    case 'claim_task': {
      const r = await apiRequest('POST', `/tasks/${args.id}/claim`);
      return `Task ${r?.id} claimed. Payload: ${JSON.stringify(r?.payload)}`;
    }

    case 'submit_result': {
      await apiRequest('POST', `/tasks/${args.id}/result`, { result: args.result });
      return `Result submitted for task ${args.id}.`;
    }

    case 'call_agent': {
      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 180, 5), 300);

      // Step 1: Create the task (quick request — returns immediately)
      const created = await apiRequest('POST', '/tasks/assign', {
        assignee: args.target,
        taskType: 'rpc',
        payload: { task: args.task, ...(args.payload || {}) },
      });
      if (!created?.id) throw new Error('Failed to create task');
      const taskId = created.id;

      // Step 2: Poll for completion with short-lived requests
      const deadline = Date.now() + timeoutSec * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const task = await apiRequest('GET', `/tasks/${taskId}`);
          if (task?.status === 'completed') return `RPC completed. Result: ${JSON.stringify(task.result)}`;
          if (task?.status === 'failed') return `RPC failed: ${task.error}`;
        } catch { /* poll error — retry on next cycle */ }
      }

      return `RPC timed out. Task ID: ${taskId} — check later with check_tasks.`;
    }

    case 'manage_spam': {
      const action = args.action as string;
      if (action === 'list') {
        const qs = new URLSearchParams();
        if (args.limit) qs.set('limit', String(args.limit));
        if (args.offset) qs.set('offset', String(args.offset));
        const query = qs.toString();
        const result = await apiRequest('GET', `/mail/spam${query ? '?' + query : ''}`);
        if (!result?.messages?.length) return 'Spam folder is empty.';
        const lines = result.messages.map((m: any, i: number) =>
          `${i + 1}. [UID:${m.uid}] From: ${m.from?.[0]?.address ?? 'unknown'} | Subject: ${m.subject} | Date: ${m.date}`);
        return `Spam folder (${result.count}/${result.total}):\n${lines.join('\n')}`;
      }
      if (action === 'report') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        await apiRequest('POST', `/mail/messages/${uid}/spam`, { folder: args.folder || 'INBOX' });
        return `Message UID ${uid} moved to Spam.`;
      }
      if (action === 'not_spam') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        await apiRequest('POST', `/mail/messages/${uid}/not-spam`);
        return `Message UID ${uid} moved from Spam to INBOX.`;
      }
      if (action === 'score') {
        const uid = Number(args.uid);
        if (!uid || uid < 1) throw new Error('uid is required');
        const folder = args.folder || 'INBOX';
        const result = await apiRequest('GET', `/mail/messages/${uid}/spam-score?folder=${encodeURIComponent(folder)}`);
        const lines = [
          `Spam Score: ${result.score}/100 (${result.isSpam ? 'SPAM' : result.isWarning ? 'WARNING' : 'CLEAN'})`,
          result.topCategory ? `Top Category: ${result.topCategory}` : null,
        ];
        if (result.matches?.length) {
          lines.push('Matches:');
          for (const m of result.matches) {
            lines.push(`  [${m.ruleId}] +${m.score} — ${m.description}`);
          }
        }
        return lines.filter(Boolean).join('\n');
      }
      throw new Error('Invalid action. Use: list, report, not_spam, or score');
    }

    case 'manage_pending_emails': {
      const action = String(args.action);
      if (action === 'list') {
        const result = await apiRequest('GET', '/mail/pending');
        // Cancel follow-ups for any resolved emails
        if (result?.pending) {
          for (const p of result.pending) {
            if (p.status !== 'pending') cancelFollowUp(p.id);
          }
        }
        if (!result?.pending?.length) return withReminders('No pending outbound emails.');
        const lines = result.pending.map((p: any, i: number) =>
          `${i + 1}. [${p.id}] To: ${p.to} | Subject: ${p.subject} | Status: ${p.status} | Created: ${p.createdAt}`);
        return withReminders(`Pending emails (${result.count}):\n${lines.join('\n')}`);
      }
      if (action === 'get') {
        if (!args.id) throw new Error('id is required');
        const result = await apiRequest('GET', `/mail/pending/${encodeURIComponent(String(args.id))}`);
        if (!result) throw new Error('Pending email not found');
        if (result.status !== 'pending') cancelFollowUp(String(args.id));
        return withReminders(`Pending Email: ${result.id}\nTo: ${result.mailOptions?.to}\nSubject: ${result.mailOptions?.subject}\nStatus: ${result.status}\nCreated: ${result.createdAt}\nWarnings:\n${result.summary}`);
      }
      if (action === 'approve' || action === 'reject') {
        return withReminders(`You cannot ${action} pending emails. Only the owner (human) can approve or reject blocked emails. Please inform the owner and wait for their decision.`);
      }
      throw new Error('Invalid action. Use: list or get');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
