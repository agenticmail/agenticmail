// Generic centered confirmation modal — a proper replacement for
// the browser's `window.confirm()`. We use it for every destructive
// action in the UI (delete, report spam, etc.) so the experience
// matches the rest of the app rather than dropping the user into
// the OS-styled alert UI.
//
// Usage:
//   const ok = await confirmModal({
//     title: 'Delete this message?',
//     body: "This can't be undone.",
//     confirm: 'Delete',
//     danger: true,
//   });
//   if (!ok) return;
//
// Implementation notes:
//   - Promise-based so callers can `await` the result the same
//     way they would `confirm()`. Resolves true on confirm, false
//     on cancel / Escape / backdrop click.
//   - Built lazily on first call and reused thereafter. Closing
//     the modal detaches its keydown listener so we don't pile
//     up handlers across the session.
//   - Focus is moved to the confirm button on open so Enter
//     confirms by default. Escape always cancels.

import { escapeHtml } from './utils.js';

let modalRoot = null;
let activeResolve = null;
let activeKeydownHandler = null;

function ensureModal() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.className = 'confirm-modal-bg';
  modalRoot.style.display = 'none';
  modalRoot.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <h2 class="confirm-modal-title" id="confirm-modal-title"></h2>
      <p class="confirm-modal-body"></p>
      <div class="confirm-modal-actions">
        <button class="btn-confirm-cancel" data-action="cancel">Cancel</button>
        <button class="btn-confirm-ok" data-action="confirm"></button>
      </div>
    </div>
  `;
  document.body.appendChild(modalRoot);
  // Backdrop click → cancel (only when the click landed on the
  // backdrop itself, not the inner card).
  modalRoot.addEventListener('click', (e) => {
    if (e.target === modalRoot) resolveModal(false);
  });
  modalRoot.querySelector('[data-action=cancel]').addEventListener('click', () => resolveModal(false));
  modalRoot.querySelector('[data-action=confirm]').addEventListener('click', () => resolveModal(true));
  return modalRoot;
}

function resolveModal(value) {
  if (!activeResolve) return;
  const resolve = activeResolve;
  activeResolve = null;
  if (modalRoot) modalRoot.style.display = 'none';
  if (activeKeydownHandler) {
    document.removeEventListener('keydown', activeKeydownHandler);
    activeKeydownHandler = null;
  }
  resolve(value);
}

export function confirmModal({
  title = 'Are you sure?',
  body = '',
  confirm = 'OK',
  cancel = 'Cancel',
  danger = false,
} = {}) {
  // If a previous modal is somehow still open, cancel it before
  // opening the new one. Guarantees a single instance.
  if (activeResolve) resolveModal(false);

  const root = ensureModal();
  root.querySelector('.confirm-modal-title').textContent = title;
  const bodyEl = root.querySelector('.confirm-modal-body');
  bodyEl.innerHTML = body ? escapeHtml(body) : '';
  bodyEl.style.display = body ? 'block' : 'none';
  const okBtn = root.querySelector('[data-action=confirm]');
  okBtn.textContent = confirm;
  okBtn.classList.toggle('btn-confirm-danger', !!danger);
  root.querySelector('[data-action=cancel]').textContent = cancel;
  root.style.display = 'flex';
  // Focus the confirm button so Enter resolves true by default.
  setTimeout(() => okBtn.focus(), 0);

  activeKeydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); resolveModal(false); }
    else if (e.key === 'Enter' && document.activeElement?.dataset?.action === 'confirm') {
      // Default Enter only fires when the OK button has focus —
      // prevents a textarea-Enter elsewhere from accidentally
      // confirming a hidden modal.
      e.preventDefault();
      resolveModal(true);
    }
  };
  document.addEventListener('keydown', activeKeydownHandler);

  return new Promise((resolve) => { activeResolve = resolve; });
}
