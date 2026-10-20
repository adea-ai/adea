import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { createRuntimeResultMessage } from './conversations'
import { assertLeadTurnNotFenced } from './lead-turn-rollback'
import type { LeadTurnRuntimeBinding } from './lead-turn-runtime'
import { withAuthorizedLeadTurn } from './lead-turns'
import { leadChildPublications } from './schema/lead-child-publications'
import { leadTurnRuntime } from './schema/lead-turn-runtime'

const childId = /^dlg_[0-9A-HJKMNP-TV-Z]{26}$/
const executionId = /^exe_[0-9A-HJKMNP-TV-Z]{26}$/
const attemptId = /^att_[0-9A-HJKMNP-TV-Z]{26}$/
const artifactId = /^art_[0-9A-HJKMNP-TV-Z]{26}$/
const role = /^[A-Za-z0-9._:/-]{1,256}$/

/** Authenticated CP J1 terminal evidence, never a browser-supplied result or artifact read grant. */
export type LeadChildTerminalEvidence = Readonly<{
  delegationId: string
  childExecutionId: string
  childAttemptId: string
  role: string
  state: 'completed' | 'failed' | 'cancelled'
  resultRef?: string
  conclusion?: string
  failureCode?: string
  publication: 'published'
}>

function validated(evidence: LeadChildTerminalEvidence): LeadChildTerminalEvidence {
  if (
    !childId.test(evidence.delegationId) ||
    !executionId.test(evidence.childExecutionId) ||
    !attemptId.test(evidence.childAttemptId) ||
    !role.test(evidence.role) ||
    evidence.publication !== 'published' ||
    !['completed', 'failed', 'cancelled'].includes(evidence.state) ||
    (evidence.state === 'completed'
      ? !evidence.resultRef ||
        !artifactId.test(evidence.resultRef) ||
        evidence.failureCode !== undefined
      : evidence.resultRef !== undefined || evidence.conclusion !== undefined) ||
    (evidence.conclusion !== undefined &&
      (typeof evidence.conclusion !== 'string' ||
        evidence.conclusion.length < 1 ||
        evidence.conclusion.length > 1024 ||
        new TextEncoder().encode(evidence.conclusion).byteLength > 1024 ||
        evidence.conclusion !== evidence.conclusion.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(evidence.conclusion))) ||
    (evidence.failureCode !== undefined &&
      (evidence.state !== 'failed' || !role.test(evidence.failureCode)))
  )
    throw new Error('CHILD_PUBLICATION_WITHHELD')
  return evidence
}

function summary(evidence: LeadChildTerminalEvidence): string {
  if (evidence.state === 'completed')
    return evidence.conclusion
      ? `Child ${evidence.role} completed: ${evidence.conclusion}`
      : `Child ${evidence.role} completed.`
  if (evidence.state === 'failed') return `Child ${evidence.role} failed.`
  return `Child ${evidence.role} was cancelled.`
}

/**
 * Commits one canonical Adea message and its own publication receipt. The caller must have
 * authenticated and matched CP's retained J1 event to this parent/child attempt; the required
 * grant callback is a CP-only, lock-safe current publication check. It may not call Adea's
 * product reader while these canonical locks are held.
 */
export function publishLeadChildTerminal(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  reader: UserPrincipalRef,
  binding: LeadTurnRuntimeBinding,
  terminal: LeadChildTerminalEvidence,
  assertCurrentGrant: (transaction: AgentHqTransaction) => Promise<void>
) {
  const evidence = validated(terminal)
  if (typeof assertCurrentGrant !== 'function') throw new Error('CHILD_PUBLICATION_WITHHELD')
  return withAuthorizedLeadTurn(database, workspaceId, intentId, reader, false, (tx, intent) =>
    withAuthorizedLeadTurn(
      tx,
      workspaceId,
      intentId,
      { kind: 'user', userId: intent.actorUserId },
      true,
      async (publicationTx, admitted) => {
        const [row] = await publicationTx
          .select()
          .from(leadTurnRuntime)
          .where(eq(leadTurnRuntime.intentId, admitted.id))
          .for('update')
        if (
          !row ||
          row.intentId !== binding.intentId ||
          row.dispatchId !== binding.dispatchId ||
          row.executionId !== binding.executionId ||
          row.attemptId !== binding.attemptId ||
          row.runtimeSessionId !== binding.runtimeSessionId
        )
          throw new Error('CHILD_PUBLICATION_WITHHELD')
        await assertLeadTurnNotFenced(publicationTx, admitted.id, 'share')
        await assertCurrentGrant(publicationTx)
        const digest = createHash('sha256')
          .update(JSON.stringify({ binding, evidence }))
          .digest('hex')
        const [existing] = await publicationTx
          .select()
          .from(leadChildPublications)
          .where(
            and(
              eq(leadChildPublications.intentId, admitted.id),
              eq(leadChildPublications.delegationId, evidence.delegationId)
            )
          )
          .for('update')
        if (existing) {
          if (
            existing.outcomeDigest !== digest ||
            existing.childExecutionId !== evidence.childExecutionId ||
            existing.childAttemptId !== evidence.childAttemptId
          )
            throw new Error('CHILD_PUBLICATION_CONFLICT')
          return existing.messageId
        }
        const message = await createRuntimeResultMessage(
          publicationTx,
          workspaceId,
          admitted.channelId,
          { kind: 'user', userId: admitted.actorUserId },
          {
            sender: { kind: 'agent', agentId: admitted.agentId },
            bodyText: summary(evidence),
            executionRef: row.executionId,
            externalSessionRef: row.runtimeSessionId,
            idempotencyKey: `lead-child:${admitted.id}:${evidence.delegationId}`,
          }
        )
        await publicationTx.insert(leadChildPublications).values({
          intentId: admitted.id,
          delegationId: evidence.delegationId,
          childExecutionId: evidence.childExecutionId,
          childAttemptId: evidence.childAttemptId,
          outcomeDigest: digest,
          messageId: message.id,
        })
        return message.id
      }
    )
  )
}
