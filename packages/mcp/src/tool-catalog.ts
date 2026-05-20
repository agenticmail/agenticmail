/**
 * Categorisation of the MCP tool surface into "sets", used by the
 * `request_tools` meta-tool.
 *
 * # Why this exists
 *
 * Loading the full tool schema set into a Claude Code subagent's context
 * costs ~10K tokens per spawn — most of it never used. To stay cheap, subagents
 * are launched with a small curated whitelist (the ESSENTIAL set below)
 * plus a `request_tools` meta-tool. When they need something outside the
 * curated set, they call `request_tools` to discover what exists, then
 * `invoke` to call it by name.
 *
 * This mirrors the enterprise tool-resolver's three-tier lazy-loading
 * design (see /enterprise/src/agent-tools/tool-resolver.ts), adapted for
 * the constraint that Claude Code's subagent tool list is fixed at spawn
 * time — so instead of dynamically extending the tool list, we let the
 * agent dispatch through a single generic `invoke` tool.
 *
 * # Editing the catalogue
 *
 * Adding a new tool to AgenticMail: drop it into the right set below
 * (and if no set fits, create one — keep them small and topical).
 *
 * Adding a new SET: keep `SET_DESCRIPTIONS` aligned with `TOOL_SETS`.
 * The order in SET_DESCRIPTIONS is the order shown to the agent by
 * request_tools, so put the most-commonly-needed sets first.
 *
 * Anything in NO set still works via `invoke` — `request_tools` will
 * surface it under an `"_uncategorised"` heading. That's a soft signal
 * to come back here and categorise it properly, but won't break.
 */

/** Tool sets — short, topical, ideally ≤10 tools each. */
export const TOOL_SETS = {
  /**
   * Always loaded — the common operations every agent needs immediately.
   * If you add to this list, add to ESSENTIAL_TOOLS in the subagent
   * template too (they should track each other).
   */
  essential: [
    'whoami',
    'list_inbox',
    'read_email',
    'send_email',
    'reply_email',
    'search_emails',
    'list_agents',
    'message_agent',
    // call_agent is the one-shot RPC primitive — sync request, sync answer.
    // Used when you need ONE structured result from ONE teammate; for
    // multi-step coordination use the thread pattern (send_email with CC
    // + reply_email with replyAll) instead.
    'call_agent',
    // wait_for_email is the thread-coordination primitive: block until a
    // specific reply lands in your inbox (filter by from / subject /
    // inReplyTo / participants). The host uses it to wake on the next
    // teammate reply; agents use it when they delegate and need an answer
    // back. Essential enough that paying its tokens at every spawn beats
    // making the agent discover it via request_tools.
    'wait_for_email',
    // check_activity is the dispatcher visibility primitive: see which
    // agents the dispatcher has woken right now (or in the last 2 min)
    // and how long they have been running. The host uses it to answer
    // "did the agent I just emailed actually start working?" without
    // having to wait for a reply or send an acknowledgment.
    'check_activity',
    // tail_worker complements check_activity: when a worker has been
    // running a long time or shows up as stale, tail_worker gives you
    // the running log of what it actually did — every tool call, every
    // result. Paired with check_activity so they ship in the same tier.
    'tail_worker',
    // Wake-context memory tools. Agents call get_thread_id once when
    // they read a message to find the stable thread id, then
    // save_thread_memory at end-of-wake to persist their judgment.
    // The dispatcher reads both back into the next wake's prompt so
    // the agent doesn't re-read prior messages from scratch.
    'get_thread_id',
    'save_thread_memory',
    'check_tasks',
  ],

  /** Less-common mail operations. */
  mail_extras: [
    'forward_email',
    'list_folders',
    'list_folder',
    'mark_read',
    'mark_unread',
    'move_email',
    'delete_email',
    'create_folder',
    'manage_tags',
  ],

  /** Bulk mail operations — fan-out reads, mass-mark, mass-move. */
  mail_bulk: [
    'batch_delete',
    'batch_read',
    'batch_mark_read',
    'batch_mark_unread',
    'batch_move',
    'inbox_digest',
  ],

  /** Compose-time helpers — drafts, templates, signatures, scheduling. */
  mail_compose: [
    'manage_drafts',
    'manage_templates',
    'manage_signatures',
    'manage_scheduled',
    'template_send',
    'import_relay_email',
  ],

  /** Outbound safety + rules. */
  mail_safety: [
    'manage_pending_emails',
    'manage_rules',
    'manage_spam',
  ],

  /** Agent coordination beyond the basics in `essential`. */
  agent_coord: [
    'check_messages',
    'claim_task',
    'submit_result',
  ],

  /** Address book. */
  contacts: [
    'manage_contacts',
    'update_metadata',
  ],

  /** SMS / voice messaging. */
  sms: [
    'sms_send',
    'sms_messages',
    'sms_check_code',
    'sms_parse_email',
    'sms_read_voice',
    'sms_record',
    'sms_setup',
    'sms_config',
  ],

  /** Phone call-control missions. */
  phone: [
    'phone_transport_setup',
    'phone_capabilities',
    'call_phone',
    'call_status',
    'call_transcript',
    'call_cancel',
  ],

  /** Telegram channel — bot setup, send/list messages, poll for updates. */
  telegram: [
    'telegram_setup',
    'telegram_config',
    'telegram_send',
    'telegram_messages',
    'telegram_poll',
  ],

  /** Media toolset — TTS, image/video/audio editing, probing, understanding. */
  media: [
    'media_capabilities',
    'media_tts',
    'media_tts_voices',
    'media_image_edit',
    'media_video_edit',
    'media_audio_edit',
    'media_info',
    'media_video_understand',
    'media_voice_clone',
  ],

  /** Account admin (master-key territory — create/delete accounts, cleanup). */
  account_admin: [
    'create_account',
    'delete_agent',
    'deletion_reports',
    'cleanup_agents',
    'stop_agent',
    'resume_agent',
  ],

  /** Storage of arbitrary files for an agent. */
  storage: [
    'storage',
  ],

  /** Persistent per-agent memory — long-term knowledge that survives every conversation. */
  memory: [
    'memory',
    'memory_reflect',
    'memory_context',
    'memory_stats',
  ],

  /** Skill library — JSON how-to-act-like-a-skilled-human playbooks loaded on demand during phone calls. */
  skills: [
    'skill_list',
    'skill_search',
    'skill_load',
  ],

  /** Mail-server setup / onboarding wizards. */
  setup: [
    'setup_guide',
    'setup_operator_email',
    'setup_email_relay',
    'setup_email_domain',
    'setup_gmail_alias',
    'setup_payment',
    'purchase_domain',
    'send_test_email',
  ],

  /** System health / gateway status. */
  system: [
    'check_health',
    'check_gateway_status',
  ],
} as const;

export type ToolSetName = keyof typeof TOOL_SETS;

/** One-line description shown in the request_tools catalogue. */
export const SET_DESCRIPTIONS: Record<ToolSetName, string> = {
  essential: 'Always-on baseline — inbox, send/reply, search, agent discover/message/call (RPC), tasks',
  mail_extras: 'Less-common mail ops — forward, folders, mark/move/delete, tags',
  mail_bulk: 'Bulk operations — fan-out read, mass-mark, mass-move, digest',
  mail_compose: 'Compose-time — drafts, templates, signatures, scheduling',
  mail_safety: 'Outbound safety — pending approvals, rules, spam controls',
  agent_coord: 'Beyond-basic coordination — push wait, task lifecycle (claim/submit), check_messages',
  contacts: 'Address book and your own metadata',
  sms: 'SMS / voice — send/read/setup/parse/record',
  phone: 'Phone call-control — setup/capabilities/start/status/transcript/cancel',
  telegram: 'Telegram channel — bot setup, send/list messages, poll for updates',
  skills: 'Skill library — load real-world phone-call playbooks (negotiate-bill-reduction, handle-debt-collector, book-restaurant-reservation, …) on demand mid-call. Search and load when the agent hits a situation it needs a playbook for.',
  media: 'Media toolset — text-to-speech, image/video/audio editing, probing, video understanding, voice cloning (opt-in, needs ffmpeg/ImageMagick/whisper)',
  account_admin: 'Account admin — create/delete/stop/resume agents, cleanup (master key required)',
  storage: 'File storage for an agent',
  memory: 'Persistent agent memory — remember/recall/reflect, ranked context digest, stats',
  setup: 'Mail-server onboarding wizards (one-time setup)',
  system: 'System health and gateway status checks',
};

/**
 * Reverse index built from TOOL_SETS — { toolName: setName }. Used by
 * `request_tools` to label tools that came up in a query filter, and to
 * surface "uncategorised" tools when a new tool is added but not yet
 * placed in a set.
 */
export const TOOL_TO_SET: Record<string, ToolSetName> = (() => {
  const out: Record<string, ToolSetName> = {};
  for (const [setName, tools] of Object.entries(TOOL_SETS)) {
    for (const tool of tools) out[tool] = setName as ToolSetName;
  }
  return out;
})();

/**
 * Cross-channel tools we promote to always-loaded even though they live
 * in a specialised TOOL_SETS bucket. Operators routinely ask for these
 * mid-conversation — "call my dentist", "DM me the result", "what
 * do I remember about X" — and discovering them via `request_tools` adds
 * a round-trip the host can't afford on a Telegram or phone turn. Keeping
 * them out of TOOL_SETS.essential preserves the partition (every tool
 * belongs to exactly one set); listing them HERE pulls them into the
 * default load-out without breaking that invariant.
 */
const PROMOTED_TO_ESSENTIAL: readonly string[] = [
  'call_phone',
  'telegram_send',
  'memory',
  'memory_context',
];

/** Convenience: the always-loaded tool names. The subagent template
 *  generator imports this so the .md frontmatter `tools:` list stays
 *  in sync with the MCP catalogue without a manual second source.
 *  Union of TOOL_SETS.essential + PROMOTED_TO_ESSENTIAL, deduped. */
export const ESSENTIAL_TOOLS: readonly string[] = Array.from(
  new Set<string>([...TOOL_SETS.essential, ...PROMOTED_TO_ESSENTIAL]),
);
