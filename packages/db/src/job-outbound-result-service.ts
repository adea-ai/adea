/*
 * Job outbound result service (M15 #1217).
 *
 * Runs the pure gates in `job-outbound-result-policy` over current state.
 *
 * Publish runs in one authorization scope. Inside it, every fact is read, the
 * trusted clock is sampled after the reads, and the decision is made. On
 * publish, the canonical message is written in that same transaction, through
 * the caller's `write`, before the scope commits. So a message exists only if its
 * authorization committed with it, and an ordinary read cannot see a publication
 * that was not authorized.
 *
 * Deliver works in two steps. First, `resolveDelivery` reads the canonical
 * publication and the grant identity it was bound to, without a lock. Second,
 * inside the scope, every fact is read again, the clock is sampled after the
 * reads, and the release runs as the last step. A change between the two steps
 * shows up in the locked reads and denies.
 */
import type { ArtifactReferenceEvidence, ArtifactReferenceGrantState } from '@adea-ai/types'

import {
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  sanitizeJobOutboundResult,
  type JobOutboundAccess,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundArtifactPolicy,
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
    input: Readonly<{ channelId: string; forWrite?: boolean; userId: string; workspaceId: string }>
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
 * Runs `run` inside one authorization scope. With a grant scope the scope is the
 * #1207 lock, held for the whole callback. Without one it is a plain transaction.
 * A rejection rolls the scope back, including any write made inside it.
 */
export type JobOutboundAuthorize<TTransaction> = <T>(
  scope: JobOutboundGrantScope | null,
  run: (context: JobOutboundAuthorizationContext<TTransaction>) => Promise<T>
) => Promise<T>

/** The release write for delivery. It runs inside the scope, after the final checks. */
export type JobOutboundRelease<TTransaction> = (
  context: Readonly<{ transaction: TTransaction }>,
  released: SanitizedJobOutboundResult
) => Promise<void>

/**
 * The publication write. It runs inside the scope, after the publish decision,
 * and returns the id of the canonical message it wrote in that transaction.
 */
export type JobOutboundPublicationWrite<TTransaction> = (
  context: Readonly<{ transaction: TTransaction }>,
  decision: Extract<JobOutboundPublicationDecision, { action: 'publish' }>
) => Promise<string>

/** The unlocked first step of delivery: the grant identity the publication was bound to, and its claim. */
export type JobOutboundDeliveryResolution = Readonly<{
  claim: JobOutboundArtifactClaim | null
  scope: JobOutboundGrantScope | null
}>

export type JobOutboundPublishInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  /** Defaults to `require`: an unauthorized artifact holds the publication. */
  artifactPolicy?: JobOutboundArtifactPolicy
  destination: JobOutboundDestination
  jobId: string
  result: unknown
}>

export type JobOutboundDeliverInput = Readonly<{
  jobId: string
  /** The canonical publication message written by `publish`. */
  messageId: string
  /** The destination participant the result is released to. */
  recipientUserId: string
}>

/**
 * A step that runs inside the publication scope before any publication fact is read,
 * in the same transaction as the decision and its write. Production completion uses it
 * so the Task completes in the transaction that decides and writes the publication.
 * A rejection rolls back everything the scope did.
 */
export type JobOutboundPrepare<TTransaction, TPrepared> = (
  context: JobOutboundAuthorizationContext<TTransaction>
) => Promise<TPrepared>

export type JobOutboundPublishResult<TPrepared = null> = Readonly<{
  decision: JobOutboundPublicationDecision
  /** The canonical message id when the publication was written in the same transaction. */
  messageId: string | null
  /** What `prepare` returned, when one was given. */
  prepared: TPrepared | null
}>

export type JobOutboundResultService<TTransaction> = Readonly<{
  deliver: (
    input: JobOutboundDeliverInput,
    release: JobOutboundRelease<TTransaction>
  ) => Promise<JobOutboundDeliveryDecision>
  publish: <TPrepared = null>(
    input: JobOutboundPublishInput,
    write: JobOutboundPublicationWrite<TTransaction>,
    prepare?: JobOutboundPrepare<TTransaction, TPrepared>
  ) => Promise<JobOutboundPublishResult<TPrepared>>
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

/** The grant scope a claim needs: the artifact and grant the sanitized result names, at the presented revision. */
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
    async publish(input, write, prepare) {
      return authorize(grantScopeFor(input.artifact, input.result), async (context) => {
        const { grantState, reads, transaction } = context
        // Prepared first, so every read below sees its effects.
        const prepared = prepare ? await prepare(context) : null
        const job = await reads.readJobSource(input.jobId)
        const sourceAccess = job
          ? await reads.readAccess({
              userId: job.originalActorUserId,
              workspaceId: job.sourceWorkspaceId,
            })
          : null
        // The destination's revision is read as the job's original actor, who must be able to write there.
        // Publication writes the channel row (its message sequence), so the write lock is taken up
        // front. A shared lock upgraded later deadlocks against a concurrent roster write.
        const audience = job
          ? await reads.readAudience({
              channelId: input.destination.channelId,
              forWrite: true,
              userId: job.originalActorUserId,
              workspaceId: input.destination.workspaceId,
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
        const decision = decideJobOutboundPublication({
          artifact,
          artifactPolicy: input.artifactPolicy ?? 'require',
          audience,
          destination: input.destination,
          job,
          jobId: input.jobId,
          // Sampled after the reads, inside the scope.
          now: clock(),
          result: input.result,
          sourceAccess,
        })
        if (decision.action !== 'publish') return { decision, messageId: null, prepared }
        // The write runs in the same transaction as the decision: it commits or rolls back with it.
        const messageId = await write({ transaction }, decision)
        return { decision, messageId, prepared }
      })
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
