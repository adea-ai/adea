import { sql } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'

/**
 * The lock that orders launch-code issuance against the end of a workspace's Sim authority.
 *
 * A sweep that spends codes and revokes sessions cannot see an INSERT another transaction has not
 * committed, so an issuance caught in flight would survive a withdrawal. Issuance therefore holds a
 * shared lock on the workspace for its whole transaction, and every sweep takes the exclusive lock
 * before it reads anything: a sweep waits for the issuances already in flight and then sees them
 * committed, and an issuance that starts later waits for the sweep. The lock is per workspace, not
 * per surface, and ends with the transaction that took it.
 *
 * Advisory locks need no table privilege, so this adds nothing to any database role. The key is the
 * lowercased workspace identifier, matching how the sweeps compare identifiers.
 */
const NAMESPACE = 'adea.sim-authority'

export async function lockSimIssuance(
  transaction: AgentHqTransaction,
  workspaceId: string
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock_shared(hashtext(${NAMESPACE}), hashtext(${workspaceId.toLowerCase()}))`
  )
}

export async function lockSimAuthorityEnd(
  transaction: AgentHqTransaction,
  workspaceId: string
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${NAMESPACE}), hashtext(${workspaceId.toLowerCase()}))`
  )
}
