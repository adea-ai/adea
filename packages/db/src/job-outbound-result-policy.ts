/*
 * Job outbound result policy (M15 #1217).
 *
 * Pure sanitization and gate composition for one job's outbound result. A job
 * keeps its own lifecycle and owner: publication is authorized by the
 * publisher's binding to the job (`decideGroupPublication`) and, when the
 * result carries an artifact reference, by the exact artifact gate
 * (`authorizeArtifactReferencePublication`). Delivery re-decides every consumed
 * authority against CURRENT state supplied by the caller — the recipient's
 * group admission and, for an artifact, the current evidence and registered
 * grant, bound to the recipient's workspace. Nothing is carried over from
 * publication except the sanitized result and the claim it was published with.
 *
 * Outbound payloads are built by allowlist: only `jobId`, a bounded and
 * cleaned `summary`, and an exact artifact locator leave this module. Runtime
 * fields such as filenames, locations, provenance, task or node identifiers
 * are never copied, so they cannot reach a recipient by construction.
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
  type ConversationParticipantRef,
  type GroupAdmission,
  type GroupCompletedJob,
  type GroupPublicationHoldReason,
} from '@adea-ai/types'

import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
} from './artifact-reference-policy'
import { decideGroupPublication, evaluateGroupGrantWindow } from './group-participation-policy'

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
  /** The publisher's current admission to the job's group, or null when none exists. */
  admission: GroupAdmission | null
  /** Present exactly when the result carries an artifact reference. */
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  job: GroupCompletedJob
  now: string
  publisher: ConversationParticipantRef
  result: unknown
}>

/**
 * Publication decisions. Every hold keeps the result out of the group while the
 * job continues unaffected; `gate` names the first check that failed.
 */
export type JobOutboundPublicationDecision =
  | Readonly<{
      action: 'publish'
      basis: 'participant_authorized'
      jobId: string
      result: SanitizedJobOutboundResult
    }>
  | Readonly<{
      action: 'hold'
      gate: 'result'
      jobId: string
      producerEffect: 'unaffected'
      reason: JobOutboundResultRejection
    }>
  | Readonly<{
      action: 'hold'
      gate: 'group'
      jobId: string
      producerEffect: 'unaffected'
      reason: GroupPublicationHoldReason
    }>
  | Readonly<{
      action: 'hold'
      gate: 'artifact'
      jobId: string
      producerEffect: 'unaffected'
      reason: ArtifactReferenceRefusalReason
    }>

export type JobOutboundRecipient = Readonly<{
  groupId: string
  participant: ConversationParticipantRef
  /** The workspace the recipient's membership was resolved in; it is the retrieval audience. */
  workspaceId: string
}>

export type JobOutboundDeliveryInput = Readonly<{
  /** The recipient's CURRENT admission, re-read by the caller at delivery. */
  admission: GroupAdmission | null
  /** The claim the result was published with, with current artifact facts; null when none. */
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  now: string
  /** The published record; it is sanitized again before any byte is released. */
  published: unknown
  recipient: JobOutboundRecipient
}>

export type JobOutboundAudienceDenial =
  | 'recipient_binding_invalid'
  | 'recipient_not_admitted'
  | 'recipient_participation_revoked'
  | 'recipient_participation_stale'

export type JobOutboundDeliveryDecision =
  | Readonly<{ action: 'deliver'; result: SanitizedJobOutboundResult }>
  | Readonly<{ action: 'deny'; gate: 'result'; reason: JobOutboundResultRejection }>
  | Readonly<{ action: 'deny'; gate: 'audience'; reason: JobOutboundAudienceDenial }>
  | Readonly<{ action: 'deny'; gate: 'artifact'; reason: ArtifactReferenceRefusalReason }>

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

function sameParticipant(left: ConversationParticipantRef, right: ConversationParticipantRef) {
  if (left.kind === 'user' && right.kind === 'user') return left.userId === right.userId
  if (left.kind === 'agent' && right.kind === 'agent') return left.agentId === right.agentId
  return false
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
 * Publication gate for one completed job's result, evaluated in a fixed order:
 * sanitization, job identity, claim agreement, the job's group binding and
 * publisher authority, then the artifact reference when one is claimed.
 */
export function decideJobOutboundPublication(
  input: JobOutboundPublicationInput
): JobOutboundPublicationDecision {
  const { job } = input
  const sanitized = sanitizeJobOutboundResult(input.result)
  if (!sanitized.ok)
    return {
      action: 'hold',
      gate: 'result',
      jobId: job.jobId,
      producerEffect: 'unaffected',
      reason: sanitized.reason,
    }
  const { result } = sanitized
  if (result.jobId !== job.jobId)
    return {
      action: 'hold',
      gate: 'result',
      jobId: job.jobId,
      producerEffect: 'unaffected',
      reason: 'result_job_mismatch',
    }
  const claimReason = claimMatches(result, input.artifact !== null)
  if (claimReason)
    return {
      action: 'hold',
      gate: 'result',
      jobId: job.jobId,
      producerEffect: 'unaffected',
      reason: claimReason,
    }

  const group = decideGroupPublication({
    admission: input.admission,
    job,
    now: input.now,
    publisher: input.publisher,
  })
  if (group.action === 'hold')
    return {
      action: 'hold',
      gate: 'group',
      jobId: job.jobId,
      producerEffect: 'unaffected',
      reason: group.reason,
    }

  if (result.artifact !== null && input.artifact) {
    const artifact: ArtifactReferencePublicationDecision = authorizeArtifactReferencePublication({
      authority: input.artifact.authority,
      evidence: input.artifact.evidence,
      grant: input.artifact.grant,
      grantState: input.artifact.grantState,
      now: input.now,
      target: result.artifact,
    })
    if (artifact.action === 'hold')
      return {
        action: 'hold',
        gate: 'artifact',
        jobId: job.jobId,
        producerEffect: 'unaffected',
        reason: artifact.reason,
      }
  }

  return { action: 'publish', basis: 'participant_authorized', jobId: job.jobId, result }
}

/**
 * Whether the recipient's admission is in force at `now` for the group being
 * delivered to. Identity is checked first, as group admission does: the binding
 * must name this group and a positive revision, and the admission must belong
 * to this recipient. Revocation and stale windows deny; no fallback is inferred.
 */
function recipientAdmissionDenial(
  admission: GroupAdmission | null,
  recipient: JobOutboundRecipient,
  now: string
): JobOutboundAudienceDenial | null {
  if (!admission || !sameParticipant(admission.participant, recipient.participant))
    return 'recipient_not_admitted'
  const { authorization } = admission
  if (
    authorization.groupId !== recipient.groupId ||
    authorization.grantId.trim().length === 0 ||
    !Number.isSafeInteger(authorization.revision) ||
    authorization.revision < 1
  )
    return 'recipient_binding_invalid'
  const state = evaluateGroupGrantWindow(admission.grant, now)
  if (state === 'revoked') return 'recipient_participation_revoked'
  if (state !== 'effective') return 'recipient_participation_stale'
  return null
}

/**
 * Delivery gate for one recipient. Re-sanitizes the published record, re-checks
 * the recipient's current group admission, then — for an artifact — runs the
 * exact retrieval gate against the current evidence and registered grant with
 * the recipient's workspace as the requesting audience.
 */
export function decideJobOutboundDelivery(
  input: JobOutboundDeliveryInput
): JobOutboundDeliveryDecision {
  const sanitized = sanitizeJobOutboundResult(input.published)
  if (!sanitized.ok) return { action: 'deny', gate: 'result', reason: sanitized.reason }
  const { result } = sanitized
  const claimReason = claimMatches(result, input.artifact !== null)
  if (claimReason) return { action: 'deny', gate: 'result', reason: claimReason }

  const audience = recipientAdmissionDenial(input.admission, input.recipient, input.now)
  if (audience) return { action: 'deny', gate: 'audience', reason: audience }

  if (result.artifact !== null && input.artifact) {
    const retrieval: ArtifactReferenceRetrievalDecision = authorizeArtifactReferenceRetrieval({
      authority: input.artifact.authority,
      evidence: input.artifact.evidence,
      grant: input.artifact.grant,
      grantState: input.artifact.grantState,
      now: input.now,
      requestingWorkspaceId: input.recipient.workspaceId,
      target: result.artifact,
    })
    if (retrieval.action === 'deny')
      return { action: 'deny', gate: 'artifact', reason: retrieval.reason }
  }

  return { action: 'deliver', result }
}
