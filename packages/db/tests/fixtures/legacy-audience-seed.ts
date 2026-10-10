import { and, eq, sql } from 'drizzle-orm'

import type { UserPrincipalRef } from '@adea-ai/types'

import { createAgent } from '../../src/agents'
import type { AgentHqDatabase } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { channelParticipants, channels, workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

// Legacy group data for the #1222 upgrade fixtures: the shape the pre-#1232 product wrote. Only
// channels, participant rows and workspace memberships are written, directly, because the current
// product path would also write group admissions and grants that the stage-one schema lacks. Users,
// workspaces and agents go through their product functions.
export type LegacyAudienceSeed = Readonly<{
  workspaceId: string
  activeGroupId: string
  archivedGroupId: string
  owner: UserPrincipalRef
  member: UserPrincipalRef
  removed: UserPrincipalRef
  removedUserId: string
  otherWorkspaceAgentId: string
  otherWorkspaceId: string
}>

/**
 * `runtime` runs product calls as the runtime role. `migration` writes the legacy rows, which the
 * pre-#1232 product wrote as data, so it is the migration role's job.
 */
export async function seedLegacyAudience(input: {
  migration: AgentHqDatabase
  runtime: AgentHqDatabase
}): Promise<LegacyAudienceSeed> {
  const { migration, runtime } = input
  const session = async (name: string) =>
    (
      await createTemporaryUserSession(runtime, {
        credentialDigest: `quarantine-${name}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  const owner = await session('owner')
  const member = await session('member')
  const removed = await session('removed')
  const otherOwner = await session('other-owner')

  const { workspace } = await createWorkspaceWithOwner(runtime, {
    idempotencyKey: `quarantine-${crypto.randomUUID()}`,
    name: 'Quarantine HQ',
    owner,
  })
  const workspaceId = workspace.id
  await migration.insert(workspaceMemberships).values([
    { role: 'member', userId: member.userId, workspaceId },
    { role: 'member', userId: removed.userId, workspaceId },
  ])

  const { workspace: otherWorkspace } = await createWorkspaceWithOwner(runtime, {
    idempotencyKey: `quarantine-other-${crypto.randomUUID()}`,
    name: 'Quarantine other',
    owner: otherOwner,
  })
  const agent = await createAgent(runtime, otherWorkspace.id, otherOwner, {
    name: 'Other Agent',
    profileId: 'software-engineer',
    profileVersion: '1.0.0',
  })

  // Active group: owner, member, the about-to-leave user, and an agent from another workspace.
  const activeGroupId = await insertLegacyGroup(
    migration,
    workspaceId,
    owner,
    'Quarantine active group'
  )
  await migration.insert(channelParticipants).values([
    { channelId: activeGroupId, principalKind: 'user', userId: member.userId, workspaceId },
    { channelId: activeGroupId, principalKind: 'user', userId: removed.userId, workspaceId },
    { channelId: activeGroupId, principalKind: 'agent', agentId: agent.id, workspaceId },
  ])

  // Archived group whose legacy participants are still on record.
  const archivedGroupId = await insertLegacyGroup(
    migration,
    workspaceId,
    owner,
    'Quarantine archived group'
  )
  await migration.insert(channelParticipants).values({
    channelId: archivedGroupId,
    principalKind: 'user',
    userId: member.userId,
    workspaceId,
  })
  await migration
    .update(channels)
    .set({ lifecycleState: 'archived' })
    .where(eq(channels.id, archivedGroupId))

  // The removed user leaves the workspace; the legacy participant row remains.
  await migration
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, removed.userId)
      )
    )

  return {
    activeGroupId,
    archivedGroupId,
    member,
    otherWorkspaceAgentId: agent.id,
    otherWorkspaceId: otherWorkspace.id,
    owner,
    removed,
    removedUserId: removed.userId,
    workspaceId,
  }
}

/**
 * A legacy group channel and its creator's participant row, as the pre-#1232 product wrote them.
 * `archived` writes the lifecycle the legacy archive left behind.
 */
export async function insertLegacyGroup(
  migration: AgentHqDatabase,
  workspaceId: string,
  creator: UserPrincipalRef,
  title: string,
  options: Readonly<{ archived?: boolean }> = {}
): Promise<string> {
  // Named columns only: the typed insert would name `archive_source`, which 0048 adds, so an earlier
  // stage would reject it. The legacy writer never knew about columns that did not exist yet.
  const [row] = (await migration.execute<{ id: string }>(sql`
    insert into app.channels (workspace_id, kind, visibility, title, lifecycle_state, idempotency_key)
    values (${workspaceId}::uuid, 'group', 'participants', ${title},
      ${options.archived ? 'archived' : 'active'}, ${`legacy-${crypto.randomUUID()}`})
    returning id`)) as unknown as { id: string }[]
  if (!row) throw new Error('legacy group insert returned no row')
  // The legacy writer always made the creator a participant.
  await migration.insert(channelParticipants).values({
    channelId: row.id,
    principalKind: 'user',
    userId: creator.userId,
    workspaceId,
  })
  return row.id
}

/**
 * A legacy user message in a group channel: the row the pre-#1232 product wrote. The sequence is the
 * table's identity, and the channel's denormalized latest sequence follows it as the product did.
 */
export async function insertLegacyMessage(
  migration: AgentHqDatabase,
  input: Readonly<{
    bodyText: string
    channelId: string
    sender: UserPrincipalRef
    workspaceId: string
  }>
): Promise<number> {
  const [row] = (await migration.execute<{ sequence: number }>(sql`
    with inserted as (
      insert into app.messages (workspace_id, channel_id, sender_kind, sender_user_id, body_text,
        idempotency_key, create_payload_hash)
      values (${input.workspaceId}::uuid, ${input.channelId}::uuid, 'user', ${input.sender.userId}::uuid,
        ${input.bodyText}, ${`legacy-message-${crypto.randomUUID()}`}, ${`legacy-${crypto.randomUUID()}`})
      returning sequence
    ), latest as (
      update app.channels set latest_message_sequence = (select sequence from inserted)
      where id = ${input.channelId}::uuid
    )
    select sequence from inserted`)) as unknown as { sequence: number }[]
  if (!row) throw new Error('legacy message insert returned no row')
  return row.sequence
}

/** A legacy task row with the columns the pre-cutover state has; the product writer names more. */
export async function insertLegacyTask(
  migration: AgentHqDatabase,
  input: Readonly<{ creatorUserId: string; objective: string; title: string; workspaceId: string }>
): Promise<string> {
  const [row] = (await migration.execute<{ id: string }>(sql`
    insert into app.tasks (workspace_id, creator_user_id, title, objective)
    values (${input.workspaceId}::uuid, ${input.creatorUserId}::uuid, ${input.title}, ${input.objective})
    returning id`)) as unknown as { id: string }[]
  if (!row) throw new Error('legacy task insert returned no row')
  return row.id
}

/** A legacy channel read state at the latest sequence the owner had seen, as the read-state writer left it. */
export async function insertLegacyReadState(
  migration: AgentHqDatabase,
  input: Readonly<{
    channelId: string
    lastReadSequence: number
    userId: string
    workspaceId: string
  }>
): Promise<void> {
  await migration.execute(sql`
    insert into app.channel_read_states (workspace_id, user_id, channel_id, last_read_sequence)
    values (${input.workspaceId}::uuid, ${input.userId}::uuid, ${input.channelId}::uuid, ${input.lastReadSequence})`)
}

/** A legacy project membership row: the product writer's table and role, with no later columns. */
export async function insertLegacyProjectMember(
  migration: AgentHqDatabase,
  input: Readonly<{
    projectId: string
    role: 'editor' | 'viewer'
    userId: string
    workspaceId: string
  }>
): Promise<void> {
  await migration.execute(sql`
    insert into app.project_members (workspace_id, project_id, user_id, role)
    values (${input.workspaceId}::uuid, ${input.projectId}::uuid, ${input.userId}::uuid, ${input.role})`)
}

/**
 * A legacy workspace project. The product writer also names `version` and `source_kind`, which
 * 0048 adds after the pre-cutover state, so the legacy row names only the columns that existed then.
 */
export async function insertLegacyProject(
  migration: AgentHqDatabase,
  workspaceId: string,
  name: string
): Promise<string> {
  const [row] = (await migration.execute<{ id: string }>(sql`
    insert into app.projects (workspace_id, name, icon_key)
    values (${workspaceId}::uuid, ${name}, 'folder')
    returning id`)) as unknown as { id: string }[]
  if (!row) throw new Error('legacy project insert returned no row')
  return row.id
}
