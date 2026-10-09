/*
 * Job outbound result service (M15 #1217).
 *
 * Runs the pure gates in `job-outbound-result-policy` over current state.
 *
 * Publish reads the job, the original actor's source access and the artifact
 * facts inside one authorization scope, then returns its decision. The message
 * write that records the publication happens after that scope closes, because
 * the existing message write opens its own transaction.
 *
 * Deliver works in two steps. First, `resolveDelivery` reads the canonical
 * publication and the artifact registration identity without a lock, so the
 * grant lock can be taken on the exact grant. Second, inside that scope, every
 * fact is read again, the publication is re-read, and the trusted clock is
 * sampled after those reads. Only then is the decision made, and the release
 * runs as the last step of the scope. A change between the two steps shows up
 * in the locked reads and denies.
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
  type JobOutboundPublication,
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
  readPublication: (
    input: Readonly<{ jobId: string; messageId: string }>
  ) => Promise<JobOutboundPublication | null>
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
 * Without one, it is a plain transaction. A rejection rolls the scope back.
 */
export type JobOutboundAuthorize<TTransaction> = <T>(
  scope: JobOutboundGrantScope | null,
  run: (context: JobOutboundAuthorizationContext<TTransaction>) => Promise<T>
) => Promise<T>

/** The release write. It runs inside the authorization scope, after the final checks. */
export type JobOutboundRelease<TTransaction> = (
  context: Readonly<{ transaction: TTransaction }>,
  released: SanitizedJobOutboundResult
) => Promise<void>

/**
 * The unlocked first step of delivery: the canonical publication's artifact
 * claim (its registration as presented) and the grant scope to lock. Null when
 * the publication cannot be resolved at all.
 */
export type JobOutboundDeliveryResolution = Readonly<{
  claim: JobOutboundArtifactClaim | null
  scope: JobOutboundGrantScope | null
}>

export type JobOutboundPublishInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  destination: JobOutboundDestination
  jobId: string
  result: unknown
}>

export type JobOutboundDeliverInput = Readonly<{
  jobId: string
  /** The canonical publication written by the existing message flow. */
  messageId: string
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

export type JobOutboundServiceOptions<TTransaction> = Readonly<{
  authorize: JobOutboundAuthorize<TTransaction>
  /** The trusted clock. It is sampled inside the scope, after the awaited reads. */
  clock: () => string
  /** The unlocked first step of delivery. */
  resolveDelivery: (
    input: Readonly<{ jobId: string; messageId: string }>
  ) => Promise<JobOutboundDeliveryResolution | null>
}>

/**
 * The grant scope a publication claim needs: the artifact and grant named by the
 * sanitized result, locked at the presented revision. Null when no artifact grant
 * is claimed or the result cannot name one.
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

/** Reads the artifact evidence an artifact claim depends on, as the job's original actor. */
async function readArtifactCurrent(
  reads: JobOutboundReads,
  claim: JobOutboundArtifactClaim | null,
  job: JobOutboundJobSource | null,
  artifactId: string | null,
  artifactWorkspaceId: string | null,
  grantState: ArtifactReferenceGrantState | null
): Promise<(JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null> {
  if (!claim) return null
  const evidence =
    artifactId && artifactWorkspaceId && job
      ? await reads.readArtifactEvidence({
          artifactId,
          principalUserId: job.originalActorUserId,
          workspaceId: artifactWorkspaceId,
        })
      : null
  return { authority: claim.authority, evidence, grant: claim.grant, grantState }
}

export function createJobOutboundResultService<TTransaction>(
  options: JobOutboundServiceOptions<TTransaction>
): JobOutboundResultService<TTransaction> {
  const { authorize, clock, resolveDelivery } = options
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
          const sanitized = sanitizeJobOutboundResult(input.result)
          const target = sanitized.ok ? sanitized.result.artifact : null
          const artifact = await readArtifactCurrent(
            reads,
            input.artifact,
            job,
            target?.artifactId ?? null,
            target?.sourceWorkspaceId ?? null,
            grantState
          )
          return decideJobOutboundPublication({
            artifact,
            destination: input.destination,
            job,
            jobId: input.jobId,
            now: clock(),
            result: input.result,
            sourceAccess,
          })
        }
      )
    },

    async deliver(input, release) {
      const resolved = await resolveDelivery({ jobId: input.jobId, messageId: input.messageId })
      if (!resolved)
        return { action: 'deny', gate: 'publication', reason: 'publication_unavailable' }
      return authorize(resolved.scope, async ({ grantState, reads, transaction }) => {
        const publication = await reads.readPublication({
          jobId: input.jobId,
          messageId: input.messageId,
        })
        const job = await reads.readJobSource(input.jobId)
        const sourceAccess = job
          ? await reads.readAccess({
              userId: job.originalActorUserId,
              workspaceId: job.sourceWorkspaceId,
            })
          : null
        const recipientAudience = publication
          ? await reads.readAudience({
              channelId: publication.channelId,
              userId: input.recipientUserId,
              workspaceId: publication.workspaceId,
            })
          : null
        const artifact = await readArtifactCurrent(
          reads,
          resolved.claim,
          job,
          publication?.artifact?.artifactId ?? null,
          publication?.artifact?.sourceWorkspaceId ?? null,
          grantState
        )
        // Sampled after every awaited read: lock waits cannot carry an expired grant through.
        const decision = decideJobOutboundDelivery({
          artifact,
          job,
          jobId: input.jobId,
          now: clock(),
          publication,
          recipientAudience,
          sourceAccess,
        })
        if (decision.action === 'deliver') await release({ transaction }, decision.result)
        return decision
      })
    },
  }
}
