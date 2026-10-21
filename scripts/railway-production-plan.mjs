// The plan for this repository's Railway production source.
//
// The plan answers one question: what is the production target right now, and
// is that answer good enough to act on? It answers it from two sources - the
// repository's own declaration in .railway/production-source.js and a live read
// of the deployment - and it refuses rather than guess.
//
// Nothing in this module runs a Railway command. The live read is injected by
// the caller as a command runner, so this file starts no process and reaches no
// network of its own. A plan without a runner is a refusal, never an empty
// plan, and the reads the plan needs are named here so that a caller knows
// exactly what it is being asked for.
//
// Every refusal carries a fixed code, one sentence that says what was refused
// and the evidence it was refused on. The evidence is hashed, so a receipt can
// name the refusal it saw without repeating the whole payload, and the same
// input always produces the same evidence.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The declaration this repository ships, relative to the repository root. */
export const PRODUCTION_SOURCE_PATH = '.railway/production-source.js'

/** The fixed codes a refusal carries. */
export const REFUSAL_CODES = Object.freeze({
  sourceUnreadable: 'RAILWAY_PRODUCTION_SOURCE_UNREADABLE',
  sourceInvalid: 'RAILWAY_PRODUCTION_SOURCE_INVALID',
  targetMissing: 'RAILWAY_PRODUCTION_TARGET_MISSING',
  targetAmbiguous: 'RAILWAY_PRODUCTION_TARGET_AMBIGUOUS',
  targetContradictory: 'RAILWAY_PRODUCTION_TARGET_CONTRADICTORY',
  metadataMissing: 'RAILWAY_PRODUCTION_METADATA_MISSING',
  metadataContradictory: 'RAILWAY_PRODUCTION_METADATA_CONTRADICTORY',
  historyMissing: 'RAILWAY_PRODUCTION_HISTORY_MISSING',
  historyUnhealthy: 'RAILWAY_PRODUCTION_HISTORY_UNHEALTHY',
  commandFailed: 'RAILWAY_PRODUCTION_COMMAND_FAILED',
  commandTimedOut: 'RAILWAY_PRODUCTION_COMMAND_TIMED_OUT',
  commandRunnerUnavailable: 'RAILWAY_PRODUCTION_COMMAND_RUNNER_UNAVAILABLE',
  readUnparsable: 'RAILWAY_PRODUCTION_READ_UNPARSABLE',
})

/** The live reads the plan needs, and the command each one describes. */
export const LIVE_READS = Object.freeze({
  status: Object.freeze({
    kind: 'status',
    command: Object.freeze(['railway', 'status', '--json']),
  }),
  deployments: Object.freeze({
    kind: 'deployments',
    command: Object.freeze(['railway', 'deployment', 'list', '--json']),
  }),
})

/** The timeout a command runner is asked to apply to one read. */
export const READ_TIMEOUT_MS = 30_000

/** The metadata fields a production deployment publishes when the declaration names none. */
export const REQUIRED_METADATA_FIELDS = Object.freeze([
  'release',
  'imageDigest',
  'region',
  'promotedAt',
])

/** The deployment statuses that describe a production deployment in service. */
export const HEALTHY_DEPLOYMENT_STATUSES = Object.freeze(['success', 'running', 'active'])

/** The repository root, derived from this file's own location. */
export function repositoryRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** A canonical JSON rendering: the same value always reads the same way. */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The digest of a refusal's evidence.
 *
 * The digest covers the code, the sentence and the evidence, so two refusals
 * with the same digest are the same refusal and a receipt can name it.
 */
export function refusalEvidenceDigest(record) {
  return createHash('sha256')
    .update(
      canonical({
        code: record.code,
        detail: record.detail,
        evidence: record.evidence,
      })
    )
    .digest('hex')
}

/** One refusal: what it was, why it was refused and the evidence for it. */
function refusal(code, detail, evidence) {
  const record = { code, detail, evidence }
  return { ...record, evidenceDigest: refusalEvidenceDigest(record) }
}

/**
 * Reads the repository's declaration of its production source.
 *
 * The declaration is the repository's own file, read as it is on disk. A
 * declaration that is missing, unreadable or not shaped as a declaration is
 * refused rather than repaired.
 */
export function readProductionSource(root = repositoryRoot()) {
  const file = resolve(root, PRODUCTION_SOURCE_PATH)
  let loaded
  try {
    loaded = createRequire(import.meta.url)(file)
  } catch {
    return {
      source: null,
      refusal: refusal(
        REFUSAL_CODES.sourceUnreadable,
        'the repository does not declare a Railway production source that can be read',
        { path: PRODUCTION_SOURCE_PATH }
      ),
    }
  }
  const source = loaded?.productionSource ?? loaded?.default?.productionSource
  const invalid = validateDeclaration(source)
  if (invalid) {
    return {
      source: null,
      refusal: refusal(
        REFUSAL_CODES.sourceInvalid,
        'the declared Railway production source is not shaped as a declaration',
        { path: PRODUCTION_SOURCE_PATH, ...invalid }
      ),
    }
  }
  return { source, refusal: null }
}

/** The field of a declaration that is not shaped as one, with the reason. */
function validateDeclaration(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { field: 'the declaration', reason: 'it is not an object' }
  }
  if (typeof source.environment !== 'string' || source.environment.length === 0) {
    return { field: 'environment', reason: 'it is not a non-empty string' }
  }
  if (!Array.isArray(source.targets)) {
    return { field: 'targets', reason: 'it is not an array' }
  }
  for (const target of source.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return { field: 'targets', reason: 'a candidate target is not an object' }
    }
    for (const key of ['project', 'service', 'environment']) {
      if (target[key] !== undefined && typeof target[key] !== 'string') {
        return { field: `targets.${key}`, reason: 'it is not a string' }
      }
    }
  }
  if (!Array.isArray(source.requiredMetadata)) {
    return { field: 'requiredMetadata', reason: 'it is not an array' }
  }
  if (
    source.pinnedMetadata !== undefined &&
    (!source.pinnedMetadata ||
      typeof source.pinnedMetadata !== 'object' ||
      Array.isArray(source.pinnedMetadata))
  ) {
    return { field: 'pinnedMetadata', reason: 'it is not an object' }
  }
  return null
}

/**
 * One live read, through the injected command runner.
 *
 * The runner is the only thing that can reach the deployment, so every way it
 * can fail - a non-zero exit, a timeout, a throw, a read that is not JSON -
 * is a refusal with its own code.
 */
function readLive(run, kind) {
  const request = {
    kind,
    command: LIVE_READS[kind].command,
    timeoutMs: READ_TIMEOUT_MS,
  }
  let result
  try {
    result = run(request)
  } catch {
    return {
      payload: null,
      refusal: refusal(REFUSAL_CODES.commandFailed, 'the live read did not return a result', {
        kind,
        command: [...request.command],
        reason: 'the runner threw',
      }),
    }
  }
  if (!result || typeof result !== 'object') {
    return {
      payload: null,
      refusal: refusal(REFUSAL_CODES.commandFailed, 'the live read did not return a result', {
        kind,
        command: [...request.command],
        reason: 'the runner returned no result',
      }),
    }
  }
  if (result.timedOut === true) {
    return {
      payload: null,
      refusal: refusal(REFUSAL_CODES.commandTimedOut, 'the live read timed out', {
        kind,
        command: [...request.command],
        timeoutMs: READ_TIMEOUT_MS,
      }),
    }
  }
  if (result.status !== 0) {
    return {
      payload: null,
      refusal: refusal(REFUSAL_CODES.commandFailed, 'the live read failed', {
        kind,
        command: [...request.command],
        exitStatus: typeof result.status === 'number' ? result.status : null,
      }),
    }
  }
  try {
    return { payload: JSON.parse(result.stdout ?? ''), refusal: null }
  } catch {
    return {
      payload: null,
      refusal: refusal(REFUSAL_CODES.readUnparsable, 'the live read did not parse as JSON', {
        kind,
        command: [...request.command],
        reason: 'the read is not JSON',
      }),
    }
  }
}

/** The candidate targets a live read named, or none when it named none. */
function observedTargets(payload) {
  const targets = payload?.targets
  return Array.isArray(targets)
    ? targets.filter((target) => target && typeof target === 'object')
    : []
}

/** The deployment metadata a live read published, or none when it published none. */
function observedDeployment(payload) {
  const deployment = payload?.deployment
  return deployment && typeof deployment === 'object' && !Array.isArray(deployment)
    ? deployment
    : {}
}

/** The deployment history a live read published, newest first. */
function observedHistory(payload) {
  const deployments = payload?.deployments
  return Array.isArray(deployments)
    ? deployments.filter((deployment) => deployment && typeof deployment === 'object')
    : []
}

/** The fields a declaration pins, and the values it pins them to. */
function pinnedFields(source, observed) {
  const pinned = []
  for (const [key, value] of Object.entries(source.pinnedMetadata ?? {})) {
    pinned.push({ field: key, expected: value, observed: observed?.[key] ?? null })
  }
  return pinned
}

/** The fields a declaration requires that the live read did not publish. */
function missingFields(source, observed) {
  const required =
    source.requiredMetadata.length > 0 ? source.requiredMetadata : REQUIRED_METADATA_FIELDS
  return required.filter((field) => {
    const value = observed?.[field]
    return typeof value !== 'string' || value.length === 0
  })
}

/**
 * The plan for the production source.
 *
 * The declaration is read from the repository when it is not supplied, the two
 * live reads are made through the injected runner, and the plan is the
 * agreement of the two. Any disagreement, omission or unhealthy state is a
 * refusal, and the plan refuses when it cannot read the deployment at all.
 */
export function planProductionDeployment({ source, root = repositoryRoot(), run } = {}) {
  const refusals = []
  let declaration = source
  if (!declaration) {
    const read = readProductionSource(root)
    declaration = read.source
    if (read.refusal) {
      refusals.push(read.refusal)
    }
  } else {
    const invalid = validateDeclaration(declaration)
    if (invalid) {
      refusals.push(
        refusal(
          REFUSAL_CODES.sourceInvalid,
          'the declared Railway production source is not shaped as a declaration',
          invalid
        )
      )
      return finish(null, null, null, null, refusals)
    }
  }

  if (!run) {
    refusals.push(
      refusal(
        REFUSAL_CODES.commandRunnerUnavailable,
        'no command runner was supplied, so no live read was made',
        { reads: Object.values(LIVE_READS).map((read) => [...read.command]) }
      )
    )
    return finish(declaration, null, null, null, refusals)
  }

  // The declaration's own candidates: none is a missing target and more than
  // one is an ambiguity, before any live read is attempted.
  if (declaration) {
    if (declaration.targets.length === 0) {
      refusals.push(
        refusal(REFUSAL_CODES.targetMissing, 'the declaration names no production target', {
          candidates: [],
        })
      )
    }
    if (declaration.targets.length > 1) {
      refusals.push(
        refusal(
          REFUSAL_CODES.targetAmbiguous,
          'the declaration names more than one production target',
          { candidates: declaration.targets }
        )
      )
    }
  }

  const status = readLive(run, 'status')
  if (status.refusal) {
    refusals.push(status.refusal)
    return finish(declaration, null, null, null, refusals)
  }

  const targets = observedTargets(status.payload)
  let target = null
  if (targets.length === 0) {
    refusals.push(
      refusal(REFUSAL_CODES.targetMissing, 'the live read named no production target', {
        candidates: [],
      })
    )
  }
  if (targets.length > 1) {
    refusals.push(
      refusal(
        REFUSAL_CODES.targetAmbiguous,
        'the live read named more than one production target',
        { candidates: targets }
      )
    )
  }
  if (targets.length === 1) {
    target = targets[0]
  }

  if (target && declaration) {
    const candidate = declaration.targets.length === 1 ? declaration.targets[0] : null
    if (candidate) {
      for (const key of ['project', 'service', 'environment']) {
        if (candidate[key] !== undefined && candidate[key] !== target[key]) {
          refusals.push(
            refusal(
              REFUSAL_CODES.targetContradictory,
              'the live target contradicts the declared production target',
              { field: key, expected: candidate[key], observed: target[key] ?? null }
            )
          )
        }
      }
    }
    if (declaration.environment && target.environment !== declaration.environment) {
      refusals.push(
        refusal(
          REFUSAL_CODES.targetContradictory,
          'the live target is not in the declared production environment',
          {
            field: 'environment',
            expected: declaration.environment,
            observed: target.environment ?? null,
          }
        )
      )
    }
  }

  const deployment = observedDeployment(status.payload)
  if (declaration) {
    for (const field of missingFields(declaration, deployment)) {
      refusals.push(
        refusal(
          REFUSAL_CODES.metadataMissing,
          'the live deployment did not publish the required metadata',
          { field, required: declaration.requiredMetadata }
        )
      )
    }
    for (const pinned of pinnedFields(declaration, deployment)) {
      if (pinned.expected !== pinned.observed) {
        refusals.push(
          refusal(
            REFUSAL_CODES.metadataContradictory,
            'the live deployment contradicts the pinned deployment metadata',
            { field: pinned.field, expected: pinned.expected, observed: pinned.observed }
          )
        )
      }
    }
  }

  const deployments = readLive(run, 'deployments')
  if (deployments.refusal) {
    refusals.push(deployments.refusal)
    return finish(declaration, target, deployment, null, refusals)
  }

  const history = observedHistory(deployments.payload)
  if (history.length === 0) {
    refusals.push(
      refusal(
        REFUSAL_CODES.historyMissing,
        'the deployment history is empty, so there is no production deployment to plan against',
        { deployments: [] }
      )
    )
  }
  const newest = history[0] ?? null
  if (newest && !HEALTHY_DEPLOYMENT_STATUSES.includes(newest.status)) {
    refusals.push(
      refusal(REFUSAL_CODES.historyUnhealthy, 'the newest deployment is not in service', {
        id: newest.id ?? null,
        status: newest.status ?? null,
        healthy: [...HEALTHY_DEPLOYMENT_STATUSES],
      })
    )
  }

  return finish(declaration, target, deployment, { newest, count: history.length }, refusals)
}

/** The finished plan: what was read, what was refused, and the verdict. */
function finish(source, target, deployment, history, refusals) {
  return {
    verdict: refusals.length === 0 ? 'planned' : 'refused',
    source: source ?? null,
    target: target ?? null,
    deployment: deployment ?? null,
    history: history ?? null,
    refusals,
  }
}
