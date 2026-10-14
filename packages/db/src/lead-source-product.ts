import { workspaceRolePermissions } from '@adea-ai/auth/authorization'
import type { WorkspacePermission } from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { admissionInForce, loadGroupAdmission } from './group-participation-store'
import { withCurrentLeadTurnProduct, type CurrentLeadTurnProduct } from './lead-turn-product'
import { isLeadTurnProductSelector } from './lead-turn-product-selectors'
import { agents, leadTurnIntents, users, workspaceMemberships, workspaces } from './schema'

export type CurrentSourceLeadTurnProduct = CurrentLeadTurnProduct &
  Readonly<{
    sourceControlPlaneWorkspaceId: string
    enlistmentGrantId: string
    enlistmentRevision: number
  }>

/** Candidate in-process source reader; the existing guarded HTTP reader stays unchanged.
 * Selectors name source execution scope, while host conversation authority is
 * derived solely from the canonical intent. No credential, grant or payer is issued.
 * Callers must independently verify existing service authority in both workspaces.
 */
export async function withCurrentSourceLeadTurnProduct<T>(
  database: AgentHqDatabase | AgentHqTransaction,
  sourceControlPlaneWorkspaceId: string,
  intentId: string,
  disclose: (product: CurrentSourceLeadTurnProduct) => Promise<T>
): Promise<T | undefined> {
  if (!isLeadTurnProductSelector(sourceControlPlaneWorkspaceId, intentId)) return undefined
  return database.transaction(async (tx) => {
    // Resolve identities without locks; revalidate each under its canonical locks.
    const [resolved] = await tx
      .select({
        hostWorkspaceId: leadTurnIntents.workspaceId,
        actorUserId: leadTurnIntents.actorUserId,
        agentWorkspaceId: agents.workspaceId,
      })
      .from(leadTurnIntents)
      .innerJoin(agents, eq(agents.id, leadTurnIntents.agentId))
      .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(
        and(
          eq(leadTurnIntents.id, intentId),
          eq(workspaces.controlPlaneWorkspaceId, sourceControlPlaneWorkspaceId)
        )
      )
      .limit(1)
    if (!resolved || resolved.hostWorkspaceId === resolved.agentWorkspaceId) return undefined

    // Original actor's users row first. Canonical workspace management (reorder,
    // create, claim) takes this row FOR UPDATE before it writes any membership, so
    // taking the shared form before our membership SHARE locks keeps every path in
    // one order and removes the membership cycle (SQLSTATE 40P01) with reorder.
    // Readers share it; only management writers for this actor wait behind us.
    const [actorRow] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, resolved.actorUserId))
      .for('share')
      .limit(1)
    if (!actorRow) throw new Error('Lead turn unavailable')

    // Actor users row -> source membership -> source workspace -> canonical
    // host/channel/Agent: source rows precede the Agent lock, as in enlistment.
    const [membership] = await tx
      .select({ role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, resolved.agentWorkspaceId),
          eq(workspaceMemberships.userId, resolved.actorUserId)
        )
      )
      .for('share')
      .limit(1)
    if (
      !membership ||
      !new Set<WorkspacePermission>(workspaceRolePermissions[membership.role]).has('runtime.invoke')
    )
      throw new Error('Lead turn unavailable')
    const [source] = await tx
      .select({ id: workspaces.id, controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, resolved.agentWorkspaceId),
          eq(workspaces.controlPlaneWorkspaceId, sourceControlPlaneWorkspaceId),
          isNull(workspaces.deletedAt),
          isNull(workspaces.deletionRequestedAt)
        )
      )
      .for('share')
      .limit(1)
    if (!source) throw new Error('Lead turn unavailable')
    const [host] = await tx
      .select({ controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, resolved.hostWorkspaceId))
      .limit(1)
    if (!host || host.controlPlaneWorkspaceId === source.controlPlaneWorkspaceId)
      throw new Error('Lead turn unavailable')
    return withCurrentLeadTurnProduct(
      tx,
      host.controlPlaneWorkspaceId,
      intentId,
      async (product) => {
        if (
          product.workspaceId !== resolved.hostWorkspaceId ||
          product.agentWorkspaceId !== source.id ||
          product.actorUserId !== resolved.actorUserId
        )
          throw new Error('Lead turn unavailable')
        const enlistment = await loadGroupAdmission(
          tx,
          product.workspaceId,
          product.channelId,
          {
            kind: 'agent',
            agentId: product.agentId,
          },
          { forUpdate: true }
        )
        if (!admissionInForce(enlistment, product.channelId, new Date().toISOString()))
          throw new Error('Lead turn unavailable')
        // The host helper's earlier clock can precede waits on Agent/message
        // locks. Re-read the original human's window after every awaited lock,
        // immediately before disclosure, without refreshing the grant's expiry.
        const actor = await loadGroupAdmission(
          tx,
          product.workspaceId,
          product.channelId,
          {
            kind: 'user',
            userId: product.actorUserId,
          },
          { forUpdate: true }
        )
        const disclosureAt = new Date().toISOString()
        if (
          !admissionInForce(actor, product.channelId, disclosureAt) ||
          !admissionInForce(enlistment, product.channelId, disclosureAt)
        )
          throw new Error('Lead turn unavailable')
        const result = await disclose(
          Object.freeze({
            ...product,
            sourceControlPlaneWorkspaceId: source.controlPlaneWorkspaceId,
            enlistmentGrantId: enlistment!.authorization.grantId,
            enlistmentRevision: enlistment!.authorization.revision,
          })
        )
        // A private response may await final service verification. Locked grant
        // rows cannot be revoked concurrently, but their fixed expiry can lapse.
        const acceptedAt = new Date().toISOString()
        if (
          !admissionInForce(actor, product.channelId, acceptedAt) ||
          !admissionInForce(enlistment, product.channelId, acceptedAt)
        )
          throw new Error('Lead turn unavailable')
        return result
      }
    )
  })
}
