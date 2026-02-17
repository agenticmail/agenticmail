/**
 * Tool Catalog — Exact mapping of real OpenClaw + AgenticMail tools
 *
 * Every tool ID here matches the ACTUAL registered tool name in OpenClaw.
 * Sourced from:
 * - OpenClaw core tools (read, write, edit, exec, web_search, etc.)
 * - AgenticMail plugin tools (agenticmail_send, agenticmail_reply, etc.)
 * - OpenClaw plugin system (browser, canvas, nodes, cron, etc.)
 *
 * This is the single source of truth for the permission engine.
 */

import type { ToolDefinition, SkillCategory, RiskLevel, SideEffect } from './skills.js';

// ─── Core OpenClaw Tools ────────────────────────────────

export const OPENCLAW_CORE_TOOLS: ToolDefinition[] = [
  // File system
  { id: 'read', name: 'Read File', description: 'Read file contents (text and images)', category: 'read', risk: 'low', skillId: 'files', sideEffects: [] },
  { id: 'write', name: 'Write File', description: 'Create or overwrite files', category: 'write', risk: 'medium', skillId: 'files', sideEffects: ['modifies-files'] },
  { id: 'edit', name: 'Edit File', description: 'Make precise edits to files', category: 'write', risk: 'medium', skillId: 'files', sideEffects: ['modifies-files'] },

  // Execution
  { id: 'exec', name: 'Shell Command', description: 'Execute shell commands', category: 'execute', risk: 'critical', skillId: 'exec', sideEffects: ['runs-code', 'modifies-files', 'network-request'] },
  { id: 'process', name: 'Process Manager', description: 'Manage running exec sessions', category: 'execute', risk: 'high', skillId: 'exec', sideEffects: ['runs-code'] },

  // Web
  { id: 'web_search', name: 'Web Search', description: 'Search the web via Brave Search API', category: 'read', risk: 'low', skillId: 'web-search', sideEffects: ['network-request'] },
  { id: 'web_fetch', name: 'Web Fetch', description: 'Fetch and extract content from URLs', category: 'read', risk: 'low', skillId: 'web-fetch', sideEffects: ['network-request'] },

  // Browser
  { id: 'browser', name: 'Browser Control', description: 'Automate web browsers', category: 'execute', risk: 'high', skillId: 'browser', sideEffects: ['network-request', 'runs-code'] },

  // Canvas
  { id: 'canvas', name: 'Canvas', description: 'Present/eval/snapshot rendered UI', category: 'read', risk: 'low', skillId: 'canvas', sideEffects: [] },

  // Nodes
  { id: 'nodes', name: 'Node Control', description: 'Control paired devices', category: 'execute', risk: 'high', skillId: 'nodes', sideEffects: ['controls-device'] },

  // Cron
  { id: 'cron', name: 'Cron Jobs', description: 'Schedule tasks and reminders', category: 'write', risk: 'medium', skillId: 'cron', sideEffects: [] },

  // Messaging
  { id: 'message', name: 'Send Message', description: 'Send messages via channels', category: 'communicate', risk: 'high', skillId: 'messaging', sideEffects: ['sends-message'] },

  // Gateway
  { id: 'gateway', name: 'Gateway Control', description: 'Restart, configure, update OpenClaw', category: 'execute', risk: 'critical', skillId: 'gateway', sideEffects: ['runs-code'] },

  // Sessions / Sub-agents
  { id: 'agents_list', name: 'List Agents', description: 'List agent IDs for spawning', category: 'read', risk: 'low', skillId: 'sessions', sideEffects: [] },
  { id: 'sessions_list', name: 'List Sessions', description: 'List active sessions', category: 'read', risk: 'low', skillId: 'sessions', sideEffects: [] },
  { id: 'sessions_history', name: 'Session History', description: 'Fetch message history', category: 'read', risk: 'low', skillId: 'sessions', sideEffects: [] },
  { id: 'sessions_send', name: 'Send to Session', description: 'Send message to another session', category: 'communicate', risk: 'medium', skillId: 'sessions', sideEffects: ['sends-message'] },
  { id: 'sessions_spawn', name: 'Spawn Sub-Agent', description: 'Spawn a background sub-agent', category: 'execute', risk: 'medium', skillId: 'sessions', sideEffects: [] },
  { id: 'subagents', name: 'Sub-Agent Control', description: 'List, steer, or kill sub-agents', category: 'execute', risk: 'medium', skillId: 'sessions', sideEffects: [] },
  { id: 'session_status', name: 'Session Status', description: 'Show session usage and status', category: 'read', risk: 'low', skillId: 'sessions', sideEffects: [] },

  // Image
  { id: 'image', name: 'Image Analysis', description: 'Analyze images with vision model', category: 'read', risk: 'low', skillId: 'media', sideEffects: [] },

  // TTS
  { id: 'tts', name: 'Text-to-Speech', description: 'Convert text to speech audio', category: 'write', risk: 'low', skillId: 'media', sideEffects: [] },

  // Memory
  { id: 'memory_search', name: 'Memory Search', description: 'Search agent memory files', category: 'read', risk: 'low', skillId: 'memory', sideEffects: [] },
  { id: 'memory_get', name: 'Memory Get', description: 'Read memory file snippets', category: 'read', risk: 'low', skillId: 'memory', sideEffects: [] },
];

// ─── AgenticMail Tools (all 63) ─────────────────────────

export const AGENTICMAIL_TOOLS: ToolDefinition[] = [
  // Core email
  { id: 'agenticmail_inbox', name: 'Inbox', description: 'List recent emails', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_read', name: 'Read Email', description: 'Read a specific email by UID', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_send', name: 'Send Email', description: 'Send an email', category: 'communicate', risk: 'high', skillId: 'agenticmail', sideEffects: ['sends-email'] },
  { id: 'agenticmail_reply', name: 'Reply to Email', description: 'Reply to an email', category: 'communicate', risk: 'high', skillId: 'agenticmail', sideEffects: ['sends-email'] },
  { id: 'agenticmail_forward', name: 'Forward Email', description: 'Forward an email', category: 'communicate', risk: 'high', skillId: 'agenticmail', sideEffects: ['sends-email'] },
  { id: 'agenticmail_search', name: 'Search Email', description: 'Search emails', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_delete', name: 'Delete Email', description: 'Delete an email', category: 'destroy', risk: 'medium', skillId: 'agenticmail', sideEffects: ['deletes-data'] },
  { id: 'agenticmail_move', name: 'Move Email', description: 'Move email to folder', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_mark_read', name: 'Mark Read', description: 'Mark email as read', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_mark_unread', name: 'Mark Unread', description: 'Mark email as unread', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_digest', name: 'Inbox Digest', description: 'Get compact inbox digest', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_list_folder', name: 'List Folder', description: 'List messages in a folder', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_folders', name: 'List Folders', description: 'List all mail folders', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_create_folder', name: 'Create Folder', description: 'Create a mail folder', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_import_relay', name: 'Import Relay', description: 'Import email from Gmail/Outlook', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },

  // Batch operations
  { id: 'agenticmail_batch_read', name: 'Batch Read', description: 'Read multiple emails', category: 'read', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_batch_delete', name: 'Batch Delete', description: 'Delete multiple emails', category: 'destroy', risk: 'medium', skillId: 'agenticmail', sideEffects: ['deletes-data'] },
  { id: 'agenticmail_batch_move', name: 'Batch Move', description: 'Move multiple emails', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_batch_mark_read', name: 'Batch Mark Read', description: 'Mark multiple as read', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_batch_mark_unread', name: 'Batch Mark Unread', description: 'Mark multiple as unread', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },

  // Agent coordination
  { id: 'agenticmail_call_agent', name: 'Call Agent', description: 'Call another agent with a task', category: 'execute', risk: 'medium', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_message_agent', name: 'Message Agent', description: 'Send message to another agent', category: 'communicate', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: ['sends-message'] },
  { id: 'agenticmail_list_agents', name: 'List Agents', description: 'List available agents', category: 'read', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_check_messages', name: 'Check Messages', description: 'Check for unread messages', category: 'read', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_check_tasks', name: 'Check Tasks', description: 'Check pending tasks', category: 'read', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_claim_task', name: 'Claim Task', description: 'Claim a pending task', category: 'write', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_complete_task', name: 'Complete Task', description: 'Complete a claimed task', category: 'write', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_submit_result', name: 'Submit Result', description: 'Submit task result', category: 'write', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },
  { id: 'agenticmail_wait_for_email', name: 'Wait for Email', description: 'Wait for new email (SSE)', category: 'read', risk: 'low', skillId: 'agenticmail-coordination', sideEffects: [] },

  // Account management
  { id: 'agenticmail_create_account', name: 'Create Account', description: 'Create agent email account', category: 'write', risk: 'high', skillId: 'agenticmail-admin', sideEffects: [] },
  { id: 'agenticmail_delete_agent', name: 'Delete Agent', description: 'Delete agent account', category: 'destroy', risk: 'critical', skillId: 'agenticmail-admin', sideEffects: ['deletes-data'] },
  { id: 'agenticmail_cleanup', name: 'Cleanup Agents', description: 'Remove inactive agents', category: 'destroy', risk: 'high', skillId: 'agenticmail-admin', sideEffects: ['deletes-data'] },
  { id: 'agenticmail_deletion_reports', name: 'Deletion Reports', description: 'List deletion reports', category: 'read', risk: 'low', skillId: 'agenticmail-admin', sideEffects: [] },
  { id: 'agenticmail_whoami', name: 'Who Am I', description: 'Get agent account info', category: 'read', risk: 'low', skillId: 'agenticmail-admin', sideEffects: [] },
  { id: 'agenticmail_update_metadata', name: 'Update Metadata', description: 'Update agent metadata', category: 'write', risk: 'low', skillId: 'agenticmail-admin', sideEffects: [] },
  { id: 'agenticmail_status', name: 'Server Status', description: 'Check server health', category: 'read', risk: 'low', skillId: 'agenticmail-admin', sideEffects: [] },
  { id: 'agenticmail_pending_emails', name: 'Pending Emails', description: 'Check blocked outbound emails', category: 'read', risk: 'low', skillId: 'agenticmail-admin', sideEffects: [] },

  // Organization
  { id: 'agenticmail_contacts', name: 'Contacts', description: 'Manage contacts', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_tags', name: 'Tags', description: 'Manage email tags/labels', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_signatures', name: 'Signatures', description: 'Manage email signatures', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_templates', name: 'Templates', description: 'Manage email templates', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_template_send', name: 'Send Template', description: 'Send email from template', category: 'communicate', risk: 'high', skillId: 'agenticmail', sideEffects: ['sends-email'] },
  { id: 'agenticmail_rules', name: 'Email Rules', description: 'Manage auto-processing rules', category: 'write', risk: 'medium', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_spam', name: 'Spam Management', description: 'Manage spam folder', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_drafts', name: 'Drafts', description: 'Manage email drafts', category: 'write', risk: 'low', skillId: 'agenticmail', sideEffects: [] },
  { id: 'agenticmail_schedule', name: 'Schedule Email', description: 'Schedule emails for later', category: 'communicate', risk: 'medium', skillId: 'agenticmail', sideEffects: ['sends-email'] },

  // Setup (admin only)
  { id: 'agenticmail_setup_relay', name: 'Setup Relay', description: 'Configure Gmail/Outlook relay', category: 'write', risk: 'critical', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_setup_domain', name: 'Setup Domain', description: 'Configure custom domain', category: 'write', risk: 'critical', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_setup_guide', name: 'Setup Guide', description: 'Email setup comparison', category: 'read', risk: 'low', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_setup_gmail_alias', name: 'Gmail Alias', description: 'Add Gmail send-as alias', category: 'read', risk: 'low', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_setup_payment', name: 'Setup Payment', description: 'Add Cloudflare payment', category: 'read', risk: 'low', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_purchase_domain', name: 'Purchase Domain', description: 'Search available domains', category: 'read', risk: 'low', skillId: 'agenticmail-setup', sideEffects: [] },
  { id: 'agenticmail_test_email', name: 'Test Email', description: 'Send test email', category: 'communicate', risk: 'low', skillId: 'agenticmail-setup', sideEffects: ['sends-email'] },
  { id: 'agenticmail_gateway_status', name: 'Gateway Status', description: 'Check email gateway', category: 'read', risk: 'low', skillId: 'agenticmail-setup', sideEffects: [] },

  // SMS
  { id: 'agenticmail_sms_send', name: 'Send SMS', description: 'Send SMS via Google Voice', category: 'communicate', risk: 'high', skillId: 'agenticmail-sms', sideEffects: ['sends-sms'] },
  { id: 'agenticmail_sms_messages', name: 'SMS Messages', description: 'List SMS messages', category: 'read', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_check_code', name: 'Check SMS Code', description: 'Check for verification codes', category: 'read', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_read_voice', name: 'Read Voice SMS', description: 'Read SMS from Google Voice', category: 'read', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_record', name: 'Record SMS', description: 'Save SMS to database', category: 'write', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_parse_email', name: 'Parse SMS Email', description: 'Parse SMS from forwarded email', category: 'read', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_setup', name: 'SMS Setup', description: 'Configure Google Voice SMS', category: 'write', risk: 'medium', skillId: 'agenticmail-sms', sideEffects: [] },
  { id: 'agenticmail_sms_config', name: 'SMS Config', description: 'Get SMS configuration', category: 'read', risk: 'low', skillId: 'agenticmail-sms', sideEffects: [] },
];

/**
 * Complete tool catalog — all tools from OpenClaw + AgenticMail
 */
export const ALL_TOOLS: ToolDefinition[] = [...OPENCLAW_CORE_TOOLS, ...AGENTICMAIL_TOOLS];

/**
 * Tool ID → ToolDefinition lookup
 */
export const TOOL_INDEX: Map<string, ToolDefinition> = new Map(ALL_TOOLS.map(t => [t.id, t]));

/**
 * Skill ID → Tool IDs mapping
 */
export function getToolsBySkill(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tool of ALL_TOOLS) {
    const list = map.get(tool.skillId) || [];
    list.push(tool.id);
    map.set(tool.skillId, list);
  }
  return map;
}

/**
 * Generate OpenClaw-compatible tools.allow / tools.deny config
 */
export function generateOpenClawToolPolicy(allowedToolIds: string[], blockedToolIds: string[]): {
  'tools.allow'?: string[];
  'tools.deny'?: string[];
} {
  const config: any = {};
  // OpenClaw uses tools.allow as allowlist and tools.deny as denylist
  // If allowlist is set, only those tools are available
  // If denylist is set, all tools except those are available
  if (blockedToolIds.length > 0 && allowedToolIds.length === 0) {
    config['tools.deny'] = blockedToolIds;
  } else if (allowedToolIds.length > 0) {
    config['tools.allow'] = allowedToolIds;
  }
  return config;
}
