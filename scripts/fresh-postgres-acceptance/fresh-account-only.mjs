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

/**
 * The lexical helpers the rules are written with.
 *
 * Every search below walks the text once, forwards only, and never rewinds.
 * A rule therefore costs the length of the text and no more, whatever the
 * input is: an unbounded pattern that backtracks would let a long input make
 * a scan quadratic, which is what the security scanner reports.
 */

/** True for the characters a JavaScript identifier may hold. */
function isWordCharacter(character) {
  if (character === undefined) return false
  const code = character.charCodeAt(0)
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    character === '_'
  )
}

/** True when the text at the index starts with the word, on a word boundary. */
function startsWithWord(text, index, word, caseInsensitive) {
  if (index + word.length > text.length) return false
  for (let offset = 0; offset < word.length; offset += 1) {
    const character = text[index + offset]
    const expected = word[offset]
    if (character === expected) continue
    if (caseInsensitive && character.toLowerCase() === expected.toLowerCase()) continue
    return false
  }
  return !isWordCharacter(text[index - 1]) && !isWordCharacter(text[index + word.length])
}

/** The index after the run of word characters that starts at the index. */
function wordEnd(text, index) {
  let cursor = index
  while (cursor < text.length && isWordCharacter(text[cursor])) cursor += 1
  return cursor
}

/** The index after the whitespace that starts at the index. */
function whitespaceEnd(text, index) {
  let cursor = index
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
  return cursor
}

/**
 * The index after the SQL comment that starts at the index.
 *
 * A block comment ends at its closing marker, and a line comment ends at the
 * line break. The index is unchanged when there is no comment. A block
 * comment that is never closed ends the text, so the search never revisits
 * what it has already read.
 */
function sqlCommentEnd(text, index) {
  if (text[index] === '/' && text[index + 1] === '*') {
    const closing = text.indexOf('*/', index + 2)
    return closing === -1 ? text.length : closing + 2
  }
  if (text[index] === '-' && text[index + 1] === '-' && !isWordCharacter(text[index + 2])) {
    const lineBreak = text.indexOf('\n', index)
    return lineBreak === -1 ? text.length : lineBreak
  }
  return index
}

/** A legacy provider environment variable, such as `NEON_AUTH_BASE_URL`. */
function detectLegacyEnvironment(text) {
  const marker = 'NEON_'
  let index = text.indexOf(marker)
  while (index !== -1 && index < text.length) {
    // The boundary is checked first, and an occurrence inside a word skips
    // that word: the marker cannot match inside a word, so the rest of the
    // word does not have to be read again for every occurrence in it.
    //
    // The search resumes after the word, so it always moves forward. A word
    // that ends at a delimiter would otherwise be skipped again and again
    // from the same place, and the scan would never end.
    if (isWordCharacter(text[index - 1])) {
      index = text.indexOf(marker, wordEnd(text, index))
      continue
    }
    const end = wordEnd(text, index)
    if (end > index + marker.length) {
      return text.slice(index, end)
    }
    index = text.indexOf(marker, index + 1)
  }
  return null
}

/** A legacy provider host, such as `db.neon.tech`. */
function detectLegacyHost(text) {
  const host = 'neon.tech'
  const lower = text.toLowerCase()
  let index = lower.indexOf(host)
  while (index !== -1) {
    if (startsWithWord(text, index, host, true)) return text.slice(index, index + host.length)
    index = lower.indexOf(host, index + 1)
  }
  return null
}

/** A legacy provider package, such as `@neondatabase/serverless`. */
function detectLegacyPackage(text) {
  const name = '@neondatabase/'
  const index = text.indexOf(name)
  return index === -1 ? null : text.slice(index, index + name.length)
}

/** A call that imports a legacy identity, such as `importLegacyIdentities`. */
function detectLegacyImport(text) {
  const prefixes = [
    'import',
    'load',
    'copy',
    'migrate',
    'reconcile',
    'seed',
    'sync',
    'read',
    'restore',
  ]
  const lower = text.toLowerCase()
  let index = 0
  while (index < text.length) {
    for (const prefix of prefixes) {
      // The prefix is the start of a word, and the marker follows it directly.
      if (isWordCharacter(text[index - 1])) continue
      if (!lower.startsWith(prefix, index)) continue
      const afterPrefix = index + prefix.length
      if (!lower.startsWith('legacy', afterPrefix)) continue
      // The word after the marker is part of the name.
      const end = wordEnd(text, afterPrefix + 'legacy'.length)
      return text.slice(index, end)
    }
    index += 1
  }
  return null
}

/** A legacy identity import written the other way round, such as `legacyUserImport`. */
function detectLegacySuffix(text) {
  const suffixes = ['import', 'seed', 'copy', 'reconcile', 'migration', 'restore']
  const lower = text.toLowerCase()
  let index = lower.indexOf('legacy')
  while (index !== -1) {
    if (!isWordCharacter(text[index - 1])) {
      // The name is the word that starts with the marker, and the suffix ends
      // that word.
      const end = wordEnd(text, index)
      for (const suffix of suffixes) {
        if (end - index < suffix.length) continue
        if (lower.slice(end - suffix.length, end) !== suffix) continue
        if (!isWordCharacter(text[end - suffix.length - 1])) continue
        return text.slice(index, end)
      }
    }
    index = lower.indexOf('legacy', index + 1)
  }
  return null
}

/**
 * The index of a word inside a range, or -1 when the range holds no such word.
 *
 * The range is read once, forwards only, and the text is never copied or
 * lowercased as a whole, so a search costs the length of its range and no
 * more however many searches there are.
 */
function findWordWithin(text, from, to, word) {
  let index = from
  while (index < to) {
    if (startsWithWord(text, index, word, true)) return index
    index += 1
  }
  return -1
}

/**
 * A statement that copies rows out of another table.
 *
 * The scan is a single forward pass. It looks for `INSERT`, then for the
 * `INTO` that may follow it across whitespace and SQL comments, and then for
 * the `SELECT` that may follow that before the statement ends. A new `INSERT`
 * seen on the way replaces the candidate, so the scan never has to go back.
 *
 * A line comment runs to the end of its line, and the keyword that follows it
 * may sit inside that extent. The extent is read once to find it, so the
 * result is the same as a backtracking pattern would give, and the cost is
 * still the length of the text.
 */
function detectRowCopy(text) {
  const lower = text.toLowerCase()
  let index = 0
  let candidate = -1
  let phase = 'insert'
  while (index < lower.length) {
    if (phase === 'select') {
      if (text[index] === ';') {
        candidate = -1
        phase = 'insert'
        index += 1
        continue
      }
      if (startsWithWord(lower, index, 'select', true)) {
        return text.slice(candidate, index + 'select'.length)
      }
      if (startsWithWord(lower, index, 'insert', true)) candidate = index
      index += 1
      continue
    }
    if (phase === 'into' && startsWithWord(lower, index, 'into', true)) {
      phase = 'select'
      index += 'into'.length
      continue
    }
    if (startsWithWord(lower, index, 'insert', true)) {
      candidate = index
      phase = 'into'
      index += 'insert'.length
      continue
    }
    if (candidate >= 0) {
      const whitespace = whitespaceEnd(text, index)
      if (whitespace > index) {
        index = whitespace
        continue
      }
      if (text[index] === '/' && text[index + 1] === '*') {
        // A block comment is one unit: it is skipped whole.
        const closing = text.indexOf('*/', index + 2)
        index = closing === -1 ? text.length : closing + 2
        continue
      }
      if (text[index] === '-' && text[index + 1] === '-' && !isWordCharacter(text[index + 2])) {
        // A line comment runs to the end of its line, and the keyword that
        // follows the statement may sit inside that extent.
        const lineBreak = text.indexOf('\n', index)
        const extent = lineBreak === -1 ? text.length : lineBreak
        const into = findWordWithin(text, index, extent, 'into')
        if (into !== -1) {
          phase = 'select'
          index = into + 'into'.length
          continue
        }
        index = extent
        continue
      }
      // The statement did not continue with `INTO`, so the candidate is void.
      candidate = -1
      phase = 'insert'
      index += 1
      continue
    }
    index += 1
  }
  return null
}

/** A server-side copy, such as `\copy`. */
function detectServerSideCopy(text) {
  const marker = '\\copy'
  const lower = text.toLowerCase()
  let index = lower.indexOf(marker)
  while (index !== -1) {
    if (!isWordCharacter(text[index + marker.length])) {
      return text.slice(index, index + marker.length)
    }
    index = lower.indexOf(marker, index + 1)
  }
  return null
}

/** A server-side copy written as `COPY … FROM`, such as `COPY app.users FROM other`. */
function detectCopyFrom(text) {
  const lower = text.toLowerCase()
  let index = 0
  while (index < lower.length) {
    if (startsWithWord(lower, index, 'copy', true)) {
      const afterKeyword = whitespaceEnd(lower, index + 'copy'.length)
      if (afterKeyword > index + 'copy'.length) {
        const target = text[afterKeyword]
        if (target !== undefined && /[A-Za-z_"]/.test(target)) {
          // The source has to be named before the statement ends. The statement
          // is read once, and a statement without a `FROM` ends the search: a
          // later `COPY` in the same statement cannot match either.
          let cursor = afterKeyword + 1
          while (cursor < lower.length) {
            if (text[cursor] === ';') break
            if (startsWithWord(lower, cursor, 'from', true)) {
              return text.slice(index, cursor + 'from'.length)
            }
            cursor += 1
          }
          index = cursor > index ? cursor : index + 1
          continue
        }
      }
    }
    index += 1
  }
  return null
}

/**
 * The constructs that would break the fresh-account-only rule.
 *
 * Every rule is a bounded, linear lexical scan. None of them uses a pattern
 * that can backtrack, so a long input cannot make a rule cost more than the
 * length of the text.
 */
export const FRESH_ACCOUNT_FORBIDDEN = Object.freeze([
  Object.freeze({
    kind: 'legacy-environment',
    detail: 'a legacy environment variable',
    detect: detectLegacyEnvironment,
  }),
  Object.freeze({
    kind: 'legacy-host',
    detail: 'a legacy provider host',
    detect: detectLegacyHost,
  }),
  Object.freeze({
    kind: 'legacy-import',
    detail: 'a legacy identity import',
    detect: detectLegacyImport,
  }),
  Object.freeze({
    kind: 'legacy-import',
    detail: 'a legacy identity import',
    detect: detectLegacySuffix,
  }),
  Object.freeze({
    kind: 'row-copy',
    // A SQL comment may sit between the two keywords, and a comment inside a
    // string literal is part of the statement.
    detail: 'a row copy out of another table',
    detect: detectRowCopy,
  }),
  Object.freeze({
    kind: 'row-copy',
    detail: 'a server-side row copy',
    detect: detectServerSideCopy,
  }),
  Object.freeze({
    kind: 'row-copy',
    detail: 'a server-side row copy',
    detect: detectCopyFrom,
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
    detail: 'a legacy provider environment variable',
    detect: detectLegacyEnvironment,
  }),
  Object.freeze({
    kind: 'legacy-host',
    detail: 'a legacy provider host',
    detect: detectLegacyHost,
  }),
  Object.freeze({
    kind: 'legacy-package',
    detail: 'a legacy provider package',
    detect: detectLegacyPackage,
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
    const evidence = rule.detect(code)
    if (evidence !== null) {
      violations.push({
        path,
        kind: rule.kind,
        detail: rule.detail,
        evidence: evidence.slice(0, 80),
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
 * snake case name and a spaced name are all caught by one rule. The comparison
 * runs over the scanned segments, so a comment marker inside a string cannot
 * remove the code around it.
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
 * comment marker inside a string literal does not hide the code around it: a
 * line that opens a block comment inside one string, calls a legacy import,
 * and closes the comment inside another string is code, and the code is
 * scanned. A string literal keeps its text, because a copy statement or a
 * legacy environment name is written as one.
 */
export function stripComments(text) {
  return scanSource(String(text ?? '')).text
}

/**
 * The text of a source file with the separators removed.
 *
 * The comparison this serves is about a name, and a name may be written with
 * spaces, underscores or dashes between its parts, and with a comment between
 * them. The comparison is made over the scanned segments, never over the raw
 * text: a string that holds a comment marker must not swallow the code around
 * it. A comment marker inside a string is removed from that string only.
 */
export function normalizeForNeedle(text) {
  const { segments } = scanSource(String(text ?? ''))
  let normalized = ''
  for (const segment of segments) {
    const content = segment.kind === 'string' ? removeSqlComments(segment.text) : segment.text
    normalized += content.toLowerCase().replace(/[ _-]/g, '')
  }
  return normalized
}

/**
 * Removes the SQL comment markers a string literal may carry.
 *
 * The scan is a single forward pass: a block comment ends at its closing
 * marker, a line comment ends at the line break, and a block comment that is
 * never closed ends the text. The text is never revisited, so a long input
 * cannot make this cost more than the length of the text.
 */
function removeSqlComments(text) {
  let result = ''
  let index = 0
  while (index < text.length) {
    const comment = sqlCommentEnd(text, index)
    if (comment !== index) {
      result += ' '
      index = comment
      continue
    }
    result += text[index]
    index += 1
  }
  return result
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

/** True for whitespace, read one character at a time. */
function isWhitespace(character) {
  if (character === undefined) return false
  return /\s/.test(character)
}

/** True for the characters an identifier may hold, the dollar sign included. */
function isIdentifierCharacter(character) {
  if (character === undefined) return false
  const code = character.charCodeAt(0)
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    character === '_' ||
    character === '$'
  )
}

/** The keywords a regular expression may follow. */
const REGULAR_EXPRESSION_KEYWORDS = new Set([
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
])

/**
 * True when a slash at this point starts a regular expression and not a division.
 *
 * Only the characters at the end of the copied text matter, so the check reads
 * them backwards. It never copies the text, so a long source with many slashes
 * does not make the scan quadratic.
 */
function regularExpressionAllowed(copied) {
  let cursor = copied.length - 1
  while (cursor >= 0 && isWhitespace(copied[cursor])) cursor -= 1
  if (cursor < 0) return true
  const last = copied[cursor]
  if (last === ')' || last === ']' || last === '}') return false
  if (isIdentifierCharacter(last)) {
    let start = cursor
    while (start >= 0 && isIdentifierCharacter(copied[start])) start -= 1
    return REGULAR_EXPRESSION_KEYWORDS.has(copied.slice(start + 1, cursor + 1))
  }
  return true
}

/**
 * Scans a range of source text.
 *
 * The result is the text with the comments removed, the segments it was built
 * from and the index the scan stopped at. A segment is either code or a
 * string literal, so a later step can treat the two differently: a comment
 * marker inside a string belongs to that string and to nothing else.
 *
 * When `stopAtBrace` is set, the scan ends at the closing brace that matches
 * the opening one. Comments and strings are skipped while that is counted, so
 * a brace inside a comment or inside a string never ends the range: the code
 * of a template interpolation is code, and it is scanned as code.
 */
function scanRange(source, start, stopAtBrace) {
  const segments = []
  let text = ''
  let code = ''
  let index = start
  let depth = 0
  const addCode = (value) => {
    if (!value) return
    text += value
    code += value
    segments.push({ kind: 'code', text: value })
  }
  const addString = (value) => {
    if (!value) return
    text += value
    segments.push({ kind: 'string', text: value })
  }
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (stopAtBrace && character === '}' && depth === 0) break
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      // A comment becomes whitespace, so the code around it cannot be joined
      // into a different token than it was.
      addCode(' ')
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index += 2
      // A comment becomes whitespace, so `await/*note*/importLegacyIdentities`
      // stays two tokens and the import is still read as an import. A brace
      // inside the comment is part of the comment and does not close a range.
      addCode(' ')
      continue
    }
    if (character === '"' || character === "'") {
      const [literal, end] = scanQuoted(source, index, character)
      addString(literal)
      index = end
      continue
    }
    if (character === '`') {
      const [parts, end] = scanTemplate(source, index)
      for (const part of parts) {
        if (part.kind === 'string') addString(part.text)
        else addCode(part.text)
      }
      index = end
      continue
    }
    if (character === '/' && regularExpressionAllowed(code)) {
      const [literal, end] = scanRegularExpression(source, index)
      if (literal !== null) {
        addCode(literal)
        index = end
        continue
      }
    }
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    addCode(character)
    index += 1
  }
  return { text, segments, code, index }
}

/**
 * Scans a source file.
 *
 * The result is the text with the comments removed and the segments it was
 * built from.
 */
function scanSource(source) {
  const scanned = scanRange(source, 0, false)
  return { text: scanned.text, segments: scanned.segments }
}

/**
 * Copies a template literal.
 *
 * The literal parts of a template are a string, and the expressions inside its
 * interpolations are code. The interpolation is scanned with the same rules
 * as the rest of the file, so a comment or a string inside it cannot end it
 * early and hide the code after it.
 */
function scanTemplate(source, start) {
  const parts = []
  let literal = ''
  let index = start + 1
  const flush = () => {
    if (literal.length > 0) {
      parts.push({ kind: 'string', text: literal })
      literal = ''
    }
  }
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      literal += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (character === '$' && source[index + 1] === '{') {
      flush()
      const scanned = scanRange(source, index + 2, true)
      for (const segment of scanned.segments) parts.push(segment)
      index = scanned.index
      if (source[index] === '}') index += 1
      continue
    }
    literal += character
    index += 1
    if (character === '`') break
  }
  flush()
  return [parts, index]
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
    const evidence = rule.detect(code)
    if (evidence !== null) {
      violations.push({
        path,
        kind: rule.kind,
        detail: rule.detail,
        evidence: evidence.slice(0, 80),
      })
    }
  }
  // A comment between the parts of a name is still a name, so the comments
  // are removed before the text is compared without its separators.
  // The comparison is made over the scanned segments, so a comment marker
  // inside a string cannot remove the code around it.
  const normalized = normalizeForNeedle(text)
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
