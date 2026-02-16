/**
 * AgenticMail Interactive Shell
 *
 * Clean REPL with /slash commands. No ANSI cursor tricks —
 * just a simple readline loop with boxed prompt styling.
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { SetupConfig } from '@agenticmail/core';

// --- Colors ---

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// Rotating dot colors for email list items
const dotColors = [
  (s: string) => `\x1b[35m${s}\x1b[0m`,   // magenta
  (s: string) => `\x1b[36m${s}\x1b[0m`,   // cyan
  (s: string) => `\x1b[33m${s}\x1b[0m`,   // yellow
  (s: string) => `\x1b[34m${s}\x1b[0m`,   // blue
  (s: string) => `\x1b[32m${s}\x1b[0m`,   // green
  (s: string) => `\x1b[91m${s}\x1b[0m`,   // bright red
  (s: string) => `\x1b[95m${s}\x1b[0m`,   // bright magenta
  (s: string) => `\x1b[92m${s}\x1b[0m`,   // bright green
  (s: string) => `\x1b[93m${s}\x1b[0m`,   // bright yellow
  (s: string) => `\x1b[94m${s}\x1b[0m`,   // bright blue
];

// --- Layout ---

function tw(): number { return process.stdout.columns || 80; }
function hr(): string { return c.dim('─'.repeat(tw())); }
function boxTop(): string { return c.dim('╭' + '─'.repeat(Math.max(0, tw() - 2)) + '╮'); }
function boxBot(): string { return c.dim('╰' + '─'.repeat(Math.max(0, tw() - 2)) + '╯'); }

function log(msg: string) { console.log(msg); }
function ok(msg: string) { log(`  ${c.green('✓')} ${msg}`); }
function fail(msg: string) { log(`  ${c.red('✗')} ${msg}`); }
function info(msg: string) { log(`  ${c.dim(msg)}`); }

/** Extract a useful error message, including the cause if present */
/** Clean a file path from drag-and-drop or paste: strip quotes, unescape spaces */
function cleanFilePath(raw: string): string {
  let p = raw.trim();
  // Strip surrounding single or double quotes (macOS drag-and-drop)
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  // Unescape backslash-space sequences (terminal escaping)
  p = p.replace(/\\ /g, ' ');
  // Expand ~ to home dir
  if (p.startsWith('~/')) {
    p = p.replace('~', process.env.HOME || '');
  }
  return p;
}

function errMsg(err: unknown): string {
  const e = err as Error & { cause?: Error };
  const msg = e?.message || String(err);
  if (e?.cause?.message && e.cause.message !== msg) {
    return `${msg} (${e.cause.message})`;
  }
  return msg;
}

// --- Date parsing for /schedule ---

/** Common timezone abbreviation → IANA timezone mapping */
const TZ_ABBREVS: Record<string, string> = {
  EST: 'America/New_York', EDT: 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  GMT: 'Europe/London', BST: 'Europe/London',
  UTC: 'UTC',
  CET: 'Europe/Paris', CEST: 'Europe/Paris',
  IST: 'Asia/Kolkata',
  JST: 'Asia/Tokyo',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
  WAT: 'Africa/Lagos',
  EAT: 'Africa/Nairobi',
  SAST: 'Africa/Johannesburg',
  HKT: 'Asia/Hong_Kong',
  SGT: 'Asia/Singapore',
  KST: 'Asia/Seoul',
  HST: 'Pacific/Honolulu',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  AST: 'America/Halifax', ADT: 'America/Halifax',
  NST: 'America/St_Johns', NDT: 'America/St_Johns',
};

/**
 * Parse a user-friendly date string like "02-14-2026 3:30 PM EST"
 * into a Date object. Also accepts ISO 8601 as fallback.
 */
function parseScheduleDate(input: string, defaultTz: string): Date | null {
  // Try ISO 8601 first (e.g. 2026-02-14T10:00:00)
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime()) && input.includes('-') && (input.includes('T') || input.includes('t'))) {
    return isoDate;
  }

  // Try MM-DD-YYYY H:MM AM/PM [TZ]
  const match = input.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\s*(.+)?$/,
  );
  if (!match) return null;

  const [, monthStr, dayStr, yearStr, hourStr, minStr, ampmRaw, tzRaw] = match;
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const year = parseInt(yearStr, 10);
  let hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);
  const ampm = ampmRaw.toUpperCase();

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 1 || hour > 12) return null;

  // Convert 12-hour to 24-hour
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  // Resolve timezone
  const tzInput = tzRaw?.trim().toUpperCase() || '';
  let tz = defaultTz;
  if (tzInput) {
    // Check abbreviation map
    if (TZ_ABBREVS[tzInput]) {
      tz = TZ_ABBREVS[tzInput];
    } else {
      // Try as IANA timezone directly
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tzInput });
        tz = tzInput;
      } catch {
        // Try the raw input from the user (case-sensitive IANA)
        const rawTz = tzRaw?.trim();
        if (rawTz) {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: rawTz });
            tz = rawTz;
          } catch {
            // Fall back to default timezone
          }
        }
      }
    }
  }

  // Build date string and convert using the timezone
  // We construct the date by finding the UTC offset for the target timezone
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;

  // Use a two-pass approach: create the date in UTC, then adjust for timezone offset
  const tempDate = new Date(dateStr + 'Z'); // treat as UTC first
  // Find offset for the target timezone at that moment
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  // Get what time it would be in the target TZ if we treat our dateStr as UTC
  // Then calculate the offset
  const parts = formatter.formatToParts(tempDate);
  const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  const tzYear = getPart('year');
  const tzMonth = getPart('month');
  const tzDay = getPart('day');
  const tzHour = getPart('hour') === 24 ? 0 : getPart('hour');
  const tzMin = getPart('minute');

  // Calculate approximate offset in minutes
  const utcMs = Date.UTC(tempDate.getUTCFullYear(), tempDate.getUTCMonth(), tempDate.getUTCDate(), tempDate.getUTCHours(), tempDate.getUTCMinutes());
  const tzMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin);
  const offsetMs = tzMs - utcMs;

  // The actual date in UTC = our desired local time - timezone offset
  const resultMs = tempDate.getTime() - offsetMs;
  const result = new Date(resultMs);

  return isNaN(result.getTime()) ? null : result;
}

// --- Shell entry ---

export interface ShellOptions {
  config: SetupConfig;
  onExit: () => void;
}

export async function interactiveShell(options: ShellOptions): Promise<void> {
  const { config, onExit } = options;
  const apiBase = `http://${config.api.host}:${config.api.port}`;

  const apiFetch = async (path: string, opts?: RequestInit) => {
    return fetch(`${apiBase}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${config.masterKey}`,
        'Content-Type': 'application/json',
        ...(opts?.headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  };

  // --- Welcome banner ---

  let agentLine = '';
  let emailLine = '';

  try {
    const resp = await apiFetch('/api/agenticmail/accounts');
    if (resp.ok) {
      const data = await resp.json() as any;
      const agents = data.agents || data || [];
      if (agents.length > 0) {
        agentLine = agents.map((a: any) => c.cyan(a.name)).join(', ');
      }
    }
  } catch { /* ignore */ }

  try {
    const gw = await apiFetch('/api/agenticmail/gateway/status');
    if (gw.ok) {
      const data = await gw.json() as any;
      if (data.mode === 'relay' && data.relay) {
        emailLine = `${c.green(data.relay.email)} ${c.dim('via ' + data.relay.provider)}`;
      } else if (data.mode === 'domain' && data.domain) {
        emailLine = c.green(data.domain.domain);
      }
    }
  } catch { /* ignore */ }

  log('');
  log(hr());
  log('');
  log(`  ${c.bold('AgenticMail')} ${c.dim('is running')}`);
  log(`  ${c.dim('Server:')} ${c.cyan(`http://${config.api.host}:${config.api.port}`)}`);
  if (agentLine) log(`  ${c.dim('Agents:')} ${agentLine}`);
  if (emailLine) log(`  ${c.dim('Email:')}  ${emailLine}`);
  log('');
  log('');
  log(`  ${c.dim('Type')} ${c.bold('/help')} ${c.dim('for commands, or')} ${c.bold('/exit')} ${c.dim('to stop.')}`);

  // --- Readline ---

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  /** Sentinel string returned by question() when user presses Escape or types "back" */
  const BACK = '\x00__BACK__';

  /**
   * Ask a sub-question using the existing readline instance.
   * Returns BACK sentinel if user presses Escape or types "back".
   */
  function question(prompt: string): Promise<string> {
    return new Promise(resolve => {
      let resolved = false;

      // Intercept Escape key during this question
      const onKeypress = (_ch: string, key: any) => {
        if (key && key.name === 'escape' && !resolved) {
          resolved = true;
          process.stdin.removeListener('keypress', onKeypress);
          // Clear the current line
          (rl as any).line = '';
          (rl as any).cursor = 0;
          rl.write('\n');
          resolve(BACK);
        }
      };
      process.stdin.on('keypress', onKeypress);

      rl.question(prompt, answer => {
        if (resolved) return; // Already resolved via Escape
        resolved = true;
        process.stdin.removeListener('keypress', onKeypress);
        if (answer.trim().toLowerCase() === 'back') {
          resolve(BACK);
        } else {
          resolve(answer);
        }
      });
    });
  }

  /** Check if a question result is a back/escape action */
  function isBack(val: string): boolean {
    return val === BACK;
  }

  // --- Helpers ---

  /** Make an API request using an agent's API key (for requireAgent routes) */
  async function agentFetch(apiKey: string, path: string, opts?: RequestInit) {
    const url = `${apiBase}${path}`;
    try {
      return await fetch(url, {
        ...opts,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(opts?.headers || {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const cause = (err as any)?.cause?.message || '';
      throw new Error(`Request to ${url} failed${cause ? ': ' + cause : ''}`, { cause: err as Error });
    }
  }

  /** Currently selected agent — persists across commands */
  let currentAgent: { apiKey: string; name: string; email: string } | null = null;

  /** Whether inbox shows body previews (persists across /inbox calls) */
  let inboxPreviews = true;

  /** Fetch all agents from the API */
  async function fetchAllAgents(): Promise<{ apiKey: string; name: string; email: string }[]> {
    const resp = await apiFetch('/api/agenticmail/accounts');
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    const agents = data.agents || data || [];
    return agents.map((a: any) => ({ apiKey: a.apiKey, name: a.name, email: a.email || `${a.name}@localhost` }));
  }

  /**
   * Get the active agent. If none is selected yet, auto-selects:
   * - If only 1 agent exists, use it silently
   * - If multiple exist, prompt the user to pick one
   */
  async function getActiveAgent(): Promise<{ apiKey: string; name: string; email: string } | null> {
    // Return cached selection if still valid
    if (currentAgent) return currentAgent;

    try {
      const agents = await fetchAllAgents();
      if (agents.length === 0) { info('No agents yet. Run /setup to create one.'); log(''); return null; }

      if (agents.length === 1) {
        currentAgent = agents[0];
        return currentAgent;
      }

      // Multiple agents — prompt to pick (up to 3 attempts)
      log(`  ${c.bold('Select agent')} ${c.dim('(Esc to cancel)')}`);
      for (let i = 0; i < agents.length; i++) {
        log(`  ${c.green(`[${i + 1}]`)} ${c.cyan(agents[i].name)}  ${c.dim(agents[i].email)}`);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const choice = await question(`  ${c.dim('#:')} `);
        if (isBack(choice)) { log(''); return null; }
        const idx = parseInt(choice) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < agents.length) {
          currentAgent = agents[idx];
          ok(`Switched to ${c.cyan(currentAgent.name)}`);
          log('');
          return currentAgent;
        }
        const remaining = 2 - attempt;
        if (remaining > 0) {
          fail(`Invalid selection. Enter 1-${agents.length}. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
        } else {
          fail('Too many invalid attempts.');
        }
      }
      log('');
      return null;
    } catch (err) {
      fail(`Error: ${errMsg(err)}`); log(''); return null;
    }
  }

  // Backwards compat alias
  const getFirstAgent = getActiveAgent;

  /**
   * Ask for a positive integer with up to 3 retries.
   * Returns the number, or null if user escapes or fails all attempts.
   */
  async function askNumber(prompt: string, { min = 1 }: { min?: number } = {}): Promise<number | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = await question(prompt);
      if (isBack(input)) return null;
      const num = parseInt(input.trim(), 10);
      if (!isNaN(num) && num >= min) return num;
      const remaining = 2 - attempt;
      if (remaining > 0) {
        fail(`Invalid number. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
      } else {
        fail('Too many invalid attempts.');
      }
    }
    return null;
  }

  /**
   * Ask for a numbered choice from a list with up to 3 retries.
   * Returns the 0-based index, or null if user escapes or fails all attempts.
   */
  async function askChoice(prompt: string, maxItems: number): Promise<number | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = await question(prompt);
      if (isBack(input)) return null;
      const idx = parseInt(input.trim(), 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < maxItems) return idx;
      const remaining = 2 - attempt;
      if (remaining > 0) {
        fail(`Invalid selection. Enter 1-${maxItems}. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
      } else {
        fail('Too many invalid attempts.');
      }
    }
    return null;
  }

  /** Render a full email message to the console */
  function renderEmailMessage(msg: any): void {
    log('');
    log(hr());
    log('');
    log(`  ${c.bold(msg.subject || '(no subject)')}`);
    log('');
    const fromStr = (msg.from || []).map((a: any) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '?';
    const toStr = (msg.to || []).map((a: any) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '?';
    log(`  ${c.dim('From:')}    ${c.cyan(fromStr)}`);
    log(`  ${c.dim('To:')}      ${toStr}`);
    if (msg.date) log(`  ${c.dim('Date:')}    ${new Date(msg.date).toLocaleString()}`);
    if (msg.cc && msg.cc.length > 0) {
      const ccStr = msg.cc.map((a: any) => a.address).join(', ');
      log(`  ${c.dim('CC:')}      ${ccStr}`);
    }
    log('');
    log(hr());
    log('');
    const body = msg.text || msg.html?.replace(/<[^>]*>/g, '') || '';
    if (body) {
      for (const line of body.split('\n')) { log(`  ${line}`); }
    } else {
      info('(no body content)');
    }
    if (msg.attachments && msg.attachments.length > 0) {
      log('');
      log(`  ${c.dim('Attachments:')}`);
      for (const att of msg.attachments) {
        const size = att.size ? ` ${c.dim(`(${Math.round(att.size / 1024)}KB)`)}` : '';
        log(`    ${c.yellow('📎')} ${att.filename}${size}`);
      }
    }
    log('');
  }

  async function showInboxPreview(apiKey: string, agentName: string): Promise<void> {
    try {
      const resp = await agentFetch(apiKey, '/api/agenticmail/mail/inbox?limit=20&offset=0');
      if (!resp.ok) return;
      const data = await resp.json() as any;
      const messages = data.messages || [];
      const total = data.total ?? messages.length;
      log('');
      log(`  ${c.bold('Inbox')} ${c.dim('─')} ${c.cyan(agentName)}  ${c.dim(`(${total} message${total !== 1 ? 's' : ''})`)}`);
      log(`  ${c.dim('─'.repeat(40))}`);
      log('');
      if (messages.length === 0) { info('Inbox is empty'); return; }
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const fromAddr = msg.from?.[0] || {};
        const from = fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : (fromAddr.address || msg.from || '?');
        const date = msg.date ? new Date(msg.date).toLocaleString() : '';
        const dot = dotColors[i % dotColors.length]('●');
        log(`  ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
        log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
        log('');
      }
    } catch { /* preview is best-effort */ }
  }

  /** Render a paginated folder listing (Sent, Drafts, Junk, etc.) */
  async function showFolderListing(apiKey: string, agentName: string, folder: string, label: string): Promise<void> {
    const PAGE_SIZE = 10;
    let page = 0;

    const fetchPage = async (offset: number) => {
      const resp = await agentFetch(apiKey, `/api/agenticmail/mail/folders/${encodeURIComponent(folder)}?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${errText.slice(0, 80)}`);
      }
      return await resp.json() as any;
    };

    const renderPage = (messages: any[], total: number, currentPage: number) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      log('');
      log(`  ${c.bold(label)} ${c.dim('─')} ${c.cyan(agentName)}  ${c.dim(`(${total} message${total !== 1 ? 's' : ''})`)}`);
      log(`  ${c.dim('─'.repeat(40))}`);
      log('');

      if (messages.length === 0) {
        info('No messages on this page');
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const addr = folder.toLowerCase().includes('sent')
            ? (msg.to?.[0] || {})
            : (msg.from?.[0] || {});
          const who = addr.name ? `${addr.name} <${addr.address}>` : (addr.address || '?');
          const date = msg.date ? new Date(msg.date).toLocaleString() : '';
          const dot = dotColors[(currentPage * PAGE_SIZE + i) % dotColors.length]('●');
          log(`  ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
          log(`  ${' '.repeat(8)} ${c.dim(folder.toLowerCase().includes('sent') ? 'To: ' : '')}${c.dim(who)}  ${c.dim(date)}`);
          log('');
        }
      }

      log(`  ${c.dim('─'.repeat(40))}`);
      const pageLabel = `Page ${currentPage + 1}/${totalPages}`;
      const nav: string[] = [];
      if (currentPage > 0) nav.push(`${c.bold('[←]')} prev`);
      if (currentPage < totalPages - 1) nav.push(`${c.bold('[→]')} next`);
      nav.push(`${c.bold('[Esc]')} back`);
      log(`  ${c.dim(pageLabel)}  ${c.dim('─')}  ${nav.join('  ')}`);
      info(`Use ${c.bold('/read')} to view a message by its # number.`);
      log('');
    };

    try {
      const data = await fetchPage(0);
      const messages = data.messages || [];
      const total = data.total ?? messages.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

      if (total === 0) {
        log('');
        log(`  ${c.bold(label)} ${c.dim('─')} ${c.cyan(agentName)}`);
        log('');
        info(`No messages in ${folder}`);
        log('');
        return;
      }

      if (totalPages <= 1) {
        renderPage(messages, total, 0);
        return;
      }

      // Interactive pagination
      renderPage(messages, total, page);

      await new Promise<void>((resolve) => {
        const onKey = async (_s: string, key: any) => {
          if (!key) return;
          let newPage = page;
          if ((key.name === 'right' || key.name === 'n') && page < totalPages - 1) {
            newPage = page + 1;
          } else if ((key.name === 'left' || key.name === 'p') && page > 0) {
            newPage = page - 1;
          } else if (key.name === 'escape') {
            (rl as any)._ttyWrite = folderPagTtyWrite;
            resolve();
            return;
          } else {
            return;
          }

          if (newPage !== page) {
            page = newPage;
            try {
              const pageData = await fetchPage(page * PAGE_SIZE);
              process.stdout.write('\x1b[2J\x1b[H');
              renderPage(pageData.messages || [], total, page);
            } catch (err) {
              fail(`Error: ${errMsg(err)}`);
            }
          }
        };

        const folderPagTtyWrite = (rl as any)._ttyWrite;
        (rl as any)._ttyWrite = function (_s: string, key: any) {
          onKey(_s, key);
        };
      });
    } catch (err) {
      fail(`Could not fetch ${folder}: ${errMsg(err)}`);
      log('');
    }
  }

  // --- Commands ---

  const commands: Record<string, { desc: string; run: () => Promise<void> }> = {
    help: {
      desc: 'Show available commands',
      run: async () => {
        log('');
        log(`  ${c.bold('Commands')}`);
        log(`  ${c.dim('─'.repeat(40))}`);
        for (const [name, cmd] of Object.entries(commands)) {
          if (name === 'quit') continue;
          log(`  ${c.green(('/' + name).padEnd(16))} ${c.dim(cmd.desc)}`);
        }
        log('');
      },
    },

    status: {
      desc: 'Show server and email status',
      run: async () => {
        log('');
        try {
          const health = await apiFetch('/api/agenticmail/health');
          if (health.ok) {
            ok(`Server ${c.dim('─')} ${c.green('running')} at ${c.cyan(apiBase)}`);
          } else {
            fail(`Server ${c.dim('─')} error`);
          }
        } catch {
          fail(`Server ${c.dim('─')} not responding`);
        }

        try {
          const gw = await apiFetch('/api/agenticmail/gateway/status');
          if (gw.ok) {
            const data = await gw.json() as any;
            if (data.mode === 'relay' && data.relay) {
              ok(`Email  ${c.dim('─')} ${c.bold(data.relay.provider)} relay via ${c.cyan(data.relay.email)}${data.relay.polling ? c.dim(' (polling)') : ''}`);
            } else if (data.mode === 'domain' && data.domain) {
              ok(`Email  ${c.dim('─')} custom domain ${c.bold(data.domain.domain)}`);
            } else {
              fail(`Email  ${c.dim('─')} not connected`);
            }
          }
        } catch { /* ignore */ }
        log('');
      },
    },

    agents: {
      desc: 'List agents or create a new one',
      run: async () => {
        log('');
        try {
          const resp = await apiFetch('/api/agenticmail/accounts');
          if (!resp.ok) { fail('Could not fetch agents'); log(''); return; }
          const data = await resp.json() as any;
          const agents = data.agents || data || [];
          if (agents.length === 0) {
            info('No agents yet.');
          } else {
            for (const agent of agents) {
              const owner = agent.metadata?.ownerName;
              const displayName = owner ? `${agent.name} from ${owner}` : agent.name;
              const active = currentAgent?.name === agent.name ? c.green(' ◂ active') : '';
              log(`  ${c.cyan(displayName.padEnd(24))} ${c.dim(agent.email || '')}${active}`);
              log(`  ${' '.repeat(24)} ${c.dim('key:')} ${c.yellow(agent.apiKey?.slice(0, 16) + '...')}`);
              log('');
            }
            if (agents.length > 1) {
              info('Use /switch to change active agent');
            }
          }
          log('');
          log(`  ${c.green('[1]')} Create new agent`);
          log(`  ${c.green('[2]')} Back`);
          log('');
          const choice = await question(`  ${c.dim('>')}: `);
          if (isBack(choice) || choice.trim() === '2') { log(''); return; }
          if (choice.trim() !== '1') { log(''); return; }

          // Create new agent flow
          log('');
          const nameInput = await question(`  ${c.cyan('Agent name:')} `);
          if (isBack(nameInput) || !nameInput.trim()) { log(''); return; }
          const agentName = nameInput.trim();

          log('');
          log(`  ${c.bold('Role')}`);
          log(`  ${c.green('[1]')} secretary ${c.dim('(default)')}`);
          log(`  ${c.green('[2]')} assistant`);
          log(`  ${c.green('[3]')} researcher`);
          log(`  ${c.green('[4]')} writer`);
          log(`  ${c.green('[5]')} custom`);
          log('');
          const roleChoice = await question(`  ${c.dim('>')}: `);
          if (isBack(roleChoice)) { log(''); return; }
          const roles = ['secretary', 'assistant', 'researcher', 'writer', 'custom'];
          const roleIdx = parseInt(roleChoice.trim()) - 1;
          const role = (roleIdx >= 0 && roleIdx < roles.length) ? roles[roleIdx] : 'secretary';

          log('');
          info('Creating agent...');
          const createResp = await apiFetch('/api/agenticmail/accounts', {
            method: 'POST',
            body: JSON.stringify({ name: agentName, role }),
            signal: AbortSignal.timeout(15_000),
          });

          if (!createResp.ok) {
            const text = await createResp.text();
            let parsed: any = {};
            try { parsed = JSON.parse(text); } catch {}
            fail(parsed.error || text);
            log('');
            return;
          }

          const created = await createResp.json() as any;
          ok(`Agent ${c.bold('"' + created.name + '"')} created!`);
          log(`    ${c.dim('Email:')} ${c.cyan(created.email || created.subAddress || '')}`);
          log(`    ${c.dim('Key:')}   ${c.yellow(created.apiKey)}`);
          log(`    ${c.dim('Role:')}  ${role}`);
          currentAgent = { name: created.name, email: created.email || created.subAddress, apiKey: created.apiKey };
          ok(`Switched to ${c.bold(created.name)}`);
          log('');
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
      },
    },

    deleteagent: {
      desc: 'Delete an agent (archives emails + generates report)',
      run: async () => {
        log('');
        try {
          const resp = await apiFetch('/api/agenticmail/accounts');
          if (!resp.ok) { fail('Could not fetch agents'); log(''); return; }
          const data = await resp.json() as any;
          const agents = data.agents || data || [];
          if (agents.length === 0) { info('No agents to delete.'); log(''); return; }

          if (agents.length <= 1) {
            fail('Cannot delete the last agent. At least one agent must remain.');
            log('');
            return;
          }

          log(`  ${c.bold('Delete agent')} ${c.dim('(Esc to cancel)')}`);
          for (let i = 0; i < agents.length; i++) {
            log(`  ${c.green(`[${i + 1}]`)} ${c.cyan(agents[i].name)}  ${c.dim(agents[i].email || '')}`);
          }
          let agent: any = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const choice = await question(`  ${c.dim('#:')} `);
            if (isBack(choice)) { log(''); return; }
            const idx = parseInt(choice) - 1;
            if (!isNaN(idx) && idx >= 0 && idx < agents.length) { agent = agents[idx]; break; }
            const remaining = 2 - attempt;
            if (remaining > 0) {
              fail(`Invalid selection. Enter 1-${agents.length}. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
            } else {
              fail('Too many invalid attempts. Cancelled.');
            }
          }
          if (!agent) { log(''); return; }

          log('');
          log(`  ${c.red('WARNING: This will permanently delete agent')} ${c.cyan(agent.name)} ${c.dim(`(${agent.email})`)}`);
          log(`  ${c.dim('All emails will be archived to a report before deletion.')}`);
          log('');

          let confirmed = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const confirm = await question(`  ${c.red('Type the agent name to confirm deletion (Esc to cancel):')} `);
            if (isBack(confirm)) { log(''); return; }
            if (confirm.trim() === agent.name) { confirmed = true; break; }
            const remaining = 2 - attempt;
            if (remaining > 0) {
              fail(`Name doesn't match. Expected "${agent.name}". ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
            } else {
              fail('Too many failed attempts. Cancelled.');
            }
          }
          if (!confirmed) { log(''); return; }

          info('Archiving emails and generating deletion report...');
          const delResp = await apiFetch(
            `/api/agenticmail/accounts/${agent.id}?archive=true&reason=user-requested&deletedBy=shell`,
            { method: 'DELETE' },
          );

          if (delResp.ok) {
            const report = await delResp.json() as any;
            ok(`Deleted ${c.cyan(agent.name)}`);
            log('');

            // Display summary
            if (report.summary) {
              const s = report.summary;
              log(`  ${c.bold('Deletion Report')} ${c.dim(report.id)}`);
              log(`  ${c.dim('Total emails archived:')} ${c.yellow(String(s.totalEmails))}`);
              if (s.inboxCount > 0) log(`    ${c.dim('Inbox:')} ${s.inboxCount}`);
              if (s.sentCount > 0) log(`    ${c.dim('Sent:')} ${s.sentCount}`);
              if (s.otherCount > 0) log(`    ${c.dim('Other:')} ${s.otherCount}`);
              if (s.folders?.length > 0) log(`    ${c.dim('Folders:')} ${s.folders.join(', ')}`);
              if (s.firstEmailDate) log(`    ${c.dim('Date range:')} ${s.firstEmailDate.slice(0, 10)} → ${s.lastEmailDate?.slice(0, 10) ?? '?'}`);
              if (s.topCorrespondents?.length > 0) {
                log(`    ${c.dim('Top contacts:')}`);
                for (const tc of s.topCorrespondents.slice(0, 5)) {
                  log(`      ${c.dim('•')} ${tc.address} ${c.dim(`(${tc.count})`)}`);
                }
              }
            }

            // Show file path
            if (report.id) {
              log('');
              info(`Report saved to database (ID: ${report.id})`);
              info('Use /deletions to view past reports');
            }

            if (currentAgent?.name === agent.name) {
              currentAgent = null;
            }
          } else {
            const errBody = await delResp.text().catch(() => '');
            fail(`Delete failed: ${delResp.status} ${errBody}`);
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    deletions: {
      desc: 'View past agent deletion reports',
      run: async () => {
        log('');
        try {
          const resp = await apiFetch('/api/agenticmail/accounts/deletions');
          if (!resp.ok) { fail(`Could not fetch deletions: ${resp.status}`); log(''); return; }
          const data = await resp.json() as any;
          const deletions = data.deletions || [];

          if (deletions.length === 0) {
            info('No deletion reports found.');
            log('');
            return;
          }

          log(`  ${c.bold('Agent Deletion Reports')} ${c.dim(`(${deletions.length})`)}`);
          log('');
          for (let i = 0; i < deletions.length; i++) {
            const d = deletions[i];
            const date = d.deletedAt ? new Date(d.deletedAt).toLocaleString() : '?';
            log(`  ${c.green(`[${i + 1}]`)} ${c.cyan(d.agentName)} ${c.dim(`(${d.agentEmail})`)}`);
            log(`      ${c.dim('Deleted:')} ${date}  ${c.dim('Emails:')} ${c.yellow(String(d.emailCount))}  ${c.dim('By:')} ${d.deletedBy || '?'}`);
            if (d.reason) log(`      ${c.dim('Reason:')} ${d.reason}`);
            if (d.filePath) log(`      ${c.dim('File:')} ${d.filePath}`);
          }
          log('');
          info('Enter a number to view full report (Esc/Enter to go back)');
          const choice = await question(`  ${c.dim('#:')} `);
          if (isBack(choice)) { log(''); return; }
          const idx = parseInt(choice) - 1;
          if (isNaN(idx) || idx < 0 || idx >= deletions.length) {
            log('');
            return;
          }

          const reportResp = await apiFetch(`/api/agenticmail/accounts/deletions/${encodeURIComponent(deletions[idx].id)}`);
          if (!reportResp.ok) { fail('Could not fetch report'); log(''); return; }
          const report = await reportResp.json() as any;

          log('');
          log(`  ${c.bold('Full Report:')} ${c.cyan(report.agent?.name || '?')}`);
          log(`  ${c.dim('ID:')} ${report.id}`);
          log(`  ${c.dim('Agent:')} ${report.agent?.name} (${report.agent?.email})`);
          log(`  ${c.dim('Role:')} ${report.agent?.role || '?'}`);
          log(`  ${c.dim('Created:')} ${report.agent?.createdAt || '?'}`);
          log(`  ${c.dim('Deleted:')} ${report.deletedAt}`);
          log(`  ${c.dim('Deleted by:')} ${report.deletedBy}`);
          if (report.reason) log(`  ${c.dim('Reason:')} ${report.reason}`);

          if (report.summary) {
            const s = report.summary;
            log('');
            log(`  ${c.bold('Email Summary')}`);
            log(`  ${c.dim('Total:')} ${s.totalEmails}  ${c.dim('Inbox:')} ${s.inboxCount}  ${c.dim('Sent:')} ${s.sentCount}  ${c.dim('Other:')} ${s.otherCount}`);
            if (s.folders?.length > 0) log(`  ${c.dim('Folders:')} ${s.folders.join(', ')}`);
            if (s.firstEmailDate) log(`  ${c.dim('Date range:')} ${s.firstEmailDate.slice(0, 10)} → ${s.lastEmailDate?.slice(0, 10) ?? '?'}`);
            if (s.topCorrespondents?.length > 0) {
              log(`  ${c.dim('Top contacts:')}`);
              for (const tc of s.topCorrespondents) {
                log(`    ${c.dim('•')} ${tc.address} ${c.dim(`(${tc.count} messages)`)}`);
              }
            }
          }

          // Show email subjects preview
          const emails = report.emails;
          if (emails) {
            const allEmails = [...(emails.inbox || []), ...(emails.sent || [])];
            for (const [, msgs] of Object.entries(emails.other || {})) {
              for (const msg of (msgs as any[])) allEmails.push(msg);
            }
            if (allEmails.length > 0) {
              log('');
              log(`  ${c.bold('Archived Emails')} ${c.dim(`(${allEmails.length})`)}`);
              for (const email of allEmails.slice(0, 20)) {
                const from = (email as any).from || '?';
                const subj = (email as any).subject || '(no subject)';
                const date = (email as any).date ? new Date((email as any).date).toLocaleDateString() : '';
                log(`    ${c.dim('•')} ${c.cyan(subj)} ${c.dim(`from ${from} ${date}`)}`);
              }
              if (allEmails.length > 20) {
                log(`    ${c.dim(`... and ${allEmails.length - 20} more`)}`);
              }
            }
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    switch: {
      desc: 'Switch active agent',
      run: async () => {
        log('');
        try {
          const agents = await fetchAllAgents();
          if (agents.length === 0) { info('No agents yet. Run /setup to create one.'); log(''); return; }
          if (agents.length === 1) { info(`Only one agent: ${c.cyan(agents[0].name)}`); currentAgent = agents[0]; log(''); return; }

          log(`  ${c.bold('Switch agent')} ${c.dim('(Esc to cancel)')}`);
          for (let i = 0; i < agents.length; i++) {
            const active = currentAgent?.name === agents[i].name ? c.green(' ◂') : '';
            log(`  ${c.green(`[${i + 1}]`)} ${c.cyan(agents[i].name)}  ${c.dim(agents[i].email)}${active}`);
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            const choice = await question(`  ${c.dim('#:')} `);
            if (isBack(choice)) { log(''); return; }
            const idx = parseInt(choice) - 1;
            if (!isNaN(idx) && idx >= 0 && idx < agents.length) {
              currentAgent = agents[idx];
              ok(`Active agent: ${c.cyan(currentAgent.name)} ${c.dim(`(${currentAgent.email})`)}`);
              log('');
              return;
            }
            const remaining = 2 - attempt;
            if (remaining > 0) {
              fail(`Invalid selection. Enter 1-${agents.length}. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
            } else {
              fail('Too many invalid attempts.');
              log('');
            }
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
          log('');
        }
      },
    },

    name: {
      desc: 'Set your name (shown in From: "Agent from YourName")',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        // Show current owner name if set
        try {
          const meResp = await agentFetch(agent.apiKey, '/api/agenticmail/accounts/me');
          if (meResp.ok) {
            const me = await meResp.json() as any;
            const current = me.metadata?.ownerName;
            if (current) {
              info(`Current: ${c.bold(`${agent.name} from ${current}`)}`);
            } else {
              info(`Currently: ${c.bold(agent.name)} ${c.dim('(no owner name set)')}`);
            }
          }
        } catch { /* ignore */ }

        const ownerName = await question(`  ${c.dim('Your name:')} `);
        if (isBack(ownerName) || !ownerName.trim()) { info('Cancelled'); log(''); return; }

        try {
          const resp = await agentFetch(agent.apiKey, '/api/agenticmail/accounts/me', {
            method: 'PATCH',
            body: JSON.stringify({ metadata: { ownerName: ownerName.trim() } }),
          });
          if (resp.ok) {
            ok(`Emails will show: ${c.bold(`${agent.name} from ${ownerName.trim()}`)}`);
          } else {
            fail('Could not update name');
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    inbox: {
      desc: 'Check an agent\'s inbox',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        const { apiKey, name: agentName } = agent;

        const PAGE_SIZE = 10;
        let page = 0;
        let selected = 0; // cursor index within current page
        let currentMessages: any[] = [];

        const fetchPage = async (offset: number) => {
          // Use digest endpoint when previews are on (includes body preview)
          const endpoint = inboxPreviews
            ? `/api/agenticmail/mail/digest?limit=${PAGE_SIZE}&offset=${offset}&previewLength=120`
            : `/api/agenticmail/mail/inbox?limit=${PAGE_SIZE}&offset=${offset}`;
          const resp = await agentFetch(apiKey, endpoint);
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`${resp.status} ${errText.slice(0, 80)}`);
          }
          return await resp.json() as any;
        };

        const renderPage = (messages: any[], total: number, currentPage: number) => {
          currentMessages = messages;
          const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
          log('');
          const previewTag = inboxPreviews ? c.dim(' [previews on]') : '';
          log(`  ${c.bold('Inbox')} ${c.dim('─')} ${c.cyan(agentName!)}  ${c.dim(`(${total} message${total !== 1 ? 's' : ''})`)}${previewTag}`);
          log(`  ${c.dim('─'.repeat(50))}`);
          log('');

          if (messages.length === 0) {
            info('No messages on this page');
          } else {
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              const fromAddr = msg.from?.[0] || {};
              const from = fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : (fromAddr.address || msg.from || '?');
              const date = msg.date ? new Date(msg.date).toLocaleString() : '';
              const flags = msg.flags || [];
              const unread = !flags.includes('\\Seen');
              const isSelected = i === selected;
              const pointer = isSelected ? c.green(' ❯') : '  ';
              const dot = dotColors[(currentPage * PAGE_SIZE + i) % dotColors.length]('●');
              const subj = unread
                ? c.bold((msg.subject || '(no subject)').slice(0, 48))
                : (msg.subject || '(no subject)').slice(0, 48);
              log(`${pointer} ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${subj}${unread ? c.cyan(' ★') : ''}`);
              log(`     ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
              if (inboxPreviews && msg.preview) {
                const preview = msg.preview.replace(/\s+/g, ' ').trim().slice(0, 80);
                log(`     ${' '.repeat(8)} ${c.dim(preview + (msg.preview.length > 80 ? '...' : ''))}`);
              }
              log('');
            }
          }

          // Navigation bar
          log(`  ${c.dim('─'.repeat(50))}`);
          const pageLabel = `Page ${currentPage + 1}/${totalPages}`;
          const nav: string[] = [];
          if (currentPage > 0) nav.push(`${c.bold('[←]')} prev`);
          if (currentPage < totalPages - 1) nav.push(`${c.bold('[→]')} next`);
          nav.push(`${c.bold('[↑↓]')} select`);
          nav.push(`${c.bold('[Enter]')} read`);
          nav.push(`${c.bold('[v]')} ${inboxPreviews ? 'hide' : 'show'} previews`);
          nav.push(`${c.bold('[Esc]')} back`);
          log(`  ${c.dim(pageLabel)}  ${c.dim('─')}  ${nav.join('  ')}`);
          log('');
        };

        try {
          const data = await fetchPage(0);
          const messages = data.messages || [];
          const total = data.total ?? messages.length;
          const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

          if (total === 0) {
            log('');
            log(`  ${c.bold('Inbox')} ${c.dim('─')} ${c.cyan(agentName!)}`);
            log('');
            info('Inbox is empty');
            log('');
            return;
          }

          selected = 0;
          renderPage(messages, total, page);

          // Interactive mode: pagination + arrow key selection + Enter to read
          await new Promise<void>((resolve) => {
            let busy = false; // prevent concurrent key handling

            const onKey = async (_s: string, key: any) => {
              if (!key || busy) return;

              if (key.name === 'escape') {
                (rl as any)._ttyWrite = inboxTtyWrite;
                resolve();
                return;
              }

              busy = true;
              try {
                if (key.name === 'up' && selected > 0) {
                  selected--;
                  process.stdout.write('\x1b[2J\x1b[H');
                  renderPage(currentMessages, total, page);
                } else if (key.name === 'down' && selected < currentMessages.length - 1) {
                  selected++;
                  process.stdout.write('\x1b[2J\x1b[H');
                  renderPage(currentMessages, total, page);
                } else if ((key.name === 'right' || key.name === 'n') && page < totalPages - 1) {
                  page++;
                  selected = 0;
                  const pageData = await fetchPage(page * PAGE_SIZE);
                  process.stdout.write('\x1b[2J\x1b[H');
                  renderPage(pageData.messages || [], total, page);
                } else if ((key.name === 'left' || key.name === 'p') && page > 0) {
                  page--;
                  selected = 0;
                  const pageData = await fetchPage(page * PAGE_SIZE);
                  process.stdout.write('\x1b[2J\x1b[H');
                  renderPage(pageData.messages || [], total, page);
                } else if (key.name === 'return' && currentMessages.length > 0) {
                  // Open selected email
                  const msg = currentMessages[selected];
                  if (msg?.uid) {
                    const resp = await agentFetch(apiKey, `/api/agenticmail/mail/messages/${msg.uid}`);
                    if (resp.ok) {
                      const full = await resp.json() as any;
                      process.stdout.write('\x1b[2J\x1b[H');
                      renderEmailMessage(full);
                      log(`  ${c.dim('Press any key to return to inbox...')}`);
                      // Wait for any key
                      await new Promise<void>((r) => {
                        const waitWrite = (rl as any)._ttyWrite;
                        (rl as any)._ttyWrite = function () {
                          (rl as any)._ttyWrite = waitWrite;
                          r();
                        };
                      });
                      // Re-render inbox
                      process.stdout.write('\x1b[2J\x1b[H');
                      const pageData = await fetchPage(page * PAGE_SIZE);
                      renderPage(pageData.messages || [], total, page);
                    } else {
                      fail('Could not load message');
                    }
                  }
                } else if (_s === 'v' || _s === 'V') {
                  // Toggle previews
                  inboxPreviews = !inboxPreviews;
                  const pageData = await fetchPage(page * PAGE_SIZE);
                  process.stdout.write('\x1b[2J\x1b[H');
                  renderPage(pageData.messages || [], total, page);
                }
              } catch (err) {
                fail(`Error: ${errMsg(err)}`);
              }
              busy = false;
            };

            const inboxTtyWrite = (rl as any)._ttyWrite;
            (rl as any)._ttyWrite = function (s: string, key: any) {
              onKey(s, key);
            };
          });
        } catch (err) {
          fail(`Could not fetch inbox: ${errMsg(err)}`);
          log('');
        }
      },
    },

    sent: {
      desc: 'View sent emails',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        await showFolderListing(agent.apiKey, agent.name, 'Sent Items', 'Sent');
      },
    },

    send: {
      desc: 'Send an email as an agent',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        const { apiKey, name: agentName } = agent;

        log('');
        log(`  ${c.bold('Send Email')} ${c.dim('as')} ${c.cyan(agentName)}`);
        log(`  ${c.dim('─'.repeat(40))}`);
        log('');

        const to = await question(`  ${c.dim('To:')}      `);
        if (isBack(to)) { log(''); return; }
        const subject = await question(`  ${c.dim('Subject:')} `);
        if (isBack(subject)) { log(''); return; }
        const body = await question(`  ${c.dim('Message:')} `);
        if (isBack(body)) { log(''); return; }
        if (!to.trim()) { fail('No recipient specified'); log(''); return; }

        // Build attachments array — keep asking until user enters empty
        const attachments: { filename: string; content: string; encoding: string }[] = [];
        while (true) {
          const prompt = attachments.length === 0
            ? `  ${c.dim('📎 Drop a file here or paste path (or press Enter to skip):')}`
            : `  ${c.dim('📎 Another file (or press Enter to send):')}`;
          const attachPath = await question(`${prompt} `);
          if (isBack(attachPath) || !attachPath.trim()) break;
          const p = cleanFilePath(attachPath);
          if (!existsSync(p)) { fail(`File not found: ${p}`); continue; }
          const content = readFileSync(p);
          attachments.push({ filename: basename(p), content: content.toString('base64'), encoding: 'base64' });
          ok(`Attached: ${basename(p)} (${Math.round(content.length / 1024)}KB)`);
        }

        log('');
        info('Sending...');

        try {
          const resp = await agentFetch(apiKey, '/api/agenticmail/mail/send', {
            method: 'POST',
            body: JSON.stringify({
              to: to.trim(), subject, text: body,
              ...(attachments.length > 0 ? { attachments } : {}),
            }),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            ok(`Sent to ${c.cyan(to.trim())} ${c.dim(data.messageId || '')}`);
          } else {
            const errText = await resp.text();
            fail(`Failed: ${errText.slice(0, 100)}`);
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    read: {
      desc: 'Read an email by # number',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        const uid = await askNumber(`  ${c.dim('Message #:')} `);
        if (!uid) { log(''); return; }

        log('');
        info('Loading...');

        try {
          const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}`);
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            fail(`Could not read message: ${resp.status} ${errText.slice(0, 80)}`);
            log('');
            return;
          }
          const msg = await resp.json() as any;
          renderEmailMessage(msg);
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
          log('');
        }
      },
    },

    save: {
      desc: 'Save attachment(s) from an email',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        const uid = await askNumber(`  ${c.dim('Message #:')} `);
        if (!uid) { log(''); return; }

        info('Loading...');
        try {
          const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}`);
          if (!resp.ok) {
            fail(`Could not read message: ${resp.status}`);
            log(''); return;
          }
          const msg = await resp.json() as any;
          const atts = msg.attachments || [];
          if (atts.length === 0) {
            info('No attachments on this message.');
            log(''); return;
          }

          log('');
          log(`  ${c.bold('Attachments')} ${c.dim('(Esc to cancel)')}`);
          log('');
          for (let i = 0; i < atts.length; i++) {
            const a = atts[i];
            const size = a.size ? `${Math.round(a.size / 1024)}KB` : '?';
            log(`  ${c.cyan(`[${i + 1}]`)} ${a.filename} ${c.dim(`(${a.contentType || '?'}, ${size})`)}`);
          }
          if (atts.length > 1) {
            log(`  ${c.cyan(`[a]`)} Save all`);
          }
          log('');

          let indices: number[] = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            const choice = await question(`  ${c.dim('Save #:')} `);
            if (isBack(choice)) { log(''); return; }
            const trimmed = choice.trim().toLowerCase();
            if (!trimmed) { info('Cancelled'); log(''); return; }
            if (trimmed === 'a' || trimmed === 'all') {
              for (let i = 0; i < atts.length; i++) indices.push(i);
              break;
            }
            const idx = parseInt(trimmed, 10) - 1;
            if (!isNaN(idx) && idx >= 0 && idx < atts.length) {
              indices.push(idx);
              break;
            }
            const remaining = 2 - attempt;
            if (remaining > 0) {
              fail(`Invalid selection. Enter 1-${atts.length} or 'a'. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`);
            } else {
              fail('Too many invalid attempts.'); log(''); return;
            }
          }

          for (const idx of indices) {
            const att = atts[idx];
            try {
              const dlResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/attachments/${idx}`);
              if (!dlResp.ok) {
                fail(`Could not download "${att.filename}": ${dlResp.status}`);
                continue;
              }
              const buf = Buffer.from(await dlResp.arrayBuffer());
              const safeName = att.filename.replace(/[/\\]/g, '_');
              writeFileSync(safeName, buf);
              ok(`Saved ${c.bold(safeName)} (${buf.length} bytes)`);
            } catch (err) {
              fail(`Error saving "${att.filename}": ${errMsg(err)}`);
            }
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    delete: {
      desc: 'Delete an email by # number',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        const { apiKey, name: agentName } = agent;

        // Show inbox so user can see the message numbers
        await showInboxPreview(apiKey, agentName);

        const uid = await askNumber(`  ${c.dim('Message # to delete:')} `);
        if (!uid) { log(''); return; }

        const confirm = await question(`  ${c.yellow('Delete message #' + uid + '?')} ${c.dim('(y/N/Esc):')} `);
        if (isBack(confirm) || confirm.trim().toLowerCase() !== 'y') { info('Cancelled'); log(''); return; }

        try {
          const resp = await agentFetch(apiKey, `/api/agenticmail/mail/messages/${uid}`, { method: 'DELETE' });
          if (resp.ok || resp.status === 204) {
            ok(`Deleted message #${uid}`);
          } else {
            const errText = await resp.text().catch(() => '');
            fail(`Could not delete: ${resp.status} ${errText.slice(0, 80)}`);
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    search: {
      desc: 'Search emails by keyword',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Search')}  ${c.dim('[1] Local inbox  [2] Connected account (Gmail/Outlook)  (Esc to cancel)')}`);
        const where = await question(`  ${c.dim('Where:')} `);
        if (isBack(where)) { log(''); return; }
        const searchRelay = where.trim() === '2';

        const keyword = await question(`  ${c.dim('Search:')} `);
        if (isBack(keyword)) { log(''); return; }
        if (!keyword.trim()) { fail('No search term entered'); log(''); return; }

        log('');
        info(searchRelay ? 'Searching connected account...' : 'Searching local inbox...');

        try {
          const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/search', {
            method: 'POST',
            body: JSON.stringify({ text: keyword.trim(), searchRelay }),
          });
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            fail(`Search failed: ${resp.status} ${errText.slice(0, 80)}`);
            log('');
            return;
          }
          const data = await resp.json() as any;
          const uids = data.uids || [];
          const relayResults = data.relayResults || [];

          // Show local results
          if (uids.length > 0) {
            log('');
            log(`  ${c.bold('Local Inbox')} ${c.dim('─')} ${uids.length} match${uids.length !== 1 ? 'es' : ''} for "${c.cyan(keyword.trim())}"`);
            log(`  ${c.dim('─'.repeat(40))}`);
            log('');

            const show = uids.slice(0, 10);
            for (let i = 0; i < show.length; i++) {
              try {
                const msgResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${show[i]}`);
                if (!msgResp.ok) continue;
                const msg = await msgResp.json() as any;
                const fromAddr = msg.from?.[0] || {};
                const from = fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : (fromAddr.address || '?');
                const date = msg.date ? new Date(msg.date).toLocaleString() : '';
                const dot = dotColors[i % dotColors.length]('●');
                log(`  ${dot} ${c.dim('#' + String(show[i]).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
                log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
                log('');
              } catch { /* skip failed fetches */ }
            }
            if (uids.length > 10) {
              info(`... and ${uids.length - 10} more results`);
            }
            info(`Use ${c.bold('/read')} to view a message by its # number.`);
          }

          // Show relay results with import option
          if (relayResults.length > 0) {
            log('');
            log(`  ${c.bold('Connected Account')} ${c.dim('─')} ${c.cyan(relayResults[0].account || '?')} ${c.dim(`(${relayResults.length} match${relayResults.length !== 1 ? 'es' : ''})`)}`);
            log(`  ${c.dim('─'.repeat(40))}`);
            log('');

            const showRelay = relayResults.slice(0, 15);
            for (let i = 0; i < showRelay.length; i++) {
              const r = showRelay[i];
              const fromAddr = r.from?.[0] || {};
              const from = fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : (fromAddr.address || '?');
              const date = r.date ? new Date(r.date).toLocaleString() : '';
              const dot = dotColors[i % dotColors.length]('●');
              log(`  ${dot} ${c.dim(`[${i + 1}]`)} ${c.bold((r.subject || '(no subject)').slice(0, 48))}`);
              log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
              log('');
            }
            if (relayResults.length > 15) {
              info(`... and ${relayResults.length - 15} more results`);
            }

            // Offer to import
            log(`  ${c.dim('Import an email to your local inbox to continue its thread.')}`);
            const importChoice = await question(`  ${c.dim('Import # (or Enter/Esc to skip):')} `);
            if (isBack(importChoice)) { log(''); return; }
            const importIdx = parseInt(importChoice.trim(), 10) - 1;
            if (importIdx >= 0 && importIdx < showRelay.length) {
              const relayUid = showRelay[importIdx].uid;
              info('Importing...');
              try {
                const importResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/import-relay', {
                  method: 'POST',
                  body: JSON.stringify({ uid: relayUid }),
                });
                if (importResp.ok) {
                  ok(`Imported! Check your inbox with ${c.bold('/inbox')} and use ${c.bold('/reply')} to continue the thread.`);
                } else {
                  const errText = await importResp.text().catch(() => '');
                  fail(`Import failed: ${errText.slice(0, 80)}`);
                }
              } catch (err) {
                fail(`Error: ${errMsg(err)}`);
              }
            }
          }

          if (uids.length === 0 && relayResults.length === 0) {
            log('');
            info(`No results for "${keyword.trim()}"${!searchRelay ? '. Try option [2] to search your connected account.' : ''}`);
          }
          log('');
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
          log('');
        }
      },
    },

    reply: {
      desc: 'Reply to an email',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        // Show inbox for reference
        await showInboxPreview(agent.apiKey, agent.name);

        const uid = await askNumber(`  ${c.dim('Reply to #:')} `);
        if (!uid) { log(''); return; }

        info('Loading original...');
        try {
          const origResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}`);
          if (!origResp.ok) { fail('Could not load original message'); log(''); return; }
          const orig = await origResp.json() as any;

          const replyTo = orig.replyTo?.[0]?.address || orig.from?.[0]?.address;
          if (!replyTo) { fail('Original email has no sender address'); log(''); return; }
          const subject = (orig.subject ?? '').startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`;
          log(`  ${c.dim('To:')}      ${c.cyan(replyTo)}`);
          log(`  ${c.dim('Subject:')} ${subject}`);
          log('');

          const body = await question(`  ${c.dim('Reply:')}   `);
          if (isBack(body) || !body.trim()) { info('Cancelled'); log(''); return; }

          // Attachments
          const attachments: { filename: string; content: string; encoding: string }[] = [];
          while (true) {
            const prompt = attachments.length === 0
              ? `  ${c.dim('📎 Drop a file here or paste path (or press Enter to skip):')}`
              : `  ${c.dim('📎 Another file (or press Enter to send):')}`;
            const attachPath = await question(`${prompt} `);
            if (isBack(attachPath) || !attachPath.trim()) break;
            const ap = cleanFilePath(attachPath);
            if (!existsSync(ap)) { fail(`File not found: ${ap}`); continue; }
            const content = readFileSync(ap);
            attachments.push({ filename: basename(ap), content: content.toString('base64'), encoding: 'base64' });
            ok(`Attached: ${basename(ap)} (${Math.round(content.length / 1024)}KB)`);
          }

          const refs = Array.isArray(orig.references) ? [...orig.references] : [];
          if (orig.messageId) refs.push(orig.messageId);
          const quoted = (orig.text || '').split('\n').map((l: string) => `> ${l}`).join('\n');
          const fullText = `${body}\n\nOn ${new Date(orig.date).toLocaleString()}, ${replyTo} wrote:\n${quoted}`;

          info('Sending...');
          const sendResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/send', {
            method: 'POST',
            body: JSON.stringify({
              to: replyTo, subject, text: fullText, inReplyTo: orig.messageId, references: refs,
              ...(attachments.length > 0 ? { attachments } : {}),
            }),
          });
          if (sendResp.ok) {
            const data = await sendResp.json() as any;
            ok(`Reply sent to ${c.cyan(replyTo)} ${c.dim(data.messageId || '')}`);
          } else {
            fail(`Failed: ${await sendResp.text().catch(() => '')}`);
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    forward: {
      desc: 'Forward an email',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        await showInboxPreview(agent.apiKey, agent.name);

        const uid = await askNumber(`  ${c.dim('Forward #:')} `);
        if (!uid) { log(''); return; }

        info('Loading...');
        try {
          const origResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}`);
          if (!origResp.ok) { fail('Could not load message'); log(''); return; }
          const orig = await origResp.json() as any;

          const to = await question(`  ${c.dim('Forward to:')} `);
          if (isBack(to) || !to.trim()) { info('Cancelled'); log(''); return; }

          const addMsg = await question(`  ${c.dim('Message (optional):')} `);
          if (isBack(addMsg)) { log(''); return; }

          // Attachments
          const attachments: { filename: string; content: string; encoding: string }[] = [];
          while (true) {
            const prompt = attachments.length === 0
              ? `  ${c.dim('📎 Drop a file here or paste path (or press Enter to skip):')}`
              : `  ${c.dim('📎 Another file (or press Enter to send):')}`;
            const attachPath = await question(`${prompt} `);
            if (isBack(attachPath) || !attachPath.trim()) break;
            const ap = cleanFilePath(attachPath);
            if (!existsSync(ap)) { fail(`File not found: ${ap}`); continue; }
            const content = readFileSync(ap);
            attachments.push({ filename: basename(ap), content: content.toString('base64'), encoding: 'base64' });
            ok(`Attached: ${basename(ap)} (${Math.round(content.length / 1024)}KB)`);
          }

          const subject = (orig.subject ?? '').startsWith('Fwd:') ? orig.subject : `Fwd: ${orig.subject}`;
          const origFrom = orig.from?.[0]?.address ?? 'unknown';
          const origTo = (orig.to || []).map((a: any) => a.address).join(', ');
          const fwdBody = `${addMsg ? addMsg + '\n\n' : ''}---------- Forwarded message ----------\nFrom: ${origFrom}\nTo: ${origTo}\nDate: ${new Date(orig.date).toLocaleString()}\nSubject: ${orig.subject}\n\n${orig.text || ''}`;

          info('Sending...');
          const sendResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/send', {
            method: 'POST',
            body: JSON.stringify({
              to: to.trim(), subject, text: fwdBody,
              ...(attachments.length > 0 ? { attachments } : {}),
            }),
          });
          if (sendResp.ok) {
            ok(`Forwarded to ${c.cyan(to.trim())}`);
          } else {
            fail(`Failed: ${await sendResp.text().catch(() => '')}`);
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    folders: {
      desc: 'Manage mail folders',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Folders')}  ${c.dim('[1] List  [2] Create  [3] Browse  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'list') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/folders');
            if (!resp.ok) { fail('Could not list folders'); log(''); return; }
            const { folders } = await resp.json() as any;
            if (!folders?.length) { info('No folders found'); } else {
              for (const f of folders) {
                const special = f.specialUse ? c.dim(` (${f.specialUse})`) : '';
                log(`  ${c.cyan('📁')} ${f.path}${special}`);
              }
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'create') {
            const name = await question(`  ${c.dim('Folder name:')} `);
            if (isBack(name) || !name.trim()) { info('Cancelled'); log(''); return; }
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/folders', {
              method: 'POST',
              body: JSON.stringify({ name: name.trim() }),
            });
            if (resp.ok) { ok(`Created folder "${name.trim()}"`); } else { fail('Could not create folder'); }
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'browse') {
            // List folders first so user can pick one
            const listResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/folders');
            if (!listResp.ok) { fail('Could not list folders'); log(''); return; }
            const { folders } = await listResp.json() as any;
            if (!folders?.length) { info('No folders'); log(''); return; }
            for (let i = 0; i < folders.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.cyan(folders[i].path)}`);
            }
            const idx = await askChoice(`  ${c.dim('Folder #:')} `, folders.length);
            if (idx === null) { log(''); return; }
            const folderPath = folders[idx].path;

            info(`Loading ${folderPath}...`);
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/folders/${encodeURIComponent(folderPath)}?limit=15&offset=0`);
            if (!resp.ok) { fail('Could not browse folder'); log(''); return; }
            const data = await resp.json() as any;
            const messages = data.messages || [];
            log('');
            log(`  ${c.bold(folderPath)} ${c.dim(`(${messages.length} shown)`)}`);
            log(`  ${c.dim('─'.repeat(40))}`);
            log('');
            if (messages.length === 0) { info('Folder is empty'); } else {
              for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                const fromAddr = msg.from?.[0] || {};
                const from = fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : (fromAddr.address || '?');
                const date = msg.date ? new Date(msg.date).toLocaleString() : '';
                const dot = dotColors[i % dotColors.length]('●');
                log(`  ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
                log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
                log('');
              }
            }
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    trash: {
      desc: 'Move email to Trash',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        await showInboxPreview(agent.apiKey, agent.name);
        const uid = await askNumber(`  ${c.dim('Move to Trash #:')} `);
        if (!uid) { log(''); return; }
        try {
          const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/move`, {
            method: 'POST',
            body: JSON.stringify({ from: 'INBOX', to: 'Trash' }),
          });
          if (resp.ok) { ok(`Moved #${uid} to Trash`); } else { fail('Could not move message'); }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    archive: {
      desc: 'Move email to Archive',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        await showInboxPreview(agent.apiKey, agent.name);
        const uid = await askNumber(`  ${c.dim('Archive #:')} `);
        if (!uid) { log(''); return; }
        try {
          const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/move`, {
            method: 'POST',
            body: JSON.stringify({ from: 'INBOX', to: 'Archive' }),
          });
          if (resp.ok) { ok(`Archived #${uid}`); } else { fail('Could not archive message'); }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    unread: {
      desc: 'Mark email as unread',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        const uid = await askNumber(`  ${c.dim('Mark unread #:')} `);
        if (!uid) { log(''); return; }
        try {
          const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/unseen`, { method: 'POST' });
          if (resp.ok) { ok(`Marked #${uid} as unread`); } else { fail('Could not mark as unread'); }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    thread: {
      desc: 'View email conversation thread',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;
        const uid = await askNumber(`  ${c.dim('Thread for #:')} `);
        if (!uid) { log(''); return; }

        info('Loading thread...');
        try {
          // Fetch the anchor message
          const origResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}`);
          if (!origResp.ok) { fail('Could not load message'); log(''); return; }
          const orig = await origResp.json() as any;

          // Search for related messages by subject (strip Re:/Fwd: prefixes)
          const baseSubject = (orig.subject || '').replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
          const searchResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/search', {
            method: 'POST',
            body: JSON.stringify({ subject: baseSubject }),
          });
          if (!searchResp.ok) { fail('Search failed'); log(''); return; }
          const { uids: threadUids } = await searchResp.json() as any;

          log('');
          log(`  ${c.bold('Thread')} ${c.dim('─')} "${baseSubject}" ${c.dim(`(${threadUids?.length || 1} messages)`)}`);
          log(`  ${c.dim('─'.repeat(40))}`);
          log('');

          // Show each message in the thread
          const show = (threadUids || [uid]).slice(0, 20);
          for (let i = 0; i < show.length; i++) {
            try {
              const msgResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${show[i]}`);
              if (!msgResp.ok) continue;
              const msg = await msgResp.json() as any;
              const from = msg.from?.[0]?.address ?? '?';
              const date = msg.date ? new Date(msg.date).toLocaleString() : '';
              const dot = dotColors[i % dotColors.length]('●');
              log(`  ${dot} ${c.bold(from)} ${c.dim(date)}`);
              // Show first 3 lines of body
              const body = (msg.text || '').split('\n').filter((l: string) => !l.startsWith('>')).slice(0, 3);
              for (const line of body) {
                log(`    ${c.dim(line.slice(0, 70))}`);
              }
              log('');
            } catch { /* skip */ }
          }
        } catch (err) {
          fail(`Error: ${errMsg(err)}`);
        }
        log('');
      },
    },

    contacts: {
      desc: 'Manage contacts',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Contacts')}  ${c.dim('[1] List  [2] Add  [3] Delete  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'list') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/contacts');
            if (!resp.ok) { fail('Could not fetch contacts'); log(''); return; }
            const { contacts } = await resp.json() as any;
            if (!contacts?.length) { info('No contacts yet'); } else {
              for (const ct of contacts) {
                log(`  ${c.cyan(ct.email)} ${ct.name ? c.dim(ct.name) : ''} ${c.dim(`[${ct.id.slice(0, 8)}]`)}`);
              }
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'add') {
            const email = await question(`  ${c.dim('Email:')} `);
            if (isBack(email) || !email.trim()) { info('Cancelled'); log(''); return; }
            const name = await question(`  ${c.dim('Name (optional):')} `);
            if (isBack(name)) { log(''); return; }
            await agentFetch(agent.apiKey, '/api/agenticmail/contacts', {
              method: 'POST', body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined }),
            });
            ok(`Added ${email.trim()}`);
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'delete') {
            const id = await question(`  ${c.dim('Contact ID:')} `);
            if (isBack(id) || !id.trim()) { info('Cancelled'); log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/contacts/${id.trim()}`, { method: 'DELETE' });
            ok('Deleted');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    drafts: {
      desc: 'Manage email drafts',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Drafts')}  ${c.dim('[1] List saved  [2] New  [3] Send  [4] Delete  [5] Browse mail drafts  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/drafts');
            const { drafts } = await resp.json() as any;
            if (!drafts?.length) { info('No saved drafts'); } else {
              for (const d of drafts) {
                log(`  ${c.dim(d.id.slice(0, 8))} To: ${d.to_addr || '?'} | ${d.subject || '(no subject)'}`);
              }
            }
          } else if (choice.trim() === '5') {
            await showFolderListing(agent.apiKey, agent.name, 'Drafts', 'Drafts');
            return; // showFolderListing handles its own output
          } else if (choice.trim() === '2') {
            const to = await question(`  ${c.dim('To:')} `);
            if (isBack(to)) { log(''); return; }
            const subject = await question(`  ${c.dim('Subject:')} `);
            if (isBack(subject)) { log(''); return; }
            const text = await question(`  ${c.dim('Body:')} `);
            if (isBack(text)) { log(''); return; }
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/drafts', {
              method: 'POST', body: JSON.stringify({ to: to.trim(), subject, text }),
            });
            const data = await resp.json() as any;
            ok(`Draft saved: ${data.id?.slice(0, 8)}`);
          } else if (choice.trim() === '3') {
            const id = await question(`  ${c.dim('Draft ID:')} `);
            if (isBack(id)) { log(''); return; }
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/drafts/${id.trim()}/send`, { method: 'POST' });
            if (resp.ok) { ok('Draft sent!'); } else { fail('Could not send draft'); }
          } else if (choice.trim() === '4') {
            const id = await question(`  ${c.dim('Draft ID:')} `);
            if (isBack(id)) { log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/drafts/${id.trim()}`, { method: 'DELETE' });
            ok('Draft deleted');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    signature: {
      desc: 'Manage email signatures',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Signatures')}  ${c.dim('[1] List  [2] Create  [3] Delete  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/signatures');
            const { signatures } = await resp.json() as any;
            if (!signatures?.length) { info('No signatures'); } else {
              for (const s of signatures) {
                log(`  ${s.is_default ? c.green('★') : c.dim('○')} ${c.bold(s.name)} ${c.dim(`[${s.id.slice(0, 8)}]`)}`);
                if (s.text_content) log(`    ${c.dim(s.text_content.slice(0, 60))}`);
              }
            }
          } else if (choice.trim() === '2') {
            const name = await question(`  ${c.dim('Name:')} `);
            if (isBack(name)) { log(''); return; }
            const text = await question(`  ${c.dim('Signature text:')} `);
            if (isBack(text)) { log(''); return; }
            const defStr = await question(`  ${c.dim('Set as default? (y/N):')} `);
            if (isBack(defStr)) { log(''); return; }
            await agentFetch(agent.apiKey, '/api/agenticmail/signatures', {
              method: 'POST', body: JSON.stringify({ name: name.trim(), text: text.trim(), isDefault: defStr.trim().toLowerCase() === 'y' }),
            });
            ok(`Signature "${name.trim()}" created`);
          } else if (choice.trim() === '3') {
            const id = await question(`  ${c.dim('Signature ID:')} `);
            if (isBack(id)) { log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/signatures/${id.trim()}`, { method: 'DELETE' });
            ok('Signature deleted');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    templates: {
      desc: 'Manage email templates',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Templates')}  ${c.dim('[1] List  [2] Create  [3] Use  [4] Delete  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/templates');
            const { templates } = await resp.json() as any;
            if (!templates?.length) { info('No templates'); } else {
              for (const t of templates) {
                log(`  ${c.cyan(t.name)} ${c.dim(`| ${t.subject || '(no subject)'}`)} ${c.dim(`[${t.id.slice(0, 8)}]`)}`);
              }
            }
          } else if (choice.trim() === '2') {
            const name = await question(`  ${c.dim('Template name:')} `);
            if (isBack(name)) { log(''); return; }
            const subject = await question(`  ${c.dim('Subject:')} `);
            if (isBack(subject)) { log(''); return; }
            const text = await question(`  ${c.dim('Body:')} `);
            if (isBack(text)) { log(''); return; }
            await agentFetch(agent.apiKey, '/api/agenticmail/templates', {
              method: 'POST', body: JSON.stringify({ name: name.trim(), subject, text }),
            });
            ok(`Template "${name.trim()}" created`);
          } else if (choice.trim() === '3') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/templates');
            const { templates } = await resp.json() as any;
            if (!templates?.length) { info('No templates available'); log(''); return; }
            for (const t of templates) {
              log(`  ${c.cyan(t.name)} ${c.dim(`| ${t.subject || '(no subject)'}`)}`);
            }
            const name = await question(`  ${c.dim('Template name:')} `);
            if (isBack(name)) { log(''); return; }
            const tmpl = templates.find((t: any) => t.name === name.trim());
            if (!tmpl) { fail('Template not found'); log(''); return; }
            const to = await question(`  ${c.dim('To:')} `);
            if (isBack(to) || !to.trim()) { info('Cancelled'); log(''); return; }
            info('Sending...');
            const sendResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/send', {
              method: 'POST',
              body: JSON.stringify({ to: to.trim(), subject: tmpl.subject, text: tmpl.text_body }),
            });
            if (sendResp.ok) { ok(`Sent using template "${name.trim()}"`); } else { fail('Send failed'); }
          } else if (choice.trim() === '4') {
            const id = await question(`  ${c.dim('Template ID:')} `);
            if (isBack(id)) { log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/templates/${id.trim()}`, { method: 'DELETE' });
            ok('Template deleted');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    schedule: {
      desc: 'Schedule an email for later',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Schedule Email')} ${c.dim('as')} ${c.cyan(agent.name)}`);
        log(`  ${c.dim('─'.repeat(40))}`);
        log('');

        // Show existing scheduled emails
        try {
          const listResp = await agentFetch(agent.apiKey, '/api/agenticmail/scheduled');
          if (listResp.ok) {
            const { scheduled } = await listResp.json() as any;
            const pending = (scheduled || []).filter((s: any) => s.status === 'pending');
            if (pending.length > 0) {
              log(`  ${c.dim('Pending:')} ${pending.length} scheduled email${pending.length !== 1 ? 's' : ''}`);
              for (const s of pending.slice(0, 5)) {
                const sendDate = new Date(s.send_at);
                log(`    ${c.dim('•')} To: ${s.to_addr} | "${s.subject}" | ${c.cyan(sendDate.toLocaleString())} ${c.dim(`[${s.id.slice(0, 8)}]`)}`);
              }
              log('');
            }
          }
        } catch { /* ignore */ }

        log(`  ${c.dim('[1] Schedule new  [2] Cancel pending  [3] List all  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        if (choice.trim() === '2') {
          const id = await question(`  ${c.dim('Scheduled ID to cancel:')} `);
          if (isBack(id) || !id.trim()) { info('Cancelled'); log(''); return; }
          try {
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/scheduled/${id.trim()}`, { method: 'DELETE' });
            if (resp.ok) { ok('Scheduled email cancelled'); } else { fail('Could not cancel (may already be sent)'); }
          } catch (err) { fail(`Error: ${errMsg(err)}`); }
          log('');
          return;
        }

        if (choice.trim() === '3') {
          try {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/scheduled');
            if (!resp.ok) { fail('Could not fetch scheduled emails'); log(''); return; }
            const { scheduled } = await resp.json() as any;
            if (!scheduled?.length) { info('No scheduled emails'); log(''); return; }
            log('');
            for (const s of scheduled) {
              const d = new Date(s.send_at);
              const statusIcon = s.status === 'pending' ? c.yellow('⏳') : s.status === 'sent' ? c.green('✓') : c.red('✗');
              log(`  ${statusIcon} To: ${s.to_addr} | "${s.subject}" | ${d.toLocaleString()} ${c.dim(`[${s.status}]`)} ${c.dim(`[${s.id.slice(0, 8)}]`)}`);
            }
          } catch (err) { fail(`Error: ${errMsg(err)}`); }
          log('');
          return;
        }

        // Schedule new email
        const to = await question(`  ${c.dim('To:')}        `);
        if (isBack(to)) { log(''); return; }
        const subject = await question(`  ${c.dim('Subject:')}   `);
        if (isBack(subject)) { log(''); return; }
        const text = await question(`  ${c.dim('Message:')}   `);
        if (isBack(text)) { log(''); return; }

        if (!to.trim()) { fail('Recipient is required'); log(''); return; }

        // Build quick-pick time presets
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzAbbr = new Date().toLocaleString('en-US', { timeZoneName: 'short' }).split(' ').pop() || tz;
        const now = new Date();

        // Build "tomorrow 8am" and "tomorrow 9am" display times
        const tom8 = new Date(now); tom8.setDate(tom8.getDate() + 1); tom8.setHours(8, 0, 0, 0);
        const tom9 = new Date(now); tom9.setDate(tom9.getDate() + 1); tom9.setHours(9, 0, 0, 0);

        const presets = [
          { label: 'In 30 minutes',   value: 'in 30 minutes',   time: new Date(Date.now() + 30 * 60_000) },
          { label: 'In 1 hour',       value: 'in 1 hour',       time: new Date(Date.now() + 60 * 60_000) },
          { label: 'In 3 hours',      value: 'in 3 hours',      time: new Date(Date.now() + 180 * 60_000) },
          { label: 'Tomorrow 8 AM',   value: 'tomorrow 8am',    time: tom8 },
          { label: 'Tomorrow 9 AM',   value: 'tomorrow 9am',    time: tom9 },
        ];

        log('');
        log(`  ${c.bold('Quick pick:')}`);
        for (let i = 0; i < presets.length; i++) {
          const p = presets[i];
          log(`    ${c.cyan(`[${i + 1}]`)} ${p.label}  ${c.dim(`(${p.time.toLocaleString()})`)}`);
        }
        log(`    ${c.cyan('[6]')} Custom date/time`);
        log('');

        const timeChoice = await question(`  ${c.dim('When:')} `);
        if (isBack(timeChoice)) { log(''); return; }
        let sendAtValue: string;

        const presetIdx = parseInt(timeChoice.trim(), 10) - 1;
        if (presetIdx >= 0 && presetIdx < presets.length) {
          sendAtValue = presets[presetIdx].value;
          info(`Sending: ${presets[presetIdx].label} (${presets[presetIdx].time.toLocaleString()})`);
        } else if (timeChoice.trim() === '6' || timeChoice.trim().toLowerCase() === 'custom') {
          // Custom date entry
          const future = new Date(Date.now() + 60 * 60_000);
          const month = String(future.getMonth() + 1).padStart(2, '0');
          const day = String(future.getDate()).padStart(2, '0');
          const year = future.getFullYear();
          const hours12 = future.getHours() % 12 || 12;
          const mins = String(future.getMinutes()).padStart(2, '0');
          const ampm = future.getHours() >= 12 ? 'PM' : 'AM';
          const template = `${month}-${day}-${year} ${hours12}:${mins} ${ampm} ${tzAbbr}`;

          log(`  ${c.dim('Format:')} ${c.bold('MM-DD-YYYY H:MM AM/PM TZ')}`);
          log(`  ${c.dim('Example:')} ${c.cyan(template)}`);
          log(`  ${c.dim('Timezone:')} ${c.cyan(tz)} (${tzAbbr})`);
          log(`  ${c.dim('Also accepts:')} "tomorrow 2pm", "next monday 9am", "tonight"`);
          log('');

          const when = await question(`  ${c.dim('Send at:')}   `);
          if (isBack(when) || !when.trim()) { info('Cancelled'); log(''); return; }

          // Validate locally before sending
          const parsed = parseScheduleDate(when.trim(), tz);
          if (!parsed) {
            fail('Could not parse date. Use format: MM-DD-YYYY H:MM AM/PM TZ');
            log('');
            return;
          }
          if (parsed.getTime() <= Date.now()) {
            fail('Send time must be in the future');
            log('');
            return;
          }
          info(`Will send at: ${c.bold(parsed.toLocaleString())}`);
          sendAtValue = when.trim();
        } else if (timeChoice.trim()) {
          // User typed a freeform time string directly (e.g. "tomorrow 2pm")
          sendAtValue = timeChoice.trim();
        } else {
          fail('No time selected'); log(''); return;
        }

        const confirmSch = await question(`  ${c.dim('Confirm schedule? (Y/n):')} `);
        if (isBack(confirmSch) || confirmSch.trim().toLowerCase() === 'n') { info('Cancelled'); log(''); return; }

        try {
          const resp = await agentFetch(agent.apiKey, '/api/agenticmail/scheduled', {
            method: 'POST',
            body: JSON.stringify({ to: to.trim(), subject, text, sendAt: sendAtValue }),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            ok(`Scheduled for ${new Date(data.sendAt).toLocaleString()}`);
          } else {
            const errText = await resp.text().catch(() => '');
            fail(`Could not schedule: ${errText.slice(0, 80)}`);
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    tag: {
      desc: 'Manage tags and label messages',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Tags')}  ${c.dim('[1] List  [2] Create  [3] Tag message  [4] View by tag  [5] Delete  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'list') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/tags');
            if (!resp.ok) { fail('Could not fetch tags'); log(''); return; }
            const { tags } = await resp.json() as any;
            if (!tags?.length) { info('No tags yet'); } else {
              for (const t of tags) {
                log(`  ${c.bold(t.color || '#888')} ${c.bold(t.name)} ${c.dim(`[${t.id.slice(0, 8)}]`)}`);
              }
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'create') {
            const name = await question(`  ${c.dim('Tag name:')} `);
            if (isBack(name) || !name.trim()) { info('Cancelled'); log(''); return; }
            const color = await question(`  ${c.dim('Color hex (e.g. #ff5500, or press Enter for default):')} `);
            if (isBack(color)) { log(''); return; }
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/tags', {
              method: 'POST',
              body: JSON.stringify({ name: name.trim(), color: color.trim() || undefined }),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              ok(`Created tag "${data.name}" ${c.dim(data.color)}`);
            } else { fail('Could not create tag'); }
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'tag') {
            // Show tags first
            const tagsResp = await agentFetch(agent.apiKey, '/api/agenticmail/tags');
            if (!tagsResp.ok) { fail('Could not fetch tags'); log(''); return; }
            const { tags } = await tagsResp.json() as any;
            if (!tags?.length) { info('No tags yet — create one first with option [2]'); log(''); return; }
            for (let i = 0; i < tags.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold(tags[i].name)} ${c.dim(tags[i].color)}`);
            }
            const tagIdx = await askChoice(`  ${c.dim('Tag #:')} `, tags.length);
            if (tagIdx === null) { log(''); return; }
            const tag = tags[tagIdx];

            // Show inbox for reference
            await showInboxPreview(agent.apiKey, agent.name);

            const uid = await askNumber(`  ${c.dim('Message # to tag:')} `);
            if (!uid) { log(''); return; }

            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/tags/${tag.id}/messages`, {
              method: 'POST',
              body: JSON.stringify({ uid, folder: 'INBOX' }),
            });
            if (resp.ok) { ok(`Tagged #${uid} with "${tag.name}"`); } else { fail('Could not tag message'); }
          } else if (choice.trim() === '4' || choice.trim().toLowerCase() === 'view') {
            // List tags then show messages for selected tag
            const tagsResp = await agentFetch(agent.apiKey, '/api/agenticmail/tags');
            if (!tagsResp.ok) { fail('Could not fetch tags'); log(''); return; }
            const { tags } = await tagsResp.json() as any;
            if (!tags?.length) { info('No tags yet'); log(''); return; }
            for (let i = 0; i < tags.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold(tags[i].name)} ${c.dim(tags[i].color)}`);
            }
            const tagIdx = await askChoice(`  ${c.dim('Tag #:')} `, tags.length);
            if (tagIdx === null) { log(''); return; }
            const tag = tags[tagIdx];

            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/tags/${tag.id}/messages`);
            if (!resp.ok) { fail('Could not fetch tagged messages'); log(''); return; }
            const data = await resp.json() as any;
            const messages = data.messages || [];
            log('');
            log(`  ${c.bold('Tag:')} ${tag.name} ${c.dim(`(${messages.length} message${messages.length !== 1 ? 's' : ''})`)}`);
            log(`  ${c.dim('─'.repeat(40))}`);
            log('');
            if (messages.length === 0) { info('No messages with this tag'); } else {
              for (let i = 0; i < Math.min(messages.length, 15); i++) {
                const m = messages[i];
                try {
                  const msgResp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${m.uid}?folder=${encodeURIComponent(m.folder)}`);
                  if (!msgResp.ok) { log(`  ${c.dim('#' + m.uid)} ${c.dim(`(${m.folder})`)}`); continue; }
                  const msg = await msgResp.json() as any;
                  const from = msg.from?.[0]?.address ?? '?';
                  const dot = dotColors[i % dotColors.length]('●');
                  log(`  ${dot} ${c.dim('#' + String(m.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
                  log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(m.folder)}`);
                  log('');
                } catch {
                  log(`  ${c.dim('#' + m.uid)} ${c.dim(`(${m.folder})`)}`);
                }
              }
              if (messages.length > 15) info(`... and ${messages.length - 15} more`);
            }
          } else if (choice.trim() === '5' || choice.trim().toLowerCase() === 'delete') {
            const tagsResp = await agentFetch(agent.apiKey, '/api/agenticmail/tags');
            if (!tagsResp.ok) { fail('Could not fetch tags'); log(''); return; }
            const { tags } = await tagsResp.json() as any;
            if (!tags?.length) { info('No tags to delete'); log(''); return; }
            for (let i = 0; i < tags.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold(tags[i].name)} ${c.dim(`[${tags[i].id.slice(0, 8)}]`)}`);
            }
            const tagIdx = await askChoice(`  ${c.dim('Tag # to delete:')} `, tags.length);
            if (tagIdx === null) { log(''); return; }
            const confirm = await question(`  ${c.yellow('Delete tag "' + tags[tagIdx].name + '"?')} ${c.dim('(y/N/Esc):')} `);
            if (isBack(confirm) || confirm.trim().toLowerCase() !== 'y') { info('Cancelled'); log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/tags/${tags[tagIdx].id}`, { method: 'DELETE' });
            ok(`Deleted tag "${tags[tagIdx].name}"`);
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    spam: {
      desc: 'View spam folder, report/unreport spam, score emails',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Spam')}  ${c.dim('[1] View spam folder  [2] Report spam  [3] Not spam  [4] Score email  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'view') {
            await showFolderListing(agent.apiKey, agent.name, 'Spam', 'Spam');
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'report') {
            await showInboxPreview(agent.apiKey, agent.name);
            const uid = await askNumber(`  ${c.dim('Message # to report as spam:')} `);
            if (!uid) { log(''); return; }
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/spam`, {
              method: 'POST',
              body: JSON.stringify({ folder: 'INBOX' }),
            });
            if (resp.ok) { ok(`Message #${uid} moved to Spam`); } else { fail('Could not report as spam'); }
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'not') {
            // List spam folder first
            const spamResp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/spam?limit=20');
            if (!spamResp.ok) { fail('Could not fetch spam folder'); log(''); return; }
            const data = await spamResp.json() as any;
            const messages = data.messages || [];
            if (messages.length === 0) { info('Spam folder is empty'); log(''); return; }
            log('');
            log(`  ${c.bold('Spam')} ${c.dim(`(${data.total ?? messages.length} message${(data.total ?? messages.length) !== 1 ? 's' : ''})`)}`);
            log(`  ${c.dim('─'.repeat(40))}`);
            log('');
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              const from = msg.from?.[0]?.address || '?';
              const dot = dotColors[i % dotColors.length]('●');
              log(`  ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
              log(`  ${' '.repeat(8)} ${c.dim(from)}`);
              log('');
            }
            const uid = await askNumber(`  ${c.dim('Message # to mark as not spam:')} `);
            if (!uid) { log(''); return; }
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/not-spam`, { method: 'POST' });
            if (resp.ok) { ok(`Message #${uid} moved back to Inbox`); } else { fail('Could not mark as not-spam'); }
          } else if (choice.trim() === '4' || choice.trim().toLowerCase() === 'score') {
            await showInboxPreview(agent.apiKey, agent.name);
            const uid = await askNumber(`  ${c.dim('Message # to score:')} `);
            if (!uid) { log(''); return; }
            const folder = await question(`  ${c.dim('Folder (Enter for INBOX):')} `);
            if (isBack(folder)) { log(''); return; }
            const f = folder.trim() || 'INBOX';
            const resp = await agentFetch(agent.apiKey, `/api/agenticmail/mail/messages/${uid}/spam-score?folder=${encodeURIComponent(f)}`);
            if (!resp.ok) { fail('Could not score message'); log(''); return; }
            const result = await resp.json() as any;
            log('');
            if (result.internal) {
              info(`Internal email ${c.dim('─')} score: 0 (spam filter skipped)`);
            } else {
              const scoreColor = result.isSpam ? c.red : result.isWarning ? c.yellow : c.green;
              log(`  ${c.bold('Score:')} ${scoreColor(String(result.score))}  ${result.isSpam ? c.red('SPAM') : result.isWarning ? c.yellow('WARNING') : c.green('CLEAN')}`);
              if (result.topCategory) log(`  ${c.bold('Category:')} ${result.topCategory}`);
              if (result.matches?.length) {
                log(`  ${c.bold('Matches:')}`);
                for (const m of result.matches) {
                  log(`    ${c.yellow(`+${m.score}`)} ${m.ruleId} ${c.dim('─')} ${m.description}`);
                }
              }
            }
          } else {
            fail('Invalid choice');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    rules: {
      desc: 'Manage email filtering rules',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        log('');
        log(`  ${c.bold('Rules')}  ${c.dim('[1] List  [2] Create  [3] Delete  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'list') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/rules');
            if (!resp.ok) { fail('Could not fetch rules'); log(''); return; }
            const { rules } = await resp.json() as any;
            if (!rules?.length) { info('No rules configured'); } else {
              log('');
              for (const r of rules) {
                const status = r.enabled ? c.green('ON') : c.red('OFF');
                log(`  ${status} ${c.bold(r.name)} ${c.dim(`[${r.id.slice(0, 8)}]  priority: ${r.priority}`)}`);
                if (r.conditions && Object.keys(r.conditions).length > 0) {
                  log(`       ${c.dim('if')} ${c.cyan(JSON.stringify(r.conditions))}`);
                }
                if (r.actions && Object.keys(r.actions).length > 0) {
                  log(`       ${c.dim('then')} ${c.cyan(JSON.stringify(r.actions))}`);
                }
                log('');
              }
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'create') {
            const name = await question(`  ${c.dim('Rule name:')} `);
            if (isBack(name) || !name.trim()) { info('Cancelled'); log(''); return; }
            log(`  ${c.dim('Conditions — match emails where:')}`);
            const fromMatch = await question(`  ${c.dim('  From contains (or Enter to skip):')} `);
            if (isBack(fromMatch)) { log(''); return; }
            const subjectMatch = await question(`  ${c.dim('  Subject contains (or Enter to skip):')} `);
            if (isBack(subjectMatch)) { log(''); return; }
            const conditions: any = {};
            if (fromMatch.trim()) conditions.from = fromMatch.trim();
            if (subjectMatch.trim()) conditions.subject = subjectMatch.trim();
            if (Object.keys(conditions).length === 0) { fail('At least one condition required'); log(''); return; }

            log(`  ${c.dim('Actions:')}`);
            const moveTo = await question(`  ${c.dim('  Move to folder (or Enter to skip):')} `);
            if (isBack(moveTo)) { log(''); return; }
            const markRead = await question(`  ${c.dim('  Mark as read? (y/N):')} `);
            if (isBack(markRead)) { log(''); return; }
            const deleteMsg = await question(`  ${c.dim('  Delete? (y/N):')} `);
            if (isBack(deleteMsg)) { log(''); return; }

            const actions: any = {};
            if (moveTo.trim()) actions.move_to = moveTo.trim();
            if (markRead.trim().toLowerCase() === 'y') actions.mark_read = true;
            if (deleteMsg.trim().toLowerCase() === 'y') actions.delete = true;
            if (Object.keys(actions).length === 0) { fail('At least one action required'); log(''); return; }

            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/rules', {
              method: 'POST',
              body: JSON.stringify({ name: name.trim(), conditions, actions }),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              ok(`Created rule "${data.name}"`);
            } else { fail('Could not create rule'); }
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'delete') {
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/rules');
            if (!resp.ok) { fail('Could not fetch rules'); log(''); return; }
            const { rules } = await resp.json() as any;
            if (!rules?.length) { info('No rules to delete'); log(''); return; }
            for (let i = 0; i < rules.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold(rules[i].name)} ${c.dim(`[${rules[i].id.slice(0, 8)}]`)}`);
            }
            const idx = await askChoice(`  ${c.dim('Rule # to delete:')} `, rules.length);
            if (idx === null) { log(''); return; }
            const confirm = await question(`  ${c.yellow('Delete rule "' + rules[idx].name + '"?')} ${c.dim('(y/N):')} `);
            if (isBack(confirm) || confirm.trim().toLowerCase() !== 'y') { info('Cancelled'); log(''); return; }
            await agentFetch(agent.apiKey, `/api/agenticmail/rules/${rules[idx].id}`, { method: 'DELETE' });
            ok(`Deleted rule "${rules[idx].name}"`);
          } else {
            fail('Invalid choice');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    pending: {
      desc: 'View and manage blocked outbound emails',
      run: async () => {
        log('');
        log(`  ${c.bold('Pending Emails')}  ${c.dim('[1] List  [2] Approve  [3] Reject  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'list') {
            const resp = await apiFetch('/api/agenticmail/mail/pending');
            if (!resp.ok) { fail('Could not fetch pending emails'); log(''); return; }
            const { pending } = await resp.json() as any;
            if (!pending?.length) { info('No pending emails'); log(''); return; }
            log('');
            for (const p of pending) {
              const statusColor = p.status === 'pending' ? c.yellow : p.status === 'approved' ? c.green : c.red;
              log(`  ${statusColor('●')} ${c.dim(p.id.slice(0, 8))}  ${c.bold((p.subject || '(no subject)').slice(0, 48))}`);
              log(`    ${c.dim('To:')} ${Array.isArray(p.to) ? p.to.join(', ') : p.to}  ${c.dim('Status:')} ${statusColor(p.status)}  ${c.dim(p.createdAt || '')}`);
              if (p.warnings?.length) {
                log(`    ${c.yellow('Warnings:')} ${p.warnings.map((w: any) => w.ruleId || w).join(', ')}`);
              }
              log('');
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'approve') {
            // Show pending list first
            const listResp = await apiFetch('/api/agenticmail/mail/pending');
            if (!listResp.ok) { fail('Could not fetch pending emails'); log(''); return; }
            const { pending } = await listResp.json() as any;
            const pendingOnly = (pending || []).filter((p: any) => p.status === 'pending');
            if (!pendingOnly.length) { info('No pending emails to approve'); log(''); return; }
            for (let i = 0; i < pendingOnly.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold((pendingOnly[i].subject || '(no subject)').slice(0, 48))} → ${pendingOnly[i].to}`);
            }
            const i = await askChoice(`  ${c.dim('# to approve:')} `, pendingOnly.length);
            if (i === null) { log(''); return; }
            const confirm = await question(`  ${c.yellow('Approve and send this email?')} ${c.dim('(y/N):')} `);
            if (isBack(confirm) || confirm.trim().toLowerCase() !== 'y') { info('Cancelled'); log(''); return; }
            const resp = await apiFetch(`/api/agenticmail/mail/pending/${pendingOnly[i].id}/approve`, { method: 'POST' });
            if (resp.ok) { ok('Email approved and sent'); } else {
              const err = await resp.json().catch(() => ({})) as any;
              fail(err.error || 'Could not approve email');
            }
          } else if (choice.trim() === '3' || choice.trim().toLowerCase() === 'reject') {
            const listResp = await apiFetch('/api/agenticmail/mail/pending');
            if (!listResp.ok) { fail('Could not fetch pending emails'); log(''); return; }
            const { pending } = await listResp.json() as any;
            const pendingOnly = (pending || []).filter((p: any) => p.status === 'pending');
            if (!pendingOnly.length) { info('No pending emails to reject'); log(''); return; }
            for (let i = 0; i < pendingOnly.length; i++) {
              log(`  ${c.dim(`[${i + 1}]`)} ${c.bold((pendingOnly[i].subject || '(no subject)').slice(0, 48))} → ${pendingOnly[i].to}`);
            }
            const i = await askChoice(`  ${c.dim('# to reject:')} `, pendingOnly.length);
            if (i === null) { log(''); return; }
            const confirm = await question(`  ${c.red('Reject and discard this email?')} ${c.dim('(y/N):')} `);
            if (isBack(confirm) || confirm.trim().toLowerCase() !== 'y') { info('Cancelled'); log(''); return; }
            const resp = await apiFetch(`/api/agenticmail/mail/pending/${pendingOnly[i].id}/reject`, { method: 'POST' });
            if (resp.ok) { ok('Email rejected and discarded'); } else {
              const err = await resp.json().catch(() => ({})) as any;
              fail(err.error || 'Could not reject email');
            }
          } else {
            fail('Invalid choice');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    digest: {
      desc: 'View inbox digest with message previews',
      run: async () => {
        const agent = await getFirstAgent();
        if (!agent) return;

        try {
          const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/digest?limit=15');
          if (!resp.ok) { fail('Could not fetch digest'); log(''); return; }
          const data = await resp.json() as any;
          const messages = data.messages || [];
          const total = data.total ?? messages.length;
          log('');
          log(`  ${c.bold('Digest')} ${c.dim('─')} ${c.cyan(agent.name)}  ${c.dim(`(${total} message${total !== 1 ? 's' : ''})`)}`);
          log(`  ${c.dim('─'.repeat(50))}`);
          log('');
          if (messages.length === 0) { info('Inbox is empty'); log(''); return; }
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const from = msg.from?.[0]?.name ? `${msg.from[0].name} <${msg.from[0].address}>` : (msg.from?.[0]?.address || '?');
            const date = msg.date ? new Date(msg.date).toLocaleString() : '';
            const flags = msg.flags || [];
            const unread = !flags.includes('\\Seen');
            const dot = dotColors[i % dotColors.length]('●');
            const subj = unread ? c.bold((msg.subject || '(no subject)').slice(0, 50)) : c.dim((msg.subject || '(no subject)').slice(0, 50));
            log(`  ${dot} ${c.dim('#' + String(msg.uid).padEnd(5))} ${subj}${unread ? c.cyan(' ★') : ''}`);
            log(`  ${' '.repeat(8)} ${c.dim(from)}  ${c.dim(date)}`);
            if (msg.preview) {
              const preview = msg.preview.replace(/\s+/g, ' ').trim().slice(0, 80);
              log(`  ${' '.repeat(8)} ${c.dim(preview + (msg.preview.length > 80 ? '...' : ''))}`);
            }
            log('');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    relay: {
      desc: 'Search relay inbox and import messages',
      run: async () => {
        log('');
        // Check if relay is active
        try {
          const gw = await apiFetch('/api/agenticmail/gateway/status');
          if (gw.ok) {
            const data = await gw.json() as any;
            if (data.mode !== 'relay') { fail('Relay gateway not configured'); log(''); return; }
          }
        } catch { fail('Could not check gateway status'); log(''); return; }

        log(`  ${c.bold('Relay')}  ${c.dim('[1] Search  [2] Import message  (Esc to cancel)')}`);
        const choice = await question(`  ${c.dim('Choice:')} `);
        if (isBack(choice)) { log(''); return; }

        try {
          if (choice.trim() === '1' || choice.trim().toLowerCase() === 'search') {
            const from = await question(`  ${c.dim('From (or Enter to skip):')} `);
            if (isBack(from)) { log(''); return; }
            const subject = await question(`  ${c.dim('Subject (or Enter to skip):')} `);
            if (isBack(subject)) { log(''); return; }
            const text = await question(`  ${c.dim('Body text (or Enter to skip):')} `);
            if (isBack(text)) { log(''); return; }

            const criteria: any = {};
            if (from.trim()) criteria.from = from.trim();
            if (subject.trim()) criteria.subject = subject.trim();
            if (text.trim()) criteria.text = text.trim();
            if (Object.keys(criteria).length === 0) { fail('Enter at least one search criterion'); log(''); return; }

            const agent = await getFirstAgent();
            if (!agent) return;
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/search', {
              method: 'POST',
              body: JSON.stringify(criteria),
            });
            if (!resp.ok) { fail('Search failed'); log(''); return; }
            const data = await resp.json() as any;
            const results = data.messages || data.results || [];
            if (!results.length) { info('No messages found'); } else {
              log('');
              for (let i = 0; i < Math.min(results.length, 20); i++) {
                const msg = results[i];
                const msgFrom = msg.from?.[0]?.address || msg.from || '?';
                log(`  ${c.dim('#' + String(msg.uid).padEnd(5))} ${c.bold((msg.subject || '(no subject)').slice(0, 48))}`);
                log(`  ${' '.repeat(8)} ${c.dim(msgFrom)}`);
                log('');
              }
            }
          } else if (choice.trim() === '2' || choice.trim().toLowerCase() === 'import') {
            const uid = await askNumber(`  ${c.dim('Relay message UID to import:')} `);
            if (!uid) { log(''); return; }
            const agent = await getFirstAgent();
            if (!agent) return;
            const resp = await agentFetch(agent.apiKey, '/api/agenticmail/mail/import-relay', {
              method: 'POST',
              body: JSON.stringify({ relayUid: uid, agentName: agent.name }),
            });
            if (resp.ok) {
              const data = await resp.json() as any;
              if (data.success) { ok(`Imported message to ${c.cyan(agent.name)}'s inbox`); }
              else { fail(data.error || 'Import failed'); }
            } else { fail('Could not import message'); }
          } else {
            fail('Invalid choice');
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    // ─── Agent Coordination & Tasks ─────────────────────────────

    tasks: {
      desc: 'View tasks (incoming/outgoing/all)',
      run: async () => {
        log('');
        try {
          const direction = await question('  Direction (incoming/outgoing/all) [all]: ').then(v => isBack(v) ? '' : (v.trim() || 'all'));
          const agentKey = currentAgent?.apiKey ?? config.masterKey;

          // Fetch tasks based on direction
          const params = direction === 'all' ? '' : `?direction=${direction}`;
          const resp = await apiFetch(`/api/agenticmail/tasks${params}`, {
            headers: { 'Authorization': `Bearer ${agentKey}` },
          });
          if (!resp.ok) { fail(`API error: ${resp.status}`); return; }
          const data = await resp.json() as any;
          const tasks = data.tasks || data || [];

          if (tasks.length === 0) {
            info('No tasks found');
            return;
          }

          log(`  ${c.bold('Tasks')} (${tasks.length}):`);
          log('');
          for (const t of tasks.slice(0, 20)) {
            const status = t.status === 'completed' ? c.green('✓ done')
              : t.status === 'claimed' ? c.yellow('⏳ working')
              : t.status === 'failed' ? c.red('✗ failed')
              : c.dim('pending');
            const taskDesc = (t.payload?.task || t.taskType || 'unknown').slice(0, 80);
            const age = t.createdAt ? c.dim(` (${t.createdAt})`) : '';
            log(`  ${c.cyan(t.id.slice(0, 8))}  ${status}  ${taskDesc}${age}`);
            if (t.status === 'completed' && t.result) {
              const summary = typeof t.result === 'string' ? t.result : JSON.stringify(t.result).slice(0, 120);
              log(`           ${c.dim('Result:')} ${summary}`);
            }
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    msg: {
      desc: 'Send a message to another agent',
      run: async () => {
        log('');
        try {
          const agent = await getActiveAgent();
          if (!agent) return;

          // List available agents
          const agentsResp = await apiFetch('/api/agenticmail/accounts');
          if (agentsResp.ok) {
            const data = await agentsResp.json() as any;
            const otherAgents = (data.agents || data || []).filter((a: any) => a.name !== agent.name);
            if (otherAgents.length > 0) {
              log(`  ${c.dim('Available agents:')} ${otherAgents.map((a: any) => c.cyan(a.name)).join(', ')}`);
            }
          }

          const target = await question('  To agent: ');
          if (!target.trim() || isBack(target)) return;
          const subject = await question('  Subject: ');
          if (!subject.trim() || isBack(subject)) return;
          const body = await question('  Message: ');
          if (!body.trim() || isBack(body)) return;

          const resp = await apiFetch('/api/agenticmail/agents/message', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${agent.apiKey}` },
            body: JSON.stringify({ agent: target, subject, text: body }),
          });

          if (resp.ok) {
            ok(`Message sent to ${c.cyan(target)}`);
          } else {
            const err = await resp.json().catch(() => ({})) as any;
            fail(`Failed: ${err.error || resp.status}`);
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    chat: {
      desc: 'Chat with the OpenClaw AI agent (real-time streaming)',
      run: async () => {
        log('');
        try {
          let gatewayPort = '18789';
          let gatewayToken = '';
          try {
            const { readFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            const homedir = process.env.HOME || process.env.USERPROFILE || '';
            const cfgPath = join(homedir, '.openclaw', 'openclaw.json');
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
            gatewayPort = String(cfg?.gateway?.port ?? 18789);
            gatewayToken = cfg?.gateway?.auth?.token ?? '';
          } catch { /* ignore */ }

          gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || gatewayToken;
          if (!gatewayToken) {
            fail('Gateway token not found. Is OpenClaw running?');
            return;
          }

          const { WsChat } = await import('./ws-chat.js');
          const {
            renderBubble, renderAgentLabel, renderUserLabel,
            renderThinking, randomThinking,
          } = await import('./chat-ui.js');

          const chat = new WsChat({
            gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
            token: gatewayToken,
          });

          await chat.connect();

          // Read user name from workspace
          let userName = 'You';
          try {
            const { readFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            const homedir = process.env.HOME || process.env.USERPROFILE || '';
            for (const f of ['USER.md', 'IDENTITY.md']) {
              try {
                const txt = readFileSync(join(homedir, '.openclaw', 'workspace', f), 'utf8');
                const match = txt.match(/\*\*(?:Name|What to call them)\*\*:\s*(.+)/i);
                if (match) { userName = match[1].trim(); break; }
              } catch {}
            }
          } catch {}

          // Suppress main shell prompt during chat
          (rl as any).__chatMode = true;

          // Erase main shell input box (3 lines: top + prompt + bot)
          process.stdout.write('\x1b[3A\r\x1b[J');

          log(hr());
          log(`  ${c.bold(c.cyan('\ud83c\udf80 Agent Chat'))} ${c.dim('| Esc to leave | Enter to send | \\\\ + Enter for new line')}`);
          log(hr());

          const boxChar = { tl: '\u256d', tr: '\u256e', bl: '\u2570', br: '\u256f', h: '\u2500', v: '\u2502' };
          const bw = () => Math.max(0, (process.stdout.columns || 80) - 2);

          // Readline-based input inside a bordered box.
          // Custom keypress-based multi-line input with bordered box.
          // Enter sends (single line w/ content). \ + Enter = new line. Backspace merges lines.
          function chatInput(): Promise<string | null> {
            return new Promise((resolve) => {
              const inputLines: string[] = [''];
              let cursorLine = 0;
              let cursorCol = 0;
              const prefixLen = 5; // visible length of "│ ❯ " or "│   "

              // After draw(), cursor sits on content line `cursorLine`.
              // Distance from cursor to top border = cursorLine + 1.
              // We save this so eraseBox works even after cursorLine is mutated.
              let savedUp = 0;

              function draw() {
                const width = bw();
                const top = c.dim(boxChar.tl + boxChar.h.repeat(width) + boxChar.tr);
                const bot = c.dim(boxChar.bl + boxChar.h.repeat(width) + boxChar.br);

                // Erase previous box using saved distance (+1 for top border line)
                if (savedUp > 0) {
                  process.stdout.write(`\x1b[${savedUp + 1}A\r\x1b[J`);
                }

                // Draw top border
                process.stdout.write(`${top}\n`);
                // Draw content lines
                for (let i = 0; i < inputLines.length; i++) {
                  const prefix = i === 0 
                    ? `${c.dim(boxChar.v)} ${c.cyan('\u276f')} ` 
                    : `${c.dim(boxChar.v)}   `;
                  process.stdout.write(`${prefix}${inputLines[i]}\n`);
                }
                // Draw bottom border (no trailing newline)
                process.stdout.write(bot);
                // Move cursor to correct content line
                const upFromBot = inputLines.length - cursorLine;
                if (upFromBot > 0) process.stdout.write(`\x1b[${upFromBot}A`);
                // Position cursor horizontally
                process.stdout.write(`\r\x1b[${prefixLen + cursorCol}C`);

                savedUp = cursorLine + 1;
              }

              // Initial draw
              draw();

              const onKey = (_ch: string, key: any) => {
                if (!key) return;

                const eraseBox = () => {
                  // Move to top border line and clear everything from there down
                  // savedUp = cursorLine + 1 (distance from content line to top border)
                  // Add 1 extra to ensure we clear the top border line itself
                  const up = savedUp + 1;
                  process.stdout.write(`\x1b[${up}A\r\x1b[J`);
                };

                // Escape = exit chat
                if (key.name === 'escape') {
                  process.stdin.removeListener('keypress', onKey);
                  eraseBox();
                  resolve(null);
                  return;
                }

                // Enter = send if single line with content, else new line
                if (key.name === 'return') {
                  if (inputLines.length === 1 && inputLines[0].trim()) {
                    process.stdin.removeListener('keypress', onKey);
                    const text = inputLines[0].trim();
                    eraseBox();
                    resolve(text);
                    return;
                  }
                  // Multi-line or empty: add new line
                  const cur = inputLines[cursorLine];
                  inputLines[cursorLine] = cur.slice(0, cursorCol);
                  inputLines.splice(cursorLine + 1, 0, cur.slice(cursorCol));
                  cursorLine++;
                  cursorCol = 0;
                  draw();
                  return;
                }

                // Tab = send (multi-line)
                if (key.name === 'tab') {
                  const text = inputLines.join('\n').trim();
                  if (!text) return;
                  process.stdin.removeListener('keypress', onKey);
                  eraseBox();
                  resolve(text);
                  return;
                }

                // Backspace
                if (key.name === 'backspace') {
                  if (cursorCol > 0) {
                    inputLines[cursorLine] = inputLines[cursorLine].slice(0, cursorCol - 1) + inputLines[cursorLine].slice(cursorCol);
                    cursorCol--;
                  } else if (cursorLine > 0) {
                    cursorCol = inputLines[cursorLine - 1].length;
                    inputLines[cursorLine - 1] += inputLines[cursorLine];
                    inputLines.splice(cursorLine, 1);
                    cursorLine--;
                  }
                  draw();
                  return;
                }

                // Delete key
                if (key.name === 'delete') {
                  if (cursorCol < inputLines[cursorLine].length) {
                    inputLines[cursorLine] = inputLines[cursorLine].slice(0, cursorCol) + inputLines[cursorLine].slice(cursorCol + 1);
                  } else if (cursorLine < inputLines.length - 1) {
                    inputLines[cursorLine] += inputLines[cursorLine + 1];
                    inputLines.splice(cursorLine + 1, 1);
                  }
                  draw();
                  return;
                }

                // Arrow keys
                if (key.name === 'left') { if (cursorCol > 0) cursorCol--; draw(); return; }
                if (key.name === 'right') { if (cursorCol < inputLines[cursorLine].length) cursorCol++; draw(); return; }
                if (key.name === 'up' && cursorLine > 0) { cursorLine--; cursorCol = Math.min(cursorCol, inputLines[cursorLine].length); draw(); return; }
                if (key.name === 'down' && cursorLine < inputLines.length - 1) { cursorLine++; cursorCol = Math.min(cursorCol, inputLines[cursorLine].length); draw(); return; }

                // Regular character
                if (_ch && !key.ctrl && !key.meta && key.name !== 'tab') {
                  inputLines[cursorLine] = inputLines[cursorLine].slice(0, cursorCol) + _ch + inputLines[cursorLine].slice(cursorCol);
                  cursorCol += _ch.length;
                  draw();
                }
              };

              process.stdin.on('keypress', onKey);
            });
          }

          while (true) {
            const msg = await chatInput();
            if (msg === null || !msg.trim() || msg.trim().toLowerCase() === 'exit') break;

            // User bubble (right)
            log(renderUserLabel(userName));
            log(renderBubble(msg.trim(), 'right'));

            // Thinking spinner inside a bordered box
            const thinkMsg = randomThinking();
            const startTime = Date.now();
            const spinFrames = ['\u25e0','\u25d4','\u25d1','\u25d5','\u25e1','\u25d5','\u25d1','\u25d4'];
            const spinColors = [
              '\x1b[38;5;209m','\x1b[38;5;176m','\x1b[38;5;115m','\x1b[38;5;180m',
              '\x1b[38;5;139m','\x1b[38;5;109m','\x1b[38;5;216m','\x1b[38;5;146m',
            ];
            let spinFrame = 0;
            const bWidth = bw();
            const vBar = c.dim(boxChar.v);
            log(`${c.dim(boxChar.tl + boxChar.h.repeat(bWidth) + boxChar.tr)}`);
            process.stdout.write(`${vBar} ${spinColors[0]}${spinFrames[0]}\x1b[0m ${c.dim(thinkMsg)} ${c.dim('0.0s')}`);
            process.stdout.write(`\n${c.dim(boxChar.bl + boxChar.h.repeat(bWidth) + boxChar.br)}`);
            process.stdout.write('\x1b[1A\r'); // move back to content line

            const timerInterval = setInterval(() => {
              spinFrame++;
              const frame = spinFrames[spinFrame % spinFrames.length];
              const color = spinColors[spinFrame % spinColors.length];
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              process.stdout.write(`\r\x1b[2K${vBar} ${color}${frame}\x1b[0m ${c.dim(thinkMsg)} ${c.yellow(`${elapsed}s`)}`);
            }, 150);

            try {
              const resp = await chat.send(msg.trim(), {
                sessionKey: 'agenticmail-chat',
                timeoutMs: 120_000,
              });

              clearInterval(timerInterval);
              // Erase thinking box: cursor is on content line, top is 1 up, bot is 1 down
              process.stdout.write('\x1b[1A\r\x1b[J');

              if (resp.text) {
                log(renderAgentLabel());
                log(renderBubble(resp.text, 'left'));
              } else if (resp.error) {
                fail(resp.error);
              } else {
                log(`  ${c.dim('No response received')}`);
              }
            } catch (err) {
              clearInterval(timerInterval);
              process.stdout.write('\x1b[1A\r\x1b[J');
              fail(`Error: ${errMsg(err)}`);
            }
            log(''); // spacing before next prompt
          }

          chat.close();
          (rl as any).__chatMode = false;
          log('');
          log(`  ${c.dim('Chat ended')}`);
          log('');
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },




    assign: {
      desc: 'Assign a task to an agent',
      run: async () => {
        log('');
        try {
          // List available agents
          const agentsResp = await apiFetch('/api/agenticmail/accounts');
          if (agentsResp.ok) {
            const data = await agentsResp.json() as any;
            const agents = data.agents || data || [];
            if (agents.length > 0) {
              log(`  ${c.dim('Available agents:')} ${agents.map((a: any) => c.cyan(a.name)).join(', ')}`);
            }
          }

          const assignee = await question('  Assign to agent: ');
          if (!assignee.trim() || isBack(assignee)) return;
          const task = await question('  Task description: ');
          if (!task.trim() || isBack(task)) return;
          const taskType = await question('  Task type [generic]: ').then(v => isBack(v) ? '' : (v.trim() || 'generic'));

          const resp = await apiFetch('/api/agenticmail/tasks/assign', {
            method: 'POST',
            body: JSON.stringify({ assignee, taskType, payload: { task } }),
          });

          if (resp.ok) {
            const data = await resp.json() as any;
            ok(`Task assigned: ${c.cyan(data.id?.slice(0, 8) || 'ok')}`);
          } else {
            const err = await resp.json().catch(() => ({})) as any;
            fail(`Failed: ${err.error || resp.status}`);
          }
        } catch (err) { fail(`Error: ${errMsg(err)}`); }
        log('');
      },
    },

    clear: {
      desc: 'Clear the screen',
      run: async () => {
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen + move cursor to top
      },
    },

    setup: {
      desc: 'Set up email connection',
      run: async () => {
        log('');
        log(`  ${c.bold('Email Setup')}`);
        log('');
        log(`  ${c.cyan('1.')} Gmail`);
        log(`  ${c.cyan('2.')} Outlook / Hotmail`);
        log(`  ${c.cyan('3.')} Skip`);
        log('');
        const provChoice = await question(`  ${c.dim('>')}: `);
        if (isBack(provChoice)) { log(''); return; }
        const ch = provChoice.trim();
        if (ch === '3') { info('Skipped. You can run /setup anytime.'); log(''); return; }

        let provider: string;
        if (ch === '1') provider = 'gmail';
        else if (ch === '2') provider = 'outlook';
        else { fail('Invalid choice.'); log(''); return; }

        const email = await question(`  ${c.cyan('Your email address:')} `);
        if (isBack(email) || !email.trim()) { log(''); return; }
        log('');

        if (provider === 'gmail') {
          info('You need a Gmail App Password.');
          info(`Go to ${c.cyan('https://myaccount.google.com/apppasswords')}`);
          info('Create one and paste it below (spaces are fine).');
        } else {
          info('You need an Outlook App Password from your account security settings.');
        }
        log('');

        const agentNameInput = await question(`  ${c.cyan('Agent name')} ${c.dim('(secretary)')}: `);
        if (isBack(agentNameInput)) { log(''); return; }
        const agentName = agentNameInput.trim() || 'secretary';

        // Retry loop for password (up to 3 attempts)
        for (let attempt = 1; attempt <= 3; attempt++) {
          const rawPassword = await question(`  ${c.cyan('App password:')} `);
          if (isBack(rawPassword)) { log(''); return; }
          const password = rawPassword.replace(/\s+/g, '');
          if (!password) { fail('Password cannot be empty.'); continue; }

          log('');
          info('Connecting...');

          try {
            const resp = await apiFetch('/api/agenticmail/gateway/relay', {
              method: 'POST',
              body: JSON.stringify({ provider, email: email.trim(), password, agentName }),
              signal: AbortSignal.timeout(30_000),
            });

            if (!resp.ok) {
              const text = await resp.text();
              let parsed: any = {};
              try { parsed = JSON.parse(text); } catch {}
              const error = parsed.error || text;

              const isAuth = /Username and Password not accepted|Invalid login|Authentication failed|AUTHENTICATIONFAILED|Invalid credentials|535/.test(error);
              if (isAuth && attempt < 3) {
                fail('Incorrect email or password.');
                info(`Let's try again. (attempt ${attempt} of 3)`);
                log('');
                continue;
              }
              fail(error.slice(0, 200));
              log('');
              return;
            }

            const data = await resp.json() as any;
            ok('Email connected!');
            if (data.agent) {
              ok(`Agent ${c.bold('"' + data.agent.name + '"')} is ready!`);
              log(`    ${c.dim('Email:')} ${c.cyan(data.agent.subAddress)}`);
              log(`    ${c.dim('Key:')}   ${c.yellow(data.agent.apiKey)}`);
              currentAgent = { name: data.agent.name, email: data.agent.email || data.agent.subAddress, apiKey: data.agent.apiKey };
            }
            log('');
            return;
          } catch (err) {
            fail(`Connection failed: ${errMsg(err)}`);
            log('');
            return;
          }
        }
        log('');
      },
    },

    openclaw: {
      desc: 'Open the OpenClaw TUI in a new terminal',
      run: async () => {
        log('');
        // Check if openclaw CLI exists
        try {
          const { execSync } = await import('node:child_process');
          execSync('which openclaw', { stdio: 'ignore' });
        } catch {
          fail('OpenClaw CLI not found in PATH');
          info('Install OpenClaw: https://openclaw.com');
          return;
        }

        const { spawn } = await import('node:child_process');

        if (process.platform === 'darwin') {
          spawn('osascript', [
            '-e', 'tell application "Terminal"',
            '-e', '  do script "openclaw tui"',
            '-e', '  activate',
            '-e', 'end tell',
          ], { detached: true, stdio: 'ignore' }).unref();
          ok('OpenClaw TUI launched in a new Terminal window');
        } else {
          const terminals = ['gnome-terminal', 'xterm', 'konsole'];
          let launched = false;
          for (const term of terminals) {
            try {
              spawn(term, ['--', 'openclaw', 'tui'], { detached: true, stdio: 'ignore' }).unref();
              ok('OpenClaw TUI launched in a new terminal');
              launched = true;
              break;
            } catch { /* try next */ }
          }
          if (!launched) {
            info('Run in another terminal: openclaw tui');
          }
        }
      },
    },

    exit: {
      desc: 'Stop the server and exit',
      run: async () => {
        log('');
        log(hr());
        info('Shutting down...');
        log(hr());
        log('');
        onExit();
        process.exit(0);
      },
    },

    quit: {
      desc: 'Stop the server and exit',
      run: async () => { await commands.exit.run(); },
    },
  };

  // --- REPL loop (transient prompt with command suggestions) ---

  function makePromptLine() {
    const agentTag = currentAgent ? `${c.dim('│')} ${c.cyan(currentAgent.name)} ${c.green('❯')} ` : `${c.dim('│')} ${c.green('❯')} `;
    return agentTag;
  }
  function promptCol() {
    return makePromptLine().replace(/\x1b\[[^m]*m/g, '').length + 1;
  }
  // Keep backwards compat for the cursor positioning code
  let PROMPT_LINE = makePromptLine();
  let PROMPT_COL = promptCol();

  // --- Command suggestion menu state ---

  let menuVisible = false;
  let menuItems: string[] = [];
  let menuIndex = 0;
  let menuRenderedLines = 0;

  const commandNames = Object.keys(commands).filter(n => n !== 'quit');

  function getFiltered(partial: string): string[] {
    return commandNames.filter(n => n.startsWith(partial));
  }

  /** Move cursor back to the input line and correct column */
  function cursorToInput(linesBelow: number) {
    if (linesBelow > 0) process.stdout.write(`\x1b[${linesBelow}A`);
    process.stdout.write(`\x1b[${PROMPT_COL + ((rl as any).cursor || 0)}G`);
  }

  /** Render the suggestion menu below the input box */
  function renderMenu() {
    if (menuItems.length === 0) { clearMenu(); return; }

    const maxLines = Math.max(menuItems.length, menuRenderedLines);
    // 1 line for boxBot + maxLines for menu items
    const totalBelow = 1 + maxLines;

    // Allocate terminal space with newlines (handles scrolling at bottom of screen)
    for (let i = 0; i < totalBelow; i++) process.stdout.write('\n');
    // Go back up to first menu line (below boxBot)
    if (maxLines > 1) process.stdout.write(`\x1b[${maxLines - 1}A`);
    process.stdout.write('\r');

    // Render each line (items + clear leftover)
    for (let i = 0; i < maxLines; i++) {
      process.stdout.write('\x1b[2K'); // clear line
      if (i < menuItems.length) {
        const name = menuItems[i];
        const desc = commands[name]?.desc || '';
        if (i === menuIndex) {
          process.stdout.write(`  ${c.green('▸')} ${c.green('/' + name)}  ${c.dim(desc)}`);
        } else {
          process.stdout.write(`    ${c.dim('/' + name)}  ${c.dim(desc)}`);
        }
      }
      if (i < maxLines - 1) process.stdout.write('\x1b[1B\r');
    }

    menuRenderedLines = menuItems.length;
    menuVisible = true;

    // Return to input line
    cursorToInput(totalBelow);
  }

  /** Clear the suggestion menu visually and reset state */
  function clearMenu() {
    if (menuRenderedLines > 0) {
      const totalBelow = 1 + menuRenderedLines;
      for (let i = 0; i < totalBelow; i++) process.stdout.write('\n');
      if (menuRenderedLines > 1) process.stdout.write(`\x1b[${menuRenderedLines - 1}A`);
      process.stdout.write('\r');
      for (let i = 0; i < menuRenderedLines; i++) {
        process.stdout.write('\x1b[2K');
        if (i < menuRenderedLines - 1) process.stdout.write('\x1b[1B\r');
      }
      cursorToInput(totalBelow);
    }
    menuVisible = false;
    menuItems = [];
    menuIndex = 0;
    menuRenderedLines = 0;
  }

  /** Update menu based on current readline content */
  function updateMenuState() {
    const line = (rl as any).line as string;
    if (line === '/') {
      menuItems = getFiltered('');
      menuIndex = 0;
      renderMenu();
    } else if (line.startsWith('/') && line.length > 1) {
      const partial = line.slice(1).toLowerCase();
      const filtered = getFiltered(partial);
      // Don't show menu for single exact match
      if (filtered.length > 0 && !(filtered.length === 1 && filtered[0] === partial)) {
        menuItems = filtered;
        menuIndex = Math.min(menuIndex, menuItems.length - 1);
        if (menuIndex < 0) menuIndex = 0;
        renderMenu();
      } else {
        if (menuVisible) clearMenu();
      }
    } else {
      if (menuVisible) clearMenu();
    }
  }

  // --- Prompt ---

  function showPrompt() {
    menuVisible = false;
    menuItems = [];
    menuIndex = 0;
    menuRenderedLines = 0;

    // Refresh prompt line in case active agent changed
    PROMPT_LINE = makePromptLine();
    PROMPT_COL = promptCol();

    log('');
    log(boxTop());
    rl.setPrompt(PROMPT_LINE);
    rl.prompt();
    // Draw bottom border, move cursor back up to input line
    process.stdout.write('\n' + boxBot());
    process.stdout.write(`\x1b[1A\x1b[${PROMPT_COL}G`);
  }

  // --- Key interception (monkey-patch readline._ttyWrite) ---

  const origTtyWrite = (rl as any)._ttyWrite.bind(rl);
  (rl as any)._ttyWrite = function (s: string, key: any) {
    if (menuVisible && key) {
      if (key.name === 'up') {
        menuIndex = Math.max(0, menuIndex - 1);
        renderMenu();
        return;
      }
      if (key.name === 'down') {
        menuIndex = Math.min(menuItems.length - 1, menuIndex + 1);
        renderMenu();
        return;
      }
      if (key.name === 'return') {
        // Fill selected command and submit
        (rl as any).line = '/' + menuItems[menuIndex];
        (rl as any).cursor = ((rl as any).line as string).length;
        menuVisible = false;
        menuRenderedLines = 0;
        (rl as any)._refreshLine();
        origTtyWrite(s, key); // let readline process Enter → emits 'line'
        return;
      }
      if (key.name === 'escape') {
        clearMenu();
        return;
      }
      if (key.name === 'tab') {
        // Tab-complete without submitting
        const selected = menuItems[menuIndex];
        clearMenu();
        (rl as any).line = '/' + selected;
        (rl as any).cursor = ((rl as any).line as string).length;
        (rl as any)._refreshLine();
        updateMenuState();
        return;
      }
    }

    // Let readline handle the key normally
    origTtyWrite(s, key);

    // After readline processed the key, update menu
    updateMenuState();
  };

  showPrompt();

  rl.on('line', async (rawLine: string) => {
    // During chat mode, don't process lines from main handler
    if ((rl as any).__chatMode) return;

    // Clear the input box + any menu from history
    process.stdout.write('\x1b[3A\r\x1b[J');

    let trimmed = rawLine.trim();
    if (!trimmed) { showPrompt(); return; }

    // Support /command and bare command
    if (trimmed.startsWith('/')) trimmed = trimmed.slice(1);

    const cmdName = trimmed.split(/\s+/)[0].toLowerCase();
    const handler = commands[cmdName];

    if (handler) {
      await handler.run();
    } else {
      log(`  ${c.red('Unknown:')} /${cmdName} ${c.dim('─ type /help')}`);
    }

    showPrompt();
  });

  rl.on('close', () => {
    log('');
    log(hr());
    info('Shutting down...');
    log(hr());
    onExit();
    process.exit(0);
  });
}
