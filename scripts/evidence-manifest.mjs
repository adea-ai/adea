import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Evidence manifest validator for Adea #1225 (parent #1183, M18.03).
//
// The manifest maps each requirement and each A01–A40 acceptance id to:
//   1. repository evidence. Each reference names a repository key declared in
//      `repositories`; the key's `rootCommit` is its immutable identity, and its
//      `sourceSha` is the one revision every reference must resolve at.
//      - `test-reference`: a test title appears in a *.test.* file at that revision.
//        This is a source-text match, so it also matches comments and strings.
//      - `execution-reference`: a recorded run at exactly that revision (`exitCode` 0,
//        status `passed`) whose JUnit receipt lists the title as passing.
//      Only runner-verified titles count. A declaration alone never verifies an id.
//   2. candidate records (packaged or deployed). A candidate declares the exact
//      source SHA of every repository the id references, a compatible contract
//      version, and a passing JUnit receipt of its own.
// `coverage: complete` is only accepted with criteria, each citing runner-verified
// tests, and no gaps. Anything else stays `pending` with its gaps listed. Local
// checkouts are supplied by the caller and must contain the declared root commit.
// Files are read only when they are regular, within the root, and under
// MAX_EVIDENCE_BYTES. Unmapped ids stay `pending`.

export const SCHEMA_VERSION = 1
export const ISSUE = 1225
export const HOME_REPOSITORY = 'adea'
export const MAX_EVIDENCE_BYTES = 1024 * 1024

/** Requirement ids named by #1225 traceability (`REQ 005,012,…`). */
export const REQUIREMENT_IDS = Object.freeze(
  [
    '005',
    '012',
    '033',
    '059',
    '108',
    '118',
    '119',
    '120',
    '130',
    '131',
    '132',
    '133',
    '134',
    '135',
    '136',
    '150',
    '151',
    '153',
    '154',
    '155',
    '174',
    '175',
    '176',
    '177',
  ].map((number) => `REQ-${number}`)
)

/** Acceptance ids named by #1225 (`Tests: A01–A40`). */
export const ACCEPTANCE_IDS = Object.freeze(
  Array.from({ length: 40 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
)

export const REQUIRED_IDS = Object.freeze([...REQUIREMENT_IDS, ...ACCEPTANCE_IDS])

export const STATUS = Object.freeze({
  pending: 'pending',
  invalid: 'invalid',
  repoVerified: 'repo-verified',
  candidateCompatible: 'candidate-compatible',
})

const CHANNELS = new Set(['packaged', 'deployed'])
const REGULAR_BLOB_MODES = new Set(['100644', '100755'])
const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/
const REPO_KEY = /^[a-z][a-z0-9-]{0,62}$/
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LS_TREE = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\s+(-|\d+)\t([\s\S]*)$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A repo-relative POSIX path with no absolute prefix, `..`, `.`, or empty segment. */
export function safeRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) return null
  if (path.includes('\\')) return null
  const segments = path.split('/')
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ? null
    : path
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJson(bytes) {
  try {
    return { value: JSON.parse(Buffer.from(bytes).toString('utf8')) }
  } catch {
    return { error: 'not valid JSON' }
  }
}

/** One local checkout, read through git. Blobs come from committed trees, not the disk. */
function gitCheckout(root) {
  const git = (args, encoding) =>
    spawnSync('git', args, { cwd: root, encoding, maxBuffer: MAX_EVIDENCE_BYTES * 4 })
  return {
    commitExists(sha) {
      return git(['cat-file', '-e', `${sha}^{commit}`]).status === 0
    },
    rootCommits(sha) {
      const result = git(['rev-list', '--max-parents=0', sha], 'utf8')
      if (result.status !== 0) return []
      return result.stdout.split('\n').filter(Boolean)
    },
    blobAtSha(sha, path) {
      const listing = git(['ls-tree', '-l', '-z', sha, '--', path], 'utf8')
      if (listing.status !== 0) return null
      const match = listing.stdout
        .split('\0')
        .map((line) => LS_TREE.exec(line))
        .filter(Boolean)
        .find(([, , , , , name]) => name === path)
      if (!match) return null
      const [, mode, type, , size] = match
      return {
        regular: type === 'blob' && REGULAR_BLOB_MODES.has(mode),
        mode,
        size: size === '-' ? 0 : Number(size),
        bytes: () => git(['cat-file', 'blob', `${sha}:${path}`]).stdout,
      }
    },
  }
}

/** Working-tree files under the home root. Symlinks resolving outside it are reported. */
function workingFiles(root) {
  const realRoot = realpathSync(root)
  return (path) => {
    let real
    try {
      real = realpathSync(resolve(realRoot, path))
    } catch {
      return null
    }
    if (!real.startsWith(realRoot + sep)) return { outside: true }
    const stat = statSync(real)
    return {
      regular: stat.isFile(),
      size: stat.size,
      bytes: () => readFileSync(real),
    }
  }
}

/**
 * Default I/O. `mapping` maps repository keys to local checkout paths and must include
 * the home repository, whose checkout also holds the working-tree artifact records.
 * A repository key with no mapping has no checkout, so its references stay invalid.
 */
export function repositoryIo(mapping) {
  const home = mapping[HOME_REPOSITORY]
  if (typeof home !== 'string') throw new Error(`repository mapping needs ${HOME_REPOSITORY}`)
  const checkouts = new Map(
    Object.entries(mapping).map(([key, path]) => [key, gitCheckout(resolve(path))])
  )
  const workingFile = workingFiles(resolve(home))
  return {
    checkout: (repository) => checkouts.get(repository) ?? null,
    workingFile,
  }
}

function checkTestReference(item, checkout, manifest) {
  if (!TEST_FILE.test(item.path)) return 'test-reference must name a *.test.* file'
  if (typeof item.name !== 'string' || item.name.length === 0) {
    return 'test-reference must name the test title'
  }
  const sha = manifest.repositories[item.repository].sourceSha
  const blob = checkout.blobAtSha(sha, item.path)
  if (blob === null) return `${item.repository}:${item.path} does not exist at ${sha}`
  if (!blob.regular) return `${item.repository}:${item.path} is not a regular file`
  if (blob.size > MAX_EVIDENCE_BYTES) {
    return `${item.repository}:${item.path} exceeds ${MAX_EVIDENCE_BYTES} bytes`
  }
  const source = blob.bytes().toString('utf8')
  const quoted = [`'${item.name}'`, `"${item.name}"`, `\`${item.name}\``]
  if (!quoted.some((literal) => source.includes(literal))) {
    return `test title "${item.name}" is not declared in ${item.repository}:${item.path} at ${sha}`
  }
  return null
}

/** Bounded, hash-pinned bytes: size is checked before any read. */
function readBytes(item, io) {
  const file = io.workingFile(item.path)
  if (file === null) return { problem: `${item.path} is missing` }
  if (file.outside) return { problem: `${item.path} resolves outside the repository root` }
  if (!file.regular) return { problem: `${item.path} is not a regular file` }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return { problem: `${item.path} exceeds ${MAX_EVIDENCE_BYTES} bytes` }
  }
  const bytes = file.bytes()
  if (!SHA256.test(item.sha256 ?? '') || sha256Hex(bytes) !== item.sha256) {
    return { problem: `${item.path} does not match sha256` }
  }
  return { bytes }
}

function readRecord(item, io) {
  const { bytes, problem } = readBytes(item, io)
  if (problem) return { problem }
  const parsed = parseJson(bytes)
  if (parsed.error) return { problem: `${item.path} is ${parsed.error}` }
  if (!isObject(parsed.value)) return { problem: `${item.path} must be a JSON object` }
  return { record: parsed.value }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name])

/**
 * Runner-produced JUnit receipt: one entry per testcase. A testcase with a failure,
 * error, or skipped child is not passing. Counts are per testcase, so a duplicated
 * title is counted twice. Returns null when the XML has no testcases.
 */
export function parseJunit(xml) {
  const passed = new Set()
  const failed = new Set()
  let passCount = 0
  let failCount = 0
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\sname="([^"]*)"/.exec(match[1])?.[1]
    if (name === undefined) return null
    const title = unescapeXml(name)
    if (/<(failure|error|skipped)\b/.test(match[2] ?? '')) {
      failed.add(title)
      failCount += 1
    } else {
      passed.add(title)
      passCount += 1
    }
  }
  if (passCount + failCount === 0) return null
  return { passed, failed, passCount, failCount }
}

/**
 * A receipt is the runner's output. Its per-testcase counts must equal the claimed
 * summary. Returns the titles it lists as passing and as failing.
 */
function checkReceipt(receiptRef, summary, io) {
  if (!isObject(receiptRef) || safeRepoPath(receiptRef.path) === null) {
    return { problem: 'a receipt must name a path and sha256' }
  }
  const receipt = readBytes(receiptRef, io)
  if (receipt.problem) return { problem: `receipt ${receipt.problem}` }
  const junit = parseJunit(Buffer.from(receipt.bytes).toString('utf8'))
  if (junit === null) return { problem: `receipt ${receiptRef.path} is not JUnit testcases` }
  if (junit.passCount !== summary?.pass || junit.failCount !== summary?.fail) {
    return {
      problem: `receipt counts ${junit.passCount}/${junit.failCount} do not match record summary`,
    }
  }
  const passing = new Set([...junit.passed].filter((title) => !junit.failed.has(title)))
  return { passing, failed: junit.failed }
}

/**
 * A recorded run bound to the pinned revision. The record is a claim, so its receipt
 * must match it. `executedAtHead` must equal the pinned SHA, not merely exist.
 */
function checkExecutionReference(item, id, io, manifest) {
  const { record, problem } = readRecord(item, io)
  if (problem) return { problem }
  if (record.repository !== item.repository) {
    return {
      problem: `execution record names repository ${record.repository}, reference names ${item.repository}`,
    }
  }
  const sha = manifest.repositories[item.repository].sourceSha
  if (record.sourceSha !== sha) {
    return { problem: `execution record pins ${record.sourceSha}, ${item.repository} pins ${sha}` }
  }
  if (record.executedAtHead !== sha) {
    return { problem: `executedAtHead ${record.executedAtHead} is not the pinned ${sha}` }
  }
  if (record.status !== 'passed') {
    return { problem: `execution record status is ${record.status}, not passed` }
  }
  if (record.exitCode !== 0) {
    return { problem: `execution record exit code is ${record.exitCode}, not 0` }
  }
  if (typeof record.command !== 'string' || record.command.length === 0) {
    return { problem: 'execution record must name the command' }
  }
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return { problem: `execution record does not list ${id}` }
  }
  if (safeRepoPath(record.file) === null || !TEST_FILE.test(record.file)) {
    return { problem: 'execution record must name a *.test.* file' }
  }
  const receipt = checkReceipt(item.receipt, record.summary, io)
  if (receipt.problem) return { problem: receipt.problem }
  return { file: record.file, passing: receipt.passing }
}

function sourceProblems(entry, io, manifest) {
  const problems = []
  for (const ref of entry.sourceReferences ?? []) {
    if (safeRepoPath(ref.path) === null) {
      problems.push(`unsafe source reference ${String(ref.path)}`)
      continue
    }
    const checkout = io.checkout(ref.repository)
    if (checkout === null) {
      problems.push(`no local checkout mapped for repository ${ref.repository}`)
      continue
    }
    const blob = checkout.blobAtSha(manifest.repositories[ref.repository].sourceSha, ref.path)
    if (blob === null || !blob.regular) {
      problems.push(`source ${ref.repository}:${ref.path} is not a regular file at the pinned SHA`)
    }
  }
  return problems
}

/** A candidate's own passing receipt: every testcase it lists must pass, and it lists some. */
function checkCandidateEvidence(item, id, io, manifest, repositories) {
  const { record, problem } = readRecord(item, io)
  if (problem) return problem
  if (typeof record.candidateId !== 'string' || record.candidateId.length === 0) {
    return 'candidate record must name candidateId'
  }
  const name = record.candidateId
  if (!CHANNELS.has(record.channel)) {
    return `candidate ${name} channel ${record.channel} is not packaged or deployed`
  }
  if (!manifest.compatibility.contractVersions.includes(record.contractVersion)) {
    return `candidate ${name} contract ${record.contractVersion} is not compatible`
  }
  if (record.status !== 'passed') return `candidate ${name} status is ${record.status}`
  if (record.exitCode !== 0) return `candidate ${name} exit code is ${record.exitCode}, not 0`
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return `candidate ${name} does not list ${id}`
  }
  if (!isObject(record.sources)) return `candidate ${name} must declare sources per repository`
  for (const repository of repositories) {
    const sha = manifest.repositories[repository].sourceSha
    if (record.sources[repository] !== sha) {
      return `candidate ${name} does not declare sources.${repository} = ${sha}`
    }
  }
  const receipt = checkReceipt(item.receipt, record.summary, io)
  if (receipt.problem) return `candidate ${name} ${receipt.problem}`
  if (receipt.failed.size > 0 || receipt.passing.size === 0) {
    return `candidate ${name} test result is not all passing`
  }
  return null
}

const intersect = (previous, next) =>
  previous === undefined ? next : new Set([...previous].filter((title) => next.has(title)))

const isVerified = (test, receipts) => receipts.get(test.path)?.has(test.name) === true

function evaluate(id, entry, io, manifest) {
  if (entry === undefined) return { status: STATUS.pending, reasons: ['no evidence mapped'] }
  const sources = sourceProblems(entry, io, manifest)
  if (sources.length > 0) return { status: STATUS.invalid, reasons: sources }
  const gapReasons = (entry.gaps ?? []).map((gap) => `gap: ${gap}`)

  if (entry.repoEvidence.length === 0) {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['candidate evidence requires an execution-reference'],
      }
    }
    return { status: STATUS.pending, reasons: ['no repository evidence mapped', ...gapReasons] }
  }

  const reasons = []
  const repositories = new Set()
  // File -> titles that passed in every execution-reference for that file.
  const receipts = new Map()
  const tests = []
  let executions = 0
  for (const item of entry.repoEvidence) {
    if (safeRepoPath(item.path) === null) {
      reasons.push(`unsafe evidence path ${String(item.path)}`)
      continue
    }
    repositories.add(item.repository)
    const checkout = io.checkout(item.repository)
    if (checkout === null) {
      reasons.push(`no local checkout mapped for repository ${item.repository}`)
      continue
    }
    if (item.kind === 'test-reference') {
      tests.push(item)
      const problem = checkTestReference(item, checkout, manifest)
      if (problem) reasons.push(problem)
    } else if (item.kind === 'execution-reference') {
      executions += 1
      const result = checkExecutionReference(item, id, io, manifest)
      if (result.problem) reasons.push(result.problem)
      else receipts.set(result.file, intersect(receipts.get(result.file), result.passing))
    } else {
      reasons.push(`unknown repository evidence kind ${item.kind}`)
    }
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }

  const verified = tests.filter((test) => isVerified(test, receipts))
  const unverified = tests.filter((test) => !isVerified(test, receipts))

  if (executions === 0) {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['candidate evidence requires an execution-reference'],
      }
    }
    if (entry.coverage === 'complete') {
      return {
        status: STATUS.invalid,
        reasons: ['complete coverage requires an execution-reference'],
      }
    }
    return {
      status: STATUS.pending,
      reasons: ['declaration only, no execution-reference', ...gapReasons],
    }
  }
  if (verified.length === 0) {
    return {
      status: STATUS.invalid,
      reasons: ['no test-reference is a passing title in its receipt'],
    }
  }

  if (entry.coverage === 'partial') {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['partial coverage cannot carry candidate evidence'],
      }
    }
    return {
      status: STATUS.pending,
      reasons: [
        `runner-verified titles: ${verified.length}, source-text-only titles: ${unverified.length} (weaker)`,
        ...gapReasons,
      ],
    }
  }

  // Complete coverage is a claim. Every declared test must have passed in its receipt,
  // and every criterion must cite runner-verified tests from this entry.
  const failures = unverified.map(
    (test) => `test-reference is not a passing title in its receipt: ${test.path} "${test.name}"`
  )
  for (const criterion of entry.criteria ?? []) {
    const evidenced = criterion.tests.every((ref) =>
      verified.some((test) => test.path === ref.path && test.name === ref.name)
    )
    if (!evidenced)
      failures.push(`criterion not evidenced by runner-verified tests: ${criterion.text}`)
  }
  if (failures.length > 0) return { status: STATUS.invalid, reasons: failures }

  if (entry.candidateEvidence.length === 0) {
    return { status: STATUS.repoVerified, reasons: ['candidate evidence pending'] }
  }

  for (const item of entry.candidateEvidence) {
    if (item?.kind !== 'candidate-reference' || safeRepoPath(item.path) === null) {
      reasons.push(`invalid candidate evidence reference for ${id}`)
      continue
    }
    const problem = checkCandidateEvidence(item, id, io, manifest, repositories)
    if (problem) reasons.push(problem)
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }
  return { status: STATUS.candidateCompatible, reasons: [] }
}

function criteriaErrors(entry) {
  const errors = []
  for (const criterion of entry.criteria ?? []) {
    const valid =
      isObject(criterion) &&
      typeof criterion.text === 'string' &&
      criterion.text.length > 0 &&
      Array.isArray(criterion.tests) &&
      criterion.tests.length > 0 &&
      criterion.tests.every(
        (ref) => isObject(ref) && typeof ref.path === 'string' && typeof ref.name === 'string'
      )
    if (!valid)
      errors.push(`${entry.id} criterion must name text and at least one test {path, name}`)
  }
  return errors
}

function manifestErrors(manifest, io) {
  const errors = []
  if (!isObject(manifest)) return ['manifest must be a JSON object']
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (manifest.issue !== ISSUE) errors.push(`issue must be ${ISSUE}`)

  const repositories = manifest.repositories
  if (!isObject(repositories) || Object.keys(repositories).length === 0) {
    errors.push('repositories must be a non-empty object')
  } else if (!Object.hasOwn(repositories, HOME_REPOSITORY)) {
    errors.push(`repositories must include ${HOME_REPOSITORY}`)
  }
  for (const [key, repo] of Object.entries(isObject(repositories) ? repositories : {})) {
    if (!REPO_KEY.test(key)) {
      errors.push(`repository key ${key} must be lowercase letters, digits, or dashes`)
      continue
    }
    if (!isObject(repo) || typeof repo.name !== 'string' || !REPO_NAME.test(repo.name)) {
      errors.push(`${key}.name must be owner/repo`)
      continue
    }
    if (typeof repo.rootCommit !== 'string' || !SHA.test(repo.rootCommit)) {
      errors.push(`${key}.rootCommit must be a 40-character lowercase commit SHA`)
    }
    if (typeof repo.sourceSha !== 'string' || !SHA.test(repo.sourceSha)) {
      errors.push(`${key}.sourceSha must be a 40-character lowercase commit SHA`)
      continue
    }
    const checkout = io.checkout(key)
    if (checkout === null) continue
    if (!checkout.commitExists(repo.sourceSha)) {
      errors.push(`${key} sourceSha ${repo.sourceSha} is not a commit in its local checkout`)
    } else if (!checkout.rootCommits(repo.sourceSha).includes(repo.rootCommit)) {
      errors.push(`local checkout for ${key} is not ${repo.name} (root ${repo.rootCommit} absent)`)
    }
  }

  if (
    !isObject(manifest.compatibility) ||
    !Array.isArray(manifest.compatibility.contractVersions)
  ) {
    errors.push('compatibility.contractVersions must be an array')
  } else if (manifest.compatibility.contractVersions.some((v) => typeof v !== 'string' || !v)) {
    errors.push('compatibility.contractVersions must contain non-empty strings')
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('entries must be an array')
    return errors
  }
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (!isObject(entry) || typeof entry.id !== 'string') {
      errors.push('every entry must be an object with an id')
      continue
    }
    if (!REQUIRED_IDS.includes(entry.id)) errors.push(`unknown id ${entry.id}`)
    if (seen.has(entry.id)) errors.push(`duplicate entry ${entry.id}`)
    seen.add(entry.id)
    if (!Array.isArray(entry.repoEvidence) || !Array.isArray(entry.candidateEvidence)) {
      errors.push(`${entry.id} must list repoEvidence and candidateEvidence arrays`)
      continue
    }
    if (entry.coverage !== 'complete' && entry.coverage !== 'partial') {
      errors.push(`${entry.id} coverage must be complete or partial`)
    } else if (entry.coverage === 'partial') {
      if (
        !Array.isArray(entry.gaps) ||
        entry.gaps.length === 0 ||
        entry.gaps.some((g) => typeof g !== 'string' || !g)
      ) {
        errors.push(`${entry.id} partial coverage must list gaps`)
      }
    } else {
      if (entry.gaps !== undefined) errors.push(`${entry.id} complete coverage must not list gaps`)
      if (!Array.isArray(entry.criteria) || entry.criteria.length === 0) {
        errors.push(`${entry.id} complete coverage must list criteria`)
      }
    }
    if (entry.criteria !== undefined && !Array.isArray(entry.criteria)) {
      errors.push(`${entry.id} criteria must be an array`)
    } else {
      errors.push(...criteriaErrors(entry))
    }
    for (const item of entry.repoEvidence) {
      if (
        !isObject(item) ||
        !isObject(repositories) ||
        !Object.hasOwn(repositories, item.repository)
      ) {
        errors.push(`${entry.id} references unknown repository ${item?.repository}`)
      }
    }
    if (entry.sourceReferences !== undefined) {
      if (!Array.isArray(entry.sourceReferences)) {
        errors.push(`${entry.id} sourceReferences must be an array`)
      } else {
        for (const ref of entry.sourceReferences) {
          if (
            !isObject(ref) ||
            typeof ref.path !== 'string' ||
            !isObject(repositories) ||
            !Object.hasOwn(repositories, ref.repository)
          ) {
            errors.push(`${entry.id} source reference must name a declared repository and path`)
          }
        }
      }
    }
  }
  return errors
}

/**
 * Validate a manifest against the #1225 id universe.
 *
 * Returns `{ ok, schemaErrors, results, counts }`. `ok` is false on any schema error
 * or invalid mapping. `strict` also requires every id to be candidate-compatible.
 */
export function validateEvidenceManifest(manifest, io, { strict = false } = {}) {
  const schemaErrors = manifestErrors(manifest, io)
  if (schemaErrors.length > 0) {
    return { ok: false, schemaErrors, results: [], counts: countStatuses([]) }
  }

  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]))
  const results = REQUIRED_IDS.map((id) => {
    const group = id.startsWith('REQ-') ? 'requirement' : 'acceptance'
    return { id, group, ...evaluate(id, byId.get(id), io, manifest) }
  })
  const counts = countStatuses(results)
  const complete = counts[STATUS.candidateCompatible] === REQUIRED_IDS.length
  const ok = counts[STATUS.invalid] === 0 && (!strict || complete)
  return { ok, schemaErrors, results, counts }
}

function countStatuses(results) {
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]))
  for (const result of results) counts[result.status] += 1
  return counts
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultManifest = 'docs/plans/m18-evidence-manifest.json'

/** Human summary: the revisions checked, every invalid id, and the explicit certification state. */
function summarize(manifest, report) {
  const lines = []
  const revisions = Object.entries(manifest.repositories ?? {})
    .map(([key, repo]) => `${key}@${repo?.sourceSha}`)
    .join(' ')
  lines.push(`revisions: ${revisions}`)
  lines.push(JSON.stringify(report.counts))
  for (const error of report.schemaErrors) lines.push(`schema: ${error}`)
  for (const result of report.results.filter((r) => r.status === STATUS.invalid)) {
    lines.push(`${result.id}: ${result.reasons.join('; ')}`)
  }
  if (report.schemaErrors.length === 0) {
    const pending = report.results.filter((r) => r.status === STATUS.pending).map((r) => r.id)
    if (pending.length > 0) lines.push(`pending: ${pending.join(' ')}`)
    const certified = report.counts[STATUS.candidateCompatible]
    lines.push(
      certified === REQUIRED_IDS.length
        ? 'certification: complete'
        : `certification: incomplete (${certified} of ${REQUIRED_IDS.length} candidate-compatible)`
    )
  }
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const json = args.includes('--json')
  const mapping = { [HOME_REPOSITORY]: repoRoot }
  const positional = []
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--repo') {
        const value = args[(index += 1)] ?? ''
        const equals = value.indexOf('=')
        if (equals <= 0) throw new Error('--repo expects key=path')
        mapping[value.slice(0, equals)] = resolve(value.slice(equals + 1))
      } else if (!arg.startsWith('--')) {
        positional.push(arg)
      }
    }
    const manifestPath = resolve(repoRoot, positional[0] ?? defaultManifest)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const report = validateEvidenceManifest(manifest, repositoryIo(mapping), { strict })
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : `${summarize(manifest, report)}\n`
    )
    if (strict && report.schemaErrors.length === 0 && !report.ok) {
      process.stdout.write('strict: not every id is candidate-compatible\n')
    }
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
