import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACCEPTANCE_IDS,
  REQUIRED_IDS,
  REQUIREMENT_IDS,
  STATUS,
  repositoryIo,
  validateEvidenceManifest,
} from './evidence-manifest.mjs'

const root = resolve(import.meta.dir, '..')
const SHA = '1'.repeat(40)
const CONTRACT = 'pi-durable-2026-10'
const TEST_PATH = 'scripts/evidence-manifest.test.ts'
const TEST_TITLE = 'validates every mapped id'

/** In-memory I/O: `files` keys are `<sha>:<path>`, `working` maps path to bytes. */
function fixtureIo({ commits = [SHA], files = {}, working = {} } = {}) {
  return {
    commitExists: (sha) => commits.includes(sha),
    readAtSha: (sha, path) => files[`${sha}:${path}`] ?? null,
    readWorking: (path) => working[path] ?? null,
  }
}

function record(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function manifest(entries = [], overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 1225,
    parent: 1183,
    sourceSha: SHA,
    compatibility: { contractVersions: [CONTRACT] },
    entries,
    ...overrides,
  }
}

/** A fully mapped A01 (test + run + packaged candidate) and its fixture io. */
function completeFixture(overrides = {}) {
  const run = record({ sourceSha: SHA, command: 'bun test', status: 'passed', ids: ['A01'] })
  const candidate = record({
    candidateId: 'pkg-1',
    channel: 'packaged',
    sourceSha: SHA,
    contractVersion: CONTRACT,
    status: 'passed',
    ids: ['A01'],
  })
  const io = fixtureIo({
    files: {
      [`${SHA}:${TEST_PATH}`]: `test('${TEST_TITLE}', () => {})`,
      ...overrides.io?.files,
    },
    working: {
      'artifacts/run.json': run.bytes,
      'artifacts/candidate.json': candidate.bytes,
      ...overrides.io?.working,
    },
  })
  const entry = {
    id: 'A01',
    sourceSha: SHA,
    repoEvidence: [
      { kind: 'test', path: TEST_PATH, name: TEST_TITLE },
      { kind: 'run', path: 'artifacts/run.json', sha256: run.sha256 },
    ],
    candidateEvidence: [
      { kind: 'candidate', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
    ],
    ...overrides.entry,
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

describe('committed evidence manifest', () => {
  test('pins the canonical base and maps nothing yet, so every id stays pending', () => {
    const committed = JSON.parse(
      readFileSync(resolve(root, 'docs/plans/m18-evidence-manifest.json'), 'utf8')
    )
    expect(committed.issue).toBe(1225)
    expect(committed.sourceSha).toBe('34e173df7bf4654d53e2b4daed5ff41239cafd8b')
    expect(committed.entries).toEqual([])
    expect(committed.compatibility.contractVersions).toEqual([])

    const report = validateEvidenceManifest(
      committed,
      fixtureIo({ commits: [committed.sourceSha] })
    )
    expect(report.schemaErrors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.counts[STATUS.pending]).toBe(64)
    expect(
      validateEvidenceManifest(committed, fixtureIo({ commits: [committed.sourceSha] }), {
        strict: true,
      }).ok
    ).toBe(false)
  })
})

describe('evidence manifest validation', () => {
  test('promotes a fully evidenced id to candidate-compatible and leaves others pending', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(report.ok).toBe(true)
    expect(statusOf(report, 'A01').status).toBe(STATUS.candidateCompatible)
    expect(statusOf(report, 'A02')).toMatchObject({ status: STATUS.pending })
    expect(report.counts[STATUS.candidateCompatible]).toBe(1)
    expect(report.counts[STATUS.pending]).toBe(63)
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
      manifest([{ id: 'REQ-005', sourceSha: SHA, repoEvidence: [], candidateEvidence: [] }]),
      fixtureIo()
    )
    expect(statusOf(report, 'REQ-005')).toMatchObject({
      status: STATUS.pending,
      reasons: ['no repository evidence mapped'],
    })
    expect(report.ok).toBe(true)
  })

  test('fails when a declared test file is missing at the pinned SHA', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(manifest([entry]), { ...io, readAtSha: () => null })
    expect(statusOf(report, 'A01').status).toBe(STATUS.invalid)
    expect(statusOf(report, 'A01').reasons[0]).toContain(`does not exist at ${SHA}`)
    expect(report.ok).toBe(false)
  })

  test('fails when the test title is not declared in the file', () => {
    const { io, entry } = completeFixture({
      io: { files: { [`${SHA}:${TEST_PATH}`]: `test('some other title', () => {})` } },
    })
    const report = validateEvidenceManifest(manifest([entry]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('is not declared')
    expect(report.ok).toBe(false)
  })

  test('rejects a test path that is not a test file', () => {
    const { io, entry } = completeFixture()
    const bad = {
      ...entry,
      repoEvidence: [{ kind: 'test', path: 'scripts/evidence-manifest.mjs', name: TEST_TITLE }],
    }
    expect(validateEvidenceManifest(manifest([bad]), io).ok).toBe(false)
  })

  test('fails when an entry pins a different SHA from the manifest', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(manifest([{ ...entry, sourceSha: '2'.repeat(40) }]), io)
    expect(statusOf(report, 'A01').status).toBe(STATUS.invalid)
    expect(statusOf(report, 'A01').reasons[0]).toContain('entry pins')
  })

  test('fails when a run record bytes differ from the pinned hash', () => {
    const { io, entry } = completeFixture()
    const tampered = {
      ...entry,
      repoEvidence: entry.repoEvidence.map((item) =>
        item.kind === 'run' ? { ...item, sha256: '0'.repeat(64) } : item
      ),
    }
    const report = validateEvidenceManifest(manifest([tampered]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('does not match sha256')
    expect(report.ok).toBe(false)
  })

  test('does not count a run record that did not pass', () => {
    const run = record({ sourceSha: SHA, command: 'bun test', status: 'failed', ids: ['A01'] })
    const { io, entry } = completeFixture({ io: { working: { 'artifacts/run.json': run.bytes } } })
    const failing = {
      ...entry,
      repoEvidence: entry.repoEvidence.map((item) =>
        item.kind === 'run' ? { ...item, sha256: run.sha256 } : item
      ),
    }
    const report = validateEvidenceManifest(manifest([failing]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain('not passed')
    expect(report.ok).toBe(false)
  })

  test('rejects a candidate built from a different source SHA', () => {
    const candidate = record({
      candidateId: 'pkg-old',
      channel: 'packaged',
      sourceSha: '3'.repeat(40),
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A01'],
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/candidate.json': candidate.bytes } },
    })
    const mismatched = {
      ...entry,
      candidateEvidence: [
        { kind: 'candidate', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
      ],
    }
    const report = validateEvidenceManifest(manifest([mismatched]), io)
    expect(statusOf(report, 'A01').status).toBe(STATUS.invalid)
    expect(statusOf(report, 'A01').reasons[0]).toContain('built from')
  })

  test('rejects a candidate whose contract version is not listed as compatible', () => {
    const candidate = record({
      candidateId: 'dep-1',
      channel: 'deployed',
      sourceSha: SHA,
      contractVersion: 'pi-durable-2025-01',
      status: 'passed',
      ids: ['A01'],
    })
    const { io, entry } = completeFixture({
      io: { working: { 'artifacts/candidate.json': candidate.bytes } },
    })
    const incompatible = {
      ...entry,
      candidateEvidence: [
        { kind: 'candidate', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
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
      sourceSha: SHA,
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A01'],
    })
    const notListed = record({
      candidateId: 'y',
      channel: 'deployed',
      sourceSha: SHA,
      contractVersion: CONTRACT,
      status: 'passed',
      ids: ['A02'],
    })
    for (const [candidate, reason] of [
      [unknownChannel, 'is not packaged or deployed'],
      [notListed, 'does not list A01'],
    ] as const) {
      const { io, entry } = completeFixture({
        io: { working: { 'artifacts/candidate.json': candidate.bytes } },
      })
      const bad = {
        ...entry,
        candidateEvidence: [
          { kind: 'candidate', path: 'artifacts/candidate.json', sha256: candidate.sha256 },
        ],
      }
      const report = validateEvidenceManifest(manifest([bad]), io)
      expect(statusOf(report, 'A01').reasons[0]).toContain(reason)
    }
  })

  test('a missing candidate record file is invalid rather than pending', () => {
    const { io, entry } = completeFixture()
    const report = validateEvidenceManifest(
      manifest([{ ...entry, repoEvidence: [entry.repoEvidence[0]] }]),
      { ...io, readWorking: () => null }
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
      repoEvidence: [{ kind: 'run', path, sha256: '0'.repeat(64) }],
    }
    const report = validateEvidenceManifest(manifest([unsafe]), io)
    expect(statusOf(report, 'A01').reasons[0]).toContain(reason)
  })

  test('rejects schema errors: unknown id, duplicate entry, bad SHA, missing commit, wrong issue', () => {
    const { io, entry } = completeFixture()
    expect(validateEvidenceManifest(manifest([{ ...entry, id: 'A41' }]), io).schemaErrors).toEqual([
      'unknown id A41',
    ])
    expect(validateEvidenceManifest(manifest([entry, entry]), io).schemaErrors).toEqual([
      'duplicate entry A01',
    ])
    expect(validateEvidenceManifest(manifest([], { sourceSha: 'abc' }), io).ok).toBe(false)
    expect(
      validateEvidenceManifest(manifest([], { sourceSha: '4'.repeat(40) }), fixtureIo())
        .schemaErrors
    ).toEqual([`sourceSha ${'4'.repeat(40)} is not a commit in this repository`])
    expect(validateEvidenceManifest(manifest([], { issue: 1183 }), io).schemaErrors).toEqual([
      'issue must be 1225',
    ])
  })

  test('rejects malformed entries without throwing', () => {
    const report = validateEvidenceManifest(manifest([{ id: 'A01', sourceSha: SHA }]), fixtureIo())
    expect(report.ok).toBe(false)
    expect(report.schemaErrors[0]).toContain('must list repoEvidence and candidateEvidence')
  })
})

describe('repositoryIo provenance', () => {
  test('reads committed bytes at a SHA and working files only inside the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-evidence-manifest-'))
    try {
      const git = (args) =>
        spawnSync('git', args, {
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
      git(['init', '-q'])
      writeFileSync(join(dir, 'a.test.ts'), "test('committed', () => {})\n")
      git(['add', 'a.test.ts'])
      git(['commit', '-q', '-m', 'fixture'])
      const sha = git(['rev-parse', 'HEAD']).stdout.trim()
      writeFileSync(join(dir, 'a.test.ts'), "test('uncommitted', () => {})\n")
      writeFileSync(join(dir, 'run.json'), '{}')

      const io = repositoryIo(dir)
      expect(io.commitExists(sha)).toBe(true)
      expect(io.commitExists('5'.repeat(40))).toBe(false)
      expect(io.readAtSha(sha, 'a.test.ts')).toContain('committed')
      expect(io.readAtSha(sha, 'missing.test.ts')).toBeNull()
      expect(io.readWorking('run.json')?.toString()).toBe('{}')
      expect(io.readWorking('../outside.json')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
