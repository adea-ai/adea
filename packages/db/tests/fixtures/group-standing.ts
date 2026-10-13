import { and, eq } from 'drizzle-orm'

import type { AgentHqDatabase } from '../../src/connection'
import {
  channelParticipants,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
} from '../../src/schema'

type Member = Readonly<{ agentId: string } | { userId: string }>

/**
 * Put a participant into a group the way the product holds one: a participant row, a live grant,
 * and an admission that names it. Direct row inserts no longer make a group readable, because the
 * canonical readers serve a group only to participants whose admission is in force.
 */
export async function admitGroupMember(
  database: AgentHqDatabase,
  input: Readonly<{
    channelId: string
    joinedSequence?: number
    member: Member
    workspaceId: string
  }>
): Promise<void> {
  const { channelId, member, workspaceId } = input
  const issuedAt = new Date().toISOString()
  const base = { channelId, issuedAt, revision: 1, workspaceId }
  if ('userId' in member) {
    const grantId = `test:audience:${member.userId}`
    await database
      .insert(groupAudienceGrants)
      .values({ ...base, grantId, userId: member.userId })
      .onConflictDoNothing()
    await database
      .insert(channelParticipants)
      .values({ channelId, principalKind: 'user', userId: member.userId, workspaceId })
    await database.insert(groupAdmissions).values({
      authGrantId: grantId,
      authGroupId: channelId,
      authRevision: 1,
      channelId,
      joinedAt: issuedAt,
      joinedSequence: input.joinedSequence ?? 0,
      principalKind: 'user',
      userId: member.userId,
      workspaceId,
    })
    return
  }
  const grantId = `test:enlistment:${member.agentId}`
  await database
    .insert(groupEnlistmentGrants)
    .values({ ...base, agentId: member.agentId, grantId })
    .onConflictDoNothing()
  await database
    .insert(channelParticipants)
    .values({ agentId: member.agentId, channelId, principalKind: 'agent', workspaceId })
  await database.insert(groupAdmissions).values({
    agentId: member.agentId,
    authGrantId: grantId,
    authGroupId: channelId,
    authRevision: 1,
    channelId,
    joinedAt: issuedAt,
    joinedSequence: input.joinedSequence ?? 0,
    principalKind: 'agent',
    workspaceId,
  })
}

/** Remove a user from a group: the admission, then the participant row. */
export async function withdrawGroupUser(
  database: AgentHqDatabase,
  input: Readonly<{ channelId: string; userId: string }>
): Promise<void> {
  await database
    .delete(groupAdmissions)
    .where(
      and(eq(groupAdmissions.channelId, input.channelId), eq(groupAdmissions.userId, input.userId))
    )
  await database
    .delete(channelParticipants)
    .where(
      and(
        eq(channelParticipants.channelId, input.channelId),
        eq(channelParticipants.userId, input.userId)
      )
    )
}
