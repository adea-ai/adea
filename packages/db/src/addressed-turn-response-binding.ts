import { and, eq, sql } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import { addressedAgentTurns } from './schema/addressed-agent-turns'

/**
 * Binds the Agent's published answer to the addressed turn that dispatched its lead-turn intent
 * (M15.02, adea-ai/adea#1179), inside the publication transaction that holds the intent's canonical locks.
 * The claim row is the one slot per (message, Agent, revision), so a replayed publication converges on the
 * same response. Only live claims (`claimed`, `dispatching`) move: a turn a newer human message superseded
 * or an addresser cancelled keeps that terminal state, and the published message stays ordinary channel
 * history. The claim is matched by the intent bound at dispatch, never by Agent or channel alone.
 */
export async function bindAddressedTurnResponse(
  transaction: AgentHqTransaction,
  workspaceId: string,
  intentId: string,
  responseMessageId: string
): Promise<void> {
  await transaction
    .update(addressedAgentTurns)
    .set({ responseMessageId, state: 'responded' })
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.intentId, intentId),
        sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
      )
    )
}
