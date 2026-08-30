import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveRoom,
  createRoom,
  getRoomForUser,
  listRoomsForUser,
  reorderRooms,
  updateRoom,
} from '../../src/rooms'
import {
  rooms,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('room persistence and isolation', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('persists, reorders, updates, archives, and isolates rooms', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `room-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `room-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'rooms',
      name: 'Room HQ',
      owner: owner.principal,
      scene: 'work',
    })

    const engineering = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'engineering',
      layoutRef: 'layout:work/engineering',
      name: 'Engineering',
      templateKey: 'work.engineering',
    })
    const operations = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'operations',
      name: 'Operations',
    })

    expect(await listRoomsForUser(connection.db, workspace.id, owner.principal)).toEqual([
      engineering,
      operations,
    ])
    expect(
      await getRoomForUser(connection.db, workspace.id, engineering.id, outsider.principal)
    ).toBeNull()
    await expect(
      updateRoom(connection.db, workspace.id, engineering.id, outsider.principal, {
        name: 'Leaked',
      })
    ).rejects.toThrow('Room unavailable')

    const reordered = await reorderRooms(connection.db, workspace.id, owner.principal, [
      operations.id,
      engineering.id,
    ])
    expect(reordered.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
      [operations.id, 0],
      [engineering.id, 1],
    ])

    const updated = await updateRoom(connection.db, workspace.id, engineering.id, owner.principal, {
      name: 'Product Engineering',
      spatialRef: 'space:room/product-engineering',
    })
    expect(updated.name).toBe('Product Engineering')
    expect(updated.spatialRef).toBe('space:room/product-engineering')

    await archiveRoom(connection.db, workspace.id, operations.id, owner.principal)
    expect(await listRoomsForUser(connection.db, workspace.id, owner.principal)).toEqual([
      expect.objectContaining({ id: engineering.id, lifecycleState: 'active' }),
    ])

    await connection.db.delete(rooms).where(eq(rooms.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    for (const principal of [owner.principal, outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  })

  test('rejects incomplete, duplicate, and cross-workspace reorder requests', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `room-order-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const firstWorkspace = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'room-order-a',
      name: 'First HQ',
      owner: owner.principal,
    })
    const secondWorkspace = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'room-order-b',
      name: 'Second HQ',
      owner: owner.principal,
    })
    const first = await createRoom(connection.db, firstWorkspace.workspace.id, owner.principal, {
      functionKey: 'general',
      name: 'First',
    })
    const second = await createRoom(connection.db, firstWorkspace.workspace.id, owner.principal, {
      functionKey: 'general',
      name: 'Second',
    })
    const other = await createRoom(connection.db, secondWorkspace.workspace.id, owner.principal, {
      functionKey: 'general',
      name: 'Other',
    })

    await expect(
      reorderRooms(connection.db, firstWorkspace.workspace.id, owner.principal, [first.id])
    ).rejects.toThrow('Room order conflict')
    await expect(
      reorderRooms(connection.db, firstWorkspace.workspace.id, owner.principal, [
        first.id,
        first.id,
      ])
    ).rejects.toThrow('Room order conflict')
    await expect(
      reorderRooms(connection.db, firstWorkspace.workspace.id, owner.principal, [
        first.id,
        other.id,
      ])
    ).rejects.toThrow('Room order conflict')

    for (const workspaceId of [firstWorkspace.workspace.id, secondWorkspace.workspace.id]) {
      await connection.db.delete(rooms).where(eq(rooms.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    expect(second.id).not.toBe(first.id)
  })
})
