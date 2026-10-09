/*
 * Job outbound result policy (M15 #1217).
 *
 * Pure gate composition for one job's outbound result. Authority is the job's
 * original authorized actor, who must hold current owner or admin access to the
 * job's source workspace, and the job must be a completed Task. Group membership
 * is never source authority. Group membership only decides who the destination
 * audience is.
 *
 * The destination is one exact group channel in one destination workspace.
 * A recipient is released to only when they are a participant of that exact
 * channel, so a participation in some other group cannot stand in for it. An
 * artifact claim must pass the registration-backed artifact gates (#1207)
 * against current evidence, bound to the destination workspace as audience.
 *
 * Release is an audience-authorized projection. The released object is built
 * field by field from the authorized facts, never copied from the stored
 * record. A claimed artifact is included only when the destination is
 * authorized to retrieve it, and a result whose artifact is not authorized is
 * not released at all.
 *
 * No I/O. The service reads state through injected ports and persists nothing.
 * A hold or denial never cancels, reassigns or mutates the job.
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

/** Identifiers are bounded visible ASCII; the bound is checked by code point, not by pattern. */
const JOB_ID_MAX_LENGTH = 128

/** Work bound: the raw string is refused before normalization when it is far larger than the limit. */
const RAW_SUMMARY_MAX_UNITS = JOB_OUTBOUND_SUMMARY_MAX_BYTES * 4

/** The released object. Built only by `projectJobOutboundRelease`. */
export type SanitizedJobOutboundResult = Readonly<{
  /** The exact artifact locator, present only when the destination may retrieve it. */
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

/** The exact destination: one group channel in one destination workspace. */
export type JobOutboundDestination = Readonly<{ channelId: string; workspaceId: string }>

/**
 * A job as the source workspace records it: the owning workspace, the original
 * authorized actor and the completion instant. `completedAt` is null while the
 * Task has not completed, so the gate can name that state.
 */
export type JobOutboundJobSource = Readonly<{
  completedAt: string | null
  jobId: string
  originalActorUserId: string
  sourceWorkspaceId: string
}>

/** One principal's current role in one workspace; `workspaceLive` is false for a deleted workspace. */
export type JobOutboundAccess = Readonly<{
  role: 'owner' | 'admin' | 'member' | null
  workspaceLive: boolean
}>

/**
 * A recipient's standing in the exact channel the destination names. `channelId`
 * is the channel the read was bound to, so a standing read for another channel
 * can never be substituted into this decision.
 */
export type JobOutboundAudience = Readonly<{
  channelId: string | null
  channelIsGroup: boolean
  channelLive: boolean
  participant: boolean
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
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  destination: JobOutboundDestination
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

export type JobOutboundPublicationDecision =
  | Readonly<{
      action: 'publish'
      basis: 'source_owner_actor'
      destination: JobOutboundDestination
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
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  /** The destination recorded at publication; never taken from the request. */
  destination: JobOutboundDestination
  /** The recipient's standing in the destination channel, read at delivery. */
  recipientAudience: JobOutboundAudience | null
  /** The job as read at delivery. */
  job: JobOutboundJobSource | null
  jobId: string
  now: string
  /** The published record; it is re-sanitized before any byte is released. */
  published: unknown
  /** The original actor's current access to the job's source workspace. */
  sourceAccess: JobOutboundAccess | null
}>

export type JobOutboundDeliveryDenialGate = 'artifact' | 'audience' | 'job' | 'result' | 'source'

export type JobOutboundAudienceDenial =
  | 'destination_channel_mismatch'
  | 'destination_channel_unavailable'
  | 'destination_workspace_unavailable'
  | 'recipient_not_destination_participant'

export type JobOutboundDeliveryDenialReason =
  | ArtifactReferenceRefusalReason
  | JobOutboundAudienceDenial
  | JobOutboundResultRejection
  | 'job_not_completed'
  | 'job_source_mismatch'
  | 'job_unavailable'
  | 'source_access_lost'

export type JobOutboundDeliveryDecision =
  | Readonly<{
      action: 'deliver'
      destination: JobOutboundDestination
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

/** Visible ASCII, bounded in length; checked code point by code point. */
function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > JOB_ID_MAX_LENGTH)
    return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
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

/** Canonical line breaks: CRLF and lone CR become LF, read left to right in one pass. */
function canonicalLineBreaks(value: string): string {
  let text = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index)
    if (character !== '\r') {
      text += character
    } else {
      text += '\n'
      if (value.charAt(index + 1) === '\n') index += 1
    }
  }
  return text
}

function cleanSummary(value: string): string {
  const normalized = canonicalLineBreaks(value.normalize('NFC'))
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
 * Reads a published or submitted result into the only released shape. Unlisted
 * top-level fields are dropped; the artifact locator must be exact.
 */
export function sanitizeJobOutboundResult(value: unknown): JobOutboundSanitization {
  if (!isPlainObject(value)) return refused('result_malformed')
  const { artifact, jobId, summary } = value
  if (!isIdentifier(jobId)) return refused('result_malformed')
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

/**
 * Builds the released object from authorized facts only. The artifact field is
 * included only when `artifactAuthorized` is true, which the caller sets from
 * the retrieval gate. Nothing else from the stored record is carried over.
 */
export function projectJobOutboundRelease(
  result: SanitizedJobOutboundResult,
  artifactAuthorized: boolean
): SanitizedJobOutboundResult {
  return Object.freeze({
    artifact: artifactAuthorized ? result.artifact : null,
    jobId: result.jobId,
    summary: result.summary,
  })
}

function claimMatches(
  result: SanitizedJobOutboundResult,
  claimed: boolean
): JobOutboundResultRejection | null {
  return (result.artifact !== null) === claimed ? null : 'artifact_claim_mismatch'
}

/**
 * The original actor's source-workspace access is current when the workspace is
 * live and the actor is an owner or admin. Group membership never enters here.
 */
export function sourceAccessCurrent(access: JobOutboundAccess | null): boolean {
  return (
    access !== null && access.workspaceLive && (access.role === 'owner' || access.role === 'admin')
  )
}

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
 * Whether the recipient's standing is for the exact destination channel and is
 * in force. A standing read for any other channel is refused as a mismatch.
 */
function audienceDenial(
  audience: JobOutboundAudience | null,
  destination: JobOutboundDestination
): JobOutboundAudienceDenial | null {
  if (!audience) return 'destination_workspace_unavailable'
  if (audience.channelId !== destination.channelId) return 'destination_channel_mismatch'
  if (!audience.workspaceLive) return 'destination_workspace_unavailable'
  if (!audience.channelIsGroup || !audience.channelLive) return 'destination_channel_unavailable'
  if (!audience.participant) return 'recipient_not_destination_participant'
  return null
}

/**
 * Publication gate, in order: result, job identity and completion, the original
 * actor's source access, the destination (outbound only), and the artifact claim.
 * An artifact must be bound to the destination workspace as audience.
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

  const { destination } = input
  if (
    destination.channelId.trim().length === 0 ||
    destination.workspaceId.trim().length === 0 ||
    destination.workspaceId === input.job.sourceWorkspaceId
  )
    return hold('destination', 'destination_not_outbound')

  if (result.artifact !== null && input.artifact) {
    if (result.artifact.sourceWorkspaceId !== input.job.sourceWorkspaceId)
      return hold('job', 'job_source_mismatch')
    if (result.artifact.audienceWorkspaceId !== destination.workspaceId)
      return hold('artifact', 'audience_not_authorized')
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
    destination,
    jobId,
    result,
  }
}

/**
 * Delivery gate, in order: re-sanitize the published record, re-check the job,
 * the original actor's source access, the recipient's standing in the exact
 * destination channel, and — for an artifact — the retrieval gate with the
 * destination workspace as the requesting audience. The release is projected
 * from these facts only.
 */
export function decideJobOutboundDelivery(
  input: JobOutboundDeliveryInput
): JobOutboundDeliveryDecision {
  const { jobId, destination } = input
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

  const audience = audienceDenial(input.recipientAudience, destination)
  if (audience) return { action: 'deny', gate: 'audience', reason: audience }

  let artifactAuthorized = false
  if (result.artifact !== null && input.artifact) {
    if (result.artifact.sourceWorkspaceId !== input.job.sourceWorkspaceId)
      return { action: 'deny', gate: 'job', reason: 'job_source_mismatch' }
    const retrieval: ArtifactReferenceRetrievalDecision = authorizeArtifactReferenceRetrieval({
      authority: input.artifact.authority,
      evidence: input.artifact.evidence,
      grant: input.artifact.grant,
      grantState: input.artifact.grantState,
      now: input.now,
      requestingWorkspaceId: destination.workspaceId,
      target: result.artifact,
    })
    if (retrieval.action === 'deny')
      return { action: 'deny', gate: 'artifact', reason: retrieval.reason }
    artifactAuthorized = true
  }

  return {
    action: 'deliver',
    destination,
    jobId,
    result: projectJobOutboundRelease(result, artifactAuthorized),
  }
}
