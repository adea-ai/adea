import { and, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withAuthorizedLeadTurn } from './lead-turns'
import { isLeadTurnProductSelector } from './lead-turn-product-selectors'
import { leadTurnIntents } from './schema/lead-turns'
import { workspaces } from './schema/workspaces'

/** Private canonical product evidence. This is not runtime, funding or transport authority. */
export type CurrentLeadTurnProduct = Readonly<{
  workspaceId: string
  controlPlaneWorkspaceId: string
  intentId: string
  intentCreatedAt: string
  channelId: string
  channelVersion: number
  channelVisibility: 'workspace' | 'participants'
  audience: readonly string[]
  messageId: string
  messageVersion: number
  actorUserId: string
  agentId: string
  controlPlaneAgentId: string
  profileId: string
  profileVersion: string
  profileRevision: number
  prompt: string
}>

/**
 * Trusted in-process reader: selectors resolve the exact mapped workspace and stored
 * original actor. Current actor, designated lead, profile, message and complete audience
 * authority remain locked until the canonical evidence is read. No caller grants are accepted.
 */
export async function readCurrentLeadTurnProduct(
  database: AgentHqDatabase | AgentHqTransaction,
  controlPlaneWorkspaceId: string,
  intentId: string
): Promise<CurrentLeadTurnProduct | undefined> {
  if (!isLeadTurnProductSelector(controlPlaneWorkspaceId, intentId)) return undefined
  return database.transaction(async (tx) => {
    // Resolve selectors without early locks. The canonical helper owns lock order,
    // then checks this mapping again while its current workspace lock is held.
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.controlPlaneWorkspaceId, controlPlaneWorkspaceId),
          isNull(workspaces.deletedAt)
        )
      )
    if (!workspace) return undefined
    const [original] = await tx
      .select({ id: leadTurnIntents.id, actorUserId: leadTurnIntents.actorUserId })
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspace.id)))
    if (!original) return undefined
    return withAuthorizedLeadTurn(
      tx,
      workspace.id,
      original.id,
      { kind: 'user', userId: original.actorUserId },
      true,
      async (_locked, intent, message, mappedWorkspaceId) => {
        if (
          mappedWorkspaceId !== controlPlaneWorkspaceId ||
          message.channelId !== intent.channelId ||
          message.senderKind !== 'user' ||
          message.senderUserId !== original.actorUserId ||
          message.version !== 1 ||
          message.editedAt ||
          message.executionRef ||
          message.externalSessionRef ||
          message.bodyContentRefId ||
          typeof message.bodyText !== 'string' ||
          !message.bodyText.trim() ||
          message.bodyText.length > 1_000_000 ||
          intent.audience.length > 256 ||
          intent.audience.some((ref) => typeof ref !== 'string' || ref.length > 256) ||
          intent.profileId.length > 256 ||
          intent.profileVersion.length > 256 ||
          !['workspace', 'participants'].includes(intent.channelVisibility)
        )
          throw new Error('Lead turn unavailable')
        return Object.freeze({
          workspaceId: workspace.id,
          controlPlaneWorkspaceId: mappedWorkspaceId,
          intentId: intent.id,
          intentCreatedAt: intent.createdAt.toISOString(),
          channelId: intent.channelId,
          channelVersion: intent.channelVersion,
          channelVisibility: intent.channelVisibility as 'workspace' | 'participants',
          audience: Object.freeze([...intent.audience]),
          messageId: message.id,
          messageVersion: message.version,
          actorUserId: intent.actorUserId,
          agentId: intent.agentId,
          controlPlaneAgentId: intent.controlPlaneAgentId,
          profileId: intent.profileId,
          profileVersion: intent.profileVersion,
          profileRevision: intent.profileRevision,
          prompt: message.bodyText,
        })
      }
    )
  })
}
