/*
 * Job outbound result policy (M15 #1217).
 *
 * Pure gate composition over one job's publication. Authority is the job's
 * original authorized actor, who must hold current owner or admin access to the
 * source workspace, over a completed Task. Group membership is never source
 * authority. It only decides the destination audience.
 *
 * A publication is the channel message written atomically with its authorization
 * (see `job-outbound-binding`). Its system sender encodes the exact approved
 * facts: the job, the actor, the destination, the channel revision, the summary
 * hash, and the artifact and grant identity. Delivery accepts a message only when
 * it decodes to that binding and every fact still matches current state. An
 * ordinary message that merely names the job, or that the actor wrote, does not
 * qualify.
 *
 * No I/O. The service reads state through injected ports and persists nothing.
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
  decodeJobOutboundBinding,
  jobOutboundMessageKey,
  summarySha256,
  type JobOutboundBinding,
} from './job-outbound-binding'
import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
} from './artifact-reference-policy'

/** Summaries are refused above this size; they are never silently truncated. */
export const JOB_OUTBOUND_SUMMARY_MAX_BYTES = 8_192

/** Identifiers are bounded visible ASCII; checked code point by code point. */
const JOB_ID_MAX_LENGTH = 128

/** Work bound: the raw string is refused before normalization when it is far larger than the limit. */
const RAW_SUMMARY_MAX_UNITS = JOB_OUTBOUND_SUMMARY_MAX_BYTES * 4

/** The released object, built only by `projectJobOutboundRelease`. */
export type SanitizedJobOutboundResult = Readonly<{
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

/** A job as the source workspace records it. `completedAt` is null while the Task has not completed. */
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
 * A principal's standing in one exact channel, with the channel's current revision.
 * `channelVersion` is the channel's roster revision: any roster or channel change
 * advances it, so a publication bound to an older revision no longer matches.
 */
export type JobOutboundAudience = Readonly<{
  channelId: string | null
  channelIsGroup: boolean
  channelLive: boolean
  channelVersion: number | null
  /** The principal's current role in the destination workspace; null when not a member. */
  workspaceRole: 'owner' | 'admin' | 'member' | null
  participant: boolean
  workspaceLive: boolean
}>

/**
 * The canonical publication as read: the channel message, its linked artifact
 * (resolved from the artifact row, or null), and the link count. A link whose
 * artifact row cannot be resolved stays visible as `artifactLinkCount` 1 with a
 * null artifact, which the gate refuses.
 */
export type JobOutboundPublication = Readonly<{
  artifact: ArtifactReferenceTarget | null
  artifactLinkCount: number
  bodyText: string | null
  channelId: string
  deleted: boolean
  edited: boolean
  executionRef: string | null
  /** The idempotency key the message was written under. */
  idempotencyKey: string
  messageId: string
  senderKind: 'agent' | 'system' | 'user'
  senderSystemId: string | null
  workspaceId: string
}>

/** The authority an outbound artifact claims: the registration as presented, with its current facts. */
export type JobOutboundArtifactClaim = Readonly<{
  authority: ArtifactReferenceAuthority
  grant: ArtifactReferenceGrant | null
}>

export type JobOutboundArtifactCurrent = Readonly<{
  evidence: ArtifactReferenceEvidence | null
  grantState: ArtifactReferenceGrantState | null
}>

/**
 * `require`: an artifact the destination may not receive holds the whole publication.
 * `omit_unauthorized`: publish the summary without the artifact, and report why.
 */
export type JobOutboundArtifactPolicy = 'require' | 'omit_unauthorized'

export type JobOutboundPublicationInput = Readonly<{
  artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null
  /** The actor's standing in the destination channel; its revision is bound into the publication. */
  artifactPolicy: JobOutboundArtifactPolicy
  audience: JobOutboundAudience | null
  destination: JobOutboundDestination
  job: JobOutboundJobSource | null
  jobId: string
  now: string
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
  | 'destination_channel_mismatch'
  | 'destination_channel_unavailable'
  | 'destination_not_outbound'
  | 'destination_workspace_unavailable'
  | 'job_not_completed'
  | 'job_source_mismatch'
  | 'job_unavailable'
  | 'recipient_not_destination_member'
  | 'source_access_lost'

export type JobOutboundPublicationDecision =
  | Readonly<{
      action: 'publish'
      /** Why the artifact was omitted from a summary-only publication; null when none was omitted. */
      artifactOmitted: ArtifactReferenceRefusalReason | null
      binding: JobOutboundBinding
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
  job: JobOutboundJobSource | null
  jobId: string
  now: string
  /** The canonical publication as read inside the scope; null when it cannot be found. */
  publication: JobOutboundPublication | null
  recipientAudience: JobOutboundAudience | null
  sourceAccess: JobOutboundAccess | null
}>

export type JobOutboundDeliveryDenialGate =
  | 'artifact'
  | 'audience'
  | 'job'
  | 'publication'
  | 'result'
  | 'source'

export type JobOutboundPublicationDenialReason =
  | 'destination_channel_mismatch'
  | 'destination_not_outbound'
  | 'publication_actor_mismatch'
  | 'publication_altered'
  | 'publication_destination_mismatch'
  | 'publication_job_mismatch'
  | 'publication_unavailable'

export type JobOutboundAudienceDenial =
  | 'audience_revision_changed'
  | 'recipient_not_destination_member'
  | 'destination_channel_mismatch'
  | 'destination_channel_unavailable'
  | 'destination_workspace_unavailable'
  | 'recipient_not_destination_participant'

export type JobOutboundArtifactDenialReason =
  | 'artifact_binding_mismatch'
  | 'artifact_claim_mismatch'
  | 'artifact_unavailable'

export type JobOutboundDeliveryDenialReason =
  | ArtifactReferenceRefusalReason
  | JobOutboundArtifactDenialReason
  | JobOutboundAudienceDenial
  | JobOutboundPublicationDenialReason
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
      messageId: string
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
 * Reads a candidate result into the only released shape. Unlisted top-level
 * fields are dropped; the artifact locator must be exact.
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
 * included only when `artifactAuthorized` is true.
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

/** Whether the original actor's source access is current: a live workspace and an owner or admin. */
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
type DestinationDenial =
  | 'destination_channel_mismatch'
  | 'destination_channel_unavailable'
  | 'destination_workspace_unavailable'
  | 'recipient_not_destination_member'

/**
 * The destination check shared by publish and delivery. The principal must be a
 * current member of the destination workspace, and the channel must be the exact
 * one named: a live group channel in a live workspace with a known revision. A
 * membership removal leaves no role, so it denies here.
 */
function destinationDenial(
  audience: JobOutboundAudience | null,
  channelId: string
): DestinationDenial | null {
  if (!audience || !audience.workspaceLive) return 'destination_workspace_unavailable'
  if (audience.workspaceRole === null) return 'recipient_not_destination_member'
  if (audience.channelId !== channelId) return 'destination_channel_mismatch'
  if (!audience.channelIsGroup || !audience.channelLive) return 'destination_channel_unavailable'
  if (audience.channelVersion === null) return 'destination_channel_unavailable'
  return null
}

/**
 * The artifact refusal for a publication, or null when the destination may receive
 * it. A claim with no grant is malformed; a target for another audience is refused;
 * otherwise the publication gate decides against current evidence and registration.
 */
function artifactPublicationRefusal(
  input: JobOutboundPublicationInput,
  target: ArtifactReferenceTarget,
  audienceWorkspaceId: string
): ArtifactReferenceRefusalReason | null {
  const claim = input.artifact
  if (!claim?.grant) return 'grant_malformed'
  if (target.audienceWorkspaceId !== audienceWorkspaceId) return 'audience_not_authorized'
  const decision: ArtifactReferencePublicationDecision = authorizeArtifactReferencePublication({
    authority: claim.authority,
    evidence: claim.evidence,
    grant: claim.grant,
    grantState: claim.grantState,
    now: input.now,
    target,
  })
  return decision.action === 'hold' ? decision.reason : null
}

/**
 * Publication gate, in order: result, job identity and completion, the original
 * actor's source access, the destination (outbound, exact, and the actor a current
 * member), and the artifact. An artifact refusal holds the publication, unless the
 * caller allowed omission: then the summary publishes without the artifact, the
 * binding and link carry no artifact identity, and the reason is reported.
 * Claim-level inconsistencies are never omitted; they are client errors.
 */
export function decideJobOutboundPublication(
  input: JobOutboundPublicationInput
): JobOutboundPublicationDecision {
  const { jobId, destination } = input
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
  if ((result.artifact !== null) !== (input.artifact !== null))
    return hold('result', 'artifact_claim_mismatch')

  const jobReason = jobDenial(input.job, jobId, input.now)
  if (jobReason || !input.job) return hold('job', jobReason ?? 'job_unavailable')
  if (!sourceAccessCurrent(input.sourceAccess)) return hold('source', 'source_access_lost')

  if (
    destination.channelId.trim().length === 0 ||
    destination.workspaceId.trim().length === 0 ||
    destination.workspaceId === input.job.sourceWorkspaceId
  )
    return hold('destination', 'destination_not_outbound')
  const audience = input.audience
  const audienceReason = destinationDenial(audience, destination.channelId)
  if (audienceReason || !audience || audience.channelVersion === null)
    return hold('destination', audienceReason ?? 'destination_channel_unavailable')

  let keptArtifact: ArtifactReferenceTarget | null = null
  let grant: ArtifactReferenceGrant | null = null
  let artifactOmitted: ArtifactReferenceRefusalReason | null = null
  if (result.artifact !== null) {
    if (result.artifact.sourceWorkspaceId !== input.job.sourceWorkspaceId)
      return hold('job', 'job_source_mismatch')
    const refusal = artifactPublicationRefusal(input, result.artifact, destination.workspaceId)
    if (refusal === null) {
      keptArtifact = result.artifact
      grant = input.artifact?.grant ?? null
    } else if (input.artifactPolicy === 'omit_unauthorized') {
      artifactOmitted = refusal
    } else {
      return hold('artifact', refusal)
    }
  }

  const published = projectJobOutboundRelease(result, keptArtifact !== null)
  const binding: JobOutboundBinding = {
    actorUserId: input.job.originalActorUserId,
    artifact:
      keptArtifact === null || grant === null
        ? null
        : {
            artifactId: keptArtifact.artifactId,
            checksumSha256: keptArtifact.checksumSha256,
            sourceWorkspaceId: keptArtifact.sourceWorkspaceId,
            version: keptArtifact.version,
          },
    channelId: destination.channelId,
    channelVersion: audience.channelVersion,
    grant: grant === null ? null : { grantId: grant.grantId, revision: grant.revision },
    jobId,
    summarySha256: summarySha256(published.summary),
    workspaceId: destination.workspaceId,
  }
  return { action: 'publish', artifactOmitted, binding, destination, jobId, result: published }
}

/**
 * Delivery gate, in order: the canonical publication decodes to a binding and its
 * idempotency key is the one that binding derives, so the approval is anchored to
 * the message itself; the publication is unaltered and matches its job, actor and
 * destination; the job and actor's source access are current; the recipient is a
 * current member and participant of the exact channel at the bound revision; and
 * any artifact link and row match the binding and pass the retrieval gate. The
 * released text is the approved body.
 */
export function decideJobOutboundDelivery(
  input: JobOutboundDeliveryInput
): JobOutboundDeliveryDecision {
  const { jobId, publication } = input
  if (!publication)
    return { action: 'deny', gate: 'publication', reason: 'publication_unavailable' }
  const binding = decodeJobOutboundBinding(
    publication.senderKind === 'system' ? publication.senderSystemId : null
  )
  if (!binding) return { action: 'deny', gate: 'publication', reason: 'publication_unavailable' }

  const job = input.job
  const jobReason = jobDenial(job, jobId, input.now)
  if (jobReason || !job)
    return { action: 'deny', gate: 'job', reason: jobReason ?? 'job_unavailable' }

  if (publication.deleted || publication.edited)
    return { action: 'deny', gate: 'publication', reason: 'publication_altered' }
  if (publication.idempotencyKey !== jobOutboundMessageKey(binding))
    return { action: 'deny', gate: 'publication', reason: 'publication_altered' }
  if (publication.workspaceId === job.sourceWorkspaceId)
    return { action: 'deny', gate: 'publication', reason: 'destination_not_outbound' }
  if (binding.jobId !== jobId || publication.executionRef !== jobId)
    return { action: 'deny', gate: 'publication', reason: 'publication_job_mismatch' }
  if (binding.actorUserId !== job.originalActorUserId)
    return { action: 'deny', gate: 'publication', reason: 'publication_actor_mismatch' }
  if (
    binding.workspaceId !== publication.workspaceId ||
    binding.channelId !== publication.channelId
  )
    return { action: 'deny', gate: 'publication', reason: 'publication_destination_mismatch' }
  if (binding.summarySha256 !== summarySha256(publication.bodyText ?? ''))
    return { action: 'deny', gate: 'publication', reason: 'publication_altered' }

  if (!sourceAccessCurrent(input.sourceAccess))
    return { action: 'deny', gate: 'source', reason: 'source_access_lost' }

  const audience = input.recipientAudience
  const audienceReason = destinationDenial(audience, publication.channelId)
  if (audienceReason) return { action: 'deny', gate: 'audience', reason: audienceReason }
  if (!audience?.participant)
    return { action: 'deny', gate: 'audience', reason: 'recipient_not_destination_participant' }
  if (audience.channelVersion !== binding.channelVersion)
    return { action: 'deny', gate: 'audience', reason: 'audience_revision_changed' }

  // Attachments: the link count, the row and the binding must agree exactly.
  if (publication.artifactLinkCount > 1)
    return { action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' }
  if (binding.artifact === null) {
    if (publication.artifactLinkCount !== 0 || input.artifact !== null)
      return { action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' }
    const sanitized = sanitizeJobOutboundResult({ jobId, summary: publication.bodyText ?? '' })
    if (!sanitized.ok) return { action: 'deny', gate: 'result', reason: sanitized.reason }
    return {
      action: 'deliver',
      destination: { channelId: publication.channelId, workspaceId: publication.workspaceId },
      jobId,
      messageId: publication.messageId,
      result: projectJobOutboundRelease(sanitized.result, false),
    }
  }

  // An artifact binding needs its link and its row. A link whose row is gone fails closed.
  if (publication.artifactLinkCount !== 1 || publication.artifact === null)
    return { action: 'deny', gate: 'artifact', reason: 'artifact_unavailable' }
  const row = publication.artifact
  if (
    row.artifactId !== binding.artifact.artifactId ||
    row.sourceWorkspaceId !== binding.artifact.sourceWorkspaceId ||
    row.version !== binding.artifact.version ||
    row.checksumSha256 !== binding.artifact.checksumSha256
  )
    return { action: 'deny', gate: 'artifact', reason: 'artifact_binding_mismatch' }
  if (row.sourceWorkspaceId !== job.sourceWorkspaceId)
    return { action: 'deny', gate: 'job', reason: 'job_source_mismatch' }
  const claim = input.artifact
  if (!claim) return { action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' }
  if (
    !binding.grant ||
    claim.grant?.grantId !== binding.grant.grantId ||
    claim.grant.revision !== binding.grant.revision
  )
    return { action: 'deny', gate: 'artifact', reason: 'artifact_binding_mismatch' }

  const sanitized = sanitizeJobOutboundResult({
    artifact: row,
    jobId,
    summary: publication.bodyText ?? '',
  })
  if (!sanitized.ok) return { action: 'deny', gate: 'result', reason: sanitized.reason }
  const retrieval: ArtifactReferenceRetrievalDecision = authorizeArtifactReferenceRetrieval({
    authority: claim.authority,
    evidence: claim.evidence,
    grant: claim.grant,
    grantState: claim.grantState,
    now: input.now,
    requestingWorkspaceId: publication.workspaceId,
    target: sanitized.result.artifact!,
  })
  if (retrieval.action === 'deny')
    return { action: 'deny', gate: 'artifact', reason: retrieval.reason }

  return {
    action: 'deliver',
    destination: { channelId: publication.channelId, workspaceId: publication.workspaceId },
    jobId,
    messageId: publication.messageId,
    result: projectJobOutboundRelease(sanitized.result, true),
  }
}
