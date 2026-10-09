/*
 * Job outbound result service (M15 #1217).
 *
 * Runs the pure decisions in `job-outbound-result-policy` over CURRENT state
 * read through injected ports. Every publish and every delivery reads the job,
 * the original actor's source-workspace access, the artifact facts, and (for
 * delivery) the recipient's destination access again. Nothing is cached between
 * calls, so a revocation after publication denies the next delivery. A rejected
 * read rejects the call: no decision is made and nothing is released on an
 * authority that could not be read.
 *
 * The service persists nothing and mutates no job. Callers own the outbox,
 * event and transport steps that follow a `publish` or `deliver` decision.
 */
import type { ArtifactReferenceEvidence, ArtifactReferenceGrantState } from '@adea-ai/types'

import {
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  sanitizeJobOutboundResult,
  type JobOutboundAccess,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundDeliveryDecision,
  type JobOutboundJobSource,
  type JobOutboundPublicationDecision,
} from './job-outbound-result-policy'

/**
 * Current-state reads. Each returns the authoritative value at call time; a
 * `null` evidence or job is a refusal, never a reason to trust the request.
 */
export type JobOutboundPorts = Readonly<{
  /** Current access of one principal to one workspace (role and workspace liveness). */
  readAccess: (
    input: Readonly<{ userId: string; workspaceId: string }>
  ) => Promise<JobOutboundAccess>
  readArtifactEvidence: (
    input: Readonly<{ artifactId: string; principalUserId: string; workspaceId: string }>
  ) => Promise<ArtifactReferenceEvidence | null>
  /** Resolves the registration only while the presented revision is current; a stale revision reads null. */
  readArtifactGrantState: (
    presentation: Readonly<{ grantId: string; revision: number }>
  ) => Promise<ArtifactReferenceGrantState | null>
  readJobSource: (jobId: string) => Promise<JobOutboundJobSource | null>
}>

export type JobOutboundPublishInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  destinationWorkspaceId: string
  jobId: string
  now: string
  result: unknown
}>

export type JobOutboundDeliverInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  /** The destination recorded when the result was published. */
  destinationWorkspaceId: string
  jobId: string
  now: string
  /** The record stored at publication; it is sanitized again before release. */
  published: unknown
  /** The destination member the result is released to. */
  recipientUserId: string
}>

export type JobOutboundResultService = Readonly<{
  deliver: (input: JobOutboundDeliverInput) => Promise<JobOutboundDeliveryDecision>
  publish: (input: JobOutboundPublishInput) => Promise<JobOutboundPublicationDecision>
}>

export function createJobOutboundResultService(ports: JobOutboundPorts): JobOutboundResultService {
  /** Source access of the job's original actor, or null when the job cannot be proven. */
  async function readSourceAccess(
    job: JobOutboundJobSource | null
  ): Promise<JobOutboundAccess | null> {
    if (!job) return null
    return ports.readAccess({
      userId: job.originalActorUserId,
      workspaceId: job.sourceWorkspaceId,
    })
  }

  /**
   * Reads the artifact facts a claim depends on. Evidence is read as the
   * original actor, so a principal that lost source access reads no evidence.
   */
  async function readArtifactCurrent(
    claim: JobOutboundArtifactClaim | null,
    job: JobOutboundJobSource | null,
    result: unknown
  ): Promise<(JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null> {
    if (!claim) return null
    const sanitized = sanitizeJobOutboundResult(result)
    const target = sanitized.ok ? sanitized.result.artifact : null
    const evidence =
      target && job
        ? await ports.readArtifactEvidence({
            artifactId: target.artifactId,
            principalUserId: job.originalActorUserId,
            workspaceId: target.sourceWorkspaceId,
          })
        : null
    const grantState = claim.grant
      ? await ports.readArtifactGrantState({
          grantId: claim.grant.grantId,
          revision: claim.grant.revision,
        })
      : null
    return { authority: claim.authority, evidence, grant: claim.grant, grantState }
  }

  return {
    async publish(input) {
      const job = await ports.readJobSource(input.jobId)
      const sourceAccess = await readSourceAccess(job)
      const artifact = await readArtifactCurrent(input.artifact, job, input.result)
      return decideJobOutboundPublication({
        artifact,
        destinationWorkspaceId: input.destinationWorkspaceId,
        job,
        jobId: input.jobId,
        now: input.now,
        result: input.result,
        sourceAccess,
      })
    },

    async deliver(input) {
      const job = await ports.readJobSource(input.jobId)
      const sourceAccess = await readSourceAccess(job)
      const recipientAccess = await ports.readAccess({
        userId: input.recipientUserId,
        workspaceId: input.destinationWorkspaceId,
      })
      const artifact = await readArtifactCurrent(input.artifact, job, input.published)
      return decideJobOutboundDelivery({
        artifact,
        destinationWorkspaceId: input.destinationWorkspaceId,
        job,
        jobId: input.jobId,
        now: input.now,
        published: input.published,
        recipientAccess,
        sourceAccess,
      })
    },
  }
}
