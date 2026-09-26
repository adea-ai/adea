import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import { createContentRef } from '../../src/content-refs'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  listReadStateForUser,
  markAllChannelsRead,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import { createRoom } from '../../src/rooms'
import { searchWorkspaceForUser } from '../../src/search'
import {
  agents,
  artifacts,
  channelParticipants,
  channelReadStates,
  channels,
  contentRefs,
  messageArtifactReferences,
  messageMentions,
  messages,
  rooms,
  taskMutations,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('read state and workspace search', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('keeps channel and thread frontiers explicit, scoped, and retry-stable', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `read-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `read-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `read-${crypto.randomUUID()}`,
      name: 'Searchable HQ',
      owner: owner.principal,
    })
    const room = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'research',
      name: 'Research Lab',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Search Scout',
      profileId: 'researcher',
      profileVersion: '1',
      roleSummary: 'Finds workspace context',
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Investigate aurora telemetry', title: 'Aurora investigation' },
      { idempotencyKey: 'search-task', requestId: crypto.randomUUID() }
    )
    const artifact = await createArtifact(connection.db, workspace.id, owner.principal, {
      checksumSha256: 'f'.repeat(64),
      filename: 'aurora-report.md',
      location: { reference: 'artifacts/aurora-report', type: 'object_store' },
      mediaType: 'text/markdown',
      sizeBytes: 42,
      sourceArtifactRef: 'search:aurora-report',
      sourcePrincipal: owner.principal,
      taskId: task.id,
    })
    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'search-group',
      title: 'Aurora response',
    })
    const root = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyText: 'Aurora launch checklist and telemetry notes',
      idempotencyKey: 'search-root',
      sender: owner.principal,
      taskId: task.id,
    })
    const reply = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyText: 'Thread-only aurora follow-up',
      idempotencyKey: 'search-thread',
      replyToMessageId: root.id,
      sender: owner.principal,
      threadRootMessageId: root.id,
    })
    const privateContentId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, owner.principal, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'a'.repeat(64),
      id: privateContentId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    const privateMessage = await createMessage(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      {
        bodyContentRefId: privateContentId,
        idempotencyKey: 'search-private',
        sender: owner.principal,
      }
    )

    const prefetched = await listReadStateForUser(connection.db, workspace.id, owner.principal)
    expect(prefetched.find(({ channelId }) => channelId === channel.id)).toMatchObject({
      threadUnreadCount: 1,
      topLevelUnreadCount: 2,
      unread: true,
    })
    expect(
      await connection.db
        .select()
        .from(channelReadStates)
        .where(eq(channelReadStates.workspaceId, workspace.id))
    ).toEqual([])
    await expect(
      listReadStateForUser(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Read state unavailable')

    const channelRead = await markChannelReadState(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      'read',
      privateMessage.sequence
    )
    expect(channelRead.find(({ channelId }) => channelId === channel.id)).toMatchObject({
      threadUnreadCount: 1,
      topLevelUnreadCount: 0,
    })
    const threadRead = await markThreadReadState(
      connection.db,
      workspace.id,
      channel.id,
      root.id,
      owner.principal,
      'read',
      reply.sequence
    )
    expect(threadRead.find(({ channelId }) => channelId === channel.id)?.unread).toBe(false)
    const manuallyUnread = await markChannelReadState(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      'unread'
    )
    const firstMarker = manuallyUnread.find(({ channelId }) => channelId === channel.id)!
    const retried = await markChannelReadState(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      'unread'
    )
    expect(retried.find(({ channelId }) => channelId === channel.id)).toEqual(firstMarker)
    const markedAll = await markAllChannelsRead(connection.db, workspace.id, owner.principal)
    expect(markedAll.every(({ unread }) => !unread)).toBe(true)
    const eventCount = (
      await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, workspace.id))
    ).length
    expect(await markAllChannelsRead(connection.db, workspace.id, owner.principal)).toEqual(
      markedAll
    )
    expect(
      (
        await connection.db
          .select()
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, workspace.id))
      ).length
    ).toBe(eventCount)

    // A stale client sequence (for example from a partially loaded message
    // window) must never rewind a read frontier and resurrect notifications.
    const staleChannel = await markChannelReadState(
      connection.db,
      workspace.id,
      channel.id,
      owner.principal,
      'read',
      root.sequence
    )
    expect(staleChannel.find(({ channelId }) => channelId === channel.id)).toMatchObject({
      lastReadSequence: privateMessage.sequence,
      topLevelUnreadCount: 0,
      unread: false,
    })
    const staleThread = await markThreadReadState(
      connection.db,
      workspace.id,
      channel.id,
      root.id,
      owner.principal,
      'read',
      0
    )
    expect(staleThread.find(({ channelId }) => channelId === channel.id)).toMatchObject({
      threadUnreadCount: 0,
      unread: false,
    })

    const global = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      owner.principal,
      'aurora',
      { limit: 50 }
    )
    expect(new Set(global.results.map(({ kind }) => kind))).toEqual(
      new Set(['artifact', 'channel', 'message', 'task'])
    )
    expect(global.privateResultsUnavailable).toBe(true)
    expect(global.results).toContainEqual(expect.objectContaining({ id: artifact.id }))
    expect(global.results.find(({ kind }) => kind === 'message')).toMatchObject({
      channelId: channel.id,
      messageId: root.id,
    })
    const scoped = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      owner.principal,
      'thread-only',
      { channelId: channel.id }
    )
    expect(scoped.results).toHaveLength(1)
    expect(scoped.results[0]).toMatchObject({
      messageId: reply.id,
      threadRootMessageId: root.id,
    })
    expect(
      await searchWorkspaceForUser(connection.db, workspace.id, owner.principal, 'research', {
        limit: 50,
      })
    ).toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ id: room.id })]),
    })
    expect(
      await searchWorkspaceForUser(connection.db, workspace.id, owner.principal, 'scout', {
        limit: 50,
      })
    ).toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ id: agent.id })]),
    })
    expect(JSON.stringify(global)).not.toContain('PRIVATE-SEARCH-LEAK-CANARY')

    await connection.db
      .delete(threadReadStates)
      .where(eq(threadReadStates.workspaceId, workspace.id))
    await connection.db
      .delete(channelReadStates)
      .where(eq(channelReadStates.workspaceId, workspace.id))
    await connection.db.delete(messageMentions).where(eq(messageMentions.workspaceId, workspace.id))
    await connection.db
      .delete(messageArtifactReferences)
      .where(eq(messageArtifactReferences.workspaceId, workspace.id))
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspace.id))
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspace.id))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.workspaceId, workspace.id))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspace.id))
    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspace.id))
    await connection.db.delete(rooms).where(eq(rooms.workspaceId, workspace.id))
    await connection.db.delete(workspaceEvents).where(eq(workspaceEvents.workspaceId, workspace.id))
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
  // The batched mark-all-read path writes many channels and many threads in a
  // handful of statements. The case above only ever has one channel and one
  // thread, so it cannot catch a multi-row upsert that silently writes only the
  // first row, or a frontier that is skipped for every channel but the last.
  test('marks every channel and thread read across a multi-row batch', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `batch-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `batch-${crypto.randomUUID()}`,
      name: 'Batch HQ',
      owner: owner.principal,
    })

    const channelIds: string[] = []
    const rootIds: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
        idempotencyKey: `batch-ch-${index}-${crypto.randomUUID()}`,
        title: `Batch ${index}`,
      })
      channelIds.push(channel.id)
      // Two threads per channel, each with a distinct latest reply sequence, so
      // a wrong per-thread frontier is visible rather than coincidentally right.
      for (let thread = 0; thread < 2; thread += 1) {
        const root = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
          bodyText: `root ${index}/${thread}`,
          idempotencyKey: `batch-root-${index}-${thread}-${crypto.randomUUID()}`,
          sender: owner.principal,
        })
        rootIds.push(root.id)
        await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
          bodyText: `reply ${index}/${thread}`,
          idempotencyKey: `batch-reply-${index}-${thread}-${crypto.randomUUID()}`,
          replyToMessageId: root.id,
          sender: owner.principal,
          threadRootMessageId: root.id,
        })
      }
    }

    const before = await listReadStateForUser(connection.db, workspace.id, owner.principal)
    expect(before.every((row) => row.unread)).toBe(true)
    expect(before.reduce((total, row) => total + row.threadUnreadCount, 0)).toBe(8)

    const after = await markAllChannelsRead(connection.db, workspace.id, owner.principal)

    // Every channel in the batch advanced, not just the first or the last.
    for (const channelId of channelIds) {
      const row = after.find((entry) => entry.channelId === channelId)
      expect(row, `channel ${channelId} missing from the mark-all-read result`).toBeDefined()
      expect(row?.unread).toBe(false)
      expect(row?.threadUnreadCount).toBe(0)
      expect(row?.manuallyUnread).toBe(false)
      // One frontier row per channel, and one per thread inside each channel.
      expect(row?.latestTopLevelSequence).toBeGreaterThan(0)
      expect(row?.threads).toHaveLength(2)
      for (const thread of row?.threads ?? []) expect(thread.unreadCount).toBe(0)
    }
    expect(after).toHaveLength(channelIds.length)

    // The persisted rows match what was returned, for every channel and thread.
    const persistedChannels = await connection.db
      .select()
      .from(channelReadStates)
      .where(eq(channelReadStates.workspaceId, workspace.id))
    expect(persistedChannels).toHaveLength(channelIds.length)
    expect(persistedChannels.every((row) => row.manuallyUnread === false)).toBe(true)
    const persistedThreads = await connection.db
      .select()
      .from(threadReadStates)
      .where(eq(threadReadStates.workspaceId, workspace.id))
    expect(persistedThreads).toHaveLength(rootIds.length)
    expect(persistedThreads.every((row) => row.manuallyUnread === false)).toBe(true)
    for (const thread of persistedThreads) expect(thread.lastReadSequence).toBeGreaterThan(0)

    // Idempotent: a second call is a no-op that still reports everything read.
    const retried = await markAllChannelsRead(connection.db, workspace.id, owner.principal)
    expect(retried.every((row) => !row.unread)).toBe(true)
    expect(
      await connection.db
        .select()
        .from(threadReadStates)
        .where(eq(threadReadStates.workspaceId, workspace.id))
    ).toHaveLength(rootIds.length)

    // A previously rewound frontier is repaired forward, never backward.
    const [victim] = await connection.db
      .select()
      .from(threadReadStates)
      .where(eq(threadReadStates.workspaceId, workspace.id))
      .limit(1)
    await connection.db
      .update(threadReadStates)
      .set({ lastReadSequence: 1, manuallyUnread: true })
      .where(eq(threadReadStates.threadRootMessageId, victim!.threadRootMessageId))
    const repaired = await markAllChannelsRead(connection.db, workspace.id, owner.principal)
    expect(repaired.every((row) => !row.unread)).toBe(true)

    await connection.db
      .delete(threadReadStates)
      .where(eq(threadReadStates.workspaceId, workspace.id))
    await connection.db
      .delete(channelReadStates)
      .where(eq(channelReadStates.workspaceId, workspace.id))
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspace.id))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.workspaceId, workspace.id))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db.delete(workspaceEvents).where(eq(workspaceEvents.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })
})
