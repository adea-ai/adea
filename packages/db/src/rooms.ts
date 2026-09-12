import type { RoomSummary, UserPrincipalRef } from '@adea-ai/types'
import { and, asc, eq, inArray, max } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { provisionPrimaryRoomChannelInTransaction } from './conversations'
import { channels, rooms, workspaceMemberships } from './schema'
import { appendWorkspaceEvent } from './transactions'

type RoomCreateInput = Readonly<{
  functionKey: string
  layoutRef?: string
  name: string
  spatialRef?: string
  templateKey?: string
}>

type RoomUpdateInput = Readonly<{
  functionKey?: string
  layoutRef?: string | null
  name?: string
  spatialRef?: string | null
  templateKey?: string | null
}>

function roomSummary(row: typeof rooms.$inferSelect): RoomSummary {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    functionKey: row.functionKey,
    id: row.id,
    ...(row.layoutRef ? { layoutRef: row.layoutRef } : {}),
    lifecycleState: row.lifecycleState,
    name: row.name,
    sortOrder: row.sortOrder,
    ...(row.spatialRef ? { spatialRef: row.spatialRef } : {}),
    ...(row.templateKey ? { templateKey: row.templateKey } : {}),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
  })
}

async function requireMembership(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Room unavailable')
}

export async function createRoom(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: RoomCreateInput
): Promise<RoomSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const [position] = await transaction
      .select({ value: max(rooms.sortOrder) })
      .from(rooms)
      .where(and(eq(rooms.workspaceId, workspaceId), eq(rooms.lifecycleState, 'active')))
    const [created] = await transaction
      .insert(rooms)
      .values({
        functionKey: input.functionKey.trim(),
        layoutRef: input.layoutRef?.trim() || null,
        name: input.name.trim(),
        sortOrder: (position?.value ?? -1) + 1,
        spatialRef: input.spatialRef?.trim() || null,
        templateKey: input.templateKey?.trim() || null,
        workspaceId,
      })
      .returning()
    if (!created) throw new Error('Room creation failed')
    await provisionPrimaryRoomChannelInTransaction(
      transaction,
      workspaceId,
      created.id,
      created.name
    )
    await appendWorkspaceEvent(transaction, {
      eventType: 'room.created',
      payload: { actorUserId: principal.userId, roomId: created.id },
      workspaceId,
    })
    return roomSummary(created)
  })
}

export async function listRoomsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<RoomSummary[]> {
  await requireMembership(database, workspaceId, principal)
  const rows = await database
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(rooms.lifecycleState, 'active')])
      )
    )
    .orderBy(asc(rooms.sortOrder), asc(rooms.id))
  return rows.map(roomSummary)
}

export async function getRoomForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  roomId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<RoomSummary | null> {
  const [row] = await database
    .select({ room: rooms })
    .from(rooms)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, rooms.workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(rooms.lifecycleState, 'active')])
      )
    )
    .limit(1)
  return row ? roomSummary(row.room) : null
}

export async function updateRoom(
  database: AgentHqDatabase,
  workspaceId: string,
  roomId: string,
  principal: UserPrincipalRef,
  input: RoomUpdateInput
): Promise<RoomSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const [updated] = await transaction
      .update(rooms)
      .set({
        ...(input.functionKey !== undefined ? { functionKey: input.functionKey.trim() } : {}),
        ...(input.layoutRef !== undefined ? { layoutRef: input.layoutRef?.trim() || null } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.spatialRef !== undefined ? { spatialRef: input.spatialRef?.trim() || null } : {}),
        ...(input.templateKey !== undefined
          ? { templateKey: input.templateKey?.trim() || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rooms.id, roomId),
          eq(rooms.workspaceId, workspaceId),
          eq(rooms.lifecycleState, 'active')
        )
      )
      .returning()
    if (!updated) throw new Error('Room unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'room.updated',
      payload: { actorUserId: principal.userId, roomId },
      workspaceId,
    })
    return roomSummary(updated)
  })
}

export async function archiveRoom(
  database: AgentHqDatabase,
  workspaceId: string,
  roomId: string,
  principal: UserPrincipalRef
): Promise<void> {
  await database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const roomChannels = await transaction
      .select({ id: channels.id, version: channels.version })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.roomId, roomId),
          eq(channels.lifecycleState, 'active')
        )
      )
    for (const channel of roomChannels) {
      await transaction
        .update(channels)
        .set({ lifecycleState: 'archived', updatedAt: new Date(), version: channel.version + 1 })
        .where(and(eq(channels.id, channel.id), eq(channels.workspaceId, workspaceId)))
      await appendWorkspaceEvent(transaction, {
        eventType: 'channel.archived',
        payload: { actorUserId: principal.userId, channelId: channel.id, roomId },
        workspaceId,
      })
    }
    const [archived] = await transaction
      .update(rooms)
      .set({ lifecycleState: 'archived', updatedAt: new Date() })
      .where(
        and(
          eq(rooms.id, roomId),
          eq(rooms.workspaceId, workspaceId),
          eq(rooms.lifecycleState, 'active')
        )
      )
      .returning({ id: rooms.id })
    if (!archived) throw new Error('Room unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'room.archived',
      payload: { actorUserId: principal.userId, roomId },
      workspaceId,
    })
  })
}

export async function reorderRooms(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  roomIds: readonly string[]
): Promise<RoomSummary[]> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const activeRooms = await transaction
      .select()
      .from(rooms)
      .where(and(eq(rooms.workspaceId, workspaceId), eq(rooms.lifecycleState, 'active')))
    if (
      roomIds.length !== activeRooms.length ||
      new Set(roomIds).size !== roomIds.length ||
      activeRooms.some(({ id }) => !roomIds.includes(id))
    ) {
      throw new Error('Room order conflict')
    }
    for (const [sortOrder, roomId] of roomIds.entries()) {
      await transaction
        .update(rooms)
        .set({ sortOrder, updatedAt: new Date() })
        .where(and(eq(rooms.id, roomId), eq(rooms.workspaceId, workspaceId)))
    }
    await appendWorkspaceEvent(transaction, {
      eventType: 'room.reordered',
      payload: { actorUserId: principal.userId, roomIds: [...roomIds] },
      workspaceId,
    })
    const reordered = await transaction
      .select()
      .from(rooms)
      .where(and(eq(rooms.workspaceId, workspaceId), inArray(rooms.id, [...roomIds])))
      .orderBy(asc(rooms.sortOrder), asc(rooms.id))
    return reordered.map(roomSummary)
  })
}
