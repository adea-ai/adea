import type { ArtifactReferenceEvidence, UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray } from 'drizzle-orm'

import { getArtifactForUser } from './artifacts'
import type { AgentHqDatabase } from './connection'
import { resolveProjectAccessScopes } from './project-access'
import { artifacts, tasks } from './schema'

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

/** One evidence read: the artifact, in its workspace, as one reader. */
export type ArtifactEvidenceRequest = Readonly<{
  artifactId: string
  principalUserId: string
  workspaceId: string
}>

/** The key an evidence batch result is stored under. */
export function artifactEvidenceKey(request: ArtifactEvidenceRequest): string {
  return `${request.workspaceId}\u0000${request.principalUserId}\u0000${request.artifactId}`
}

/**
 * `readArtifactReferenceEvidence` for many requests, in two reads per workspace. The rules are
 * the same as the single read: the reader needs a membership in the artifact's workspace, a
 * task in a project the reader cannot see hides its artifact, and a deleted artifact has no
 * evidence. A request with no evidence has no entry, which the policy treats as unavailable.
 */
export async function readArtifactReferenceEvidenceBatch(
  database: AgentHqDatabase,
  requests: readonly ArtifactEvidenceRequest[]
): Promise<ReadonlyMap<string, ArtifactReferenceEvidence>> {
  const evidence = new Map<string, ArtifactReferenceEvidence>()
  const groups = new Map<string, ArtifactEvidenceRequest[]>()
  for (const request of requests) {
    const group = groups.get(request.workspaceId)
    if (group) group.push(request)
    else groups.set(request.workspaceId, [request])
  }
  for (const [workspaceId, group] of groups) {
    const scopes = await resolveProjectAccessScopes(
      database,
      workspaceId,
      group.map((request) => request.principalUserId)
    )
    const rows = await database
      .select({ artifact: artifacts, projectId: tasks.projectId })
      .from(artifacts)
      .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
      .where(
        and(
          eq(artifacts.workspaceId, workspaceId),
          inArray(
            artifacts.id,
            group.map((request) => request.artifactId)
          ),
          eq(artifacts.deletionState, 'active')
        )
      )
    const rowById = new Map(rows.map((row) => [row.artifact.id, row]))
    for (const request of group) {
      const scope = scopes.get(request.principalUserId)
      const row = rowById.get(request.artifactId)
      if (!scope || !row) continue
      if (row.artifact.taskId && row.projectId && scope.hiddenProjectIds.includes(row.projectId))
        continue
      evidence.set(
        artifactEvidenceKey(request),
        Object.freeze({
          availability: row.artifact.availability,
          checksumSha256: row.artifact.checksumSha256,
          deletionState: row.artifact.deletionState,
          id: row.artifact.id,
          sensitivity: row.artifact.sensitivity,
          version: row.artifact.version,
          workspaceId: row.artifact.workspaceId,
        })
      )
    }
  }
  return evidence
}

export {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
} from './artifact-reference-decisions'
