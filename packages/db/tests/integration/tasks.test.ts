import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createArtifact } from '../../src/artifacts'
import { createGroupChannel, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createAgent } from '../../src/agents'
import { createRoom } from '../../src/rooms'
import {
  archiveTask,
  assignTask,
  cancelTask,
  completeTask,
  createTask,
  getTaskForUser,
  listTasksForUser,
  moveTaskToRoom,
  queueTask,
  reviewTask,
  setTaskArtifactReferences,
  setTaskConversationReferences,
  setTaskDependencies,
  startTask,
  updateTask,
} from '../../src/tasks'
import {
  agents,
  artifacts,
  channels,
  messages,
  rooms,
  taskDependencies,
  taskMutations,
  tasks,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const command = (idempotencyKey: string, expectedVersion?: number) => ({
  correlationId: `correlation:${idempotencyKey}`,
  expectedVersion,
  idempotencyKey,
  requestId: crypto.randomUUID(),
})

describe.skipIf(!connectionUrl)('durable product Tasks', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('persists workspace-scoped task context without requiring execution or a channel', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `tasks-${crypto.randomUUID()}`,
      name: 'Task HQ',
      owner: owner.principal,
    })
    const room = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'engineering',
      name: 'Engineering',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'engineer',
      profileVersion: '1',
    })

    const created = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      {
        agentId: agent.id,
        objective: 'Ship the durable Task model',
        priority: 'high',
        roomId: room.id,
        title: 'Implement Tasks',
      },
      command('create-task')
    )
    const retried = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      {
        agentId: agent.id,
        objective: 'Ship the durable Task model',
        priority: 'high',
        roomId: room.id,
        title: 'Implement Tasks',
      },
      command('create-task')
    )

    expect(retried.id).toBe(created.id)
    expect(created).toMatchObject({
      agentId: agent.id,
      artifactRefs: [],
      lifecycleState: 'created',
      roomId: room.id,
      version: 1,
      workspaceId: workspace.id,
    })
    expect(created.controlPlaneExecutionRef).toBeUndefined()
    expect(created.conversation).toEqual({})
    expect(await listTasksForUser(connection.db, workspace.id, owner.principal)).toHaveLength(1)
    expect(
      await getTaskForUser(connection.db, workspace.id, created.id, outsider.principal)
    ).toBeNull()
    await expect(
      updateTask(
        connection.db,
        workspace.id,
        created.id,
        outsider.principal,
        { title: 'Unauthorized' },
        command('outsider-update', 1)
      )
    ).rejects.toThrow('Task unavailable')

    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db
      .delete(taskDependencies)
      .where(eq(taskDependencies.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspace.id))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
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

  test('enforces lifecycle versions and makes retried mutations effect-idempotent', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-lifecycle-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `task-lifecycle-${crypto.randomUUID()}`,
      name: 'Lifecycle HQ',
      owner: owner.principal,
    })
    const created = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Validate transitions', priority: 'normal', title: 'Lifecycle' },
      command('lifecycle-create')
    )
    const queued = await queueTask(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      command('queue', 1)
    )
    const retried = await queueTask(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      command('queue', 1)
    )
    expect(retried).toEqual(queued)
    expect(queued).toMatchObject({ lifecycleState: 'queued', version: 2 })
    await expect(
      updateTask(
        connection.db,
        workspace.id,
        created.id,
        owner.principal,
        { title: 'Stale' },
        command('stale', 1)
      )
    ).rejects.toThrow('Task version conflict')
    await expect(
      queueTask(
        connection.db,
        workspace.id,
        created.id,
        owner.principal,
        command('invalid-transition', 2)
      )
    ).rejects.toThrow('Invalid Task lifecycle transition')
    const cancelled = await cancelTask(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      command('cancel', 2)
    )
    expect(cancelled).toMatchObject({ lifecycleState: 'cancelled', version: 3 })
    const archived = await archiveTask(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      command('archive', 3)
    )
    expect(archived.lifecycleState).toBe('archived')
    const completable = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Finish the work', priority: 'normal', title: 'Completable' },
      command('completable-create')
    )
    const completableQueued = await queueTask(
      connection.db,
      workspace.id,
      completable.id,
      owner.principal,
      command('completable-queue', 1)
    )
    expect(completableQueued.lifecycleState).toBe('queued')
    const started = await startTask(
      connection.db,
      workspace.id,
      completable.id,
      owner.principal,
      command('start', 2)
    )
    expect(started).toMatchObject({ lifecycleState: 'in_progress', version: 3 })
    const submitted = await reviewTask(
      connection.db,
      workspace.id,
      completable.id,
      owner.principal,
      command('review', 3)
    )
    expect(submitted).toMatchObject({ lifecycleState: 'in_review', version: 4 })
    await expect(
      queueTask(
        connection.db,
        workspace.id,
        completable.id,
        owner.principal,
        command('queue-from-review', 4)
      )
    ).rejects.toThrow('Invalid Task lifecycle transition')
    const completed = await completeTask(
      connection.db,
      workspace.id,
      completable.id,
      owner.principal,
      command('complete', 4)
    )
    expect(completed).toMatchObject({ lifecycleState: 'completed', version: 5 })
    await expect(
      cancelTask(
        connection.db,
        workspace.id,
        completable.id,
        owner.principal,
        command('cancel-completed', 5)
      )
    ).rejects.toThrow('Invalid Task lifecycle transition')
    const completedArchived = await archiveTask(
      connection.db,
      workspace.id,
      completable.id,
      owner.principal,
      command('archive-completed', 5)
    )
    expect(completedArchived.lifecycleState).toBe('archived')
    const raced = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Only one writer wins', title: 'Concurrent update' },
      command('race-create')
    )
    const race = await Promise.allSettled([
      updateTask(
        connection.db,
        workspace.id,
        raced.id,
        owner.principal,
        { title: 'Winner A' },
        command('race-a', 1)
      ),
      updateTask(
        connection.db,
        workspace.id,
        raced.id,
        owner.principal,
        { title: 'Winner B' },
        command('race-b', 1)
      ),
    ])
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(race.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(await listTasksForUser(connection.db, workspace.id, owner.principal)).toHaveLength(1)

    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })

  test('reopens in_review Tasks when their linked conversation receives a message', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-reopen-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `task-reopen-${crypto.randomUUID()}`,
      name: 'Reopen HQ',
      owner: owner.principal,
    })
    let task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Review then comment', priority: 'normal', title: 'Reopenable' },
      command('reopen-create')
    )
    task = await queueTask(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      command('reopen-queue', task.version)
    )
    task = await startTask(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      command('reopen-start', task.version)
    )
    task = await reviewTask(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      command('reopen-review', task.version)
    )
    expect(task.lifecycleState).toBe('in_review')
    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'reopen-channel',
      title: 'Task thread',
    })
    const otherChannel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'reopen-other-channel',
      title: 'Unrelated thread',
    })
    task = await setTaskConversationReferences(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      { channelId: channel.id },
      command('reopen-conversation', task.version)
    )
    await createMessage(connection.db, workspace.id, otherChannel.id, owner.principal, {
      bodyText: 'Unrelated comment',
      idempotencyKey: 'reopen-unrelated-message',
      sender: owner.principal,
    })
    expect(
      (await getTaskForUser(connection.db, workspace.id, task.id, owner.principal))?.lifecycleState
    ).toBe('in_review')
    await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyText: 'Needs another change',
      idempotencyKey: 'reopen-linked-message',
      sender: owner.principal,
    })
    const reopened = await getTaskForUser(connection.db, workspace.id, task.id, owner.principal)
    expect(reopened).toMatchObject({ lifecycleState: 'in_progress', version: task.version + 1 })

    await connection.db.delete(messages).where(eq(messages.workspaceId, workspace.id))
    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })

  test('defaults Task kind to feature and allows bug/chore updates', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-kind-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `task-kind-${crypto.randomUUID()}`,
      name: 'Kind HQ',
      owner: owner.principal,
    })
    const defaulted = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Default kind', title: 'Defaulted' },
      command('kind-default')
    )
    expect(defaulted.kind).toBe('feature')
    const bug = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { kind: 'bug', objective: 'Explicit kind', title: 'Bugged' },
      command('kind-bug')
    )
    expect(bug.kind).toBe('bug')
    const chore = await updateTask(
      connection.db,
      workspace.id,
      bug.id,
      owner.principal,
      { kind: 'chore' },
      command('kind-chore', bug.version)
    )
    expect(chore).toMatchObject({ kind: 'chore', version: bug.version + 1 })

    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })

  test('updates assignment, Room, dependencies, Artifact refs, and conversation provenance', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `task-context-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `task-context-${crypto.randomUUID()}`,
      name: 'Context HQ',
      owner: owner.principal,
    })
    const room = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'planning',
      name: 'Planning',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Grace',
      profileId: 'planner',
      profileVersion: '1',
    })
    const dependency = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'First', priority: 'low', title: 'Dependency' },
      command('dependency-create')
    )
    let task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Second', priority: 'urgent', title: 'Dependent' },
      command('dependent-create')
    )
    task = await assignTask(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      agent.id,
      command('assign', task.version)
    )
    task = await moveTaskToRoom(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      room.id,
      command('move', task.version)
    )
    task = await setTaskDependencies(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      [dependency.id],
      command('dependencies', task.version)
    )
    await expect(
      setTaskDependencies(
        connection.db,
        workspace.id,
        dependency.id,
        owner.principal,
        [task.id],
        command('dependency-cycle', dependency.version)
      )
    ).rejects.toThrow('Task dependency cycle')
    const artifact = await createArtifact(connection.db, workspace.id, owner.principal, {
      checksumSha256: 'e'.repeat(64),
      filename: 'spec.md',
      location: { reference: 'task/spec', type: 'object_store' },
      mediaType: 'text/markdown',
      sizeBytes: 100,
      sourceArtifactRef: 'task-artifact:spec',
      sourcePrincipal: owner.principal,
      taskId: task.id,
    })
    task = await setTaskArtifactReferences(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      [artifact.id],
      command('artifacts', task.version)
    )
    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: 'task-conversation-channel',
      title: 'Task conversation',
    })
    const message = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyText: 'Task context',
      idempotencyKey: 'task-conversation-message',
      sender: owner.principal,
      taskId: task.id,
    })
    task = await setTaskConversationReferences(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      { channelId: channel.id, messageId: message.id, threadRootMessageId: message.id },
      command('conversation', task.version)
    )
    expect(task).toMatchObject({
      agentId: agent.id,
      artifactRefs: [artifact.id],
      conversation: {
        channelId: channel.id,
        messageId: message.id,
        threadRootMessageId: message.id,
      },
      dependencyIds: [dependency.id],
      roomId: room.id,
    })

    await connection.db.delete(messages).where(eq(messages.workspaceId, workspace.id))
    await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspace.id))
    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id))
    await connection.db
      .delete(taskDependencies)
      .where(eq(taskDependencies.workspaceId, workspace.id))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspace.id))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db.delete(rooms).where(eq(rooms.workspaceId, workspace.id))
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
