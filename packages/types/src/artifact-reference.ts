/**
 * Pure artifact-reference coordination types for M15.03 (#1180).
 *
 * A cross-workspace plan may reference a job's artifact owned by another
 * workspace without transferring authority or private context. These types
 * describe the reference locator, the grant that authorizes it, the injected
 * evidence the policy consumes, and the sanitized decisions it returns.
 *
 * The decision logic lives in `@adea-ai/db` (`artifact-reference-policy`).
 * This module deliberately holds data shapes and guards only: no transport,
 * storage, or location fields cross this boundary, and a refusal never
 * carries names, locations, or contents.
 */

import type { ArtifactSummary } from './index'

/**
 * Which decision entry point produced a result. Publication (the producing
 * workspace announces a reference) and retrieval (the audience workspace
 * pulls against it) are separate gates with separate checks.
 */
export type ArtifactReferenceStage = 'publication' | 'retrieval'

/**
 * The authority a reference claims. Only `workspace_grant` has a reviewed
 * contract in this slice; a reference claiming group-based authority stays
 * denied until that contract exists.
 */
export type ArtifactReferenceAuthority =
  | Readonly<{ kind: 'workspace_grant' }>
  | Readonly<{ kind: 'group'; groupId: string }>

/**
 * The exact locator a cross-workspace reference claims. Every field must
 * match current authoritative evidence: workspace, artifact id, version and
 * content checksum. A URL or artifact id alone never grants access.
 * `checksumSha256` reuses the existing `ArtifactSummary` content identity.
 */
export type ArtifactReferenceTarget = Readonly<{
  artifactId: string
  audienceWorkspaceId: string
  checksumSha256: string
  sourceWorkspaceId: string
  version: number
}>

/**
 * A grant binding one exact target to one audience. `revision` is bumped by
 * the granting workspace whenever the registration changes; a presented
 * grant whose revision differs from the authoritative registration is stale.
 */
export type ArtifactReferenceGrant = Readonly<{
  artifactId: string
  audienceWorkspaceId: string
  checksumSha256: string
  expiresAt: string | null
  grantId: string
  revokedAt: string | null
  revision: number
  sourceWorkspaceId: string
}>

/**
 * The authoritative current registration of a grant, read by the caller from
 * its own grant store and injected here. The policy store holds no grant
 * schema in this slice, so this is the only way revision/revocation/audience
 * truth reaches the decision.
 */
export type ArtifactReferenceGrantState = Readonly<{
  audienceWorkspaceIds: readonly string[]
  grantId: string
  revoked: boolean
  revision: number
}>

/**
 * Current, authoritative artifact facts as read through the existing db
 * access helpers. Deliberately projected: no filename, no location, no
 * provenance, no task linkage — evidence may feed refusals' inputs but never
 * their outputs.
 */
export type ArtifactReferenceEvidence = Readonly<{
  availability: ArtifactSummary['availability']
  checksumSha256: string
  deletionState: ArtifactSummary['deletionState']
  id: string
  sensitivity: ArtifactSummary['sensitivity']
  version: number
  workspaceId: string
}>

/**
 * Typed refusal reasons. The codes are the only denial payload a caller may
 * observe: they name the failed check, never the private artifact.
 */
export const artifactReferenceRefusalReasons = [
  'artifact_deleted',
  'artifact_not_available',
  'artifact_quarantined',
  'audience_not_authorized',
  'digest_mismatch',
  'evidence_unavailable',
  'grant_expired',
  'grant_malformed',
  'grant_not_registered',
  'grant_revoked',
  'grant_revision_stale',
  'reference_malformed',
  'stale_version',
  'target_mismatch',
  'unsupported_authority',
  'workspace_mismatch',
] as const

export type ArtifactReferenceRefusalReason = (typeof artifactReferenceRefusalReasons)[number]

export function isArtifactReferenceRefusalReason(
  value: unknown
): value is ArtifactReferenceRefusalReason {
  return (
    typeof value === 'string' &&
    (artifactReferenceRefusalReasons as readonly string[]).includes(value)
  )
}

/** Publication authorizes announcing the reference; anything else is held. */
export type ArtifactReferencePublicationDecision =
  | Readonly<{
      action: 'publish'
      ok: true
      stage: 'publication'
      /** The exact target whose publication is admitted. */
      target: ArtifactReferenceTarget
    }>
  | Readonly<{
      action: 'hold'
      ok: false
      /** A hold gates the publication only; the producing job continues. */
      producerEffect: 'unaffected'
      reason: ArtifactReferenceRefusalReason
      stage: 'publication'
    }>

/** Retrieval authorizes delivering content against the reference. */
export type ArtifactReferenceRetrievalDecision =
  | Readonly<{
      action: 'deliver'
      ok: true
      stage: 'retrieval'
      /** The exact target whose retrieval is admitted. */
      target: ArtifactReferenceTarget
    }>
  | Readonly<{
      action: 'deny'
      ok: false
      reason: ArtifactReferenceRefusalReason
      stage: 'retrieval'
    }>

/**
 * Inputs to the publication gate. `evidence` must be read at decision time
 * through the db access helpers; `grant`/`grantState` are the presented and
 * registered grant, and `now` is the caller's clock.
 */
export type ArtifactReferencePublicationInput = Readonly<{
  authority: ArtifactReferenceAuthority
  evidence: ArtifactReferenceEvidence | null
  grant: ArtifactReferenceGrant | null
  grantState: ArtifactReferenceGrantState | null
  now: string
  target: ArtifactReferenceTarget
}>

/**
 * Inputs to the retrieval gate. Beyond the publication inputs, the caller
 * binds the workspace on whose behalf content would be delivered; only the
 * target's registered audience workspace may retrieve.
 */
export type ArtifactReferenceRetrievalInput = ArtifactReferencePublicationInput &
  Readonly<{ requestingWorkspaceId: string }>

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/

/** Whether the value is a well-formed artifact content checksum (sha-256 hex). */
export function isChecksumSha256(value: unknown): value is string {
  return typeof value === 'string' && CHECKSUM_PATTERN.test(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Whether the value is a structurally well-formed reference target. */
export function isArtifactReferenceTarget(value: unknown): value is ArtifactReferenceTarget {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    hasText(candidate.artifactId) &&
    hasText(candidate.audienceWorkspaceId) &&
    hasText(candidate.sourceWorkspaceId) &&
    isChecksumSha256(candidate.checksumSha256) &&
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    candidate.version > 0 &&
    Object.keys(candidate).length === 5
  )
}

/** Whether the value is a structurally well-formed grant. */
export function isArtifactReferenceGrant(value: unknown): value is ArtifactReferenceGrant {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    hasText(candidate.grantId) &&
    hasText(candidate.artifactId) &&
    hasText(candidate.audienceWorkspaceId) &&
    hasText(candidate.sourceWorkspaceId) &&
    isChecksumSha256(candidate.checksumSha256) &&
    typeof candidate.revision === 'number' &&
    Number.isInteger(candidate.revision) &&
    candidate.revision > 0 &&
    (candidate.expiresAt === null || hasText(candidate.expiresAt)) &&
    (candidate.revokedAt === null || hasText(candidate.revokedAt)) &&
    Object.keys(candidate).length === 8
  )
}
