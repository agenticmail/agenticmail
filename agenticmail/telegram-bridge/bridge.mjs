#!/usr/bin/env node
/**
 * agenticmail-telegram-bridge — always-on Telegram ↔ claude router.
 *
 * Shuttles inbound Telegram messages into claude and streams the
 * responses back. Supports:
 *   - Long-polling (default) OR webhook mode (if webhook URL configured)
 *   - Per-sender session isolation — each Telegram user gets a continuous
 *     Claude conversation, persisted across restarts
 *   - Media download (photo/video/document/voice/audio) → local paths
 *     attached to the prompt so Claude can read them
 *   - Auto-registered Telegram MCP server so Claude can send proactive
 *     messages back to any chat (useful for cron-triggered notifications)
 *   - Allow-list of Telegram user IDs
 *   - Per-chat inflight dedup + typing indicator
 *   - Clean restart recovery via persistent offset
 *
 * Setup: run `agenticmail setup-telegram` or see the top of that file for details.
 *
 * Env overrides:
 *   TELEGRAM_BOT_TOKEN           — inline bot token (overrides token file)
 *   AGENTICMAIL_BRIDGE_MODE             — 'poll' | 'webhook' (default: auto-detect)
 *   AGENTICMAIL_BRIDGE_WEBHOOK_PORT            — port for webhook HTTP server (default: 8787)
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createLogger } from './lib/log.mjs';
import {
  TG_DIR,
  TELEGRAM_TOKEN_FILE,
  TELEGRAM_ALLOWED_IDS_FILE,
  TELEGRAM_OFFSET_FILE,
  TELEGRAM_WEBHOOK_CONFIG_FILE,
  MCP_CONFIG_FILE,
  AGENT_KEY_FILE,
} from './lib/paths.mjs';
import {
  tgApi,
  sendMessage,
  sendChatAction,
  downloadMedia,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
} from './lib/telegram-api.mjs';
import { SessionMap } from './lib/sessions.mjs';
import { runClaude, loadAnthropicToken } from './lib/claude-runner.mjs';
import { classifyClaudeChildError } from './lib/error-classifier.mjs';
import { loadBridgePersona } from './lib/persona-loader.mjs';
import {
  ALLOW_ALL_TOKEN,
  createWebhookRequestHandler,
  isSenderAllowed,
  parseAllowedIds,
  resolveWebhookSecret,
} from './lib/webhook-auth.mjs';

/**
 * Generate (or refresh) the MCP config the spawned `claude -p` turn loads.
 *
 * The config registers `@agenticmail/mcp` as a single MCP server, scoped
 * to the agent that owns the Telegram channel via `AGENTICMAIL_API_KEY`.
 * That gives every Telegram turn access to the full AgenticMail toolset:
 *
 *   - Persistent memory     — `mcp__agenticmail__memory_*` (the same
 *     memory store the dispatcher's workers use, so a fact the bot
 *     learns over Telegram is visible to email replies and vice
 *     versa).
 *   - Email send / search / read   — `mcp__agenticmail__send_email`, etc.
 *   - Voice calls           — `call_phone` and friends, so the bot can
 *     literally place a phone call from inside a Telegram turn.
 *   - SMS, contacts, drafts, signatures, file storage, agent
 *     coordination, scheduled sends … everything the MCP server
 *     surfaces.
 *
 * The config is regenerated every boot so a key rotation flows in
 * cleanly without manual cleanup. `agenticmail-mcp` resolves on
 * PATH — the standard install of `@agenticmail/cli` puts it there.
 *
 * Returns the path to write, or `null` if no agent key is configured
 * (in which case the bridge runs without MCP — the bot still replies,
 * just without memory or tools).
 */
function ensureMcpConfig(log) {
  if (!existsSync(AGENT_KEY_FILE)) {
    log.warn(`No agent key at ${AGENT_KEY_FILE} — MCP tools (memory, send_email, call_phone, …) will be unavailable to the bot. Re-run \`agenticmail setup\` or write the key file manually to enable.`);
    return null;
  }
  const agentKey = readFileSync(AGENT_KEY_FILE, 'utf8').trim();
  if (!agentKey) {
    log.warn(`Agent key file ${AGENT_KEY_FILE} is empty — skipping MCP wiring.`);
    return null;
  }
  const apiUrl = process.env.AGENTICMAIL_API_URL || 'http://127.0.0.1:3829';

  // Resolve the MCP server command. Three paths in order of preference:
  //
  //   1. `agenticmail-mcp` is on PATH — they already installed
  //      `@agenticmail/mcp` globally. Cheapest cold-start.
  //   2. Fall through to `npx -y @agenticmail/mcp@latest` — fresh
  //      installs that only ran `npm install -g @agenticmail/cli`
  //      (which doesn't pull mcp transitively) still get a working
  //      bridge. First spawn caches into ~/.npm/_npx so subsequent
  //      spawns are fast.
  //
  // The earlier bridge config hardcoded the bare `agenticmail-mcp`
  // command, which silently failed in case 2 — Claude couldn't find
  // the binary and spawned with zero MCP tools, leaving the agent
  // to apologise that "the voice tool isn't loaded" when the user
  // asked for a phone call.
  let command = 'npx';
  let args = ['-y', '@agenticmail/mcp@latest'];
  try {
    const onPath = execFileSync('which', ['agenticmail-mcp'], { timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (onPath) { command = onPath; args = []; }
  } catch { /* not on PATH — npx fallback wins */ }

  const cfg = {
    mcpServers: {
      agenticmail: {
        command,
        args,
        env: {
          AGENTICMAIL_API_KEY: agentKey,
          AGENTICMAIL_API_URL: apiUrl,
        },
      },
    },
  };
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  log.info(`mcp server command: ${command} ${args.join(' ')}`.trim());
  return MCP_CONFIG_FILE;
}

const log = createLogger('tg-bridge');

// ── bootstrap helpers ────────────────────────────────────────────────────────
function loadBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  if (existsSync(TELEGRAM_TOKEN_FILE)) return readFileSync(TELEGRAM_TOKEN_FILE, 'utf8').trim();
  log.error(`No Telegram token. Set TELEGRAM_BOT_TOKEN or save to ${TELEGRAM_TOKEN_FILE}`);
  process.exit(1);
}

function loadAllowedIds() {
  if (!existsSync(TELEGRAM_ALLOWED_IDS_FILE)) {
    log.warn(`No allow-list at ${TELEGRAM_ALLOWED_IDS_FILE} — bot will ignore ALL messages`);
    return new Set();
  }
  const ids = parseAllowedIds(readFileSync(TELEGRAM_ALLOWED_IDS_FILE, 'utf8'));
  if (ids.size === 0) {
    log.warn(`Allow-list ${TELEGRAM_ALLOWED_IDS_FILE} is empty — bot will ignore ALL messages`);
  } else if (ids.has(ALLOW_ALL_TOKEN)) {
    log.warn(`Allow-list contains "${ALLOW_ALL_TOKEN}" — bot will accept messages from ANY Telegram user`);
  }
  return ids;
}

function loadOffset() {
  if (!existsSync(TELEGRAM_OFFSET_FILE)) return 0;
  try {
    return JSON.parse(readFileSync(TELEGRAM_OFFSET_FILE, 'utf8')).offset || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  mkdirSync(TG_DIR, { recursive: true });
  writeFileSync(
    TELEGRAM_OFFSET_FILE,
    JSON.stringify({ offset, updatedAt: new Date().toISOString() }),
  );
}

function loadWebhookConfig() {
  if (!existsSync(TELEGRAM_WEBHOOK_CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TELEGRAM_WEBHOOK_CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ── prompt formatting ────────────────────────────────────────────────────────
function formatPrompt(msg, mediaPaths) {
  const from = msg.from || {};
  const chat = msg.chat || {};
  const text = msg.text || msg.caption || '';
  const senderName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'User';
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';

  // Header block gives Claude metadata + explicit reply routing rules.
  //
  // CRITICAL: without these rules Claude sometimes calls telegram_send to
  // reply to the current chat AND also writes a narration like "Sent X to
  // the chat" to stdout, which the bridge forwards as a second message.
  // The user receives two copies. By spelling out that stdout IS the reply
  // and telegram_send is for OTHER chats only, we get exactly one message
  // per turn.
  const header = [
    '[Incoming Telegram message — via agenticmail-telegram-bridge]',
    `from_name: ${senderName}`,
    `from_id: ${from.id}`,
    `chat_id: ${chat.id}`,
    `chat_type: ${chat.type}`,
    `message_id: ${msg.message_id}`,
    isGroup ? `chat_title: ${chat.title || '(untitled)'}` : null,
    `timestamp: ${new Date((msg.date || 0) * 1000).toISOString()}`,
    '',
    '=== REPLY ROUTING (important, read before responding) ===',
    `To reply to THIS message (chat_id=${chat.id}): just write your response as`,
    'your normal final text. Whatever you print to stdout will be sent back to',
    'this chat automatically by the bridge. Do NOT call telegram_send for the',
    'reply — that causes a duplicate message.',
    '',
    'Use telegram_send ONLY for: (a) messaging a DIFFERENT chat than this one,',
    '(b) proactive notifications triggered by something other than the current',
    "incoming message, or (c) sending media via telegram_send_media.",
    '',
    'Keep replies concise and plain-text (markdown formatting gets stripped',
    'by the bridge before Telegram delivery). No narration about what you',
    "just did — just answer the user's question.",
    '=== END REPLY ROUTING ===',
    '',
    '=== AVAILABLE AGENTIC MAIL CAPABILITIES ===',
    'You have the AgenticMail MCP server loaded. The most common tools are',
    'pre-declared in your tool list (whoami, list_inbox, read_email, send_email,',
    'reply_email, search_emails, list_agents, message_agent, call_agent,',
    'wait_for_email, check_activity, tail_worker, get_thread_id,',
    'save_thread_memory, check_tasks, call_phone, telegram_send, get_datetime,',
    'web_search, memory, memory_context).',
    '',
    `In particular: YES, you CAN place a phone call. The tool is mcp__agenticmail__call_phone`,
    `(args: to, task, policy?). Use it when the user asks you to call someone.`,
    'If the user wants you to call THEM, they\'ll usually give you their number;',
    'otherwise ask. Phone transport must be set up first (`agenticmail setup-phone`)',
    `— if you get a "no phone transport configured" error, tell the user to run that.`,
    '',
    'Other tools NOT in your default list (50+) are reachable via the `invoke`',
    'meta-tool: invoke({ tool: "<name>", args: {...} }). Call request_tools()',
    'to see the full catalogue when you need something less common (sms_send,',
    'manage_signatures, manage_contacts, voice_clone, video_edit, etc.).',
    '=== END CAPABILITIES ===',
    '',
  ]
    .filter(l => l !== null)
    .join('\n');

  const parts = [header];
  if (text) parts.push(text);
  if (mediaPaths && mediaPaths.length > 0) {
    parts.push('');
    parts.push('Attached media files (read with the Read tool if needed):');
    for (const p of mediaPaths) parts.push(`- ${p}`);
  }
  return parts.join('\n');
}

// ── per-chat message queue ───────────────────────────────────────────────────
//
// Old design: "inflight dedup" — if a task was running, new messages got a
// "⏳ busy" notice (which Telegram rate-limited, crashing the bridge) or were
// silently dropped (losing the user's input).
//
// New design: per-chat QUEUE. Messages are never dropped or noticed. They
// accumulate while a task is running. When the current task finishes, the
// queue is drained: all waiting messages are batched into ONE combined prompt
// for the next turn ("btw" pattern — the agent sees everything the user said
// while it was working, in order, as a single multi-part message). No
// Telegram spam, no lost messages, the agent gets full context.

const chatQueues = new Map(); // chatId → { messages, processing, currentChild, aborted }
let activeWorkers = 0; // tracked by processChatQueue, read by shutdown handler
// Dedup: track recently-seen message_ids so duplicate Telegram updates
// (from local Bot API replay, media resends, or webhook+poll overlap)
// never queue the same message twice. Keeps the last 500 ids per chat.
const seenMessageIds = new Map(); // chatId → Set<messageId>
const SEEN_IDS_MAX = 500;

// Words that, when sent alone (case-insensitive, trimmed, optional trailing
// punctuation), abort whatever claude run is in flight for that chat and
// clear any queued follow-ups. Kept narrow on purpose: anything longer or
// ambiguous should be treated as a normal message.
const STOP_WORDS = new Set(['stop', 'abort', 'kill', 'cancel', 'halt']);

/**
 * v0.9.91 — POST a parsed Telegram message to the API's operator-query
 * intake endpoint. The API parses the text for `/approve`, `/reject`,
 * `/answer`, or a reply-quote with an `[AMQ oq_…]` tag, finds the
 * matching pending operator query, and records the answer against the
 * live phone mission. Returns the API's structured response, or null
 * when intake is disabled (no agent-key on disk).
 *
 * Best-effort: any HTTP / network failure is THROWN so the caller can
 * decide to fall through to claudecode (which is what the bridge does).
 * A non-2xx response is logged and treated as "not consumed".
 */
async function tryOperatorQueryIntake(parsed, state, log) {
  if (!state.agentKeyForIntake) return null;
  const url = `${state.intakeApiBase}/api/agenticmail/telegram/operator-query/intake`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.agentKeyForIntake}`,
    },
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn(`intake non-2xx: ${res.status} ${body.slice(0, 200)}`);
    return null;
  }
  return res.json();
}

function isStopCommand(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase().replace(/[!.?]+$/, '');
  return STOP_WORDS.has(cleaned);
}

// /btw <text> — matches the harness's /btw feature. In telegram we can't
// interject into a live print-mode run (cli.js -p is one-shot, no stdin),
// so "mid-task" is implemented as: tag the message, queue it, and render
// it with a clear "side note while you were working" framing on the next
// turn. If no run is in flight, behaves like a normal message with the
// /btw prefix stripped.
const BTW_PREFIX = /^\/btw\b\s*/i;

function detectBtw(text) {
  if (!text) return { isBtw: false, stripped: text };
  const m = text.match(BTW_PREFIX);
  if (!m) return { isBtw: false, stripped: text };
  return { isBtw: true, stripped: text.slice(m[0].length) };
}

function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) {
    chatQueues.set(chatId, {
      messages: [],
      processing: false,
      currentChild: null, // spawned claude ChildProcess during a run
      aborted: false,     // set by a stop command so the worker skips reply
    });
  }
  return chatQueues.get(chatId);
}

/** Kill the in-flight claude run for a chat (if any) and clear its queue. */
function abortChatRun(chatId) {
  const queue = chatQueues.get(chatId);
  if (!queue) return { killed: false, dropped: 0 };
  const dropped = queue.messages.length;
  queue.messages = [];
  let killed = false;
  const child = queue.currentChild;
  if (child && child.pid && child.exitCode === null && !child.killed) {
    queue.aborted = true;
    try {
      // Kill the whole process group — the child was spawned detached, so
      // its PID is also its PGID. This takes down any MCP subprocesses too.
      process.kill(-child.pid, 'SIGTERM');
      killed = true;
    } catch {
      // Fall back to killing just the child if the group kill fails
      // (e.g. race where the child has already exited).
      try { child.kill('SIGTERM'); killed = true; } catch {}
    }
  }
  return { killed, dropped };
}

function isDuplicateMessage(chatId, messageId) {
  if (!seenMessageIds.has(chatId)) {
    seenMessageIds.set(chatId, new Set());
  }
  const seen = seenMessageIds.get(chatId);
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  // Prune old ids to cap memory
  if (seen.size > SEEN_IDS_MAX) {
    const arr = [...seen];
    seenMessageIds.set(chatId, new Set(arr.slice(-SEEN_IDS_MAX / 2)));
  }
  return false;
}

async function handleMessage(msg, state) {
  const userId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');

  // Allow-list gate — fails closed: an empty allow-list admits nobody.
  if (!isSenderAllowed(state.allowedIds, userId)) {
    return; // silent — don't even log, to avoid flooding logs with unauthorized noise
  }

  // Dedup: if we've already seen this exact message_id for this chat, skip.
  // This catches duplicate Telegram updates from local Bot API replay,
  // media message resends, and webhook+poll overlap.
  const messageId = msg.message_id;
  if (isDuplicateMessage(chatId, messageId)) {
    return; // completely silent — no log, no notice, no queue entry
  }

  // Stop command: if the user sends a bare "stop"/"abort"/"kill"/... it
  // aborts the in-flight run and drops any queued follow-ups for this chat.
  // Checked BEFORE media download so it reacts instantly even on mid-run panics.
  const rawText = msg.text || msg.caption || '';
  if (isStopCommand(rawText)) {
    const { killed, dropped } = abortChatRun(chatId);
    log.info(`stop command from user=${userId} chat=${chatId}: killed=${killed} dropped=${dropped}`);
    const parts = [];
    if (killed) parts.push('stopped in-flight run');
    if (dropped > 0) parts.push(`dropped ${dropped} queued`);
    const reply = parts.length ? `🛑 ${parts.join(', ')}.` : 'Nothing to stop.';
    await sendMessage(state.token, chatId, reply, { replyToMessageId: messageId }).catch(() => {});
    return;
  }

  // Download any attached media BEFORE queueing so the paths are ready
  // when the worker picks up the message.
  const mediaPaths = [];
  const mediaRefs = [];
  if (msg.photo?.length)
    mediaRefs.push({ fileId: msg.photo.at(-1).file_id, name: `photo-${Date.now()}.jpg` });
  if (msg.video) mediaRefs.push({ fileId: msg.video.file_id, name: msg.video.file_name });
  if (msg.document) mediaRefs.push({ fileId: msg.document.file_id, name: msg.document.file_name });
  if (msg.voice) mediaRefs.push({ fileId: msg.voice.file_id, name: `voice-${Date.now()}.ogg` });
  if (msg.audio)
    mediaRefs.push({ fileId: msg.audio.file_id, name: msg.audio.file_name || `audio-${Date.now()}.mp3` });

  for (const m of mediaRefs) {
    const p = await downloadMedia(state.token, m.fileId, m.name, err => log.warn(err));
    if (p) {
      mediaPaths.push(p);
      log.info(`downloaded media → ${p}`);
    }
  }

  const text = msg.text || msg.caption || '';
  if (!text && mediaPaths.length === 0) {
    log.info(`empty message from user_id=${userId}, skipping`);
    return;
  }

  // v0.9.91 — operator-query intake. BEFORE forwarding to claudecode,
  // ask the API whether this message answers a pending `ask_operator`
  // query on a live phone call. If yes, the API records the answer (the
  // voice agent on the call gets it within its next poll cycle), and the
  // bridge sends a confirmation to the operator + skips the claudecode
  // forward — much faster than letting an LLM round-trip notice it.
  //
  // Best-effort: if the API is unreachable, the intake throws, we log,
  // and fall through to the regular claudecode path. The LLM still
  // catches missed answers via its own context (the v0.9.91 dispatcher
  // hardening also teaches claudecode to re-dial when an answer arrives
  // after an operator query timed out).
  if (text && mediaPaths.length === 0) {
    try {
      const intake = await tryOperatorQueryIntake({
        chatId,
        chatType: msg.chat?.type || 'private',
        messageId,
        fromId: userId,
        fromName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'User',
        fromUsername: msg.from?.username || '',
        text,
        replyToText: msg.reply_to_message?.text || msg.reply_to_message?.caption || '',
        updateId: 0,
      }, state, log);
      if (intake?.answered) {
        log.info(`operator-query answered via bridge intake: queryId=${intake.answeredQueryId} (skipping claudecode forward)`);
        if (intake.confirmation) {
          await sendMessage(state.token, chatId, intake.confirmation, {
            replyToMessageId: messageId,
          }).catch(() => {});
        }
        return; // consumed by operator-query path; no claudecode turn needed
      }
      if (intake?.confirmation) {
        // Non-answered branch returned a hint (e.g. "you have 2 open
        // questions, reply with /answer ..."). Surface it but still
        // forward to claudecode so the LLM can also weigh in.
        await sendMessage(state.token, chatId, intake.confirmation, {
          replyToMessageId: messageId,
        }).catch(() => {});
      }
    } catch (err) {
      log.warn(`operator-query intake failed (${err.message}); falling through to claudecode`);
    }
  }

  // /btw prefix → side-note framing. Strip the prefix from the text the agent
  // sees and rewrite msg.text/caption so formatPrompt picks up the cleaned
  // version. isBtw is stashed on the queue entry for the batch renderer.
  const { isBtw, stripped } = detectBtw(text);
  if (isBtw) {
    if (msg.text !== undefined) msg.text = stripped;
    if (msg.caption !== undefined) msg.caption = stripped;
  }

  // Enqueue the message
  const queue = getChatQueue(chatId);
  queue.messages.push({ msg, mediaPaths, userId, isBtw });
  log.info(
    `queued msg #${msg.message_id} for chat=${chatId} (queue depth: ${queue.messages.length})${isBtw ? ' [btw]' : ''}`,
  );

  // If no worker is running for this chat, start one
  if (!queue.processing) {
    processChatQueue(chatId, state);
  }
}

/**
 * Worker loop for a single chat. Drains the queue one batch at a time.
 * While a claude turn is running, new messages accumulate in the queue.
 * When the turn finishes, the worker checks if more messages arrived and
 * combines them into one prompt for the next turn (the "btw" batch).
 */
async function processChatQueue(chatId, state) {
  const queue = getChatQueue(chatId);
  if (queue.processing) return; // another worker already running
  queue.processing = true;
  activeWorkers++;

  try {
    while (queue.messages.length > 0 && state.running) {
      // Drain everything currently in the queue into one batch
      const batch = queue.messages.splice(0, queue.messages.length);
      const firstMsg = batch[0].msg;
      const userId = batch[0].userId;

      // Typing indicator
      sendChatAction(state.token, chatId);
      const typingTimer = setInterval(() => sendChatAction(state.token, chatId), 4000);

      try {
        const sessionId = state.sessions.getOrCreate(userId);

        // If session just rotated, extract handoff context from the old session
        let sessionHandoff = null;
        if (state.sessions.lastRotation) {
          const { from } = state.sessions.lastRotation;
          log.info(`session rotated: ${from.slice(0, 8)} → ${sessionId.slice(0, 8)}, building handoff`);
          sessionHandoff = state.sessions.getSessionHandoff(from);
          if (sessionHandoff) {
            log.info(`handoff context: ${sessionHandoff.length} chars from old session`);
          }
        }

        // Build the prompt: if there's just one message, use normal format.
        // If there are multiple (user sent follow-ups while agent was working),
        // combine them with "[btw]" separators so the agent sees the full context.
        // Entries flagged isBtw (user typed "/btw ..." to give a side instruction
        // mid-task) get a distinct header so the agent treats them as supplemental
        // guidance rather than a separate new task.
        const btwHeader = (i) =>
          i === 0
            ? '\n[BTW — side note from user, factor into your current work but it is not a new standalone task]\n'
            : `\n[Follow-up #${i + 1} — BTW side note from user while you were working, factor in alongside the other messages]\n`;
        const followUpHeader = (i) => `\n[Follow-up message #${i + 1} sent while you were working]\n`;
        let prompt;
        if (batch.length === 1) {
          const entry = batch[0];
          prompt = entry.isBtw
            ? btwHeader(0) + formatPrompt(firstMsg, entry.mediaPaths)
            : formatPrompt(firstMsg, entry.mediaPaths);
        } else {
          const parts = batch.map((entry, i) => {
            const body = formatPrompt(entry.msg, entry.mediaPaths);
            if (entry.isBtw) return btwHeader(i) + body;
            return i === 0 ? body : followUpHeader(i) + body;
          });
          prompt = parts.join('\n\n---\n\n');
        }

        log.info(
          `→ claude user=${userId} chat=${chatId} session=${sessionId.slice(0, 8)} batch=${batch.length} prompt_len=${prompt.length}`,
        );

        queue.aborted = false;
        let result;
        try {
          result = await runClaude({
            prompt,
            sessionId,
            sessionHandoff,
            personaPrompt: state.personaPrompt,
            anthropicToken: state.anthropicToken,
            mcpConfig: state.mcpConfig,
            onLog: line => log.info(`claude: ${line}`),
            onSpawn: child => { queue.currentChild = child; },
          });
        } finally {
          queue.currentChild = null;
        }

        if (queue.aborted) {
          log.info(`← claude user=${userId} aborted by user, suppressing reply`);
        } else {
          log.info(`← claude user=${userId} response_len=${result.stdout.length}`);
          if (result.stdout) {
            // Reply to the LAST message in the batch so it threads correctly
            const lastMsg = batch[batch.length - 1].msg;
            await sendMessage(state.token, chatId, result.stdout, {
              replyToMessageId: lastMsg.message_id,
            });
          } else {
            log.info('empty stdout — likely tool-only turn, no fallback reply sent');
          }
        }
      } catch (err) {
        if (queue.aborted) {
          // User-requested kill surfaces as a SIGTERM-rejected promise — swallow it.
          log.info(`handler: run aborted by user (${err.message.slice(0, 80)})`);
        } else {
          // Classify the failure into one of: rate-limited, quota-exceeded,
          // subscription-disabled, auth-failed, overloaded, unknown — and
          // send a chat-friendly message so the human on the other end
          // knows what to do (wait, refresh token, contact admin). The
          // raw stderr stays in the bridge log for the operator to debug.
          const classified = classifyClaudeChildError(err.message);
          log.error(`handler error [${classified.category}]: ${err.message.slice(0, 600)}`);
          await sendMessage(
            state.token,
            chatId,
            classified.message,
            { replyToMessageId: firstMsg.message_id },
          ).catch(() => {});
        }
      } finally {
        clearInterval(typingTimer);
      }

      // Brief yield so the event loop can accept new messages from the
      // poll before we check the queue again
      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    queue.processing = false;
    activeWorkers--;
  }
}

// ── transport: long-poll ─────────────────────────────────────────────────────
async function runPollingLoop(state) {
  let offset = loadOffset();
  log.info(`polling mode, starting offset=${offset}`);

  // Make sure no webhook is registered while we poll (Telegram rejects getUpdates
  // if a webhook is active)
  try {
    const info = await getWebhookInfo(state.token);
    if (info?.url) {
      log.info(`webhook currently set to ${info.url}, clearing it for polling mode`);
      await deleteWebhook(state.token);
    }
  } catch (err) {
    log.warn(`webhook info check failed: ${err.message}`);
  }

  while (state.running) {
    try {
      const updates = await tgApi(
        state.token,
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message'] },
        { longPoll: true },
      );
      // Advance offset FIRST, save to disk, THEN dispatch messages.
      // This ensures a crash during message handling can't replay the
      // same batch — Telegram considers them consumed once we poll
      // with the higher offset on the next iteration.
      for (const update of updates) {
        if (update.update_id >= offset) offset = update.update_id + 1;
      }
      if (updates.length > 0) saveOffset(offset);

      // Now dispatch (fire-and-forget so slow Claude runs don't block polling)
      for (const update of updates) {
        if (update.message) {
          handleMessage(update.message, state).catch(err =>
            log.error(`unhandled message: ${err.message}`),
          );
        }
      }
    } catch (err) {
      log.error(`poll error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  saveOffset(offset);
}

// ── transport: webhook ──────────────────────────────────────────────────────
async function runWebhookServer(state, webhookCfg) {
  const port = Number(process.env.AGENTICMAIL_BRIDGE_WEBHOOK_PORT || webhookCfg.port || 8787);
  const path = webhookCfg.path || `/agenticmail-telegram-webhook`;
  const url = webhookCfg.url; // public URL: e.g. https://your-domain.example + path

  if (!url) {
    log.error(`webhook mode requires "url" in ${TELEGRAM_WEBHOOK_CONFIG_FILE}`);
    process.exit(1);
  }

  // The secret is mandatory: without it anyone who can reach the port
  // could POST a forged update. Generate + persist one when absent; it is
  // registered with Telegram below so deliveries carry it.
  let secret;
  try {
    const resolved = resolveWebhookSecret(webhookCfg);
    secret = resolved.secret;
    if (resolved.generated) {
      writeFileSync(
        TELEGRAM_WEBHOOK_CONFIG_FILE,
        JSON.stringify({ ...webhookCfg, secret }, null, 2),
        { mode: 0o600 },
      );
      try { chmodSync(TELEGRAM_WEBHOOK_CONFIG_FILE, 0o600); } catch { /* best effort */ }
      log.warn(`no webhook "secret" configured — generated one and saved it to ${TELEGRAM_WEBHOOK_CONFIG_FILE}`);
    }
  } catch (err) {
    log.error(`${err.message} (${TELEGRAM_WEBHOOK_CONFIG_FILE})`);
    process.exit(1);
  }

  if (state.allowedIds.size === 0) {
    log.warn('allow-list is empty — every webhook message will be refused until a Telegram user id is added');
  }

  log.info(`webhook mode, listening on :${port}${path}, public URL = ${url}`);

  const server = createServer(createWebhookRequestHandler({
    path,
    secret,
    onUpdate: update => {
      if (update?.message) {
        handleMessage(update.message, state).catch(err =>
          log.error(`webhook handler: ${err.message}`),
        );
      }
    },
    onError: err => log.error(`webhook parse: ${err.message}`),
  }));

  server.listen(port, () => {
    log.info(`webhook HTTP server ready on port ${port}`);
  });

  // Register the webhook with Telegram. The secret is always sent so
  // Telegram echoes it on every delivery; without a successful
  // registration Telegram's requests would be refused (403), never
  // admitted unauthenticated.
  try {
    await setWebhook(state.token, url, { secretToken: secret });
    log.info(`webhook registered with Telegram → ${url}`);
  } catch (err) {
    log.error(`setWebhook failed — deliveries will be refused until it succeeds: ${err.message}`);
  }

  // Block until shutdown
  await new Promise(resolve => {
    state.stopServer = resolve;
  });

  server.close();
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(TG_DIR, { recursive: true });

  const token = loadBotToken();
  const { token: anthropicToken, source: tokenSource } = loadAnthropicToken();
  if (!anthropicToken) {
    log.error('No Anthropic OAuth token. Save it to ~/.agenticmail/anthropic-token (or set ANTHROPIC_AUTH_TOKEN).');
    process.exit(1);
  }
  log.info(`anthropic token source: ${tokenSource} (suffix ...${anthropicToken.slice(-6)})`);

  const allowedIds = loadAllowedIds();
  const sessions = new SessionMap({ scope: 'telegram' }).load();

  // Ensure the telegram-mcp server is registered so Claude can send proactively
  const mcpConfig = ensureMcpConfig(log) ?? undefined;

  // Bot identity sanity check
  let me;
  try {
    me = await tgApi(token, 'getMe');
  } catch (err) {
    log.error(`getMe failed — bad token? ${err.message}`);
    process.exit(1);
  }
  log.info(`connected as @${me.username} (${me.first_name})`);
  log.info(`allow-list: ${allowedIds.size === 0 ? 'EMPTY (all messages refused)' : [...allowedIds].join(',')}`);
  log.info(`existing sessions: ${sessions.list().length}`);
  log.info(`mcp config: ${mcpConfig || '(none)'}`);

  // v0.9.86 — load the agent's persona ("soul file") so the Telegram
  // bridge shares identity with the voice runtime and the email
  // worker. Read once at bridge boot — the file rarely changes, and
  // a per-message disk read would be wasteful. Empty string ⇒ no
  // persona-prepend on the system prompt (legacy behaviour).
  const personaPrompt = loadBridgePersona();
  if (personaPrompt) {
    log.info(`persona loaded (${personaPrompt.length} chars from ~/.agenticmail/agents/.../persona.md)`);
  } else {
    log.info('persona: none configured (set AGENTICMAIL_AGENT_NAME or create ~/.agenticmail/agents/<name>/persona.md)');
  }

  // v0.9.91 — bridge calls the API's operator-query intake endpoint
  // before forwarding messages to claudecode, so a Telegram reply that
  // answers a pending ask_operator query is routed to the live call in
  // under a second (instead of waiting for an LLM round-trip). Read
  // the agent key + API URL once at boot — both rarely change.
  let agentKeyForIntake = '';
  try {
    if (existsSync(AGENT_KEY_FILE)) {
      agentKeyForIntake = readFileSync(AGENT_KEY_FILE, 'utf8').trim();
    }
  } catch { /* missing key ⇒ intake path silently disabled */ }
  const intakeApiBase = (process.env.AGENTICMAIL_API_URL || 'http://127.0.0.1:3829').replace(/\/$/, '');
  if (agentKeyForIntake) {
    log.info(`operator-query intake enabled (api: ${intakeApiBase})`);
  } else {
    log.info('operator-query intake disabled (no agent-key on disk)');
  }

  const state = {
    token,
    anthropicToken,
    allowedIds,
    sessions,
    mcpConfig,
    personaPrompt,
    agentKeyForIntake,
    intakeApiBase,
    running: true,
    stopServer: null,
  };

  // Deferred shutdown: if SIGINT/SIGTERM arrives while a claude child
  // is processing, DON'T exit immediately — the response would be lost and
  // the user sees silence. Instead, set running=false so the poll loop
  // stops after the current batch, and let processChatQueue's finally block
  // notice that running=false and NOT start a new batch. The setTimeout
  // is a hard backstop in case something truly hangs.
  const shutdown = sig => {
    log.info(`received ${sig}`);
    state.running = false;
    if (activeWorkers > 0) {
      log.info(`${activeWorkers} worker(s) still active — deferring exit until they finish (max 90s)`);
      const hardStop = setTimeout(() => {
        log.warn('hard stop — workers did not finish in 90s');
        process.exit(0);
      }, 90_000);
      hardStop.unref(); // don't keep the process alive just for this timer
      // The worker(s) will notice state.running=false and exit the loop,
      // then the event loop drains and Node exits naturally.
    } else {
      log.info('no active workers — exiting immediately');
      if (state.stopServer) state.stopServer();
      setTimeout(() => process.exit(0), 500);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Mode selection
  const webhookCfg = loadWebhookConfig();
  const mode = process.env.AGENTICMAIL_BRIDGE_MODE || (webhookCfg?.url ? 'webhook' : 'poll');

  if (mode === 'webhook') {
    if (!webhookCfg) {
      log.error(`AGENTICMAIL_BRIDGE_MODE=webhook but ${TELEGRAM_WEBHOOK_CONFIG_FILE} is missing`);
      process.exit(1);
    }
    await runWebhookServer(state, webhookCfg);
  } else {
    await runPollingLoop(state);
  }
}

main().catch(err => {
  log.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
