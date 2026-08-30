import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  archiveChannel,
  createDirectAgentChannel,
  createGroupChannel,
  createMessage,
  createRoomChannel,
  deleteMessage,
  editMessage,
  listChannelsForUser,
  listMessagesForUser,
  provisionPrimaryRoomChannel,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { archiveRoom, createRoom } from '../../src/rooms'
import {
  agents,
  channelParticipants,
  channels,
  messageArtifactReferences,
  messageMentions,
  messages,
  rooms,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createTask } from '../../src/tasks'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('canonical conversations', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture(name: string) {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `${name}-${crypto.randomUUID()}`,
      name,
      owner: owner.principal,
    })
    return { owner, workspace }
  }

  async function cleanup(workspaceId: string, userIds: readonly string[]) {
    await connection.db.delete(messageMentions).where(eq(messageMentions.workspaceId, workspaceId))
    await connection.db
      .delete(messageArtifactReferences)
      .where(eq(messageArtifactReferences.workspaceId, workspaceId))
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.workspaceId, workspaceId))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspaceId))
    await connection.db.delete(rooms).where(eq(rooms.workspaceId, workspaceId))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
  }

  test('provisions exactly one primary Channel and protects it through Room lifecycle', async () => {
    const { owner, workspace } = await fixture('Rooms and channels')
    const room = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'engineering',
      name: 'Engineering',
    })
    const channelsAfterRoom = await listChannelsForUser(
      connection.db,
      workspace.id,
      owner.principal
    )
    expect(channelsAfterRoom).toHaveLength(1)
    expect(channelsAfterRoom[0]).toMatchObject({
      isPrimaryRoomChannel: true,
      kind: 'room',
      roomId: room.id,
    })
    const repaired = await provisionPrimaryRoomChannel(
      connection.db,
      workspace.id,
      room.id,
      owner.principal
    )
    expect(repaired.id).toBe(channelsAfterRoom[0]!.id)
    const secondary = await createRoomChannel(
      connection.db,
      workspace.id,
      room.id,
      owner.principal,
      { idempotencyKey: 'room-secondary', title: 'Architecture' }
    )
    expect(secondary.isPrimaryRoomChannel).toBe(false)
    await expect(
      archiveChannel(connection.db, workspace.id, repaired.id, owner.principal, repaired.version)
    ).rejects.toThrow('Primary Room Channel required')
    await archiveRoom(connection.db, workspace.id, room.id, owner.principal)
    expect(await listChannelsForUser(connection.db, workspace.id, owner.principal)).toEqual([])
    await cleanup(workspace.id, [owner.principal.userId])
  })

  test('keeps direct and group conversation identity independent from Room and runtime state', async () => {
    const { owner, workspace } = await fixture('Direct and group')
    const nonParticipant = await createTemporaryUserSession(connection.db, {
      credentialDigest: `channel-nonparticipant-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await addWorkspaceMembership(connection.db, workspace.id, nonParticipant.principal, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'engineer',
      profileVersion: '1',
    })
    const direct = await createDirectAgentChannel(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal
    )
    const retried = await createDirectAgentChannel(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal
    )
    expect(retried.id).toBe(direct.id)
    expect(direct).toMatchObject({ agentId: agent.id, kind: 'direct_agent' })
    expect(direct).not.toHaveProperty('roomId')

    const group = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'group-1',
      title: 'Launch group',
    })
    const withParticipants = await setChannelParticipants(
      connection.db,
      workspace.id,
      group.id,
      owner.principal,
      [
        { kind: 'user', userId: owner.principal.userId },
        { agentId: agent.id, kind: 'agent' },
      ],
      group.version
    )
    expect(withParticipants.participants).toEqual([
      { agentId: agent.id, kind: 'agent' },
      { kind: 'user', userId: owner.principal.userId },
    ])
    expect(withParticipants).not.toHaveProperty('roomId')
    expect(
      await listChannelsForUser(connection.db, workspace.id, nonParticipant.principal)
    ).toEqual([])
    await cleanup(workspace.id, [owner.principal.userId, nonParticipant.principal.userId])
  })

  test('orders canonical Messages, preserves threads and refs, and rejects stale or foreign access', async () => {
    const { owner, workspace } = await fixture('Messages')
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `message-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'messages-group',
      title: 'Messages',
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Discuss', title: 'Discussion' },
      { idempotencyKey: 'message-task', requestId: crypto.randomUUID() }
    )
    const root = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      artifactIds: [crypto.randomUUID()],
      bodyText: 'Canonical history',
      idempotencyKey: 'root-message',
      mentions: [{ kind: 'user', userId: owner.principal.userId }],
      sender: owner.principal,
      taskId: task.id,
    })
    const retried = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      artifactIds: [...root.artifactIds],
      bodyText: 'Canonical history',
      idempotencyKey: 'root-message',
      mentions: [{ kind: 'user', userId: owner.principal.userId }],
      sender: owner.principal,
      taskId: task.id,
    })
    expect(retried.id).toBe(root.id)
    const reply = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyContentRefId: crypto.randomUUID(),
      idempotencyKey: 'reply-message',
      replyToMessageId: root.id,
      sender: { kind: 'system', systemId: 'agent-hq' },
      threadRootMessageId: root.id,
    })
    expect(reply).not.toHaveProperty('bodyText')
    expect(reply).toMatchObject({ replyToMessageId: root.id, threadRootMessageId: root.id })
    const page = await listMessagesForUser(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      { limit: 1 }
    )
    expect(page.messages).toEqual([root])
    expect(page.nextAfterSequence).toBe(root.sequence)
    expect(
      (
        await listMessagesForUser(connection.db, workspace.id, channel.id, owner.principal, {
          afterSequence: page.nextAfterSequence,
          limit: 10,
        })
      ).messages
    ).toEqual([reply])
    await expect(
      listMessagesForUser(connection.db, workspace.id, channel.id, outsider.principal)
    ).rejects.toThrow('Channel unavailable')

    const edited = await editMessage(
      connection.db,
      workspace.id,
      root.id,
      owner.principal,
      { bodyText: 'Edited canonical history' },
      1
    )
    expect(edited).toMatchObject({ bodyText: 'Edited canonical history', version: 2 })
    await expect(
      editMessage(connection.db, workspace.id, root.id, owner.principal, { bodyText: 'Stale' }, 1)
    ).rejects.toThrow('Message version conflict')
    const deleted = await deleteMessage(connection.db, workspace.id, root.id, owner.principal, 2)
    expect(deleted).toMatchObject({ deleted: true, version: 3 })
    expect(deleted).not.toHaveProperty('bodyText')
    await cleanup(workspace.id, [owner.principal.userId, outsider.principal.userId])
  })
})
