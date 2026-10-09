/*
 * Job outbound result policy (M15 #1217).
 *
 * Pure sanitization and gate composition for one job's outbound result.
 * Authority is the job's source-workspace owner or admin acting through the
 * original authorized actor that admitted the job. Group participation is not
 * authority. Publication and every delivery re-check that actor's current
 * source-workspace access, and each delivery also re-checks the recipient's
 * current membership in the exact destination workspace. An artifact claim
 * must pass the artifact reference gates against current evidence and the
 * registered grant (#1207), bound to the destination audience.
 *
 * Outbound payloads are built by allowlist: only `jobId`, a bounded and
 * cleaned `summary`, and an exact artifact locator leave this module. Runtime
 * fields such as filenames, locations, provenance, task or node identifiers
 * are never copied, so they cannot reach a destination by construction.
 *
 * No I/O: the service module reads current state through injected ports and
 * persists nothing. A hold or denial never cancels, reassigns or mutates the
 * job, and every refusal carries only a typed reason.
 */
import {
  isArtifactReferenceTarget,
  type ArtifactReferenceAuthority,
  type ArtifactReferenceEvidence,
  type ArtifactReferenceGrant,
  type ArtifactReferenceGrantState,
  type ArtifactReferencePublicationDecision,
  type ArtifactReferenceRefusalReason,
  type ArtifactReferenceRetrievalDecision,
  type ArtifactReferenceTarget,
} from '@adea-ai/types'

import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
} from './artifact-reference-policy'

/** Summaries are refused above this size; they are never silently truncated. */
export const JOB_OUTBOUND_SUMMARY_MAX_BYTES = 8_192

const JOB_ID_PATTERN = /^[\x21-\x7e]{1,128}$/u

/** Work bound: the raw string is refused before normalization when it is far larger than the limit. */
const RAW_SUMMARY_MAX_UNITS = JOB_OUTBOUND_SUMMARY_MAX_BYTES * 4

export type SanitizedJobOutboundResult = Readonly<{
  /** The exact artifact locator the result references, or null when it carries none. */
  artifact: ArtifactReferenceTarget | null
  jobId: string
  summary: string
}>

export type JobOutboundResultRejection =
  | 'artifact_claim_mismatch'
  | 'artifact_reference_malformed'
  | 'result_job_mismatch'
  | 'result_malformed'
  | 'result_too_large'

export type JobOutboundSanitization =
  | Readonly<{ ok: true; result: SanitizedJobOutboundResult }>
  | Readonly<{ ok: false; reason: JobOutboundResultRejection }>

/**
 * A completed job as the source workspace records it: the workspace that owns
 * it and the original authorized actor who admitted it. `completedAt` is null
 * while the job has not completed, so the gate can name that state.
 */
export type JobOutboundJobSource = Readonly<{
  completedAt: string | null
  jobId: string
  originalActorUserId: string
  sourceWorkspaceId: string
}>

/**
 * One principal's current access to one workspace, read at decision time.
 * `role` is null when there is no membership; `workspaceLive` is false for a
 * deleted or missing workspace.
 */
export type JobOutboundAccess = Readonly<{
  role: 'owner' | 'admin' | 'member' | null
  workspaceLive: boolean
}>

/** The authority an outbound artifact claims, as the producer presented it. */
export type JobOutboundArtifactClaim = Readonly<{
  authority: ArtifactReferenceAuthority
  grant: ArtifactReferenceGrant | null
}>

/** Current artifact facts, read by the caller at decision time. */
export type JobOutboundArtifactCurrent = Readonly<{
  evidence: ArtifactReferenceEvidence | null
  grantState: ArtifactReferenceGrantState | null
}>

export type JobOutboundPublicationInput = Readonly<{
  /** Present exactly when the result carries an artifact reference. */
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  destinationWorkspaceId: string
  /** The job as read now; null when it cannot be found or proven. */
  job: JobOutboundJobSource | null
  jobId: string
  now: string
  /** The original actor's current access to the job's source workspace; null when unreadable. */
  sourceAccess: JobOutboundAccess | null
  result: unknown
}>

export type JobOutboundPublicationHoldGate =
  | 'artifact'
  | 'destination'
  | 'job'
  | 'result'
  | 'source'

export type JobOutboundPublicationHoldReason =
  | ArtifactReferenceRefusalReason
  | JobOutboundResultRejection
  | 'destination_not_outbound'
  | 'job_not_completed'
  | 'job_source_mismatch'
  | 'job_unavailable'
  | 'source_access_lost'

/**
 * Publication decisions. Every hold keeps the result out of the destination
 * while the job continues unaffected; `gate` names the first check that failed.
 */
export type JobOutboundPublicationDecision =
  | Readonly<{
      action: 'publish'
      basis: 'source_owner_actor'
      destinationWorkspaceId: string
      jobId: string
      result: SanitizedJobOutboundResult
    }>
  | Readonly<{
      action: 'hold'
      gate: JobOutboundPublicationHoldGate
      jobId: string
      producerEffect: 'unaffected'
      reason: JobOutboundPublicationHoldReason
    }>

export type JobOutboundDeliveryInput = Readonly<{
  /** The artifact claim the result was published with, with current facts; null when none. */
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  /** The destination recorded at publication. It is never taken from the request. */
  destinationWorkspaceId: string
  /** The job as read now at delivery. */
  job: JobOutboundJobSource | null
  jobId: string
  now: string
  /** The published record; it is sanitized again before any byte is released. */
  published: unknown
  /** The recipient's current access to the destination workspace; null when unreadable. */
  recipientAccess: JobOutboundAccess | null
  /** The original actor's current access to the job's source workspace; null when unreadable. */
  sourceAccess: JobOutboundAccess | null
}>

export type JobOutboundDeliveryDenialGate = 'artifact' | 'audience' | 'job' | 'result' | 'source'

export type JobOutboundDeliveryDenialReason =
  | ArtifactReferenceRefusalReason
  | JobOutboundResultRejection
  | 'job_not_completed'
  | 'job_source_mismatch'
  | 'job_unavailable'
  | 'recipient_not_destination_member'
  | 'destination_workspace_unavailable'
  | 'source_access_lost'

export type JobOutboundDeliveryDecision =
  | Readonly<{
      action: 'deliver'
      destinationWorkspaceId: string
      jobId: string
      result: SanitizedJobOutboundResult
    }>
  | Readonly<{
      action: 'deny'
      gate: JobOutboundDeliveryDenialGate
      reason: JobOutboundDeliveryDenialReason
    }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Controls except tab and newline, bidi embeddings/overrides/isolates, zero-width marks and BOM. */
function isUnsafeSummaryCharacter(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  )
}

function cleanSummary(value: string): string {
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n')
  let text = ''
  for (const character of normalized) {
    if (!isUnsafeSummaryCharacter(character.codePointAt(0) ?? 0)) text += character
  }
  return text.trim()
}

function refused(reason: JobOutboundResultRejection): JobOutboundSanitization {
  return { ok: false, reason }
}

/**
 * Builds the only outbound result shape. Unlisted top-level fields are dropped;
 * the artifact locator must be exact because the artifact gates require it.
 */
export function sanitizeJobOutboundResult(value: unknown): JobOutboundSanitization {
  if (!isPlainObject(value)) return refused('result_malformed')
  const { artifact, jobId, summary } = value
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return refused('result_malformed')
  if (typeof summary !== 'string') return refused('result_malformed')
  if (summary.length > RAW_SUMMARY_MAX_UNITS) return refused('result_too_large')
  const text = cleanSummary(summary)
  if (text.length === 0) return refused('result_malformed')
  if (new TextEncoder().encode(text).byteLength > JOB_OUTBOUND_SUMMARY_MAX_BYTES)
    return refused('result_too_large')
  let target: ArtifactReferenceTarget | null = null
  if (artifact !== undefined && artifact !== null) {
    if (!isArtifactReferenceTarget(artifact)) return refused('artifact_reference_malformed')
    target = Object.freeze({
      artifactId: artifact.artifactId,
      audienceWorkspaceId: artifact.audienceWorkspaceId,
      checksumSha256: artifact.checksumSha256,
      sourceWorkspaceId: artifact.sourceWorkspaceId,
      version: artifact.version,
    })
  }
  return { ok: true, result: Object.freeze({ artifact: target, jobId, summary: text }) }
}

/** The result's artifact presence must agree with the claim it is published or delivered under. */
function claimMatches(
  result: SanitizedJobOutboundResult,
  claimed: boolean
): JobOutboundResultRejection | null {
  return (result.artifact !== null) === claimed ? null : 'artifact_claim_mismatch'
}

/**
 * Whether the original actor's source-workspace access is current: a live
 * workspace and an owner or admin membership. Anything else is lost access.
 */
export function sourceAccessCurrent(access: JobOutboundAccess | null): boolean {
  return (
    access !== null && access.workspaceLive && (access.role === 'owner' || access.role === 'admin')
  )
}

/** Whether a completed job is still in force at `now` for its source workspace. */
function jobDenial(
  job: JobOutboundJobSource | null,
  jobId: string,
  now: string
): 'job_not_completed' | 'job_unavailable' | null {
  if (!job || job.jobId !== jobId) return 'job_unavailable'
  if (job.completedAt === null) return 'job_not_completed'
  const completed = Date.parse(job.completedAt)
  const current = Date.parse(now)
  if (!Number.isFinite(completed) || !Number.isFinite(current) || completed > current)
    return 'job_not_completed'
  return null
}

/**
 * Publication gate for one job's result, evaluated in a fixed order: result
 * sanitization, job identity and completion, the original actor's current
 * source-workspace access, the destination (cross-workspace only), and finally
 * the artifact reference against current evidence and its registered grant.
 */
export function decideJobOutboundPublication(
  input: JobOutboundPublicationInput
): JobOutboundPublicationDecision {
  const { jobId } = input
  const hold = (
    gate: JobOutboundPublicationHoldGate,
    reason: JobOutboundPublicationHoldReason
  ): JobOutboundPublicationDecision => ({
    action: 'hold',
    gate,
    jobId,
    producerEffect: 'unaffected',
    reason,
  })

  const sanitized = sanitizeJobOutboundResult(input.result)
  if (!sanitized.ok) return hold('result', sanitized.reason)
  const { result } = sanitized
  if (result.jobId !== jobId) return hold('result', 'result_job_mismatch')
  const claimReason = claimMatches(result, input.artifact !== null)
  if (claimReason) return hold('result', claimReason)

  const jobReason = jobDenial(input.job, jobId, input.now)
  if (jobReason || !input.job) return hold('job', jobReason ?? 'job_unavailable')

  if (!sourceAccessCurrent(input.sourceAccess)) return hold('source', 'source_access_lost')

  if (
    input.destinationWorkspaceId.trim().length === 0 ||
    input.destinationWorkspaceId === input.job.sourceWorkspaceId
  )
    return hold('destination', 'destination_not_outbound')

  if (result.artifact !== null && input.artifact) {
    if (result.artifact.sourceWorkspaceId !== input.job.sourceWorkspaceId)
      return hold('job', 'job_source_mismatch')
    const artifact: ArtifactReferencePublicationDecision = authorizeArtifactReferencePublication({
      authority: input.artifact.authority,
      evidence: input.artifact.evidence,
      grant: input.artifact.grant,
      grantState: input.artifact.grantState,
      now: input.now,
      target: result.artifact,
    })
    if (artifact.action === 'hold') return hold('artifact', artifact.reason)
  }

  return {
    action: 'publish',
    basis: 'source_owner_actor',
    destinationWorkspaceId: input.destinationWorkspaceId,
    jobId,
    result,
  }
}

/**
 * Delivery gate for one destination recipient. Re-sanitizes the published
 * record, re-checks the job, re-checks the original actor's current
 * source-workspace access, then checks the recipient's current membership in
 * the exact destination workspace. For an artifact it runs the retrieval gate
 * against current evidence and the registered grant, with the destination as
 * the requesting audience.
 */
export function decideJobOutboundDelivery(
  input: JobOutboundDeliveryInput
): JobOutboundDeliveryDecision {
  const { jobId } = input
  const sanitized = sanitizeJobOutboundResult(input.published)
  if (!sanitized.ok) return { action: 'deny', gate: 'result', reason: sanitized.reason }
  const { result } = sanitized
  if (result.jobId !== jobId)
    return { action: 'deny', gate: 'result', reason: 'result_job_mismatch' }
  const claimReason = claimMatches(result, input.artifact !== null)
  if (claimReason) return { action: 'deny', gate: 'result', reason: claimReason }

  const jobReason = jobDenial(input.job, jobId, input.now)
  if (jobReason || !input.job)
    return { action: 'deny', gate: 'job', reason: jobReason ?? 'job_unavailable' }

  if (!sourceAccessCurrent(input.sourceAccess))
    return { action: 'deny', gate: 'source', reason: 'source_access_lost' }

  const recipient = input.recipientAccess
  if (!recipient || !recipient.workspaceLive)
    return { action: 'deny', gate: 'audience', reason: 'destination_workspace_unavailable' }
  if (recipient.role === null)
    return { action: 'deny', gate: 'audience', reason: 'recipient_not_destination_member' }

  if (result.artifact !== null && input.artifact) {
    if (result.artifact.sourceWorkspaceId !== input.job.sourceWorkspaceId)
      return { action: 'deny', gate: 'job', reason: 'job_source_mismatch' }
    const retrieval: ArtifactReferenceRetrievalDecision = authorizeArtifactReferenceRetrieval({
      authority: input.artifact.authority,
      evidence: input.artifact.evidence,
      grant: input.artifact.grant,
      grantState: input.artifact.grantState,
      now: input.now,
      requestingWorkspaceId: input.destinationWorkspaceId,
      target: result.artifact,
    })
    if (retrieval.action === 'deny')
      return { action: 'deny', gate: 'artifact', reason: retrieval.reason }
  }

  return { action: 'deliver', destinationWorkspaceId: input.destinationWorkspaceId, jobId, result }
}
