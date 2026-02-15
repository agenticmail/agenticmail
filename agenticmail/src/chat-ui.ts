/**
 * Terminal Chat UI — bubble-style chat with left-aligned AI and right-aligned human.
 * Uses only foreground colors + borders for universal terminal compatibility.
 */

const ESC = '\x1b';
const reset = `${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${reset}`;
const dim = (s: string) => `${ESC}[2m${s}${reset}`;
const green = (s: string) => `${ESC}[32m${s}${reset}`;
const cyan = (s: string) => `${ESC}[36m${s}${reset}`;
const pink = (s: string) => `${ESC}[38;5;211m${s}${reset}`;
const gray = (s: string) => `${ESC}[90m${s}${reset}`;

function getTermWidth(): number {
  try { return process.stdout.columns || 100; } catch { return 100; }
}

/**
 * Convert basic markdown to ANSI escape codes.
 */
function mdToAnsi(text: string): string {
  return text
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, `${ESC}[1m$1${reset}`)
    .replace(/__(.+?)__/g, `${ESC}[1m$1${reset}`)
    // Italic: *text* or _text_ (but not inside words like file_name)
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, `${ESC}[3m$1${reset}`)
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, `${ESC}[3m$1${reset}`)
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, `${ESC}[9m$1${reset}`)
    // Inline code: `text`
    .replace(/`([^`]+)`/g, `${ESC}[7m $1 ${reset}`)
    // Headers: # text
    .replace(/^(#{1,3})\s+(.+)$/gm, (_m, _h, t) => `${ESC}[1m${ESC}[4m${t}${reset}`)
    // Bullet points: - text or * text
    .replace(/^(\s*)[-*]\s+/gm, '$1\u2022 ')
    // Numbered lists stay as-is
    ;
}

function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) { lines.push(''); continue; }
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxWidth && current.length > 0) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function wordWrapAnsi(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (stripAnsi(paragraph).length === 0) { lines.push(''); continue; }
    const words = paragraph.split(' ');
    let current = '';
    let currentVisLen = 0;
    for (const word of words) {
      const wordVisLen = stripAnsi(word).length;
      if (currentVisLen + wordVisLen + 1 > maxWidth && currentVisLen > 0) {
        lines.push(current);
        current = word;
        currentVisLen = wordVisLen;
      } else {
        current = current ? current + ' ' + word : word;
        currentVisLen = currentVisLen ? currentVisLen + 1 + wordVisLen : wordVisLen;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function renderBubble(text: string, side: 'left' | 'right'): string {
  const termW = getTermWidth();
  const maxContentW = Math.min(Math.floor(termW * 0.6), 72);
  // Convert markdown first, then word-wrap with ANSI awareness
  const converted = mdToAnsi(text);
  const displayLines = wordWrapAnsi(converted, maxContentW);
  const contentW = Math.max(...displayLines.map(l => stripAnsi(l).length), 6);
  const borderW = contentW + 2; // 1 space padding each side

  const output: string[] = [];
  const colorFn = side === 'left' ? gray : pink;

  const top = colorFn(`\u256d${'─'.repeat(borderW)}\u256e`);
  const bot = colorFn(`\u2570${'─'.repeat(borderW)}\u256f`);

  if (side === 'left') {
    // AI bubble — left-aligned, gray border, normal text
    output.push(`  ${top}`);
    for (const line of displayLines) {
      const pad = ' '.repeat(Math.max(0, contentW - stripAnsi(line).length));
      output.push(`  ${colorFn('\u2502')} ${line}${pad} ${colorFn('\u2502')}`);
    }
    output.push(`  ${bot}`);
  } else {
    // Human bubble — right-aligned, pink border, bold text
    const totalW = borderW + 2;
    const indent = ' '.repeat(Math.max(termW - totalW - 2, 2));
    output.push(`${indent}${top}`);
    for (const line of displayLines) {
      const pad = ' '.repeat(Math.max(0, contentW - stripAnsi(line).length));
      output.push(`${indent}${colorFn('\u2502')} ${bold(line)}${pad} ${colorFn('\u2502')}`);
    }
    output.push(`${indent}${bot}`);
  }

  return output.join('\n');
}

export function renderAgentLabel(name: string = 'Fola'): string {
  return `  ${'\ud83c\udf80'} ${bold(cyan(name))}`;
}

export function renderUserLabel(name: string = 'You'): string {
  const termW = getTermWidth();
  const visLen = name.length + 4; // "Name 👤"
  const indent = Math.max(termW - visLen - 2, 2);
  return `${' '.repeat(indent)}${bold(green(name))} \ud83d\udc64`;
}

export function renderThinking(message: string): string {
  return `  ${gray(`\u22ef ${message}`)}`;
}

export function renderConnected(): string {
  return `  ${green('\u25cf')} ${bold('Connected')} ${gray('\u2014 real-time streaming')}`;
}

export function renderConnecting(): string {
  return `  ${gray('\u25cb Connecting...')}`;
}

export function renderSystemMessage(text: string): string {
  const termW = getTermWidth();
  const padLen = Math.max(Math.floor((termW - text.length) / 2), 2);
  return `${' '.repeat(padLen)}${gray(text)}`;
}

export function getInputPrompt(): string {
  return `  ${green('\u203a')} `;
}

export const THINKING_MESSAGES = [
  'brewing thoughts...', 'consulting the oracle...', 'neurons firing...',
  'channeling genius...', 'loading brilliance...', 'warming up the brain cells...',
  'plot twist incoming...', 'assembling words with care...', 'hold my coffee...',
  'calculating the meaning of life...', 'asking the universe...',
  'summoning eloquence...', 'crafting something beautiful...',
  'let me cook...', 'one sec, being brilliant...', 'the gears are turning...',
  'connecting the dots...', 'processing at the speed of thought...',
  'this one deserves a good answer...', 'thinking harder than usual...',
];

export function randomThinking(): string {
  return THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)];
}
