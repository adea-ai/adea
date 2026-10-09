/*
 * Job outbound result service (M15 #1217).
 *
 * Runs the pure gates in `job-outbound-result-policy` over current state. Every
 * decision reads the job, the original actor's source access, the destination
 * standing, and the artifact facts inside one authorization scope. For an
 * artifact that scope is the #1207 grant lock, so the grant state is read
 * under lock. A release is handed to the caller in that same scope, after the
 * final reads, so no authority read happens after the last check and before the
 * release. A rejected read rejects the call, and nothing is released.
 *
 * The service persists nothing. The caller supplies the authorization scope
 * (the store adapter, or a fake in tests) and the release write, which receives
 * the same transaction the reads ran in.
 */
import type { ArtifactReferenceEvidence, ArtifactReferenceGrantState } from '@adea-ai/types'

import {
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  sanitizeJobOutboundResult,
  type JobOutboundAccess,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundAudience,
  type JobOutboundDeliveryDecision,
  type JobOutboundDestination,
  type JobOutboundJobSource,
  type JobOutboundPublicationDecision,
  type SanitizedJobOutboundResult,
} from './job-outbound-result-policy'

/** The artifact grant an authorization scope locks: artifact, grant identity and revision. */
export type JobOutboundGrantScope = Readonly<{
  artifactId: string
  grantId: string
  revision: number
  sourceWorkspaceId: string
}>

/** Current-state reads, all performed inside one authorization scope. */
export type JobOutboundReads = Readonly<{
  readAccess: (
    input: Readonly<{ userId: string; workspaceId: string }>
  ) => Promise<JobOutboundAccess>
  readArtifactEvidence: (
    input: Readonly<{ artifactId: string; principalUserId: string; workspaceId: string }>
  ) => Promise<ArtifactReferenceEvidence | null>
  readAudience: (
    input: Readonly<{ channelId: string; userId: string; workspaceId: string }>
  ) => Promise<JobOutboundAudience>
  readJobSource: (jobId: string) => Promise<JobOutboundJobSource | null>
}>

export type JobOutboundAuthorizationContext<TTransaction> = Readonly<{
  /** Registration state under the grant lock; null when no artifact grant is claimed or it is not registered. */
  grantState: ArtifactReferenceGrantState | null
  reads: JobOutboundReads
  transaction: TTransaction
}>

/**
 * Runs `run` inside one authorization scope. With a grant scope, the scope is the
 * #1207 lock: the artifact and grant rows stay locked for the whole callback.
 * Without one, it is a plain transaction. A rejection anywhere rolls the scope back.
 */
export type JobOutboundAuthorize<TTransaction> = <T>(
  scope: JobOutboundGrantScope | null,
  run: (context: JobOutboundAuthorizationContext<TTransaction>) => Promise<T>
) => Promise<T>

/** The release write. It runs inside the authorization scope, after the final reads. */
export type JobOutboundRelease<TTransaction> = (
  context: Readonly<{ transaction: TTransaction }>,
  released: SanitizedJobOutboundResult
) => Promise<void>

export type JobOutboundPublishInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  destination: JobOutboundDestination
  jobId: string
  now: string
  result: unknown
}>

export type JobOutboundDeliverInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  /** The destination recorded when the result was published. */
  destination: JobOutboundDestination
  jobId: string
  now: string
  /** The record stored at publication; it is re-sanitized before release. */
  published: unknown
  /** The destination participant the result is released to. */
  recipientUserId: string
}>

export type JobOutboundResultService<TTransaction> = Readonly<{
  deliver: (
    input: JobOutboundDeliverInput,
    release: JobOutboundRelease<TTransaction>
  ) => Promise<JobOutboundDeliveryDecision>
  publish: (input: JobOutboundPublishInput) => Promise<JobOutboundPublicationDecision>
}>

/**
 * The grant scope a claim needs: the artifact and grant the sanitized result
 * names, locked at the presented revision. Null when no artifact grant is claimed
 * or the result cannot name one; the gates then refuse on their own terms.
 */
function grantScopeFor(
  claim: JobOutboundArtifactClaim | null,
  result: unknown
): JobOutboundGrantScope | null {
  if (!claim?.grant) return null
  const sanitized = sanitizeJobOutboundResult(result)
  const target = sanitized.ok ? sanitized.result.artifact : null
  if (!target) return null
  return {
    artifactId: target.artifactId,
    grantId: claim.grant.grantId,
    revision: claim.grant.revision,
    sourceWorkspaceId: target.sourceWorkspaceId,
  }
}

/** Reads the artifact evidence a claim depends on, as the job's original actor. */
async function readArtifactCurrent(
  reads: JobOutboundReads,
  claim: JobOutboundArtifactClaim | null,
  job: JobOutboundJobSource | null,
  grantState: ArtifactReferenceGrantState | null,
  result: unknown
): Promise<(JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null> {
  if (!claim) return null
  const sanitized = sanitizeJobOutboundResult(result)
  const target = sanitized.ok ? sanitized.result.artifact : null
  const evidence =
    target && job
      ? await reads.readArtifactEvidence({
          artifactId: target.artifactId,
          principalUserId: job.originalActorUserId,
          workspaceId: target.sourceWorkspaceId,
        })
      : null
  return { authority: claim.authority, evidence, grant: claim.grant, grantState }
}

export function createJobOutboundResultService<TTransaction>(
  authorize: JobOutboundAuthorize<TTransaction>
): JobOutboundResultService<TTransaction> {
  return {
    async publish(input) {
      return authorize(
        grantScopeFor(input.artifact, input.result),
        async ({ grantState, reads }) => {
          const job = await reads.readJobSource(input.jobId)
          const sourceAccess = job
            ? await reads.readAccess({
                userId: job.originalActorUserId,
                workspaceId: job.sourceWorkspaceId,
              })
            : null
          const artifact = await readArtifactCurrent(
            reads,
            input.artifact,
            job,
            grantState,
            input.result
          )
          return decideJobOutboundPublication({
            artifact,
            destination: input.destination,
            job,
            jobId: input.jobId,
            now: input.now,
            result: input.result,
            sourceAccess,
          })
        }
      )
    },

    async deliver(input, release) {
      return authorize(
        grantScopeFor(input.artifact, input.published),
        async ({ grantState, reads, transaction }) => {
          const job = await reads.readJobSource(input.jobId)
          const sourceAccess = job
            ? await reads.readAccess({
                userId: job.originalActorUserId,
                workspaceId: job.sourceWorkspaceId,
              })
            : null
          const recipientAudience = await reads.readAudience({
            channelId: input.destination.channelId,
            userId: input.recipientUserId,
            workspaceId: input.destination.workspaceId,
          })
          const artifact = await readArtifactCurrent(
            reads,
            input.artifact,
            job,
            grantState,
            input.published
          )
          const decision = decideJobOutboundDelivery({
            artifact,
            destination: input.destination,
            job,
            jobId: input.jobId,
            now: input.now,
            published: input.published,
            recipientAudience,
            sourceAccess,
          })
          // The release is the last step of the scope: nothing is read after the final check.
          if (decision.action === 'deliver') {
            await release({ transaction }, decision.result)
          }
          return decision
        }
      )
    },
  }
}
