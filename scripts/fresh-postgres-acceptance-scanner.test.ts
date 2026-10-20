import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  assertFreshAccountOnly,
  assertNoNeonInScope,
  freshAccountOnlyViolations,
  freshAccountScopeFiles,
  laneSourceFiles,
  noNeonViolations,
  normalizeForNeedle,
  scanFreshAccountScope,
  scanNoNeonScope,
  stripComments,
} from './fresh-postgres-acceptance/fresh-account-only.mjs'

// The behavior of the fresh-account rule.
//
// The rule reads untrusted source text, so a rule that backtracks would let a
// long input make a scan quadratic. Every input here is shaped to be the worst
// case for a backtracking pattern: a long run of whitespace between the
// keywords of a statement, a long run of comment markers, and markers that
// never close. The bound is deliberately generous: a linear scan finishes
// these in milliseconds, and a quadratic one needs seconds.
//
// The inputs that are JavaScript and the inputs that are a string are both
// covered, because a comment marker means different things in the two. A
// marker in code comments the rest of the line out, and a marker inside a
// string is part of the statement.

const MAX_SCAN_MILLISECONDS = 5_000
const TAB_RUN = 50_000
const MARKER_RUN = 20_000

function elapsed(startedAt: number): number {
  return Date.now() - startedAt
}

describe('the fresh-account rule stays linear on adversarial input', () => {
  test('a long run of tabs between the keywords of a statement is still read', () => {
    const source = `await pool.query('INSERT${'\t'.repeat(TAB_RUN)}INTO app.users SELECT * FROM legacy.users')`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations.map((violation) => violation.kind)).toContain('row-copy')
  })

  test('a long run of tabs that never reaches the keyword is refused without a match', () => {
    const source = `INSERT${'\t'.repeat(TAB_RUN)}app.users`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations).toEqual([])
  })

  test('a long run of comment markers does not hide the statement behind it', () => {
    const source = `await pool.query('${'*//*'.repeat(MARKER_RUN)}INSERT INTO app.users SELECT * FROM legacy.users')`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations.map((violation) => violation.kind)).toContain('row-copy')
  })

  test('a long run of markers that never close does not hide the statement before it', () => {
    const source = `await pool.query('INSERT INTO app.users SELECT * FROM legacy.users${'/*x'.repeat(MARKER_RUN)}')`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations.map((violation) => violation.kind)).toContain('row-copy')
  })

  test('a long run of markers in code comments the statement out, and the scan stays fast', () => {
    const source = `${'/*x'.repeat(MARKER_RUN)}INSERT INTO app.users SELECT * FROM legacy.users`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    // The statement is inside a comment, so there is nothing to refuse.
    expect(violations).toEqual([])
  })

  test('a long run of legacy markers is still refused', () => {
    const source = `const value = process.env.${'NEON_'.repeat(MARKER_RUN)}AUTH_BASE_URL`
    const startedAt = Date.now()
    const violations = noNeonViolations('adversarial.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations.map((violation) => violation.kind)).toContain('legacy-environment')
  })

  test('the scope of the lane is scanned without a slow read', () => {
    const root = join(import.meta.dir, '..')
    const startedAt = Date.now()
    expect(scanFreshAccountScope(root)).toEqual([])
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
  })
})

describe('a marker inside a word never stops the scan', () => {
  // The scan has to end, and it has to end with the right answer. A scan that
  // does not move forward would hold the whole lane, so every case here runs
  // in a child process with a timeout: a scan that stops making progress is
  // reported as a failed test instead of hanging the run.

  const modulePath = join(import.meta.dir, 'fresh-postgres-acceptance', 'fresh-account-only.mjs')

  function scanInChild(source: string) {
    const probe = `import { freshAccountOnlyViolations } from ${JSON.stringify(modulePath)}
const kinds = freshAccountOnlyViolations('probe.ts', ${JSON.stringify(source)}).map(
  (violation) => violation.kind
)
console.log(JSON.stringify(kinds))`
    return spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      timeout: MAX_SCAN_MILLISECONDS,
      killSignal: 'SIGKILL',
    })
  }

  test('a marker inside a word followed by punctuation does not stop the scan', () => {
    const result = scanInChild('xNEON_FOO; NEON_AUTH_BASE_URL')
    expect(result.error?.message ?? '').toBe('')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(['legacy-environment'])
  })

  test('a marker inside a word followed by whitespace does not stop the scan', () => {
    const result = scanInChild('xNEON_FOO NEON_AUTH_BASE_URL')
    expect(result.error?.message ?? '').toBe('')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(['legacy-environment'])
  })

  test('a marker inside a word at the end of the text does not stop the scan', () => {
    const result = scanInChild('xNEON_FOO')
    expect(result.error?.message ?? '').toBe('')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual([])
  })

  test('a long run of markers inside words does not stop the scan', () => {
    const result = scanInChild('xNEON_FOO;'.repeat(MARKER_RUN))
    expect(result.error?.message ?? '').toBe('')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual([])
  })

  test('the same inputs are read in this process as well', () => {
    const cases: [string, string[]][] = [
      ['xNEON_FOO; NEON_AUTH_BASE_URL', ['legacy-environment']],
      ['xNEON_FOO NEON_AUTH_BASE_URL', ['legacy-environment']],
      ['xNEON_FOO', []],
    ]
    for (const [source, expected] of cases) {
      const kinds = freshAccountOnlyViolations('growth.ts', source).map(
        (violation) => violation.kind
      )
      expect(kinds, source).toEqual(expected)
    }
  })
})

describe('a candidate that does not match does not cost more as the text grows', () => {
  // Each input is a candidate that never matches, repeated so that the text
  // grows while the candidate stays unsuccessful. A scan that reads the rest
  // of the text again for every candidate costs the square of the length; a
  // forward-only scan does not.

  test('a copy without a source does not rescan the text for every copy', () => {
    const source = `COPY x ${'copy '.repeat(MARKER_RUN)}`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('growth.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations).toEqual([])
  })

  test('a legacy name inside one word does not rescan the word for every marker', () => {
    const source = `x${'NEON_'.repeat(MARKER_RUN)}`
    const startedAt = Date.now()
    const violations = noNeonViolations('growth.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations).toEqual([])
  })

  test('a long run of line comments does not copy the source for every comment', () => {
    const source = `await pool.query('${'-- note\n'.repeat(MARKER_RUN)}x')`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('growth.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations).toEqual([])
  })

  test('a long run of legacy names in one word does not rescan the word', () => {
    const source = `x${'legacy'.repeat(MARKER_RUN)}`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('growth.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations).toEqual([])
  })
})

describe('a candidate that matches is reported at once', () => {
  test('the first matching candidate ends the scan', () => {
    const source = `await pool.query('INSERT INTO app.users SELECT * FROM legacy.users')`
    const startedAt = Date.now()
    const violations = freshAccountOnlyViolations('immediate.ts', source)
    expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
    expect(violations.map((violation) => violation.kind)).toContain('row-copy')
  })

  test('the first matching copy, environment name and import are reported', () => {
    const cases: [string, string][] = [
      ["await pool.query('COPY app.users FROM legacy.users')", 'row-copy'],
      ['const url = process.env.NEON_AUTH_BASE_URL', 'legacy-environment'],
      ['await importLegacyIdentities(pool)', 'legacy-import'],
    ]
    for (const [source, kind] of cases) {
      const startedAt = Date.now()
      const violations = freshAccountOnlyViolations('immediate.ts', source)
      expect(elapsed(startedAt)).toBeLessThan(MAX_SCAN_MILLISECONDS)
      expect(violations.map((violation) => violation.kind)).toContain(kind)
    }
  })
})

describe('the fresh-account rule reads source the way the language does', () => {
  test('a comment is removed and a string keeps its text', () => {
    expect(stripComments('const a = 1 // note\nconst b = 2')).toBe('const a = 1  \nconst b = 2')
    expect(stripComments('/* note */const a = 1')).toBe(' const a = 1')
    expect(stripComments('const a = "/* note */"')).toBe('const a = "/* note */"')
    expect(stripComments("const a = 'it\\'s'")).toBe("const a = 'it\\'s'")
    expect(stripComments('const a = `x ${1 + 2} y`')).toContain('1 + 2')
    expect(stripComments('const a = /a\\/b/')).toBe('const a = /a\\/b/')
  })

  test('a name is compared without its separators', () => {
    expect(normalizeForNeedle('dual write')).toBe('dualwrite')
    expect(normalizeForNeedle('dual_write')).toBe('dualwrite')
    expect(normalizeForNeedle('dualWrite')).toBe('dualwrite')
    expect(normalizeForNeedle('const a = 1')).toBe('consta=1')
  })

  test('every construct the rule refuses is refused', () => {
    const cases: [string, string][] = [
      ['const url = process.env.NEON_AUTH_BASE_URL', 'legacy-environment'],
      ["const host = 'db.neon.tech'", 'legacy-host'],
      ['await importLegacyIdentities(pool)', 'legacy-import'],
      ['await seedLegacyUsers(pool)', 'legacy-import'],
      ['const legacyUsersImport = 1', 'legacy-import'],
      ['await pool.query("INSERT INTO app.users SELECT * FROM legacy.users")', 'row-copy'],
      ['await pool.query("INSERT/**/INTO app.users SELECT * FROM legacy.users")', 'row-copy'],
      [
        'await pool.query("INSERT -- note\n INTO app.users SELECT * FROM legacy.users")',
        'row-copy',
      ],
      ['await pool.query("\\\\copy app.users FROM /tmp/users.csv")', 'row-copy'],
      ['await pool.query("COPY app.users FROM legacy.users")', 'row-copy'],
      ['const a = "/*"; dualWriteToBoth(pool); const b = "*/";', 'dual-write'],
      ['const s = `${ /* } */ "/*" + dualWriteToBoth(pool) + "*/" }`;', 'dual-write'],
    ]
    for (const [source, kind] of cases) {
      const kinds = freshAccountOnlyViolations('behaviour.ts', source).map(
        (violation) => violation.kind
      )
      expect(kinds, source).toContain(kind)
    }
  })

  test('nothing the rule does not refuse is refused', () => {
    const cases = [
      'const a = 1',
      'const a = total / count',
      '// importLegacyIdentities(pool)\nconst a = 1',
      '/* importLegacyIdentities(pool) */\nconst a = 1',
      'await pool.query("INSERT INTO app.users VALUES (1)")',
      'await pool.query("COPY app.users")',
      'const s = `${ /* importLegacyIdentities(pool) */ "ok" }`;',
      'const preliminary = 1',
    ]
    for (const source of cases) {
      expect(freshAccountOnlyViolations('behaviour.ts', source), source).toEqual([])
    }
  })

  test('a legacy provider package is refused', () => {
    const violations = noNeonViolations(
      'behaviour.ts',
      "import { neon } from '@neondatabase/serverless'"
    )
    expect(violations.map((violation) => violation.kind)).toContain('legacy-package')
    expect(noNeonViolations('behaviour.ts', "import { postgres } from 'postgres'")).toEqual([])
  })
})

describe('the scope the rule covers', () => {
  const root = join(import.meta.dir, '..')

  test('the acceptance sources are in the scope', () => {
    const files = freshAccountScopeFiles(root)
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain('scripts/fresh-postgres-acceptance/policy.mjs')
    expect(files).toContain('scripts/fresh-postgres-acceptance/run.mjs')
  })

  test('the named lane files outside the directory are in the scope too', () => {
    const files = laneSourceFiles(root)
    expect(files.length).toBeGreaterThan(freshAccountScopeFiles(root).length)
    expect(files).toContain('scripts/disposable-postgres-ci.ts')
    expect(files).toContain('packages/auth/src/schema-init.ts')
  })

  test('the scope of the lane carries no rule violation and no legacy provider', () => {
    expect(scanFreshAccountScope(root)).toEqual([])
    expect(scanNoNeonScope(root)).toEqual([])
    expect(assertFreshAccountOnly(root)).toBe(true)
    expect(assertNoNeonInScope(root)).toBe(true)
  })
})
