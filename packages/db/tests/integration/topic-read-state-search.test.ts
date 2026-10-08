import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  archiveChannel,
  createDirectAgentChannel,
  createDirectAgentTopic,
  createMessage,
  listMessagesForUser,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  listReadStateForUser,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import {
  channelParticipants,
  channelReadStates,
  messages,
  threadReadStates,
} from '../../src/schema'
import { searchWorkspaceForUser } from '../../src/search'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('distinct topic search and read-state acceptance', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('isolates topic search, read and thread frontiers from sibling topics and the legacy lane', async () => {
    const owner = (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `topic-search-owner-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
    const member = (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `topic-search-member-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Topic semantics',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Shared Agent',
      profileId: 'engineer',
      profileVersion: '1',
    })
    const first = await createDirectAgentTopic(connection.db, workspace.id, agent.id, owner, {
      idempotencyKey: 'first',
      title: 'Architecture',
    })
    const second = await createDirectAgentTopic(connection.db, workspace.id, agent.id, owner, {
      idempotencyKey: 'second',
      title: 'Launch',
    })
    const legacy = await createDirectAgentChannel(connection.db, workspace.id, agent.id, owner)
    const ownTopic = await createDirectAgentTopic(connection.db, workspace.id, agent.id, member, {
      idempotencyKey: 'first',
      title: 'Member topic',
    })
    const roots = []
    const replies = []
    for (const [index, channel] of [first, second, legacy, ownTopic].entries()) {
      const root = await createMessage(
        connection.db,
        workspace.id,
        channel.id,
        index === 3 ? member : owner,
        {
          bodyText: `topicsearchcanary root ${index}`,
          idempotencyKey: 'root',
          sender: index === 3 ? member : owner,
        }
      )
      const reply = await createMessage(
        connection.db,
        workspace.id,
        channel.id,
        index === 3 ? member : owner,
        {
          bodyText: `topicsearchcanary reply ${index}`,
          idempotencyKey: 'reply',
          sender: index === 3 ? member : owner,
          threadRootMessageId: root.id,
          replyToMessageId: root.id,
        }
      )
      roots.push(root)
      replies.push(reply)
    }
    const before = await listReadStateForUser(connection.db, workspace.id, owner)
    expect(before.map(({ channelId }) => channelId).toSorted()).toEqual(
      [first.id, second.id, legacy.id].toSorted()
    )
    expect(
      before.every((row) => row.topLevelUnreadCount === 1 && row.threadUnreadCount === 1)
    ).toBe(true)
    await markChannelReadState(
      connection.db,
      workspace.id,
      first.id,
      owner,
      'read',
      roots[0]!.sequence
    )
    const read = await markThreadReadState(
      connection.db,
      workspace.id,
      first.id,
      roots[0]!.id,
      owner,
      'read',
      replies[0]!.sequence
    )
    expect(read.find(({ channelId }) => channelId === first.id)).toMatchObject({ unread: false })
    for (const channelId of [second.id, legacy.id])
      expect(read.find((row) => row.channelId === channelId)).toMatchObject({
        topLevelUnreadCount: 1,
        threadUnreadCount: 1,
        unread: true,
      })
    const global = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      owner,
      'topicsearchcanary'
    )
    expect(global.results.map(({ id }) => id).toSorted()).toEqual(
      [...roots.slice(0, 3), ...replies.slice(0, 3)].map(({ id }) => id).toSorted()
    )
    const scoped = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      owner,
      'topicsearchcanary',
      { channelId: first.id }
    )
    expect(scoped.results.map(({ id }) => id).toSorted()).toEqual(
      [roots[0]!.id, replies[0]!.id].toSorted()
    )
    expect(scoped.results.find(({ id }) => id === replies[0]!.id)).toMatchObject({
      channelId: first.id,
      threadRootMessageId: roots[0]!.id,
    })
    const memberSearch = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      member,
      'topicsearchcanary'
    )
    expect(memberSearch.results.map(({ id }) => id).toSorted()).toEqual(
      [roots[3]!.id, replies[3]!.id].toSorted()
    )
    await expect(
      searchWorkspaceForUser(connection.db, workspace.id, member, 'topicsearchcanary', {
        channelId: first.id,
      })
    ).rejects.toThrow('Search unavailable')
    await expect(
      markChannelReadState(connection.db, workspace.id, first.id, member, 'read')
    ).rejects.toThrow('Read state unavailable')
    await expect(
      markThreadReadState(connection.db, workspace.id, second.id, roots[0]!.id, owner, 'read')
    ).rejects.toThrow('Read state unavailable')

    const savedChannel = await connection.db
      .select()
      .from(channelReadStates)
      .where(
        and(eq(channelReadStates.channelId, first.id), eq(channelReadStates.userId, owner.userId))
      )
    const savedThread = await connection.db
      .select()
      .from(threadReadStates)
      .where(
        and(eq(threadReadStates.channelId, first.id), eq(threadReadStates.userId, owner.userId))
      )
    await archiveChannel(connection.db, workspace.id, first.id, owner, first.version)
    expect(
      (await listReadStateForUser(connection.db, workspace.id, owner)).some(
        ({ channelId }) => channelId === first.id
      )
    ).toBe(false)
    expect(
      (
        await searchWorkspaceForUser(connection.db, workspace.id, owner, 'topicsearchcanary')
      ).results.some(({ channelId }) => channelId === first.id)
    ).toBe(false)
    await expect(
      searchWorkspaceForUser(connection.db, workspace.id, owner, 'topicsearchcanary', {
        channelId: first.id,
      })
    ).rejects.toThrow('Search unavailable')
    await expect(listMessagesForUser(connection.db, workspace.id, first.id, owner)).rejects.toThrow(
      'Channel unavailable'
    )
    const archivedMessages = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, first.id))
    expect(archivedMessages.map(({ id }) => id).toSorted()).toEqual(
      [roots[0]!.id, replies[0]!.id].toSorted()
    )
    expect(archivedMessages.map(({ bodyText }) => bodyText).toSorted()).toEqual(
      ['topicsearchcanary root 0', 'topicsearchcanary reply 0'].toSorted()
    )
    expect(
      await connection.db
        .select()
        .from(channelReadStates)
        .where(
          and(eq(channelReadStates.channelId, first.id), eq(channelReadStates.userId, owner.userId))
        )
    ).toEqual(savedChannel)
    expect(
      await connection.db
        .select()
        .from(threadReadStates)
        .where(
          and(eq(threadReadStates.channelId, first.id), eq(threadReadStates.userId, owner.userId))
        )
    ).toEqual(savedThread)
    // Trusted fixture removes a participant; the direct-topic public API does
    // not let a caller mutate that audience or widen it to a new topic.
    await connection.db
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.channelId, second.id),
          eq(channelParticipants.userId, owner.userId)
        )
      )
    await expect(
      listMessagesForUser(connection.db, workspace.id, second.id, owner)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      searchWorkspaceForUser(connection.db, workspace.id, owner, 'topicsearchcanary', {
        channelId: second.id,
      })
    ).rejects.toThrow('Search unavailable')
    await expect(
      markChannelReadState(connection.db, workspace.id, second.id, owner, 'read')
    ).rejects.toThrow('Read state unavailable')
    expect(
      (await listReadStateForUser(connection.db, workspace.id, owner)).map(
        ({ channelId }) => channelId
      )
    ).toEqual([legacy.id])
    const newTopic = await createDirectAgentTopic(connection.db, workspace.id, agent.id, owner, {
      idempotencyKey: 'new-after-archive',
      title: 'Fresh topic',
    })
    expect(
      (
        await searchWorkspaceForUser(connection.db, workspace.id, owner, 'topicsearchcanary', {
          channelId: newTopic.id,
        })
      ).results
    ).toEqual([])
    expect(
      (await listReadStateForUser(connection.db, workspace.id, owner)).find(
        ({ channelId }) => channelId === newTopic.id
      )
    ).toMatchObject({
      lastReadSequence: 0,
      topLevelUnreadCount: 0,
      threadUnreadCount: 0,
      unread: false,
    })
    expect((await createDirectAgentChannel(connection.db, workspace.id, agent.id, owner)).id).toBe(
      legacy.id
    )
    expect(
      (await listMessagesForUser(connection.db, workspace.id, legacy.id, owner)).messages.map(
        ({ id }) => id
      )
    ).toEqual([roots[2]!.id, replies[2]!.id])
    expect(
      (await listMessagesForUser(connection.db, workspace.id, legacy.id, owner)).messages.map(
        ({ bodyText }) => bodyText
      )
    ).toEqual(['topicsearchcanary root 2', 'topicsearchcanary reply 2'])
  })
})
