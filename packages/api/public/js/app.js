// Main entry — wires the modules, runs auth, and drives the
// hash-based router.
//
// Routes:
//   #/inbox    → folder list view (active folder lives in state)
//   #/m/:uid   → single-message view
import { state, API_URL } from './state.js';
import { toast } from './utils.js';
import { apiGet } from './api.js';
import { isBridgeAgent } from './avatar.js';
import { renderProfile, toggleProfileMenu, closeProfileMenu } from './profile.js';
import { renderSidebar } from './sidebar.js';
import { loadList, renderList, clearSearch, ensureFolderCache } from './list-view.js';
import { openMessage } from './message-view.js';
import { populateComposeFrom, openCompose, openDraft, closeCompose, discardCompose, sendCompose } from './compose.js';
import { subscribeToAllAgents, maybeRequestNotificationPermission } from './sse.js';
import { subscribeToActivity } from './activity-badges.js';
import { icon } from './icons.js';
import { isSoundEnabled, setSoundEnabled, playNotificationSound } from './sound.js';

// Hydrate every `data-icon="name"` placeholder in the static HTML
// with the corresponding inline SVG. Done once on load so we don't
// keep emojis around as fallback.
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const size = el.dataset.iconSize ? Number(el.dataset.iconSize) : undefined;
    el.innerHTML = icon(name, size ? { size } : {});
  });
}
hydrateIcons();

// ─── Auth ────────────────────────────────────────────────────────────
const authApiUrl = document.getElementById('auth-api-url');
if (authApiUrl) authApiUrl.textContent = API_URL;

async function signIn() {
  const key = document.getElementById('auth-key').value.trim();
  if (!key) return showAuthErr('Master key is required.');
  try {
    const resp = await fetch(`${API_URL}/api/agenticmail/accounts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    localStorage.setItem('agenticmail.masterKey', key);
    state.masterKey = key;
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    await bootstrap();
  } catch (err) {
    showAuthErr(`Sign-in failed: ${err.message}. Check the key and that the API is running on ${API_URL}.`);
  }
}
function showAuthErr(msg) {
  const e = document.getElementById('auth-err');
  e.textContent = msg; e.style.display = 'block';
}
function signOut() {
  localStorage.removeItem('agenticmail.masterKey');
  localStorage.removeItem('agenticmail.selectedAgentId');
  location.reload();
}

// localStorage key for the inbox the user was last viewing.
// Persisted on every successful agent switch and consulted on
// bootstrap so a refresh / reopen lands on the same account
// instead of bouncing back to the bridge.
const STORAGE_LAST_AGENT = 'agenticmail.selectedAgentId';

document.getElementById('auth-submit').addEventListener('click', signIn);
document.getElementById('auth-key').addEventListener('keydown', e => {
  if (e.key === 'Enter') signIn();
});
document.getElementById('signout-link').addEventListener('click', signOut);

// ─── Bootstrap ───────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const data = await apiGet('/accounts');
    const all = (data.agents ?? data ?? []);
    // Bridge agent pinned to top of switcher; everyone else alphabetical.
    all.sort((a, b) => {
      const aBridge = isBridgeAgent(a) ? 0 : 1;
      const bBridge = isBridgeAgent(b) ? 0 : 1;
      if (aBridge !== bBridge) return aBridge - bBridge;
      return a.name.localeCompare(b.name);
    });
    state.agents = all;
    // Prefer the inbox the user was last viewing (persisted in
    // localStorage on every selectAgent call). Falls back to the
    // bridge if the stored id is gone (agent was deleted) or the
    // user never switched. Fixes the "refresh always bounces me
    // back to the host account" bug.
    const lastId = localStorage.getItem(STORAGE_LAST_AGENT);
    const initial = (lastId && state.agents.find(a => a.id === lastId))
      ?? state.agents.find(isBridgeAgent)
      ?? state.agents[0];
    // Seed the URL hash BEFORE selectAgent so selectAgent's loadList
    // call lands on the right folder. We use history.replaceState
    // (NOT `location.hash = ...`) so this does NOT fire a hashchange
    // event — that would trigger a second route() → loadList() in
    // parallel with selectAgent's, doubling the work on every
    // bootstrap. Read the hash first so a deep-link refresh
    // (e.g. /#/folder/sent) still wins.
    const folderMatch = location.hash.match(/^#\/folder\/([a-z]+)$/);
    if (folderMatch) {
      state.selectedFolder = folderMatch[1];
    } else if (!location.hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/folder/inbox`);
    }
    if (initial) await selectAgent(initial);
    renderProfile();
    populateComposeFrom();
    subscribeToAllAgents();
    // Real-time worker activity badges. Master-key-scoped SSE on
    // /system/events; the dispatcher's worker_started /
    // worker_heartbeat / worker_finished events drive the badge
    // rendering. Idempotent — safe to call after bootstrap reruns.
    subscribeToActivity();
    maybeRequestNotificationPermission();
    // If the URL points at a message (not a folder), open it now —
    // the folder list selectAgent already loaded stays in the
    // background. Folder hashes need no extra work; selectAgent's
    // loadList already handled them above.
    const hash = location.hash;
    const msgMatch = hash.match(/^#\/m\/(\d+)$/);
    const draftMatch = hash.match(/^#\/d\/([a-zA-Z0-9-]+)$/);
    if (msgMatch || draftMatch) route();
  } catch (err) {
    toast(`Failed to load agents: ${err.message}`, true);
  }
}

async function selectAgent(agent) {
  state.selectedAgent = agent;
  state.selectedUid = null;
  state.currentMessage = null;
  // Persist the selection so a page refresh lands back on this
  // inbox rather than bouncing to the bridge. Stored under a
  // separate key from the master key so signing out clears it
  // cleanly without affecting auth.
  try { localStorage.setItem(STORAGE_LAST_AGENT, agent.id); } catch { /* private mode etc. */ }
  // Reset the per-agent folder cache so a fresh discovery runs
  // against the new agent's IMAP. Otherwise switching to an
  // account that uses different folder names (e.g. Gmail relay
  // vs vanilla Stalwart) keeps the previous cache.
  state.folderNames = {};
  // Reset pagination — each inbox starts at page 1.
  state.pagination = { offset: 0, limit: 50, total: 0 };
  // Discover folders BEFORE the first sidebar render so the
  // `requiresDiscovery` hide-rule (All Mail on non-Gmail servers)
  // has the cache to consult. Falls back to defaults on failure.
  await ensureFolderCache(agent);
  renderSidebar(onFolderSelect);
  renderProfile();
  await loadList(agent, state.selectedFolder);
}

function onFolderSelect(folder) {
  // URL drives state — set the hash and let the router do the work.
  // This is what makes browser back / forward / shareable URLs work,
  // and it stops the previous bug where every folder click stayed on
  // #/inbox in the address bar.
  location.hash = `#/folder/${folder}`;
  // On mobile (the only viewport where the sidebar is over-canvas),
  // close it after a folder pick so the user sees the list.
  document.getElementById('main')?.classList.remove('sidebar-open');
}

// ─── Hash router ─────────────────────────────────────────────────────
// Routes:
//   #/inbox            → inbox (back-compat shortcut for #/folder/inbox)
//   #/folder/<id>      → folder list view (sent, drafts, starred, …)
//   #/m/<uid>          → single-message detail
//
// Folder switches go through here too so the URL is the source of truth
// for "what's on screen". If you bookmark or copy-paste a URL like
// http://127.0.0.1:3829/#/folder/sent, opening it lands you on Sent.
function route() {
  const hash = location.hash || '#/inbox';
  const msgMatch = hash.match(/^#\/m\/(\d+)$/);
  if (msgMatch) {
    openMessage(Number(msgMatch[1]));
    return;
  }
  // Drafts use UUIDs as ids and open the compose modal pre-
  // populated rather than the read-only message view. The list
  // row click handler emits #/d/<uuid> for draft rows.
  const draftMatch = hash.match(/^#\/d\/([a-zA-Z0-9-]+)$/);
  if (draftMatch) {
    openDraft(draftMatch[1]);
    return;
  }
  const folderMatch = hash.match(/^#\/folder\/([a-z]+)$/);
  const folder = folderMatch ? folderMatch[1] : 'inbox';
  // Only do work if the folder actually changed. Re-firing loadList
  // for the SAME folder on every hashchange (e.g. closing a message
  // detail back to the list) makes the UI feel sluggish — the list
  // is already rendered, and a second digest fetch just churns
  // through 50 messages on the IMAP server for no visible change.
  if (state.selectedFolder === folder) return;
  state.selectedFolder = folder;
  // Reset pagination on every folder switch — a fresh folder
  // starts at page 1. Preserved across silent SSE refreshes so
  // a new arrival doesn't yank the user back from page 3.
  state.pagination = { offset: 0, limit: 50, total: 0 };
  renderSidebar(onFolderSelect);
  if (state.selectedAgent) loadList(state.selectedAgent, folder);
}
window.addEventListener('hashchange', route);

// ─── Top bar wiring ──────────────────────────────────────────────────
// Hamburger toggles the sidebar on mobile. On desktop the sidebar
// is always visible; the class only changes anything below 800 px,
// where the CSS slides it off-canvas by default.
function toggleSidebar() {
  const main = document.getElementById('main');
  main?.classList.toggle('sidebar-open');
}
document.getElementById('menu-btn').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-backdrop').addEventListener('click', () => {
  document.getElementById('main')?.classList.remove('sidebar-open');
});

// Sound toggle. Stateful icon button — bell (on) / bell-slash (off).
// Clicking flips the preference (persisted to localStorage by the
// sound module), updates the icon, and plays a single test chime
// on transitions to ON so the user hears what they just enabled.
function renderSoundToggle() {
  const btn = document.getElementById('sound-toggle-btn');
  if (!btn) return;
  const on = isSoundEnabled();
  btn.innerHTML = icon(on ? 'soundOn' : 'soundOff', { size: 18 });
  btn.title = on ? 'Notification sound: on (click to mute)' : 'Notification sound: off (click to enable)';
  btn.classList.toggle('sound-on', on);
  btn.classList.toggle('sound-off', !on);
}
document.getElementById('sound-toggle-btn')?.addEventListener('click', () => {
  const next = !isSoundEnabled();
  setSoundEnabled(next);
  renderSoundToggle();
  if (next) playNotificationSound();   // sample the chime on enable
});
renderSoundToggle();

document.getElementById('refresh-btn').addEventListener('click', async () => {
  if (state.selectedAgent) {
    await loadList(state.selectedAgent, state.selectedFolder);
    toast('Refreshed.');
  }
});
document.getElementById('compose-btn').addEventListener('click', openCompose);
document.getElementById('profile-btn').addEventListener('click', toggleProfileMenu);
document.getElementById('profile-menu').addEventListener('click', e => {
  e.stopPropagation();
  const item = e.target.closest('.profile-menu-item');
  if (!item) return;
  const agent = state.agents.find(a => a.id === item.dataset.id);
  if (agent && agent.id !== state.selectedAgent?.id) selectAgent(agent);
  closeProfileMenu();
});
document.addEventListener('click', e => {
  const menu = document.getElementById('profile-menu');
  const btn = document.getElementById('profile-btn');
  if (!menu || !btn) return;
  if (!menu.contains(e.target) && !btn.contains(e.target)) closeProfileMenu();
});

// ─── Compose modal wiring ────────────────────────────────────────────
document.getElementById('compose-close').addEventListener('click', closeCompose);
document.getElementById('compose-cancel').addEventListener('click', discardCompose);
document.getElementById('compose-send').addEventListener('click', sendCompose);
document.getElementById('compose-bg').addEventListener('click', e => {
  if (e.target.id === 'compose-bg') closeCompose();
});

// ─── Search (debounced, Esc clears) ─────────────────────────────────
let searchDebounce = null;
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', e => {
  const v = e.target.value;
  e.target.classList.toggle('has-query', v.length > 0);
  document.getElementById('search-clear').classList.toggle('show', v.length > 0);
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = v;
    renderList();
  }, 80);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});
document.getElementById('search-clear').addEventListener('click', clearSearch);

// ─── Keyboard shortcuts (Gmail-style) ───────────────────────────────
//   r  refresh current inbox
//   c  compose new
//   /  focus the search box
//
// IMPORTANT: every shortcut bails when ANY modifier key is held
// (Cmd / Ctrl / Alt / Meta) — otherwise Cmd+C "copy" was opening
// the compose modal, Cmd+R was overriding browser refresh, etc.
// Plain unmodified single-key shortcuts only.
document.addEventListener('keydown', e => {
  if (document.getElementById('compose-bg').style.display !== 'none') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;  // never hijack OS shortcuts
  if (e.key === 'r') document.getElementById('refresh-btn').click();
  else if (e.key === 'c') openCompose();
  else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  }
});

// ─── Boot ───────────────────────────────────────────────────────────
(() => {
  // Accept `?key=...` from the CLI's `agenticmail web` command, then
  // strip it from the URL so it doesn't leak via Referer / history /
  // screen shares. Safe because the URL is loopback-only.
  try {
    const params = new URL(location.href).searchParams;
    const urlKey = params.get('key');
    if (urlKey) {
      localStorage.setItem('agenticmail.masterKey', urlKey);
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch {}

  const saved = localStorage.getItem('agenticmail.masterKey');
  if (saved) {
    state.masterKey = saved;
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    bootstrap();
  }
})();
