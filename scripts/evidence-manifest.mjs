import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Evidence manifest validator for Adea #1225 (parent #1183, M18.03).
//
// The manifest maps each requirement and each A01–A40 acceptance id to:
//   1. repository evidence pinned to one exact commit: a test declaration that
//      exists at that commit, or a recorded run whose bytes match a pinned hash;
//   2. optionally, candidate records (packaged or deployed) whose source SHA and
//      contract version are explicitly compatible with that commit.
// Declaring a test proves the test exists, not that it passed. A run or candidate
// record counts only when it says `passed`. Ids with no mapping stay `pending`;
// nothing is inferred from neighbouring ids, file presence, or a green CI run.

export const SCHEMA_VERSION = 1
export const ISSUE = 1225

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
const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/

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

/**
 * Default I/O: reads committed content from git (`<sha>:<path>`) and working-tree
 * artifacts from disk, confined to `root`.
 */
export function repositoryIo(root) {
  const git = (args, options = {}) =>
    spawnSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options })
  return {
    commitExists(sha) {
      return git(['cat-file', '-e', `${sha}^{commit}`]).status === 0
    },
    readAtSha(sha, path) {
      const result = git(['show', `${sha}:${path}`], { encoding: 'utf8' })
      return result.status === 0 ? result.stdout : null
    },
    readWorking(path) {
      const absolute = resolve(root, path)
      if (!absolute.startsWith(resolve(root) + sep) || !existsSync(absolute)) return null
      return readFileSync(absolute)
    },
  }
}

function checkTestEvidence(item, io, manifest) {
  if (!TEST_FILE.test(item.path ?? '')) return 'test evidence must name a *.test.* file'
  if (typeof item.name !== 'string' || item.name.length === 0) {
    return 'test evidence must name the test title'
  }
  const source = io.readAtSha(manifest.sourceSha, item.path)
  if (source === null) return `${item.path} does not exist at ${manifest.sourceSha}`
  const quoted = [`'${item.name}'`, `"${item.name}"`, `\`${item.name}\``]
  if (!quoted.some((literal) => source.includes(literal))) {
    return `test title "${item.name}" is not declared in ${item.path} at ${manifest.sourceSha}`
  }
  return null
}

function readRecord(item, io) {
  const bytes = io.readWorking(item.path)
  if (bytes === null) return { problem: `${item.path} is missing` }
  if (!SHA256.test(item.sha256 ?? '') || sha256Hex(bytes) !== item.sha256) {
    return { problem: `${item.path} does not match sha256` }
  }
  const parsed = parseJson(bytes)
  if (parsed.error) return { problem: `${item.path} is ${parsed.error}` }
  if (!isObject(parsed.value)) return { problem: `${item.path} must be a JSON object` }
  return { record: parsed.value }
}

function checkRunEvidence(item, id, io, manifest) {
  const { record, problem } = readRecord(item, io)
  if (problem) return problem
  if (record.sourceSha !== manifest.sourceSha) {
    return `run record pins ${record.sourceSha}, manifest pins ${manifest.sourceSha}`
  }
  if (record.status !== 'passed') return `run record status is ${record.status}, not passed`
  if (typeof record.command !== 'string' || record.command.length === 0) {
    return 'run record must name the command'
  }
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return `run record does not list ${id}`
  }
  return null
}

function checkCandidateEvidence(item, id, io, manifest) {
  const { record, problem } = readRecord(item, io)
  if (problem) return problem
  if (typeof record.candidateId !== 'string' || record.candidateId.length === 0) {
    return 'candidate record must name candidateId'
  }
  if (!CHANNELS.has(record.channel))
    return `candidate channel ${record.channel} is not packaged or deployed`
  if (record.sourceSha !== manifest.sourceSha) {
    return `candidate ${record.candidateId} built from ${record.sourceSha}, manifest pins ${manifest.sourceSha}`
  }
  if (!manifest.compatibility.contractVersions.includes(record.contractVersion)) {
    return `candidate ${record.candidateId} contract ${record.contractVersion} is not compatible`
  }
  if (record.status !== 'passed')
    return `candidate ${record.candidateId} status is ${record.status}`
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return `candidate ${record.candidateId} does not list ${id}`
  }
  return null
}

function evaluate(id, entry, io, manifest) {
  if (entry === undefined) return { status: STATUS.pending, reasons: ['no evidence mapped'] }

  const reasons = []
  if (entry.sourceSha !== manifest.sourceSha) {
    reasons.push(`entry pins ${entry.sourceSha}, manifest pins ${manifest.sourceSha}`)
  }
  if (entry.repoEvidence.length === 0) {
    if (reasons.length > 0) return { status: STATUS.invalid, reasons }
    return { status: STATUS.pending, reasons: ['no repository evidence mapped'] }
  }

  for (const item of entry.repoEvidence) {
    const path = item?.path
    if (item?.kind !== 'test' && item?.kind !== 'run') {
      reasons.push(`unknown repository evidence kind ${item?.kind}`)
      continue
    }
    if (safeRepoPath(path) === null) {
      reasons.push(`unsafe evidence path ${String(path)}`)
      continue
    }
    const problem =
      item.kind === 'test'
        ? checkTestEvidence(item, io, manifest)
        : checkRunEvidence(item, id, io, manifest)
    if (problem) reasons.push(problem)
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }

  if (entry.candidateEvidence.length === 0) {
    return { status: STATUS.repoVerified, reasons: ['candidate evidence pending'] }
  }

  for (const item of entry.candidateEvidence) {
    if (item?.kind !== 'candidate' || safeRepoPath(item.path) === null) {
      reasons.push(`invalid candidate evidence reference for ${id}`)
      continue
    }
    const problem = checkCandidateEvidence(item, id, io, manifest)
    if (problem) reasons.push(problem)
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }
  return { status: STATUS.candidateCompatible, reasons: [] }
}

function manifestErrors(manifest, io) {
  const errors = []
  if (!isObject(manifest)) return ['manifest must be a JSON object']
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (manifest.issue !== ISSUE) errors.push(`issue must be ${ISSUE}`)
  if (typeof manifest.sourceSha !== 'string' || !SHA.test(manifest.sourceSha)) {
    errors.push('sourceSha must be a 40-character lowercase commit SHA')
  } else if (!io.commitExists(manifest.sourceSha)) {
    errors.push(`sourceSha ${manifest.sourceSha} is not a commit in this repository`)
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
    }
  }
  return errors
}

/**
 * Validate a manifest against the #1225 id universe.
 *
 * Returns `{ ok, schemaErrors, results, counts }`. `ok` is false on any schema error
 * or invalid mapping. `strict` also requires every id to be candidate-compatible,
 * so an incomplete manifest passes only in its default, pending-tolerant mode.
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const json = args.includes('--json')
  const manifestArg = args.find((arg) => !arg.startsWith('--')) ?? defaultManifest
  const manifestPath = resolve(repoRoot, manifestArg)
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const report = validateEvidenceManifest(manifest, repositoryIo(repoRoot), { strict })
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      process.stdout.write(`${JSON.stringify(report.counts)}\n`)
      for (const error of report.schemaErrors) process.stdout.write(`schema: ${error}\n`)
      for (const result of report.results.filter((r) => r.status === STATUS.invalid)) {
        process.stdout.write(`${result.id}: ${result.reasons.join('; ')}\n`)
      }
      if (strict && report.schemaErrors.length === 0) {
        const open = REQUIRED_IDS.length - report.counts[STATUS.candidateCompatible]
        process.stdout.write(`strict: ${open} id(s) not candidate-compatible\n`)
      }
    }
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
