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
  // Archive is a Gmail/Outlook concept — most servers don't ship
  // with one by default. We auto-create on demand (see the API's
  // archive endpoint) so this matcher only needs to recognise
  // existing folders.
  archive: /^archives?\b|^all archive\b/i,
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
    state.folderNames.sent    = 'Sent Items';
    state.folderNames.drafts  = 'Drafts';
    state.folderNames.spam    = 'Junk Mail';
    state.folderNames.trash   = 'Trash';
    state.folderNames.archive = 'Archive';
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
      <div class="bulk-actions" id="bulk-actions" hidden>
        <button class="icon-btn bulk-btn" id="bulk-archive" title="Archive selected">${icon('archive', { size: 18 })}</button>
        <button class="icon-btn bulk-btn" id="bulk-delete" title="Delete selected">${icon('trash', { size: 18 })}</button>
        <button class="icon-btn bulk-btn" id="bulk-spam" title="Report as spam">${icon('spam', { size: 18 })}</button>
        <button class="icon-btn bulk-btn" id="bulk-mark-read" title="Mark as read">${icon('check', { size: 18 })}</button>
        <button class="icon-btn bulk-btn" id="bulk-mark-unread" title="Mark as unread">${icon('mailUnread', { size: 18 })}</button>
        <span class="bulk-count" id="bulk-count"></span>
      </div>
      <div class="list-toolbar-spacer"></div>
      <span class="count-text" id="list-count"></span>
      <button class="icon-btn pager-btn" id="pager-prev" title="Newer" data-icon="back"></button>
      <button class="icon-btn pager-btn" id="pager-next" title="Older"></button>
    </div>
    <div class="list-rows" id="list-rows"><div class="empty">Loading…</div></div>
  `;
  // Pager buttons. "Newer" goes back to a lower offset (closer to
  // the head of the inbox); "Older" advances to higher offsets.
  // Each handler clamps to valid bounds and refetches via loadList
  // with the new offset preserved in state.pagination.
  document.getElementById('pager-next').innerHTML = icon('back', { size: 18 });
  document.getElementById('pager-next').style.transform = 'rotate(180deg)';
  document.getElementById('pager-prev')?.addEventListener('click', () => goToPage(agent, folder, -1));
  document.getElementById('pager-next')?.addEventListener('click', () => goToPage(agent, folder, +1));
  document.getElementById('list-refresh-btn')?.addEventListener('click', () => loadList(agent, folder));
  document.getElementById('list-select-all-input')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('#list-rows .row-check input[type=checkbox]')
      .forEach(cb => { cb.checked = checked; });
    updateBulkActions();
  });
  // Wire bulk-action handlers — each gathers the selected UIDs,
  // calls the matching batch endpoint, and reloads the list. The
  // toolbar visibility is driven by `updateBulkActions` which is
  // called every time a checkbox flips.
  document.getElementById('bulk-archive')?.addEventListener('click', () => runBulkAction(agent, folder, 'archive'));
  document.getElementById('bulk-delete')?.addEventListener('click',  () => runBulkAction(agent, folder, 'delete'));
  document.getElementById('bulk-spam')?.addEventListener('click',    () => runBulkAction(agent, folder, 'spam'));
  document.getElementById('bulk-mark-read')?.addEventListener('click',   () => runBulkAction(agent, folder, 'mark-read'));
  document.getElementById('bulk-mark-unread')?.addEventListener('click', () => runBulkAction(agent, folder, 'mark-unread'));

  // Drafts are a SQL-backed app primitive, not an IMAP mailbox.
  // The autosave path writes to /drafts (sqlite) and the agent
  // MCP tools operate on the same table — so the list must come
  // from there, not from /mail/digest?folder=Drafts (which would
  // miss everything autosaved by the web UI).
  if (folder === 'drafts') return loadDraftsList(agent);
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
    const { offset, limit } = state.pagination;
    const url = `/mail/digest?folder=${encodeURIComponent(imap)}&limit=${limit}&offset=${offset}&previewLength=240`;
    const data = await apiGet(url, { agentKey: agent.apiKey });
    state.messages = data.messages ?? [];
    // The digest endpoint returns `total` — use it for the pager.
    // Fall back to (offset + page-size) when missing so the
    // pager still functions in a degraded "we don't know the
    // upper bound" mode (Next stays enabled until a fetch
    // returns a short page).
    state.pagination.total = typeof data?.total === 'number'
      ? data.total
      : (state.messages.length === limit ? offset + limit + 1 : offset + state.messages.length);
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

/**
 * Drafts list — sourced from the SQL drafts table via `/drafts`,
 * not from the IMAP Drafts mailbox.
 *
 * The autosave path (compose.js) writes here, and the MCP
 * `manage_drafts` tool operates on the same rows, so this is
 * the single source of truth for app-level drafts.
 *
 * We normalise each row into the same envelope shape `renderList`
 * expects (uid → draft id, subject, from = agent itself, date =
 * updated_at, preview = first 240 chars of text_body) so the
 * row markup stays identical across folders. Click handling
 * branches on `state.selectedFolder === 'drafts'` to open the
 * compose modal pre-populated instead of the read-only message
 * view.
 */
async function loadDraftsList(agent) {
  try {
    const data = await apiGet('/drafts', { agentKey: agent.apiKey });
    const all = Array.isArray(data?.drafts) ? data.drafts : [];
    const { offset, limit } = state.pagination;
    // Drafts come from SQL as a single list; paginate client-side.
    const rows = all.slice(offset, offset + limit);
    state.pagination.total = all.length;
    state.messages = rows.map(r => ({
      // We store the draft id under `uid` so renderList +
      // click handlers can use the same field. Drafts also
      // get a `__draftId` marker so the click handler can
      // route differently.
      uid: r.id,
      __draftId: r.id,
      subject: r.subject || '(no subject)',
      from: [{ name: agent.name, address: agent.email }],
      // SQLite returns updated_at as a UTC string without an
      // explicit Z. Date() parses it as local; force UTC
      // interpretation by appending Z so the formatter shows
      // the actual save time.
      date: r.updated_at ? `${r.updated_at}Z`.replace('ZZ', 'Z') : null,
      preview: (r.text_body || '').slice(0, 240),
      flags: [],
      __recipient: r.to_addr || '(no recipient)',
    }));
    renderList();
  } catch (err) {
    document.getElementById('list-rows').innerHTML =
      `<div class="empty">Failed to load drafts: ${escapeHtml(err.message ?? err)}</div>`;
  }
}

/**
 * Advance the pager by one page in the given direction (-1 newer,
 * +1 older). Clamps to valid bounds, then triggers loadList for the
 * fresh offset. Bound to the prev/next toolbar buttons.
 */
function goToPage(agent, folder, direction) {
  const { offset, limit, total } = state.pagination;
  const next = offset + direction * limit;
  if (next < 0) return;                      // already at newest
  if (next >= total && direction > 0) return; // already at oldest
  state.pagination.offset = Math.max(0, next);
  // Scroll to top so the user lands on the first row of the new
  // page rather than at the bottom of where the previous page
  // ended.
  const rows = document.getElementById('list-rows');
  if (rows) rows.scrollTop = 0;
  loadList(agent, folder);
}

/**
 * Refresh the currently-rendered list without rebuilding the
 * toolbar. Used by the SSE new-mail handler so a new email
 * silently slides into the list — no flicker, no "Loading…",
 * no bulk-action selection wiped, no scroll jump.
 *
 * Drafts have their own loader; everything else uses the
 * generic digest path. Falls through to a noop on errors
 * (the SSE notification already pinged the user, so a silent
 * refresh failure is acceptable — the next user-driven
 * refresh / folder switch will repair).
 */
export async function silentRefresh(agent, folder) {
  if (!agent) return;
  try {
    const { offset, limit } = state.pagination;
    if (folder === 'drafts') {
      const data = await apiGet('/drafts', { agentKey: agent.apiKey });
      const all = Array.isArray(data?.drafts) ? data.drafts : [];
      state.pagination.total = all.length;
      const rows = all.slice(offset, offset + limit);
      state.messages = rows.map(r => ({
        uid: r.id,
        __draftId: r.id,
        subject: r.subject || '(no subject)',
        from: [{ name: agent.name, address: agent.email }],
        date: r.updated_at ? `${r.updated_at}Z`.replace('ZZ', 'Z') : null,
        preview: (r.text_body || '').slice(0, 240),
        flags: [],
        __recipient: r.to_addr || '(no recipient)',
      }));
      renderList();
      return;
    }
    await ensureFolderCache(agent);
    const isStarred = folder === 'starred';
    const imap = isStarred ? 'INBOX' : (state.folderNames?.[folder]);
    if (!imap) return;
    const url = `/mail/digest?folder=${encodeURIComponent(imap)}&limit=${limit}&offset=${offset}&previewLength=240`;
    const data = await apiGet(url, { agentKey: agent.apiKey });
    state.messages = data.messages ?? [];
    state.pagination.total = typeof data?.total === 'number'
      ? data.total
      : (state.messages.length === limit ? offset + limit + 1 : offset + state.messages.length);
    renderList();
  } catch { /* silent — next user action will repair */ }
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
  // Defensive Sent-folder filter. The API serves the IMAP Sent
  // mailbox directly, but some Stalwart configurations (or
  // misconfigured saveSentCopy targets) can land messages whose
  // sender ISN'T the active agent in Sent. Filter client-side
  // so the user only ever sees messages they actually sent.
  // This is a safety net — the server-side fix lives in
  // saveSentCopy and the dispatcher's send path.
  if (state.selectedFolder === 'sent' && state.selectedAgent?.email) {
    const me = state.selectedAgent.email.toLowerCase();
    filtered = filtered.filter(m => {
      const fromAddr = (m.from?.[0]?.address ?? '').toLowerCase();
      return fromAddr === me;
    });
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
  // Gmail-style "X-Y of Z" pager label + button enable/disable.
  // We show the current PAGE range against the server-reported
  // total, not just the filtered window — pagination is page-
  // level; search is row-level filtering within the current page.
  const countEl = document.getElementById('list-count');
  const { offset, limit, total } = state.pagination;
  const pageStart = state.messages.length > 0 ? offset + 1 : 0;
  const pageEnd = offset + state.messages.length;
  if (countEl) {
    countEl.textContent = total > 0
      ? `${pageStart}–${pageEnd} of ${total}`
      : (state.messages.length > 0 ? `${pageStart}–${pageEnd}` : '0');
  }
  const prevBtn = document.getElementById('pager-prev');
  const nextBtn = document.getElementById('pager-next');
  if (prevBtn) prevBtn.disabled = offset <= 0;
  // Drive Next purely from the server-reported total. The previous
  // `state.messages.length < limit` clause was meant as a "we hit the
  // end" heuristic for the no-total fallback case, but it backfired
  // on every folder that legitimately had fewer-than-`limit` items on
  // a page (e.g. trailing partial page after deletions, or a folder
  // whose IMAP STATUS returned a stale low count) — Next stayed
  // permanently disabled. The new digest endpoint always returns an
  // authoritative SEARCH-derived total, so a single check is enough.
  if (nextBtn) nextBtn.disabled = pageEnd >= total;

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
  const isDrafts = state.selectedFolder === 'drafts';
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
    // In Drafts the "from" column reads naturally as the recipient
    // ("To: alice@…") since the user is always the sender. Add a
    // small "Draft" tag in red so the row is unmistakeable.
    const leadingCell = isDrafts
      ? `<span class="from drafts-recipient" title="${escapeHtml(m.__recipient ?? '')}"><span class="drafts-tag">Draft</span> ${escapeHtml(m.__recipient ?? '(no recipient)')}</span>`
      : `<span class="from" title="${escapeHtml(fromAddr)}">${highlightTerm(fromName, hlTerm)}</span>`;
    // Drafts can't be starred; suppress the star icon to keep the
    // row visually quiet for the user.
    const starCell = isDrafts
      ? `<span class="star drafts-star-placeholder"></span>`
      : `<span class="star ${starred ? 'starred' : ''}" data-action="star" data-uid="${m.uid}">${starIcon}</span>`;
    return `
      <div class="list-row ${unread ? 'unread' : ''}${isDrafts ? ' draft-row' : ''}" data-uid="${m.uid}">
        <label class="row-check" data-action="select"><input type="checkbox" /></label>
        ${starCell}
        ${leadingCell}
        <span class="subject-cell">
          <span class="subject">${highlightTerm(subject, hlTerm)}</span>
          ${cleanPreview ? `<span class="preview-sep"> — </span><span class="preview">${highlightTerm(cleanPreview, hlTerm)}</span>` : ''}
        </span>
        <span class="date">${escapeHtml(date)}</span>
      </div>
    `;
  }).join('');

  root.querySelectorAll('.list-row').forEach(el => {
    // Checkbox change on individual rows — drives the bulk-action
    // toolbar visibility. Attached separately from the row click
    // handler so clicking the box doesn't propagate to "open
    // message".
    const cb = el.querySelector('.row-check input[type=checkbox]');
    cb?.addEventListener('change', updateBulkActions);
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
      // Drafts open the compose modal pre-populated with the
      // saved draft, NOT the read-only message view. The UID
      // we put on the row is actually a draft UUID; route as
      // #/d/<id> so the router knows to call openDraft().
      if (isDrafts) {
        location.hash = `#/d/${el.dataset.uid}`;
        return;
      }
      const uid = Number(el.dataset.uid);
      location.hash = `#/m/${uid}`;
    });
  });
}

/**
 * Read every checked row's UID. Empty array when nothing is
 * selected. Used by the bulk-action handlers and toolbar
 * visibility logic.
 */
function getSelectedUids() {
  const uids = [];
  document.querySelectorAll('#list-rows .list-row').forEach(row => {
    const cb = row.querySelector('.row-check input[type=checkbox]');
    if (cb?.checked) {
      const uid = Number(row.dataset.uid);
      if (Number.isFinite(uid)) uids.push(uid);
    }
  });
  return uids;
}

/**
 * Toggle the visibility of the bulk-action toolbar based on
 * current selection. Also updates the count label so the user
 * sees "3 selected" etc. Called on every checkbox change +
 * after each successful bulk action.
 */
function updateBulkActions() {
  const uids = getSelectedUids();
  const bar = document.getElementById('bulk-actions');
  const count = document.getElementById('bulk-count');
  if (!bar || !count) return;
  if (uids.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  count.textContent = `${uids.length} selected`;
}

/**
 * Execute a bulk action against every currently-selected row.
 * Maps the action name to the matching batch endpoint, fires
 * one request, then reloads the list so the rows disappear /
 * change visibly. Confirm dialogs only on destructive actions
 * (delete, spam) — archive + mark-read/unread are silent.
 */
async function runBulkAction(agent, folder, action) {
  const uids = getSelectedUids();
  if (uids.length === 0) return;
  const imap = state.folderNames?.[folder] ?? 'INBOX';
  let confirmTitle = '';
  let confirmBody = '';
  let confirmLabel = '';
  let endpoint = '';
  let body = { uids, folder: imap };
  let danger = false;
  switch (action) {
    case 'archive':
      endpoint = '/mail/batch/archive';
      break;
    case 'delete':
      // From Trash, batch/trash falls through to permanent
      // expunge; everywhere else it's a move-to-trash.
      endpoint = '/mail/batch/trash';
      danger = true;
      confirmTitle = folder === 'trash' ? `Delete ${uids.length} message${uids.length === 1 ? '' : 's'} forever?` : `Move ${uids.length} message${uids.length === 1 ? '' : 's'} to Trash?`;
      confirmBody = folder === 'trash' ? "This can't be undone." : 'You can recover them from Trash.';
      confirmLabel = folder === 'trash' ? 'Delete forever' : 'Move to Trash';
      break;
    case 'spam':
      // No batch/spam route yet — fall back to batch/move with
      // the auto-discovered Spam folder.
      endpoint = '/mail/batch/move';
      body.toFolder = state.folderNames?.spam ?? 'Junk Mail';
      danger = true;
      confirmTitle = `Report ${uids.length} message${uids.length === 1 ? '' : 's'} as spam?`;
      confirmBody = 'They will be moved to the Junk folder.';
      confirmLabel = 'Report spam';
      break;
    case 'mark-read':
      endpoint = '/mail/batch/seen';
      break;
    case 'mark-unread':
      endpoint = '/mail/batch/unseen';
      break;
    default:
      return;
  }
  if (confirmTitle) {
    const { confirmModal } = await import('./modal.js');
    const ok = await confirmModal({ title: confirmTitle, body: confirmBody, confirm: confirmLabel, danger });
    if (!ok) return;
  }
  try {
    await apiPost(endpoint, body, { agentKey: agent.apiKey });
    toast(`${uids.length} message${uids.length === 1 ? '' : 's'} ${
      action === 'archive' ? 'archived' :
      action === 'delete' ? (folder === 'trash' ? 'deleted' : 'moved to Trash') :
      action === 'spam' ? 'reported as spam' :
      action === 'mark-read' ? 'marked as read' :
      'marked as unread'
    }.`);
    // Reload so the rows that moved/changed visibly update.
    await loadList(agent, folder);
  } catch (err) {
    toast(`Bulk ${action} failed: ${err.message}`, true);
  }
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
