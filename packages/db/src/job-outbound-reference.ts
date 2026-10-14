/*
 * References to separately owned jobs (M15 #1217).
 *
 * A cross-workspace plan may point at a job another workspace owns. The pointer is a job id and
 * nothing else: it confers no authority over the job and carries none of its private context.
 * The job's title, objective, state, artifacts, runtime and participants stay in its source
 * workspace. A reader learns only whether the job's result is currently released to them, and
 * where.
 *
 * "Released to the reader" is the canonical delivery decision, taken through the same batch gate
 * that history, search, counts and events use (`readerVisiblePublicationIds`). It judges the
 * publication binding, the job, the original actor's source access, the artifact grant, and the
 * reader's membership and participation at the bound channel revision. This module adds no
 * authority rule of its own. It only looks up the publication messages a plan could mean.
 *
 * Every other case is `unavailable`, and the cases are not told apart: an unknown id, a job that
 * has not completed or published, a result held or revoked, a publication in another channel, a
 * job the reader's workspace owns, a reader who left the group. An answer that named the reason
 * would let a plan author probe a job it was never given.
 */
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'

import type { AgentHqDatabase } from './connection'
import { JOB_OUTBOUND_SENDER_PREFIX } from './job-outbound-binding'
import { readerVisiblePublicationIds } from './job-outbound-visibility'
import { messages } from './schema'

/** A plan may cite this many jobs in one resolution; more is refused, never truncated. */
export const JOB_REFERENCE_MAX_BATCH = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * What a plan may show for one referenced job. `authority: 'none'` is the whole contract: holding
 * this value lets nobody read, change, cancel, complete or re-run the job. `messageId` names the
 * publication the reader can already open in the channel.
 */
export type JobReferenceView =
  | Readonly<{ authority: 'none'; availability: 'available'; jobId: string; messageId: string }>
  | Readonly<{ authority: 'none'; availability: 'unavailable'; jobId: string }>

export type ResolveJobReferencesInput = Readonly<{
  /** The group channel that carries the plan. */
  channelId: string
  jobIds: readonly string[]
  reader: UserPrincipalRef
  /** The workspace that holds that channel. */
  workspaceId: string
}>

/** Refused before any read: more references than one resolution takes. */
export class JobReferenceBatchError extends Error {
  constructor() {
    super('Too many job references')
    this.name = 'JobReferenceBatchError'
  }
}

function unavailable(jobId: string): JobReferenceView {
  return { authority: 'none', availability: 'unavailable', jobId }
}

/**
 * Resolves the jobs a plan cites, for one reader, in the order cited (a repeated id resolves once,
 * at its first position). A malformed id is `unavailable`. The reads run in one transaction that
 * holds the publication, artifact and grant locks to the decision, so a revocation or roster change
 * that commits after the read orders after it, and the next resolution reflects it.
 */
export async function resolveJobReferences(
  database: AgentHqDatabase,
  input: ResolveJobReferencesInput
): Promise<readonly JobReferenceView[]> {
  if (input.jobIds.length > JOB_REFERENCE_MAX_BATCH) throw new JobReferenceBatchError()
  // Task ids are stored lowercase. A cited id differing only in case is the same job, and is
  // reported as cited.
  const first = new Map<string, string>()
  for (const jobId of input.jobIds)
    if (!first.has(jobId.toLowerCase())) first.set(jobId.toLowerCase(), jobId)
  const jobIds = [...first.values()]
  const wellFormed = jobIds.filter((jobId) => UUID.test(jobId)).map((jobId) => jobId.toLowerCase())
  const released = new Map<string, string>()
  if (wellFormed.length && UUID.test(input.channelId) && UUID.test(input.workspaceId)) {
    // Candidates are the job-outbound system messages in this channel. Forged lookalikes are
    // included on purpose: the delivery decision refuses them, and a decision is never skipped.
    const candidates = await database
      .select({
        executionRef: messages.executionRef,
        id: messages.id,
        senderKind: messages.senderKind,
        senderSystemId: messages.senderSystemId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, input.workspaceId),
          eq(messages.channelId, input.channelId),
          eq(messages.senderKind, 'system'),
          inArray(messages.executionRef, wellFormed),
          like(messages.senderSystemId, `${JOB_OUTBOUND_SENDER_PREFIX}%`)
        )
      )
      .orderBy(asc(messages.sequence))
    const visible = await readerVisiblePublicationIds(database, candidates, input.reader.userId)
    for (const candidate of candidates) {
      // The earliest released publication names the job; a job has one per destination.
      if (
        candidate.executionRef &&
        visible.has(candidate.id) &&
        !released.has(candidate.executionRef)
      )
        released.set(candidate.executionRef, candidate.id)
    }
  }
  return jobIds.map((jobId): JobReferenceView => {
    const messageId = released.get(jobId.toLowerCase())
    return messageId
      ? { authority: 'none', availability: 'available', jobId, messageId }
      : unavailable(jobId)
  })
}
