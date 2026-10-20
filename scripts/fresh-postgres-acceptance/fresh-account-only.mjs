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

/**
 * The source files of this lane that live outside the scoped directory.
 *
 * The Railway-only target is the only target, so the lane's own runtime,
 * fixtures and proofs carry no legacy provider coupling either. The files are
 * named here, so the scope is explicit: a new lane file outside the scoped
 * directory is added to this list, and the gate fails on a file it cannot
 * read.
 *
 * The fresh-account rule is stricter than the no-Neon rule and is applied to
 * the acceptance sources only: these other files legitimately hold refusal
 * cases and template-built loopback URLs.
 */
export const FRESH_ACCOUNT_SCOPED_FILES = Object.freeze([
  'packages/auth/src/schema-init.ts',
  'packages/auth/tests/integration/schema-backup-restore.test.ts',
  'packages/auth/tests/integration/schema-init-runner.ts',
  'packages/db/tests/fixtures/canonical-boundary.ts',
  'scripts/capture-provisioning.mjs',
  'scripts/disposable-postgres-ci.ts',
  'scripts/disposable-postgres-cli.ts',
])

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
    // A SQL comment may sit between the two keywords, and a comment inside a
    // string literal is part of the statement.
    pattern: /\bINSERT(?:\s+|\/\*[\s\S]*?\*\/|--(?![A-Za-z0-9_$])[^\n]*)+INTO\b[^;]*\bSELECT\b/i,
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
 * The legacy provider constructs that this lane may not carry.
 *
 * The Railway target is the only target, so a source file of this lane names
 * no legacy provider environment variable, no legacy provider host and no
 * legacy provider package. A comment that names the rule is not a violation,
 * because the scan strips comments.
 */
export const NO_NEON_FORBIDDEN = Object.freeze([
  Object.freeze({
    kind: 'legacy-environment',
    pattern: /\bNEON_[A-Z0-9_]+\b/,
    detail: 'a legacy provider environment variable',
  }),
  Object.freeze({
    kind: 'legacy-host',
    pattern: /\bneon\.tech\b/i,
    detail: 'a legacy provider host',
  }),
  Object.freeze({
    kind: 'legacy-package',
    pattern: /@neondatabase\//,
    detail: 'a legacy provider package',
  }),
])

/**
 * The legacy provider coupling one source file carries.
 *
 * Every violation names the construct, so a failure says what would bring the
 * legacy provider back.
 */
export function noNeonViolations(path, text) {
  const code = stripComments(text)
  const violations = []
  for (const rule of NO_NEON_FORBIDDEN) {
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
  return violations
}

/**
 * The source files of this lane, wherever they live.
 *
 * The acceptance directory and the named lane files outside it. The lane
 * files are named, so the scope is explicit and a new one has to be added.
 */
export function laneSourceFiles(root) {
  const files = freshAccountScopeFiles(root)
  for (const scoped of FRESH_ACCOUNT_SCOPED_FILES) {
    if (!files.includes(scoped)) files.push(scoped)
  }
  return files.toSorted()
}

/**
 * Scans every lane source file for legacy provider coupling.
 *
 * A file that cannot be read is a violation: a source the gate cannot read is
 * a source the gate cannot clear.
 */
export function scanNoNeonScope(root) {
  const violations = []
  for (const relativePath of laneSourceFiles(root)) {
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
    violations.push(...noNeonViolations(relativePath, text))
  }
  return violations
}

/**
 * Fails when a lane source file carries legacy provider coupling.
 *
 * The failure names every violation, so the whole set is fixed in one pass.
 */
export function assertNoNeonInScope(root) {
  const violations = scanNoNeonScope(root)
  if (violations.length > 0) {
    const detail = violations
      .map((violation) => violation.path + ': ' + violation.kind + ' (' + violation.detail + ')')
      .join('; ')
    throw new Error('the lane scope still carries legacy provider coupling: ' + detail)
  }
  return true
}

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
 * The scan tracks strings, template literals and regular expressions, so a
 * comment marker inside a string literal does not hide the code around it. A
 * line that opens a block comment inside one string, calls a legacy import,
 * and closes the comment inside another string is code, and the code is
 * scanned. A string literal keeps its text, because a copy statement or a
 * legacy environment name is written as one.
 */
export function stripComments(text) {
  return scanCode(String(text ?? ''), 0)[0]
}

/** Copies one quoted string, honoring the escapes inside it. */
function scanQuoted(source, start, quote) {
  let literal = quote
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      literal += source.slice(index, index + 2)
      index += 2
      continue
    }
    literal += character
    index += 1
    if (character === quote) break
  }
  return [literal, index]
}

/** Copies one template literal, including the code in its interpolations. */
function scanTemplate(source, start) {
  let literal = '`'
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      literal += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (character === '$' && source[index + 1] === '{') {
      const [expression, end] = scanCode(source, index + 2, true)
      literal += '${' + expression + '}'
      index = end
      continue
    }
    literal += character
    index += 1
    if (character === '`') break
  }
  return [literal, index]
}

/** Copies one regular expression, or reports that the slash is a division. */
function scanRegularExpression(source, start) {
  let literal = '/'
  let index = start + 1
  let inCharacterClass = false
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      literal += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (character === '[') inCharacterClass = true
    if (character === ']') inCharacterClass = false
    if (character === '/' && !inCharacterClass) {
      literal += character
      index += 1
      // The flags of the expression are part of it.
      while (index < source.length && /[a-z]/.test(source[index])) {
        literal += source[index]
        index += 1
      }
      return [literal, index]
    }
    if (character === '\n') return [null, start]
    literal += character
    index += 1
  }
  return [null, start]
}

/** True when a slash at this point starts a regular expression and not a division. */
function regularExpressionAllowed(copied) {
  const trimmed = copied.replace(/\s+$/, '')
  if (trimmed.length === 0) return true
  const last = trimmed[trimmed.length - 1]
  if (last === ')' || last === ']' || last === '}') return false
  if (/[A-Za-z0-9_$]/.test(last)) {
    const identifier = /([A-Za-z0-9_$]+)$/.exec(trimmed)
    const word = identifier ? identifier[1] : ''
    return [
      'return',
      'typeof',
      'instanceof',
      'in',
      'of',
      'new',
      'delete',
      'void',
      'case',
      'do',
      'else',
      'yield',
      'await',
    ].includes(word)
  }
  return true
}

/**
 * Copies source text, dropping the comments and keeping everything else.
 *
 * When `stopAtBrace` is set, the scan ends at the matching closing brace, so
 * a template interpolation is copied with its own code.
 */
function scanCode(source, start, stopAtBrace = false) {
  let copied = ''
  let index = start
  let depth = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (stopAtBrace && character === '}' && depth === 0) break
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      // A comment becomes whitespace, so the code around it cannot be joined
      // into a different token than it was.
      copied += ' '
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index += 2
      // A comment becomes whitespace, so `await/*note*/importLegacyIdentities`
      // stays two tokens and the import is still read as an import.
      copied += ' '
      continue
    }
    if (character === '"' || character === "'") {
      const [literal, end] = scanQuoted(source, index, character)
      copied += literal
      index = end
      continue
    }
    if (character === '`') {
      const [literal, end] = scanTemplate(source, index)
      copied += literal
      index = end
      continue
    }
    if (character === '/' && regularExpressionAllowed(copied)) {
      const [literal, end] = scanRegularExpression(source, index)
      if (literal !== null) {
        copied += literal
        index = end
        continue
      }
    }
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    copied += character
    index += 1
  }
  return [copied, index]
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
  // A comment between the parts of a name is still a name, so the comments
  // are removed before the text is compared without its separators.
  const normalized = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--(?![A-Za-z0-9_$])[^\n]*/g, ' ')
    .toLowerCase()
    .replace(/[ _-]/g, '')
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
