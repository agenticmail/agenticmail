/**
 * Inbound authentication for the Telegram bridge. Every check here
 * FAILS CLOSED: a missing secret, a missing allow-list or a malformed
 * request is a refusal, never a pass.
 *
 * - The webhook secret is mandatory. When the config has none, one is
 *   generated, persisted (0600) and registered with Telegram via
 *   setWebhook's `secret_token`, so Telegram echoes it on every delivery.
 * - The secret is compared in constant time.
 * - An empty allow-list admits nobody. Allowing every sender requires
 *   an explicit `*` line in the allow-list file.
 *
 * Pure helpers (no import-time side effects) so they can be unit-tested
 * without booting the bridge.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Telegram's `secret_token` charset (1-256 chars) and our entropy floor. */
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
export const MIN_WEBHOOK_SECRET_LENGTH = 16;
/** Telegram updates are small; cap the body so the endpoint can't be used to exhaust memory. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
/** Explicit opt-in token for "allow every sender". */
export const ALLOW_ALL_TOKEN = '*';

export function generateWebhookSecret() {
  return randomBytes(32).toString('hex');
}

export function isUsableWebhookSecret(secret) {
  return typeof secret === 'string'
    && secret.length >= MIN_WEBHOOK_SECRET_LENGTH
    && WEBHOOK_SECRET_RE.test(secret);
}

/**
 * Returns `{ secret, generated }`. A configured secret that is present
 * but unusable (too short / bad charset) throws — silently replacing it
 * would desync from whatever the operator registered elsewhere.
 */
export function resolveWebhookSecret(cfg) {
  const configured = cfg?.secret;
  if (configured === undefined || configured === null || configured === '') {
    return { secret: generateWebhookSecret(), generated: true };
  }
  if (!isUsableWebhookSecret(configured)) {
    throw new Error(
      `webhook "secret" must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters of A-Z, a-z, 0-9, _ or -`,
    );
  }
  return { secret: configured, generated: false };
}

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function isValidSecretToken(provided, secret) {
  if (!isUsableWebhookSecret(secret)) return false; // never authenticate against no secret
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse allow-list file text: one id per line, `#` comments. */
export function parseAllowedIds(text) {
  return new Set(
    String(text ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#')),
  );
}

/** Empty allow-list ⇒ nobody. `*` ⇒ everybody (explicit opt-in only). */
export function isSenderAllowed(allowedIds, userId) {
  if (!allowedIds || allowedIds.size === 0) return false;
  if (allowedIds.has(ALLOW_ALL_TOKEN)) return true;
  const id = String(userId ?? '').trim();
  if (!id) return false;
  return allowedIds.has(id);
}

/**
 * Build the webhook HTTP request handler. `onUpdate(update)` is called
 * only for authenticated, well-formed requests.
 */
export function createWebhookRequestHandler({ path, secret, onUpdate, onError = () => {}, maxBodyBytes = MAX_WEBHOOK_BODY_BYTES }) {
  if (!isUsableWebhookSecret(secret)) {
    throw new Error('createWebhookRequestHandler requires a webhook secret');
  }
  return (req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404).end('not found');
      return;
    }
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!isValidSecretToken(Array.isArray(header) ? header[0] : header, secret)) {
      res.writeHead(403).end('forbidden');
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        aborted = true;
        res.writeHead(413).end('payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      res.writeHead(200).end('ok'); // ack first, process async
      let update;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        onError(err);
        return;
      }
      try {
        onUpdate(update);
      } catch (err) {
        onError(err);
      }
    });
  };
}
