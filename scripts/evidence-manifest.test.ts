import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACCEPTANCE_IDS,
  MAX_EVIDENCE_BYTES,
  REQUIRED_IDS,
  REQUIREMENT_IDS,
  STATUS,
  parseJunit,
  repositoryIo,
  validateEvidenceManifest,
} from './evidence-manifest.mjs'

const root = resolve(import.meta.dir, '..')
const SHA = '1'.repeat(40)
const ROOT = '9'.repeat(40)
const OTHER_SHA = '2'.repeat(40)
const OTHER_ROOT = '8'.repeat(40)
const CONTRACT = 'pi-durable-2026-10'
const TEST_PATH = 'scripts/evidence-manifest.test.ts'
const TEST_TITLE = 'validates every mapped id'

/** A local checkout fake: committed blobs keyed by `<sha>:<path>`. */
function checkoutFake({ commits = [SHA], roots = { [SHA]: [ROOT] }, blobs = {} } = {}) {
  return {
    commitExists: (sha) => commits.includes(sha),
    rootCommits: (sha) => roots[sha] ?? [],
    blobAtSha: (sha, path) => {
      const blob = blobs[`${sha}:${path}`]
      if (!blob) return null
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

/** I/O fake: `checkouts` by repository key, `working` files by repo-relative path. */
function fixtureIo({
  checkouts = { adea: checkoutFake({ blobs: testBlob() }) },
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

function testBlob() {
  return { [`${SHA}:${TEST_PATH}`]: { content: `test('${TEST_TITLE}', () => {})` } }
}

function record(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const ADEA = { name: 'adea-ai/adea', rootCommit: ROOT, sourceSha: SHA }

function manifest(entries = [], overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 1225,
    parent: 1183,
    repositories: { adea: ADEA },
    compatibility: { contractVersions: [CONTRACT] },
    entries: entries.map((entry) => ({ coverage: 'complete', ...entry })),
    ...overrides,
  }
}

const testRef = { kind: 'test-reference', repository: 'adea', path: TEST_PATH, name: TEST_TITLE }

/** A JUnit receipt as bun writes it: one testcase per title; failing titles get a failure child. */
function junitReceipt(titles, failing = []) {
  const cases = titles
    .map((title) =>
      failing.includes(title)
        ? `    <testcase name="${title}" classname="" time="0.1"><failure message="boom"/></testcase>`
        : `    <testcase name="${title}" classname="" time="0.1" />`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n  <testsuite name="x">\n${cases}\n  </testsuite>\n</testsuites>\n`
}

/** A run record and its receipt, as the runner would produce them for one test file. */
function runArtifacts({
  repository = 'adea',
  sourceSha = SHA,
  executedAtHead = SHA,
  file = TEST_PATH,
  status = 'passed',
  ids = ['A01'],
  titles = [TEST_TITLE],
  failing = [],
  pass,
  fail,
} = {}) {
  const receipt = Buffer.from(junitReceipt(titles, failing))
  const run = record({
    repository,
    sourceSha,
    executedAtHead,
    file,
    command: `bun test ${file}`,
    exitCode: 0,
    status,
    summary: { pass: pass ?? titles.length - failing.length, fail: fail ?? failing.length },
    ids,
  })
  return {
    run,
    receipt: { bytes: receipt, sha256: createHash('sha256').update(receipt).digest('hex') },
  }
}

/** A fully evidenced A01 (test + execution + packaged candidate) and its fixture io. */
function completeFixture({ io: overrides = {}, entry: entryOverrides = {} } = {}) {
  const { run, receipt } = runArtifacts()
  const candidate = record({
    candidateId: 'pkg-1',
    channel: 'packaged',
    contractVersion: CONTRACT,
    status: 'passed',
    ids: ['A01'],
    sources: { adea: SHA },
  })
  const io = fixtureIo({
    checkouts: { adea: checkoutFake({ blobs: testBlob() }) },
    working: {
      'artifacts/run.json': { content: run.bytes },
      'artifacts/receipt.xml': { content: receipt.bytes },
      'artifacts/candidate.json': { content: candidate.bytes },
      ...overrides.working,
    },
    ...overrides.fixture,
  })
  const entry = {
    id: 'A01',
    coverage: 'complete',
    repoEvidence: [
      testRef,
      {
        kind: 'execution-reference',
        repository: 'adea',
        path: 'artifacts/run.json',
        sha256: run.sha256,
        receipt: { path: 'artifacts/receipt.xml', sha256: receipt.sha256 },
      },
    ],
    candidateEvidence: [
      { kind: 'candidate-reference', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
    ],
    ...entryOverrides,
  }
  return { io, entry }
}

function statusOf(report, id) {
  return report.results.find((result) => result.id === id)
}

describe('evidence manifest id universe', () => {
  test('covers the 24 requirements and A01–A40 named by #1225', () => {
    expect(REQUIREMENT_IDS).toHaveLength(24)
    expect(REQUIREMENT_IDS[0]).toBe('REQ-005')
    expect(REQUIREMENT_IDS.at(-1)).toBe('REQ-177')
    expect(ACCEPTANCE_IDS).toHaveLength(40)
    expect(ACCEPTANCE_IDS[0]).toBe('A01')
    expect(ACCEPTANCE_IDS.at(-1)).toBe('A40')
    expect(REQUIRED_IDS).toHaveLength(64)
  })
})

describe('partial coverage', () => {
  test('a partial entry with a resolving execution reference is pending, names its gaps, and stays ok', () => {
    const { io, entry } = completeFixture()
    const partial = {
      ...entry,
      coverage: 'partial',
      gaps: ['no candidate for direct sessions'],
      candidateEvidence: [],
    }
    const report = validateEvidenceManifest(manifest([partial]), io)
    expect(statusOf(report, 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: [
        'runner-verified titles: 1, source-text-only titles: 0 (weaker)',
        'gap: no candidate for direct sessions',
      ],
    })
    expect(report.ok).toBe(true)
  })

  test('a partial entry still validates its references: a broken reference is invalid', () => {
    const { io, entry } = completeFixture()
    const broken = {
      ...entry,
      coverage: 'partial',
      gaps: ['x'],
      repoEvidence: [{ ...testRef, name: 'no such title' }, entry.repoEvidence[1]],
    }
    const report = validateEvidenceManifest(manifest([broken]), io)
    expect(statusOf(report, 'A01').status).toBe(STATUS.invalid)
    expect(report.ok).toBe(false)
  })

  test('a partial entry cannot carry candidate evidence', () => {
    const { io, entry } = completeFixture()
    const bad = { ...entry, coverage: 'partial', gaps: ['x'] }
    const report = validateEvidenceManifest(manifest([bad]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      'partial coverage cannot carry candidate evidence',
    ])
    expect(report.ok).toBe(false)
  })

  test('coverage must be explicit, and partial coverage must list gaps', () => {
    const { io, entry } = completeFixture()
    const { coverage: _omitted, ...withoutCoverage } = entry
    const raw = { ...manifest(), entries: [withoutCoverage] }
    expect(validateEvidenceManifest(raw, io).schemaErrors).toEqual([
      'A01 coverage must be complete or partial',
    ])
    const noGaps = { ...manifest(), entries: [{ ...entry, coverage: 'partial', gaps: [] }] }
    expect(validateEvidenceManifest(noGaps, io).schemaErrors).toEqual([
      'A01 partial coverage must list gaps',
    ])
  })
})

describe('committed evidence manifest', () => {
  test('pins the canonical base repository; every mapping is partial, so every id stays pending', () => {
    const committed = JSON.parse(
      readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
    )
    const adea = committed.repositories.adea
    expect(committed.issue).toBe(1225)
    expect(adea.name).toBe('adea-ai/adea')
    expect(adea.sourceSha).toBe('34e173df7bf4654d53e2b4daed5ff41239cafd8b')
    expect(committed.entries.length).toBeGreaterThan(0)
    expect(committed.entries.every((entry) => entry.coverage === 'partial')).toBe(true)
    expect(committed.compatibility.contractVersions).toEqual([])

    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({
          commits: [adea.sourceSha],
          roots: { [adea.sourceSha]: [adea.rootCommit] },
        }),
      },
    })
    expect(validateEvidenceManifest(committed, io).schemaErrors).toEqual([])
    expect(committed.entries.map((entry) => entry.id)).toEqual([
      ...new Set(committed.entries.map((entry) => entry.id)),
    ])
  })

  const pinned =
    spawnSync('git', ['cat-file', '-e', '34e173df7bf4654d53e2b4daed5ff41239cafd8b^{commit}'], {
      cwd: root,
    }).status === 0
  test.skipIf(!pinned)(
    'against the pinned commit in this checkout, every mapping is partial and pending',
    () => {
      const committed = JSON.parse(
        readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
      )
      const io = repositoryIo({ adea: root })
      const report = validateEvidenceManifest(committed, io)
      expect(report.schemaErrors).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.counts[STATUS.pending]).toBe(64)
      expect(report.counts[STATUS.repoVerified] + report.counts[STATUS.candidateCompatible]).toBe(0)
      expect(validateEvidenceManifest(committed, io, { strict: true }).ok).toBe(false)
    },
    120_000
  )
})

describe('evidence manifest validation', () => {
  test('promotes a fully evidenced id to candidate-compatible and leaves others pending', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(report.ok).toBe(true)
    expect(statusOf(report, 'A01').status).toBe(STATUS.candidateCompatible)
    expect(statusOf(report, 'A02').status).toBe(STATUS.pending)
    expect(report.counts[STATUS.candidateCompatible]).toBe(1)
    expect(report.counts[STATUS.pending]).toBe(63)
  })

  test('a test declaration alone is repo-declared, never verified', () => {
    const { io } = completeFixture()
    const declared = { id: 'A01', repoEvidence: [testRef], candidateEvidence: [] }
    const report = validateEvidenceManifest(manifest([declared]), io)
    expect(statusOf(report, 'A01')).toMatchObject({ status: STATUS.repoDeclared })
    expect(report.ok).toBe(true)
    expect(validateEvidenceManifest(manifest([declared]), io, { strict: true }).ok).toBe(false)
  })

  test('a candidate cannot attach to a declaration without an execution reference', () => {
    const { io, entry } = completeFixture()
    const bad = { ...entry, repoEvidence: [testRef] }
    const report = validateEvidenceManifest(manifest([bad]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      'candidate evidence requires an execution-reference',
    ])
    expect(report.ok).toBe(false)
  })

  test('keeps an id repo-verified without candidate evidence and fails strict mode', () => {
    const { io, entry } = completeFixture()
    const repoOnly = { ...entry, candidateEvidence: [] }
    const report = validateEvidenceManifest(manifest([repoOnly]), io)
    expect(statusOf(report, 'A01').status).toBe(STATUS.repoVerified)
    expect(report.ok).toBe(true)
    expect(validateEvidenceManifest(manifest([repoOnly]), io, { strict: true }).ok).toBe(false)
  })

  test('treats an entry with no repository evidence as pending, not invalid', () => {
    const report = validateEvidenceManifest(
      manifest([{ id: 'REQ-005', repoEvidence: [], candidateEvidence: [] }]),
      fixtureIo()
    )
    expect(statusOf(report, 'REQ-005')).toMatchObject({
      status: STATUS.pending,
      reasons: ['no repository evidence mapped'],
    })
    expect(report.ok).toBe(true)
  })

  test('fails when a declared test file is missing at the pinned SHA', () => {
    const { entry } = completeFixture()
    const missing = fixtureIo({ checkouts: { adea: checkoutFake({ blobs: {} }) }, working: {} })
    const report = validateEvidenceManifest(manifest([entry]), missing)
    expect(statusOf(report, 'A01').reasons[0]).toContain(`does not exist at ${SHA}`)
    expect(report.ok).toBe(false)
  })

  test('fails when the test title is not declared in the file', () => {
    const { entry } = completeFixture()
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({
          blobs: { [`${SHA}:${TEST_PATH}`]: { content: `test('some other title', () => {})` } },
        }),
      },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not declared')
    expect(report.ok).toBe(false)
  })

  test('rejects a test path that is not a test file', () => {
    const { io, entry } = completeFixture()
    const bad = {
      ...entry,
      repoEvidence: [{ ...testRef, path: 'scripts/evidence-manifest.mjs' }, entry.repoEvidence[1]],
    }
    expect(validateEvidenceManifest(manifest([bad]), io).ok).toBe(false)
  })

  test('rejects a test reference whose git blob is not a regular file (symlink)', () => {
    const { entry } = completeFixture()
    const linked = fixtureIo({
      checkouts: {
        adea: checkoutFake({
          blobs: { [`${SHA}:${TEST_PATH}`]: { content: 'x', regular: false } },
        }),
      },
    })
    const report = validateEvidenceManifest(manifest([entry]), linked)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not a regular file')
    expect(report.ok).toBe(false)
  })

  test('rejects a test reference whose git blob exceeds the size limit', () => {
    const { entry } = completeFixture()
    const huge = fixtureIo({
      checkouts: {
        adea: checkoutFake({
          blobs: {
            [`${SHA}:${TEST_PATH}`]: { content: '', size: MAX_EVIDENCE_BYTES + 1 },
          },
        }),
      },
    })
    const report = validateEvidenceManifest(manifest([entry]), huge)
    expect(statusOf(report, 'A01').reasons[0]).toContain(`exceeds ${MAX_EVIDENCE_BYTES} bytes`)
  })

  test('fails when an execution record was produced for a different repository', () => {
    const run = record({
      repository: 'control-plane',
      sourceSha: SHA,
      command: 'bun test',
      status: 'passed',
      ids: ['A01'],
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { content: run.bytes } } },
    })
    const wrong = {
      ...entry,
      repoEvidence: [testRef, { ...entry.repoEvidence[1], sha256: run.sha256 }],
    }
    const report = validateEvidenceManifest(manifest([wrong]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('names repository control-plane')
    expect(report.ok).toBe(false)
  })

  test('fails when an execution record pins the wrong SHA for its repository', () => {
    const run = record({
      repository: 'adea',
      sourceSha: OTHER_SHA,
      command: 'bun test',
      status: 'passed',
      ids: ['A01'],
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { content: run.bytes } } },
    })
    const wrong = {
      ...entry,
      repoEvidence: [testRef, { ...entry.repoEvidence[1], sha256: run.sha256 }],
    }
    const report = validateEvidenceManifest(manifest([wrong]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain(`adea pins ${SHA}`)
  })

  test('fails when an execution record bytes differ from the pinned hash', () => {
    const { io, entry } = completeFixture()
    const tampered = {
      ...entry,
      repoEvidence: entry.repoEvidence.map((item) =>
        item.kind === 'execution-reference' ? { ...item, sha256: '0'.repeat(64) } : item
      ),
    }
    const report = validateEvidenceManifest(manifest([tampered]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('does not match sha256')
    expect(report.ok).toBe(false)
  })

  test('does not count an execution record that did not pass', () => {
    const run = record({
      repository: 'adea',
      sourceSha: SHA,
      command: 'bun test',
      status: 'failed',
      ids: ['A01'],
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { content: run.bytes } } },
    })
    const failing = {
      ...entry,
      repoEvidence: [testRef, { ...entry.repoEvidence[1], sha256: run.sha256 }],
    }
    const report = validateEvidenceManifest(manifest([failing]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('not passed')
    expect(report.ok).toBe(false)
  })

  test('rejects an execution record file that resolves outside the repository root', () => {
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { outside: true } } },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('resolves outside the repository root')
    expect(report.ok).toBe(false)
  })

  test('rejects an oversized execution record without reading it', () => {
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { content: '{}', size: MAX_EVIDENCE_BYTES + 1 } } },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain(`exceeds ${MAX_EVIDENCE_BYTES} bytes`)
  })

  test('rejects a non-regular execution record (directory)', () => {
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/run.json': { content: '', regular: false } } },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not a regular file')
  })

  test('rejects a candidate built from a different source SHA', () => {
    const candidate = record({
      candidateId: 'pkg-old',
      channel: 'packaged',
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A01'],
      sources: { adea: OTHER_SHA },
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/candidate.json': { content: candidate.bytes } } },
    })
    const mismatched = {
      ...entry,
      candidateEvidence: [
        { kind: 'candidate-reference', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
      ],
    }
    const report = validateEvidenceManifest(manifest([mismatched]), io)
    expect(statusOf(report, 'A01').status).toBe(STATUS.invalid)
    expect(statusOf(report, 'A01').reasons[0]).toContain('does not declare sources.adea')
  })

  test('rejects a candidate whose contract version is not listed as compatible', () => {
    const candidate = record({
      candidateId: 'dep-1',
      channel: 'deployed',
      contractVersion: 'pi-durable-2025-01',
      status: 'passed',
      ids: ['A01'],
      sources: { adea: SHA },
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/candidate.json': { content: candidate.bytes } } },
    })
    const incompatible = {
      ...entry,
      candidateEvidence: [
        { kind: 'candidate-reference', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
      ],
    }
    const report = validateEvidenceManifest(manifest([incompatible]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not compatible')
    expect(report.ok).toBe(false)
  })

  test('rejects a candidate on an unknown channel or that does not list the id', () => {
    const unknownChannel = record({
      candidateId: 'x',
      channel: 'staging',
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A01'],
      sources: { adea: SHA },
    })
    const notListed = record({
      candidateId: 'y',
      channel: 'deployed',
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A02'],
      sources: { adea: SHA },
    })
    for (const [candidate, reason] of [
      [unknownChannel, 'is not packaged or deployed'],
      [notListed, 'does not list A01'],
    ]) {
      const { io, entry } = completeFixture({
        io: { working: { 'artifacts/candidate.json': { content: candidate.bytes } } },
      })
      const bad = {
        ...entry,
        candidateEvidence: [
          {
            kind: 'candidate-reference',
            path: 'artifacts/candidate.json',
            sha256: candidate.sha256,
          },
        ],
      }
      const report = validateEvidenceManifest(manifest([bad]), io)
      expect(statusOf(report, 'A01').reasons[0]).toContain(reason)
    }
  })

  test('a missing candidate record file is invalid rather than pending', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(
      manifest([{ ...entry, repoEvidence: [testRef, entry.repoEvidence[1]] }]),
      { ...io, workingFile: () => null }
    )
    expect(statusOf(report, 'A01').reasons[0]).toContain('is missing')
    expect(report.ok).toBe(false)
  })

  test.each([
    ['../escape.json', 'unsafe evidence path'],
    ['/etc/passwd', 'unsafe evidence path'],
    ['artifacts//run.json', 'unsafe evidence path'],
  ])('rejects unsafe evidence path %s', (path, reason) => {
    const { io, entry } = completeFixture()
    const unsafe = {
      ...entry,
      repoEvidence: [
        { kind: 'execution-reference', repository: 'adea', path, sha256: '0'.repeat(64) },
      ],
    }
    const report = validateEvidenceManifest(manifest([unsafe]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain(reason)
  })

  test('multi-repository: references resolve per repository and candidates must declare every repository', () => {
    const CP = { name: 'adea-ai/control-plane', rootCommit: OTHER_ROOT, sourceSha: OTHER_SHA }
    const cp = runArtifacts({
      repository: 'control-plane',
      sourceSha: OTHER_SHA,
      executedAtHead: OTHER_SHA,
      file: 'tests/cp.test.ts',
      ids: ['A02'],
      titles: ['cp title'],
    })
    const cpRun = cp.run
    const candidate = record({
      candidateId: 'pkg-both',
      channel: 'packaged',
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A02'],
      sources: { adea: SHA, 'control-plane': OTHER_SHA },
    })
    const partial = record({
      candidateId: 'pkg-adea-only',
      channel: 'packaged',
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A02'],
      sources: { adea: SHA },
    })
    const cpTest = {
      kind: 'test-reference',
      repository: 'control-plane',
      path: 'tests/cp.test.ts',
      name: 'cp title',
    }
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({ blobs: testBlob() }),
        'control-plane': checkoutFake({
          commits: [OTHER_SHA],
          roots: { [OTHER_SHA]: [OTHER_ROOT] },
          blobs: { [`${OTHER_SHA}:tests/cp.test.ts`]: { content: "test('cp title', () => {})" } },
        }),
      },
      working: {
        'artifacts/cp-run.json': { content: cpRun.bytes },
        'artifacts/cp-receipt.xml': { content: cp.receipt.bytes },
        'artifacts/both.json': { content: candidate.bytes },
        'artifacts/partial.json': { content: partial.bytes },
      },
    })
    const entry = (candidatePath, sha256) => ({
      id: 'A02',
      repoEvidence: [
        cpTest,
        {
          kind: 'execution-reference',
          repository: 'control-plane',
          path: 'artifacts/cp-run.json',
          sha256: cpRun.sha256,
          receipt: { path: 'artifacts/cp-receipt.xml', sha256: cp.receipt.sha256 },
        },
      ],
      candidateEvidence: [{ kind: 'candidate-reference', path: candidatePath, sha256 }],
    })
    const twoRepo = manifest([entry('artifacts/both.json', candidate.sha256)], {
      repositories: { adea: ADEA, 'control-plane': CP },
    })
    expect(statusOf(validateEvidenceManifest(twoRepo, io), 'A02').status).toBe(
      STATUS.candidateCompatible
    )

    const partialManifest = manifest([entry('artifacts/partial.json', partial.sha256)], {
      repositories: { adea: ADEA, 'control-plane': CP },
    })
    const partialReport = validateEvidenceManifest(partialManifest, io)
    expect(statusOf(partialReport, 'A02').reasons[0]).toContain(
      'does not declare sources.control-plane'
    )
    expect(partialReport.ok).toBe(false)
  })

  test('an unmapped repository is invalid for references to it, not silently pending', () => {
    const { io, entry } = completeFixture()
    const unmapped = {
      ...entry,
      repoEvidence: [{ ...testRef, repository: 'adea' }, entry.repoEvidence[1]],
    }
    const withUnmapped = manifest(
      [{ id: 'A01', repoEvidence: [{ ...testRef, repository: 'other' }], candidateEvidence: [] }],
      {
        repositories: {
          adea: ADEA,
          other: { name: 'adea-ai/other', rootCommit: OTHER_ROOT, sourceSha: OTHER_SHA },
        },
      }
    )
    const report = validateEvidenceManifest(withUnmapped, io)
    expect(statusOf(report, 'A01').reasons[0]).toContain(
      'no local checkout mapped for repository other'
    )
    expect(report.ok).toBe(false)
    expect(validateEvidenceManifest(manifest([unmapped]), io).ok).toBe(true)
  })

  test('a local checkout whose history lacks the declared root commit is refused', () => {
    const { entry } = completeFixture()
    const wrongRoot = fixtureIo({
      checkouts: { adea: checkoutFake({ roots: { [SHA]: [OTHER_ROOT] }, blobs: testBlob() }) },
    })
    const report = validateEvidenceManifest(manifest([entry]), wrongRoot)
    expect(report.schemaErrors).toEqual([
      `local checkout for adea is not adea-ai/adea (root ${ROOT} absent)`,
    ])
    expect(report.ok).toBe(false)
  })

  test('a repository key that is not declared is a schema error', () => {
    const { io, entry } = completeFixture()
    const undeclared = { ...entry, repoEvidence: [{ ...testRef, repository: 'ghost' }] }
    const report = validateEvidenceManifest(manifest([undeclared]), io)
    expect(report.schemaErrors).toEqual(['A01 references unknown repository ghost'])
  })

  test('rejects schema errors: unknown id, duplicate entry, repository shape, wrong issue', () => {
    const { io, entry } = completeFixture()
    expect(validateEvidenceManifest(manifest([{ ...entry, id: 'A41' }]), io).schemaErrors).toEqual([
      'unknown id A41',
    ])
    expect(validateEvidenceManifest(manifest([entry, entry]), io).schemaErrors).toEqual([
      'duplicate entry A01',
    ])
    expect(
      validateEvidenceManifest(
        manifest([], { repositories: { adea: { ...ADEA, sourceSha: 'abc' } } }),
        io
      ).ok
    ).toBe(false)
    expect(
      validateEvidenceManifest(manifest([], { repositories: { 'Bad Key': ADEA, adea: ADEA } }), io)
        .schemaErrors
    ).toEqual(['repository key Bad Key must be lowercase letters, digits, or dashes'])
    expect(
      validateEvidenceManifest(
        manifest([], { repositories: { adea: { ...ADEA, name: 'no-slash' } } }),
        io
      ).schemaErrors
    ).toEqual(['adea.name must be owner/repo'])
    expect(validateEvidenceManifest(manifest([], { repositories: {} }), io).schemaErrors).toEqual([
      'repositories must be a non-empty object',
    ])
    expect(
      validateEvidenceManifest(manifest([], { repositories: { other: ADEA } }), io).schemaErrors
    ).toEqual(['repositories must include adea'])
    expect(validateEvidenceManifest(manifest([], { issue: 1183 }), io).schemaErrors).toEqual([
      'issue must be 1225',
    ])
  })

  test('rejects a declared sourceSha that is not a commit in its local checkout', () => {
    const report = validateEvidenceManifest(
      manifest([]),
      fixtureIo({ checkouts: { adea: checkoutFake({ commits: [] }) } })
    )
    expect(report.schemaErrors).toEqual([
      `adea sourceSha ${SHA} is not a commit in its local checkout`,
    ])
  })

  test('rejects malformed entries without throwing', () => {
    const report = validateEvidenceManifest(manifest([{ id: 'A01' }]), fixtureIo())
    expect(report.ok).toBe(false)
    expect(report.schemaErrors[0]).toContain('must list repoEvidence and candidateEvidence')
  })
})

function git(dir, args) {
  return spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}

function makeRepo(dir, build) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  build(dir)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'fixture', '--allow-empty'])
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim()
}

describe('runner receipts and source references', () => {
  test('parseJunit separates passing, failing, and entity-escaped testcases', () => {
    const xml = `<testsuites><testsuite>
      <testcase name="ok &amp; fine" classname="" time="0.1" />
      <testcase name="it&apos;s &quot;quoted&quot;" time="0.1"></testcase>
      <testcase name="broken" time="0.1"><failure message="x"/></testcase>
      <testcase name="errored" time="0.1"><error message="x"/></testcase>
    </testsuite></testsuites>`
    const parsed = parseJunit(xml)
    expect([...parsed.passed].toSorted()).toEqual(['it\'s "quoted"', 'ok & fine'])
    expect([...parsed.failed].toSorted()).toEqual(['broken', 'errored'])
    expect(parseJunit('<testsuites></testsuites>')).toBeNull()
    const repeated = parseJunit(`<testsuites>
      <testcase name="same" time="0.1" />
      <testcase name="same" time="0.1" />
    </testsuites>`)
    expect([repeated.passCount, repeated.failCount]).toEqual([2, 0])
  })

  test('a passing title in the receipt is runner-verified; source-only titles are reported as weaker', () => {
    const { io, entry } = completeFixture()
    const extra = {
      kind: 'test-reference',
      repository: 'adea',
      path: TEST_PATH,
      name: 'declared but not run',
    }
    const source = {
      ...entry,
      coverage: 'partial',
      gaps: ['not all criteria covered'],
      repoEvidence: [...entry.repoEvidence, extra],
      candidateEvidence: [],
    }
    const withSource = {
      ...io,
      checkout: () =>
        checkoutFake({
          blobs: {
            [`${SHA}:${TEST_PATH}`]: {
              content: `test('${TEST_TITLE}', () => {})\ntest('declared but not run', () => {})`,
            },
          },
        }),
    }
    const report = validateEvidenceManifest(manifest([source]), withSource)
    expect(statusOf(report, 'A01')).toMatchObject({
      status: STATUS.pending,
      reasons: [
        'runner-verified titles: 1, source-text-only titles: 1 (weaker)',
        'gap: not all criteria covered',
      ],
    })
    expect(report.ok).toBe(true)
  })

  test('a receipt that fails the claimed title is not verified', () => {
    const { entry } = completeFixture()
    const { run, receipt } = runArtifacts({ failing: [TEST_TITLE] })
    const failing = fixtureIo({
      checkouts: { adea: checkoutFake({ blobs: testBlob() }) },
      working: {
        'artifacts/run.json': { content: run.bytes },
        'artifacts/receipt.xml': { content: receipt.bytes },
      },
    })
    const bad = {
      ...entry,
      repoEvidence: [
        testRef,
        {
          ...entry.repoEvidence[1],
          sha256: run.sha256,
          receipt: { path: 'artifacts/receipt.xml', sha256: receipt.sha256 },
        },
      ],
    }
    const report = validateEvidenceManifest(manifest([bad]), failing)
    expect(statusOf(report, 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
    expect(report.ok).toBe(false)
  })

  test('a receipt whose hash differs from the pinned value is refused', () => {
    const { io, entry } = completeFixture()
    const tampered = {
      ...entry,
      repoEvidence: entry.repoEvidence.map((item) =>
        item.kind === 'execution-reference'
          ? { ...item, receipt: { ...item.receipt, sha256: '0'.repeat(64) } }
          : item
      ),
    }
    const report = validateEvidenceManifest(manifest([tampered]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('does not match sha256')
  })

  test('a receipt that lists no matching passing title is invalid', () => {
    const { entry } = completeFixture()
    const { run, receipt } = runArtifacts({ titles: ['some other title'] })
    const io = fixtureIo({
      checkouts: { adea: checkoutFake({ blobs: testBlob() }) },
      working: {
        'artifacts/run.json': { content: run.bytes },
        'artifacts/receipt.xml': { content: receipt.bytes },
      },
    })
    const bad = {
      ...entry,
      repoEvidence: [
        testRef,
        {
          ...entry.repoEvidence[1],
          sha256: run.sha256,
          receipt: { path: 'artifacts/receipt.xml', sha256: receipt.sha256 },
        },
      ],
    }
    const report = validateEvidenceManifest(manifest([bad]), io)
    expect(statusOf(report, 'A01').reasons).toEqual([
      'no test-reference is a passing title in its receipt',
    ])
  })

  test('executedAtHead must be a commit in the checkout', () => {
    const { run, receipt } = runArtifacts({ executedAtHead: OTHER_SHA })
    const { io, entry } = completeFixture({
      io: {
        working: {
          'artifacts/run.json': { content: run.bytes },
          'artifacts/receipt.xml': { content: receipt.bytes },
        },
      },
    })
    const report = validateEvidenceManifest(
      manifest([
        {
          ...entry,
          repoEvidence: [
            testRef,
            {
              ...entry.repoEvidence[1],
              sha256: run.sha256,
              receipt: { path: 'artifacts/receipt.xml', sha256: receipt.sha256 },
            },
          ],
        },
      ]),
      io
    )
    expect(statusOf(report, 'A01').reasons[0]).toContain(
      `executedAtHead ${OTHER_SHA} is not a commit`
    )
  })

  test('a receipt outside the root or over the size limit is refused before reading', () => {
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/receipt.xml': { content: '', size: MAX_EVIDENCE_BYTES + 1 } } },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('receipt artifacts/receipt.xml exceeds')
  })

  test('a source reference must be a regular file at the pinned SHA', () => {
    const { io, entry } = completeFixture()
    const sourced = {
      ...entry,
      coverage: 'partial',
      gaps: ['x'],
      sourceReferences: [{ repository: 'adea', path: 'scripts/missing.ts' }],
    }
    const report = validateEvidenceManifest(manifest([sourced]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not a regular file at the pinned SHA')
    expect(report.ok).toBe(false)
  })

  test('an uncovered criterion with a source reference is pending and names the gap', () => {
    const sourced = {
      id: 'A02',
      coverage: 'partial',
      gaps: ['retry returning the original id is not tested'],
      repoEvidence: [],
      candidateEvidence: [],
      sourceReferences: [{ repository: 'adea', path: 'scripts/evidence-manifest.mjs' }],
    }
    const io = fixtureIo({
      checkouts: {
        adea: checkoutFake({
          blobs: { [`${SHA}:scripts/evidence-manifest.mjs`]: { content: 'x' } },
        }),
      },
    })
    const report = validateEvidenceManifest(manifest([sourced]), io)
    expect(statusOf(report, 'A02')).toMatchObject({
      status: STATUS.pending,
      reasons: [
        'no repository evidence mapped',
        'gap: retry returning the original id is not tested',
      ],
    })
    expect(report.ok).toBe(true)
  })
})

describe('repositoryIo: git and working-tree safety', () => {
  test('reads committed blobs, rejects symlink and oversized blobs, and resolves immutable roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-io-'))
    const outside = mkdtempSync(join(tmpdir(), 'adea-evidence-outside-'))
    try {
      const sha = makeRepo(join(dir, 'repo'), (repo) => {
        writeFileSync(join(repo, 'a.test.ts'), "test('committed', () => {})\n")
        writeFileSync(join(repo, 'big.test.ts'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
        symlinkSync(join(outside, 'secret.test.ts'), join(repo, 'link.test.ts'))
      })
      const rootSha = git(join(dir, 'repo'), ['rev-list', '--max-parents=0', sha]).stdout.trim()
      const io = repositoryIo({ adea: join(dir, 'repo') })
      const checkout = io.checkout('adea')

      expect(checkout.commitExists(sha)).toBe(true)
      expect(checkout.commitExists('5'.repeat(40))).toBe(false)
      expect(checkout.rootCommits(sha)).toEqual([rootSha])
      expect(checkout.rootCommits('5'.repeat(40))).toEqual([])

      const regular = checkout.blobAtSha(sha, 'a.test.ts')
      expect(regular).toMatchObject({ regular: true })
      expect(regular.bytes().toString('utf8')).toContain('committed')

      expect(checkout.blobAtSha(sha, 'link.test.ts')).toMatchObject({ regular: false })
      expect(checkout.blobAtSha(sha, 'big.test.ts').size).toBeGreaterThan(MAX_EVIDENCE_BYTES)
      expect(checkout.blobAtSha(sha, 'missing.test.ts')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('working files: regular in-root allowed; outside symlink, directory, oversized, missing handled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-work-'))
    const outside = mkdtempSync(join(tmpdir(), 'adea-evidence-outside-'))
    try {
      const home = join(dir, 'home')
      mkdirSync(join(home, 'sub'), { recursive: true })
      writeFileSync(join(home, 'run.json'), '{}')
      writeFileSync(join(home, 'big.json'), 'x'.repeat(MAX_EVIDENCE_BYTES + 1))
      writeFileSync(join(outside, 'secret.json'), '{"secret":true}')
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
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('multi-repository local mapping: each key reads its own checkout; unmapped keys yield null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-multi-'))
    try {
      const adeaSha = makeRepo(join(dir, 'adea'), (repo) =>
        writeFileSync(join(repo, 'x.test.ts'), 'a')
      )
      const cpSha = makeRepo(join(dir, 'cp'), (repo) => writeFileSync(join(repo, 'y.test.ts'), 'b'))
      const io = repositoryIo({ adea: join(dir, 'adea'), 'control-plane': join(dir, 'cp') })
      expect(io.checkout('adea').commitExists(adeaSha)).toBe(true)
      expect(io.checkout('adea').commitExists(cpSha)).toBe(false)
      expect(io.checkout('control-plane').commitExists(cpSha)).toBe(true)
      expect(io.checkout('control-plane').blobAtSha(cpSha, 'y.test.ts')).toMatchObject({
        regular: true,
      })
      expect(io.checkout('unmapped')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('repositoryIo refuses a mapping without the home repository', () => {
    expect(() => repositoryIo({ 'control-plane': '/tmp' })).toThrow('repository mapping needs adea')
  })
})
