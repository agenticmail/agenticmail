/**
 * Safe handling of user-supplied regular expressions in mail rules
 * (`conditions.subject_regex`) — GHSA-3jw6-982f-pp9w.
 *
 * A catastrophic pattern such as `^(a+)+$` does not throw; it just
 * never returns, and `evaluateRules()` runs on the shared event loop.
 * Two independent layers:
 *
 *  1. {@link validateRuleRegex} — run on store AND at evaluation (rules
 *     stored before this check existed are re-validated). Rejects
 *     overlong patterns, backreferences, lookarounds, and any repeated
 *     group that itself contains a quantifier or an alternation (the
 *     star-height > 1 / overlapping-alternation shapes behind
 *     exponential backtracking), and caps the quantifier count.
 *  2. {@link safeRegexTest} — caps the input length and runs the match
 *     inside a `vm` context with a hard timeout, so even a pattern that
 *     slips past the validator (polynomial blow-up) is interrupted.
 *     No native dependency (RE2) is required.
 */

import vm from 'node:vm';

export const MAX_RULE_REGEX_LENGTH = 200;
export const MAX_RULE_REGEX_QUANTIFIERS = 20;
export const MAX_RULE_REGEX_UNBOUNDED_QUANTIFIERS = 6;
export const MAX_RULE_REGEX_REPEAT_BOUND = 1000;
/** Subjects longer than this are truncated before matching. */
export const MAX_REGEX_INPUT_LENGTH = 1024;
/** Hard wall-clock cap on a single match. */
export const REGEX_TIMEOUT_MS = 50;

export type RegexValidation = { ok: true } | { ok: false; error: string };

interface GroupFrame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

/**
 * Validate a user-supplied pattern. Returns a human-readable error for
 * the API response when the pattern is rejected.
 */
export function validateRuleRegex(pattern: unknown): RegexValidation {
  if (typeof pattern !== 'string') return { ok: false, error: 'subject_regex must be a string' };
  if (pattern.length === 0) return { ok: false, error: 'subject_regex must not be empty' };
  if (pattern.length > MAX_RULE_REGEX_LENGTH) {
    return { ok: false, error: `subject_regex must be at most ${MAX_RULE_REGEX_LENGTH} characters` };
  }
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    return { ok: false, error: `subject_regex is not a valid regular expression: ${(err as Error).message}` };
  }

  const stack: GroupFrame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let quantifiers = 0;
  let unbounded = 0;
  // What the next quantifier would apply to: a closed group's frame, an atom, or nothing.
  let lastAtom: { kind: 'group'; frame: GroupFrame } | { kind: 'atom' } | null = null;

  const reject = (error: string): RegexValidation => ({ ok: false, error: `subject_regex rejected: ${error}` });

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) return reject('trailing backslash');
      if (/[1-9]/.test(n) || n === 'k') return reject('backreferences are not allowed');
      // Skip escapes with payloads (\uXXXX, \xXX, \cX, \p{..}) as one atom.
      if (n === 'u' && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        i = end === -1 ? i + 1 : end;
      } else if (n === 'u') i += 5;
      else if (n === 'x') i += 3;
      else if (n === 'c') i += 2;
      else if ((n === 'p' || n === 'P') && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        i = end === -1 ? i + 1 : end;
      } else i += 1;
      lastAtom = { kind: 'atom' };
      continue;
    }

    if (c === '[') {
      // Character class: consume to the closing unescaped ']'.
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') j++;
        j++;
      }
      i = j;
      lastAtom = { kind: 'atom' };
      continue;
    }

    if (c === '(') {
      if (pattern[i + 1] === '?') {
        const kind = pattern.slice(i + 2, i + 4);
        if (kind.startsWith('=') || kind.startsWith('!') || kind === '<=' || kind === '<!') {
          return reject('lookahead/lookbehind assertions are not allowed');
        }
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      lastAtom = null;
      continue;
    }

    if (c === ')') {
      const frame = stack.pop();
      if (!frame || stack.length === 0) return reject('unbalanced parenthesis');
      // A group's contents count toward its parent's contents.
      const parent = stack[stack.length - 1];
      if (frame.hasQuantifier) parent.hasQuantifier = true;
      if (frame.hasAlternation) parent.hasAlternation = true;
      lastAtom = { kind: 'group', frame };
      continue;
    }

    if (c === '|') {
      stack[stack.length - 1].hasAlternation = true;
      lastAtom = null;
      continue;
    }

    let repeats = false; // can the quantified thing match more than once?
    let isQuantifier = false;
    if (c === '*' || c === '+') {
      isQuantifier = true;
      repeats = true;
      unbounded++;
    } else if (c === '?') {
      isQuantifier = lastAtom !== null; // otherwise it's a lazy modifier, already rejected/handled below
      if (!isQuantifier) continue;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        isQuantifier = true;
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        if (min > MAX_RULE_REGEX_REPEAT_BOUND || (max !== Infinity && max > MAX_RULE_REGEX_REPEAT_BOUND)) {
          return reject(`repeat counts must be at most ${MAX_RULE_REGEX_REPEAT_BOUND}`);
        }
        if (max === Infinity) unbounded++;
        repeats = max > 1;
        i += m[0].length - 1;
      }
    }

    if (isQuantifier) {
      if (lastAtom === null) continue; // lazy `?` after a quantifier, or a literal
      quantifiers++;
      if (quantifiers > MAX_RULE_REGEX_QUANTIFIERS) {
        return reject(`at most ${MAX_RULE_REGEX_QUANTIFIERS} quantifiers are allowed`);
      }
      if (unbounded > MAX_RULE_REGEX_UNBOUNDED_QUANTIFIERS) {
        return reject(`at most ${MAX_RULE_REGEX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (*, +, {n,}) are allowed`);
      }
      if (repeats && lastAtom.kind === 'group' && (lastAtom.frame.hasQuantifier || lastAtom.frame.hasAlternation)) {
        return reject('a repeated group may not contain a quantifier or alternation (catastrophic backtracking)');
      }
      stack[stack.length - 1].hasQuantifier = true;
      // A lazy `?` may follow; it must not be read as another quantifier.
      if (pattern[i + 1] === '?') i++;
      lastAtom = null;
      continue;
    }

    lastAtom = { kind: 'atom' };
  }

  if (stack.length !== 1) return reject('unbalanced parenthesis');
  return { ok: true };
}

// One reusable sandbox; `vm`'s timeout interrupts a running regex match.
let sandbox: vm.Context | null = null;
const script = new vm.Script('__re.test(__s)');

/**
 * Test `input` against `pattern` case-insensitively, safely. Returns
 * `'timeout'` if the match was interrupted, `'invalid'` if the pattern
 * fails validation, otherwise the boolean result.
 */
export function safeRegexTest(pattern: string, input: string): boolean | 'timeout' | 'invalid' {
  if (!validateRuleRegex(pattern).ok) return 'invalid';
  const re = new RegExp(pattern, 'i');
  const s = String(input ?? '').slice(0, MAX_REGEX_INPUT_LENGTH);
  if (!sandbox) sandbox = vm.createContext(Object.create(null));
  sandbox.__re = re;
  sandbox.__s = s;
  try {
    return script.runInContext(sandbox, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch (err) {
    if ((err as { code?: string })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    return 'invalid';
  } finally {
    sandbox.__re = undefined;
    sandbox.__s = undefined;
  }
}
