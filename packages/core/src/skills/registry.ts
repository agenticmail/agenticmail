/**
 * Skill registry — load, search, validate, list.
 *
 * Skills live in two places:
 *
 *   1. **Built-in** — JSON files bundled with `@agenticmail/core` at
 *      `packages/core/src/skills/built-in/*.json`. These ship with
 *      every install and form the starter library. Editing one in
 *      a fork is fine, but the canonical copy is the one in the
 *      monorepo — PRs to add or refine built-in skills are the
 *      community contribution path.
 *
 *   2. **User-contributed** — JSON files dropped into
 *      `~/.agenticmail/skills/*.json` at runtime. The registry
 *      scans this directory on every `list` / `search` / `load`
 *      call (cached for a few seconds) so a user can add a skill
 *      without restarting the server. User-contributed skills
 *      override built-ins when their `id` collides.
 *
 * The registry is filesystem-only — no DB. A skill is a leaf JSON
 * file, easy to diff in git, easy to write by hand. Loading skills
 * directly from `~/.agenticmail/skills/` (no manifest, no
 * `enabled: true`) is deliberate: the simplest contribution path
 * is "drop the file in, that's it."
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { MemorySearchIndex } from '../memory/text-search.js';
import type {
  Skill,
  SkillSummary,
  SkillValidationError,
  SkillCategory,
} from './types.js';

/** Built-in skills directory — resolved relative to this module. */
function builtInDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout: `packages/core/src/skills/registry.ts` ←→ `built-in/`
  // Dist  layout: `packages/core/dist/skills/registry.js` ←→ `built-in/`
  // We copy `built-in/` into `dist/skills/` on build (handled by the
  // package's tsup config). Both locations are siblings of this file.
  return join(here, 'built-in');
}

/** User-contributed skills directory — created on first read. */
function userDir(): string {
  const dir = join(homedir(), '.agenticmail', 'skills');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/**
 * Coarse 5-second cache so an active skill_search loop doesn't re-read
 * disk per call AND doesn't rebuild the BM25F index per call.
 *
 * Two things live in here together because they share the same
 * invalidation moment: a fresh disk read requires a fresh index, and
 * vice-versa. Splitting them into separate caches would create the
 * possibility of an index built against stale documents (or fresh
 * documents not yet indexed) for a brief window.
 *
 * The index implementation is `MemorySearchIndex` from the memory
 * subsystem — same BM25F + inverted-postings + lazy-IDF + bigram-
 * proximity scorer that powers persistent agent memory. Skills are
 * indexed as `{ title: name, tags: tags, content: description +
 * principles + phrases + tactic scripts }`, so the field weighting
 * (title 3×, tags 2×, content 1×) naturally prioritises name + tag
 * matches over tactic-body matches.
 */
const cache: {
  ts: number;
  byId: Map<string, Skill> | null;
  index: MemorySearchIndex | null;
} = { ts: 0, byId: null, index: null };

const CACHE_TTL_MS = 5_000;

/**
 * Render a skill into the field-weighted-text shape `MemorySearchIndex`
 * expects. We collapse the body fields (description + principles +
 * tactic scripts + phrase bodies) into one `content` blob; the index's
 * BM25F weighting then handles the title/tags/content hierarchy.
 *
 * Why include tactic scripts and phrase bodies in the content blob —
 * those phrases are where the user's likely query language actually
 * lives. A query like "rep wants me to commit to payment" should hit
 * `cancel-subscription-graceful` because its `refuse_payment_request`
 * phrase contains those exact words, not because the skill's name
 * mentions them.
 */
function skillToIndexDoc(s: Skill): { title: string; tags: string[]; content: string } {
  const contentParts: string[] = [
    s.description,
    s.context?.when_to_use ?? '',
    ...(s.principles ?? []),
    ...Object.values(s.phrases ?? {}),
    ...((s.tactics ?? []).flatMap((t) => [t.name, t.when, t.script])),
    ...(s.success_signals ?? []),
    ...(s.failure_signals ?? []),
  ];
  return {
    title: s.name,
    // Include category as a tag for free — a query of "negotiation"
    // hits both literal `negotiation`-category skills AND skills
    // that tagged themselves "negotiation".
    tags: [...(s.tags ?? []), s.category],
    content: contentParts.filter(Boolean).join(' '),
  };
}

function loadAllSkillsFromDisk(): Map<string, Skill> {
  const all = new Map<string, Skill>();
  const dirs = [builtInDir(), userDir()];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        const raw = readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw) as Skill;
        const errors = validateSkill(parsed);
        if (errors.length > 0) {
          // Skip invalid skills with a warning. Don't crash the
          // server on a community contribution typo — the rest of
          // the library stays usable.
          console.warn(`[skills] ${entry} invalid, skipping: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
          continue;
        }
        // User-contributed skills win on collision — that's the
        // intended override path (e.g. ship a localised version).
        all.set(parsed.id, parsed);
      } catch (err) {
        console.warn(`[skills] could not load ${fullPath}: ${(err as Error).message}`);
      }
    }
  }
  return all;
}

function ensureLoaded(): { byId: Map<string, Skill>; index: MemorySearchIndex } {
  const now = Date.now();
  if (cache.byId && cache.index && now - cache.ts < CACHE_TTL_MS) {
    return { byId: cache.byId, index: cache.index };
  }
  const fresh = loadAllSkillsFromDisk();
  // Build the BM25F index incrementally — `addDocument` updates the
  // posting lists + per-doc records + (lazily) IDF. Total cost scales
  // with the total token count, not the skill count squared.
  const index = new MemorySearchIndex();
  for (const [id, skill] of fresh) {
    try { index.addDocument(id, skillToIndexDoc(skill)); } catch { /* skip — best-effort */ }
  }
  cache.byId = fresh;
  cache.index = index;
  cache.ts = now;
  return { byId: fresh, index };
}

/** Manual cache invalidation — useful for tests + after a write. */
export function invalidateSkillCache(): void {
  cache.byId = null;
  cache.index = null;
  cache.ts = 0;
}

/**
 * Schema validator. Returns a list of (path, message) — empty list
 * means the skill is structurally valid. Catches the classes of
 * mistakes a contributor is most likely to make:
 *
 *   - Missing top-level required fields.
 *   - Wrong types (`tactics` as object instead of array).
 *   - Empty arrays where a non-empty one is required.
 *   - Invalid `category` value.
 *   - Tactic with empty `script`.
 *
 * Intentionally NOT a full JSON-schema implementation — the cost of
 * a dependency on `ajv` or similar isn't justified for our shape.
 */
export function validateSkill(s: unknown): SkillValidationError[] {
  const errs: SkillValidationError[] = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return [{ path: '$', message: 'skill must be a JSON object' }];
  }
  const sk = s as Record<string, unknown>;

  const requireString = (key: string, minLen = 1) => {
    const v = sk[key];
    if (typeof v !== 'string' || v.length < minLen) {
      errs.push({ path: key, message: `must be a non-empty string` });
    }
  };
  const requireArray = (key: string, minLen = 1) => {
    const v = sk[key];
    if (!Array.isArray(v) || v.length < minLen) {
      errs.push({ path: key, message: `must be a non-empty array` });
    }
  };

  requireString('id');
  if (typeof sk.id === 'string' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(sk.id)) {
    errs.push({ path: 'id', message: 'must be lowercase-hyphenated slug (a-z, 0-9, -)' });
  }
  requireString('name');
  requireString('version');
  requireString('description');
  requireString('category');

  const validCategories: SkillCategory[] = [
    'negotiation', 'customer-service', 'reservations', 'medical-admin',
    'legal-admin', 'finance-admin', 'real-estate', 'travel',
    'subscription', 'home-services', 'social', 'civic', 'employment',
    'debt-collection', 'other',
  ];
  if (typeof sk.category === 'string' && !validCategories.includes(sk.category as SkillCategory)) {
    errs.push({ path: 'category', message: `unknown category "${sk.category}"; must be one of: ${validCategories.join(', ')}` });
  }

  if (!Array.isArray(sk.tags)) errs.push({ path: 'tags', message: 'must be an array of strings' });
  if (sk.disclaimer !== null && typeof sk.disclaimer !== 'string') {
    errs.push({ path: 'disclaimer', message: 'must be a string or null' });
  }

  // Context block.
  if (!sk.context || typeof sk.context !== 'object') {
    errs.push({ path: 'context', message: 'must be an object' });
  } else {
    const ctx = sk.context as Record<string, unknown>;
    if (typeof ctx.when_to_use !== 'string') errs.push({ path: 'context.when_to_use', message: 'must be a string' });
    if (!Array.isArray(ctx.preconditions)) errs.push({ path: 'context.preconditions', message: 'must be an array' });
    if (typeof ctx.estimated_call_duration_minutes !== 'number') errs.push({ path: 'context.estimated_call_duration_minutes', message: 'must be a number' });
  }

  requireArray('principles', 2);
  if (!sk.phrases || typeof sk.phrases !== 'object') errs.push({ path: 'phrases', message: 'must be an object of {key: phrase}' });

  if (!Array.isArray(sk.tactics) || sk.tactics.length === 0) {
    errs.push({ path: 'tactics', message: 'must be a non-empty array' });
  } else {
    sk.tactics.forEach((t, i) => {
      if (!t || typeof t !== 'object') {
        errs.push({ path: `tactics[${i}]`, message: 'must be an object' });
        return;
      }
      const tactic = t as Record<string, unknown>;
      if (typeof tactic.name !== 'string') errs.push({ path: `tactics[${i}].name`, message: 'must be a string' });
      if (typeof tactic.when !== 'string') errs.push({ path: `tactics[${i}].when`, message: 'must be a string' });
      if (typeof tactic.script !== 'string' || tactic.script.length < 5) {
        errs.push({ path: `tactics[${i}].script`, message: 'must be a non-empty string (>= 5 chars)' });
      }
    });
  }

  requireArray('boundaries', 1);
  if (!Array.isArray(sk.success_signals)) errs.push({ path: 'success_signals', message: 'must be an array' });
  if (!Array.isArray(sk.failure_signals)) errs.push({ path: 'failure_signals', message: 'must be an array' });

  if (!sk.exit_strategy || typeof sk.exit_strategy !== 'object') {
    errs.push({ path: 'exit_strategy', message: 'must be an object' });
  } else {
    const xs = sk.exit_strategy as Record<string, unknown>;
    if (typeof xs.on_success !== 'string') errs.push({ path: 'exit_strategy.on_success', message: 'must be a string' });
    if (typeof xs.on_failure !== 'string') errs.push({ path: 'exit_strategy.on_failure', message: 'must be a string' });
  }

  if (!Array.isArray(sk.required_user_info)) errs.push({ path: 'required_user_info', message: 'must be an array' });
  if (typeof sk.contributed_by !== 'string') errs.push({ path: 'contributed_by', message: 'must be a string' });

  return errs;
}

/**
 * Return a summary view (no body, no tactics) — used by `skill_list`
 * and `skill_search`. v0.9.92 added `when_to_use` + `first_principle`
 * + optional `score` so the realtime voice agent can decide whether
 * to load a skill from the SEARCH result alone, without an extra
 * `load_skill` round-trip on a wrong guess.
 */
function summarize(s: Skill, score?: number): SkillSummary {
  const out: SkillSummary = {
    id: s.id,
    name: s.name,
    category: s.category,
    tags: s.tags,
    description: s.description,
    version: s.version,
    disclaimer_required: !!s.disclaimer,
    estimated_call_duration_minutes: s.context.estimated_call_duration_minutes,
    when_to_use: s.context.when_to_use,
    first_principle: (s.principles && s.principles.length > 0) ? s.principles[0] : '',
  };
  if (score !== undefined) out.score = score;
  return out;
}

/** List all skills (summaries), optionally filtered. */
export function listSkills(opts: { category?: SkillCategory; tag?: string } = {}): SkillSummary[] {
  const all = Array.from(ensureLoaded().byId.values());
  const filtered = all.filter((s) => {
    if (opts.category && s.category !== opts.category) return false;
    if (opts.tag && !s.tags.includes(opts.tag.toLowerCase())) return false;
    return true;
  });
  return filtered.sort((a, b) => a.name.localeCompare(b.name)).map(summarize);
}

/**
 * Search skills by free-text query, ranked by BM25F.
 *
 * Uses {@link MemorySearchIndex} — the same scorer that powers
 * persistent agent memory. Field weighting puts name (title 3×) and
 * tags (2×) above body content (1×), so an exact-name hit always beats
 * a phrase-body match. Inverted posting lists mean scoring only touches
 * docs that share at least one stem with the query — search cost grows
 * with matches, not corpus size, so a 1,000-skill library scores in
 * the same sub-millisecond range as a 10-skill one.
 *
 * Two behaviours worth knowing:
 *
 *   - **Stemming + stop-word removal.** "negotiating", "negotiate",
 *     and "negotiation" all match the same skills. "the", "a", "for"
 *     are dropped from the query.
 *   - **Empty / no-match queries return an empty list**, not the full
 *     library. The model should call `skill_list` if it wants
 *     everything; `skill_search` is for "did anything match?".
 *
 * If the BM25F search returns nothing (typo, very rare phrase), we
 * fall back to a tiny linear scan that catches substring hits the
 * stemmer might have missed. Keeps the search forgiving without
 * making the fast path slow.
 */
export function searchSkills(query: string, limit = 20): SkillSummary[] {
  const q = query.trim();
  if (!q) return [];

  const { byId, index } = ensureLoaded();
  const ranked = index.search(q);

  // Substring-fallback for queries that survived stemming but still
  // matched nothing — typically because of unusual non-English terms,
  // brand names, or one-off slang. Cheap: only runs when BM25F was
  // already empty. Fallback scores get a synthetic 0.1 so they sort
  // BELOW any BM25 hit but the model can still see they exist.
  if (ranked.length === 0) {
    const qLow = q.toLowerCase();
    const fallback: SkillSummary[] = [];
    for (const s of byId.values()) {
      if (s.id.toLowerCase().includes(qLow)
          || s.name.toLowerCase().includes(qLow)
          || s.tags.some((t) => t.toLowerCase().includes(qLow))) {
        fallback.push(summarize(s, 0.1));
        if (fallback.length >= limit) break;
      }
    }
    return fallback;
  }

  const out: SkillSummary[] = [];
  for (const { id, score } of ranked) {
    const skill = byId.get(id);
    if (!skill) continue;
    out.push(summarize(skill, score));
    if (out.length >= limit) break;
  }
  return out;
}

/** Load the FULL skill body (everything an agent needs to act on it). */
export function loadSkill(id: string): Skill | null {
  return ensureLoaded().byId.get(id) ?? null;
}

/**
 * Save a new or updated skill to `~/.agenticmail/skills/<id>.json`.
 * Validates first; throws on invalid input. Bumps `updated_at`.
 *
 * Used by `agenticmail skill add` and by the future "build farm"
 * agents that draft skills programmatically — the same path either
 * way.
 */
export function saveUserSkill(skill: Skill): { path: string } {
  const errors = validateSkill(skill);
  if (errors.length > 0) {
    throw new Error(`skill validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  const dir = userDir();
  const path = join(dir, `${skill.id}.json`);
  const now = new Date().toISOString();
  const out: Skill = {
    ...skill,
    created_at: skill.created_at ?? now,
    updated_at: now,
  };
  writeFileSync(path, JSON.stringify(out, null, 2), 'utf-8');
  invalidateSkillCache();
  return { path };
}

/** Filename-from-id helper (`negotiate-bill-reduction` → `negotiate-bill-reduction.json`). */
export function skillFilename(id: string): string {
  return `${basename(id)}.json`;
}

/** Where the user library lives (for surfacing in error messages / help). */
export function userSkillsDir(): string {
  return userDir();
}
