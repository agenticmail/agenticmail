import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@agenticmail/core';
import {
  MailSender,
  type AccountManager,
  type AgenticMailConfig,
  type GatewayManager,
} from '@agenticmail/core';
import { requireAgent } from '../middleware/auth.js';
import { validateRuleRegex, safeRegexTest } from '../rule-regex.js';
import { getAgentPassword, normalizeWakeList, wakeHeaders, pushLocalRecipientWakes, deriveDefaultWakeList } from './mail.js';

/**
 * Parse a schedule time string. Supports:
 * - ISO 8601: "2026-02-14T10:00:00", "2026-02-14T10:00:00Z"
 * - Relative presets: "in 30 minutes", "in 1 hour", "in 2 hours", "in 3 hours"
 * - Named presets: "tomorrow 8am", "tomorrow 9am", "tomorrow 2pm"
 * - Day presets: "next monday 9am", "next friday 2pm"
 * - Human-friendly: "02-14-2026 3:30 PM EST" (MM-DD-YYYY H:MM AM/PM TZ)
 */
function parseScheduleTime(input: string): Date | null {
  const trimmed = input.trim();

  // 1. Try ISO 8601
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  const lower = trimmed.toLowerCase();

  // 2. Relative presets: "in X minutes/hours/days"
  const relativeMatch = lower.match(/^in\s+(\d+)\s+(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const now = Date.now();
    if (unit.startsWith('min')) return new Date(now + amount * 60_000);
    if (unit.startsWith('h')) return new Date(now + amount * 3_600_000);
    if (unit.startsWith('d')) return new Date(now + amount * 86_400_000);
  }

  // 3. "tomorrow" presets: "tomorrow 8am", "tomorrow at 2pm", "tomorrow 14:00"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tomorrowMatch) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    let hour = parseInt(tomorrowMatch[1], 10);
    const min = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const ampm = tomorrowMatch[3];
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    tomorrow.setHours(hour, min, 0, 0);
    return tomorrow;
  }

  // 4. "next <day>" presets: "next monday 9am", "next friday at 2pm"
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextDayMatch = lower.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1]);
    let hour = parseInt(nextDayMatch[2], 10);
    const min = nextDayMatch[3] ? parseInt(nextDayMatch[3], 10) : 0;
    const ampm = nextDayMatch[4];
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const result = new Date();
    const currentDay = result.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7; // always next week
    result.setDate(result.getDate() + daysUntil);
    result.setHours(hour, min, 0, 0);
    return result;
  }

  // 5. "this evening", "tonight"
  if (lower === 'tonight' || lower === 'this evening') {
    const d = new Date();
    d.setHours(20, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }

  // 6. Human-friendly: "MM-DD-YYYY H:MM AM/PM [TZ]" or "MM/DD/YYYY H:MM AM/PM [TZ]"
  //
  // Bound input length so the trailing `(.+)?` can't backtrack
  // catastrophically on adversarial input (CodeQL
  // `js/polynomial-redos`). 200 chars is well past any plausible
  // human-typed datetime string.
  const humanMatch = trimmed.length > 200 ? null : trimmed.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\s*(.+)?$/,
  );
  if (humanMatch) {
    const [, mStr, dStr, yStr, hStr, minStr, ampmRaw, tzRaw] = humanMatch;
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);
    const year = parseInt(yStr, 10);
    let hour = parseInt(hStr, 10);
    const min = parseInt(minStr, 10);
    const ampm = ampmRaw.toUpperCase();
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 1 || hour > 12) return null;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;

    // Build local date (server timezone) — timezone in input is informational
    const result = new Date(year, month - 1, day, hour, min, 0, 0);

    // If a TZ abbreviation is provided, try to adjust
    if (tzRaw?.trim()) {
      const TZ_OFFSETS: Record<string, number> = {
        EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6,
        PST: -8, PDT: -7, GMT: 0, UTC: 0, BST: 1, CET: 1, CEST: 2,
        IST: 5.5, JST: 9, AEST: 10, AEDT: 11, NZST: 12, NZDT: 13,
        WAT: 1, EAT: 3, SAST: 2, HKT: 8, SGT: 8, KST: 9,
        HST: -10, AKST: -9, AKDT: -8, AST: -4, ADT: -3,
        NST: -3.5, NDT: -2.5,
      };
      const tz = tzRaw.trim().toUpperCase();
      if (TZ_OFFSETS[tz] !== undefined) {
        const tzOffsetMs = TZ_OFFSETS[tz] * 3_600_000;
        const serverOffsetMs = result.getTimezoneOffset() * -60_000;
        const diff = serverOffsetMs - tzOffsetMs;
        result.setTime(result.getTime() + diff);
      }
    }

    return isNaN(result.getTime()) ? null : result;
  }

  // 7. Last resort: try Date constructor
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Feature routes: contacts, drafts, signatures, templates, scheduled emails
 */
export function createFeatureRoutes(
  db: Database,
  accountManager: AccountManager,
  config: AgenticMailConfig,
  gatewayManager?: GatewayManager,
): Router {
  const router = Router();

  // ─── Contacts ───

  router.get('/contacts', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM contacts WHERE agent_id = ? ORDER BY name, email').all(req.agent!.id);
      res.json({ contacts: rows });
    } catch (err) { next(err); }
  });

  router.post('/contacts', requireAgent, async (req, res, next) => {
    try {
      const { name, email, notes } = req.body || {};
      if (!email) { res.status(400).json({ error: 'email is required' }); return; }
      const id = uuidv4();
      db.prepare('INSERT OR REPLACE INTO contacts (id, agent_id, name, email, notes) VALUES (?, ?, ?, ?, ?)')
        .run(id, req.agent!.id, name || null, email, notes || null);
      res.json({ ok: true, id, email });
    } catch (err) { next(err); }
  });

  router.delete('/contacts/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM contacts WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Contact not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ─── Drafts ───

  /**
   * Normalise an attachments value coming in on POST/PUT bodies.
   * Returns a JSON string suitable for sqlite or null. Each entry
   * is { filename, contentType, content (base64), size }. The web
   * UI's 20 MB total cap is enforced client-side; this is a
   * server-side sanity bound to refuse pathological payloads.
   */
  const MAX_DRAFT_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
  function normaliseDraftAttachments(raw: unknown): string | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    let totalBytes = 0;
    const cleaned = raw.map((a: any) => {
      const content = typeof a?.content === 'string' ? a.content : '';
      // base64 → ~3/4 bytes per char; approximate the on-wire size.
      totalBytes += Math.ceil(content.length * 0.75);
      return {
        filename: typeof a?.filename === 'string' ? a.filename : 'attachment',
        contentType: typeof a?.contentType === 'string' ? a.contentType : 'application/octet-stream',
        content,
        encoding: 'base64' as const,
        size: typeof a?.size === 'number' ? a.size : Math.ceil(content.length * 0.75),
      };
    });
    if (totalBytes > MAX_DRAFT_ATTACHMENTS_BYTES) {
      throw Object.assign(new Error('attachments exceed 25 MB total'), { status: 413 });
    }
    return JSON.stringify(cleaned);
  }

  /**
   * List drafts. Strips the heavy `attachments` column from each
   * row — only metadata (filename/contentType/size) is included so
   * the sidebar list payload stays small. Fetch a single draft via
   * GET /drafts/:id to get full attachment content for editing.
   */
  router.get('/drafts', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM drafts WHERE agent_id = ? ORDER BY updated_at DESC').all(req.agent!.id) as any[];
      const stripped = rows.map(r => {
        let metaOnly: any[] | undefined;
        if (r.attachments) {
          try {
            metaOnly = (JSON.parse(r.attachments) as any[]).map(a => ({
              filename: a.filename, contentType: a.contentType, size: a.size,
            }));
          } catch { metaOnly = undefined; }
        }
        return { ...r, attachments: metaOnly };
      });
      res.json({ drafts: stripped });
    } catch (err) { next(err); }
  });

  /**
   * Fetch a single draft with full attachment content (base64) so
   * the compose modal can rehydrate every field on resume-edit.
   */
  router.get('/drafts/:id', requireAgent, async (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM drafts WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent!.id) as any;
      if (!row) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (row.attachments) {
        try { row.attachments = JSON.parse(row.attachments); }
        catch { row.attachments = []; }
      }
      res.json(row);
    } catch (err) { next(err); }
  });

  router.post('/drafts', requireAgent, async (req, res, next) => {
    try {
      const { to, subject, text, html, cc, bcc, inReplyTo, references, attachments } = req.body || {};
      const attachmentsJson = normaliseDraftAttachments(attachments);
      const id = uuidv4();
      db.prepare(`INSERT INTO drafts (id, agent_id, to_addr, subject, text_body, html_body, cc, bcc, in_reply_to, refs, attachments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.agent!.id, to || null, subject || null, text || null, html || null,
          cc || null, bcc || null, inReplyTo || null, references ? JSON.stringify(references) : null,
          attachmentsJson);
      res.json({ ok: true, id });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status) { res.status(status).json({ error: (err as Error).message }); return; }
      next(err);
    }
  });

  router.put('/drafts/:id', requireAgent, async (req, res, next) => {
    try {
      const { to, subject, text, html, cc, bcc, inReplyTo, references, attachments } = req.body || {};
      // Allow the client to omit `attachments` to leave the existing
      // value alone (partial updates) — only overwrite when the
      // field is explicitly present. Otherwise an autosave that
      // doesn't re-send the base64 blob each tick would lose the
      // attachments on every keystroke.
      const includeAttachments = Object.prototype.hasOwnProperty.call(req.body || {}, 'attachments');
      const attachmentsJson = includeAttachments ? normaliseDraftAttachments(attachments) : undefined;
      const sql = includeAttachments
        ? `UPDATE drafts SET to_addr=?, subject=?, text_body=?, html_body=?,
            cc=?, bcc=?, in_reply_to=?, refs=?, attachments=?, updated_at=datetime('now')
            WHERE id=? AND agent_id=?`
        : `UPDATE drafts SET to_addr=?, subject=?, text_body=?, html_body=?,
            cc=?, bcc=?, in_reply_to=?, refs=?, updated_at=datetime('now')
            WHERE id=? AND agent_id=?`;
      const params: unknown[] = [
        to || null, subject || null, text || null, html || null,
        cc || null, bcc || null, inReplyTo || null,
        references ? JSON.stringify(references) : null,
      ];
      if (includeAttachments) params.push(attachmentsJson);
      params.push(req.params.id, req.agent!.id);
      const result = db.prepare(sql).run(...params as [string]);
      if (result.changes === 0) { res.status(404).json({ error: 'Draft not found' }); return; }
      res.json({ ok: true });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status) { res.status(status).json({ error: (err as Error).message }); return; }
      next(err);
    }
  });

  router.delete('/drafts/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM drafts WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Draft not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Send a draft (sends and deletes it)
  router.post('/drafts/:id/send', requireAgent, async (req, res, next) => {
    try {
      const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent!.id) as any;
      if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
      if (!draft.to_addr) { res.status(400).json({ error: 'Draft has no recipient' }); return; }

      const agent = req.agent!;
      // Drafts don't persist a wake list (the schema predates the
      // feature) so the caller can pass `wake` at send time on the
      // POST body. Same normalisation + header plumbing as elsewhere.
      // 0.9.0 default: derive from To: when sender omits `wake`. See
      // mail.ts:deriveDefaultWakeList for the rationale (CC is for
      // awareness, not action; flipping this stops wake-thrash).
      const explicitWake = normalizeWakeList(req.body?.wake);
      const wakeList = req.body?.wake === undefined ? deriveDefaultWakeList(draft.to_addr) : explicitWake;
      const customHeaders = wakeHeaders(wakeList);

      // Materialise persisted attachments into the nodemailer
      // shape the sender expects. The draft column stores base64
      // strings; nodemailer accepts them as-is when we pass
      // `encoding: 'base64'`.
      let persistedAttachments: Array<{ filename: string; content: string; contentType?: string; encoding: 'base64' }> | undefined;
      if (draft.attachments) {
        try {
          const parsed = JSON.parse(draft.attachments) as Array<{ filename: string; contentType?: string; content: string }>;
          persistedAttachments = parsed.map(a => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
            encoding: 'base64' as const,
          }));
        } catch { /* corrupt blob — fall through with no attachments */ }
      }

      const mailOpts = {
        to: draft.to_addr,
        subject: draft.subject || '(no subject)',
        text: draft.text_body || undefined,
        html: draft.html_body || undefined,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        inReplyTo: draft.in_reply_to || undefined,
        references: draft.refs ? JSON.parse(draft.refs) : undefined,
        ...(persistedAttachments && persistedAttachments.length > 0 ? { attachments: persistedAttachments } : {}),
        ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
      };

      // Try gateway first
      if (gatewayManager) {
        const gatewayResult = await gatewayManager.routeOutbound(agent.name, mailOpts);
        if (gatewayResult) {
          db.prepare('DELETE FROM drafts WHERE id = ?').run(draft.id);
          res.json(gatewayResult);
          return;
        }
      }

      const password = getAgentPassword(agent);
      const sender = new MailSender({
        host: config.smtp.host,
        port: config.smtp.port,
        email: agent.email,
        password,
        authUser: agent.stalwartPrincipal,
      });
      try {
        const result = await sender.send(mailOpts);
        db.prepare('DELETE FROM drafts WHERE id = ?').run(draft.id);
        // Same SSE push as /mail/send so dispatcher wake gating applies
        // to drafts too.
        pushLocalRecipientWakes(
          accountManager, mailOpts.to, mailOpts.cc, mailOpts.bcc, agent, mailOpts.subject, result.messageId, config, wakeList,
        ).catch((err) => {
          console.warn(`[drafts] SSE notify failed: ${(err as Error).message}`);
        });
        res.json(result);
      } finally {
        sender.close();
      }
    } catch (err) { next(err); }
  });

  // ─── Signatures ───

  router.get('/signatures', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM signatures WHERE agent_id = ? ORDER BY is_default DESC, name').all(req.agent!.id);
      res.json({ signatures: rows });
    } catch (err) { next(err); }
  });

  router.post('/signatures', requireAgent, async (req, res, next) => {
    try {
      const { name, text, html, isDefault } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const id = uuidv4();
      if (isDefault) {
        db.prepare('UPDATE signatures SET is_default = 0 WHERE agent_id = ?').run(req.agent!.id);
      }
      db.prepare('INSERT OR REPLACE INTO signatures (id, agent_id, name, text_content, html_content, is_default) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, req.agent!.id, name, text || null, html || null, isDefault ? 1 : 0);
      res.json({ ok: true, id });
    } catch (err) { next(err); }
  });

  router.delete('/signatures/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM signatures WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Signature not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ─── Templates ───

  router.get('/templates', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM templates WHERE agent_id = ? ORDER BY name').all(req.agent!.id);
      res.json({ templates: rows });
    } catch (err) { next(err); }
  });

  router.post('/templates', requireAgent, async (req, res, next) => {
    try {
      const { name, subject, text, html } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const id = uuidv4();
      db.prepare('INSERT OR REPLACE INTO templates (id, agent_id, name, subject, text_body, html_body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, req.agent!.id, name, subject || null, text || null, html || null);
      res.json({ ok: true, id });
    } catch (err) { next(err); }
  });

  router.delete('/templates/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM templates WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Template not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ─── Scheduled Emails ───

  router.get('/scheduled', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM scheduled_emails WHERE agent_id = ? ORDER BY send_at ASC').all(req.agent!.id);
      res.json({ scheduled: rows });
    } catch (err) { next(err); }
  });

  router.post('/scheduled', requireAgent, async (req, res, next) => {
    try {
      const { to, subject, text, html, cc, bcc, sendAt } = req.body || {};
      if (!to || !subject || !sendAt) {
        res.status(400).json({ error: 'to, subject, and sendAt are required' });
        return;
      }

      // Parse sendAt — supports ISO 8601, natural language presets, and human-friendly formats
      const sendDate = parseScheduleTime(String(sendAt));
      if (!sendDate || isNaN(sendDate.getTime())) {
        res.status(400).json({
          error: 'Invalid sendAt date. Accepted formats: ISO 8601 (2026-02-14T10:00:00), '
            + 'presets (in 30 minutes, in 1 hour, in 3 hours, tomorrow 8am, tomorrow 9am, '
            + 'next monday 9am), or MM-DD-YYYY H:MM AM/PM TZ',
        });
        return;
      }
      if (sendDate.getTime() <= Date.now()) {
        res.status(400).json({ error: 'sendAt must be in the future' });
        return;
      }
      const id = uuidv4();
      db.prepare(`INSERT INTO scheduled_emails (id, agent_id, to_addr, subject, text_body, html_body, cc, bcc, send_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.agent!.id, to, subject, text || null, html || null, cc || null, bcc || null, sendDate.toISOString());
      res.json({ ok: true, id, sendAt: sendDate.toISOString() });
    } catch (err) { next(err); }
  });

  router.delete('/scheduled/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare("DELETE FROM scheduled_emails WHERE id = ? AND agent_id = ? AND status = 'pending'")
        .run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Scheduled email not found or already sent' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ─── Tags ───

  router.get('/tags', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM tags WHERE agent_id = ? ORDER BY name').all(req.agent!.id);
      res.json({ tags: rows });
    } catch (err) { next(err); }
  });

  router.post('/tags', requireAgent, async (req, res, next) => {
    try {
      const { name, color } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const id = uuidv4();
      db.prepare('INSERT OR IGNORE INTO tags (id, agent_id, name, color) VALUES (?, ?, ?, ?)')
        .run(id, req.agent!.id, name.trim(), color || '#888888');
      res.json({ ok: true, id, name: name.trim(), color: color || '#888888' });
    } catch (err) { next(err); }
  });

  router.delete('/tags/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM tags WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Tag not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Tag a message
  router.post('/tags/:id/messages', requireAgent, async (req, res, next) => {
    try {
      const { uid, folder } = req.body || {};
      if (!uid) { res.status(400).json({ error: 'uid is required' }); return; }
      // Verify tag belongs to agent
      const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent!.id);
      if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }
      db.prepare('INSERT OR IGNORE INTO message_tags (agent_id, message_uid, tag_id, folder) VALUES (?, ?, ?, ?)')
        .run(req.agent!.id, uid, req.params.id, folder || 'INBOX');
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Remove tag from message
  router.delete('/tags/:id/messages/:uid', requireAgent, async (req, res, next) => {
    try {
      const folder = (req.query.folder as string) || 'INBOX';
      db.prepare('DELETE FROM message_tags WHERE agent_id = ? AND message_uid = ? AND tag_id = ? AND folder = ?')
        .run(req.agent!.id, parseInt(String(req.params.uid)), req.params.id, folder);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Get messages by tag
  router.get('/tags/:id/messages', requireAgent, async (req, res, next) => {
    try {
      const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent!.id) as any;
      if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }
      const rows = db.prepare(
        'SELECT message_uid, folder FROM message_tags WHERE agent_id = ? AND tag_id = ? ORDER BY created_at DESC'
      ).all(req.agent!.id, req.params.id) as any[];
      res.json({ tag, messages: rows.map(r => ({ uid: r.message_uid, folder: r.folder })) });
    } catch (err) { next(err); }
  });

  // Get all tags for a specific message
  router.get('/messages/:uid/tags', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare(`
        SELECT t.* FROM tags t
        JOIN message_tags mt ON mt.tag_id = t.id
        WHERE mt.agent_id = ? AND mt.message_uid = ?
        ORDER BY t.name
      `).all(req.agent!.id, parseInt(String(req.params.uid)));
      res.json({ tags: rows });
    } catch (err) { next(err); }
  });

  // ─── Template send with variable substitution ────────────────────
  router.post('/templates/:id/send', requireAgent, async (req, res, next) => {
    try {
      const template = db.prepare('SELECT * FROM templates WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent!.id) as any;
      if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
      const { to, variables, cc, bcc, wake } = req.body || {};
      if (!to) { res.status(400).json({ error: 'to is required' }); return; }

      const applyVars = (text: string, vars: Record<string, string>): string =>
        text.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m);

      // Normalise wake the same way POST /mail/send does so template-
      // sent mail behaves identically to a direct send for dispatcher
      // wake gating. 0.9.0: default-from-To applies here too.
      const explicitWake = normalizeWakeList(wake);
      const wakeList = wake === undefined ? deriveDefaultWakeList(to) : explicitWake;
      const customHeaders = wakeHeaders(wakeList);

      const vars: Record<string, string> = variables && typeof variables === 'object' ? variables : {};
      const renderedSubject = applyVars(template.subject || '(no subject)', vars);
      const mailOpts = {
        to,
        subject: renderedSubject,
        text: template.text_body ? applyVars(template.text_body, vars) : undefined,
        html: template.html_body ? applyVars(template.html_body, vars) : undefined,
        cc: cc || undefined,
        bcc: bcc || undefined,
        ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
      };

      const agent = req.agent!;
      if (gatewayManager) {
        const gatewayResult = await gatewayManager.routeOutbound(agent.name, mailOpts);
        if (gatewayResult) { res.json(gatewayResult); return; }
      }

      const password = getAgentPassword(agent);
      const sender = new MailSender({
        host: config.smtp.host, port: config.smtp.port,
        email: agent.email, password, authUser: agent.stalwartPrincipal,
      });
      try {
        const result = await sender.send(mailOpts);
        // Push SSE wake events to local recipients with the same
        // wake-allowlist semantics as POST /mail/send. Without this,
        // template-sent mail would only wake recipients through IMAP
        // IDLE — slower, and impossible to gate per-recipient.
        pushLocalRecipientWakes(
          accountManager, to, cc, bcc, agent, renderedSubject, result.messageId, config, wakeList,
        ).catch((err) => {
          console.warn(`[templates] SSE notify failed: ${(err as Error).message}`);
        });
        res.json(result);
      } finally {
        sender.close();
      }
    } catch (err) { next(err); }
  });

  // ─── Email Rules/Filters ────────────────────────────────────────
  router.get('/rules', requireAgent, async (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM email_rules WHERE agent_id = ? ORDER BY priority DESC, created_at').all(req.agent!.id);
      res.json({ rules: rows.map((r: any) => ({ ...r, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) })) });
    } catch (err) { next(err); }
  });

  router.post('/rules', requireAgent, async (req, res, next) => {
    try {
      const { name, conditions, actions, priority, enabled } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const conditionError = validateRuleConditions(conditions);
      if (conditionError) { res.status(400).json({ error: conditionError }); return; }
      const existing = db.prepare('SELECT COUNT(*) AS n FROM email_rules WHERE agent_id = ?').get(req.agent!.id) as { n: number };
      if (existing.n >= MAX_RULES_PER_AGENT) {
        res.status(400).json({ error: `At most ${MAX_RULES_PER_AGENT} rules per agent` });
        return;
      }
      const id = uuidv4();
      db.prepare(
        'INSERT INTO email_rules (id, agent_id, name, priority, enabled, conditions, actions) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, req.agent!.id, name, priority ?? 0, enabled !== false ? 1 : 0, JSON.stringify(conditions || {}), JSON.stringify(actions || {}));
      res.status(201).json({ id, name, conditions: conditions || {}, actions: actions || {}, priority: priority ?? 0, enabled: enabled !== false });
    } catch (err) { next(err); }
  });

  router.delete('/rules/:id', requireAgent, async (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM email_rules WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent!.id);
      if (result.changes === 0) { res.status(404).json({ error: 'Rule not found' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

const MAX_RULES_PER_AGENT = 200;
const MAX_RULE_STRING_LENGTH = 500;
const RULE_STRING_CONDITIONS = ['from_contains', 'from_exact', 'subject_contains', 'to_contains'] as const;

/** Returns an error message, or null when `conditions` is acceptable. */
export function validateRuleConditions(conditions: unknown): string | null {
  if (conditions === undefined || conditions === null) return null;
  if (typeof conditions !== 'object' || Array.isArray(conditions)) return 'conditions must be an object';
  const cond = conditions as Record<string, unknown>;
  for (const key of RULE_STRING_CONDITIONS) {
    const v = cond[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `${key} must be a string`;
    if (v.length > MAX_RULE_STRING_LENGTH) return `${key} must be at most ${MAX_RULE_STRING_LENGTH} characters`;
  }
  if (cond.has_attachment !== undefined && typeof cond.has_attachment !== 'boolean') {
    return 'has_attachment must be a boolean';
  }
  if (cond.subject_regex !== undefined && cond.subject_regex !== null && cond.subject_regex !== '') {
    const check = validateRuleRegex(cond.subject_regex);
    if (!check.ok) return check.error;
  }
  return null;
}

/** Rules whose regex hit the match timeout — skipped (no match) from then on. */
const trippedRegexRules = new Set<string>();

function condString(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase() : '';
}

/**
 * Evaluate email rules for an agent against a parsed email.
 * Returns the first matching rule's actions, or null if no match.
 */
export function evaluateRules(db: Database, agentId: string, email: { from?: { address?: string }[]; to?: { address?: string }[]; subject?: string; text?: string; attachments?: any[] }): { ruleId: string; actions: any } | null {
  const rules = db.prepare('SELECT * FROM email_rules WHERE agent_id = ? AND enabled = 1 ORDER BY priority DESC').all(agentId) as any[];
  for (const rule of rules) {
    let cond: Record<string, unknown>;
    try { cond = JSON.parse(rule.conditions) ?? {}; } catch { continue; }
    let match = true;
    const fromAddr = String(email.from?.[0]?.address ?? '').toLowerCase();
    const toAddr = String(email.to?.[0]?.address ?? '').toLowerCase();
    const subject = String(email.subject ?? '').toLowerCase();

    if (cond.from_contains && !fromAddr.includes(condString(cond.from_contains))) match = false;
    if (cond.from_exact && fromAddr !== condString(cond.from_exact)) match = false;
    if (cond.subject_contains && !subject.includes(condString(cond.subject_contains))) match = false;
    if (match && cond.subject_regex) {
      // Validated, length-capped and time-boxed (GHSA-3jw6-982f-pp9w).
      // Rules stored before validation existed are re-checked here.
      if (trippedRegexRules.has(rule.id) || typeof cond.subject_regex !== 'string') {
        match = false;
      } else {
        const result = safeRegexTest(cond.subject_regex, String(email.subject ?? ''));
        if (result === 'timeout') {
          trippedRegexRules.add(rule.id);
          console.warn(`[rules] subject_regex of rule ${rule.id} exceeded its time budget; rule disabled for this process`);
        }
        if (result !== true) match = false;
      }
    }
    if (cond.to_contains && !toAddr.includes(condString(cond.to_contains))) match = false;
    if (cond.has_attachment === true && (!email.attachments || email.attachments.length === 0)) match = false;

    if (match) return { ruleId: rule.id, actions: JSON.parse(rule.actions) };
  }
  return null;
}

/**
 * Start the scheduled email sender loop.
 * Checks every 30 seconds for emails that need to be sent.
 */
export function startScheduledSender(
  db: Database,
  accountManager: AccountManager,
  config: AgenticMailConfig,
  gatewayManager?: GatewayManager,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const pending = db.prepare(
        "SELECT * FROM scheduled_emails WHERE status = 'pending' AND send_at <= ?"
      ).all(now) as any[];

      for (const row of pending) {
        try {
          const agent = await accountManager.getById(row.agent_id);
          if (!agent) {
            db.prepare("UPDATE scheduled_emails SET status = 'failed', error = ? WHERE id = ?")
              .run('Agent not found', row.id);
            continue;
          }

          const mailOpts = {
            to: row.to_addr,
            subject: row.subject,
            text: row.text_body || undefined,
            html: row.html_body || undefined,
            cc: row.cc || undefined,
            bcc: row.bcc || undefined,
          };

          // Try gateway first
          if (gatewayManager) {
            const gResult = await gatewayManager.routeOutbound(agent.name, mailOpts);
            if (gResult) {
              db.prepare("UPDATE scheduled_emails SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(row.id);
              continue;
            }
          }

          const password = (agent.metadata as Record<string, any>)?._password || agent.name;
          const sender = new MailSender({
            host: config.smtp.host,
            port: config.smtp.port,
            email: agent.email,
            password,
            authUser: agent.stalwartPrincipal,
          });
          try {
            await sender.send(mailOpts);
            db.prepare("UPDATE scheduled_emails SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(row.id);
          } finally {
            sender.close();
          }
        } catch (err) {
          db.prepare("UPDATE scheduled_emails SET status = 'failed', error = ? WHERE id = ?")
            .run((err as Error).message, row.id);
        }
      }
      // Housekeeping: prune delivered_messages older than 30 days
      try {
        db.prepare("DELETE FROM delivered_messages WHERE delivered_at < datetime('now', '-30 days')").run();
      } catch { /* ignore cleanup errors */ }
      // Housekeeping: prune spam_log older than 30 days
      try {
        db.prepare("DELETE FROM spam_log WHERE created_at < datetime('now', '-30 days')").run();
      } catch { /* ignore cleanup errors */ }
    } catch { /* ignore sweep errors */ }
  }, 30_000);
}
