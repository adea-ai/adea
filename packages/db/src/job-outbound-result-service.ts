/*
 * Job outbound result service (M15 #1217).
 *
 * Runs the pure decisions in `job-outbound-result-policy` over CURRENT state
 * read through injected ports. Publication reads the job, the publisher's
 * admission and the artifact facts; every delivery reads the recipient's
 * admission and the artifact facts again, so a revocation or revision after
 * publication denies the next delivery. Nothing is cached between calls. A
 * rejected read rejects the call: no decision is made and nothing is released
 * on an authority that could not be read.
 *
 * The service persists nothing and mutates no job. Callers own the outbox,
 * event and transport steps that follow a `publish` or `deliver` decision.
 */
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrantState,
  ConversationParticipantRef,
  GroupAdmission,
  GroupCompletedJob,
  UserPrincipalRef,
} from '@adea-ai/types'

import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import type { AgentHqDatabase } from './connection'
import {
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  sanitizeJobOutboundResult,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundDeliveryDecision,
  type JobOutboundPublicationDecision,
  type JobOutboundRecipient,
} from './job-outbound-result-policy'

/**
 * Current-state reads. Each port returns the authoritative value at call time;
 * `null` means no current evidence, which the policy treats as a refusal.
 */
export type JobOutboundPorts = Readonly<{
  readArtifactEvidence: (
    input: Readonly<{ artifactId: string; workspaceId: string }>
  ) => Promise<ArtifactReferenceEvidence | null>
  /** Resolves the registration only while the presented revision is current; a stale revision reads null. */
  readArtifactGrantState: (
    presentation: Readonly<{ grantId: string; revision: number }>
  ) => Promise<ArtifactReferenceGrantState | null>
  readCompletedJob: (jobId: string) => Promise<GroupCompletedJob | null>
  readGroupAdmission: (
    input: Readonly<{ groupId: string; participant: ConversationParticipantRef }>
  ) => Promise<GroupAdmission | null>
}>

export type JobOutboundPublishInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  groupId: string
  jobId: string
  now: string
  publisher: ConversationParticipantRef
  result: unknown
}>

export type JobOutboundDeliverInput = Readonly<{
  artifact: JobOutboundArtifactClaim | null
  now: string
  /** The record stored at publication; it is sanitized again before release. */
  published: unknown
  recipient: JobOutboundRecipient
}>

/** A missing or mismatched job cannot be evaluated, so nothing is published. */
export type JobOutboundPublishResult =
  | JobOutboundPublicationDecision
  | Readonly<{
      action: 'hold'
      gate: 'job'
      jobId: string
      producerEffect: 'unaffected'
      reason: 'job_unavailable'
    }>

export type JobOutboundResultService = Readonly<{
  deliver: (input: JobOutboundDeliverInput) => Promise<JobOutboundDeliveryDecision>
  publish: (input: JobOutboundPublishInput) => Promise<JobOutboundPublishResult>
}>

export function createJobOutboundResultService(ports: JobOutboundPorts): JobOutboundResultService {
  /** Reads the artifact facts a claim depends on; a claim with no artifact reads nothing. */
  async function readArtifactCurrent(
    claim: JobOutboundArtifactClaim | null,
    result: unknown
  ): Promise<(JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null> {
    if (!claim) return null
    const sanitized = sanitizeJobOutboundResult(result)
    const target = sanitized.ok ? sanitized.result.artifact : null
    const evidence = target
      ? await ports.readArtifactEvidence({
          artifactId: target.artifactId,
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
      const job = await ports.readCompletedJob(input.jobId)
      if (!job || job.jobId !== input.jobId)
        return {
          action: 'hold',
          gate: 'job',
          jobId: input.jobId,
          producerEffect: 'unaffected',
          reason: 'job_unavailable',
        }
      const admission = await ports.readGroupAdmission({
        groupId: input.groupId,
        participant: input.publisher,
      })
      const artifact = await readArtifactCurrent(input.artifact, input.result)
      return decideJobOutboundPublication({
        admission,
        artifact,
        job,
        now: input.now,
        publisher: input.publisher,
        result: input.result,
      })
    },

    async deliver(input) {
      const admission = await ports.readGroupAdmission({
        groupId: input.recipient.groupId,
        participant: input.recipient.participant,
      })
      const artifact = await readArtifactCurrent(input.artifact, input.published)
      return decideJobOutboundDelivery({
        admission,
        artifact,
        now: input.now,
        published: input.published,
        recipient: input.recipient,
      })
    },
  }
}

/**
 * Evidence port backed by the existing access helper. The principal must hold
 * access to the artifact's source workspace; a principal without it reads `null`
 * and the decision refuses with `evidence_unavailable`. Which principal reads at
 * delivery is the caller's decision.
 */
export function artifactEvidenceThroughDatabase(
  database: AgentHqDatabase,
  principal: UserPrincipalRef
): JobOutboundPorts['readArtifactEvidence'] {
  return ({ artifactId, workspaceId }) =>
    readArtifactReferenceEvidence(database, workspaceId, artifactId, principal)
}
