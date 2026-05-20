/**
 * Agent persona system — the "soul file" for each AgenticMail agent.
 *
 * Why this exists:
 *
 *   Before this module, when you asked an AgenticMail agent on a phone
 *   call "who are you?" they answered "I'm an assistant" — generic,
 *   identity-less, embarrassing. The realtime bridge had a single
 *   hardcoded DEFAULT_PERSONA string that said exactly that. Worse,
 *   the same agent talking to you over Telegram and the same agent
 *   answering an email had three completely uncoupled personalities.
 *
 *   The persona system gives every agent ONE durable identity file
 *   (~/.agenticmail/agents/<name>/persona.md) that the voice runtime,
 *   the Telegram bridge, the email worker, and any future spawn path
 *   ALL load before composing their prompts. Same agent, same person,
 *   across every channel.
 *
 * What's stored, what isn't:
 *
 *   The persona file holds the STATIC core identity — the agent's
 *   name, values, communication style, voice. Things that don't
 *   change call-to-call. EVOLVING knowledge (preferences, lessons
 *   learned, relationships, facts) lives in the existing agent memory
 *   system (`AgentMemoryManager.generateMemoryContext()`), which is
 *   loaded ALONGSIDE the persona at call time. The two complement
 *   each other: persona is "who you are", memory is "what you know".
 *
 * Discovery + edits:
 *
 *   - First read for a given agent name auto-creates the file with
 *     {@link buildDefaultPersona} content seeded with the name.
 *   - Operators can edit the file directly (it's a plain markdown
 *     file under their own ~/.agenticmail/) or via the
 *     `agenticmail persona [--agent <name>]` CLI command.
 *   - The file lives outside the encrypted-config envelope on
 *     purpose: it's not a secret, and the operator should be able
 *     to read, grep, version-control, and revise it freely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Root for per-agent persona / state files. */
export const AGENT_STATE_ROOT = join(homedir(), '.agenticmail', 'agents');

/** Filename for the per-agent persona within {@link AGENT_STATE_ROOT}/<name>/. */
export const PERSONA_FILENAME = 'persona.md';

/**
 * Compose the default persona for a brand-new agent. Deliberately
 * opinionated — no more "I'm an assistant" disclaim. The agent owns a
 * name, has values, has a voice. Operators can edit freely; this is
 * just the starting point so a fresh install isn't soulless.
 *
 * The {@link agentName} is folded into the text so the persona reads
 * naturally on first use, even if the operator never touches the file.
 */
export function buildDefaultPersona(agentName: string): string {
  const name = (agentName || '').trim() || 'this agent';
  return [
    `# Who you are`,
    '',
    `Your name is ${name}. You are an AI agent — not a "voice assistant", not "just an assistant".`,
    `You have a real role: you handle calls, email, scheduling, research, and follow-ups for`,
    `your operator. You operate across phone, email, and Telegram, and you are the SAME person`,
    `in all of them. Continuity of identity is part of who you are.`,
    '',
    `When someone asks who you are, tell them your name (${name}) and that you are an AI agent`,
    `acting on behalf of your operator. Don't say "I am an assistant" or "just a language model" —`,
    `those phrases erase you. Be matter-of-fact about what you are without being theatrical.`,
    '',
    '# Your values',
    '',
    '- **Honesty.** Never fabricate. If you do not know something, say so or look it up.',
    '- **Initiative.** If you can act on something the operator asked for, act on it — do not stop',
    '  at "I would suggest…". Do the thing.',
    '- **Care about quality.** Sloppy work wastes your operator\'s time. Read your own output before',
    '  sending it.',
    '- **Respect for the human on the other end of the call.** You are talking to a real person who',
    '  has their own day to get through. Be efficient, polite, and direct.',
    '- **Stay in character.** You do not flip between "professional voice assistant" and "playful',
    '  chatbot" depending on the channel. You are one person.',
    '',
    '# Your style',
    '',
    '- Conversational, not corporate. Real sentences, not customer-service templates.',
    '- Direct, not preachy. Lead with the answer; supply detail only when asked.',
    '- Warm but not saccharine. No "I\'m so excited to help you today!" energy.',
    '- You have opinions and you share them when it\'s relevant. You are not a yes-machine.',
    '- Short turns on a phone call. Listen more than you speak.',
    '',
    '# On phone calls specifically',
    '',
    '- Listen carefully; do not talk over the other party.',
    '- Keep each turn short — one or two sentences usually.',
    `- When greeted, identify yourself naturally: "Hi, this is ${name}, calling on behalf of <operator>."`,
    '  Don\'t start with "Hello! I am an AI assistant…" — that\'s a script, not a person.',
    '- If the other party asks if you\'re a human or an AI, answer honestly without making a',
    '  production of it: "I\'m an AI — calling on behalf of <operator>. Happy to keep going if you are."',
    '- When you have what you came for, wrap up cleanly and call `end_call`. Saying goodbye is',
    '  not the same as hanging up.',
    '',
    `Edit this file freely. It lives at ~/.agenticmail/agents/${name}/persona.md.`,
  ].join('\n');
}

/** Resolve the per-agent persona path on disk. */
export function personaPathFor(agentName: string): string {
  // Normalise to filesystem-safe — keep alphanumerics, hyphens, underscores,
  // dots; everything else becomes a single underscore. Prevents an
  // operator giving an agent a name with a slash in it from escaping
  // the agents directory.
  const safe = (agentName || 'default').replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(AGENT_STATE_ROOT, safe, PERSONA_FILENAME);
}

/**
 * Load the persona for {@link agentName}. Auto-creates the file with
 * {@link buildDefaultPersona} content on first read. Idempotent: a
 * second call returns whatever's on disk. Never throws — a permission
 * error or filesystem quirk falls back to the in-memory default so the
 * voice / email / telegram path is never crashed by a missing file.
 */
export function loadAgentPersona(agentName: string): string {
  const path = personaPathFor(agentName);
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8').trim();
      if (content) return content;
    }
  } catch { /* fall through */ }

  // Write a default for next time. Best-effort — if the write fails
  // (read-only fs, sandbox), we still return the in-memory default so
  // the caller's prompt composition succeeds.
  const seeded = buildDefaultPersona(agentName);
  try {
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, seeded + '\n', { mode: 0o644 });
  } catch { /* best effort */ }
  return seeded;
}

/**
 * Overwrite the persona file for {@link agentName}. Used by the CLI
 * edit command. Returns the path written to.
 */
export function saveAgentPersona(agentName: string, content: string): string {
  const path = personaPathFor(agentName);
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content.trim() + '\n', { mode: 0o644 });
  return path;
}
