import {
  isArtifactReferenceGrant,
  isArtifactReferenceTarget,
  type ArtifactReferenceEvidence,
  type ArtifactReferencePublicationDecision,
  type ArtifactReferencePublicationInput,
  type ArtifactReferenceRefusalReason,
  type ArtifactReferenceRetrievalDecision,
  type ArtifactReferenceRetrievalInput,
  type UserPrincipalRef,
} from '@adea-ai/types'
import { getArtifactForUser } from './artifacts'
import type { AgentHqDatabase } from './connection'

/**
 * Artifact-reference authorization policy for M15.03 (#1180).
 *
 * Cross-workspace plans may reference another workspace's job artifact
 * without transferring authority or private context. This module is the
 * gate: publication and retrieval are separate decision entry points over
 * INJECTED evidence, and both require an exact match of workspace, artifact,
 * version and content checksum against CURRENT authoritative evidence plus a
 * current, registered, unrevoked, unexpired grant. A URL or artifact id
 * alone never grants access.
 *
 * The presented grant is authenticated in full against its authoritative
 * registration: identity, revision, revocation and audience as before, and
 * now also the registered source workspace, artifact, version, digest and
 * expiry. Every field must equal the retained record, and any divergence is
 * its own typed refusal (`grant_target_mismatch`, `grant_digest_mismatch`,
 * `grant_version_mismatch`, `grant_expiry_mismatch`): a known grant can
 * never be relabelled onto another artifact, version or lifetime, and a
 * presented expiry is never trusted over the registered one.
 *
 * The functions are pure: the caller injects the database handle when reading
 * evidence, the presented grant, its authoritative registration state and the
 * clock. Nothing here mutates artifacts, cancels jobs, or discovers grants.
 *
 * A publication refusal is a hold: the gate keeps the unauthorized result
 * from crossing while the producing job continues unaffected. A retrieval
 * refusal denies delivery. Refusals carry only typed reason codes — never
 * filenames, locations, provenance, or contents.
 */

/**
 * Read the current authoritative artifact evidence through the existing
 * access helpers, projected to the identity fields the policy needs. The
 * reading principal must already hold workspace access (`getArtifactForUser`
 * enforces membership and project visibility); `null` means no current
 * access evidence, which the policy treats as unavailable — never as a
 * reason to trust the presented locator. Deleted artifacts are excluded by
 * the helper, so deletion surfaces as `null` evidence.
 */
export async function readArtifactReferenceEvidence(
  database: AgentHqDatabase,
  workspaceId: string,
  artifactId: string,
  principal: UserPrincipalRef
): Promise<ArtifactReferenceEvidence | null> {
  const summary = await getArtifactForUser(database, workspaceId, artifactId, principal)
  if (!summary) return null
  return Object.freeze({
    availability: summary.availability,
    checksumSha256: summary.checksumSha256,
    deletionState: summary.deletionState,
    id: summary.id,
    sensitivity: summary.sensitivity,
    version: summary.version,
    workspaceId: summary.workspaceId,
  })
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * The single ordered evaluation behind both gates. Returns the refusal
 * reason, or null when every exact-match, availability, grant-registration
 * and audience check passes. The order is deterministic so the same inputs
 * always produce the same typed reason.
 */
function evaluateArtifactReference(
  input: ArtifactReferencePublicationInput | ArtifactReferenceRetrievalInput
): ArtifactReferenceRefusalReason | null {
  // Group-based authority has no reviewed contract yet: denied by name until
  // one exists, whatever else the reference claims.
  if (input.authority.kind !== 'workspace_grant') return 'unsupported_authority'

  if (
    !isArtifactReferenceTarget(input.target) ||
    input.target.audienceWorkspaceId === input.target.sourceWorkspaceId
  )
    return 'reference_malformed'

  // No current evidence (missing artifact, no access, deleted) — the locator
  // alone proves nothing.
  const { evidence } = input
  if (!evidence) return 'evidence_unavailable'

  // The evidence read must be about exactly the claimed source workspace and
  // artifact; anything else is a cross-workspace forgery attempt.
  if (
    evidence.workspaceId !== input.target.sourceWorkspaceId ||
    evidence.id !== input.target.artifactId
  )
    return 'workspace_mismatch'

  if (evidence.deletionState === 'deleted') return 'artifact_deleted'
  if (evidence.availability === 'quarantined') return 'artifact_quarantined'
  if (evidence.availability !== 'available') return 'artifact_not_available'

  // Exact version, then exact content digest: a stale version or a tampered
  // digest never matches, at publication and again at retrieval.
  if (evidence.version !== input.target.version) return 'stale_version'
  if (evidence.checksumSha256 !== input.target.checksumSha256) return 'digest_mismatch'

  // A supported workspace grant must exist, be well-formed, and bind exactly
  // the presented target — including the granted artifact version, so a v1
  // grant never presents a v2 locator even under an unchanged checksum.
  const { grant } = input
  if (!grant || !isArtifactReferenceGrant(grant)) return 'grant_malformed'
  if (
    grant.sourceWorkspaceId !== input.target.sourceWorkspaceId ||
    grant.artifactId !== input.target.artifactId ||
    grant.version !== input.target.version ||
    grant.checksumSha256 !== input.target.checksumSha256 ||
    grant.audienceWorkspaceId !== input.target.audienceWorkspaceId
  )
    return 'target_mismatch'

  // The presented grant must be the registered one: unknown grants are
  // forged, stale revisions are superseded, revocation is absolute.
  const { grantState } = input
  if (!grantState || grantState.grantId !== grant.grantId) return 'grant_not_registered'
  // And it must be COMPLETELY the registered one: the retained registration
  // authenticates every identity-bearing field of the presented grant, each
  // divergence under its own typed refusal. A known grant identity thus
  // authorizes exactly the artifact, digest, version and lifetime it was
  // issued for — never a relabelled target, a substituted digest, a moved
  // version, or a nulled/extended expiry.
  if (
    grantState.sourceWorkspaceId !== grant.sourceWorkspaceId ||
    grantState.artifactId !== grant.artifactId
  )
    return 'grant_target_mismatch'
  if (grantState.checksumSha256 !== grant.checksumSha256) return 'grant_digest_mismatch'
  if (grantState.version !== grant.version) return 'grant_version_mismatch'
  if (grantState.expiresAt !== grant.expiresAt) return 'grant_expiry_mismatch'
  if (grantState.revoked || grant.revokedAt !== null) return 'grant_revoked'
  if (grantState.revision !== grant.revision) return 'grant_revision_stale'
  if (!grantState.audienceWorkspaceIds.includes(input.target.audienceWorkspaceId))
    return 'audience_not_authorized'

  // Expiry is checked last so a revoked or superseded grant is named as such.
  // It is only reached when the presented expiry equals the registered one,
  // so the lifetime decision below runs on authenticated truth.
  if (grant.expiresAt !== null) {
    const expiresAt = parseTimestamp(grant.expiresAt)
    if (expiresAt === null) return 'grant_malformed'
    const now = parseTimestamp(input.now)
    // An unverifiable clock also fails closed, as expired.
    if (now === null || now >= expiresAt) return 'grant_expired'
  }

  return null
}

/**
 * Publication gate for a cross-workspace reference. Admits only an exact,
 * currently available artifact under a supported, current grant; holds
 * anything else — including the late publication of a result whose grant was
 * revoked, expired or superseded while the producing job kept running.
 */
export function authorizeArtifactReferencePublication(
  input: ArtifactReferencePublicationInput
): ArtifactReferencePublicationDecision {
  const reason = evaluateArtifactReference(input)
  if (reason)
    return { action: 'hold', ok: false, producerEffect: 'unaffected', reason, stage: 'publication' }
  return { action: 'publish', ok: true, stage: 'publication', target: input.target }
}

/**
 * Retrieval gate for a cross-workspace reference. Rechecks everything the
 * publication gate checks against the CURRENT evidence, and additionally
 * binds delivery to the target's registered audience workspace: a result is
 * denied after revocation rather than delivered, and only the authorized
 * destination may ever receive it.
 */
export function authorizeArtifactReferenceRetrieval(
  input: ArtifactReferenceRetrievalInput
): ArtifactReferenceRetrievalDecision {
  if (input.requestingWorkspaceId !== input.target.audienceWorkspaceId)
    return { action: 'deny', ok: false, reason: 'audience_not_authorized', stage: 'retrieval' }
  const reason = evaluateArtifactReference(input)
  if (reason) return { action: 'deny', ok: false, reason, stage: 'retrieval' }
  return { action: 'deliver', ok: true, stage: 'retrieval', target: input.target }
}
