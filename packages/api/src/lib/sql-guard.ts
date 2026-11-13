/**
 * SQL guard for the agent storage routes.
 *
 * The storage router lets agents send two kinds of free-form SQL text:
 *
 *   1. Raw statements (`POST /storage/sql`, `POST /storage/explain`).
 *   2. Expression fragments that are spliced into DDL / queries
 *      (`columns[].check`, `columns[].default`, `indexes[].where`,
 *      `having`).
 *
 * Earlier versions guarded both with regular expressions, and every one of
 * them was bypassed: a comment between `FROM` and the table name hid the
 * table from the ownership scan, `ATTACH` had no `FROM` to anchor on, and
 * expression fragments carried stacked statements into `exec()`.
 *
 * This module replaces the regexes with a real lexer. Every decision below is
 * made on TOKENS, so a comment, a quoted identifier, a string literal or a
 * newline can no longer change what the guard sees. The lexer is deliberately
 * stricter than any SQL dialect: anything whose meaning differs between
 * dialects, or that could make this lexer and the database disagree about
 * where a token ends (comments, dollar quotes, backslash escapes, NUL bytes,
 * unknown punctuation), is refused outright instead of interpreted.
 */

export class SqlGuardError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export type SqlTokenType = 'word' | 'qident' | 'string' | 'number' | 'param' | 'op';

export interface SqlToken {
  type: SqlTokenType;
  /** Identifier / string values are unquoted; words are as written. */
  value: string;
  /** Offset of the token's first character in the source text. */
  start: number;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);
const SINGLE_CHAR_OPS = new Set(['(', ')', ',', '.', '+', '-', '*', '/', '%', '<', '>', '=', '!', '|', '&', '~', '^', ';']);

function isIdStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isIdPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isSqliteFamily(dialect: string): boolean {
  return dialect === 'sqlite' || dialect === 'turso';
}

/**
 * Tokenize `sql`. Throws {@link SqlGuardError} on any construct the guard
 * refuses to reason about (see the module comment).
 */
export function tokenizeSql(sql: string, dialect = 'sqlite'): SqlToken[] {
  const tokens: SqlToken[] = [];
  const sqliteFamily = isSqliteFamily(dialect);
  let i = 0;
  const n = sql.length;

  const readQuoted = (quote: string, allowDoubling: boolean): string => {
    // i points at the opening quote.
    let out = '';
    let j = i + 1;
    for (;;) {
      if (j >= n) throw new SqlGuardError('Unterminated quoted string or identifier in SQL');
      const ch = sql[j];
      if (ch === '\0') throw new SqlGuardError('NUL bytes are not allowed in SQL');
      if (ch === quote) {
        if (allowDoubling && sql[j + 1] === quote) { out += quote; j += 2; continue; }
        break;
      }
      out += ch;
      j++;
    }
    i = j + 1;
    return out;
  };

  while (i < n) {
    const ch = sql[i];
    const start = i;

    if (WHITESPACE.has(ch)) { i++; continue; }
    if (ch === '\0') throw new SqlGuardError('NUL bytes are not allowed in SQL');

    // Comments: refused, never stripped. Dialects disagree about nesting,
    // termination and MySQL's executable `/*! */` form, so the only safe
    // interpretation is none.
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*') || ch === '#') {
      throw new SqlGuardError('SQL comments are not allowed');
    }

    if (ch === "'") {
      const value = readQuoted("'", true);
      if (!sqliteFamily && value.includes('\\')) {
        // Postgres E'' strings and MySQL strings treat backslash as an
        // escape; SQLite does not. Refuse rather than guess.
        throw new SqlGuardError('Backslashes are not allowed in SQL string literals; use a bound parameter');
      }
      tokens.push({ type: 'string', value, start });
      continue;
    }

    if (ch === '"') {
      const value = readQuoted('"', true);
      if (!sqliteFamily && value.includes('\\')) {
        throw new SqlGuardError('Backslashes are not allowed in quoted SQL text; use a bound parameter');
      }
      tokens.push({ type: 'qident', value, start });
      continue;
    }

    if (ch === '`') {
      if (dialect === 'postgres') throw new SqlGuardError('Backtick-quoted identifiers are not supported on this database');
      tokens.push({ type: 'qident', value: readQuoted('`', true), start });
      continue;
    }

    if (ch === '[' && sqliteFamily) {
      tokens.push({ type: 'qident', value: readQuoted(']', false), start });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      // Exponent signs are intentionally NOT absorbed: `1e--x` must surface
      // the `--` to the comment check above.
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      tokens.push({ type: 'number', value: sql.slice(i, j), start });
      i = j;
      continue;
    }

    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && isIdPart(sql[j])) j++;
      tokens.push({ type: 'word', value: sql.slice(i, j), start });
      i = j;
      continue;
    }

    if (ch === '?') {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      tokens.push({ type: 'param', value: sql.slice(i, j), start });
      i = j;
      continue;
    }

    if (ch === ':' && sql[i + 1] === ':') {
      tokens.push({ type: 'op', value: '::', start });
      i += 2;
      continue;
    }

    if ((ch === ':' || ch === '@' || ch === '$') && i + 1 < n && (isIdPart(sql[i + 1]) || (ch === '@' && sql[i + 1] === '@'))) {
      let j = i + 1;
      if (ch === '@' && sql[j] === '@') j++;
      while (j < n && isIdPart(sql[j])) j++;
      if (ch === '$' && sql[j] === '$') {
        throw new SqlGuardError('Dollar-quoted strings are not allowed in SQL');
      }
      if (ch === '$' && sql.slice(i + 1, j).includes('$')) {
        throw new SqlGuardError('Dollar-quoted strings are not allowed in SQL');
      }
      tokens.push({ type: 'param', value: sql.slice(i, j), start });
      i = j;
      continue;
    }

    if (ch === '$') throw new SqlGuardError('Dollar-quoted strings are not allowed in SQL');

    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'op', value: ch, start });
      i++;
      continue;
    }

    throw new SqlGuardError(`Unsupported character in SQL: ${JSON.stringify(ch)}`);
  }

  return tokens;
}

// ─── Raw statements ─────────────────────────────────────

/** Statement types an agent may run through raw SQL. Schema changes go
 *  through the dedicated DDL routes, which validate every fragment. */
const ALLOWED_FIRST_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'EXPLAIN']);
const READ_FIRST_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);

/** Unquoted keywords that are refused anywhere in a raw statement. */
const FORBIDDEN_KEYWORDS = new Set([
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'TRIGGER',
  'COPY', 'LOAD', 'GRANT', 'REVOKE', 'OUTFILE', 'DUMPFILE',
]);

/** Keywords that may legitimately sit immediately before INTO. */
const INTO_PREDECESSORS = new Set(['INSERT', 'REPLACE', 'IGNORE', 'ABORT', 'FAIL', 'ROLLBACK']);

/** Functions that read/write files, load code, or execute SQL from a string. */
const FORBIDDEN_FUNCTIONS = new Set([
  'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'zipfile',
  'sqlar_compress', 'sqlar_uncompress', 'load_file', 'sys_eval', 'sys_exec',
  'lo_import', 'lo_export', 'lo_get', 'lo_put', 'lo_from_bytea',
  'set_config', 'current_setting', 'dblink', 'dblink_exec', 'dblink_connect',
]);
const FORBIDDEN_FUNCTION_PATTERNS = [/^pragma_/i, /^pg_/i, /^sqlite_/i, /^dblink/i, /_to_xml/i, /^query_to_/i];

/** Names (identifiers or string literals) that are never storage tables. */
const FORBIDDEN_NAME_PATTERNS = [
  /^sqlite_/i, /^pg_/i, /^pragma_/i,
  /^information_schema$/i, /^performance_schema$/i, /^mysql$/i,
  /^agenticmail_storage_meta$/i,
];

export function isForbiddenName(name: string): boolean {
  return FORBIDDEN_NAME_PATTERNS.some((re) => re.test(name));
}

export interface RawSqlAnalysis {
  /** The statement to execute, with trailing semicolons removed. */
  sql: string;
  /** Upper-cased first keyword. */
  firstKeyword: string;
  kind: 'read' | 'write';
  /** Every identifier-shaped token (unquoted words and quoted identifiers). */
  identifiers: string[];
  /** Every string literal value. */
  strings: string[];
}

/**
 * Lex a raw agent statement and enforce the statement-level policy:
 * exactly one statement, an allowed statement type, no forbidden keyword or
 * function. Table ownership is the caller's job — it needs the database —
 * using {@link RawSqlAnalysis.identifiers} and {@link RawSqlAnalysis.strings}.
 */
export function analyzeRawSql(sql: unknown, dialect = 'sqlite'): RawSqlAnalysis {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlGuardError('sql must be a non-empty string');
  if (sql.length > 100_000) throw new SqlGuardError('sql is too long');

  const tokens = tokenizeSql(sql, dialect);
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].type === 'op' && tokens[end - 1].value === ';') end--;
  const body = tokens.slice(0, end);
  if (!body.length) throw new SqlGuardError('sql must contain a statement');
  if (body.some((t) => t.type === 'op' && t.value === ';')) {
    throw new SqlGuardError('Only a single SQL statement is allowed');
  }

  const first = body[0];
  const firstKeyword = first.type === 'word' ? first.value.toUpperCase() : '';
  if (!ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    throw new SqlGuardError(
      `Statement type not allowed in raw SQL: ${firstKeyword || first.value}. Allowed: ${[...ALLOWED_FIRST_KEYWORDS].join(', ')}`,
      403,
    );
  }

  const identifiers: string[] = [];
  const strings: string[] = [];
  for (let k = 0; k < body.length; k++) {
    const t = body[k];
    if (t.type === 'string') { strings.push(t.value); continue; }
    if (t.type === 'qident') { identifiers.push(t.value); continue; }
    if (t.type !== 'word') continue;

    const upper = t.value.toUpperCase();
    if (FORBIDDEN_KEYWORDS.has(upper)) {
      throw new SqlGuardError(`Operation not allowed: ${upper}`, 403);
    }
    if (upper === 'INTO') {
      const prev = body[k - 1];
      if (!prev || prev.type !== 'word' || !INTO_PREDECESSORS.has(prev.value.toUpperCase())) {
        throw new SqlGuardError('INTO is only allowed in INSERT/REPLACE statements', 403);
      }
    }
    const next = body[k + 1];
    if (next && next.type === 'op' && next.value === '(') {
      const lower = t.value.toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(lower) || FORBIDDEN_FUNCTION_PATTERNS.some((re) => re.test(lower))) {
        throw new SqlGuardError(`Function not allowed: ${t.value}`, 403);
      }
    }
    identifiers.push(t.value);
  }

  const cut = end < tokens.length ? tokens[end].start : sql.length;
  return {
    sql: sql.slice(0, cut).trim(),
    firstKeyword,
    kind: READ_FIRST_KEYWORDS.has(firstKeyword) ? 'read' : 'write',
    identifiers,
    strings,
  };
}

// ─── Expression fragments ───────────────────────────────

const EXPR_KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'GLOB', 'ESCAPE',
  'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
  'CAST', 'AS', 'TEXT', 'INTEGER', 'INT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN',
  'COLLATE', 'NOCASE', 'BINARY',
]);

const EXPR_FUNCTIONS = new Set([
  'abs', 'coalesce', 'ifnull', 'nullif', 'iif', 'length', 'lower', 'upper',
  'trim', 'ltrim', 'rtrim', 'substr', 'substring', 'replace', 'instr', 'round',
  'typeof', 'hex', 'json_valid', 'json_type', 'json_extract', 'json_array_length',
  'datetime', 'date', 'time', 'julianday', 'strftime', 'unixepoch', 'now',
  'min', 'max',
]);

const AGGREGATE_FUNCTIONS = new Set(['count', 'sum', 'avg', 'total', 'group_concat']);

const EXPR_OPS = new Set(['(', ')', ',', '+', '-', '*', '/', '%', '<', '>', '=', '!', '|', '&', '~']);

export interface ExpressionOptions {
  label: string;
  /** Column names (any case) the expression may reference. */
  columns?: Iterable<string>;
  dialect?: string;
  maxLength?: number;
  /** Allow COUNT/SUM/AVG/... (HAVING clauses). */
  allowAggregates?: boolean;
}

/**
 * Validate an expression fragment against a strict whitelist: literals,
 * columns of the table, a fixed set of operators, keywords and scalar
 * functions. No subqueries, no table references, no qualified names, no
 * parameters, no statement separators, no comments. Parentheses must
 * balance and there may be no top-level comma, so the fragment cannot
 * close the construct it is spliced into.
 *
 * Returns the trimmed expression.
 */
export function validateSqlExpression(expr: unknown, opts: ExpressionOptions): string {
  const { label } = opts;
  if (typeof expr !== 'string') throw new SqlGuardError(`${label} must be a string`);
  const trimmed = expr.trim();
  const maxLength = opts.maxLength ?? 500;
  if (!trimmed) throw new SqlGuardError(`${label} must not be empty`);
  if (trimmed.length > maxLength) throw new SqlGuardError(`${label} is too long (max ${maxLength} chars)`);

  const columns = new Set([...(opts.columns ?? [])].map((c) => c.toLowerCase()));
  let tokens: SqlToken[];
  try {
    tokens = tokenizeSql(trimmed, opts.dialect ?? 'sqlite');
  } catch (err: any) {
    throw new SqlGuardError(`${label}: ${err?.message || 'invalid expression'}`);
  }

  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const next = tokens[k + 1];
    switch (t.type) {
      case 'number':
        if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][0-9]*)?$|^0[xX][0-9A-Fa-f]+$/.test(t.value)) {
          throw new SqlGuardError(`${label} contains an invalid number: ${t.value}`);
        }
        break;
      case 'string':
        break;
      case 'param':
        throw new SqlGuardError(`${label} must not contain bound parameters`);
      case 'qident':
        if (!columns.has(t.value.toLowerCase())) {
          throw new SqlGuardError(`${label} references "${t.value}", which is not a column of this table`);
        }
        break;
      case 'word': {
        const upper = t.value.toUpperCase();
        const lower = t.value.toLowerCase();
        const isCall = next?.type === 'op' && next.value === '(';
        if (isCall && (EXPR_FUNCTIONS.has(lower) || (opts.allowAggregates && AGGREGATE_FUNCTIONS.has(lower)))) break;
        if (upper === 'IN' && !isCall) {
          // `x IN tbl` is a table reference in SQLite; only `x IN (...)`.
          throw new SqlGuardError(`${label}: IN must be followed by a parenthesised list`);
        }
        if (EXPR_KEYWORDS.has(upper)) break;
        if (!isCall && columns.has(lower)) break;
        throw new SqlGuardError(
          `${label} references "${t.value}", which is not a column of this table or an allowed keyword/function`,
        );
      }
      case 'op':
        if (!EXPR_OPS.has(t.value)) {
          throw new SqlGuardError(`${label} contains a forbidden token: ${t.value}`);
        }
        if (t.value === '(') depth++;
        if (t.value === ')') {
          depth--;
          if (depth < 0) throw new SqlGuardError(`${label} has unbalanced parentheses`);
        }
        if (t.value === ',' && depth === 0) {
          throw new SqlGuardError(`${label} must not contain a top-level comma`);
        }
        break;
    }
  }
  if (depth !== 0) throw new SqlGuardError(`${label} has unbalanced parentheses`);
  return trimmed;
}
