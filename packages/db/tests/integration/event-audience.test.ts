import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef } from '../../src/content-refs'
import {
  archiveChannel,
  createDirectAgentTopic,
  createGroupChannel,
  createMessage,
  getChannelForUser,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { listWorkspaceEventsAfter, workspaceEventWindow } from '../../src/event-log'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import { createProject } from '../../src/projects'
import { setProjectVisibility } from '../../src/project-sharing'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { appendWorkspaceEvent, inTransaction } from '../../src/transactions'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('current conversation event audiences', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `event-audience-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const admin = await user('admin')
    const member = await user('member')
    const outsider = await user('outsider')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Event audience',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, outsider, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Lead',
      profileId: 'lead',
      profileVersion: '1',
    })
    const { latest: start } = await workspaceEventWindow(connection.db, workspace.id)
    const channel = await createDirectAgentTopic(connection.db, workspace.id, agent.id, member, {
      idempotencyKey: 'private-topic',
      title: 'Private topic',
    })
    const contentRefId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, member, {
      id: contentRefId,
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'a'.repeat(64),
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    const message = await createMessage(connection.db, workspace.id, channel.id, member, {
      bodyContentRefId: contentRefId,
      idempotencyKey: 'private-message',
      sender: member,
    })
    await inTransaction(connection.db, async (transaction) => {
      await appendWorkspaceEvent(transaction, {
        workspaceId: workspace.id,
        eventType: 'message.updated',
        payload: { messageId: message.id },
      })
      await appendWorkspaceEvent(transaction, {
        workspaceId: workspace.id,
        eventType: 'content.availability_changed',
        payload: { contentRefId },
      })
      await appendWorkspaceEvent(transaction, {
        workspaceId: workspace.id,
        eventType: 'thread.read',
        payload: { channelId: channel.id, threadRootMessageId: message.id },
      })
    })
    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, start, 100)
    return { owner, admin, member, outsider, workspace, channel, message, contentRefId, events }
  }

  test('private topic channel, message, thread and content events match canonical read audiences', async () => {
    const f = await fixture()
    expect(f.events).toHaveLength(5)
    const participant = await classifyWorkspaceEventsForUser(
      connection.db,
      f.workspace.id,
      f.member.userId,
      f.events
    )
    expect(participant!.every(({ kind }) => kind === 'deliver')).toBe(true)
    for (const principal of [f.owner, f.admin, f.outsider]) {
      await expect(
        getChannelForUser(connection.db, f.workspace.id, f.channel.id, principal)
      ).rejects.toThrow('Channel unavailable')
      const delivery = await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        principal.userId,
        f.events
      )
      expect(delivery).toEqual(
        f.events.map((event) => ({ kind: 'withheld', workspaceSequence: event.workspaceSequence }))
      )
      expect(JSON.stringify(delivery)).not.toContain(f.channel.id)
      expect(JSON.stringify(delivery)).not.toContain(f.message.id)
      expect(JSON.stringify(delivery)).not.toContain(f.contentRefId)
    }
    const stranger = await user('not-a-member')
    expect(
      await classifyWorkspaceEventsForUser(connection.db, f.workspace.id, stranger.userId, f.events)
    ).toBeNull()
  })

  test('replay rechecks participant removal, visibility changes and archived channel audiences', async () => {
    const f = await fixture()
    const { latest: start } = await workspaceEventWindow(connection.db, f.workspace.id)
    const group = await createGroupChannel(connection.db, f.workspace.id, f.owner, {
      idempotencyKey: 'private-group',
      title: 'Private group',
    })
    const shared = await setChannelParticipants(
      connection.db,
      f.workspace.id,
      group.id,
      f.owner,
      [f.owner, f.member],
      group.version
    )
    const historical = await listWorkspaceEventsAfter(connection.db, f.workspace.id, start, 100)
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.owner.userId,
        historical
      ))!.every(({ kind }) => kind === 'deliver')
    ).toBe(true)
    const removed = await setChannelParticipants(
      connection.db,
      f.workspace.id,
      group.id,
      f.owner,
      [f.member],
      shared.version
    )
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.owner.userId,
        historical
      ))!.every(({ kind }) => kind === 'withheld')
    ).toBe(true)
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.member.userId,
        historical
      ))!.every(({ kind }) => kind === 'deliver')
    ).toBe(true)
    const publicGroup = await updateChannel(
      connection.db,
      f.workspace.id,
      group.id,
      f.owner,
      { visibility: 'workspace' },
      removed.version
    )
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.admin.userId,
        historical
      ))!.every(({ kind }) => kind === 'deliver')
    ).toBe(true)
    const privateGroup = await updateChannel(
      connection.db,
      f.workspace.id,
      group.id,
      f.owner,
      { visibility: 'participants' },
      publicGroup.version
    )
    await archiveChannel(connection.db, f.workspace.id, group.id, f.owner, privateGroup.version)
    const archived = await listWorkspaceEventsAfter(connection.db, f.workspace.id, start, 100)
    expect(archived.some(({ eventType }) => eventType === 'channel.archived')).toBe(true)
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.admin.userId,
        archived
      ))!.map(({ kind }) => kind)
    ).toEqual(
      archived.map((event) =>
        event.eventType === 'channel.updated' && event.payload.previousVisibility === 'workspace'
          ? 'audience_changed'
          : 'withheld'
      )
    )
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.member.userId,
        archived
      ))!.every(({ kind }) => kind === 'deliver')
    ).toBe(true)
  })

  test('workspace-to-private transition gives former readers an ID-free audience resync', async () => {
    const f = await fixture()
    const created = await createGroupChannel(connection.db, f.workspace.id, f.owner, {
      idempotencyKey: 'formerly-public',
      title: 'Formerly public',
    })
    const group = await updateChannel(
      connection.db,
      f.workspace.id,
      created.id,
      f.owner,
      { visibility: 'workspace' },
      created.version
    )
    expect((await getChannelForUser(connection.db, f.workspace.id, group.id, f.admin)).id).toBe(
      group.id
    )
    const { latest: start } = await workspaceEventWindow(connection.db, f.workspace.id)
    await updateChannel(
      connection.db,
      f.workspace.id,
      group.id,
      f.owner,
      { visibility: 'participants' },
      group.version
    )
    await expect(
      getChannelForUser(connection.db, f.workspace.id, group.id, f.admin)
    ).rejects.toThrow('Channel unavailable')
    const transitions = await listWorkspaceEventsAfter(connection.db, f.workspace.id, start, 100)
    const deliveries = await classifyWorkspaceEventsForUser(
      connection.db,
      f.workspace.id,
      f.admin.userId,
      transitions
    )
    expect(deliveries).toEqual([
      { kind: 'audience_changed', workspaceSequence: transitions[0]!.workspaceSequence },
    ])
    expect(JSON.stringify(deliveries)).not.toContain(group.id)
    expect(JSON.stringify(deliveries)).not.toContain(f.owner.userId)
    // An update to a channel that was private from creation never signals its audience.
    await updateChannel(
      connection.db,
      f.workspace.id,
      f.channel.id,
      f.member,
      { title: 'Still private' },
      f.channel.version
    )
    const privateEvents = await listWorkspaceEventsAfter(
      connection.db,
      f.workspace.id,
      transitions[0]!.workspaceSequence,
      100
    )
    expect(
      await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.admin.userId,
        privateEvents
      )
    ).toEqual(
      privateEvents.map((event) => ({
        kind: 'withheld',
        workspaceSequence: event.workspaceSequence,
      }))
    )
  })

  test('a channel transition in a never-authorized project remains withheld', async () => {
    const f = await fixture()
    const project = await createProject(connection.db, f.workspace.id, f.owner, {
      name: 'Private project',
      iconKey: 'folder',
    })
    await setProjectVisibility(connection.db, f.workspace.id, project.id, f.owner, 'members')
    const primary = await connection.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.projectId, project.id))
    const channel = primary[0]!
    const { latest: start } = await workspaceEventWindow(connection.db, f.workspace.id)
    await updateChannel(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner,
      { visibility: 'participants' },
      channel.version
    )
    const transitions = await listWorkspaceEventsAfter(connection.db, f.workspace.id, start, 100)
    expect(
      await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.outsider.userId,
        transitions
      )
    ).toEqual(
      transitions.map((event) => ({ kind: 'withheld', workspaceSequence: event.workspaceSequence }))
    )
  })

  test('missing, foreign or mismatched channel references fail closed', async () => {
    const f = await fixture()
    const foreign = await fixture()
    const template = f.events[0]!
    const visible = await createGroupChannel(connection.db, f.workspace.id, f.owner, {
      idempotencyKey: 'visible-group',
      title: 'Visible group',
    })
    const missingChannelId = crypto.randomUUID()
    const events = [
      ...[missingChannelId, foreign.channel.id].map((channelId) => ({
        ...template,
        schemaVersion: 2,
        eventType: 'channel.updated',
        aggregateType: 'channel' as const,
        aggregateId: channelId,
        payload: { channelId, previousVisibility: 'workspace', visibility: 'participants' },
      })),
      {
        ...template,
        eventType: 'channel.updated',
        aggregateType: 'channel' as const,
        aggregateId: crypto.randomUUID(),
        payload: { channelId: crypto.randomUUID() },
      },
      {
        ...template,
        eventType: 'message.updated',
        aggregateType: 'message' as const,
        aggregateId: crypto.randomUUID(),
        payload: { messageId: crypto.randomUUID() },
      },
      {
        ...template,
        eventType: 'content.availability_changed',
        aggregateType: 'content_ref' as const,
        aggregateId: crypto.randomUUID(),
        payload: { contentRefId: crypto.randomUUID() },
      },
      { ...template, aggregateId: foreign.channel.id, payload: { channelId: foreign.channel.id } },
      // A visible payload channel cannot authorize a different private message.
      {
        ...template,
        eventType: 'message.updated',
        aggregateType: 'message' as const,
        aggregateId: f.message.id,
        payload: { channelId: visible.id, messageId: f.message.id },
      },
      { ...template, aggregateId: foreign.channel.id, payload: {} },
    ]
    expect(
      (await classifyWorkspaceEventsForUser(
        connection.db,
        f.workspace.id,
        f.owner.userId,
        events
      ))!.every(({ kind }) => kind === 'withheld')
    ).toBe(true)
  })

  test('conversation audience filtering uses a fixed number of indexed reads per page', async () => {
    const f = await fixture()
    let queries = 0
    const counting = postgres(connectionUrl!, {
      debug: () => {
        queries += 1
      },
      max: 1,
      prepare: false,
    })
    try {
      await counting`select 1`
      const db = drizzle(counting, { schema })
      queries = 0
      const small = await classifyWorkspaceEventsForUser(
        db,
        f.workspace.id,
        f.owner.userId,
        f.events
      )
      expect(small!.every(({ kind }) => kind === 'withheld')).toBe(true)
      expect(queries).toBe(5)
      queries = 0
      const page = Array.from({ length: 24 }, () => f.events).flat()
      const large = await classifyWorkspaceEventsForUser(db, f.workspace.id, f.owner.userId, page)
      expect(large).toHaveLength(120)
      expect(large!.every(({ kind }) => kind === 'withheld')).toBe(true)
      expect(queries).toBe(5)
    } finally {
      await counting.end({ timeout: 5 })
    }
  })
})
