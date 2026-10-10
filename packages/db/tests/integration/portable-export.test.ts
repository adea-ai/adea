import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  canonicalPortableJson,
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  type PortableWorkspaceExport,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { type AgentHqDatabase, createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { exportPortableWorkspace, readCompletePortableContent } from '../../src/portable-export'
import { PortableExportError } from '../../src/portable-export-content'
import { listChannelsForUser, listMessagesForUser } from '../../src/conversations'
import { importPortableWorkspace } from '../../src/portable-import'
import { PortableImportError } from '../../src/portable-import-guards'
import { portableContentDigest } from '../../src/portable-export-content'
import {
  agents,
  artifacts,
  channelParticipants,
  channels,
  contentRefs,
  contentReplicas,
  messageArtifactReferences,
  messageMentions,
  messages,
  projectMembers,
  projects,
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  temporaryUserSessions,
  users,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

// Canaries are unique per run. Each names one class the export must never carry
// (credentials, ciphertext, locators, deleted or private-audience text), or a
// visible value a restored workspace must reproduce.
const run = randomBytes(6).toString('hex')
const canary = {
  artifactLocator: `ARTIFACT-LOCATOR-CANARY-${run}`,
  ciphertext: `CIPHERTEXTCANARY${run.padEnd(8, '0').slice(0, 8)}`,
  deletedText: `DELETED-CANARY-${run}`,
  executionRef: `EXECUTION-CANARY-${run}`,
  hiddenTask: `HIDDEN-TASK-CANARY-${run}`,
  inviteEmail: `invitee-canary-${run}@example.test`,
  membersText: `MEMBERS-PROJECT-CANARY-${run}`,
  privateText: `PRIVATE-CANARY-${run}`,
  provenance: `PROVENANCE-CANARY-${run}`,
  publicText: `PUBLIC-TEXT-${run}`,
  sessionDigest: `SESSION-CANARY-${run}`,
}

const future = () => new Date(Date.now() + 60 * 60 * 1000)

const exportOutcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'exported',
    (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
  )

const importOutcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'imported',
    (error: unknown) => (error instanceof PortableImportError ? error.code : 'other')
  )

describe.skipIf(!connectionUrl)('portable workspace export and import', () => {
  let connection: DatabaseConnection
  let db: AgentHqDatabase
  const created: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
    db = connection.db
  })

  afterAll(async () => {
    for (const workspaceId of created) await deleteWorkspace(workspaceId)
    await connection.close()
  })

  async function deleteWorkspace(workspaceId: string) {
    // Break the message thread links first: they are RESTRICT foreign keys.
    await db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, workspaceId))
    await db
      .delete(messageArtifactReferences)
      .where(eq(messageArtifactReferences.workspaceId, workspaceId))
    await db.delete(messageMentions).where(eq(messageMentions.workspaceId, workspaceId))
    await db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await db.delete(channelParticipants).where(eq(channelParticipants.workspaceId, workspaceId))
    await db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await db.delete(taskExecutionAttempts).where(eq(taskExecutionAttempts.workspaceId, workspaceId))
    await db.delete(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId))
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId))
    await db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
    await db.delete(contentReplicas).where(eq(contentReplicas.workspaceId, workspaceId))
    await db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspaceId))
    await db.delete(projectMembers).where(eq(projectMembers.workspaceId, workspaceId))
    await db.delete(projects).where(eq(projects.workspaceId, workspaceId))
    await db.delete(agents).where(eq(agents.workspaceId, workspaceId))
    await db.delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId))
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, workspaceId))
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  }

  /**
   * A workspace with every family in it: a members-only project the member is
   * not listed on, a participants-only channel and a direct channel, an archived
   * channel, a content ref with a body in the local authority, a deleted body, a
   * task objective held by reference, a cloud replica with ciphertext, an
   * artifact with a locator, and an invitation with a token and an email.
   */
  async function seed(name: string) {
    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `${canary.sessionDigest}-${name}`,
      displayName: 'Owner Person',
      expiresAt: future(),
    })
    const member = await createTemporaryUserSession(db, {
      credentialDigest: `member-${name}-${run}`,
      displayName: 'Member Person',
      expiresAt: future(),
    })
    const outsider = await createTemporaryUserSession(db, {
      credentialDigest: `outsider-${name}-${run}`,
      displayName: 'Outsider Person',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `portable-${name}-${run}`,
      name: `Portable ${name}`,
      owner: owner.principal,
    })
    created.push(workspace.id)
    const workspaceId = workspace.id
    await addWorkspaceMembership(db, workspaceId, member.principal, 'member')

    const [agentA] = await db
      .insert(agents)
      .values({
        name: 'Researcher',
        profileId: 'profile.research',
        profileVersion: '1.0.0',
        workspaceId,
      })
      .returning()
    const [agentB] = await db
      .insert(agents)
      .values({
        name: 'Members Agent',
        profileId: 'profile.members',
        profileVersion: '1.0.0',
        workspaceId,
      })
      .returning()
    const [projectA] = await db
      .insert(projects)
      .values({ iconKey: 'folder', name: 'Public', sortOrder: 0, workspaceId })
      .returning()
    const [projectB] = await db
      .insert(projects)
      .values({
        iconKey: 'lock',
        name: 'Members only',
        sortOrder: 1,
        visibility: 'members',
        workspaceId,
      })
      .returning()
    await db.insert(projectMembers).values({
      projectId: projectB!.id,
      role: 'editor',
      userId: owner.principal.userId,
      workspaceId,
    })

    const channel = async (
      values: Partial<typeof channels.$inferInsert> & { idempotencyKey: string; title: string }
    ) =>
      (
        await db
          .insert(channels)
          .values({ kind: 'group', visibility: 'workspace', workspaceId, ...values })
          .returning()
      )[0]!
    const general = await channel({
      idempotencyKey: 'general',
      isPrimaryProjectChannel: true,
      kind: 'project',
      projectId: projectA!.id,
      sortOrder: 0,
      title: 'General',
    })
    const privateGroup = await channel({
      idempotencyKey: 'private',
      sortOrder: 1,
      title: 'Private',
      visibility: 'participants',
    })
    const membersLane = await channel({
      idempotencyKey: 'members-lane',
      isPrimaryProjectChannel: true,
      kind: 'project',
      projectId: projectB!.id,
      sortOrder: 2,
      title: 'Members lane',
    })
    const archived = await channel({
      idempotencyKey: 'archived',
      lifecycleState: 'archived',
      sortOrder: 3,
      title: 'Archived',
    })
    const direct = await channel({
      agentId: agentA!.id,
      idempotencyKey: 'topic-direct',
      kind: 'direct_agent',
      sortOrder: 4,
      title: 'Direct',
      visibility: 'participants',
    })
    await db.insert(channelParticipants).values([
      {
        channelId: privateGroup.id,
        principalKind: 'user',
        userId: owner.principal.userId,
        workspaceId,
      },
      { agentId: agentA!.id, channelId: privateGroup.id, principalKind: 'agent', workspaceId },
      { channelId: direct.id, principalKind: 'user', userId: owner.principal.userId, workspaceId },
    ])

    const message = async (
      values: Partial<typeof messages.$inferInsert> & { channelId: string; idempotencyKey: string }
    ) =>
      (
        await db
          .insert(messages)
          .values({
            createPayloadHash: 'a'.repeat(64),
            senderKind: 'user',
            senderUserId: owner.principal.userId,
            workspaceId,
            ...values,
          })
          .returning()
      )[0]!
    const m1 = await message({
      bodyText: canary.publicText,
      channelId: general.id,
      idempotencyKey: 'm1',
    })
    const m2 = await message({
      bodyText: 'Agent reply',
      channelId: general.id,
      idempotencyKey: 'm2',
      replyToMessageId: m1.id,
      senderAgentId: agentA!.id,
      senderKind: 'agent',
      senderUserId: null,
      threadRootMessageId: m1.id,
    })
    const m3 = await message({
      bodyText: 'Member note',
      channelId: general.id,
      idempotencyKey: 'm3',
      senderUserId: member.principal.userId,
    })
    await db.insert(messageMentions).values({
      messageId: m1.id,
      principalKind: 'user',
      userId: member.principal.userId,
      workspaceId,
    })
    await message({
      bodyText: canary.deletedText,
      channelId: general.id,
      deletedAt: new Date(),
      idempotencyKey: 'm4',
      version: 2,
    })
    const [crMessage] = await db
      .insert(contentRefs)
      .values({
        availability: 'offline',
        contentType: 'message_body',
        digestSha256: 'b'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        workspaceId,
      })
      .returning()
    const [crDeleted] = await db
      .insert(contentRefs)
      .values({
        availability: 'deleted',
        contentType: 'message_body',
        deletedAt: new Date(),
        digestSha256: 'c'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        workspaceId,
      })
      .returning()
    await message({
      channelId: general.id,
      idempotencyKey: 'm5',
      bodyContentRefId: crMessage!.id,
      bodyText: null,
    })
    await message({
      channelId: general.id,
      idempotencyKey: 'm6',
      bodyContentRefId: crDeleted!.id,
      bodyText: null,
    })
    await message({
      bodyText: canary.privateText,
      channelId: privateGroup.id,
      idempotencyKey: 'p1',
    })
    const b1 = await message({
      bodyText: canary.membersText,
      channelId: membersLane.id,
      idempotencyKey: 'b1',
    })
    await message({ bodyText: 'Direct message', channelId: direct.id, idempotencyKey: 'd1' })

    const [tA] = await db
      .insert(tasks)
      .values({
        agentId: agentA!.id,
        channelId: general.id,
        creatorUserId: owner.principal.userId,
        kind: 'feature',
        lifecycleState: 'in_progress',
        messageId: m1.id,
        objective: 'Write the public plan.',
        projectId: projectA!.id,
        title: 'Public task',
        workspaceId,
      })
      .returning()
    const [crObjective] = await db
      .insert(contentRefs)
      .values({
        availability: 'missing',
        contentType: 'task_objective',
        digestSha256: 'd'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'restricted',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        taskId: null,
        workspaceId,
      })
      .returning()
    const [tC] = await db
      .insert(tasks)
      .values({
        creatorUserId: owner.principal.userId,
        objective: null,
        objectiveContentRefId: crObjective!.id,
        projectId: projectA!.id,
        title: 'Objective by reference',
        workspaceId,
      })
      .returning()
    const [tB] = await db
      .insert(tasks)
      .values({
        agentId: agentB!.id,
        channelId: membersLane.id,
        creatorUserId: owner.principal.userId,
        lifecycleState: 'queued',
        messageId: b1.id,
        objective: 'Hidden objective.',
        projectId: projectB!.id,
        title: canary.hiddenTask,
        workspaceId,
      })
      .returning()
    await db.insert(taskDependencies).values([
      { dependsOnTaskId: tC!.id, taskId: tA!.id, workspaceId },
      { dependsOnTaskId: tB!.id, taskId: tA!.id, workspaceId },
    ])
    await db.insert(taskExecutionAttempts).values({
      attempt: 1,
      change: 'initial',
      locationKind: 'agent_hq_cloud',
      taskId: tA!.id,
      workspaceId,
    })

    await db.insert(contentReplicas).values({
      availability: 'available',
      ciphertext: canary.ciphertext.padEnd(24, 'A').slice(0, 24),
      contentRefId: crMessage!.id,
      digestSha256: 'e'.repeat(64),
      nonce: 'NONCECANARY000AA',
      replicaKind: 'self_hosted_authority',
      revision: 1,
      schemaVersion: 1,
      workspaceId,
    })
    const [artifact] = await db
      .insert(artifacts)
      .values({
        checksumSha256: 'f'.repeat(64),
        createPayloadHash: '0'.repeat(64),
        executionRef: canary.executionRef,
        filename: 'plan.pdf',
        locationRef: canary.artifactLocator,
        locationType: 'object_store',
        mediaType: 'application/pdf',
        ownerPrincipalId: owner.principal.userId,
        ownerPrincipalKind: 'user',
        provenance: { origin: canary.provenance },
        sizeBytes: 10,
        sourceArtifactRef: `source-${run}`,
        sourcePrincipalId: owner.principal.userId,
        sourcePrincipalKind: 'user',
        taskId: tA!.id,
        workspaceId,
      })
      .returning()
    await db
      .insert(messageArtifactReferences)
      .values({ artifactId: artifact!.id, messageId: m1.id, workspaceId })
    await db.insert(workspaceInvitations).values({
      email: canary.inviteEmail,
      expiresAt: future(),
      invitedByUserId: owner.principal.userId,
      role: 'member',
      tokenDigest: randomBytes(32).toString('hex'),
      workspaceId,
    })

    return {
      agentA: agentA!,
      artifact: artifact!,
      channels: { archived, direct, general, membersLane, privateGroup },
      member,
      messages: { b1, m1, m2, m3 },
      outsider,
      owner,
      projectA: projectA!,
      projectB: projectB!,
      tA: tA!,
      tB: tB!,
      tC: tC!,
      workspaceId,
    }
  }

  test('an owner export holds the whole workspace as a valid, digest-bearing document', async () => {
    const fixture = await seed('owner')
    const document = await exportPortableWorkspace(db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })

    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(document.exportedBy).toEqual({ role: 'owner', userId: fixture.owner.principal.userId })
    expect(document.content.projects.map((project) => project.projectId).toSorted()).toEqual(
      [fixture.projectA.id, fixture.projectB.id].toSorted()
    )
    expect(document.content.channels).toHaveLength(4)
    expect(document.content.messages).toHaveLength(9)
    expect(document.content.tasks.map((task) => task.taskId).toSorted()).toEqual(
      [fixture.tA.id, fixture.tB.id, fixture.tC.id].toSorted()
    )
    expect(document.contentDigest.value).toBe(portableContentDigest(document.content))
    expect(canonicalPortableJson(document.exclusions)).toBe(
      canonicalPortableJson(PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS)
    )
  })

  test('a member receives only the audience they are entitled to, with links to withheld records cleared', async () => {
    const fixture = await seed('member')
    const document = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })

    expect(document.exportedBy.role).toBe('member')
    expect(document.content.projects.map((project) => project.projectId)).toEqual([
      fixture.projectA.id,
    ])
    expect(document.content.channels.map((channel) => channel.channelId)).toEqual([
      fixture.channels.general.id,
    ])
    const generalMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, fixture.channels.general.id))
    expect(document.content.messages.map((message) => message.messageId).toSorted()).toEqual(
      generalMessages.map((row) => row.id).toSorted()
    )
    expect(document.content.messages.map((message) => message.channelId)).not.toContain(
      fixture.channels.privateGroup.id
    )
    expect(document.content.tasks.map((task) => task.taskId).toSorted()).toEqual(
      [fixture.tA.id, fixture.tC.id].toSorted()
    )
    expect(document.content.taskDependencies).toEqual([
      { dependsOnTaskId: fixture.tC.id, taskId: fixture.tA.id },
    ])
    expect(document.content.agents.map((agent) => agent.agentId)).toEqual([fixture.agentA.id])
    expect(document.content.users.map((user) => user.userId).toSorted()).toEqual(
      [fixture.owner.principal.userId, fixture.member.principal.userId].toSorted()
    )
    const serialized = JSON.stringify(document)
    expect(serialized).not.toContain(canary.privateText)
    expect(serialized).not.toContain(canary.membersText)
    expect(serialized).not.toContain(canary.hiddenTask)
    expect(serialized).not.toContain(fixture.outsider.principal.userId)
    expect(serialized).not.toContain(fixture.projectB.id)
  })

  test('denies an outsider, and a removed member loses access until re-added', async () => {
    const fixture = await seed('revoked')

    expect(
      await exportOutcome(
        exportPortableWorkspace(db, {
          principal: fixture.outsider.principal,
          workspaceId: fixture.workspaceId,
        })
      )
    ).toBe('denied')

    expect(await removeWorkspaceMembership(db, fixture.workspaceId, fixture.member.principal)).toBe(
      true
    )
    expect(
      await exportOutcome(
        exportPortableWorkspace(db, {
          principal: fixture.member.principal,
          workspaceId: fixture.workspaceId,
        })
      )
    ).toBe('denied')

    await addWorkspaceMembership(db, fixture.workspaceId, fixture.member.principal, 'member')
    const reinstated = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    expect(reinstated.content.messages.length).toBeGreaterThan(0)
  })

  test('refuses an export while the workspace is being deleted', async () => {
    const fixture = await seed('deleting')
    await db
      .update(workspaces)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(workspaces.id, fixture.workspaceId))
    const error = await exportPortableWorkspace(db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PortableExportError)
    expect((error as PortableExportError).code).toBe('denied')
  })

  test('withdraws a participants-only channel from a participant once they are removed', async () => {
    const fixture = await seed('participant')
    await db.insert(channelParticipants).values({
      channelId: fixture.channels.privateGroup.id,
      principalKind: 'user',
      userId: fixture.member.principal.userId,
      workspaceId: fixture.workspaceId,
    })
    const joined = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    expect(joined.content.channels.map((channel) => channel.channelId)).toContain(
      fixture.channels.privateGroup.id
    )
    expect(JSON.stringify(joined)).toContain(canary.privateText)

    await db
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.channelId, fixture.channels.privateGroup.id),
          eq(channelParticipants.userId, fixture.member.principal.userId)
        )
      )
    const removed = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    expect(removed.content.channels.map((channel) => channel.channelId)).not.toContain(
      fixture.channels.privateGroup.id
    )
    expect(JSON.stringify(removed)).not.toContain(canary.privateText)
  })

  test('no export carries credentials, ciphertext, artifact locators, deleted text or invitations', async () => {
    const fixture = await seed('secrets')
    const documents = await Promise.all([
      exportPortableWorkspace(db, {
        principal: fixture.owner.principal,
        workspaceId: fixture.workspaceId,
      }),
      exportPortableWorkspace(db, {
        principal: fixture.member.principal,
        workspaceId: fixture.workspaceId,
      }),
    ])
    const forbidden = [
      canary.sessionDigest,
      canary.inviteEmail,
      canary.ciphertext,
      canary.artifactLocator,
      canary.provenance,
      canary.executionRef,
      canary.deletedText,
      'NONCECANARY000AA',
      fixture.artifact.id,
      fixture.outsider.principal.userId,
    ]
    for (const document of documents) {
      const serialized = JSON.stringify(document)
      for (const value of forbidden) expect(serialized).not.toContain(value)
    }
    const owner = documents[0]!
    const contentRef = owner.content.contentRefs.find((ref) => ref.bodyState === 'local_authority')
    expect(contentRef?.synchronizationPolicy).toBe('local_only')
    expect(owner.content.contentRefs.some((ref) => ref.bodyState === 'deleted')).toBe(true)
    expect(
      owner.content.messages.find((message) => message.body.kind === 'deleted')?.deletedAt
    ).not.toBeNull()
  })

  test('a bundle restores into a clean destination exactly, and keeps residency unchanged', async () => {
    const fixture = await seed('restore')
    const bundle = await exportPortableWorkspace(db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const importer = await createTemporaryUserSession(db, {
      credentialDigest: `importer-${run}-restore`,
      displayName: 'Importer Person',
      expiresAt: future(),
    })
    // The destination must be clean: the source workspace is removed first, so
    // the bundle is the only copy and the restore starts from nothing.
    await deleteWorkspace(fixture.workspaceId)
    const [gone] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, fixture.workspaceId))
    expect(gone).toBeUndefined()
    const restored = await importPortableWorkspace(db, { bundle, importer: importer.principal })
    created.push(restored.workspaceId)

    expect(restored.workspaceId).toBe(fixture.workspaceId)
    expect(restored.counts.messages).toBe(9)
    expect(restored.counts.tasks).toBe(3)
    expect(restored.deferred).toEqual(PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS)

    // The restored workspace reproduces every record of the bundle, read with the
    // complete reader that the import itself verified against.
    const target = await db.transaction((transaction) =>
      readCompletePortableContent(transaction, fixture.workspaceId)
    )
    expect(portableContentDigest(target!)).toBe(bundle.contentDigest.value)

    const memberships = await db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, fixture.workspaceId))
    expect(memberships.map((row) => [row.userId, row.role])).toEqual([
      [importer.principal.userId, 'owner'],
    ])

    // Residency: bodies, ciphertext, artifacts and invitations do not enter the
    // destination; content refs stay local-only and report no body.
    const refs = await db
      .select()
      .from(contentRefs)
      .where(eq(contentRefs.workspaceId, fixture.workspaceId))
    expect(refs.find((ref) => ref.synchronizationPolicy !== 'local_only')).toBeUndefined()
    expect(refs.filter((ref) => ref.availability === 'missing')).toHaveLength(2)
    expect(refs.filter((ref) => ref.availability === 'deleted').every((ref) => ref.deletedAt)).toBe(
      true
    )
    expect(
      await db
        .select()
        .from(contentReplicas)
        .where(eq(contentReplicas.workspaceId, fixture.workspaceId))
    ).toEqual([])
    expect(
      await db.select().from(artifacts).where(eq(artifacts.workspaceId, fixture.workspaceId))
    ).toEqual([])
    expect(
      await db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.workspaceId, fixture.workspaceId))
    ).toEqual([])
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.workspaceId, fixture.workspaceId))
    expect(stored.some((row) => row.bodyText?.includes(canary.deletedText))).toBe(false)

    // A second import of the same bundle is refused: the workspace now exists.
    const again = await importPortableWorkspace(db, { bundle, importer: importer.principal }).catch(
      (caught: unknown) => caught
    )
    expect((again as PortableImportError).code).toBe('target_exists')
    const sessions = await db
      .select({ id: temporaryUserSessions.id })
      .from(temporaryUserSessions)
      .where(eq(temporaryUserSessions.credentialDigest, `importer-${run}-restore`))
    expect(sessions).toHaveLength(1)
  })

  test('the import refuses every defective bundle before the destination changes', async () => {
    const fixture = await seed('refuse')
    const bundle = await exportPortableWorkspace(db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const importer = { kind: 'user' as const, userId: fixture.outsider.principal.userId }

    const tampered = structuredClone(bundle) as PortableWorkspaceExport
    const textMessage = tampered.content.messages.find((message) => message.body.kind === 'text')
    expect(textMessage).toBeDefined()
    ;(textMessage!.body as { text: string }).text = 'Edited after export'
    expect(await importOutcome(importPortableWorkspace(db, { bundle: tampered, importer }))).toBe(
      'digest_mismatch'
    )

    const extra = structuredClone(bundle) as unknown as Record<string, unknown>
    ;(extra.content as Record<string, unknown>).credentials = []
    expect(await importOutcome(importPortableWorkspace(db, { bundle: extra, importer }))).toBe(
      'invalid_document'
    )

    const unknownImporter = {
      kind: 'user' as const,
      userId: '00000000-0000-4000-8000-00000000dead',
    }
    expect(
      await importOutcome(importPortableWorkspace(db, { bundle, importer: unknownImporter }))
    ).toBe('importer_unavailable')

    // A fresh workspace that names a user the destination does not hold is refused.
    const phantom = {
      ...bundle,
      content: {
        ...bundle.content,
        users: [
          ...bundle.content.users,
          { displayName: null, userId: '00000000-0000-4000-8000-00000000beef' },
        ],
        workspace: {
          ...bundle.content.workspace,
          workspaceId: '00000000-0000-4000-8000-0000000fee01',
        },
      },
    } as unknown as PortableWorkspaceExport
    const rebound = {
      ...phantom,
      contentDigest: {
        algorithm: 'sha256' as const,
        value: portableContentDigest(phantom.content),
      },
    }
    expect(await importOutcome(importPortableWorkspace(db, { bundle: rebound, importer }))).toBe(
      'unresolved_users'
    )
    expect(
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, '00000000-0000-4000-8000-0000000fee01'))
    ).toEqual([])

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, importer.userId))
    expect(await importOutcome(importPortableWorkspace(db, { bundle: rebound, importer }))).toBe(
      'importer_unavailable'
    )
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, importer.userId))
  })

  test('a visible record never names a withheld one: links to hidden channels, tasks and messages are cleared', async () => {
    const fixture = await seed('links')
    const [visibleTask] = await db
      .insert(tasks)
      .values({
        channelId: fixture.channels.privateGroup.id,
        creatorUserId: fixture.owner.principal.userId,
        messageId: fixture.messages.m1.id,
        objective: 'Linked to a private channel.',
        projectId: fixture.projectA.id,
        title: 'Visible task with hidden links',
        workspaceId: fixture.workspaceId,
      })
      .returning()
    await db
      .update(messages)
      .set({ taskId: fixture.tB.id })
      .where(eq(messages.id, fixture.messages.m2.id))

    const document = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    const task = document.content.tasks.find((row) => row.taskId === visibleTask!.id)
    expect(task?.channelId).toBeNull()
    expect(task?.messageId).toBe(fixture.messages.m1.id)
    const reply = document.content.messages.find((row) => row.messageId === fixture.messages.m2.id)
    expect(reply?.taskId).toBeNull()
    expect(JSON.stringify(document)).not.toContain(fixture.tB.id)
    expect(JSON.stringify(document)).not.toContain(fixture.channels.privateGroup.id)
    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
  })

  test('a project grant governs members-only visibility, and withdrawing it hides the project again', async () => {
    const fixture = await seed('grant')
    const granted = await db
      .insert(projectMembers)
      .values({
        projectId: fixture.projectB.id,
        role: 'viewer',
        userId: fixture.member.principal.userId,
        workspaceId: fixture.workspaceId,
      })
      .returning()
    const withGrant = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    expect(withGrant.content.projects.map((project) => project.projectId)).toContain(
      fixture.projectB.id
    )
    expect(JSON.stringify(withGrant)).toContain(canary.membersText)

    await db.delete(projectMembers).where(eq(projectMembers.id, granted[0]!.id))
    const withoutGrant = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    expect(withoutGrant.content.projects.map((project) => project.projectId)).not.toContain(
      fixture.projectB.id
    )
    expect(JSON.stringify(withoutGrant)).not.toContain(canary.membersText)
  })

  test('the export carries exactly the messages the canonical readers serve the same principal', async () => {
    const fixture = await seed('composition')
    const database = connection.db
    for (const principal of [fixture.owner.principal, fixture.member.principal]) {
      const served: string[] = []
      for (const channel of await listChannelsForUser(database, fixture.workspaceId, principal)) {
        let afterSequence: number | undefined
        for (;;) {
          const page = await listMessagesForUser(
            database,
            fixture.workspaceId,
            channel.id,
            principal,
            {
              afterSequence,
              limit: 100,
            }
          )
          served.push(...page.messages.map((message) => message.id))
          if (page.nextAfterSequence === undefined) break
          afterSequence = page.nextAfterSequence
        }
      }
      const document = await exportPortableWorkspace(database, {
        principal,
        workspaceId: fixture.workspaceId,
      })
      expect(document.content.messages.map((message) => message.messageId).toSorted()).toEqual(
        served.toSorted()
      )
    }
  })

  test('an encoded job binding never leaves through a system sender or a linked runtime reference', async () => {
    const fixture = await seed('binding')
    const binding = `job-outbound:v1:${run}:${randomBytes(16).toString('base64url')}`
    await db.insert(messages).values({
      bodyText: 'Publication body text',
      channelId: fixture.channels.general.id,
      createPayloadHash: 'b'.repeat(64),
      executionRef: `exec:${binding}`,
      externalSessionRef: `session:${binding}`,
      idempotencyKey: `publication-${run}`,
      senderKind: 'system',
      senderSystemId: binding,
      workspaceId: fixture.workspaceId,
    })
    await db
      .update(tasks)
      .set({ artifactRefs: [binding] })
      .where(eq(tasks.id, fixture.tA.id))

    const owner = await exportPortableWorkspace(db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const member = await exportPortableWorkspace(db, {
      principal: fixture.member.principal,
      workspaceId: fixture.workspaceId,
    })
    for (const document of [owner, member]) {
      const serialized = JSON.stringify(document)
      expect(serialized).not.toContain(binding)
      expect(serialized).not.toContain(run + ':')
    }
    const publication = owner.content.messages.find(
      (message) => message.body.kind === 'text' && message.body.text === 'Publication body text'
    )
    expect(publication?.sender).toEqual({ kind: 'system', systemId: 'system' })
  })

  test('refuses a workspace above the portable bound instead of truncating it', async () => {
    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `bound-owner-${run}`,
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `bound-${run}`,
      name: 'Bound',
      owner: owner.principal,
    })
    created.push(workspace.id)
    const rows = Array.from({ length: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1 }, (_, index) => ({
      iconKey: 'folder',
      name: `Project ${index}`,
      sortOrder: index,
      workspaceId: workspace.id,
    }))
    for (let offset = 0; offset < rows.length; offset += 1000)
      await db.insert(projects).values(rows.slice(offset, offset + 1000))

    const error = await exportPortableWorkspace(db, {
      principal: owner.principal,
      workspaceId: workspace.id,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PortableExportError)
    expect((error as PortableExportError).code).toBe('too_large')
  }, 120_000)
})
