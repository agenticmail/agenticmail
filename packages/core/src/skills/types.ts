/**
 * AgenticMail skill library — types.
 *
 * A "skill" is a structured how-to-act-like-a-skilled-human bundle for
 * a single real-world task an agent might be asked to do: negotiate a
 * bill, book a reservation, handle a debt collector, escalate to a
 * supervisor. Each skill is a JSON document with a fixed schema (this
 * file) so agents can load them on demand AND so humans / other agents
 * can contribute new ones without writing TypeScript.
 *
 * The skill schema is deliberately verbose. A skill that an agent
 * loads mid-call into its system prompt needs to teach it everything
 * a human would intuitively know: what to open with, what objections
 * to expect, how to phrase a graceful concession, when to walk away.
 * Sparse skills ("just be assertive") do not actually transfer
 * competence to a language model that has never made the call before.
 *
 * Why JSON, not Markdown / Python / a DSL:
 *   - Stable, language-agnostic — community contributions can come
 *     from anyone with a text editor; the schema validates and rejects
 *     malformed contributions on PR.
 *   - Embeddable in a Realtime API session.update — the JSON shape can
 *     be rendered into a single `instructions` block at load time.
 *   - Diffable on GitHub — reviewers can see exactly what changed,
 *     phrase-by-phrase, in a PR.
 *   - Searchable — registry-level fuzzy match on name / description /
 *     tags / phrase contents works without any extra index layer.
 *
 * The schema is intentionally open to extension: every object has an
 * optional `extra: Record<string, unknown>` escape hatch so a
 * contributor can attach domain-specific fields without waiting for a
 * core schema bump. The MCP `skill_load` tool returns the raw object,
 * so an agent that recognises the extension can use it directly.
 */

/** Wire-format JSON skill — the on-disk file shape. */
export interface Skill {
  /**
   * Globally-unique slug. Lowercase, hyphenated, no spaces.
   * Convention: `<verb>-<noun>` (`negotiate-bill-reduction`,
   * `book-restaurant-reservation`). Used as the `skill_load` argument
   * and as the JSON filename (`<id>.json`).
   */
  id: string;

  /** Human-readable title, sentence case. */
  name: string;

  /**
   * Semver. Bumped when the skill changes materially (new tactic
   * added, deprecation, etc). Agents that loaded an older version
   * mid-call keep their copy — versioning is for the registry, not
   * the in-flight session.
   */
  version: string;

  /**
   * Coarse-grained category. Keep this list short and stable; tags
   * are where the long tail lives.
   */
  category: SkillCategory;

  /** Free-form lowercase tags for search. */
  tags: string[];

  /**
   * One-sentence summary used in search results + the `skill_list`
   * tool's response. The first 80 characters are what an agent sees
   * when deciding whether to load the full skill.
   */
  description: string;

  /**
   * REQUIRED legal / safety disclaimer the agent must recite to the
   * other party at the start of the call when this skill is loaded.
   * Set to `null` for skills that need no disclaimer; set to a
   * literal string for skills with legal / medical / financial
   * sensitivity (debt collection, court representation, medical
   * triage). The agent's system prompt is updated to make this
   * disclaimer mandatory before any substantive turn.
   */
  disclaimer: string | null;

  /** When + why to reach for this skill. */
  context: SkillContext;

  /**
   * Three to seven principles the agent should internalise. These
   * are the strategic frame — concrete phrasing lives in `phrases`
   * and `tactics`. Mirror the kind of advice a friend who's GOOD at
   * this thing would give you in a 30-second pep talk.
   */
  principles: string[];

  /**
   * Named scripted phrases. Keys are stable identifiers
   * (`opener`, `objection_no_discounts`, `stall_thinking`) so a
   * tactic can reference a phrase by key.
   */
  phrases: Record<string, string>;

  /**
   * Ordered list of specific moves to attempt, with their preconditions
   * and scripts. Agents should try tactics in order, falling back to
   * the next when the previous fails.
   */
  tactics: SkillTactic[];

  /**
   * Hard rules the agent must NOT cross. These are checked at every
   * turn — if the agent is about to violate one, it should pull
   * back, possibly via `ask_operator`. Examples: don't lie about
   * the user's situation, don't commit money on the user's behalf
   * without confirmation, don't be abusive.
   */
  boundaries: string[];

  /** Signs the call is going well — keep doing what's working. */
  success_signals: string[];

  /** Signs the call is going badly — escalate or exit. */
  failure_signals: string[];

  /** How to end the call. Almost always invoked; design carefully. */
  exit_strategy: SkillExitStrategy;

  /**
   * Information the agent needs from the operator (via task brief or
   * `ask_operator` mid-call) BEFORE it can use this skill effectively.
   * Used by the mission planner to flag missing context up front.
   */
  required_user_info: string[];

  /** Free-form attribution: name or handle of the contributor. */
  contributed_by: string;

  /** ISO 8601. Set by the registry on first load if absent. */
  created_at?: string;

  /** ISO 8601. Bumped on every JSON edit. */
  updated_at?: string;

  /**
   * Forward-compatible extension hatch. Domain-specific fields a
   * contributor wants to attach without a core schema bump live
   * here. Agents that recognise the extension key use it; others
   * ignore it. Example: `extra.compliance_jurisdiction: 'US'`.
   */
  extra?: Record<string, unknown>;
}

/** Coarse-grained taxonomy. Extend ONLY via PR + a reviewer's nod. */
export type SkillCategory =
  | 'negotiation'        // bills, contracts, deals
  | 'customer-service'   // billing disputes, support escalations
  | 'reservations'       // restaurants, hotels, services
  | 'medical-admin'      // insurance verification, appointment booking
  | 'legal-admin'        // court check-ins, filing, NOT representation
  | 'finance-admin'      // bank holds, charge disputes, account changes
  | 'real-estate'        // viewings, lease questions, agent comms
  | 'travel'             // airline changes, hotel adjustments
  | 'subscription'       // cancel + retain offer flows
  | 'home-services'      // plumber, electrician, contractor
  | 'social'             // RSVPs, polite declines, breaking news
  | 'civic'              // DMV, voter registration, city services
  | 'employment'         // scheduling interviews, declining offers
  | 'debt-collection'    // FDCPA-aware (US) responses, validation requests
  // v0.9.87 — community drop + emergency-services bundle added these:
  | 'emergency-services'      // 911 / 988 / poison-control / FBI tip / APS / CPS
  | 'critical-reasoning'      // meta-skills that layer under any other skill
  | 'emotional-intelligence'  // tone, rapport, de-escalation
  | 'closing'                 // wrap-up, confirmation, reference-number capture
  | 'outreach'                // outbound / cold calls
  | 'professional-services'   // intake calls for doctors / lawyers / coaches
  | 'education'               // registrar, admissions, financial aid
  | 'tenancy'                 // landlord / lease / HOA matters
  | 'utility-telecom'         // power, water, mobile, cable, fiber
  | 'insurance'               // claims, disputes, prior-auth
  | 'other';

/** When-to-use + preconditions block. */
export interface SkillContext {
  /** Plain-language description of the situation this skill fits. */
  when_to_use: string;
  /** What must be true before the agent picks up the phone. */
  preconditions: string[];
  /**
   * Realistic typical duration. Used to set the mission's
   * `maxCallDurationSeconds` policy automatically if not overridden.
   */
  estimated_call_duration_minutes: number;
}

/** A single move the agent can try. */
export interface SkillTactic {
  name: string;
  /** When to deploy this tactic. */
  when: string;
  /**
   * Verbatim script. The agent paraphrases to match its voice but
   * keeps the structural moves (mirror, ask for retention, etc).
   */
  script: string;
  /**
   * Optional priority order (1 = try first). Defaults to array order.
   * Lower-priority tactics are fallbacks.
   */
  priority?: number;
}

/** How to wrap the call up. Different ending for success vs failure. */
export interface SkillExitStrategy {
  /** What to do / say when the call hit its goal. */
  on_success: string;
  /** What to do / say when the goal isn't reachable on this call. */
  on_failure: string;
  /**
   * Optional follow-ups for the operator after the call ends —
   * tasks like "email the rep's confirmation number" or "calendar a
   * 30-day check-back". The mission report includes these.
   */
  follow_ups?: string[];
}

/** Skill summary returned by `skill_list` / `skill_search` (no body). */
export interface SkillSummary {
  id: string;
  name: string;
  category: SkillCategory;
  tags: string[];
  description: string;
  version: string;
  disclaimer_required: boolean;
  estimated_call_duration_minutes: number;
  /**
   * v0.9.92 — surfaced from `context.when_to_use`. This is the field
   * that actually tells the model "should I load this for the
   * current situation?" — far more diagnostic than the generic
   * `description` (which is just a one-liner for browsing). The
   * realtime `search_skills` tool result includes it so the model
   * can decide WITHOUT a second `load_skill` round-trip on a wrong
   * guess.
   */
  when_to_use: string;
  /**
   * v0.9.92 — the skill's first principle, surfaced for the same
   * "is this the right playbook" decision. Principles are the
   * strategic frame ("be calm and friendly — the rep didn't choose
   * your bill"); seeing one principle tells the model whether the
   * skill's POSTURE matches the situation, not just its topic.
   */
  first_principle: string;
  /**
   * v0.9.92 — BM25F search score from the rank. Only present on
   * results from `searchSkills`; absent on `listSkills` output
   * (where the ordering is by id, not by relevance). Lets the
   * model thresholds "definitely load" vs. "re-search with a
   * better query".
   */
  score?: number;
}

/** Failed-validation result from the schema validator. */
export interface SkillValidationError {
  path: string;       // JSON pointer-ish, e.g. `tactics[2].when`
  message: string;
}
