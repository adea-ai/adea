import { workspaceRolePermissions } from '@adea-ai/auth/authorization'
import type { WorkspacePermission } from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { admissionInForce, loadGroupAdmission } from './group-participation-store'
import { withCurrentLeadTurnProduct, type CurrentLeadTurnProduct } from './lead-turn-product'
import { isLeadTurnProductSelector } from './lead-turn-product-selectors'
import { agents, leadTurnIntents, workspaceMemberships, workspaces } from './schema'

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

    // Source membership -> source workspace -> canonical host/channel/Agent:
    // source rows precede the Agent lock, as they do during enlistment.
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
        return disclose(
          Object.freeze({
            ...product,
            sourceControlPlaneWorkspaceId: source.controlPlaneWorkspaceId,
            enlistmentGrantId: enlistment!.authorization.grantId,
            enlistmentRevision: enlistment!.authorization.revision,
          })
        )
      }
    )
  })
}
