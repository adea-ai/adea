import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef } from '../../src/content-refs'
import {
  archiveChannel,
  createDirectAgentChannel,
  createDirectAgentTopic,
  createGroupChannel,
  createMessage,
  createProjectChannel,
  deleteMessage,
  editMessage,
  listChannelsForUser,
  listMessagesForUser,
  provisionPrimaryProjectChannel,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { archiveProject, createProject } from '../../src/projects'
import {
  agents,
  artifacts,
  channelParticipants,
  channels,
  contentRefs,
  messageArtifactReferences,
  messageMentions,
  messages,
  projects,
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
    await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspaceId))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.workspaceId, workspaceId))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspaceId))
    await connection.db.delete(projects).where(eq(projects.workspaceId, workspaceId))
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

  test('provisions exactly one primary Channel and protects it through Project lifecycle', async () => {
    const { owner, workspace } = await fixture('Projects and channels')
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const channelsAfterProject = await listChannelsForUser(
      connection.db,
      workspace.id,
      owner.principal
    )
    expect(channelsAfterProject).toHaveLength(1)
    expect(channelsAfterProject[0]).toMatchObject({
      isPrimaryProjectChannel: true,
      kind: 'project',
      projectId: project.id,
    })
    const repaired = await provisionPrimaryProjectChannel(
      connection.db,
      workspace.id,
      project.id,
      owner.principal
    )
    expect(repaired.id).toBe(channelsAfterProject[0]!.id)
    const secondary = await createProjectChannel(
      connection.db,
      workspace.id,
      project.id,
      owner.principal,
      { idempotencyKey: 'project-secondary', title: 'Architecture' }
    )
    expect(secondary.isPrimaryProjectChannel).toBe(false)
    await expect(
      archiveChannel(connection.db, workspace.id, repaired.id, owner.principal, repaired.version)
    ).rejects.toThrow('Primary Project Channel required')
    await archiveProject(connection.db, workspace.id, project.id, owner.principal)
    expect(await listChannelsForUser(connection.db, workspace.id, owner.principal)).toEqual([])
    await cleanup(workspace.id, [owner.principal.userId])
  })

  test('keeps direct and group conversation identity independent from Project and runtime state', async () => {
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
    expect(direct).not.toHaveProperty('projectId')

    // Archiving then reopening moves the live conversation to a suffixed
    // idempotency key. Opening again must return that live row instead of
    // attempting a fresh insert that violates the active direct-channel
    // uniqueness (previously surfaced as a generic invalid request).
    const archived = await archiveChannel(
      connection.db,
      workspace.id,
      direct.id,
      owner.principal,
      direct.version
    )
    expect(archived.lifecycleState).toBe('archived')
    const reopened = await createDirectAgentChannel(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal
    )
    expect(reopened.lifecycleState).toBe('active')
    expect(reopened.id).not.toBe(direct.id)
    const reopenedAgain = await createDirectAgentChannel(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal
    )
    expect(reopenedAgain.id).toBe(reopened.id)

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
    expect(withParticipants).not.toHaveProperty('projectId')
    expect(
      await listChannelsForUser(connection.db, workspace.id, nonParticipant.principal)
    ).toEqual([])
    await cleanup(workspace.id, [owner.principal.userId, nonParticipant.principal.userId])
  })

  test('isolates topic histories and caller retries from the legacy default lane', async () => {
    const { owner, workspace } = await fixture('Distinct direct topics')
    const member = await createTemporaryUserSession(connection.db, {
      credentialDigest: `topic-member-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await addWorkspaceMembership(connection.db, workspace.id, member.principal, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'engineer',
      profileVersion: '1',
    })
    // Even a caller key resembling the legacy lane stays in the topic namespace.
    const input = { idempotencyKey: `direct-agent:${agent.id}`, title: 'Architecture' }
    const first = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal,
      input
    )
    const second = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal,
      {
        idempotencyKey: 'second-topic',
        title: 'Launch',
      }
    )
    const defaultLane = await createDirectAgentChannel(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal
    )
    expect(new Set([first.id, second.id, defaultLane.id]).size).toBe(3)
    expect(first.visibility).toBe('participants')
    expect(first.participants).toContainEqual({ kind: 'user', userId: owner.principal.userId })
    expect(first.participants).toContainEqual({ kind: 'agent', agentId: agent.id })
    const message = await createMessage(connection.db, workspace.id, first.id, owner.principal, {
      bodyText: 'Architecture only',
      idempotencyKey: 'first-message',
      sender: owner.principal,
    })
    expect(
      (await listMessagesForUser(connection.db, workspace.id, first.id, owner.principal)).messages
    ).toEqual([message])
    expect(
      (await listMessagesForUser(connection.db, workspace.id, second.id, owner.principal)).messages
    ).toEqual([])
    expect(
      (await listMessagesForUser(connection.db, workspace.id, defaultLane.id, owner.principal))
        .messages
    ).toEqual([])
    expect(
      (await createDirectAgentChannel(connection.db, workspace.id, agent.id, owner.principal)).id
    ).toBe(defaultLane.id)
    expect(await listChannelsForUser(connection.db, workspace.id, member.principal)).toEqual([])
    await expect(
      listMessagesForUser(connection.db, workspace.id, first.id, member.principal)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      createDirectAgentChannel(connection.db, workspace.id, agent.id, member.principal)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      updateChannel(
        connection.db,
        workspace.id,
        first.id,
        member.principal,
        { title: 'Foreign edit' },
        first.version
      )
    ).rejects.toThrow('Channel unavailable')
    await expect(
      archiveChannel(connection.db, workspace.id, first.id, member.principal, first.version)
    ).rejects.toThrow('Channel unavailable')
    const memberTopic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      agent.id,
      member.principal,
      input
    )
    expect(memberTopic.id).not.toBe(first.id)
    const renamed = await updateChannel(
      connection.db,
      workspace.id,
      first.id,
      owner.principal,
      { title: 'Architecture renamed' },
      first.version
    )
    expect(
      (await createDirectAgentTopic(connection.db, workspace.id, agent.id, owner.principal, input))
        .id
    ).toBe(first.id)
    await expect(
      createDirectAgentTopic(connection.db, workspace.id, agent.id, owner.principal, {
        ...input,
        title: 'Changed request',
      })
    ).rejects.toThrow('Channel idempotency conflict')
    const archived = await archiveChannel(
      connection.db,
      workspace.id,
      first.id,
      owner.principal,
      renamed.version
    )
    expect(
      (await createDirectAgentTopic(connection.db, workspace.id, agent.id, owner.principal, input))
        .lifecycleState
    ).toBe('archived')
    expect(
      (
        await listChannelsForUser(connection.db, workspace.id, owner.principal, {
          includeArchived: true,
        })
      ).find((channel) => channel.id === archived.id)?.lifecycleState
    ).toBe('archived')
    const stored = await connection.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, first.id))
    expect(stored.map(({ id }) => id)).toEqual([message.id])
    await connection.db
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.channelId, first.id),
          eq(channelParticipants.principalKind, 'user')
        )
      )
    await expect(
      createDirectAgentTopic(connection.db, workspace.id, agent.id, owner.principal, input)
    ).rejects.toThrow('Channel unavailable')
    await cleanup(workspace.id, [owner.principal.userId, member.principal.userId])
  })

  test('rejects topic retries with a changed agent or a foreign workspace', async () => {
    const first = await fixture('Topic request identity')
    const other = await fixture('Foreign topic workspace')
    const agent = await createAgent(connection.db, first.workspace.id, first.owner.principal, {
      name: 'Ada',
      profileId: 'engineer',
      profileVersion: '1',
    })
    const secondAgent = await createAgent(
      connection.db,
      first.workspace.id,
      first.owner.principal,
      {
        name: 'Grace',
        profileId: 'engineer',
        profileVersion: '1',
      }
    )
    const input = { idempotencyKey: 'same-request', title: 'Topic' }
    const results = await Promise.all([
      createDirectAgentTopic(
        connection.db,
        first.workspace.id,
        agent.id,
        first.owner.principal,
        input
      ),
      createDirectAgentTopic(
        connection.db,
        first.workspace.id,
        agent.id,
        first.owner.principal,
        input
      ),
    ])
    expect(results[0]!.id).toBe(results[1]!.id)
    await expect(
      createDirectAgentTopic(
        connection.db,
        first.workspace.id,
        secondAgent.id,
        first.owner.principal,
        input
      )
    ).rejects.toThrow('Channel idempotency conflict')
    await expect(
      createDirectAgentTopic(
        connection.db,
        other.workspace.id,
        agent.id,
        other.owner.principal,
        input
      )
    ).rejects.toThrow('Agent unavailable')
    await expect(
      createDirectAgentTopic(
        connection.db,
        first.workspace.id,
        agent.id,
        other.owner.principal,
        input
      )
    ).rejects.toThrow('Channel unavailable')
    expect(() =>
      createDirectAgentTopic(connection.db, first.workspace.id, agent.id, first.owner.principal, {
        ...input,
        idempotencyKey: ' ',
      })
    ).toThrow('Invalid topic request')
    await cleanup(first.workspace.id, [first.owner.principal.userId])
    await cleanup(other.workspace.id, [other.owner.principal.userId])
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
    const artifact = await createArtifact(connection.db, workspace.id, owner.principal, {
      checksumSha256: 'd'.repeat(64),
      filename: 'message.txt',
      location: { reference: 'messages/message-1', type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 12,
      sourceArtifactRef: 'message-artifact:1',
      sourcePrincipal: owner.principal,
      taskId: task.id,
    })
    const root = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      artifactIds: [artifact.id],
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
    const bodyContentRefId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'e'.repeat(64),
      id: bodyContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    const reply = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyContentRefId,
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
