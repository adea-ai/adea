import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACCEPTANCE_IDS,
  MAX_EVIDENCE_BYTES,
  parseJunit,
  REQUIRED_IDS,
  REQUIREMENT_IDS,
  repositoryIo,
  STATUS,
  validateEvidenceManifest,
} from './evidence-manifest.mjs'

const root = resolve(import.meta.dir, '..')
const SHA = '1'.repeat(40)
const ROOT = '9'.repeat(40)
const OTHER_SHA = '2'.repeat(40)
const CONTRACT = 'pi-durable-2026-10'
const TEST_PATH = 'scripts/evidence-manifest.test.ts'
const TEST_TITLE = 'validates every mapped id'
const testRef = { kind: 'test-reference', repository: 'adea', path: TEST_PATH, name: TEST_TITLE }
const criterionA01 = {
  text: 'the designated lead is the only lead',
  tests: [{ path: TEST_PATH, name: TEST_TITLE }],
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A local checkout fake: committed blobs keyed by `<sha>:<path>`. */
function checkoutFake({ commits = [SHA], roots = { [SHA]: [ROOT] }, blobs = {} } = {}) {
  return {
    commitExists: (sha) => commits.includes(sha),
    rootCommits: (sha) => roots[sha] ?? [],
    blobAtSha: (sha, path) => {
      const blob = blobs[`${sha}:${path}`]
      if (blob === undefined) return null
      const bytes = Buffer.from(blob.content ?? '')
      return {
        regular: blob.regular ?? true,
        mode: blob.regular === false ? '120000' : '100644',
        size: blob.size ?? bytes.length,
        bytes: () => bytes,
      }
    },
  }
}

const testBlobs = () => ({
  [`${SHA}:${TEST_PATH}`]: { content: `test('${TEST_TITLE}', () => {})` },
})

/** I/O fake: `checkouts` by repository key, `working` files by repo-relative path. */
function fixtureIo({
  checkouts = { adea: checkoutFake({ blobs: testBlobs() }) },
  working = {},
} = {}) {
  return {
    checkout: (repository) => checkouts[repository] ?? null,
    workingFile: (path) => {
      const file = working[path]
      if (file === undefined) return null
      if (file.outside) return { outside: true }
      const bytes = Buffer.from(file.content ?? '')
      return { regular: file.regular ?? true, size: file.size ?? bytes.length, bytes: () => bytes }
    },
  }
}

function junit(titles, failing = []) {
  const cases = titles
    .map((title) =>
      failing.includes(title)
        ? `    <testcase name="${title}" classname="" time="0.1"><failure message="boom"/></testcase>`
        : `    <testcase name="${title}" classname="" time="0.1" />`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n  <testsuite name="x">\n${cases}\n  </testsuite>\n</testsuites>\n`
}

/** One run for a test file at the pinned revision: its record and receipt as working files. */
function runFor(
  prefix,
  {
    titles = [TEST_TITLE],
    failing = [],
    file = TEST_PATH,
    ids = ['A01'],
    record: overrides = {},
    executedAtHead = SHA,
  } = {}
) {
  const receipt = Buffer.from(junit(titles, failing))
  const summary = { pass: titles.length - failing.length, fail: failing.length }
  const record = Buffer.from(
    JSON.stringify({
      repository: 'adea',
      sourceSha: SHA,
      executedAtHead,
      file,
      command: `bun test ${file}`,
      exitCode: 0,
      status: 'passed',
      summary,
      ids,
      ...overrides,
    })
  )
  return {
    files: { [`${prefix}.json`]: { content: record }, [`${prefix}.xml`]: { content: receipt } },
    ref: {
      kind: 'execution-reference',
      repository: 'adea',
      path: `${prefix}.json`,
      sha256: sha256Of(record),
      receipt: { path: `${prefix}.xml`, sha256: sha256Of(receipt) },
    },
  }
}

/** One candidate record with its own receipt. */
function candidateFor(
  prefix,
  {
    id = 'A01',
    sources = { adea: SHA },
    contractVersion = CONTRACT,
    channel = 'packaged',
    failing = [],
    record: overrides = {},
  } = {}
) {
  const titles = ['packaged smoke']
  const receipt = Buffer.from(junit(titles, failing))
  const summary = { pass: titles.length - failing.length, fail: failing.length }
  const record = Buffer.from(
    JSON.stringify({
      candidateId: prefix,
      channel,
      contractVersion,
      status: 'passed',
      exitCode: 0,
      ids: [id],
      sources,
      summary,
      ...overrides,
    })
  )
  return {
    files: { [`${prefix}.json`]: { content: record }, [`${prefix}.xml`]: { content: receipt } },
    ref: {
      kind: 'candidate-reference',
      path: `${prefix}.json`,
      sha256: sha256Of(record),
      receipt: { path: `${prefix}.xml`, sha256: sha256Of(receipt) },
    },
  }
}

const ADEA = { name: 'adea-ai/adea', rootCommit: ROOT, sourceSha: SHA }

function manifest(entries = [], overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 1225,
    parent: 1183,
    repositories: { adea: ADEA },
    compatibility: { contractVersions: [CONTRACT] },
    entries,
    ...overrides,
  }
}

/** A complete A01: one runner-verified test and one passing run, with working files. */
function completeA01({ overrides = {}, run = runFor('artifacts/a01-run'), extra = {} } = {}) {
  return {
    io: fixtureIo({ working: { ...run.files, ...extra } }),
    entry: {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef, run.ref],
      candidateEvidence: [],
      ...overrides,
    },
  }
}

const statusOf = (report, id) => report.results.find((result) => result.id === id)

describe('evidence manifest id universe', () => {
  test('covers the 24 requirements and A01–A40 named by #1225', () => {
    expect(REQUIREMENT_IDS).toHaveLength(24)
    expect(ACCEPTANCE_IDS).toHaveLength(40)
    expect(REQUIRED_IDS).toHaveLength(64)
  })
})

describe('schema and repository identity', () => {
  test('rejects unknown, duplicate, and malformed entries', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    expect(validateEvidenceManifest(manifest([{ ...entry, id: 'A41' }]), io).schemaErrors).toEqual([
      'unknown id A41',
    ])
    expect(validateEvidenceManifest(manifest([entry, entry]), io).schemaErrors).toEqual([
      'duplicate entry A01',
    ])
    expect(validateEvidenceManifest(manifest([{ id: 'A01' }]), io).schemaErrors[0]).toContain(
      'must list repoEvidence'
    )
  })

  test('coverage must be explicit; partial lists gaps; complete lists criteria and no gaps', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    const { coverage: _omitted, ...bare } = entry
    expect(validateEvidenceManifest(manifest([bare]), io).schemaErrors).toEqual([
      'A01 coverage must be complete or partial',
    ])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, coverage: 'partial', gaps: [] }]), io)
        .schemaErrors
    ).toEqual(['A01 partial coverage must list gaps'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, criteria: undefined }]), io).schemaErrors
    ).toEqual(['A01 complete coverage must list criteria'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, gaps: ['x'] }]), io).schemaErrors
    ).toEqual(['A01 complete coverage must not list gaps'])
    expect(
      validateEvidenceManifest(manifest([{ ...entry, criteria: [{ text: 'x', tests: [] }] }]), io)
        .schemaErrors
    ).toEqual(['A01 criterion must name text and at least one test {path, name}'])
  })

  test('references must name a declared repository; source references are validated the same way', () => {
    const io = fixtureIo()
    const { entry } = completeA01()
    expect(
      validateEvidenceManifest(
        manifest([{ ...entry, repoEvidence: [{ ...testRef, repository: 'ghost' }] }]),
        io
      ).schemaErrors
    ).toEqual(['A01 references unknown repository ghost'])
    // A declared-looking source reference to an undeclared repository must fail closed, not throw.
    const partial = {
      id: 'A02',
      coverage: 'partial',
      gaps: ['x'],
      repoEvidence: [],
      candidateEvidence: [],
      sourceReferences: [{ repository: 'ghost', path: TEST_PATH }],
    }
    expect(validateEvidenceManifest(manifest([partial]), io).schemaErrors).toEqual([
      'A02 source reference must name a declared repository and path',
    ])
  })

  test('the home repository must include a root that the checkout actually contains', () => {
    const wrongRoot = fixtureIo({
      checkouts: { adea: checkoutFake({ roots: { [SHA]: [OTHER_SHA] } }) },
    })
    expect(validateEvidenceManifest(manifest([]), wrongRoot).schemaErrors).toEqual([
      `local checkout for adea is not adea-ai/adea (root ${ROOT} absent)`,
    ])
    const missing = fixtureIo({ checkouts: { adea: checkoutFake({ commits: [] }) } })
    expect(validateEvidenceManifest(manifest([]), missing).schemaErrors).toEqual([
      `adea sourceSha ${SHA} is not a commit in its local checkout`,
    ])
    expect(
      validateEvidenceManifest(
        manifest([], { repositories: { adea: { ...ADEA, sourceSha: 'abc' } } }),
        fixtureIo()
      ).ok
    ).toBe(false)
  })
})

describe('repository evidence: declarations, executions, and receipts', () => {
  test('a declaration alone is pending when partial and invalid when complete', () => {
    const io = fixtureIo()
    const partial = {
      id: 'A01',
      coverage: 'partial',
      gaps: ['no run'],
      repoEvidence: [testRef],
      candidateEvidence: [],
    }
    const report = validateEvidenceManifest(manifest([partial]), io)
    expect(statusOf(report, 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: ['declaration only, no execution-reference', 'gap: no run'],
    })
    expect(report.ok).toBe(true)
    const complete = {
      id: 'A01',
      coverage: 'complete',
      criteria: [criterionA01],
      repoEvidence: [testRef],
      candidateEvidence: [],
    }
    expect(statusOf(validateEvidenceManifest(manifest([complete]), io), 'A01')).toMatchObject({
      status: STATUS.invalid,
      reasons: ['complete coverage requires an execution-reference'],
    })
  })

  test('a declared title must exist as a regular, bounded file at the pinned revision', () => {
    const { entry } = completeA01()
    const cases = [
      [fixtureIo({ checkouts: { adea: checkoutFake({ blobs: {} }) } }), 'does not exist at'],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: 'x', regular: false } },
            }),
          },
        }),
        'is not a regular file',
      ],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: 'x', size: MAX_EVIDENCE_BYTES + 1 } },
            }),
          },
        }),
        'exceeds',
      ],
      [
        fixtureIo({
          checkouts: {
            adea: checkoutFake({
              blobs: { [`${SHA}:${TEST_PATH}`]: { content: "test('other', () => {})" } },
            }),
          },
        }),
        'is not declared',
      ],
    ]
    for (const [badIo, message] of cases) {
      const report = validateEvidenceManifest(manifest([entry]), badIo)
      expect(statusOf(report, 'A01').reasons[0]).toContain(message)
    }
  })

  test('an execution must be exact: pinned revision, exit code 0, status passed, and the claimed repository', () => {
    const cases = [
      [{ executedAtHead: OTHER_SHA }, 'is not the pinned'],
      [{ record: { exitCode: 1 } }, 'exit code is 1, not 0'],
      [{ record: { status: 'failed' } }, 'status is failed'],
      [{ record: { repository: 'control-plane' } }, 'names repository control-plane'],
      [{ record: { sourceSha: OTHER_SHA } }, `pins ${OTHER_SHA}`],
      [{ record: { ids: ['A02'] } }, 'does not list A01'],
    ]
    for (const [options, message] of cases) {
      const run = runFor('artifacts/a01-run', options)
      const { entry, io } = completeA01({ run })
      expect(statusOf(validateEvidenceManifest(manifest([entry]), io), 'A01').reasons[0]).toContain(
        message
      )
    }
  })

  test('the receipt must match its claimed summary, pin its hash, and list the title as passing', () => {
    const { entry, io } = completeA01()
    const tamperedHash = {
      ...entry,
      repoEvidence: [
        testRef,
        {
          ...entry.repoEvidence[1],
          receipt: { ...entry.repoEvidence[1].receipt, sha256: '0'.repeat(64) },
        },
      ],
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([tamperedHash]), io), 'A01').reasons[0]
    ).toContain('does not match sha256')

    const miscounted = runFor('artifacts/a01-run', { record: { summary: { pass: 2, fail: 0 } } })
    const { entry: e2, io: io2 } = completeA01({ run: miscounted })
    expect(statusOf(validateEvidenceManifest(manifest([e2]), io2), 'A01').reasons[0]).toContain(
      'do not match record summary'
    )

    const failing = runFor('artifacts/a01-run', { failing: [TEST_TITLE] })
    const { entry: e3, io: io3 } = completeA01({ run: failing })
    expect(statusOf(validateEvidenceManifest(manifest([e3]), io3), 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
  })

  test('two runs of one file must agree: a passing run cannot hide a failing title', () => {
    const passing = runFor('artifacts/a01-run-1')
    const failing = runFor('artifacts/a01-run-2', { failing: [TEST_TITLE] })
    const { entry, io } = completeA01({ run: passing, extra: failing.files })
    const twoRuns = { ...entry, repoEvidence: [testRef, failing.ref, passing.ref] }
    expect(statusOf(validateEvidenceManifest(manifest([twoRuns]), io), 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
  })
})

describe('complete and partial coverage', () => {
  test('a complete entry is repo-verified only when every declared test passed and each criterion is evidenced', () => {
    const { entry, io } = completeA01()
    expect(statusOf(validateEvidenceManifest(manifest([entry]), io), 'A01').status).toBe(
      STATUS.repoVerified
    )

    const declaredOnly = {
      ...entry,
      repoEvidence: [...entry.repoEvidence, { ...testRef, name: 'declared but never run' }],
    }
    const withDeclared = {
      checkout: () =>
        checkoutFake({
          blobs: {
            [`${SHA}:${TEST_PATH}`]: {
              content: `test('${TEST_TITLE}', () => {})\ntest('declared but never run', () => {})`,
            },
          },
        }),
      workingFile: io.workingFile,
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([declaredOnly]), withDeclared), 'A01').reasons
    ).toEqual([
      `test-reference is not a passing title in its receipt: ${TEST_PATH} "declared but never run"`,
    ])

    const unevidenced = {
      ...entry,
      criteria: [
        { text: 'a criterion no test covers', tests: [{ path: TEST_PATH, name: 'missing' }] },
      ],
    }
    expect(statusOf(validateEvidenceManifest(manifest([unevidenced]), io), 'A01').reasons).toEqual([
      'criterion not evidenced by runner-verified tests: a criterion no test covers',
    ])
  })

  test('a partial entry stays pending, counts runner-verified and source-only titles, and cannot carry candidates', () => {
    const { entry, io } = completeA01()
    const partial = {
      ...entry,
      coverage: 'partial',
      criteria: undefined,
      gaps: ['not all criteria covered'],
    }
    expect(statusOf(validateEvidenceManifest(manifest([partial]), io), 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: [
        'runner-verified titles: 1, source-text-only titles: 0 (weaker)',
        'gap: not all criteria covered',
      ],
    })
    const withCandidate = {
      ...partial,
      candidateEvidence: [{ kind: 'candidate-reference', path: 'x.json', sha256: '0'.repeat(64) }],
    }
    expect(
      statusOf(validateEvidenceManifest(manifest([withCandidate]), io), 'A01').reasons
    ).toEqual(['partial coverage cannot carry candidate evidence'])
  })
})

describe('candidate records', () => {
  test('a candidate is compatible only with the pinned sources, a listed contract, exit 0, and an all-passing receipt', () => {
    const cand = candidateFor('artifacts/pkg-1')
    const { entry, io } = completeA01({ extra: cand.files })
    const withCandidate = { ...entry, candidateEvidence: [cand.ref] }
    expect(statusOf(validateEvidenceManifest(manifest([withCandidate]), io), 'A01').status).toBe(
      STATUS.candidateCompatible
    )

    const cases = [
      [
        candidateFor('artifacts/pkg-1', { sources: { adea: OTHER_SHA } }),
        'does not declare sources.adea',
      ],
      [
        candidateFor('artifacts/pkg-1', { contractVersion: 'pi-durable-2025-01' }),
        'is not compatible',
      ],
      [candidateFor('artifacts/pkg-1', { record: { exitCode: 1 } }), 'exit code is 1'],
      [
        candidateFor('artifacts/pkg-1', { failing: ['packaged smoke'] }),
        'test result is not all passing',
      ],
      [candidateFor('artifacts/pkg-1', { channel: 'staging' }), 'is not packaged or deployed'],
    ]
    for (const [bad, message] of cases) {
      const { entry: e, io: i } = completeA01({ extra: bad.files })
      const report = validateEvidenceManifest(manifest([{ ...e, candidateEvidence: [bad.ref] }]), i)
      expect(statusOf(report, 'A01').reasons[0]).toContain(message)
      expect(report.ok).toBe(false)
    }
  })
})

describe('bounded reads and provenance on real git and working files', () => {
  test('committed blobs: regular files read, symlinks and oversized blobs are not regular or are bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-io-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      const git = (args) =>
        spawnSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'f',
            GIT_AUTHOR_EMAIL: 'f@example.invalid',
            GIT_COMMITTER_NAME: 'f',
            GIT_COMMITTER_EMAIL: 'f@example.invalid',
          },
        })
      git(['init', '-q'])
      writeFileSync(join(repo, 'a.test.ts'), "test('committed', () => {})\n")
      writeFileSync(join(repo, 'big.test.ts'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
      symlinkSync(join(dir, 'outside.test.ts'), join(repo, 'link.test.ts'))
      git(['add', '-A'])
      git(['commit', '-q', '-m', 'fixture'])
      const sha = git(['rev-parse', 'HEAD']).stdout.trim()
      const rootSha = git(['rev-list', '--max-parents=0', sha]).stdout.trim()
      const checkout = repositoryIo({ adea: repo }).checkout('adea')
      expect(checkout.commitExists(sha)).toBe(true)
      expect(checkout.commitExists('5'.repeat(40))).toBe(false)
      expect(checkout.rootCommits(sha)).toEqual([rootSha])
      expect(checkout.blobAtSha(sha, 'a.test.ts')).toMatchObject({ regular: true })
      expect(checkout.blobAtSha(sha, 'link.test.ts')).toMatchObject({ regular: false })
      expect(checkout.blobAtSha(sha, 'big.test.ts').size).toBeGreaterThan(MAX_EVIDENCE_BYTES)
      expect(checkout.blobAtSha(sha, 'missing.test.ts')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('working files: outside symlinks, directories, oversized files, and missing files are refused before any read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-work-'))
    try {
      const home = join(dir, 'home')
      const outside = join(dir, 'outside')
      mkdirSync(join(home, 'sub'), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(home, 'run.json'), '{}')
      writeFileSync(join(home, 'big.json'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
      writeFileSync(join(outside, 'secret.json'), '{}')
      symlinkSync(join(outside, 'secret.json'), join(home, 'escape.json'))
      symlinkSync(join(home, 'run.json'), join(home, 'inside.json'))
      const io = repositoryIo({ adea: home })
      expect(io.workingFile('run.json')).toMatchObject({ regular: true, size: 2 })
      expect(io.workingFile('inside.json')).toMatchObject({ regular: true })
      expect(io.workingFile('escape.json')).toEqual({ outside: true })
      expect(io.workingFile('sub')).toMatchObject({ regular: false })
      expect(io.workingFile('big.json').size).toBeGreaterThan(MAX_EVIDENCE_BYTES)
      expect(io.workingFile('missing.json')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('each repository key reads only its own mapped checkout, and the home key is required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-multi-'))
    try {
      const make = (name) => {
        const repo = join(dir, name)
        mkdirSync(repo)
        spawnSync('git', ['init', '-q'], { cwd: repo })
        writeFileSync(join(repo, 'x.test.ts'), name)
        spawnSync('git', ['add', '-A'], { cwd: repo })
        spawnSync(
          'git',
          ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', name],
          { cwd: repo }
        )
        return {
          repo,
          sha: spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: repo,
            encoding: 'utf8',
          }).stdout.trim(),
        }
      }
      const a = make('adea')
      const b = make('cp')
      const io = repositoryIo({ adea: a.repo, 'control-plane': b.repo })
      expect(io.checkout('adea').commitExists(a.sha)).toBe(true)
      expect(io.checkout('adea').commitExists(b.sha)).toBe(false)
      expect(io.checkout('control-plane').commitExists(b.sha)).toBe(true)
      expect(io.checkout('unmapped')).toBeNull()
      expect(() => repositoryIo({ 'control-plane': dir })).toThrow('repository mapping needs adea')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const committed = JSON.parse(
    readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
  )
  const pin = committed.repositories.adea.sourceSha
  const pinned = spawnSync('git', ['cat-file', '-e', `${pin}^{commit}`], { cwd: root }).status === 0
  test.skipIf(!pinned)(
    'the committed manifest validates at its pinned revision: every id pending, none certified',
    () => {
      const report = validateEvidenceManifest(committed, repositoryIo({ adea: root }))
      expect(report.schemaErrors).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.counts[STATUS.invalid]).toBe(0)
      expect(report.counts[STATUS.candidateCompatible]).toBe(0)
      expect(report.counts[STATUS.pending]).toBe(REQUIRED_IDS.length)
      const cli = spawnSync(process.execPath, [resolve(root, 'scripts/evidence-manifest.mjs')], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(cli.status).toBe(0)
      expect(cli.stdout).toContain(`revisions: adea@${pin}`)
      expect(cli.stdout).toContain(
        `certification: incomplete (0 of ${REQUIRED_IDS.length} candidate-compatible)`
      )
    },
    180_000
  )
})

describe('parseJunit', () => {
  test('separates passing and failing testcases, unescapes names, and counts duplicates per testcase', () => {
    const parsed = parseJunit(`<testsuites><testsuite>
      <testcase name="ok &amp; fine" time="0.1" />
      <testcase name="it&apos;s &quot;quoted&quot; &gt; x" time="0.1"></testcase>
      <testcase name="broken" time="0.1"><failure message="x"/></testcase>
      <testcase name="errored" time="0.1"><error message="x"/></testcase>
      <testcase name="same" time="0.1" />
      <testcase name="same" time="0.1" />
    </testsuite></testsuites>`)
    expect([...parsed.passed].toSorted()).toEqual(['it\'s "quoted" > x', 'ok & fine', 'same'])
    expect([...parsed.failed].toSorted()).toEqual(['broken', 'errored'])
    expect([parsed.passCount, parsed.failCount]).toEqual([4, 2])
    expect(parseJunit('<testsuites></testsuites>')).toBeNull()
  })
})
