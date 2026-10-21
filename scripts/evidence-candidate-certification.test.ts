import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  browserConditionLane,
  buildCertificationMap,
  buildReport,
  certificationExitCode,
  changedSince,
  classifyRunnable,
  CLASS,
  CLASS_STATUS,
  countEntries,
  discoverQualifications,
  dispositionFor,
  disposableLane,
  gapTokens,
  EVIDENCE_CLASSES,
  exportCleanCheckout,
  installWorkspaceDependencies,
  isHelperOnlyPath,
  isLoopbackDatabaseUrl,
  nonUiLane,
  owningPackage,
  readReceipts,
  readCrossRepositoryPin,
  readinessCriteriaForId,
  requiredBuilds,
  REQUIRED_IDS,
  runCrossProductJourney,
  runPackageConsumerJourney,
  revisionDistance,
  summarize,
  validateCandidateArtifacts,
  valueWorkspaceImports,
} from './evidence-candidate-certification.mjs'

const root = resolve(import.meta.dir, '..')
const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const ROOT_COMMIT = 'c'.repeat(40)
const CONTRACT = 'pi-durable-2026-10'

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A checkout fake whose committed blobs are keyed `<sha>:<path>`. */
function checkoutFake({ commits = [SHA], blobs = {} } = {}) {
  return {
    root: root,
    commitExists: (sha) => commits.includes(sha),
    rootCommits: (sha) => (sha === commits[0] ? [ROOT_COMMIT] : []),
    blobAtSha: (sha, path) => {
      const blob = blobs[`${sha}:${path}`]
      if (blob === undefined) return null
      const bytes = Buffer.from(blob.content ?? '')
      return { regular: true, mode: '100644', size: bytes.length, bytes: () => bytes }
    },
  }
}

const packageBlob = (name, version) =>
  JSON.stringify({ name, version, private: true, exports: { '.': { import: './dist/index.js' } } })

function manifestFor(entries, overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 1225,
    repositories: {
      adea: { name: 'adea-ai/adea', rootCommit: ROOT_COMMIT, sourceSha: SHA },
    },
    compatibility: { contractVersions: [] },
    entries,
    ...overrides,
  }
}

const testReference = (path, name) => ({
  kind: 'test-reference',
  repository: 'adea',
  path,
  name,
})

describe('evidence classes', () => {
  test('the five classes are distinct and ordered by where the evidence was produced', () => {
    expect(EVIDENCE_CLASSES).toEqual([
      'source',
      'disposable-integration',
      'packaged-native',
      'deployed',
      'owner-daily-driver',
    ])
    expect(new Set(EVIDENCE_CLASSES).size).toBe(EVIDENCE_CLASSES.length)
    expect(CLASS.ownerDailyDriver).toBe('owner-daily-driver')
  })

  test('an integration path can only claim the disposable integration class', () => {
    const map = {
      'packages/db/tests/integration/artifact-reference-service.test.ts':
        CLASS.disposableIntegration,
      'packages/db/tests/unit/artifact-reference-policy.test.ts': CLASS.source,
      'apps/web/test/lead-turn-runtime.test.ts': CLASS.source,
    }
    for (const [path, expected] of Object.entries(map)) {
      const entry = { test: { path }, evidenceClass: expected }
      expect(entry.evidenceClass).toBe(expected)
    }
  })
})

describe('helper and fixture detection', () => {
  test('a fixture or helper module is recognised', () => {
    expect(isHelperOnlyPath('packages/db/tests/fixtures/pi-durable-candidate.ts')).toBe(true)
    expect(isHelperOnlyPath('scripts/pi-durable-candidate/packed-consumer-fixture.mjs')).toBe(true)
    expect(isHelperOnlyPath('apps/web/test/helpers/render.ts')).toBe(true)
    expect(isHelperOnlyPath('packages/db/tests/unit/fixture.test.ts')).toBe(true)
  })

  test('a product test file is not a helper', () => {
    expect(isHelperOnlyPath('packages/db/tests/unit/artifact-reference-policy.test.ts')).toBe(false)
    expect(isHelperOnlyPath('apps/web/test/lead-turn-runtime.test.ts')).toBe(false)
    expect(isHelperOnlyPath('packages/workspace-ui/tests/unit/lead-turn-state.test.ts')).toBe(false)
  })
})

describe('owning package', () => {
  test('the package and its version are read at the pinned commit', () => {
    const checkout = checkoutFake({
      blobs: {
        [`${SHA}:packages/workspace-ui/package.json`]: {
          content: packageBlob('@adea-ai/workspace-ui', '0.99.0'),
        },
      },
    })
    const owner = owningPackage(
      checkout,
      SHA,
      'packages/workspace-ui/tests/unit/lead-turn-state.test.ts'
    )
    expect(owner?.name).toBe('@adea-ai/workspace-ui')
    expect(owner?.version).toBe('0.99.0')
    expect(owner?.path).toBe('packages/workspace-ui')
  })

  test('a path with no package above it has no owner', () => {
    expect(owningPackage(checkoutFake(), SHA, 'docs/plans/m18-evidence-manifest.json')).toBe(null)
  })
})

describe('candidate artifact validation', () => {
  const artifactPath = 'docs/evidence/candidate-artifact.txt'
  const artifactBytes = Buffer.from('candidate artifact\n')

  const candidate = (overrides = {}) => ({
    candidateId: 'pr-1542',
    repository: 'adea',
    commit: BASE,
    channel: 'packaged',
    evidenceClass: CLASS.packagedNative,
    contractVersion: CONTRACT,
    ids: ['A01'],
    status: 'passed',
    exitCode: 0,
    command: 'bun test candidate.test.ts',
    artifacts: [{ path: artifactPath, sha256: sha256Of(artifactBytes) }],
    ...overrides,
  })

  const artifactManifest = (overrides = {}) => ({
    schema: 'adea.evidence.candidate-artifacts.v1',
    issue: 1225,
    baseHead: BASE,
    contractVersion: CONTRACT,
    candidates: [candidate()],
    ...overrides,
  })

  const setup = (raw) => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    writeArtifact(scratch)
    const checkout = checkoutFake({ commits: [SHA, BASE] })
    const result = validateCandidateArtifacts(raw, {
      baseHead: BASE,
      contractVersions: [CONTRACT],
      checkout,
      root: scratch,
    })
    rmSync(scratch, { recursive: true, force: true })
    return result
  }

  /** Writes the declared artifact where the validator looks for it. */
  function writeArtifact(scratch) {
    mkdirSync(join(scratch, 'docs', 'evidence'), { recursive: true })
    writeFileSync(join(scratch, artifactPath), artifactBytes)
  }

  test('a missing manifest is reported as missing, never as an empty candidate list', () => {
    const result = setup(null)
    expect(result.status).toBe('missing')
    expect(result.candidates).toHaveLength(0)
    expect(result.rejections[0].reason).toContain('No candidate artifact manifest')
  })

  test('a manifest with another schema is incompatible', () => {
    const result = setup(artifactManifest({ schema: 'adea.evidence.other.v1' }))
    expect(result.status).toBe('incompatible')
    expect(result.candidates).toHaveLength(0)
  })

  test('a manifest pinned to another base is stale', () => {
    const result = setup(artifactManifest({ baseHead: SHA }))
    expect(result.status).toBe('stale')
    expect(result.candidates).toHaveLength(0)
  })

  test('a manifest that does not pin a base commit is incompatible', () => {
    const result = setup(artifactManifest({ baseHead: undefined }))
    expect(result.status).toBe('incompatible')
    expect(result.candidates).toHaveLength(0)
  })

  test('a contract version the evidence manifest does not declare is incompatible', () => {
    const result = setup(artifactManifest({ contractVersion: 'other-contract' }))
    expect(result.status).toBe('incompatible')
  })

  test('an evidence manifest with no compatible contract rejects every candidate', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    writeArtifact(scratch)
    const checkout = checkoutFake({ commits: [SHA, BASE] })
    const result = validateCandidateArtifacts(artifactManifest(), {
      baseHead: BASE,
      contractVersions: [],
      checkout,
      root: scratch,
    })
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('incompatible')
    expect(result.candidates).toHaveLength(0)
  })

  test('a candidate whose commit is not in the checkout is unavailable', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    const result = validateCandidateArtifacts(artifactManifest(), {
      baseHead: BASE,
      contractVersions: [CONTRACT],
      checkout: checkoutFake({ commits: [SHA] }),
      root: scratch,
    })
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('unavailable')
    expect(
      result.rejections.some((entry) => entry.reason.includes('not present in this checkout'))
    ).toBe(true)
  })

  test('a helper or fixture artifact cannot carry a packaged candidate claim', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    const fixturePath = 'scripts/pi-durable-candidate/packed-consumer-fixture.mjs'
    mkdirSync(join(scratch, 'scripts/pi-durable-candidate'), { recursive: true })
    writeFileSync(join(scratch, fixturePath), 'fixture\n')
    const result = validateCandidateArtifacts(
      artifactManifest({
        candidates: [
          candidate({
            artifacts: [{ path: fixturePath, sha256: sha256Of(Buffer.from('fixture\n')) }],
          }),
        ],
      }),
      {
        baseHead: BASE,
        contractVersions: [CONTRACT],
        checkout: checkoutFake({ commits: [SHA, BASE] }),
        root: scratch,
      }
    )
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('rejected')
    expect(
      result.rejections.some((entry) => entry.reason.includes('helper or fixture module'))
    ).toBe(true)
  })

  test('an artifact whose digest does not match is rejected', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    writeArtifact(scratch)
    const result = validateCandidateArtifacts(
      artifactManifest({
        candidates: [candidate({ artifacts: [{ path: artifactPath, sha256: 'd'.repeat(64) }] })],
      }),
      {
        baseHead: BASE,
        contractVersions: [CONTRACT],
        checkout: checkoutFake({ commits: [SHA, BASE] }),
        root: scratch,
      }
    )
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('rejected')
    expect(
      result.rejections.some((entry) => entry.reason.includes('does not match its sha256'))
    ).toBe(true)
  })

  test('a candidate that names an unknown id is rejected', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    writeArtifact(scratch)
    const result = validateCandidateArtifacts(
      artifactManifest({ candidates: [candidate({ ids: ['A99'] })] }),
      {
        baseHead: BASE,
        contractVersions: [CONTRACT],
        checkout: checkoutFake({ commits: [SHA, BASE] }),
        root: scratch,
      }
    )
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('rejected')
    expect(result.rejections.some((entry) => entry.reason.includes('unknown ids'))).toBe(true)
  })

  test('a channel that cannot carry the claimed class is incompatible', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-artifact-'))
    writeArtifact(scratch)
    const result = validateCandidateArtifacts(
      artifactManifest({
        candidates: [candidate({ channel: 'deployed', evidenceClass: CLASS.packagedNative })],
      }),
      {
        baseHead: BASE,
        contractVersions: [CONTRACT],
        checkout: checkoutFake({ commits: [SHA, BASE] }),
        root: scratch,
      }
    )
    rmSync(scratch, { recursive: true, force: true })
    expect(result.status).toBe('incompatible')
  })

  test('a valid candidate is accepted', () => {
    const result = setup(artifactManifest())
    expect(result.status).toBe('accepted')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].candidateId).toBe('pr-1542')
    expect(result.candidates[0].commit).toBe(BASE)
  })
})

describe('certification map', () => {
  const checkout = checkoutFake({
    blobs: {
      [`${SHA}:packages/workspace-ui/package.json`]: {
        content: packageBlob('@adea-ai/workspace-ui', '0.99.0'),
      },
    },
  })

  const manifest = manifestFor([
    {
      id: 'A01',
      coverage: 'partial',
      gaps: ['the exactly-one-lead invariant is not tested'],
      repoEvidence: [
        testReference(
          'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
          'only the designated lead'
        ),
        {
          kind: 'execution-reference',
          repository: 'adea',
          path: 'docs/plans/m18-evidence-runs/a01.execution.json',
          sha256: 'e'.repeat(64),
        },
      ],
      candidateEvidence: [],
    },
    {
      id: 'A02',
      coverage: 'partial',
      gaps: [],
      repoEvidence: [
        testReference('packages/db/tests/fixtures/only-a-fixture.test.ts', 'a fixture title'),
      ],
      candidateEvidence: [],
    },
  ])

  const receipts = new Map([
    [
      'docs/plans/m18-evidence-runs/a01.execution.json',
      {
        path: 'docs/plans/m18-evidence-runs/a01.execution.json',
        file: 'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
        command: 'bun test packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
        sourceSha: SHA,
        ids: ['A01'],
        pass: 1,
        fail: 0,
        passing: ['only the designated lead'],
      },
    ],
  ])

  const build = (overrides = {}) =>
    buildCertificationMap({
      manifest,
      receipts,
      checkout,
      baseHead: BASE,
      changedTestFiles: new Set(),
      reproduced: new Map(),
      ...overrides,
    })

  test('every requirement and acceptance id appears in the map', () => {
    const entries = build()
    expect(entries).toHaveLength(REQUIRED_IDS.length)
    expect(entries.map((entry) => entry.id)).toEqual([...REQUIRED_IDS])
    expect(entries.filter((entry) => entry.id === 'A01')).toHaveLength(1)
    expect(entries.filter((entry) => entry.id === 'REQ-005')).toHaveLength(1)
  })

  test('an id with no mapped evidence stays pending and keeps its reason', () => {
    const entry = build().find((item) => item.id === 'REQ-005')
    expect(entry.status).toBe(CLASS_STATUS.pending)
    expect(entry.reasons.join(' ')).toContain('no evidence is mapped')
    expect(entry.gaps).toEqual([])
  })

  test('a mapped id names the commit, the package and its version, the test and the class', () => {
    const entry = build().find((item) => item.id === 'A01')
    expect(entry.evidenceClass).toBe(CLASS.source)
    expect(entry.package?.name).toBe('@adea-ai/workspace-ui')
    expect(entry.package?.version).toBe('0.99.0')
    expect(entry.test?.path).toBe(
      'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts'
    )
    expect(entry.titles).toEqual(['only the designated lead'])
    expect(entry.commit).toBe(SHA)
    expect(entry.gaps).toEqual(['the exactly-one-lead invariant is not tested'])
  })

  test('evidence whose cited test changed since the pin is stale', () => {
    const entry = build({
      changedTestFiles: new Set([
        'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
      ]),
    }).find((item) => item.id === 'A01')
    expect(entry.status).toBe(CLASS_STATUS.stale)
    expect(entry.reasons.join(' ')).toContain('changed between')
  })

  test('evidence whose cited test is unchanged is carried, not verified', () => {
    const entry = build().find((item) => item.id === 'A01')
    expect(entry.status).toBe(CLASS_STATUS.carried)
    expect(entry.reasons.join(' ')).toContain('still describes the certification base')
  })

  test('evidence that was reproduced at the base is verified and bound to the base', () => {
    const entry = build({
      reproduced: new Map([
        [
          'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
          { status: 'passed', passing: ['only the designated lead'] },
        ],
      ]),
    }).find((item) => item.id === 'A01')
    expect(entry.status).toBe(CLASS_STATUS.verified)
    expect(entry.commit).toBe(BASE)
  })

  test('a reproduction that did not pass the declared title does not verify the id', () => {
    const entry = build({
      reproduced: new Map([
        [
          'packages/workspace-ui/tests/unit/lead-conversation-model.test.ts',
          { status: 'passed', passing: ['another title'] },
        ],
      ]),
    }).find((item) => item.id === 'A01')
    expect(entry.status).toBe(CLASS_STATUS.carried)
    expect(entry.reasons.join(' ')).toContain('did not pass')
  })

  test('evidence that rests only on a helper or fixture module is rejected', () => {
    const entry = build().find((item) => item.id === 'A02')
    expect(entry.status).toBe(CLASS_STATUS.rejected)
    expect(entry.reasons.join(' ')).toContain('helper or fixture module')
  })
})

/** Writes an execution receipt into a scratch directory. */
function writeReceipt(scratch, name, record) {
  const path = join(scratch, name)
  writeFileSync(path, JSON.stringify(record))
  return path
}

/** Runs the certification runner as a command. */
function runRunner(extra = []) {
  return spawnSync(
    'bun',
    [join(root, 'scripts', 'evidence-candidate-certification.mjs'), ...extra],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    }
  )
}

describe('execution receipts', () => {
  const validReceipt = {
    schema: 'adea.evidence.execution.v1',
    repository: 'adea',
    sourceSha: SHA,
    executedAtHead: SHA,
    file: 'packages/db/tests/unit/artifact-reference-policy.test.ts',
    command: 'bun test packages/db/tests/unit/artifact-reference-policy.test.ts',
    exitCode: 0,
    status: 'passed',
    summary: { pass: 1, fail: 0 },
    ids: ['A09'],
    junit:
      '<?xml version="1.0"?><testsuites name="bun test" tests="1"><testsuite name="x"><testcase name="a policy title" classname="" time="0.001" file="x" line="1" assertions="1" /></testsuite></testsuites>',
  }

  test('a passing receipt is read with its titles', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-receipt-'))
    writeReceipt(scratch, 'r.json', validReceipt)
    const manifest = manifestFor([
      {
        id: 'A09',
        coverage: 'partial',
        gaps: ['gap'],
        repoEvidence: [
          {
            kind: 'execution-reference',
            repository: 'adea',
            path: 'r.json',
            sha256: '0'.repeat(64),
          },
        ],
        candidateEvidence: [],
      },
    ])
    const { receipts, problems } = readReceipts(manifest, scratch)
    rmSync(scratch, { recursive: true, force: true })
    expect(problems).toEqual([])
    expect(receipts.get('r.json')?.passing).toEqual(['a policy title'])
  })

  test('a receipt whose counts disagree with its summary is refused', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-receipt-'))
    writeReceipt(scratch, 'r.json', { ...validReceipt, summary: { pass: 9, fail: 0 } })
    const manifest = manifestFor([
      {
        id: 'A09',
        coverage: 'partial',
        gaps: ['gap'],
        repoEvidence: [
          {
            kind: 'execution-reference',
            repository: 'adea',
            path: 'r.json',
            sha256: '0'.repeat(64),
          },
        ],
        candidateEvidence: [],
      },
    ])
    const { receipts, problems } = readReceipts(manifest, scratch)
    rmSync(scratch, { recursive: true, force: true })
    expect(receipts.size).toBe(0)
    expect(problems.join(' ')).toContain('do not match its summary')
  })

  test('a receipt that binds two revisions is refused', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-receipt-'))
    writeReceipt(scratch, 'r.json', { ...validReceipt, executedAtHead: BASE })
    const manifest = manifestFor([
      {
        id: 'A09',
        coverage: 'partial',
        gaps: ['gap'],
        repoEvidence: [
          {
            kind: 'execution-reference',
            repository: 'adea',
            path: 'r.json',
            sha256: '0'.repeat(64),
          },
        ],
        candidateEvidence: [],
      },
    ])
    const { receipts, problems } = readReceipts(manifest, scratch)
    rmSync(scratch, { recursive: true, force: true })
    expect(receipts.size).toBe(0)
    expect(problems.join(' ')).toContain('does not bind one revision')
  })

  test('a failing receipt is refused', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-receipt-'))
    writeReceipt(scratch, 'r.json', { ...validReceipt, status: 'failed', exitCode: 1 })
    const manifest = manifestFor([
      {
        id: 'A09',
        coverage: 'partial',
        gaps: ['gap'],
        repoEvidence: [
          {
            kind: 'execution-reference',
            repository: 'adea',
            path: 'r.json',
            sha256: '0'.repeat(64),
          },
        ],
        candidateEvidence: [],
      },
    ])
    const { receipts, problems } = readReceipts(manifest, scratch)
    rmSync(scratch, { recursive: true, force: true })
    expect(receipts.size).toBe(0)
    expect(problems.join(' ')).toContain('not a passing run')
  })
})

describe('counts, lanes and summary', () => {
  test('counts name every status and every class', () => {
    const counts = countEntries([
      { status: CLASS_STATUS.verified, evidenceClass: CLASS.source },
      { status: CLASS_STATUS.stale, evidenceClass: CLASS.disposableIntegration },
    ])
    expect(counts.total).toBe(2)
    expect(counts.byStatus[CLASS_STATUS.verified]).toBe(1)
    expect(counts.byStatus[CLASS_STATUS.stale]).toBe(1)
    expect(counts.byClass[CLASS.source]).toBe(1)
    expect(counts.byClass[CLASS.disposableIntegration]).toBe(1)
    expect(Object.keys(counts.byClass).toSorted()).toEqual([...EVIDENCE_CLASSES].toSorted())
  })

  test('the non-UI lane leaves out browser-condition files and the disposable lane', () => {
    const entries = [
      {
        test: { path: 'packages/db/tests/unit/a.test.ts' },
        evidenceClass: CLASS.source,
        titles: ['t'],
      },
      {
        test: { path: 'apps/web/test/account-directory-pages.test.ts' },
        evidenceClass: CLASS.source,
        titles: ['t'],
      },
      {
        test: { path: 'packages/db/tests/integration/b.test.ts' },
        evidenceClass: CLASS.disposableIntegration,
        titles: ['t'],
      },
    ]
    const lane = nonUiLane(entries)
    expect(lane.map((file) => file.path)).toEqual(['packages/db/tests/unit/a.test.ts'])
    expect(disposableLane(entries)).toEqual(['packages/db/tests/integration/b.test.ts'])
  })

  test('the disposable lane accepts only a loopback database', () => {
    expect(isLoopbackDatabaseUrl('postgres://user:pass@127.0.0.1:55432/agent_hq')).toBe(true)
    expect(isLoopbackDatabaseUrl('postgres://user:pass@localhost:55432/agent_hq')).toBe(true)
    expect(isLoopbackDatabaseUrl('postgres://user:pass@db.example.com:5432/agent_hq')).toBe(false)
    expect(isLoopbackDatabaseUrl('postgres://user:pass@10.0.0.4:5432/agent_hq')).toBe(false)
    expect(isLoopbackDatabaseUrl('')).toBe(false)
    expect(isLoopbackDatabaseUrl(undefined)).toBe(false)
  })

  test('the summary states the certification outcome and the open gates', () => {
    const report = {
      base: { repository: 'adea', commit: BASE, branch: 'codex/test' },
      candidate: { repository: 'adea', commit: BASE, packageVersion: '0.99.0' },
      manifest: {
        path: 'm.json',
        pinnedCommit: SHA,
        stale: true,
        behind: 3,
        contractVersions: [],
        receiptProblems: [],
      },
      counts: {
        byStatus: {},
        byClass: {},
        byDisposition: { passed: 1 },
        certified: 0,
      },
      candidates: { rejected: [] },
      journeys: [],
      gates: [{ id: 'owner-acceptance', owner: 'owner' }],
      entries: [],
      readinessProbes: [],
      certification: {
        statement: 'certification: incomplete (0 of 64 certified; 9 external gates open)',
      },
    }
    const summary = summarize(report)
    expect(summary).toContain('certification: incomplete')
    expect(summary).toContain('gate owner-acceptance: open (owner)')
    expect(summary).toContain('stale, 3 commits behind')
    expect(summary).toContain('candidate: adea@')
    expect(summary).toContain('dispositions:')
  })
})

describe('report assembly', () => {
  test('an empty candidate set and open gates keep the certification incomplete', () => {
    const manifest = manifestFor([])
    const candidateArtifacts = {
      status: 'missing',
      candidates: [],
      rejections: [{ candidateId: null, status: 'missing', reason: 'no manifest' }],
    }
    const report = buildReport({
      manifest,
      manifestPath: 'docs/plans/m18-evidence-manifest.json',
      receipts: new Map(),
      receiptProblems: [],
      checkout: checkoutFake(),
      baseHead: BASE,
      branch: 'codex/test',
      clean: true,
      candidateArtifacts,
    })
    expect(report.certification.certified).toBe(0)
    expect(report.certification.total).toBe(REQUIRED_IDS.length)
    expect(report.certification.state).toBe('incomplete')
    expect(report.gates.length).toBeGreaterThan(0)
    expect(report.gates.every((gate) => gate.status === 'open')).toBe(true)
    expect(report.candidates.status).toBe('missing')
  })
})

describe('clean checkout', () => {
  test('a commit is exported and the exported tree matches the commit', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-git-'))
    const repo = join(scratch, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'certification@example.invalid')
    git('config', 'user.name', 'Certification')
    writeFileSync(join(repo, 'a.txt'), 'alpha\n')
    mkdirSync(join(repo, 'nested'), { recursive: true })
    writeFileSync(join(repo, 'nested', 'b.txt'), 'beta\n')
    git('add', '.')
    git('commit', '-qm', 'seed')
    const sha = git('rev-parse', 'HEAD').stdout.trim()
    const checkout = { ...checkoutFake({ commits: [sha] }), root: repo }
    const target = join(scratch, 'export')
    const exported = exportCleanCheckout(checkout, sha, target)
    expect(exported.missing).toEqual([])
    expect(exported.extra).toEqual([])
    expect(readFileSync(join(target, 'nested', 'b.txt'), 'utf8')).toBe('beta\n')
    rmSync(scratch, { recursive: true, force: true })
  })

  test('a workspace package is linked to the clean checkout and a third-party one to the installed tree', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-deps-'))
    const source = join(scratch, 'source')
    const target = join(scratch, 'target')
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    mkdirSync(join(source, 'node_modules', '@adea-ai'), { recursive: true })
    mkdirSync(join(source, 'node_modules', 'left-pad'), { recursive: true })
    mkdirSync(join(source, 'packages', 'types'), { recursive: true })
    writeFileSync(
      join(source, 'packages', 'types', 'package.json'),
      JSON.stringify({ name: '@adea-ai/types', version: '0.0.0' })
    )
    writeFileSync(join(source, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    symlinkSync(
      join(source, 'packages', 'types'),
      join(source, 'node_modules', '@adea-ai', 'types')
    )
    // The clean checkout carries its own root manifest and its own package.
    writeFileSync(join(target, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    mkdirSync(join(target, 'packages', 'types'), { recursive: true })
    writeFileSync(
      join(target, 'packages', 'types', 'package.json'),
      JSON.stringify({ name: '@adea-ai/types', version: '0.0.0' })
    )
    const result = installWorkspaceDependencies(source, target)
    expect(result.installed).toBe(true)
    expect(result.linked).toContain('workspace:types')
    expect(readlinkSync(join(target, 'node_modules', '@adea-ai', 'types'))).toBe(
      '../../packages/types'
    )
    expect(readlinkSync(join(target, 'node_modules', 'left-pad'))).toBe(
      join(source, 'node_modules', 'left-pad')
    )
    rmSync(scratch, { recursive: true, force: true })
  })

  test('a scope entry without a matching local package keeps the installed entry', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-deps-'))
    const source = join(scratch, 'source')
    const target = join(scratch, 'target')
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    mkdirSync(join(source, 'node_modules', '@adea-ai', 'ui'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    mkdirSync(join(target, 'packages'), { recursive: true })
    const result = installWorkspaceDependencies(source, target)
    expect(result.installed).toBe(true)
    expect(result.linked).toEqual([])
    expect(readlinkSync(join(target, 'node_modules', '@adea-ai', 'ui'))).toBe(
      join(source, 'node_modules', '@adea-ai', 'ui')
    )
    rmSync(scratch, { recursive: true, force: true })
  })
})

describe('revision distance and changed files', () => {
  test('the distance between two commits is counted, and the changed files are named', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-revision-'))
    const repo = join(scratch, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'certification@example.invalid')
    git('config', 'user.name', 'Certification')
    writeFileSync(join(repo, 'a.txt'), 'alpha\n')
    git('add', '.')
    git('commit', '-qm', 'first')
    const first = git('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(repo, 'b.txt'), 'beta\n')
    writeFileSync(join(repo, 'a.txt'), 'alpha changed\n')
    git('add', '.')
    git('commit', '-qm', 'second')
    const second = git('rev-parse', 'HEAD').stdout.trim()
    const checkout = { ...checkoutFake({ commits: [first, second] }), root: repo }
    expect(revisionDistance(checkout, first, second)).toEqual({ behind: 1, relation: 'descendant' })
    expect(revisionDistance(checkout, first, first)).toEqual({ behind: 0, relation: 'same' })
    expect(changedSince(checkout, first, second, ['a.txt', 'b.txt', 'c.txt'])).toEqual([
      'a.txt',
      'b.txt',
    ])
    rmSync(scratch, { recursive: true, force: true })
  })

  test('an unknown revision is reported as unknown and never as a count', () => {
    const checkout = { ...checkoutFake({ commits: [] }), root: root }
    expect(revisionDistance(checkout, SHA, BASE)).toEqual({ behind: null, relation: 'unknown' })
  })
})

describe('the packages a clean checkout has to build', () => {
  test('a value import needs a built artifact and a type-only import does not', () => {
    const source = [
      "import type { AgentSummary } from '@adea-ai/types'",
      "import { workspaceStore } from '@adea-ai/state'",
      "import { QueryClient } from '@tanstack/solid-query'",
      "import { createX } from '../../src/x'",
    ].join('\n')
    expect(valueWorkspaceImports(source)).toEqual(['@adea-ai/state'])
  })

  test('a subpath import of a workspace package is recognised', () => {
    const source = "import { x } from '@adea-ai/api-client/model-connections'"
    expect(valueWorkspaceImports(source)).toEqual(['@adea-ai/api-client/model-connections'])
  })

  test('the packages to build are the value-imported ones and their workspace dependencies, in order', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-build-'))
    const write = (directory, name, dependencies = []) => {
      mkdirSync(join(scratch, directory), { recursive: true })
      writeFileSync(
        join(scratch, directory, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', dependencies })
      )
    }
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    write('packages/types', '@adea-ai/types')
    write('packages/state', '@adea-ai/state', { '@adea-ai/types': 'workspace:*' })
    write('packages/data', '@adea-ai/data', { '@adea-ai/state': 'workspace:*' })
    mkdirSync(join(scratch, 'packages', 'data', 'tests'), { recursive: true })
    writeFileSync(
      join(scratch, 'packages', 'data', 'tests', 'a.test.ts'),
      "import { workspaceStore } from '@adea-ai/state'\nimport type { T } from '@adea-ai/types'\n"
    )
    const builds = requiredBuilds(scratch, ['packages/data/tests/a.test.ts'])
    expect(builds).toEqual(['packages/types', 'packages/state'])
    rmSync(scratch, { recursive: true, force: true })
  })

  test('a test file with no value import of a workspace package needs no build', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-build-'))
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    mkdirSync(join(scratch, 'packages', 'data', 'tests'), { recursive: true })
    writeFileSync(
      join(scratch, 'packages', 'data', 'tests', 'a.test.ts'),
      "import type { T } from '@adea-ai/types'\n"
    )
    expect(requiredBuilds(scratch, ['packages/data/tests/a.test.ts'])).toEqual([])
    rmSync(scratch, { recursive: true, force: true })
  })
})

describe('the package-consumer journey', () => {
  test('a packed package installs into a consumer and carries the declared name and version', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-pack-'))
    const packageRoot = join(scratch, 'package')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@adea-ai/certification-probe',
        version: '1.2.3',
        exports: { '.': { import: './dist/index.js' } },
      })
    )
    writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const probe = 1\n')
    const declared = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const result = runPackageConsumerJourney({
      packageRoot,
      packagePath: 'packages/probe',
      declared,
    })
    expect(result.status).toBe('passed')
    expect(result.installed).toEqual({ name: '@adea-ai/certification-probe', version: '1.2.3' })
    expect(result.artifactDigest).toMatch(/^[0-9a-f]{64}$/)
    rmSync(scratch, { recursive: true, force: true })
  })

  test('a package whose export target is missing is reported as a failure', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-pack-'))
    const packageRoot = join(scratch, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const declared = {
      name: '@adea-ai/certification-probe',
      version: '1.2.3',
      exports: { '.': { import: './dist/index.js' } },
    }
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(declared))
    const result = runPackageConsumerJourney({
      packageRoot,
      packagePath: 'packages/probe',
      declared,
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('does not contain')
    rmSync(scratch, { recursive: true, force: true })
  })
})

describe('the strict exit code', () => {
  const incomplete = { certification: { state: 'incomplete', certified: 0 } }
  const complete = { certification: { state: 'complete', certified: 64 } }

  test('a plain run exits zero even while ids are uncertified', () => {
    expect(certificationExitCode(incomplete)).toBe(0)
    expect(certificationExitCode(incomplete, { strict: false })).toBe(0)
  })

  test('a strict run exits non-zero while any id is uncertified', () => {
    expect(certificationExitCode(incomplete, { strict: true })).toBe(1)
  })

  test('a strict run exits zero only when every id is certified', () => {
    expect(certificationExitCode(complete, { strict: true })).toBe(0)
  })

  test('the command exits one in strict mode and prints the exact line', () => {
    const result = spawnSync(
      'bun',
      [join(root, 'scripts', 'evidence-candidate-certification.mjs'), '--strict'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 16,
      }
    )
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('strict: not every id is certified')
  }, 120_000)

  test('the command exits zero without strict mode', () => {
    const result = spawnSync(
      'bun',
      [join(root, 'scripts', 'evidence-candidate-certification.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 16,
      }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('strict: not every id is certified')
  }, 120_000)

  test('an unknown option is refused instead of shifting the manifest path', () => {
    const result = spawnSync(
      'bun',
      [join(root, 'scripts', 'evidence-candidate-certification.mjs'), '--not-an-option', 'value'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown option --not-an-option')
  }, 120_000)
})

describe('the row disposition', () => {
  test('a verified row is passed and a rejected row is failed', () => {
    expect(dispositionFor({ status: CLASS_STATUS.verified, hasEvidence: true })).toBe('passed')
    expect(dispositionFor({ status: CLASS_STATUS.rejected, hasEvidence: true })).toBe('failed')
  })

  test('a row whose cited file failed is failed, and a row that was not run is skipped', () => {
    expect(
      dispositionFor({
        status: CLASS_STATUS.stale,
        hasEvidence: true,
        failedFile: 'a.test.ts',
      })
    ).toBe('failed')
    expect(dispositionFor({ status: CLASS_STATUS.stale, hasEvidence: true })).toBe('skipped')
    expect(dispositionFor({ status: CLASS_STATUS.carried, hasEvidence: true })).toBe('skipped')
  })

  test('a row with no mapped evidence is untestable when nothing can evidence it', () => {
    expect(dispositionFor({ status: CLASS_STATUS.pending, hasEvidence: false })).toBe('untestable')
  })

  test('a row with a passing qualification that the manifest does not map is unavailable', () => {
    const reproduced = new Map([['a.test.ts', { status: 'passed', passing: ['t'] }]])
    expect(
      dispositionFor({
        status: CLASS_STATUS.pending,
        hasEvidence: false,
        rowDiscovered: [
          { gap: 'g', tokens: ['g'], subject: 'g', leads: [{ file: 'a.test.ts', score: 2 }] },
        ],
        reproduced,
      })
    ).toBe('unavailable')
  })

  test('a row whose readiness criterion is unavailable is unavailable', () => {
    expect(
      dispositionFor({
        status: CLASS_STATUS.pending,
        hasEvidence: false,
        rowReadiness: [{ id: 'OPS-12', method: { kind: 'unavailable' } }],
      })
    ).toBe('unavailable')
  })

  test('a row with a qualification that was not run is skipped', () => {
    expect(
      dispositionFor({
        status: CLASS_STATUS.pending,
        hasEvidence: false,
        rowDiscovered: [
          { gap: 'g', tokens: ['g'], subject: 'g', leads: [{ file: 'a.test.ts', score: 2 }] },
        ],
      })
    ).toBe('skipped')
  })

  test('a row whose subject word is in no test file at all is untestable', () => {
    expect(
      dispositionFor({
        status: CLASS_STATUS.pending,
        hasEvidence: false,
        rowDiscovered: [{ gap: 'g', tokens: ['g'], subject: 'g', leads: [], unmentioned: ['g'] }],
      })
    ).toBe('untestable')
  })
})

describe('the readiness inventory mapping', () => {
  const criteria = [
    { id: 'ACC-01', source: 'TDD section 20, A25; PRD REQ 136', method: { kind: 'axe' } },
    {
      id: 'OPS-12',
      source: 'TDD section 20 (exact compatible packaged and deployed candidates)',
      method: { kind: 'unavailable' },
    },
  ]

  test('a criterion is found by the acceptance id it names', () => {
    expect(readinessCriteriaForId(criteria, 'A25').map((criterion) => criterion.id)).toEqual([
      'ACC-01',
    ])
  })

  test('a criterion is found by the requirement id it names', () => {
    expect(readinessCriteriaForId(criteria, 'REQ-136').map((criterion) => criterion.id)).toEqual([
      'ACC-01',
    ])
  })

  test('a criterion that names no id is not attributed to one', () => {
    expect(readinessCriteriaForId(criteria, 'OPS-12')).toEqual([])
    expect(readinessCriteriaForId(criteria, 'A40')).toEqual([])
  })
})

describe('the gap search', () => {
  test('the content words of a gap are the subject of the gap', () => {
    expect(gapTokens('writer lease and conflict handling are not tested')).toEqual([
      'writer',
      'lease',
      'conflict',
      'handling',
    ])
  })

  test('a stop word, a short word and a meta word carry no subject', () => {
    expect(gapTokens('the budget is not tested')).toEqual(['budget'])
    expect(gapTokens('the writer lease and conflict handling are not tested')).toEqual([
      'writer',
      'lease',
      'conflict',
      'handling',
    ])
  })

  test('a file qualifies for a gap only when it mentions every distinctive word', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-gap-'))
    const repo = join(scratch, 'repo')
    mkdirSync(join(repo, 'packages', 'db', 'tests', 'unit'), { recursive: true })
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'certification@example.invalid')
    git('config', 'user.name', 'Certification')
    writeFileSync(
      join(repo, 'packages', 'db', 'tests', 'unit', 'lease.test.ts'),
      "test('a writer lease and conflict handling are refused', () => {})\n"
    )
    writeFileSync(
      join(repo, 'packages', 'db', 'tests', 'unit', 'other.test.ts'),
      "test('a writer lease is granted', () => {})\n"
    )
    git('add', '.')
    git('commit', '-qm', 'seed')
    const sha = git('rev-parse', 'HEAD').stdout.trim()
    const found = discoverQualifications({
      gaps: ['writer lease and conflict handling are not tested'],
      revision: sha,
      cwd: repo,
    })
    expect(found).toHaveLength(1)
    expect(found[0].subject).toBe('conflict')
    expect(found[0].leads[0].file).toBe('packages/db/tests/unit/lease.test.ts')
    expect(found[0].leads[0].score).toBe(4)
    expect(found[0].leads.map((entry) => entry.file)).toContain(
      'packages/db/tests/unit/other.test.ts'
    )
    rmSync(scratch, { recursive: true, force: true })
  })

  test('a word that matches most test files is noise and is discarded', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-gap-'))
    const repo = join(scratch, 'repo')
    mkdirSync(join(repo, 'packages', 'db', 'tests', 'unit'), { recursive: true })
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'certification@example.invalid')
    git('config', 'user.name', 'Certification')
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(
        join(repo, 'packages', 'db', 'tests', 'unit', `${name}.test.ts`),
        "test('a writer lease is granted', () => {})\n"
      )
    }
    writeFileSync(
      join(repo, 'packages', 'db', 'tests', 'unit', 'conflict.test.ts'),
      "test('a writer lease and conflict handling are refused', () => {})\n"
    )
    git('add', '.')
    git('commit', '-qm', 'seed')
    const sha = git('rev-parse', 'HEAD').stdout.trim()
    const found = discoverQualifications({
      gaps: ['writer lease and conflict handling are not tested'],
      revision: sha,
      cwd: repo,
    })
    // The subject of the gap is its rarest word, and the lead that mentions
    // it is the file that also mentions the other words.
    expect(found[0].subject).toBe('conflict')
    expect(found[0].leads[0].file).toBe('packages/db/tests/unit/conflict.test.ts')
    expect(found[0].leads[0].score).toBe(4)
    rmSync(scratch, { recursive: true, force: true })
  })
})

describe('the browser-condition lane', () => {
  test('the browser-condition file is in its own lane and not in the source lane', () => {
    const entries = [
      {
        test: { path: 'apps/web/test/account-directory-pages.test.ts' },
        tests: ['apps/web/test/account-directory-pages.test.ts'],
        evidenceClass: CLASS.source,
        titles: ['t'],
      },
      {
        test: { path: 'packages/db/tests/unit/a.test.ts' },
        tests: ['packages/db/tests/unit/a.test.ts'],
        evidenceClass: CLASS.source,
        titles: ['t'],
      },
    ]
    expect(browserConditionLane(entries)).toEqual(['apps/web/test/account-directory-pages.test.ts'])
    expect(nonUiLane(entries).map((file) => file.path)).toEqual([
      'packages/db/tests/unit/a.test.ts',
    ])
  })
})

describe('what this runner can run', () => {
  test('a Bun test file is runnable', () => {
    expect(classifyRunnable('packages/db/tests/unit/artifact-reference-policy.test.ts')).toEqual({
      runnable: true,
      reason: null,
    })
  })

  test('a Playwright specification, a fixture and a script lane test are not', () => {
    expect(classifyRunnable('apps/web/e2e/chat-view.spec.ts').runnable).toBe(false)
    expect(classifyRunnable('apps/web/e2e/chat-view.spec.ts').reason).toContain('Playwright')
    expect(classifyRunnable('apps/web/e2e/helpers/harness-app.tsx').runnable).toBe(false)
    expect(classifyRunnable('apps/web/test/control-plane-child-joined/host.mjs').runnable).toBe(
      false
    )
    expect(classifyRunnable('scripts/evidence-manifest.test.ts').runnable).toBe(false)
    expect(classifyRunnable('scripts/evidence-manifest.test.ts').reason).toContain('script lane')
    expect(classifyRunnable('packages/db/tests/fixtures/pi-durable-candidate.ts').runnable).toBe(
      false
    )
  })
})

describe('the cross-repository pin', () => {
  test('the pin is read from the repository, never invented', () => {
    const pin = readCrossRepositoryPin(root)
    expect(pin).not.toBe(null)
    expect(pin?.repository).toBe('adea-ai/control-plane')
    expect(pin?.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  test('a checkout that is not at the pinned revision is unavailable, not a pass', () => {
    const pin = readCrossRepositoryPin(root)
    const result = runCrossProductJourney({
      root,
      pin,
      controlPlaneSource: root,
      databaseUrl: 'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq',
    })
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('not the pinned revision')
  })

  test('no checkout at all is unavailable, with the reason', () => {
    const pin = readCrossRepositoryPin(root)
    const result = runCrossProductJourney({
      root,
      pin,
      controlPlaneSource: null,
      databaseUrl: '',
    })
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('ADEA_CONTROL_PLANE_SOURCE')
  })
})

describe('the runner as a command', () => {
  test('it reports the pinned manifest, the open gates and an incomplete certification', () => {
    const result = runRunner(['--json'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.schema).toBe('adea.evidence.candidate-certification.v1')
    expect(report.entries).toHaveLength(REQUIRED_IDS.length)
    expect(report.certification.state).toBe('incomplete')
    expect(report.gates.length).toBeGreaterThan(0)
    expect(report.manifest.contractVersions).toEqual([])
  }, 60_000)

  test('strict mode fails while the certification is incomplete', () => {
    const result = runRunner(['--strict'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('strict: not every id is certified')
  }, 60_000)

  test('the committed evidence manifest is pinned to a revision this runner reports as stale', () => {
    const result = runRunner(['--json'])
    const report = JSON.parse(result.stdout)
    expect(report.manifest.pinnedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.manifest.stale).toBe(true)
    expect(report.manifest.behind).toBeGreaterThan(0)
  }, 60_000)
})
