// Single-message detail view, opened when the user clicks a list row.
import { state } from './state.js';
import { escapeHtml, stripHtml, toast } from './utils.js';
import { formatDateFull } from './time.js';
import { renderMarkdown } from './markdown.js';
import { avatarHtml } from './avatar.js';
import { apiGet, apiPost, apiDelete, downloadAttachment } from './api.js';
import { openReply } from './compose.js';
import { loadList } from './list-view.js';
import { icon } from './icons.js';
import { confirmModal } from './modal.js';

export async function openMessage(uid) {
  if (!state.selectedAgent) return;
  state.selectedUid = uid;
  const root = document.getElementById('content');
  root.innerHTML = `
    <div class="message-toolbar">
      <button class="icon-btn" id="msg-back" title="Back to list">${icon('back')}</button>
      <button class="icon-btn" id="msg-reply" title="Reply">${icon('reply')}</button>
      <button class="icon-btn" id="msg-reply-all" title="Reply all">${icon('replyAll')}</button>
      <button class="icon-btn" id="msg-unread" title="Mark unread">${icon('mailUnread')}</button>
      <button class="icon-btn" id="msg-spam" title="Report spam">${icon('spam')}</button>
      <button class="icon-btn" id="msg-delete" title="Delete">${icon('trash')}</button>
      <div class="toolbar-spacer"></div>
    </div>
    <div class="message-view"><div class="empty">Loading…</div></div>
  `;
  document.getElementById('msg-back').addEventListener('click', () => { location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`; });
  document.getElementById('msg-reply').addEventListener('click', () => openReply(false));
  document.getElementById('msg-reply-all').addEventListener('click', () => openReply(true));
  document.getElementById('msg-unread').addEventListener('click', () => markUnread());
  document.getElementById('msg-spam').addEventListener('click', () => markSpam());
  document.getElementById('msg-delete').addEventListener('click', () => deleteMessage());

  try {
    const msg = await apiGet(`/mail/messages/${uid}`, { agentKey: state.selectedAgent.apiKey });
    state.currentMessage = msg;
    renderMessage(msg);
  } catch (err) {
    root.querySelector('.message-view').innerHTML =
      `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMessage(msg) {
  const view = document.querySelector('.message-view');
  if (!view) return;
  const fromAddr = msg.from?.[0]?.address ?? '?';
  const fromName = msg.from?.[0]?.name || fromAddr;
  const toStr = (msg.to ?? []).map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ') || '?';
  const ccStr = (msg.cc ?? []).map(a => a.address).join(', ');
  const senderPseudo = { name: fromName };  // for avatar generation
  const bodyText = msg.text ?? stripHtml(msg.html ?? '');

  const attachmentsHtml = (msg.attachments ?? []).length > 0
    ? `<div class="message-attachments">${msg.attachments.map((a, i) =>
        `<button class="message-attachment" data-att-index="${i}" data-att-filename="${escapeHtml(a.filename ?? 'attachment')}" title="Click to download">
          <span class="att-icon">${icon('attachment', { size: 18 })}</span>
          <span class="att-name">${escapeHtml(a.filename ?? '(unnamed)')}</span>
          ${a.size ? `<span class="att-size">${formatBytes(a.size)}</span>` : ''}
        </button>`
      ).join('')}</div>`
    : '';

  view.innerHTML = `
    <div class="message-header">
      <h1 class="message-subject">${escapeHtml(msg.subject ?? '(no subject)')}</h1>
      <div class="message-sender-row">
        ${avatarHtml(senderPseudo, 'avatar-md')}
        <div class="message-meta">
          <div class="message-from">
            <span class="name">${escapeHtml(fromName)}</span>
            <span class="addr">&lt;${escapeHtml(fromAddr)}&gt;</span>
          </div>
          <div class="message-to">to ${escapeHtml(toStr)}${ccStr ? `, cc ${escapeHtml(ccStr)}` : ''}</div>
        </div>
        <div class="message-date">${escapeHtml(formatDateFull(msg.date))}</div>
      </div>
    </div>
    <div class="message-body">${renderBodyWithThreading(bodyText)}</div>
    ${attachmentsHtml}
  `;

  // Wire attachment download clicks. Browsers don't pass our auth
  // header on a plain <a href>, so we fetch+blob+synthesise the
  // click in api.js → downloadAttachment.
  view.querySelectorAll('.message-attachment').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.attIndex);
      const filename = el.dataset.attFilename;
      el.classList.add('downloading');
      try {
        await downloadAttachment(state.selectedUid, idx, filename, { agentKey: state.selectedAgent.apiKey });
      } catch (err) {
        toast(`Download failed: ${err.message}`, true);
      } finally {
        el.classList.remove('downloading');
      }
    });
  });
}

/** Pretty-print byte counts (KB / MB) for attachment size display. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a message body with proper email-thread chrome around
 * quoted replies.
 *
 * Most clients (including ours, via `openReply` in compose.js)
 * prefix a quoted-reply block with the canonical header line:
 *
 *   On 2026-05-13T22:50:24.000Z, claudecode@localhost wrote:
 *   > original body line 1
 *   > original body line 2
 *
 * Rendered with our plain markdown that becomes raw text + a
 * blockquote of `>` lines — visible but ugly: ISO timestamp, no
 * avatar, no nice formatting. This function detects the pattern,
 * extracts (date, sender, quoted body), and renders each quoted
 * chunk as a styled "thread-quote" card with the right chrome:
 * sender avatar, name, friendly date, and the quoted body
 * recursively threaded (for replies-to-replies).
 *
 * Non-matching prose flows through untouched via `renderMarkdown`.
 */
function renderBodyWithThreading(src) {
  if (!src) return '<div class="empty">(no body)</div>';
  const lines = src.split('\n');
  const out = [];
  let prose = [];
  let i = 0;

  const flushProse = () => {
    if (prose.length === 0) return;
    out.push(renderMarkdown(prose.join('\n')));
    prose = [];
  };

  // Header pattern: `On <date>, <addr> wrote:` with optional
  // angle-bracket form `<addr@host>`. Date is anything up to the
  // comma; addr is anything not whitespace + an @.
  const headerRe = /^On (.+?), <?([^\s<>]+@[^\s<>]+)>? wrote:\s*$/;

  while (i < lines.length) {
    const m = lines[i].match(headerRe);
    if (!m) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    flushProse();
    const dateRaw = m[1];
    const sender = m[2];
    i++;
    // Collect contiguous `>` lines (with possible blank-line gaps
    // inside the quote, which most clients tolerate). Stop at the
    // first non-quote, non-blank line.
    const quoted = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('>')) { quoted.push(l.replace(/^>\s?/, '')); i++; continue; }
      if (l.trim() === '') {
        // Peek ahead — if the next non-blank is another `>`, the
        // blank line is part of the quote; otherwise we're done.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].startsWith('>')) { quoted.push(''); i++; continue; }
      }
      break;
    }
    out.push(renderThreadQuote(dateRaw, sender, quoted.join('\n')));
  }
  flushProse();
  return out.join('');
}

function renderThreadQuote(dateRaw, sender, quotedBody) {
  // Try to format the ISO date through the same helper the
  // message header uses; fall back to the raw string on parse fail.
  const friendlyDate = (() => {
    const d = new Date(dateRaw);
    if (!Number.isNaN(d.getTime())) return formatDateFull(d.toISOString());
    return dateRaw;
  })();
  const sub = renderBodyWithThreading(quotedBody);  // recurse for nested threads
  return `
    <div class="thread-quote">
      <div class="thread-quote-head">
        ${avatarHtml({ name: sender }, 'avatar-sm')}
        <span class="thread-quote-from">${escapeHtml(sender)}</span>
        <span class="thread-quote-dot">·</span>
        <span class="thread-quote-date">${escapeHtml(friendlyDate)}</span>
      </div>
      <div class="thread-quote-body">${sub}</div>
    </div>
  `;
}

async function markUnread() {
  if (!state.currentMessage || !state.selectedAgent) return;
  try {
    await apiPost(`/mail/messages/${state.selectedUid}/unseen`, {}, { agentKey: state.selectedAgent.apiKey });
    toast('Marked unread.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Failed: ${err.message}`, true);
  }
}

/**
 * Move the open message to the Junk Mail folder (IMAP). The API
 * route is POST /mail/messages/:uid/spam — it does the move +
 * flags the message so future scans treat it as known spam.
 */
async function markSpam() {
  if (!state.currentMessage || !state.selectedAgent) return;
  const ok = await confirmModal({
    title: 'Report this message as spam?',
    body: 'It will be moved to the Junk folder and used to train the spam filter.',
    confirm: 'Report spam',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiPost(`/mail/messages/${state.selectedUid}/spam`, {}, { agentKey: state.selectedAgent.apiKey });
    toast('Reported as spam.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Spam failed: ${err.message}`, true);
  }
}

/**
 * Delete the open message. DELETE /mail/messages/:uid moves it
 * to the IMAP \Deleted state (Stalwart auto-expunges on server
 * config, otherwise it stays in Trash). Confirm before firing
 * since this is destructive.
 */
async function deleteMessage() {
  if (!state.currentMessage || !state.selectedAgent) return;
  const subject = state.currentMessage.subject ?? '(no subject)';
  const ok = await confirmModal({
    title: 'Delete this message?',
    body: `"${subject}" will be moved to Trash. This can't be undone from the web UI.`,
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiDelete(`/mail/messages/${state.selectedUid}`, { agentKey: state.selectedAgent.apiKey });
    toast('Deleted.');
    location.hash = `#/folder/${state.selectedFolder ?? 'inbox'}`;
    await loadList(state.selectedAgent, state.selectedFolder);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
  }
}
