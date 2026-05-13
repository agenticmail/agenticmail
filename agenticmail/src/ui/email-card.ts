/**
 * Email detail card — the bordered, sectioned view used by `/read`
 * and the inbox navigator when the user presses Enter on a message.
 *
 * # Why this exists
 *
 * The previous renderer in `shell.ts` was three flat horizontal rules
 * with bare labels. It worked but read like a config dump. An email
 * has three logically distinct regions — the subject (what), the
 * envelope (who/when), and the body (what they said) — and the eye
 * wants visual separation between them.
 *
 * This module produces a card with three pink-rule sections wrapping
 * those regions, plus localised dates (via time-format.ts) and a
 * footer for attachments and security flags. Everything is ANSI;
 * works in any terminal that supports basic 8-color sequences.
 *
 * # Pure rendering, no I/O
 *
 * `renderEmailCard(msg, opts)` returns a single string. The caller
 * (the shell) writes it to stdout. That keeps this file testable
 * without mocking console.log and keeps shell.ts able to choose
 * whether to log line-by-line or buffer.
 *
 * # Width awareness
 *
 * The card uses `opts.width` (default 80) for the rule lines. It does
 * not wrap the body — terminals handle soft-wrap fine for prose, and
 * hard-wrapping breaks code blocks and ASCII tables that AgenticMail
 * agents like to put in their replies.
 */

import { formatEmailDate } from './time-format.js';

// --- ANSI helpers (copied minimally so this module has no dependency on
//     shell.ts's `c` table; the shell can keep evolving without dragging
//     the email view with it). -----------------------------------------

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const ansi = {
  reset: RESET,
  bold: (s: string) => `${ESC}1m${s}${RESET}`,
  dim: (s: string) => `${ESC}90m${s}${RESET}`,
  cyan: (s: string) => `${ESC}36m${s}${RESET}`,
  magenta: (s: string) => `${ESC}35m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
  green: (s: string) => `${ESC}32m${s}${RESET}`,
  red: (s: string) => `${ESC}31m${s}${RESET}`,
  // The brand pink we use for the project logo. `38;5;205` is xterm-256
  // hot pink — close to the bow in the logo and readable on both dark
  // and light terminals.
  pink: (s: string) => `${ESC}38;5;205m${s}${RESET}`,
};

/** Email address representation as it arrives from the API. */
interface EmailAddress {
  name?: string;
  address?: string;
}

/** Attachment record as it arrives from the API. */
interface Attachment {
  filename?: string;
  contentType?: string;
  size?: number;
}

/** What the API hands us for one parsed message. */
export interface EmailMessage {
  uid?: number;
  subject?: string;
  date?: string | number | Date;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  messageId?: string;
  inReplyTo?: string;
  text?: string;
  html?: string;
  attachments?: Attachment[];
  /** Security flags from the API's spam/sanitiser. */
  security?: {
    isSpam?: boolean;
    isWarning?: boolean;
    spamScore?: number;
    topCategory?: string;
    sanitized?: boolean;
    matches?: string[];
  };
}

export interface RenderOptions {
  /** Terminal width to fit rule lines to. Defaults to 80. */
  width?: number;
  /** Inject a fixed "now" — useful for tests so `relativeTime` is deterministic. */
  now?: Date;
}

// --- Internals -----------------------------------------------------------

/** Format an EmailAddress as `Name <addr>` or `addr` alone. */
function formatAddress(a: EmailAddress | undefined): string {
  if (!a) return '';
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? '';
}

function formatAddressList(addrs: EmailAddress[] | undefined): string {
  if (!addrs || addrs.length === 0) return '';
  return addrs.map(formatAddress).filter(Boolean).join(', ');
}

/** A horizontal rule in the brand pink, spanning `width` columns. */
function rule(width: number): string {
  const w = Math.max(10, width);
  return ansi.pink('─'.repeat(w));
}

/**
 * Strip enough HTML for terminal display when there is no plain-text
 * alternative. Not a full HTML renderer — agents almost always send
 * `text/plain` so this is a fallback for the rare HTML-only case.
 */
function stripHtmlForTerminal(html: string): string {
  return html
    // Block elements → line breaks
    .replace(/<\/(p|div|br|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    // Drop everything else
    .replace(/<[^>]+>/g, '')
    // Decode the few entities that matter for prose
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse runs of blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build the security/warning footer (only if there's something to say). */
function securityLines(msg: EmailMessage): string[] {
  const s = msg.security;
  if (!s) return [];
  const lines: string[] = [];
  if (s.isSpam) {
    const cat = s.topCategory ? ` [${s.topCategory}]` : '';
    const score = typeof s.spamScore === 'number' ? ` score=${s.spamScore.toFixed(1)}` : '';
    lines.push(`  ${ansi.red('⚠ SPAM')} ${ansi.dim(cat + score)}`);
  } else if (s.isWarning) {
    const cat = s.topCategory ? ` [${s.topCategory}]` : '';
    const score = typeof s.spamScore === 'number' ? ` score=${s.spamScore.toFixed(1)}` : '';
    lines.push(`  ${ansi.yellow('⚠ Suspicious')} ${ansi.dim(cat + score)}`);
  }
  if (s.sanitized) {
    lines.push(`  ${ansi.yellow('⚠ Content sanitised')} ${ansi.dim('(invisible characters or hidden HTML were stripped)')}`);
  }
  return lines;
}

// --- Public renderer -----------------------------------------------------

/**
 * Render one email as a multi-section card. Returns a single string
 * with embedded newlines; the caller writes it to stdout.
 *
 * Layout:
 *
 *   ─── (rule) ────────────────────────────
 *
 *     Subject (bold)
 *
 *   ─── (rule) ────────────────────────────
 *
 *     From:  Name <addr>
 *     To:    addr, addr
 *     Cc:    addr
 *     Date:  5 minutes ago — Tue, May 13, 4:22 PM
 *     UID:   42
 *
 *   ─── (rule) ────────────────────────────
 *
 *     <body, indented by two spaces>
 *
 *   ─── (rule, only if attachments/security) ──
 *
 *     📎 file.pdf  (240KB)
 *     ⚠ Suspicious  [phishing] score=4.2
 *
 *   ─── (rule) ────────────────────────────
 */
export function renderEmailCard(msg: EmailMessage, opts: RenderOptions = {}): string {
  const width = opts.width && opts.width > 10 ? opts.width : 80;
  const now = opts.now ?? new Date();
  const out: string[] = [];

  // --- Subject section ---
  out.push('');
  out.push(rule(width));
  out.push('');
  out.push(`  ${ansi.bold(ansi.pink(msg.subject ?? '(no subject)'))}`);
  out.push('');

  // --- Envelope (From / To / Cc / Date / UID) ---
  out.push(rule(width));
  out.push('');
  const fromStr = formatAddressList(msg.from) || '?';
  const toStr = formatAddressList(msg.to) || '?';
  out.push(`  ${ansi.dim('From:')}    ${ansi.cyan(fromStr)}`);
  out.push(`  ${ansi.dim('To:')}      ${toStr}`);
  const ccStr = formatAddressList(msg.cc);
  if (ccStr) out.push(`  ${ansi.dim('Cc:')}      ${ccStr}`);
  const bccStr = formatAddressList(msg.bcc);
  if (bccStr) out.push(`  ${ansi.dim('Bcc:')}     ${bccStr}`);
  if (msg.date != null) {
    out.push(`  ${ansi.dim('Date:')}    ${ansi.magenta(formatEmailDate(msg.date, now))}`);
  }
  if (msg.uid != null) {
    out.push(`  ${ansi.dim('UID:')}     ${msg.uid}`);
  }
  if (msg.inReplyTo) {
    out.push(`  ${ansi.dim('In reply to:')} ${ansi.dim(msg.inReplyTo)}`);
  }
  out.push('');

  // --- Body ---
  out.push(rule(width));
  out.push('');
  let body = msg.text ?? '';
  if (!body && msg.html) body = stripHtmlForTerminal(msg.html);
  if (body) {
    for (const line of body.split('\n')) {
      out.push(`  ${line}`);
    }
  } else {
    out.push(`  ${ansi.dim('(no body content)')}`);
  }
  out.push('');

  // --- Attachments + security flags (optional footer) ---
  const attachments = msg.attachments ?? [];
  const secLines = securityLines(msg);
  if (attachments.length > 0 || secLines.length > 0) {
    out.push(rule(width));
    out.push('');
    for (const att of attachments) {
      const size = typeof att.size === 'number'
        ? ` ${ansi.dim(`(${Math.round(att.size / 1024)}KB)`)}`
        : '';
      const type = att.contentType ? ` ${ansi.dim(att.contentType)}` : '';
      out.push(`  ${ansi.yellow('📎')} ${att.filename ?? '(unnamed)'}${type}${size}`);
    }
    if (attachments.length > 0 && secLines.length > 0) out.push('');
    for (const line of secLines) out.push(line);
    out.push('');
  }

  // --- Closing rule ---
  out.push(rule(width));
  out.push('');

  return out.join('\n');
}
