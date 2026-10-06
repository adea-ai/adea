import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { createArtifact } from '../../src/artifacts'
import { createContentRef, getContentRefForUser } from '../../src/content-refs'
import { listContentReplicasForUser } from '../../src/content-replicas'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createMessage,
  editMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
} from '../../src/conversations'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import { listWorkspaceEventsAfter } from '../../src/event-log'
import { createTemporaryUserSession } from '../../src/identity'
import { listArtifactsForUser, getArtifactForUser } from '../../src/artifacts'
import {
  createProject,
  getProjectForUser,
  listProjectsForUser,
  reorderProjects,
  updateProject,
} from '../../src/projects'
import {
  listProjectMembersForUser,
  removeProjectMember,
  setProjectMember,
  setProjectVisibility,
} from '../../src/project-sharing'
import { listReadStateForUser, markChannelReadState } from '../../src/read-state'
import {
  channels,
  workspaceEvents,
  workspaceInvitations,
  workspaceMemberships,
} from '../../src/schema'
import { searchWorkspaceForUser } from '../../src/search'
import { createTask, getTaskForUser, listTasksForUser, updateTask } from '../../src/tasks'
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  INVITATION_LIFETIME_MS,
  listWorkspaceInvitationsForUser,
  listWorkspaceMembersForUser,
  revokeWorkspaceInvitation,
} from '../../src/workspace-invitations'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('workspace sharing', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  const user = async (label: string) =>
    (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `${label}-${crypto.randomUUID()}`,
        displayName: label,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal

  const workspaceFor = async (owner: Awaited<ReturnType<typeof user>>, name: string) =>
    (
      await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `sharing-${crypto.randomUUID()}`,
        name,
        owner,
      })
    ).workspace

  test('invitations store only a digest, are single use, expire, and can be revoked', async () => {
    const owner = await user('invite-owner')
    const member = await user('invite-member')
    const joiner = await user('invite-joiner')
    const stranger = await user('invite-stranger')
    const workspace = await workspaceFor(owner, 'Invite HQ')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    // The joiner already has a workspace of their own, so the joined one is appended.
    await workspaceFor(joiner, 'Joiner home')

    await expect(
      createWorkspaceInvitation(connection.db, workspace.id, member, {
        email: 'someone@example.com',
        role: 'member',
      })
    ).rejects.toThrow('Invitation unavailable')
    await expect(
      createWorkspaceInvitation(connection.db, workspace.id, owner, {
        email: 'not-an-email',
        role: 'member',
      })
    ).rejects.toThrow('Invitation invalid')

    const created = await createWorkspaceInvitation(connection.db, workspace.id, owner, {
      email: '  Joiner@Example.COM ',
      role: 'admin',
    })
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created.invitation).toMatchObject({
      email: 'joiner@example.com',
      role: 'admin',
      state: 'pending',
    })
    expect(
      new Date(created.invitation.expiresAt).getTime() -
        new Date(created.invitation.createdAt).getTime()
    ).toBeLessThanOrEqual(INVITATION_LIFETIME_MS + 1_000)

    const [stored] = await connection.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, created.invitation.id))
    expect(stored!.tokenDigest).toBe(createHash('sha256').update(created.token).digest('hex'))
    expect(Object.values(stored!).map(String)).not.toContain(created.token)

    const listed = await listWorkspaceInvitationsForUser(connection.db, workspace.id, owner)
    expect(listed.map(({ id }) => id)).toContain(created.invitation.id)
    expect(JSON.stringify(listed)).not.toContain(created.token)
    await expect(
      listWorkspaceInvitationsForUser(connection.db, workspace.id, member)
    ).rejects.toThrow('Invitation unavailable')

    // The wrong account, a missing email, and a malformed token are all refused alike.
    for (const attempt of [
      { email: 'other@example.com', token: created.token },
      { email: null, token: created.token },
      { email: 'joiner@example.com', token: 'short' },
    ]) {
      await expect(acceptWorkspaceInvitation(connection.db, stranger, attempt)).rejects.toThrow(
        'Invitation unavailable'
      )
    }

    const accepted = await acceptWorkspaceInvitation(connection.db, joiner, {
      email: 'JOINER@example.com',
      token: created.token,
    })
    expect(accepted).toEqual({ joined: true, workspaceId: workspace.id })
    const [membership] = await connection.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspace.id),
          eq(workspaceMemberships.userId, joiner.userId)
        )
      )
    expect(membership).toMatchObject({ role: 'admin', sortOrder: 1 })

    // Idempotent for the same user; refused for anyone else, even with the same email.
    expect(
      await acceptWorkspaceInvitation(connection.db, joiner, {
        email: 'joiner@example.com',
        token: created.token,
      })
    ).toEqual({ joined: false, workspaceId: workspace.id })
    await expect(
      acceptWorkspaceInvitation(connection.db, stranger, {
        email: 'joiner@example.com',
        token: created.token,
      })
    ).rejects.toThrow('Invitation unavailable')
    await expect(
      revokeWorkspaceInvitation(connection.db, workspace.id, created.invitation.id, owner)
    ).rejects.toThrow('Invitation already accepted')

    // Re-inviting replaces the pending invitation; the old token stops working.
    const first = await createWorkspaceInvitation(connection.db, workspace.id, owner, {
      email: 'late@example.com',
      role: 'member',
    })
    const second = await createWorkspaceInvitation(connection.db, workspace.id, owner, {
      email: 'late@example.com',
      role: 'member',
    })
    const late = await user('invite-late')
    await expect(
      acceptWorkspaceInvitation(connection.db, late, {
        email: 'late@example.com',
        token: first.token,
      })
    ).rejects.toThrow('Invitation unavailable')

    const revoked = await revokeWorkspaceInvitation(
      connection.db,
      workspace.id,
      second.invitation.id,
      owner
    )
    expect(revoked.state).toBe('revoked')
    await expect(
      acceptWorkspaceInvitation(connection.db, late, {
        email: 'late@example.com',
        token: second.token,
      })
    ).rejects.toThrow('Invitation unavailable')

    const expiring = await createWorkspaceInvitation(connection.db, workspace.id, owner, {
      email: 'late@example.com',
      role: 'member',
    })
    await expect(
      acceptWorkspaceInvitation(
        connection.db,
        late,
        { email: 'late@example.com', token: expiring.token },
        new Date(Date.now() + INVITATION_LIFETIME_MS + 60_000)
      )
    ).rejects.toThrow('Invitation unavailable')
    expect(
      (
        await listWorkspaceInvitationsForUser(
          connection.db,
          workspace.id,
          owner,
          new Date(Date.now() + INVITATION_LIFETIME_MS + 60_000)
        )
      ).find(({ id }) => id === expiring.invitation.id)?.state
    ).toBe('expired')

    // Invitation events carry ids only.
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))
    const invitationEvents = events.filter(({ eventType }) =>
      [
        'workspace.member_invited',
        'workspace.member_joined',
        'workspace.invitation_revoked',
      ].includes(eventType)
    )
    expect(new Set(invitationEvents.map(({ eventType }) => eventType))).toEqual(
      new Set([
        'workspace.member_invited',
        'workspace.member_joined',
        'workspace.invitation_revoked',
      ])
    )
    const serialized = JSON.stringify(invitationEvents.map(({ payload }) => payload))
    expect(serialized).not.toContain('@')
    expect(serialized).not.toContain(created.token)

    const members = await listWorkspaceMembersForUser(connection.db, workspace.id, member)
    expect(members.map(({ userId }) => userId).toSorted()).toEqual(
      [owner.userId, member.userId, joiner.userId].toSorted()
    )
    expect(JSON.stringify(members)).not.toContain('@')
    await expect(
      listWorkspaceMembersForUser(connection.db, workspace.id, stranger)
    ).rejects.toThrow('Workspace unavailable')
  })

  test('members-only projects are hidden from every read and from the event stream', async () => {
    const owner = await user('vis-owner')
    const admin = await user('vis-admin')
    const viewer = await user('vis-viewer')
    const outsider = await user('vis-outsider')
    const stranger = await user('vis-stranger')
    const workspace = await workspaceFor(owner, 'Visibility HQ')
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, viewer, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, outsider, 'member')

    const open = await createProject(connection.db, workspace.id, owner, {
      iconKey: 'open',
      name: 'Open plaza',
    })
    const secret = await createProject(connection.db, workspace.id, owner, {
      iconKey: 'secret',
      name: 'Zephyr secret',
    })
    expect(secret.visibility).toBe('workspace')
    const [secretChannel] = await connection.db
      .select()
      .from(channels)
      .where(eq(channels.projectId, secret.id))
    const [openChannel] = await connection.db
      .select()
      .from(channels)
      .where(eq(channels.projectId, open.id))
    const before = await listWorkspaceEventsAfter(connection.db, workspace.id, 0, 200)
    const head = before.at(-1)!.workspaceSequence

    await expect(
      setProjectVisibility(connection.db, workspace.id, secret.id, outsider, 'members')
    ).rejects.toThrow('Project sharing forbidden')
    const hidden = await setProjectVisibility(
      connection.db,
      workspace.id,
      secret.id,
      owner,
      'members'
    )
    expect(hidden.visibility).toBe('members')
    await setProjectMember(connection.db, workspace.id, secret.id, owner, {
      role: 'viewer',
      userId: viewer.userId,
    })
    await expect(
      setProjectMember(connection.db, workspace.id, secret.id, owner, {
        role: 'viewer',
        userId: stranger.userId,
      })
    ).rejects.toThrow('Project member unavailable')
    await expect(
      setProjectMember(connection.db, workspace.id, secret.id, viewer, {
        role: 'editor',
        userId: viewer.userId,
      })
    ).rejects.toThrow('Project sharing forbidden')

    const task = await createTask(
      connection.db,
      workspace.id,
      owner,
      { objective: 'Zephyr rollout', projectId: secret.id, title: 'Zephyr task' },
      { idempotencyKey: `zephyr-${crypto.randomUUID()}`, requestId: crypto.randomUUID() }
    )
    const artifact = await createArtifact(connection.db, workspace.id, owner, {
      checksumSha256: 'e'.repeat(64),
      filename: 'zephyr-plan.md',
      location: { reference: 'artifacts/zephyr-plan', type: 'object_store' },
      mediaType: 'text/markdown',
      sizeBytes: 12,
      sourceArtifactRef: `zephyr:${crypto.randomUUID()}`,
      sourcePrincipal: owner,
      taskId: task.id,
    })
    const message = await createMessage(connection.db, workspace.id, secretChannel!.id, owner, {
      bodyText: 'Zephyr launch notes',
      idempotencyKey: 'zephyr-message',
      sender: owner,
    })
    const openMessage = await createMessage(connection.db, workspace.id, openChannel!.id, owner, {
      bodyText: 'Zephyr mentioned in the open',
      idempotencyKey: 'open-message',
      sender: owner,
    })

    const privateContentId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, owner, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'b'.repeat(64),
      id: privateContentId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    await createMessage(connection.db, workspace.id, secretChannel!.id, owner, {
      bodyContentRefId: privateContentId,
      idempotencyKey: 'zephyr-private',
      sender: owner,
    })
    expect(
      await getContentRefForUser(connection.db, workspace.id, privateContentId, owner)
    ).not.toBeNull()
    expect(
      await getContentRefForUser(connection.db, workspace.id, privateContentId, outsider)
    ).toBeNull()
    await expect(
      listContentReplicasForUser(connection.db, workspace.id, privateContentId, outsider)
    ).rejects.toThrow('Content replica unavailable')

    // The outsider sees nothing of the members-only project.
    expect(
      (await listProjectsForUser(connection.db, workspace.id, outsider)).map(({ id }) => id)
    ).toEqual([open.id])
    expect(await getProjectForUser(connection.db, workspace.id, secret.id, outsider)).toBeNull()
    expect(
      (await listChannelsForUser(connection.db, workspace.id, outsider)).map(({ id }) => id)
    ).not.toContain(secretChannel!.id)
    await expect(
      getChannelForUser(connection.db, workspace.id, secretChannel!.id, outsider)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      listMessagesForUser(connection.db, workspace.id, secretChannel!.id, outsider)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      getMessageForUser(connection.db, workspace.id, message.id, outsider)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      createMessage(connection.db, workspace.id, secretChannel!.id, outsider, {
        bodyText: 'let me in',
        idempotencyKey: 'outsider-message',
        sender: outsider,
      })
    ).rejects.toThrow('Channel unavailable')
    expect(
      (await listTasksForUser(connection.db, workspace.id, outsider)).map(({ id }) => id)
    ).not.toContain(task.id)
    expect(await getTaskForUser(connection.db, workspace.id, task.id, outsider)).toBeNull()
    expect(
      (await listArtifactsForUser(connection.db, workspace.id, outsider)).map(({ id }) => id)
    ).not.toContain(artifact.id)
    expect(await getArtifactForUser(connection.db, workspace.id, artifact.id, outsider)).toBeNull()
    expect(
      (await listReadStateForUser(connection.db, workspace.id, outsider)).map(
        ({ channelId }) => channelId
      )
    ).not.toContain(secretChannel!.id)
    await expect(
      markChannelReadState(
        connection.db,
        workspace.id,
        secretChannel!.id,
        outsider,
        'read',
        message.sequence
      )
    ).rejects.toThrow('Read state unavailable')
    await expect(
      listProjectMembersForUser(connection.db, workspace.id, secret.id, outsider)
    ).rejects.toThrow('Project unavailable')
    await expect(
      updateProject(connection.db, workspace.id, secret.id, outsider, { name: 'Renamed' })
    ).rejects.toThrow('Project unavailable')
    const outsiderSearch = await searchWorkspaceForUser(
      connection.db,
      workspace.id,
      outsider,
      'zephyr'
    )
    expect(outsiderSearch.results.map(({ id }) => id)).toEqual([openMessage.id])
    expect(JSON.stringify(outsiderSearch)).not.toContain(secret.id)

    // Reordering as the outsider moves only what they can see; the hidden project keeps its slot.
    const secretOrder = secret.sortOrder
    await reorderProjects(connection.db, workspace.id, outsider, [open.id])
    expect(
      (await listProjectsForUser(connection.db, workspace.id, owner)).find(
        ({ id }) => id === secret.id
      )?.sortOrder
    ).toBe(secretOrder)

    // Owners and admins see everything.
    for (const principal of [owner, admin]) {
      expect(
        (await listProjectsForUser(connection.db, workspace.id, principal)).map(({ id }) => id)
      ).toContain(secret.id)
      const search = await searchWorkspaceForUser(connection.db, workspace.id, principal, 'zephyr')
      expect(new Set(search.results.map(({ kind }) => kind))).toEqual(
        new Set(['project', 'channel', 'task', 'artifact', 'message'])
      )
    }

    // A viewer reads but cannot write.
    expect(await getProjectForUser(connection.db, workspace.id, secret.id, viewer)).not.toBeNull()
    expect(
      (await listMessagesForUser(connection.db, workspace.id, secretChannel!.id, viewer)).messages
    ).toHaveLength(2)
    expect(
      await getContentRefForUser(connection.db, workspace.id, privateContentId, viewer)
    ).not.toBeNull()
    expect(await getTaskForUser(connection.db, workspace.id, task.id, viewer)).not.toBeNull()
    expect(
      (await listProjectMembersForUser(connection.db, workspace.id, secret.id, viewer)).map(
        ({ role, userId }) => ({ role, userId })
      )
    ).toEqual([{ role: 'viewer', userId: viewer.userId }])
    await expect(
      createMessage(connection.db, workspace.id, secretChannel!.id, viewer, {
        bodyText: 'viewer post',
        idempotencyKey: 'viewer-message',
        sender: viewer,
      })
    ).rejects.toThrow('Project read-only')
    await expect(
      editMessage(
        connection.db,
        workspace.id,
        message.id,
        viewer,
        { bodyText: 'edited' },
        message.version
      )
    ).rejects.toThrow('Project read-only')
    await expect(
      updateTask(
        connection.db,
        workspace.id,
        task.id,
        viewer,
        { title: 'Viewer rename' },
        {
          expectedVersion: task.version,
          idempotencyKey: `viewer-${crypto.randomUUID()}`,
          requestId: crypto.randomUUID(),
        }
      )
    ).rejects.toThrow('Project read-only')
    // Read state is personal, so viewers may still mark it.
    await markChannelReadState(
      connection.db,
      workspace.id,
      secretChannel!.id,
      viewer,
      'read',
      message.sequence
    )

    // Promoted to editor, the same member may post.
    await setProjectMember(connection.db, workspace.id, secret.id, owner, {
      role: 'editor',
      userId: viewer.userId,
    })
    await createMessage(connection.db, workspace.id, secretChannel!.id, viewer, {
      bodyText: 'editor post',
      idempotencyKey: 'editor-message',
      sender: viewer,
    })

    // Per-principal event classification against current state, replay included.
    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, head, 200)
    const forOutsider = (await classifyWorkspaceEventsForUser(
      connection.db,
      workspace.id,
      outsider.userId,
      events
    ))!
    const byType = (deliveries: typeof forOutsider, type: string) =>
      deliveries.filter((_, index) => events[index]!.eventType === type)
    expect(forOutsider).toHaveLength(events.length)
    expect(byType(forOutsider, 'project.visibility_changed').map(({ kind }) => kind)).toEqual([
      'redacted',
    ])
    const redacted = byType(forOutsider, 'project.visibility_changed')[0]!
    expect(redacted.kind === 'redacted' && redacted.event.payload).toEqual({})
    expect(byType(forOutsider, 'task.created').map(({ kind }) => kind)).toEqual(['withheld'])
    expect(byType(forOutsider, 'artifact.created').map(({ kind }) => kind)).toEqual(['withheld'])
    const outsiderMessages = events
      .map((event, index) => ({ delivery: forOutsider[index]!, event }))
      .filter(({ event }) => event.eventType === 'message.created')
    expect(
      outsiderMessages.map(({ delivery, event }) => [event.payload.channelId, delivery.kind])
    ).toEqual([
      [secretChannel!.id, 'withheld'],
      [openChannel!.id, 'deliver'],
      [secretChannel!.id, 'withheld'],
      [secretChannel!.id, 'withheld'],
    ])
    const reordered = byType(forOutsider, 'project.reordered')[0]!
    expect(reordered.kind === 'deliver' && reordered.event.payload.projectIds).toEqual([open.id])
    expect(JSON.stringify(forOutsider)).not.toContain(secret.id)
    expect(JSON.stringify(forOutsider)).not.toContain(task.id)

    for (const principal of [owner, admin, viewer]) {
      const deliveries = await classifyWorkspaceEventsForUser(
        connection.db,
        workspace.id,
        principal.userId,
        events
      )
      expect(deliveries!.every(({ kind }) => kind === 'deliver')).toBe(true)
    }
    expect(
      await classifyWorkspaceEventsForUser(connection.db, workspace.id, stranger.userId, events)
    ).toBeNull()

    // Removing the viewer from the project hides it again, replay included.
    expect(
      await removeProjectMember(connection.db, workspace.id, secret.id, owner, viewer.userId)
    ).toBe(true)
    expect(await getProjectForUser(connection.db, workspace.id, secret.id, viewer)).toBeNull()
    const replay = (await classifyWorkspaceEventsForUser(
      connection.db,
      workspace.id,
      viewer.userId,
      events
    ))!
    expect(byType(replay, 'task.created').map(({ kind }) => kind)).toEqual(['withheld'])

    // Leaving the workspace drops project lists too.
    await setProjectMember(connection.db, workspace.id, secret.id, owner, {
      role: 'editor',
      userId: outsider.userId,
    })
    await removeWorkspaceMembership(connection.db, workspace.id, outsider)
    await addWorkspaceMembership(connection.db, workspace.id, outsider, 'member')
    expect(await getProjectForUser(connection.db, workspace.id, secret.id, outsider)).toBeNull()

    // Back to workspace visibility, every member sees it again.
    await setProjectVisibility(connection.db, workspace.id, secret.id, owner, 'workspace')
    expect(await getProjectForUser(connection.db, workspace.id, secret.id, outsider)).not.toBeNull()
  })
})
