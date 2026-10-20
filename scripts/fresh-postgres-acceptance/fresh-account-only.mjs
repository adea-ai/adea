// The fresh-account-only rule.
//
// The acceptance lane creates synthetic accounts on a fresh PostgreSQL
// instance. It never imports a legacy identity, password or session, and it
// never writes to a second database. These are the constructs that would make
// either happen in the scoped sources.
//
// The gate reads source text. Comments are stripped first, so a comment that
// names the rule is not a violation, and the SQL in a string literal is not
// stripped, so a copy statement is a violation wherever it is written.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The files the gate does not scan.
 *
 * The first one holds the patterns themselves, so it would match its own
 * source. The second one is the scanner's test data, and the synthetic policy
 * lane never opens a database.
 */
export const FRESH_ACCOUNT_SCAN_EXCLUSIONS = Object.freeze([
  'scripts/fresh-postgres-acceptance/fresh-account-only.mjs',
  'scripts/fresh-postgres-acceptance/policy.test.mjs',
])

/** The scoped directory the rule covers. */
export const FRESH_ACCOUNT_SCOPE = 'scripts/fresh-postgres-acceptance'

/** The constructs that would break the fresh-account-only rule. */
export const FRESH_ACCOUNT_FORBIDDEN = Object.freeze([
  Object.freeze({
    kind: 'legacy-environment',
    pattern: /\bNEON_[A-Z0-9_]+\b/,
    detail: 'a legacy environment variable',
  }),
  Object.freeze({
    kind: 'legacy-host',
    pattern: /\bneon\.tech\b/i,
    detail: 'a legacy provider host',
  }),
  Object.freeze({
    kind: 'legacy-import',
    pattern: /\b(?:import|load|copy|migrate|reconcile|seed|sync|read|restore)Legacy[A-Za-z0-9_]*/i,
    detail: 'a legacy identity import',
  }),
  Object.freeze({
    kind: 'legacy-import',
    pattern: /\blegacy[A-Za-z0-9_]*(?:Import|Seed|Copy|Reconcile|Migration|Restore)\b/i,
    detail: 'a legacy identity import',
  }),
  Object.freeze({
    kind: 'dual-write',
    pattern: /\bdual[ _-]?writes?\b/i,
    detail: 'a second write target',
  }),
  Object.freeze({
    kind: 'row-copy',
    pattern: /\bINSERT\s+INTO\b[^;]*\bSELECT\b/i,
    detail: 'a row copy out of another table',
  }),
  Object.freeze({
    kind: 'row-copy',
    pattern: /\\copy\b/i,
    detail: 'a server-side row copy',
  }),
  Object.freeze({
    kind: 'row-copy',
    pattern: /\bCOPY\s+[A-Za-z_"][^;]*\bFROM\b/i,
    detail: 'a server-side row copy',
  }),
])

/**
 * The constructs that are written in more than one spelling.
 *
 * The text is compared with the separators removed, so a camel case name, a
 * snake case name and a spaced name are all caught by one rule.
 */
export const FRESH_ACCOUNT_FORBIDDEN_NORMALIZED = Object.freeze([
  Object.freeze({
    kind: 'dual-write',
    needle: 'dualwrite',
    detail: 'a second write target',
  }),
])

const DATABASE_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s'"`)]+/gi
const LOOPBACK_HOSTNAMES = new Set(['', '127.0.0.1', 'localhost', '[::1]', '::1'])
const ROUTING_QUERY_NAMES = ['host', 'hostaddr']

/**
 * Removes comments, so a comment that names the rule is not a violation.
 *
 * A string literal keeps its text, because a copy statement or a legacy
 * environment name is written as one.
 */
export function stripComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * The violations one source file carries.
 *
 * Every violation names the construct, so a failure says what would break the
 * rule instead of only that something did.
 */
export function freshAccountOnlyViolations(path, text) {
  const code = stripComments(text)
  const violations = []
  for (const rule of FRESH_ACCOUNT_FORBIDDEN) {
    const match = rule.pattern.exec(code)
    if (match) {
      violations.push({
        path,
        kind: rule.kind,
        detail: rule.detail,
        evidence: match[0].slice(0, 80),
      })
    }
  }
  const normalized = code.toLowerCase().replace(/[ _-]/g, '')
  for (const rule of FRESH_ACCOUNT_FORBIDDEN_NORMALIZED) {
    if (normalized.includes(rule.needle)) {
      violations.push({
        path,
        kind: rule.kind,
        detail: rule.detail,
        evidence: rule.needle,
      })
    }
  }
  for (const match of code.matchAll(DATABASE_URL_PATTERN)) {
    const raw = match[0]
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      violations.push({
        path,
        kind: 'database-target',
        detail: 'an unparsable database target',
        evidence: raw.slice(0, 80),
      })
      continue
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      violations.push({
        path,
        kind: 'remote-database-target',
        detail: 'a database target outside the loopback interface',
        evidence: raw.slice(0, 80),
      })
    }
    for (const name of ROUTING_QUERY_NAMES) {
      const value = parsed.searchParams.get(name)
      if (value !== null && !LOOPBACK_HOSTNAMES.has(value.toLowerCase())) {
        violations.push({
          path,
          kind: 'database-routing-override',
          detail: 'a database routing override away from the loopback interface',
          evidence: raw.slice(0, 80),
        })
      }
    }
  }
  return violations
}

/**
 * The scoped source files, relative to the repository root.
 *
 * Every source file in the scope is scanned, so a new file is covered without
 * a list to keep in step with it. The excluded files are named above.
 */
export function freshAccountScopeFiles(root) {
  const directory = join(root, FRESH_ACCOUNT_SCOPE)
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
        continue
      }
      if (!/\.(ts|mjs)$/.test(entry)) continue
      if (FRESH_ACCOUNT_SCAN_EXCLUSIONS.includes(relativePath)) continue
      files.push(relativePath)
    }
  }
  walk(directory)
  return files.toSorted()
}

/**
 * Scans the whole scope and returns every violation it finds.
 *
 * A file that cannot be read is a violation: a source the gate cannot read is
 * a source the gate cannot clear.
 */
export function scanFreshAccountScope(root) {
  const violations = []
  for (const relativePath of freshAccountScopeFiles(root)) {
    let text
    try {
      text = readFileSync(join(root, relativePath), 'utf8')
    } catch (error) {
      violations.push({
        path: relativePath,
        kind: 'unreadable-source',
        detail: 'the source could not be read',
        evidence: error instanceof Error ? error.message : 'unknown error',
      })
      continue
    }
    violations.push(...freshAccountOnlyViolations(relativePath, text))
  }
  return violations
}

/**
 * Fails when the scope carries a violation.
 *
 * The failure names every violation, so the whole set is fixed in one pass.
 */
export function assertFreshAccountOnly(root) {
  const violations = scanFreshAccountScope(root)
  if (violations.length > 0) {
    const detail = violations
      .map((violation) => violation.path + ': ' + violation.kind + ' (' + violation.detail + ')')
      .join('; ')
    throw new Error('the fresh-account acceptance scope breaks the fresh-account rule: ' + detail)
  }
  return true
}
