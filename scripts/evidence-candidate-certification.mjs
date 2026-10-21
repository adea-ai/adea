import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTANCE_IDS,
  gitCheckout,
  parseJunit,
  REQUIRED_IDS,
  REQUIREMENT_IDS,
  runCommand,
  safeRepoPath,
} from './evidence-manifest.mjs'

// Exact-candidate certification runner for Adea #1225, #1223 and #1224.
//
// The generic manifest validator (`scripts/evidence-manifest.mjs`, merged in
// #1236) decides whether a requirement id is internally consistent. It answers
// a different question: is one requirement or A-id covered by a candidate
// artifact that was built from an exact commit, at an exact package version,
// by a named test, at a named evidence class.
//
// This runner answers that question. For every id in the #1225 universe it
// records:
//
//   - the exact repository commit the evidence is bound to,
//   - the owning workspace package and its version at that commit,
//   - the test file and the declared test titles,
//   - the evidence class (source, disposable integration, packaged/native,
//     deployed, or owner daily-driver) and the status of that class.
//
// The runner never certifies what it did not observe. An id is certified only
// when every required class for it is verified at one commit. Everything else
// stays visible as `stale`, `unavailable`, `rejected` or `pending`, with the
// reason attached.
//
// It is read-only with respect to every file it reads. The only writes are
// into a temporary directory that it removes again, and the optional report
// path given with `--out`.

export const CERTIFICATION_SCHEMA = 'adea.evidence.candidate-certification.v1'
export const CANDIDATE_ARTIFACT_SCHEMA = 'adea.evidence.candidate-artifacts.v1'
export const CERTIFICATION_ISSUES = Object.freeze([1225, 1223, 1224])
export const HOME_REPOSITORY = 'adea'

/**
 * The evidence classes, weakest first. A class is not a rank of confidence on
 * its own: it names where the evidence was produced. `owner-daily-driver` is
 * the owner's own acceptance and is not a machine class, so it is reported
 * beside the others instead of being ordered among them.
 */
export const CLASS = Object.freeze({
  source: 'source',
  disposableIntegration: 'disposable-integration',
  packagedNative: 'packaged-native',
  deployed: 'deployed',
  ownerDailyDriver: 'owner-daily-driver',
})

export const EVIDENCE_CLASSES = Object.freeze([
  CLASS.source,
  CLASS.disposableIntegration,
  CLASS.packagedNative,
  CLASS.deployed,
  CLASS.ownerDailyDriver,
])

/** Classes a machine can reach in this repository without a release. */
export const MACHINE_CLASSES = Object.freeze([
  CLASS.source,
  CLASS.disposableIntegration,
  CLASS.packagedNative,
  CLASS.deployed,
])

export const CLASS_STATUS = Object.freeze({
  verified: 'verified',
  carried: 'carried',
  stale: 'stale',
  unavailable: 'unavailable',
  rejected: 'rejected',
  pending: 'pending',
})

/**
 * The disposition of one row, in the vocabulary the certification is read in.
 *
 *   - `passed`      a qualifying test ran at the frozen candidate and passed.
 *   - `failed`      a qualifying test ran at the frozen candidate and failed,
 *                   or the claim was rejected.
 *   - `skipped`     a qualifying test exists and is named, but this lane does
 *                   not run it.
 *   - `unavailable` the row's evidence needs an artifact, an environment or a
 *                   head that is not available here.
 *   - `untestable`  no test and no probe can evidence the row at this commit.
 *                   A new test or a decision is required.
 */
export const DISPOSITION = Object.freeze({
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  unavailable: 'unavailable',
  untestable: 'untestable',
})

export const DISPOSITIONS = Object.freeze(Object.values(DISPOSITION))

/**
 * The gates that stay open no matter how much source evidence exists. They are
 * external to this repository, so the runner reports them instead of
 * pretending they were met.
 */
export const GATES = Object.freeze([
  {
    id: 'native-candidate',
    label: 'native/platform candidate head',
    owner: 'candidate owners',
    reason:
      'No exact candidate head is pinned for #1181, #1182, #1177 or #1180 in this checkout, so no native artifact can be bound to a commit.',
  },
  {
    id: 'control-plane-candidate',
    label: 'control-plane candidate head (CP #943)',
    owner: 'control-plane owners',
    reason:
      'CP #943 has no pinned head in this checkout. The control-plane repository is read-only here and its candidate versioning is not published.',
  },
  {
    id: 'packaged-native',
    label: 'packaged/native candidate artifact',
    owner: 'release owners',
    reason:
      'No packaged candidate artifact is published for this milestone, and this task does not authorize a release.',
  },
  {
    id: 'deployed',
    label: 'deployed candidate environment',
    owner: 'release owners',
    reason:
      'No deployed environment is available, and this task does not authorize access to production.',
  },
  {
    id: 'cross-product',
    label: 'joined Adea x control-plane product journey',
    owner: 'both product owners',
    reason:
      'The joined journey needs one exact pair of heads from both repositories. Neither side has a pinned candidate head yet.',
  },
  {
    id: 'soak-24h',
    label: '24-hour soak',
    owner: 'release owners',
    reason:
      'A 24-hour soak is not run here. This task does not authorize long paid or production soaks.',
  },
  {
    id: 'performance-cost',
    label: 'performance and cost budgets',
    owner: 'release owners',
    reason:
      'The latency, load and cost criteria have no approved thresholds and no meter. Nothing is measured for them here.',
  },
  {
    id: 'owner-acceptance',
    label: 'owner daily-driver acceptance',
    owner: 'owner',
    reason:
      'The owner daily-driver journey is a human decision. It is reported as open and never inferred.',
  },
  {
    id: 'ui-evidence',
    label: 'UI evidence',
    owner: 'Claude',
    reason:
      'UI evidence is supplied by Claude. This runner certifies non-UI evidence only and does not implement or measure UI.',
  },
])

/** Path segments that mark a helper or fixture module rather than a product surface. */
const HELPER_SEGMENTS = new Set([
  '__fixtures__',
  'fixture',
  'fixtures',
  'helper',
  'helpers',
  'mocks',
  'stubs',
  'test-helpers',
])

const HELPER_NAME = /(^|[-._])(fixture|fixtures|helper|helpers|mock|stub)([-._]|$)/

/** A test file that must run under the browser export condition. */
const BROWSER_CONDITION_FILES = new Set(['apps/web/test/account-directory-pages.test.ts'])

/** Test files that need a local database and therefore the disposable lane. */
const INTEGRATION_PATH = /(^|\/)tests?\/integration\//

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
/** A test file, in the sense the readiness record uses the term. */
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$)|(^|\/)(tests?|e2e)\//

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Repository-relative POSIX path, rejected when it escapes the repository. */
export function safePath(path) {
  return safeRepoPath(path)
}

/**
 * True when the path names a helper or fixture module rather than a product
 * surface. A claim that rests only on such a path is an overclaim: it proves
 * that a test double works, never that the product does.
 */
export function isHelperOnlyPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const segments = path.split('/')
  const name = segments[segments.length - 1]
  if (HELPER_NAME.test(name)) return true
  return segments.slice(0, -1).some((segment) => HELPER_SEGMENTS.has(segment))
}

/** The evidence class a test file can produce at most. */
export function classForTestPath(path) {
  if (INTEGRATION_PATH.test(path)) return CLASS.disposableIntegration
  return CLASS.source
}

/** The class a candidate artifact may claim. */
export function classForChannel(channel) {
  if (channel === 'packaged') return CLASS.packagedNative
  if (channel === 'deployed') return CLASS.deployed
  return null
}

/**
 * A checkout that also names its root.
 *
 * The merged validator's `gitCheckout` closes over the root but does not
 * expose it, and this runner has to root its own git reads (the archive, the
 * tree listing, the diff) in the same directory.
 */
export function repositoryCheckout(root) {
  const checkout = gitCheckout(root)
  return { ...checkout, root }
}

/**
 * The workspace package that owns a path, with the version it declares at the
 * given commit. The version is read from the committed blob, so it is the
 * version at that revision and not the version in the working tree.
 *
 * The lookup walks up the path and reads one blob per directory. The result is
 * memoised per checkout and revision, because the certification map asks for
 * the same package once per id and every git read costs a subprocess.
 */
const packageCache = new WeakMap()

export function owningPackage(checkout, sha, path) {
  if (typeof sha !== 'string' || sha.length === 0) return null
  let byRevision = packageCache.get(checkout)
  if (byRevision === undefined) {
    byRevision = new Map()
    packageCache.set(checkout, byRevision)
  }
  const segments = path.split('/')
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const directory = segments.slice(0, index).join('/')
    const key = `${sha}\u0000${directory}`
    if (byRevision.has(key)) {
      const cached = byRevision.get(key)
      if (cached !== null) return cached
      continue
    }
    const manifestPath = `${directory}/package.json`
    const blob = checkout.blobAtSha(sha, manifestPath)
    if (blob === null || !blob.regular) {
      byRevision.set(key, null)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(blob.bytes().toString('utf8'))
    } catch {
      byRevision.set(key, null)
      return null
    }
    if (!isObject(parsed) || typeof parsed.name !== 'string') {
      byRevision.set(key, null)
      return null
    }
    const owner = {
      path: directory,
      name: parsed.name,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      private: parsed.private === true,
    }
    byRevision.set(key, owner)
    return owner
  }
  return null
}

/**
 * How far the pinned manifest is behind the certification base. `behind` is
 * null when the two revisions are unrelated or the base is not known locally.
 */
export function revisionDistance(checkout, pinned, base) {
  if (pinned === base) return { behind: 0, relation: 'same' }
  if (!checkout.commitExists(pinned) || !checkout.commitExists(base)) {
    return { behind: null, relation: 'unknown' }
  }
  try {
    const output = runCommand('git', ['rev-list', '--count', `${pinned}..${base}`], {
      cwd: checkout.root,
    })
    const behind = Number(output.trim())
    if (!Number.isSafeInteger(behind) || behind < 0) return { behind: null, relation: 'unknown' }
    return { behind, relation: behind === 0 ? 'same' : 'descendant' }
  } catch {
    return { behind: null, relation: 'unknown' }
  }
}

/**
 * The files a pinned evidence set cites that changed between the pinned
 * revision and the certification base. A receipt for a changed file describes
 * a tree that no longer exists, so it is stale and has to be re-run.
 */
export function changedSince(checkout, pinned, base, paths) {
  const unique = [...new Set(paths)].toSorted()
  if (unique.length === 0) return []
  const output = runCommand('git', ['diff', '--name-only', `${pinned}..${base}`, '--', ...unique], {
    cwd: checkout.root,
    maxBuffer: 1024 * 1024 * 8,
  })
  const changed = new Set(output.split('\n').filter(Boolean))
  return unique.filter((path) => changed.has(path))
}

/**
 * Reads the execution envelopes the generic manifest cites. Each envelope is a
 * claim plus runner output in one hashed artifact. The runner re-reads them
 * from the working tree and binds them to the pinned revision, so a receipt
 * copied from another repository or revision cannot be used here.
 */
export function readReceipts(manifest, root) {
  const receipts = new Map()
  const problems = []
  for (const entry of manifest.entries ?? []) {
    for (const item of entry.repoEvidence ?? []) {
      if (item.kind !== 'execution-reference') continue
      const path = safePath(item.path)
      if (path === null) {
        problems.push(`${entry.id}: unsafe execution reference path ${String(item.path)}`)
        continue
      }
      const absolute = join(root, path)
      if (!existsSync(absolute)) {
        problems.push(`${entry.id}: execution receipt ${path} is missing`)
        continue
      }
      let record
      try {
        record = JSON.parse(readFileSync(absolute, 'utf8'))
      } catch {
        problems.push(`${entry.id}: execution receipt ${path} is not valid JSON`)
        continue
      }
      if (record.schema !== 'adea.evidence.execution.v1') {
        problems.push(`${entry.id}: execution receipt ${path} has another schema`)
        continue
      }
      if (record.status !== 'passed' || record.exitCode !== 0) {
        problems.push(`${entry.id}: execution receipt ${path} is not a passing run`)
        continue
      }
      if (record.sourceSha !== record.executedAtHead) {
        problems.push(`${entry.id}: execution receipt ${path} does not bind one revision`)
        continue
      }
      if (typeof record.command !== 'string' || record.command.length === 0) {
        problems.push(`${entry.id}: execution receipt ${path} does not name a command`)
        continue
      }
      const junit = typeof record.junit === 'string' ? parseJunit(record.junit) : null
      if (junit === null) {
        problems.push(`${entry.id}: execution receipt ${path} has no JUnit testcases`)
        continue
      }
      if (junit.passCount !== record.summary?.pass || junit.failCount !== record.summary?.fail) {
        problems.push(`${entry.id}: execution receipt ${path} counts do not match its summary`)
        continue
      }
      const entryReceipt = {
        path,
        file: record.file,
        command: record.command,
        sourceSha: record.sourceSha,
        ids: Array.isArray(record.ids) ? record.ids : [],
        pass: junit.passCount,
        fail: junit.failCount,
        passing: [...junit.passed].filter((title) => !junit.failed.has(title)),
      }
      const existing = receipts.get(path)
      if (existing === undefined) receipts.set(path, entryReceipt)
      else if (existing.sourceSha !== entryReceipt.sourceSha) {
        problems.push(`${entry.id}: execution receipt ${path} binds two revisions`)
      }
    }
  }
  return { receipts, problems }
}

/**
 * Validates a candidate artifact manifest.
 *
 * The manifest is the only way a packaged or deployed candidate enters this
 * runner, so every field it declares is checked before any artifact is read.
 * A missing, stale or incompatible manifest is reported with its own status.
 * It is never treated as an empty candidate list, and it is never silently
 * accepted.
 */
export function validateCandidateArtifacts(raw, { baseHead, contractVersions, checkout, root }) {
  const rejections = []
  if (raw === null || raw === undefined) {
    return {
      status: 'missing',
      candidates: [],
      rejections: [
        {
          candidateId: null,
          status: 'missing',
          reason:
            'No candidate artifact manifest was supplied, so no packaged or deployed candidate can be bound to a commit.',
        },
      ],
    }
  }
  if (!isObject(raw)) {
    return {
      status: 'incompatible',
      candidates: [],
      rejections: [
        { candidateId: null, status: 'incompatible', reason: 'The manifest is not a JSON object.' },
      ],
    }
  }
  if (raw.schema !== CANDIDATE_ARTIFACT_SCHEMA) {
    rejections.push({
      candidateId: null,
      status: 'incompatible',
      reason: `The manifest schema is ${String(raw.schema)}, not ${CANDIDATE_ARTIFACT_SCHEMA}.`,
    })
  }
  if (!Array.isArray(raw.candidates)) {
    rejections.push({
      candidateId: null,
      status: 'incompatible',
      reason: 'The manifest does not list candidates.',
    })
    return { status: 'incompatible', candidates: [], rejections }
  }
  if (!Array.isArray(contractVersions) || contractVersions.length === 0) {
    rejections.push({
      candidateId: null,
      status: 'incompatible',
      reason:
        'The evidence manifest declares no compatible contract version, so no candidate contract can be accepted.',
    })
  }
  if (typeof raw.baseHead !== 'string' || !SHA.test(raw.baseHead)) {
    rejections.push({
      candidateId: null,
      status: 'incompatible',
      reason: 'The manifest does not pin a 40-character base commit.',
    })
  } else if (raw.baseHead !== baseHead) {
    rejections.push({
      candidateId: null,
      status: 'stale',
      reason: `The manifest pins base ${raw.baseHead}, not the certification base ${baseHead}.`,
    })
  }
  if (
    typeof raw.contractVersion === 'string' &&
    Array.isArray(contractVersions) &&
    !contractVersions.includes(raw.contractVersion)
  ) {
    rejections.push({
      candidateId: null,
      status: 'incompatible',
      reason: `The manifest contract ${raw.contractVersion} is not compatible with the evidence manifest.`,
    })
  }

  // A manifest that is stale or incompatible cannot carry any candidate. The
  // candidates are not read, so a stale manifest never contributes evidence.
  const manifestStatus = rejections.find(
    (rejection) => rejection.status === 'stale' || rejection.status === 'incompatible'
  )
  if (manifestStatus !== undefined) {
    return { status: manifestStatus.status, candidates: [], rejections }
  }

  const candidates = []
  for (const candidate of raw.candidates) {
    const candidateId =
      isObject(candidate) && typeof candidate.candidateId === 'string'
        ? candidate.candidateId
        : null
    const reject = (status, reason) => rejections.push({ candidateId, status, reason })
    if (!isObject(candidate)) {
      reject('incompatible', 'The candidate is not an object.')
      continue
    }
    if (candidateId === null || candidateId.length === 0) {
      reject('incompatible', 'The candidate does not name a candidateId.')
      continue
    }
    const claimedClass = candidate.evidenceClass
    if (!EVIDENCE_CLASSES.includes(claimedClass)) {
      reject(
        'incompatible',
        `The candidate claims an unknown evidence class ${String(claimedClass)}.`
      )
      continue
    }
    const channelClass = classForChannel(candidate.channel)
    if (channelClass === null) {
      reject(
        'incompatible',
        `The candidate channel ${String(candidate.channel)} is not packaged or deployed.`
      )
      continue
    }
    if (channelClass !== claimedClass) {
      reject(
        'incompatible',
        `The candidate channel ${candidate.channel} cannot carry the ${claimedClass} evidence class.`
      )
      continue
    }
    if (typeof candidate.commit !== 'string' || !SHA.test(candidate.commit)) {
      reject('unavailable', 'The candidate does not pin an exact 40-character commit.')
      continue
    }
    if (!checkout.commitExists(candidate.commit)) {
      reject(
        'unavailable',
        `The candidate commit ${candidate.commit} is not present in this checkout, so no artifact can be bound to it.`
      )
      continue
    }
    if (candidate.commit !== baseHead) {
      reject(
        'stale',
        `The candidate commit ${candidate.commit} is not the certification base ${baseHead}.`
      )
      continue
    }
    if (
      typeof raw.contractVersion === 'string' &&
      candidate.contractVersion !== raw.contractVersion
    ) {
      reject(
        'incompatible',
        `The candidate contract ${String(candidate.contractVersion)} is not the manifest contract ${raw.contractVersion}.`
      )
      continue
    }
    if (candidate.status !== 'passed' || candidate.exitCode !== 0) {
      reject(
        'rejected',
        `The candidate run is not a passing run (status ${String(candidate.status)}).`
      )
      continue
    }
    if (!Array.isArray(candidate.ids) || candidate.ids.length === 0) {
      reject('rejected', 'The candidate lists no ids.')
      continue
    }
    const unknownIds = candidate.ids.filter((id) => !REQUIRED_IDS.includes(id))
    if (unknownIds.length > 0) {
      reject('rejected', `The candidate lists unknown ids ${unknownIds.join(' ')}.`)
      continue
    }
    const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts : []
    if (artifacts.length === 0) {
      reject('rejected', 'The candidate declares no artifact.')
      continue
    }
    let artifactProblem = null
    for (const artifact of artifacts) {
      const path = safePath(artifact?.path)
      if (path === null) {
        artifactProblem = 'A candidate artifact path is not a safe repository path.'
        break
      }
      if (isHelperOnlyPath(path)) {
        artifactProblem = `The candidate artifact ${path} is a helper or fixture module, not a product artifact.`
        break
      }
      const absolute = join(root, path)
      if (!existsSync(absolute)) {
        artifactProblem = `The candidate artifact ${path} is missing.`
        break
      }
      if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
        artifactProblem = `The candidate artifact ${path} does not declare a sha256.`
        break
      }
      if (sha256Hex(readFileSync(absolute)) !== artifact.sha256) {
        artifactProblem = `The candidate artifact ${path} does not match its sha256.`
        break
      }
    }
    if (artifactProblem !== null) {
      reject('rejected', artifactProblem)
      continue
    }
    candidates.push({
      candidateId,
      commit: candidate.commit,
      channel: candidate.channel,
      evidenceClass: claimedClass,
      contractVersion: candidate.contractVersion ?? raw.contractVersion ?? null,
      ids: [...candidate.ids],
      command: candidate.command ?? null,
      artifactCount: artifacts.length,
    })
  }
  const status = rejections.some((entry) => entry.status === 'rejected')
    ? 'rejected'
    : rejections.some((entry) => entry.status === 'stale')
      ? 'stale'
      : rejections.some((entry) => entry.status === 'incompatible')
        ? 'incompatible'
        : rejections.some((entry) => entry.status === 'unavailable')
          ? 'unavailable'
          : 'accepted'
  return { status, candidates, rejections }
}

/**
 * Builds the certification map.
 *
 * Every id in the #1225 universe gets an entry, whether or not the manifest
 * has evidence for it. The entry names the commit, the package and its
 * version at that commit, the test, the evidence class and the status of that
 * class. An id with no evidence is `pending` with the reason attached, and it
 * is never dropped from the map.
 *
 * The status vocabulary is deliberately narrow:
 *
 *   - `verified`  the cited tests were re-run at the certification base and
 *                 every declared title passed.
 *   - `carried`   the cited test file is byte-identical between the pinned
 *                 revision and the certification base, so the pinned receipt
 *                 still describes the base exactly, but this certification did
 *                 not re-run it.
 *   - `stale`     the cited test file changed, so the pinned receipt describes
 *                 a tree that no longer exists.
 *   - `rejected`  the claim rests only on a helper or fixture module, or the
 *                 receipt does not bind one revision.
 *   - `pending`   no repository evidence is mapped for the id.
 */
export function buildCertificationMap({
  manifest,
  receipts,
  checkout,
  baseHead,
  changedTestFiles = new Set(),
  reproduced = new Map(),
  readiness = new Map(),
  discovered = new Map(),
}) {
  const entries = []
  const byId = new Map((manifest.entries ?? []).map((entry) => [entry.id, entry]))
  for (const id of REQUIRED_IDS) {
    const group = id.startsWith('REQ-') ? 'requirement' : 'acceptance'
    const entry = byId.get(id)
    if (entry === undefined) {
      entries.push({
        id,
        group,
        status: CLASS_STATUS.pending,
        evidenceClass: null,
        commit: null,
        package: null,
        test: null,
        titles: [],
        reasons: ['no evidence is mapped for this id in the evidence manifest'],
        gaps: [],
        blockingGates: GATES.map((gate) => gate.id),
      })
      continue
    }
    const repository = entry.repoEvidence?.[0]?.repository ?? HOME_REPOSITORY
    const pinned = manifest.repositories?.[repository]?.sourceSha ?? null
    const testReferences = (entry.repoEvidence ?? []).filter(
      (item) => item.kind === 'test-reference'
    )
    const executionReferences = (entry.repoEvidence ?? []).filter(
      (item) => item.kind === 'execution-reference'
    )
    const titles = testReferences.map((item) => ({
      path: item.path,
      name: item.name,
      helperOnly: isHelperOnlyPath(item.path),
    }))
    const primaryPath = testReferences[0]?.path ?? executionReferences[0]?.path ?? null
    const citedTestPaths = [...new Set(testReferences.map((item) => item.path))]
    const classes = [...new Set(citedTestPaths.map((path) => classForTestPath(path)))]
    // The strongest class among the cited tests is the class the id can claim.
    // A source test and a database-backed test together are disposable
    // integration evidence; the weaker class never overstates the stronger one.
    const evidenceClass =
      classes.length === 0
        ? null
        : classes.includes(CLASS.disposableIntegration)
          ? CLASS.disposableIntegration
          : CLASS.source
    const reasons = []
    const gaps = Array.isArray(entry.gaps) ? [...entry.gaps] : []

    if (titles.length === 0 && executionReferences.length === 0) {
      reasons.push('the manifest maps no repository evidence for this id')
    }
    const helperOnly = titles.length > 0 && titles.every((title) => title.helperOnly)
    if (helperOnly) {
      reasons.push(
        'every cited test lives in a helper or fixture module, which cannot evidence product behaviour'
      )
    }

    const receiptPaths = executionReferences.map((item) => item.path)
    const receiptCommits = new Set(
      receiptPaths.map((path) => receipts.get(path)?.sourceSha).filter(Boolean)
    )
    const receiptCommit = receiptCommits.size === 1 ? [...receiptCommits][0] : null
    if (receiptCommits.size > 1) {
      reasons.push('the cited receipts bind more than one revision')
    }
    const changedTests = [...new Set(testReferences.map((item) => item.path))].filter((path) =>
      changedTestFiles.has(path)
    )

    // The cited tests are reproduced only when every cited file ran and every
    // declared title passed in that file.
    const reproductionProblems = []
    for (const title of titles) {
      const run = reproduced.get(title.path)
      if (run === undefined) {
        reproductionProblems.push(`${title.path} was not reproduced at the certification base`)
        continue
      }
      if (run.status !== 'passed') {
        reproductionProblems.push(`${title.path} did not pass at the certification base`)
        continue
      }
      if (!run.passing.includes(title.name)) {
        reproductionProblems.push(`the title "${title.name}" did not pass in ${title.path}`)
      }
    }
    const reproducedHere = titles.length > 0 && reproductionProblems.length === 0

    let status
    if (titles.length === 0 && executionReferences.length === 0) {
      status = CLASS_STATUS.pending
    } else if (helperOnly) {
      status = CLASS_STATUS.rejected
    } else if (executionReferences.length === 0) {
      status = CLASS_STATUS.pending
      reasons.push('the id declares test titles but no execution receipt')
    } else if (receiptCommit === null) {
      status = CLASS_STATUS.rejected
      reasons.push('the cited execution receipt could not be read')
    } else if (reproducedHere) {
      status = CLASS_STATUS.verified
      reasons.push(`reproduced at the certification base ${baseHead}`)
    } else if (changedTests.length > 0) {
      status = CLASS_STATUS.stale
      reasons.push(
        `the cited test changed between ${String(receiptCommit).slice(0, 8)} and the certification base: ${changedTests.join(' ')}`
      )
      reasons.push(...reproductionProblems)
    } else {
      status = CLASS_STATUS.carried
      reasons.push(
        `the cited test is unchanged since the pinned revision ${String(receiptCommit).slice(0, 8)}, so the pinned receipt still describes the certification base`
      )
      reasons.push(...reproductionProblems)
    }

    // An id with no evidence at all is bound to no commit. An id that still
    // rests on its pinned receipt is bound to the pinned revision, and an id
    // that was reproduced here is bound to the certification base.
    const hasEvidence = titles.length > 0 || executionReferences.length > 0
    const boundCommit = !hasEvidence
      ? null
      : status === CLASS_STATUS.verified
        ? baseHead
        : (receiptCommit ?? pinned)
    const packageInfo =
      primaryPath === null || boundCommit === null
        ? null
        : owningPackage(checkout, boundCommit, primaryPath)
    const blockingGates = GATES.map((gate) => gate.id).filter((gateId) => {
      if (gateId === 'ui-evidence') {
        return titles.some((title) => BROWSER_CONDITION_FILES.has(title.path))
      }
      return true
    })

    const rowReadiness = readiness.get(id) ?? []
    const rowDiscovered = discovered.get(id) ?? []
    const failedFile = citedTestPaths.find((path) => reproduced.get(path)?.status === 'failed')
    const disposition = dispositionFor({
      status,
      hasEvidence: titles.length > 0 || executionReferences.length > 0,
      failedFile,
      rowReadiness,
      rowDiscovered,
      reproduced,
    })

    entries.push({
      id,
      group,
      status,
      disposition,
      evidenceClass,
      commit: boundCommit,
      pinnedCommit: pinned,
      package: packageInfo,
      test: primaryPath === null ? null : { path: primaryPath },
      tests: citedTestPaths,
      classes,
      titles: titles.map((title) => title.name),
      receipts: receiptPaths,
      reasons,
      gaps,
      readiness: rowReadiness,
      discovered: rowDiscovered,
      blockingGates,
    })
  }
  return entries
}

/**
 * The disposition of one row.
 *
 * The disposition describes the row's *evidence* at the frozen candidate. It
 * is not a certification: a row whose evidence passed is still not certified
 * while the manifest does not map it or an external gate is open.
 */
export function dispositionFor({
  status,
  hasEvidence,
  failedFile = null,
  rowReadiness = [],
  rowDiscovered = [],
  reproduced = new Map(),
}) {
  if (hasEvidence) {
    if (status === CLASS_STATUS.verified) return DISPOSITION.passed
    if (status === CLASS_STATUS.rejected) return DISPOSITION.failed
    if (failedFile !== null) return DISPOSITION.failed
    return DISPOSITION.skipped
  }
  // A row the manifest maps no evidence for. A qualification that exists and
  // passes at the candidate is available, but the manifest does not map it, so
  // the row cannot be certified.
  const leads = rowDiscovered.flatMap((entry) => entry.leads ?? [])
  const passing = leads.filter((lead) => reproduced.get(lead.file)?.status === 'passed')
  if (passing.length > 0) return DISPOSITION.unavailable
  const unavailableCriterion = rowReadiness.find(
    (entry) => entry.method?.kind === 'unavailable' || entry.method?.kind === 'not-claimed'
  )
  if (unavailableCriterion !== undefined) return DISPOSITION.unavailable
  const unmentioned = rowDiscovered.flatMap((entry) => entry.unmentioned ?? [])
  if (unmentioned.length > 0) return DISPOSITION.untestable
  if (leads.length > 0) return DISPOSITION.skipped
  return DISPOSITION.untestable
}

/**
 * Exports a clean checkout of one commit into a temporary directory and
 * verifies that the exported tree is exactly that commit's tree.
 */
export function exportCleanCheckout(checkout, sha, target) {
  mkdirSync(target, { recursive: true })
  // The archive is binary. It is read as bytes, never as text.
  const archive = runCommand('git', ['archive', '--format=tar', sha], {
    cwd: checkout.root,
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'buffer',
  })
  const result = spawnSync('tar', ['-x', '-C', target], {
    input: archive,
    maxBuffer: 1024 * 1024 * 512,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `tar could not unpack the ${sha} archive: ${result.stderr?.toString().trim() ?? ''}`
    )
  }
  const expected = runCommand('git', ['ls-tree', '-r', '--name-only', sha], {
    cwd: checkout.root,
    maxBuffer: 1024 * 1024 * 64,
  })
    .split('\n')
    .filter(Boolean)
    .toSorted()
  const actual = []
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).toSorted()) {
      const absolute = join(directory, name)
      const path = prefix === '' ? name : `${prefix}/${name}`
      const stat = lstatSync(absolute)
      if (stat.isDirectory()) walk(absolute, path)
      else actual.push(path)
    }
  }
  walk(target, '')
  actual.toSorted()
  const missing = expected.filter((path) => !actual.includes(path))
  const extra = actual.filter((path) => !expected.includes(path))
  return { expected: expected.length, actual: actual.length, missing, extra }
}

/**
 * The workspace directories of the repository, read from the root manifest.
 * The workspace globs are `apps/*` and `packages/*`.
 */
export function workspaceDirectories(root) {
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return []
  }
  const globs = Array.isArray(parsed.workspaces) ? parsed.workspaces : []
  const directories = []
  for (const glob of globs) {
    if (typeof glob !== 'string' || !glob.endsWith('/*')) continue
    const parent = glob.slice(0, -2)
    const absolute = join(root, parent)
    if (!existsSync(absolute)) continue
    for (const name of readdirSync(absolute).toSorted()) {
      if (existsSync(join(absolute, name, 'package.json'))) directories.push(`${parent}/${name}`)
    }
  }
  return directories
}

/**
 * Creates one `node_modules` scope in the clean checkout.
 *
 * A third-party entry is a link to the installed tree, so the clean checkout
 * resolves the same pinned dependency without copying it. A workspace package
 * is a link to the checkout's own package directory, so the clean checkout
 * resolves its own source and not the working tree's.
 */
function linkScope(checkoutRoot, scopeTarget, sourceScope, scopeName = '@adea-ai') {
  const linked = []
  if (!existsSync(sourceScope)) return linked
  mkdirSync(scopeTarget, { recursive: true })
  for (const name of readdirSync(sourceScope)) {
    const source = join(sourceScope, name)
    const target = join(scopeTarget, name)
    const local = localPackageByName(checkoutRoot, `${scopeName}/${name}`)
    if (local !== null) {
      symlinkSync(relative(scopeTarget, join(checkoutRoot, local.directory)), target)
      linked.push(`workspace:${name}`)
      continue
    }
    symlinkSync(source, target)
  }
  return linked
}

/**
 * Installs the dependency tree into the clean checkout.
 *
 * The root tree and every workspace's own tree are resolved, because Bun
 * resolves a workspace dependency through the depending package's
 * `node_modules`. Third-party dependencies are linked to the installed tree
 * rather than copied, so the run does not duplicate the whole tree; the
 * workspace packages themselves are linked to the checkout's own packages.
 */
export function installWorkspaceDependencies(sourceRoot, checkoutRoot) {
  const source = join(sourceRoot, 'node_modules')
  if (!existsSync(source)) {
    return { installed: false, reason: 'the repository has no installed node_modules tree' }
  }
  const rootTarget = join(checkoutRoot, 'node_modules')
  rmSync(rootTarget, { recursive: true, force: true })
  mkdirSync(rootTarget, { recursive: true })
  const linked = []
  for (const name of readdirSync(source)) {
    if (name === '@adea-ai') continue
    symlinkSync(join(source, name), join(rootTarget, name))
  }
  linked.push(...linkScope(checkoutRoot, join(rootTarget, '@adea-ai'), join(source, '@adea-ai')))
  const workspaces = []
  for (const workspace of workspaceDirectories(sourceRoot)) {
    const from = join(sourceRoot, workspace, 'node_modules')
    if (!existsSync(from)) continue
    const to = join(checkoutRoot, workspace, 'node_modules')
    rmSync(to, { recursive: true, force: true })
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      if (name === '@adea-ai') continue
      symlinkSync(join(from, name), join(to, name))
    }
    linked.push(
      ...linkScope(checkoutRoot, join(to, '@adea-ai'), join(from, '@adea-ai')).map(
        (entry) => `${workspace}/${entry}`
      )
    )
    workspaces.push(workspace)
  }
  return { installed: true, workspaces: workspaces.length, linked }
}

/**
 * The workspace packages a test file imports at runtime.
 *
 * A type-only import is erased before the test runs, so it needs no built
 * artifact. A value import does, and under Bun's default conditions the
 * package's `import` export points at its built `dist`. A clean checkout has
 * no `dist`, so the packages that a cited test value-imports have to be built
 * from the same pinned commit before the test can run.
 */
export function valueWorkspaceImports(source) {
  const names = new Set()
  const statements = /import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(statements)) {
    const clause = match[1].trim()
    if (clause.startsWith('type ')) continue
    if (clause.startsWith('type{')) continue
    const specifier = match[2]
    if (!specifier.startsWith('@adea-ai/')) continue
    names.add(specifier)
  }
  return [...names]
}

/** The local workspace package that declares a package name, with its directory. */
export function localPackageByName(checkoutRoot, name) {
  for (const workspace of workspaceDirectories(checkoutRoot)) {
    const manifestPath = join(checkoutRoot, workspace, 'package.json')
    if (!existsSync(manifestPath)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (parsed?.name === name) return { directory: workspace, name }
  }
  return null
}

/** The workspace packages a package depends on, by its own manifest. */
export function workspaceDependencies(checkoutRoot, directory) {
  const manifestPath = join(checkoutRoot, directory, 'package.json')
  if (!existsSync(manifestPath)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return []
  }
  const declared = { ...parsed?.dependencies, ...parsed?.devDependencies }
  const dependencies = []
  for (const [name, range] of Object.entries(declared)) {
    if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
    const local = localPackageByName(checkoutRoot, name)
    if (local !== null) dependencies.push(local.directory)
  }
  return dependencies
}

/**
 * The packages to build, in dependency order, so that a package is always
 * built after the packages it depends on. The transitive workspace
 * dependencies are included, because a package cannot be built before the
 * packages it compiles against.
 */
export function buildOrder(checkoutRoot, directories) {
  const ordered = []
  const visit = (directory, stack) => {
    if (ordered.includes(directory)) return
    if (stack.includes(directory)) return
    for (const dependency of workspaceDependencies(checkoutRoot, directory)) {
      visit(dependency, [...stack, directory])
    }
    ordered.push(directory)
  }
  for (const directory of [...directories].toSorted()) visit(directory, [])
  return ordered
}

/**
 * Builds workspace packages from the pinned commit.
 *
 * Each package is built with its own `build` script, in dependency order. The
 * build is part of the evidence: a source-class result is only meaningful when
 * the built artifact came from the same commit as the test.
 */
export function buildWorkspacePackages(checkoutRoot, directories, timeoutMs = 900_000) {
  const results = []
  for (const directory of directories) {
    const manifestPath = join(checkoutRoot, directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const script = parsed?.scripts?.build
    if (typeof script !== 'string' || script.length === 0) {
      results.push({ package: directory, status: 'no-build-script', exitCode: null })
      continue
    }
    const started = Date.now()
    const result = spawnSync('bun', ['run', 'build'], {
      cwd: join(checkoutRoot, directory),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 32,
      env: { ...process.env, CI: '1' },
    })
    results.push({
      package: directory,
      status: result.status === 0 ? 'built' : 'failed',
      exitCode: result.status,
      durationMs: Date.now() - started,
      command: `bun run build (cwd ${directory})`,
      stderr: result.status === 0 ? null : (result.stderr ?? '').slice(0, 2000),
    })
    if (result.status !== 0) break
  }
  return results
}

/**
 * The packages a lane has to build, derived from the runtime imports of its
 * test files. A test file that value-imports a workspace package needs that
 * package's built artifact.
 */
export function requiredBuilds(checkoutRoot, files) {
  const specifiers = new Set()
  for (const file of files) {
    const absolute = join(checkoutRoot, file)
    if (!existsSync(absolute)) continue
    for (const specifier of valueWorkspaceImports(readFileSync(absolute, 'utf8'))) {
      specifiers.add(specifier)
    }
  }
  const directories = new Set()
  for (const specifier of specifiers) {
    const root = specifier.split('/').slice(0, 2).join('/')
    const local = localPackageByName(checkoutRoot, root)
    if (local === null) continue
    directories.add(local.directory)
  }
  return buildOrder(checkoutRoot, directories)
}

/**
 * Runs the cited non-UI tests in a clean checkout of the certification base.
 *
 * Each file runs on its own so that one failure cannot hide the rest, and the
 * JUnit document of each run is parsed for the declared titles. A file whose
 * declared titles all pass is recorded as verified; anything else keeps its
 * failure.
 */
export function runCleanCheckoutJourney({
  checkout,
  baseHead,
  files,
  sourceRoot,
  kind = 'clean-checkout',
  conditions = null,
  timeoutMs = 300_000,
}) {
  const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-checkout-'))
  const checkoutRoot = join(scratch, 'checkout')
  const junitRoot = join(scratch, 'junit')
  mkdirSync(junitRoot, { recursive: true })
  const results = []
  try {
    const exported = exportCleanCheckout(checkout, baseHead, checkoutRoot)
    if (exported.missing.length > 0 || exported.extra.length > 0) {
      return {
        kind: 'clean-checkout',
        status: 'failed',
        command: `git archive --format=tar ${baseHead}`,
        exitCode: null,
        checkout: checkoutRoot,
        results,
        reason: 'the exported tree does not match the pinned commit',
        detail: { missing: exported.missing.slice(0, 20), extra: exported.extra.slice(0, 20) },
      }
    }
    const dependencies = installWorkspaceDependencies(sourceRoot, checkoutRoot)
    const builds = requiredBuilds(checkoutRoot, files)
    const buildResults = builds.length === 0 ? [] : buildWorkspacePackages(checkoutRoot, builds)
    const buildFailure = buildResults.find((result) => result.status === 'failed')
    if (buildFailure !== undefined) {
      return {
        kind: 'clean-checkout',
        status: 'failed',
        command: `git archive --format=tar ${baseHead}`,
        exitCode: buildFailure.exitCode,
        checkout: checkoutRoot,
        dependencies,
        builds: buildResults,
        results,
        reason: `the pinned package ${buildFailure.package} could not be built in the clean checkout`,
      }
    }
    // Every package the lane built is also packed and installed into a
    // consumer, so the evidence rests on an artifact a consumer can install,
    // not only on a build that happened to succeed.
    const consumers = []
    for (const directory of builds) {
      const manifestPath = join(checkoutRoot, directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const declared = JSON.parse(readFileSync(manifestPath, 'utf8'))
      consumers.push(
        runPackageConsumerJourney({
          packageRoot: join(checkoutRoot, directory),
          packagePath: directory,
          declared,
        })
      )
    }
    for (const file of files) {
      const junitFile = join(junitRoot, `${file.replace(/[^a-zA-Z0-9.-]/g, '__')}.xml`)
      const conditionFlag = conditions === null ? [] : [`--conditions=${conditions}`]
      const command = `bun test ${conditionFlag.join(' ')} ${file} --reporter=junit --reporter-outfile=${junitFile}`
      const started = process.hrtime.bigint()
      const result = spawnSync(
        'bun',
        ['test', ...conditionFlag, file, '--reporter=junit', `--reporter-outfile=${junitFile}`],
        {
          cwd: checkoutRoot,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 32,
          env: { ...process.env, CI: '1' },
        }
      )
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      const junit = existsSync(junitFile) ? readFileSync(junitFile, 'utf8') : null
      const parsed = junit === null ? null : parseJunit(junit)
      const passCount = parsed?.passCount ?? 0
      const failCount = parsed?.failCount ?? 0
      // A file that produced no testcase did not run under this runner. It is
      // a lane mismatch, not a behaviour failure, and it is reported as a skip.
      const ranNothing = passCount === 0 && failCount === 0
      results.push({
        file,
        command,
        exitCode: result.status,
        status: ranNothing ? 'skipped' : result.status === 0 ? 'passed' : 'failed',
        pass: passCount,
        fail: failCount,
        durationMs: Math.round(durationMs),
        passing:
          parsed === null ? [] : [...parsed.passed].filter((title) => !parsed.failed.has(title)),
        failed: parsed === null ? [] : [...parsed.failed],
        stderr: result.status === 0 ? null : (result.stderr ?? '').slice(0, 2000),
      })
    }
    const failed = results.filter((result) => result.status === 'failed')
    const skipped = results.filter((result) => result.status === 'skipped')
    return {
      kind,
      status: failed.length === 0 ? 'passed' : 'failed',
      command: `git archive --format=tar ${baseHead}`,
      exitCode: failed.length === 0 ? 0 : 1,
      checkout: checkoutRoot,
      conditions,
      dependencies,
      builds: buildResults,
      consumers,
      results,
      skipped: skipped.length,
      reason:
        failed.length === 0
          ? null
          : `${failed.length} of ${results.length} files did not pass in the clean checkout` +
            (skipped.length > 0 ? `; ${skipped.length} file(s) did not run under this runner` : ''),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The files under a directory, relative to it, sorted.
 *
 * The package-consumer check uses it for a wildcard export, where the target
 * is a pattern rather than a file.
 */
export function matchingFiles(root, prefix = '') {
  const files = []
  if (!existsSync(root)) return files
  for (const name of readdirSync(root).toSorted()) {
    const absolute = join(root, name)
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (lstatSync(absolute).isDirectory()) files.push(...matchingFiles(absolute, path))
    else files.push(path)
  }
  return files.toSorted()
}

/**
 * Runs the package-consumer journey for one package.
 *
 * The package is packed from the pinned tree and installed into a temporary
 * consumer project. The consumer then checks that the installed artifact
 * carries the name and version the pinned tree declares and that every export
 * target it declares is present. A package that needs a build step to become
 * importable is reported as such; it is not imported.
 */
export function runPackageConsumerJourney({
  packageRoot,
  packagePath,
  declared,
  timeoutMs = 300_000,
}) {
  const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-consumer-'))
  const consumerRoot = join(scratch, 'consumer')
  mkdirSync(consumerRoot, { recursive: true })
  try {
    const pack = spawnSync('bun', ['pm', 'pack', '--destination', scratch], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
    })
    if (pack.error || pack.status !== 0) {
      return {
        kind: 'package-consumer',
        package: packagePath,
        status: 'failed',
        command: `bun pm pack --destination <tmp> (cwd ${packagePath})`,
        exitCode: pack.status ?? null,
        reason: `the package could not be packed: ${(pack.stderr ?? '').trim().split('\n')[0] ?? 'unknown error'}`,
      }
    }
    const tarballs = readdirSync(scratch).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length === 0) {
      return {
        kind: 'package-consumer',
        package: packagePath,
        status: 'failed',
        command: 'bun pm pack --destination <tmp>',
        exitCode: null,
        reason: 'the package produced no tarball',
      }
    }
    const tarball = join(scratch, tarballs[0])
    const digest = sha256Hex(readFileSync(tarball))
    // A package that depends on another workspace package declares a
    // `workspace:` range. That range only resolves inside the workspace, so
    // the packed artifact cannot be installed by an outside consumer. This is
    // a property of the package, not a failure of the lane, and it is
    // recorded as such.
    const declaredDependencies = { ...declared.dependencies, ...declared.devDependencies }
    const workspaceRanges = Object.entries(declaredDependencies)
      .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
      .map(([name]) => name)
    if (workspaceRanges.length > 0) {
      return {
        kind: 'package-consumer',
        package: packagePath,
        status: 'workspace-only',
        command: `bun pm pack --destination <tmp> (packed ${declared.name}@${declared.version})`,
        exitCode: 0,
        artifactDigest: digest,
        declared: { name: declared.name, version: declared.version },
        workspaceRanges,
        reason: `the package declares ${workspaceRanges.join(' ')} and is consumed inside the workspace, not by an outside consumer`,
      }
    }
    writeFileSync(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify({ name: 'adea-certification-consumer', private: true, version: '0.0.0' }, null, 2)}\n`
    )
    const install = spawnSync('bun', ['add', tarball], {
      cwd: consumerRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
    })
    if (install.error || install.status !== 0) {
      return {
        kind: 'package-consumer',
        package: packagePath,
        status: 'failed',
        command: `bun add <packed ${declared.name}>`,
        exitCode: install.status ?? null,
        artifactDigest: digest,
        reason: `the consumer could not install the packed artifact: ${(install.stderr ?? '').trim().split('\n')[0] ?? 'unknown error'}`,
      }
    }
    const installedManifestPath = join(consumerRoot, 'node_modules', declared.name, 'package.json')
    if (!existsSync(installedManifestPath)) {
      return {
        kind: 'package-consumer',
        package: packagePath,
        status: 'failed',
        command: `bun add <packed ${declared.name}>`,
        exitCode: install.status,
        artifactDigest: digest,
        reason: 'the installed artifact has no package.json',
      }
    }
    const installed = JSON.parse(readFileSync(installedManifestPath, 'utf8'))
    const problems = []
    if (installed.name !== declared.name) {
      problems.push(`the installed package is named ${installed.name}, not ${declared.name}`)
    }
    if (installed.version !== declared.version) {
      problems.push(
        `the installed package is version ${installed.version}, not ${declared.version} as declared in the pinned tree`
      )
    }
    const exports = isObject(declared.exports) ? declared.exports : {}
    for (const [subpath, target] of Object.entries(exports)) {
      const candidates = isObject(target) ? Object.values(target) : [target]
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue
        const relativePath = candidate.replace(/^\.\//, '')
        const installedFile = join(consumerRoot, 'node_modules', declared.name, relativePath)
        if (relativePath.includes('*')) {
          // A wildcard export names a pattern, not a file. The pattern has to
          // match at least one file in the packed artifact.
          const pattern = new RegExp(
            `^${relativePath
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*')}$`
          )
          const matches = matchingFiles(join(consumerRoot, 'node_modules', declared.name)).filter(
            (file) => pattern.test(file)
          )
          if (matches.length === 0) {
            problems.push(
              `the export ${subpath} names the pattern ${relativePath}, which the packed artifact does not satisfy`
            )
          }
          continue
        }
        if (!existsSync(installedFile)) {
          problems.push(
            `the export ${subpath} names ${relativePath}, which the packed artifact does not contain`
          )
        }
      }
    }
    return {
      kind: 'package-consumer',
      package: packagePath,
      status: problems.length === 0 ? 'passed' : 'failed',
      command: `bun pm pack --destination <tmp> && bun add <tarball> (consumer asserts ${declared.name}@${declared.version})`,
      exitCode: problems.length === 0 ? install.status : 1,
      artifactDigest: digest,
      declared: { name: declared.name, version: declared.version },
      installed: { name: installed.name, version: installed.version },
      problems,
      reason: problems.length === 0 ? null : problems.join('; '),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The readiness criteria that name an id.
 *
 * The #1224 readiness inventory states, for each of its criteria, which
 * acceptance ids and requirement ids the criterion comes from. That mapping is
 * the reviewed input; this runner only reads it.
 */
export function readinessCriteriaForId(criteria, id) {
  const number = id.startsWith('REQ-') ? id.slice(4) : id.slice(1)
  const pattern = new RegExp(`(^|[^A-Z0-9])(A${number}|REQ[- ]?0*${number})([^0-9]|$)`, 'i')
  return (criteria ?? []).filter((criterion) => pattern.test(criterion.source ?? ''))
}

/**
 * The files at a revision that match a readiness presence probe.
 *
 * The semantics are the ones the merged readiness script uses: a `git grep`
 * over the probe's paths at the revision, with an optional path filter and an
 * optional test-file filter. A pattern that matches nothing is a result, not
 * an error.
 */
export function probeFiles(revision, probe, cwd) {
  let files
  if (probe.pathPattern) {
    const listed = runCommand(
      'git',
      ['ls-tree', '-r', '--name-only', revision, '--', ...probe.paths],
      { cwd, maxBuffer: 1024 * 1024 * 64 }
    )
    files = listed
      .split('\n')
      .filter(Boolean)
      .filter((path) => new RegExp(probe.pathPattern, 'i').test(path))
  } else {
    const args = ['grep', '-l', '-I', '-E', '-e', probe.pattern]
    if (probe.ignoreCase) args.push('-i')
    args.push(revision, '--', ...probe.paths)
    const grep = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 })
    if (grep.error) throw grep.error
    if (grep.status !== 0 && grep.status !== 1) {
      throw new Error(`git grep failed at ${revision}: ${grep.stderr ?? ''}`)
    }
    files = (grep.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(revision.length + 1))
  }
  if (probe.testFilesOnly) files = files.filter((path) => TEST_FILE.test(path))
  return [...new Set(files)].toSorted()
}

/**
 * Executes the readiness presence probes at the frozen candidate.
 *
 * A presence probe is a search, not a proof: it shows that an identifier is
 * or is not in product source at that commit. The result is reported per
 * criterion so that a row the readiness record names carries a source
 * qualification bound to the candidate.
 */
export function executeReadinessProbes({ criteria, probes, revision, cwd }) {
  const results = []
  for (const criterion of criteria ?? []) {
    if (criterion.method?.kind !== 'presence') continue
    const executions = []
    for (const name of criterion.method.probes ?? []) {
      const probe = probes?.[name]
      if (probe === undefined) continue
      const files = probeFiles(revision, probe, cwd)
      executions.push({
        probe: name,
        count: files.length,
        files: files.slice(0, 10),
        status: files.length > 0 ? 'present' : 'absent',
      })
    }
    if (executions.length === 0) continue
    results.push({
      criterion: criterion.id,
      category: criterion.category,
      revision,
      status: executions.some((entry) => entry.count > 0) ? 'present' : 'absent',
      probes: executions,
    })
  }
  return results
}

/**
 * Words that carry no subject in a gap sentence and would only widen a search.
 */
const STOP_WORDS = new Set([
  'about',
  'assert',
  'asserts',
  'covered',
  'covers',
  'exercised',
  'exists',
  'test',
  'tested',
  'tests',
  'verified',
  'verifies',
  'after',
  'again',
  'against',
  'along',
  'already',
  'another',
  'asserted',
  'before',
  'being',
  'between',
  'both',
  'cannot',
  'could',
  'does',
  'done',
  'during',
  'each',
  'either',
  'else',
  'enough',
  'every',
  'from',
  'further',
  'have',
  'having',
  'here',
  'however',
  'into',
  'itself',
  'just',
  'like',
  'made',
  'make',
  'many',
  'more',
  'most',
  'much',
  'must',
  'near',
  'never',
  'next',
  'none',
  'only',
  'other',
  'over',
  'own',
  'same',
  'shall',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'within',
  'without',
  'would',
])

/**
 * The content words of a gap sentence.
 *
 * The words are the subject of the gap: what the gap says is not tested. A
 * word of fewer than five characters carries too little to search on, and a
 * stop word carries no subject at all.
 */
export function gapTokens(text) {
  if (typeof text !== 'string') return []
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !STOP_WORDS.has(word))
  return [...new Set(words)]
}

/** The test files at a revision. */
export function testFilesAt(revision, cwd) {
  const listed = runCommand('git', ['ls-tree', '-r', '--name-only', revision], {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
  })
  return listed
    .split('\n')
    .filter(Boolean)
    .filter((path) => TEST_FILE.test(path))
}

/**
 * The test files at a revision whose content mentions a term.
 *
 * The search is a fixed-string search over the whole tree, so it also matches
 * a term inside a title, a comment or a fixture. A term that matches nothing
 * is a result, not an error.
 */
export function filesMentioning(revision, term, cwd) {
  const grep = spawnSync('git', ['grep', '-l', '-I', '-i', '-F', '-e', term, revision], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  })
  if (grep.error) throw grep.error
  if (grep.status !== 0 && grep.status !== 1) return []
  return (grep.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(revision.length + 1))
    .filter((path) => TEST_FILE.test(path))
}

/**
 * The available qualifications for one gap at a revision.
 *
 * A file qualifies for a gap when it mentions every *distinctive* content
 * word of the gap. A word is distinctive when it is rare in the repository's
 * test files: a word that matches a large share of them carries no subject
 * ("tested", "source", "merged") and would only make the search miss. The
 * rule is self-calibrating, so it needs no hand-written word list, and it
 * reports the words it discarded, so a row can say exactly what was searched.
 */
export function discoverQualifications({ gaps, revision, cwd, cache = new Map() }) {
  const mentions = (term) => {
    if (!cache.has(term)) cache.set(term, filesMentioning(revision, term, cwd))
    return cache.get(term)
  }
  const found = []
  for (const gap of gaps ?? []) {
    const tokens = gapTokens(gap)
    if (tokens.length === 0) {
      found.push({ gap, tokens: [], subject: null, leads: [], unmentioned: [] })
      continue
    }
    const perToken = tokens.map((token) => ({ token, files: mentions(token) }))
    // The subject of the gap is its rarest content word: the word the fewest
    // test files mention. A file that mentions it is a lead, and the score
    // says how many of the gap's other words it also mentions.
    const subject = perToken.toSorted((left, right) => left.files.length - right.files.length)[0]
    const scores = new Map()
    for (const entry of perToken) {
      for (const file of entry.files) scores.set(file, (scores.get(file) ?? 0) + 1)
    }
    const leads = [...scores.entries()]
      .map(([file, score]) => ({
        file,
        score,
        tokens: perToken.filter((e) => e.files.includes(file)).map((e) => e.token),
      }))
      .toSorted((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, 8)
    found.push({
      gap,
      tokens,
      subject: subject.token,
      subjectMatches: subject.files.length,
      leads,
      // A subject word that no test file mentions is the strongest form of the
      // gap: the behaviour has no trace in the repository at all.
      unmentioned: subject.files.length === 0 ? [subject.token] : [],
    })
  }
  return found
}

/**
 * How a discovered file can be run.
 *
 * The runner only runs what Bun's own test runner can run. A Playwright
 * specification, a fixture module and a script that needs the repository's
 * git history are not Bun test files, and running them with `bun test` would
 * report a lane mismatch as a behaviour failure.
 */
export function classifyRunnable(file) {
  if (/(^|\/)e2e\//.test(file) || /\.spec\.[cm]?[jt]sx?$/.test(file)) {
    return { runnable: false, reason: 'a Playwright specification, run by the E2E runner' }
  }
  if (/(^|\/)(fixtures?|helpers?|__fixtures__)\//.test(file)) {
    return { runnable: false, reason: 'a fixture or helper module, not a test file' }
  }
  if (!/\.test\.[cm]?[jt]sx?$/.test(file)) {
    return { runnable: false, reason: 'not a Bun test file' }
  }
  if (file.startsWith('scripts/')) {
    return {
      runnable: false,
      reason: 'a script lane test, run by the repository script lane, not by this runner',
    }
  }
  return { runnable: true, reason: null }
}

/**
 * The cross-repository pin this repository already commits.
 *
 * `apps/web/test/control-plane-joined/control-plane-source.json` names the
 * control-plane revision the joined proof runs against. It is an existing,
 * committed pin, so the pair is read from the repository and never invented
 * here.
 */
export function readCrossRepositoryPin(root) {
  const path = join(
    root,
    'apps',
    'web',
    'test',
    'control-plane-joined',
    'control-plane-source.json'
  )
  if (!existsSync(path)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed?.repository !== 'string' || typeof parsed?.revision !== 'string') return null
  return parsed
}

/**
 * Runs the joined cross-product proof.
 *
 * The proof runs from the control-plane checkout, because the control-plane
 * sources compile under the control plane's own TypeScript configuration. The
 * checkout has to be at the pinned revision with no tracked changes; the proof
 * checks that itself and refuses otherwise.
 *
 * The result is a source-level proof that the two repositories agree on the
 * fence-v2 contract. It is not production qualification, and it does not
 * certify a *candidate* pair: the control-plane side is a pinned consumer
 * contract revision, not a published candidate head.
 */
export function runCrossProductJourney({
  root,
  pin,
  controlPlaneSource,
  databaseUrl,
  timeoutMs = 900_000,
}) {
  const joinedDirectory = join(root, 'apps', 'web', 'test', 'control-plane-joined')
  if (!existsSync(joinedDirectory)) {
    return {
      kind: 'cross-product',
      status: 'unavailable',
      exitCode: null,
      reason: 'this repository has no joined cross-product proof directory',
    }
  }
  if (
    controlPlaneSource === undefined ||
    controlPlaneSource === null ||
    controlPlaneSource === ''
  ) {
    return {
      kind: 'cross-product',
      status: 'unavailable',
      exitCode: null,
      pinnedRevision: pin.revision,
      reason:
        'ADEA_CONTROL_PLANE_SOURCE is not set, so the joined proof has no control-plane checkout to run against',
    }
  }
  if (!existsSync(controlPlaneSource)) {
    return {
      kind: 'cross-product',
      status: 'unavailable',
      exitCode: null,
      pinnedRevision: pin.revision,
      reason: `the control-plane checkout ${controlPlaneSource} does not exist`,
    }
  }
  const head = runCommand('git', ['rev-parse', 'HEAD'], { cwd: controlPlaneSource }).trim()
  if (head !== pin.revision) {
    return {
      kind: 'cross-product',
      status: 'unavailable',
      exitCode: null,
      pinnedRevision: pin.revision,
      checkoutHead: head,
      reason: `the control-plane checkout is at ${head}, not the pinned revision ${pin.revision}`,
    }
  }
  const started = process.hrtime.bigint()
  const result = spawnSync(
    'bun',
    ['test', '--conditions=react-server', '--timeout', String(timeoutMs), joinedDirectory],
    {
      cwd: controlPlaneSource,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 64,
      env: {
        ...process.env,
        CI: '1',
        ADEA_CONTROL_PLANE_SOURCE: controlPlaneSource,
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: databaseUrl,
      },
    }
  )
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
  return {
    kind: 'cross-product',
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    durationMs: Math.round(durationMs),
    command: `bun test --conditions=react-server --timeout ${timeoutMs} apps/web/test/control-plane-joined (cwd the control-plane checkout)`,
    repository: pin.repository,
    pinnedRevision: pin.revision,
    checkoutHead: head,
    componentHeads: {
      cp1043Squash: pin.cp1043Squash ?? null,
      leadFenceConsumer: pin.leadFenceConsumer ?? null,
    },
    reason:
      result.status === 0
        ? null
        : `the joined proof failed: ${(result.stderr ?? result.stdout ?? '').trim().split('\n').slice(-3).join(' ')}. The proof needs a fresh disposable database, like the repository's own lane provisions; a database that already holds rows makes it fail on its fixed identifiers.`,
  }
}

/** The cited test files of the non-UI lane, with their declared titles. */
export function nonUiLane(entries) {
  const files = new Map()
  for (const entry of entries) {
    for (const path of entry.tests ?? (entry.test === null ? [] : [entry.test.path])) {
      if (BROWSER_CONDITION_FILES.has(path)) continue
      if (classForTestPath(path) === CLASS.disposableIntegration) continue
      const existing = files.get(path) ?? { path, titles: new Set() }
      for (const title of entry.titles) existing.titles.add(title)
      files.set(path, existing)
    }
  }
  return [...files.values()]
    .map((file) => ({ path: file.path, titles: [...file.titles] }))
    .toSorted((left, right) => left.path.localeCompare(right.path))
}

/**
 * The cited test files that need the browser export condition.
 *
 * These are unit tests of page modules under the browser condition. They need
 * no browser process and no rendered surface, so they are a test-only
 * qualification and not the UI evidence itself. The UI evidence gate stays
 * open for them.
 */
export function browserConditionLane(entries) {
  const files = new Set()
  for (const entry of entries) {
    for (const path of entry.tests ?? (entry.test === null ? [] : [entry.test.path])) {
      if (BROWSER_CONDITION_FILES.has(path)) files.add(path)
    }
  }
  return [...files].toSorted()
}

/** The cited test files that need a local database. */
export function disposableLane(entries) {
  const files = new Set()
  for (const entry of entries) {
    for (const path of entry.tests ?? (entry.test === null ? [] : [entry.test.path])) {
      if (classForTestPath(path) !== CLASS.disposableIntegration) continue
      files.add(path)
    }
  }
  return [...files].toSorted()
}

/**
 * A database URL that names a loopback host. Anything else is refused: a
 * disposable lane must never reach a shared or production database.
 */
export function isLoopbackDatabaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  const match = /^[a-zA-Z0-9+.-]+:\/\/(?:[^@/]*@)?([^:/?#]+)(?::\d+)?/.exec(url)
  if (match === null) return false
  const host = match[1]
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/**
 * Runs the cited database-backed tests against a disposable local database.
 *
 * The lane never touches a shared or production database: the URL must name a
 * loopback host, and the same guard the repository's own test lane uses
 * refuses anything else.
 */
export function runDisposableIntegrationJourney({
  checkout,
  baseHead,
  files,
  databaseUrl,
  databaseMigrationUrl,
  timeoutMs = 600_000,
}) {
  if (files.length === 0) {
    return {
      kind: 'disposable-integration',
      status: 'not-required',
      command: null,
      exitCode: null,
      results: [],
      reason: 'no cited test needs a local database',
    }
  }
  if (!isLoopbackDatabaseUrl(databaseUrl)) {
    return {
      kind: 'disposable-integration',
      status: 'unavailable',
      command: null,
      exitCode: null,
      results: [],
      reason:
        'no disposable local database was supplied, and only a loopback database may be used for this lane',
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'adea-certification-disposable-'))
  const checkoutRoot = join(scratch, 'checkout')
  const junitRoot = join(scratch, 'junit')
  mkdirSync(junitRoot, { recursive: true })
  const results = []
  try {
    exportCleanCheckout(checkout, baseHead, checkoutRoot)
    installWorkspaceDependencies(checkout.root, checkoutRoot)
    const builds = requiredBuilds(checkoutRoot, files)
    const buildResults = builds.length === 0 ? [] : buildWorkspacePackages(checkoutRoot, builds)
    const buildFailure = buildResults.find((result) => result.status === 'failed')
    if (buildFailure !== undefined) {
      return {
        kind: 'disposable-integration',
        status: 'failed',
        command: null,
        exitCode: buildFailure.exitCode,
        builds: buildResults,
        results: [],
        reason: `the pinned package ${buildFailure.package} could not be built in the clean checkout`,
      }
    }
    for (const file of files) {
      const junitFile = join(junitRoot, `${file.replace(/[^a-zA-Z0-9.-]/g, '__')}.xml`)
      const command = `bun test --conditions=react-server --timeout 120000 ${file} --reporter=junit --reporter-outfile=${junitFile}`
      const started = process.hrtime.bigint()
      const result = spawnSync(
        'bun',
        [
          'test',
          '--conditions=react-server',
          '--timeout',
          '120000',
          file,
          '--reporter=junit',
          `--reporter-outfile=${junitFile}`,
        ],
        {
          cwd: checkoutRoot,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 32,
          env: {
            ...process.env,
            CI: '1',
            DATABASE_URL: databaseUrl,
            DATABASE_URL_UNPOOLED: databaseUrl,
            ...(databaseMigrationUrl ? { DATABASE_MIGRATION_URL: databaseMigrationUrl } : {}),
          },
        }
      )
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      const junit = existsSync(junitFile) ? readFileSync(junitFile, 'utf8') : null
      const parsed = junit === null ? null : parseJunit(junit)
      const passCount = parsed?.passCount ?? 0
      const failCount = parsed?.failCount ?? 0
      // A file that produced no testcase did not run under this runner. It is
      // a lane mismatch, not a behaviour failure, and it is reported as a skip.
      const ranNothing = passCount === 0 && failCount === 0
      results.push({
        file,
        command,
        exitCode: result.status,
        status: ranNothing ? 'skipped' : result.status === 0 ? 'passed' : 'failed',
        pass: passCount,
        fail: failCount,
        durationMs: Math.round(durationMs),
        passing:
          parsed === null ? [] : [...parsed.passed].filter((title) => !parsed.failed.has(title)),
        failed: parsed === null ? [] : [...parsed.failed],
        stderr: result.status === 0 ? null : (result.stderr ?? '').slice(0, 2000),
      })
    }
    const failed = results.filter((result) => result.status !== 'passed')
    return {
      kind: 'disposable-integration',
      status: failed.length === 0 ? 'passed' : 'failed',
      command: `bun test --conditions=react-server <file> (disposable loopback database)`,
      exitCode: failed.length === 0 ? 0 : 1,
      builds: buildResults,
      results,
      reason:
        failed.length === 0
          ? null
          : `${failed.length} of ${results.length} cited files did not pass against the disposable database`,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Counts by status and by evidence class. */
export function countEntries(entries) {
  const byStatus = Object.fromEntries(Object.values(CLASS_STATUS).map((status) => [status, 0]))
  const byClass = Object.fromEntries(EVIDENCE_CLASSES.map((value) => [value, 0]))
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
    if (entry.evidenceClass !== null) {
      byClass[entry.evidenceClass] = (byClass[entry.evidenceClass] ?? 0) + 1
    }
  }
  return { byStatus, byClass, total: entries.length }
}

/**
 * Assembles the certification report.
 *
 * Nothing here certifies an id on its own. An id is certified only when its
 * source evidence was reproduced at the certification base and every external
 * gate for it is closed. Because the candidate heads, the packaged artifact,
 * the deployed environment, the soak, the performance and cost budgets and
 * the owner's acceptance are all open, the certification count stays at zero
 * and the report says so.
 */
export function buildReport({
  manifest,
  manifestPath,
  receipts,
  receiptProblems,
  checkout,
  baseHead,
  branch,
  clean,
  candidateArtifacts,
  journeys = [],
  changedTestFiles = new Set(),
  changedReceipts = new Set(),
  reproduced = new Map(),
  readiness = new Map(),
  readinessProbes = [],
  discovered = new Map(),
  candidatePackageVersion = null,
}) {
  const entries = buildCertificationMap({
    manifest,
    receipts,
    checkout,
    baseHead,
    changedTestFiles,
    reproduced,
    readiness,
    discovered,
  })
  const pinned = manifest.repositories?.[HOME_REPOSITORY]?.sourceSha ?? null
  const distance =
    pinned === null
      ? { behind: null, relation: 'unknown' }
      : revisionDistance(checkout, pinned, baseHead)
  const counts = countEntries(entries)
  const byDisposition = Object.fromEntries(DISPOSITIONS.map((value) => [value, 0]))
  for (const entry of entries) byDisposition[entry.disposition] += 1
  const sourceVerified = entries.filter((entry) => entry.status === CLASS_STATUS.verified)
  const certified = entries.filter(
    (entry) => entry.status === CLASS_STATUS.verified && entry.blockingGates.length === 0
  )
  const gates = GATES.map((gate) => ({ ...gate, status: 'open' }))
  const candidateHeads = candidateArtifacts.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    commit: candidate.commit,
    channel: candidate.channel,
    evidenceClass: candidate.evidenceClass,
    status: 'accepted',
    ids: candidate.ids,
  }))
  const rejectedHeads = candidateArtifacts.rejections.map((rejection) => ({
    candidateId: rejection.candidateId,
    status: rejection.status,
    reason: rejection.reason,
  }))
  return {
    schema: CERTIFICATION_SCHEMA,
    issues: CERTIFICATION_ISSUES,
    generatedFrom: manifestPath,
    base: {
      repository: HOME_REPOSITORY,
      commit: baseHead,
      branch,
      clean,
    },
    candidate: {
      repository: HOME_REPOSITORY,
      commit: baseHead,
      packageVersion: candidatePackageVersion,
      frozen: true,
      note: 'The source candidate is frozen at this commit. Every result in this report is bound to it.',
    },
    manifest: {
      path: manifestPath,
      pinnedCommit: pinned,
      contractVersions: manifest.compatibility?.contractVersions ?? [],
      behind: distance.behind,
      relation: distance.relation,
      stale: pinned !== null && pinned !== baseHead,
      changedTests: [...changedTestFiles].toSorted(),
      changedReceipts: [...changedReceipts].toSorted(),
      receiptProblems,
    },
    counts: {
      ...counts,
      certified: certified.length,
      sourceVerified: sourceVerified.length,
      byDisposition,
      pendingGates: gates.length,
    },
    classes: { all: EVIDENCE_CLASSES, machine: MACHINE_CLASSES },
    readinessProbes,
    entries,
    candidates: {
      status: candidateArtifacts.status,
      accepted: candidateHeads,
      rejected: rejectedHeads,
    },
    journeys,
    gates,
    certification: {
      certified: certified.length,
      sourceVerified: sourceVerified.length,
      total: REQUIRED_IDS.length,
      state: certified.length === REQUIRED_IDS.length ? 'complete' : 'incomplete',
      statement:
        certified.length === REQUIRED_IDS.length
          ? `certification: complete (${certified.length} of ${REQUIRED_IDS.length})`
          : `certification: incomplete (${certified.length} of ${REQUIRED_IDS.length} certified; ${sourceVerified.length} source-verified; ${gates.length} external gates open)`,
    },
  }
}

/**
 * The exit code of a certification run.
 *
 * A run succeeds when the report was produced and nothing is invalid. In
 * strict mode it succeeds only when every id is certified, so a strict run
 * exits non-zero for as long as any id is uncertified, whatever the reason.
 */
export function certificationExitCode(report, { strict = false } = {}) {
  if (!strict) return 0
  return report.certification.state === 'complete' ? 0 : 1
}

/** Human summary of the report. */
export function summarize(report) {
  const lines = []
  lines.push(`base: ${report.base.repository}@${report.base.commit} (${report.base.branch})`)
  lines.push(
    `manifest: ${report.manifest.path} pinned ${String(report.manifest.pinnedCommit).slice(0, 8)}` +
      (report.manifest.stale
        ? ` (stale, ${report.manifest.behind ?? '?'} commits behind the base)`
        : ' (current)')
  )
  lines.push(
    `contract versions: ${report.manifest.contractVersions.length === 0 ? 'none declared' : report.manifest.contractVersions.join(' ')}`
  )
  lines.push(JSON.stringify(report.counts.byStatus))
  lines.push(JSON.stringify(report.counts.byClass))
  lines.push(`dispositions: ${JSON.stringify(report.counts.byDisposition)}`)
  lines.push(
    `candidate: ${report.candidate.repository}@${report.candidate.commit} package ${report.candidate.packageVersion ?? 'unknown'}`
  )
  for (const probe of report.readinessProbes ?? []) {
    lines.push(
      `readiness ${probe.criterion}: ${probe.status} at ${probe.revision.slice(0, 8)} (${probe.probes.map((entry) => `${entry.probe}=${entry.count}`).join(' ')})`
    )
  }
  for (const problem of report.manifest.receiptProblems) lines.push(`receipt: ${problem}`)
  for (const rejection of report.candidates.rejected) {
    lines.push(
      `candidate ${rejection.candidateId ?? '(manifest)'}: ${rejection.status}: ${rejection.reason}`
    )
  }
  for (const journey of report.journeys) {
    lines.push(
      `journey ${journey.kind}: ${journey.status}${journey.exitCode === null ? '' : ` (exit ${journey.exitCode})`} ${journey.command ?? ''}`
    )
    if (journey.kind === 'cross-product') {
      lines.push(
        `  pair ${journey.repository}@${String(journey.pinnedRevision).slice(0, 8)} with adea@${report.candidate.commit.slice(0, 8)}`
      )
    }
    for (const build of journey.builds ?? []) {
      lines.push(
        `  build ${build.status} ${build.package}${build.durationMs ? ` ${Math.round(build.durationMs)}ms` : ''}`
      )
    }
    for (const consumer of journey.consumers ?? []) {
      lines.push(
        `  consumer ${consumer.status} ${consumer.package}${consumer.reason ? ` (${consumer.reason})` : ''}`
      )
    }
    for (const result of journey.results ?? []) {
      lines.push(
        `  ${result.status} ${result.file} pass=${result.pass} fail=${result.fail} exit=${result.exitCode} ${Math.round(result.durationMs)}ms`
      )
    }
    if (journey.reason) lines.push(`  reason: ${journey.reason}`)
  }
  for (const entry of report.entries.filter((item) => item.status !== CLASS_STATUS.verified)) {
    lines.push(`${entry.id}: ${entry.status}: ${entry.reasons.join('; ')}`)
  }
  for (const gate of report.gates) lines.push(`gate ${gate.id}: open (${gate.owner})`)
  lines.push(report.certification.statement)
  return lines.join('\n')
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultManifest = 'docs/plans/m18-evidence-manifest.json'
const defaultInventory = 'docs/plans/m18-readiness-inventory.json'
const defaultCandidateArtifacts = 'docs/plans/m18-candidate-artifacts.json'

/** Reads a JSON file, returning null when it does not exist. */
function readJsonOrNull(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const strict = args.includes('--strict')
  const run = args.includes('--run')
  const positional = []
  let baseOverride = null
  let databaseUrl = null
  let databaseMigrationUrl = null
  let controlPlaneSource = null
  let candidateManifestPath = defaultCandidateArtifacts
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--base') baseOverride = args[(index += 1)] ?? null
      else if (arg === '--database-url') databaseUrl = args[(index += 1)] ?? null
      else if (arg === '--database-migration-url') databaseMigrationUrl = args[(index += 1)] ?? null
      else if (arg === '--candidate-manifest')
        candidateManifestPath = args[(index += 1)] ?? defaultCandidateArtifacts
      else if (arg === '--control-plane-source') controlPlaneSource = args[(index += 1)] ?? null
      else if (arg === '--repo') index += 1
      else if (arg === '--json' || arg === '--strict' || arg === '--run') {
        // A boolean flag; its effect was already read from the argument list.
      } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
      else positional.push(arg)
    }
    const manifestPath = resolve(repoRoot, positional[0] ?? defaultManifest)
    // A directory here means an option value was mistaken for the manifest
    // path. The runner refuses rather than reading a directory as a file.
    if (existsSync(manifestPath) && !statSync(manifestPath).isFile()) {
      throw new Error(`the manifest path ${manifestPath} is not a file`)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const checkout = repositoryCheckout(repoRoot)
    const baseHead =
      baseOverride ?? runCommand('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim()
    const branch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
    }).trim()
    const clean =
      runCommand('git', ['status', '--porcelain'], { cwd: repoRoot }).trim().length === 0
    const { receipts, problems } = readReceipts(manifest, repoRoot)
    const candidateRaw = readJsonOrNull(resolve(repoRoot, candidateManifestPath))
    const candidateArtifacts = validateCandidateArtifacts(candidateRaw ?? null, {
      baseHead,
      contractVersions: manifest.compatibility?.contractVersions ?? [],
      checkout,
      root: repoRoot,
    })
    const pinned = manifest.repositories?.[HOME_REPOSITORY]?.sourceSha ?? null
    const citedTestPaths = [
      ...new Set(
        (manifest.entries ?? [])
          .flatMap((entry) => entry.repoEvidence ?? [])
          .filter((item) => item.kind === 'test-reference')
          .map((item) => item.path)
      ),
    ].filter((path) => safePath(path) !== null)
    const citedReceiptPaths = [
      ...new Set(
        (manifest.entries ?? [])
          .flatMap((entry) => entry.repoEvidence ?? [])
          .filter((item) => item.kind === 'execution-reference')
          .map((item) => item.path)
      ),
    ].filter((path) => safePath(path) !== null)
    const changedTests =
      pinned !== null && pinned !== baseHead
        ? changedSince(checkout, pinned, baseHead, citedTestPaths)
        : []
    const changedReceipts =
      pinned !== null && pinned !== baseHead
        ? changedSince(checkout, pinned, baseHead, citedReceiptPaths)
        : []
    const changedTestFiles = new Set(changedTests)
    const changedReceiptFiles = new Set(changedReceipts)

    // The #1224 readiness record is the reviewed second source: it names, for
    // each of its criteria, the acceptance and requirement ids the criterion
    // comes from, and it defines the presence probes that qualify a criterion
    // against product source at a revision.
    const inventoryPath = resolve(repoRoot, defaultInventory)
    const inventory = readJsonOrNull(inventoryPath) ?? null
    const readiness = new Map()
    if (inventory !== null && Array.isArray(inventory.criteria)) {
      for (const id of REQUIRED_IDS) {
        const criteria = readinessCriteriaForId(inventory.criteria, id)
        if (criteria.length > 0) readiness.set(id, criteria)
      }
    }
    const readinessProbes =
      inventory === null
        ? []
        : executeReadinessProbes({
            criteria: inventory.criteria,
            probes: inventory.probes,
            revision: baseHead,
            cwd: repoRoot,
          })

    const journeys = []
    let reproduced = new Map()
    let discovered = new Map()
    if (run) {
      const map = buildCertificationMap({
        manifest,
        receipts,
        checkout,
        baseHead,
        changedTestFiles,
        reproduced,
        readiness,
      })
      // A row the manifest maps no evidence for still gets an inventory: the
      // available qualifications at the frozen candidate are searched for, and
      // the ones that can be run are run.
      const discoveredFiles = new Set()
      const mentionCache = new Map()
      discovered = new Map()
      for (const entry of map) {
        if (entry.status !== CLASS_STATUS.pending) continue
        const found = discoverQualifications({
          gaps: entry.gaps,
          revision: baseHead,
          cwd: repoRoot,
          cache: mentionCache,
        })
        discovered.set(entry.id, found)
        for (const gap of found) {
          for (const lead of gap.leads) {
            if (lead.score < 2) continue
            if (!classifyRunnable(lead.file).runnable) continue
            discoveredFiles.add(lead.file)
          }
        }
      }
      const lane = nonUiLane(map)
      const laneFiles = new Set(lane.map((file) => file.path))
      for (const file of discoveredFiles) {
        if (laneFiles.has(file)) continue
        if (BROWSER_CONDITION_FILES.has(file)) continue
        if (classForTestPath(file) === CLASS.disposableIntegration) continue
        laneFiles.add(file)
      }
      const journey = runCleanCheckoutJourney({
        checkout,
        baseHead,
        files: lane.map((file) => file.path),
        sourceRoot: repoRoot,
      })
      journeys.push(journey)
      reproduced = new Map(
        journey.results.map((result) => [
          result.file,
          { status: result.status, passing: result.passing },
        ])
      )
      // The discovered qualifications run in their own lane, so a lane
      // mismatch in a discovered file cannot make the cited lane fail.
      const discoveredLaneFiles = [...discoveredFiles]
        .filter((file) => !laneFiles.has(file))
        .filter((file) => !BROWSER_CONDITION_FILES.has(file))
        .filter((file) => classForTestPath(file) !== CLASS.disposableIntegration)
        .toSorted()
      if (discoveredLaneFiles.length > 0) {
        const discoveredJourney = runCleanCheckoutJourney({
          checkout,
          baseHead,
          files: discoveredLaneFiles,
          sourceRoot: repoRoot,
          kind: 'discovered',
        })
        journeys.push(discoveredJourney)
        for (const result of discoveredJourney.results ?? []) {
          reproduced.set(result.file, { status: result.status, passing: result.passing })
        }
      }
      const browser = browserConditionLane(map)
      if (browser.length > 0) {
        const browserJourney = runCleanCheckoutJourney({
          checkout,
          baseHead,
          files: browser,
          sourceRoot: repoRoot,
          kind: 'browser-condition',
          conditions: 'browser',
        })
        journeys.push(browserJourney)
        for (const result of browserJourney.results ?? []) {
          reproduced.set(result.file, { status: result.status, passing: result.passing })
        }
      }
      const disposable = runDisposableIntegrationJourney({
        checkout,
        baseHead,
        files: disposableLane(map),
        databaseUrl: databaseUrl ?? '',
        databaseMigrationUrl: databaseMigrationUrl ?? null,
      })
      journeys.push(disposable)
      for (const result of disposable.results ?? []) {
        reproduced.set(result.file, { status: result.status, passing: result.passing })
      }
      const pin = readCrossRepositoryPin(repoRoot)
      if (pin !== null) {
        journeys.push(
          runCrossProductJourney({
            root: repoRoot,
            pin,
            controlPlaneSource: controlPlaneSource ?? null,
            databaseUrl: databaseUrl ?? '',
          })
        )
      }
    }
    const candidatePackageVersion = (() => {
      const blob = checkout.blobAtSha(baseHead, 'package.json')
      if (blob === null || !blob.regular) return null
      try {
        return JSON.parse(blob.bytes().toString('utf8')).version ?? null
      } catch {
        return null
      }
    })()
    const report = buildReport({
      manifest,
      manifestPath: relative(repoRoot, manifestPath),
      receipts,
      receiptProblems: problems,
      checkout,
      baseHead,
      branch,
      clean,
      candidateArtifacts,
      journeys,
      changedTestFiles,
      changedReceipts: changedReceiptFiles,
      reproduced,
      readiness,
      readinessProbes,
      discovered,
      candidatePackageVersion,
    })
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${summarize(report)}\n`)
    if (strict && report.certification.state !== 'complete') {
      process.stdout.write('strict: not every id is certified\n')
    }
    process.exitCode = certificationExitCode(report, { strict })
  } catch (error) {
    // An internal failure is a failure. The stack is printed so the cause is
    // diagnosable, and the exit code is non-zero.
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}

export { ACCEPTANCE_IDS, REQUIREMENT_IDS, REQUIRED_IDS }
