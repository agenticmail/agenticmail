// Gmail-style message-list view. One row per email; click to open in
// the message view. Search filters and inline highlighting run here.
import { state } from './state.js';
import { escapeHtml, toast } from './utils.js';
import { formatDate } from './time.js';
import { parseSearch, matchesSearch, highlightTerm } from './search.js';
import { apiGet, apiPost } from './api.js';
import { FOLDERS } from './sidebar.js';
import { icon } from './icons.js';

/**
 * Defensive flag check. The API's IMAP layer returns `flags` as an
 * array of strings most of the time (`['\\Seen', '\\Flagged']`) but
 * some envelopes come back with a Set-like serialisation or even an
 * object map. Without this guard, calling `.includes()` on a non-
 * array crashed the list with "(m.flags ?? []).includes is not a
 * function". Coerce everything we don't recognise to an empty list.
 */
function flagsHas(flags, name) {
  if (Array.isArray(flags)) return flags.includes(name);
  if (flags && typeof flags === 'object') {
    // `{Seen: true, Flagged: false}` shape — try both with and
    // without the leading backslash since callers can mean either.
    const key = name.replace(/^\\/, '');
    return flags[name] === true || flags[key] === true;
  }
  return false;
}

// Patterns we look for when matching a real IMAP folder name to one
// of our sidebar folder ids. Different mail servers use different
// names: Stalwart's defaults are "Sent Items", "Drafts", "Junk Mail",
// "Trash"; Gmail uses "[Gmail]/Sent Mail"; Outlook uses "Sent Items"
// + "Deleted Items"; macOS Mail uses "Sent Messages". Auto-discovery
// makes the sidebar work on all of them.
const FOLDER_MATCHERS = {
  sent:    /^sent\b|sent items|sent mail|sent messages|\[gmail\]\/sent/i,
  drafts:  /^drafts?\b|\[gmail\]\/drafts/i,
  spam:    /^junk\b|junk mail|^spam\b|\[gmail\]\/spam/i,
  trash:   /^trash\b|deleted items|deleted messages|\[gmail\]\/trash|\[gmail\]\/bin/i,
  all:     /^all mail\b|\[gmail\]\/all/i,
};

/**
 * Look up the real IMAP folder name for a sidebar id, using the
 * per-agent folder cache populated by ensureFolderCache().
 * Returns undefined if no match — callers should treat that as
 * "folder doesn't exist on this server" and render an empty state.
 */
function imapNameFor(folderId) {
  return state.folderNames?.[folderId];
}

/**
 * Discover real IMAP folder names for the active agent and cache
 * them in state. Called once on agent switch / first folder click.
 * Falls back to canonical names if the discovery endpoint fails so
 * the UI keeps working in degraded mode.
 */
export async function ensureFolderCache(agent) {
  if (state.folderNames && Object.keys(state.folderNames).length > 0) return;
  state.folderNames = { inbox: 'INBOX' };  // INBOX is universal
  try {
    const data = await apiGet('/mail/folders', { agentKey: agent.apiKey });
    const folders = (data.folders ?? []).map(f =>
      typeof f === 'string' ? f : (f.name ?? f.path ?? ''),
    ).filter(Boolean);
    for (const [id, pattern] of Object.entries(FOLDER_MATCHERS)) {
      const match = folders.find(f => pattern.test(f));
      if (match) state.folderNames[id] = match;
    }
  } catch {
    // Discovery failed — fall back to the most common defaults so
    // at least Inbox + Sent work for vanilla Stalwart.
    state.folderNames.sent   = 'Sent Items';
    state.folderNames.drafts = 'Drafts';
    state.folderNames.spam   = 'Junk Mail';
    state.folderNames.trash  = 'Trash';
  }
}

export async function loadList(agent, folder) {
  const root = document.getElementById('content');
  // Gmail-style toolbar above the list: select-all checkbox,
  // refresh, more-options spacer, count + pagination on the right.
  // Identical layout for every folder so Sent / Drafts / Spam /
  // Trash all share the same UX as Inbox.
  root.innerHTML = `
    <div class="list-toolbar">
      <label class="list-select-all" title="Select all">
        <input type="checkbox" id="list-select-all-input" />
      </label>
      <button class="icon-btn list-refresh" title="Refresh" id="list-refresh-btn">${icon('refresh', { size: 18 })}</button>
      <div class="list-toolbar-spacer"></div>
      <span class="count-text" id="list-count"></span>
    </div>
    <div class="list-rows" id="list-rows"><div class="empty">Loading…</div></div>
  `;
  document.getElementById('list-refresh-btn')?.addEventListener('click', () => loadList(agent, folder));
  await ensureFolderCache(agent);

  // Resolve the real IMAP folder. Starred reuses INBOX + a client-
  // side flag filter (Gmail convention); other folders need a real
  // mailbox name from the discovery cache.
  const isStarred = folder === 'starred';
  const imap = isStarred ? 'INBOX' : imapNameFor(folder);
  if (!imap) {
    document.getElementById('list-rows').innerHTML =
      `<div class="empty"><div class="big">📭</div>No ${escapeHtml(folderTitle(folder))} folder on this server.</div>`;
    return;
  }

  try {
    // `/mail/digest` returns envelopes WITH body preview in one call —
    // exactly what the list row needs to render a 2-line preview.
    // Previously we used `/mail/inbox` (no preview) and `/mail/
    // folders/:folder` (no preview, wrong folder names), which left
    // every row stuck on subject + sender alone.
    const url = `/mail/digest?folder=${encodeURIComponent(imap)}&limit=50&offset=0&previewLength=240`;
    const data = await apiGet(url, { agentKey: agent.apiKey });
    state.messages = data.messages ?? [];
    renderList();
  } catch (err) {
    const msg = String(err.message ?? err);
    document.getElementById('list-rows').innerHTML = msg.includes('404')
      ? `<div class="empty">${escapeHtml(folderTitle(folder))} is empty.</div>`
      : `<div class="empty">Failed to load: ${escapeHtml(msg)}</div>`;
  }
}

function folderTitle(folder) {
  const f = FOLDERS.find(x => x.id === folder);
  return f ? f.label : 'Inbox';
}

export function renderList() {
  const root = document.getElementById('list-rows');
  if (!root) return;
  const q = state.searchQuery.trim();
  const filters = q ? parseSearch(q) : null;
  let filtered = filters ? state.messages.filter(m => matchesSearch(m, filters)) : state.messages;

  // Client-side folder filtering for the folders the API doesn't
  // distinguish for us yet. Starred uses the IMAP \Flagged flag.
  // Flags may come back as an array OR an object map ({Seen: true})
  // depending on the IMAP path — always coerce before .includes().
  if (state.selectedFolder === 'starred') {
    filtered = filtered.filter(m => flagsHas(m.flags, '\\Flagged'));
  }

  const hlTerm = filters?.subject || filters?.from || filters?.text || '';

  // Footer count + search hint
  const hintEl = document.getElementById('search-hint');
  if (q && hintEl) {
    hintEl.textContent = `${filtered.length}/${state.messages.length}`;
    hintEl.classList.add('show');
  } else if (hintEl) {
    hintEl.classList.remove('show');
  }
  const countEl = document.getElementById('list-count');
  if (countEl) countEl.textContent = `${filtered.length} of ${state.messages.length}`;

  if (filtered.length === 0) {
    root.innerHTML = q
      ? `<div class="empty">No messages match "${escapeHtml(q)}".</div>`
      : `<div class="empty"><div class="big">${icon('inbox', { size: 48 })}</div>Nothing here yet.</div>`;
    return;
  }

  // Gmail-style single-line row: checkbox · star · sender · subject
  // — preview · date. Subject and preview sit on the same line
  // separated by an em-dash; CSS truncates the joint cell with
  // ellipsis so longer preview lines never wrap. Identical markup
  // for every folder so Sent / Drafts / Spam etc render the same
  // way Inbox does.
  root.innerHTML = filtered.map(m => {
    const unread = !flagsHas(m.flags, '\\Seen');
    const starred = flagsHas(m.flags, '\\Flagged');
    const fromAddr = m.from?.[0]?.address ?? '?';
    const fromName = m.from?.[0]?.name || fromAddr;
    const subject = m.subject ?? '(no subject)';
    const date = formatDate(m.date);
    const starIcon = icon(starred ? 'starFilled' : 'starOutline', { size: 16 });
    const cleanPreview = (m.preview ?? '')
      .replace(/^>+ ?/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `
      <div class="list-row ${unread ? 'unread' : ''}" data-uid="${m.uid}">
        <label class="row-check" data-action="select"><input type="checkbox" /></label>
        <span class="star ${starred ? 'starred' : ''}" data-action="star" data-uid="${m.uid}">${starIcon}</span>
        <span class="from" title="${escapeHtml(fromAddr)}">${highlightTerm(fromName, hlTerm)}</span>
        <span class="subject-cell">
          <span class="subject">${highlightTerm(subject, hlTerm)}</span>
          ${cleanPreview ? `<span class="preview-sep"> — </span><span class="preview">${highlightTerm(cleanPreview, hlTerm)}</span>` : ''}
        </span>
        <span class="date">${escapeHtml(date)}</span>
      </div>
    `;
  }).join('');

  root.querySelectorAll('.list-row').forEach(el => {
    el.addEventListener('click', (e) => {
      // Star click — toggle via API and optimistically update the
      // local flags so the icon flips without a reload.
      const starEl = e.target.closest('[data-action="star"]');
      if (starEl) {
        e.stopPropagation();
        toggleStar(Number(el.dataset.uid), starEl);
        return;
      }
      // Checkbox click — swallow so we don't navigate.
      if (e.target.closest('[data-action="select"]')) {
        e.stopPropagation();
        return;
      }
      const uid = Number(el.dataset.uid);
      location.hash = `#/m/${uid}`;
    });
  });
}

/**
 * Toggle the IMAP \Flagged flag on a message via the API. Updates
 * the in-memory message object on success so renderList reflects
 * the new state without a full reload — and reverts on failure so
 * the icon doesn't drift from server truth.
 */
async function toggleStar(uid, starEl) {
  const agent = state.selectedAgent;
  if (!agent) return;
  const msg = state.messages.find(m => m.uid === uid);
  if (!msg) return;
  const wasStarred = flagsHas(msg.flags, '\\Flagged');
  const nextStarred = !wasStarred;

  // Optimistic UI flip.
  starEl.classList.toggle('starred', nextStarred);
  starEl.innerHTML = icon(nextStarred ? 'starFilled' : 'starOutline', { size: 16 });

  // Local flags mutation so a re-render keeps the new state.
  const imap = state.folderNames?.[state.selectedFolder] ?? 'INBOX';
  if (Array.isArray(msg.flags)) {
    msg.flags = nextStarred
      ? Array.from(new Set([...msg.flags, '\\Flagged']))
      : msg.flags.filter(f => f !== '\\Flagged');
  } else {
    msg.flags = nextStarred ? ['\\Flagged'] : [];
  }

  try {
    await apiPost(`/mail/messages/${uid}/star`, { starred: nextStarred, folder: imap }, { agentKey: agent.apiKey });
  } catch (err) {
    // Revert on failure.
    starEl.classList.toggle('starred', wasStarred);
    starEl.innerHTML = icon(wasStarred ? 'starFilled' : 'starOutline', { size: 16 });
    if (Array.isArray(msg.flags)) {
      msg.flags = wasStarred
        ? Array.from(new Set([...msg.flags, '\\Flagged']))
        : msg.flags.filter(f => f !== '\\Flagged');
    }
    toast(`Star failed: ${err.message}`, true);
  }
}

export function clearSearch() {
  const input = document.getElementById('search-input');
  if (input) {
    input.value = '';
    input.classList.remove('has-query');
  }
  state.searchQuery = '';
  document.getElementById('search-clear')?.classList.remove('show');
  document.getElementById('search-hint')?.classList.remove('show');
  renderList();
  input?.focus();
}
