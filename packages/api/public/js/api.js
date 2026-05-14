// Tiny fetch wrapper that injects the auth header. Every API call goes
// through here so the master key (or per-agent key) is applied
// consistently and errors surface as plain Error throws.
import { state, API_URL } from './state.js';

export async function apiGet(path, opts = {}) {
  const r = await fetch(`${API_URL}/api/agenticmail${path}`, {
    headers: { Authorization: `Bearer ${opts.agentKey ?? state.masterKey}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return await r.json();
}

export async function apiPost(path, body, opts = {}) {
  const r = await fetch(`${API_URL}/api/agenticmail${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.agentKey ?? state.masterKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return await r.json();
}

export async function apiPut(path, body, opts = {}) {
  const r = await fetch(`${API_URL}/api/agenticmail${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.agentKey ?? state.masterKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return await r.json();
}

/**
 * Fetch an attachment with auth and trigger a browser download.
 *
 * Browsers don't send custom headers on `<a href>` clicks, so a
 * plain anchor pointing at the authed endpoint returns 401. We
 * fetch the bytes via `fetch` + Authorization header, convert to a
 * blob, build an object URL, and synthesise a click on a hidden
 * anchor. The object URL is revoked after a short tick so memory
 * isn't held forever.
 */
export async function downloadAttachment(uid, index, filename, opts = {}) {
  const r = await fetch(`${API_URL}/api/agenticmail/mail/messages/${uid}/attachments/${index}`, {
    headers: { Authorization: `Bearer ${opts.agentKey ?? state.masterKey}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'attachment';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function apiDelete(path, opts = {}) {
  const r = await fetch(`${API_URL}/api/agenticmail${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${opts.agentKey ?? state.masterKey}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  // DELETE may return 204 No Content — guard against empty body.
  const text = await r.text();
  return text ? JSON.parse(text) : { ok: true };
}
