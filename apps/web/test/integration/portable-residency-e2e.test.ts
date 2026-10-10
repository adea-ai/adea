// End-to-end authorized export and import residency proof (M18.02.2, #1226).
//
// The source is built only through existing product APIs: a workspace, a participants-only group, a
// members-only project with a task, content refs and their cloud replica row, artifacts that carry
// object-store, external-harness and native execution references, native session references on a
// message, a workspace invitation and a temporary session. Every bundle is produced by the GET handler.
// The owner's bundle is restored by the POST handler into a clean scratch database created on the
// provisioning instance, as portable-workspace-clean-restore does. Nothing here transplants a native
// checkpoint, and the replica row is written by upsertContentReplica rather than by invented storage.
//
// What it proves:
//   - source-owned audience filtering: each requester's bundle carries only what that requester may read.
//   - no credential, ciphertext, locator, provenance or native reference leaves in any bundle or reaches
//     the destination.
//   - destination refusals: an existing workspace, an importer without permission, a ledger class the
//     version-1 format does not name, and a digest mismatch. Each refusal writes nothing.
//   - explicit external domains: the import reports every withheld external domain as unavailable.
//
// Upstream dependencies, not claimed here: artifact bytes and provenance redaction (#86), replica sync
// keys and restore (#193), native session and checkpoint portability (no port exists: that state stays on
// the node), pre-join content (#1232) and withheld job publication (#1237).
//
// The scratch database is required. This file fails rather than skipping when
// MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is missing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  PORTABLE_EXTERNAL_DOMAIN_CLASSES,
  validatePortableWorkspaceExport,
  type PortableWorkspaceExport,
} from '@adea-ai/types'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  addWorkspaceMembership,
  artifacts,
  channelParticipants,
  channels,
  contentRefs,
  contentReplicas,
  createArtifact,
  createContentRef,
  createDatabase,
  createGroupChannel,
  createMessage,
  createProject,
  createProjectChannel,
  createTask,
  createTemporaryUserSession,
  createWorkspaceInvitation,
  createWorkspaceWithOwner,
  type DatabaseConnection,
  digestInvitationToken,
  getChannelForUser,
  listChannelsForUser,
  listMessagesForUser,
  messageArtifactReferences,
  messageMentions,
  messages,
  projectMembers,
  projects,
  setChannelParticipants,
  setProjectMember,
  setProjectVisibility,
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  temporaryUserSessions,
  upsertContentReplica,
  users,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from '@adea-ai/db'

import {
  portableImportResponse,
  portableWorkspaceExportResponse,
} from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

type Session = Awaited<ReturnType<typeof createTemporaryUserSession>>

const sourceUrl = process.env.DATABASE_URL
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!sourceUrl || !provisioningUrl)
  throw new Error(
    'DATABASE_URL and MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL are required: this residency proof restores into a disposable database and must not skip'
  )

const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const canary = {
  artifactLocator: `ARTIFACT-LOCATOR-${run}`,
  artifactProvenance: `ARTIFACT-PROVENANCE-${run}`,
  executionRef: `EXECUTION-REF-${run}`,
  externalHarness: `EXTERNAL-HARNESS-${run}`,
  externalHarnessId: `external-harness-id-${run}`,
  externalSession: `EXTERNAL-SESSION-${run}`,
  inviteEmail: `invitee-${run}@example.test`,
  membersText: `MEMBERS-ONLY-${run}`,
  privateText: `PRIVATE-GROUP-${run}`,
  sessionDigest: `SESSION-DIGEST-${run}`,
  unknownClass: `unknown-domain-${run}`,
}

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function scratchNameFor() {
  return `portable_residency_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_residency_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

function resolutionFor(
  principal: WorkspacePrincipalResolution['principal']
): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
}

function exportRequest() {
  return new Request('http://localhost/api/v1/workspaces/x/portable-export')
}

function importRequest(body: unknown) {
  return new Request('http://localhost/api/v1/portable-imports', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

function assertAbsent(text: string, values: readonly string[]) {
  for (const value of values) expect(text).not.toContain(value)
}

describe('end-to-end authorized export and import residency', () => {
  let connection: DatabaseConnection
  let admin: DatabaseConnection
  let destination: DatabaseConnection
  let scratch: string
  let workspaceId: string
  let owner: Session
  let member: Session
  let outsider: Session
  let groupId: string
  let projectId: string
  let taskId: string
  let groupBodyRef: string
  let taskObjectiveRef: string
  let replicaCiphertext: string
  let replicaNonce: string
  let inviteToken: string
  let ownerText: string
  let ownerBundle: PortableWorkspaceExport
  let destinationMessages = -1
  let restoredBody: {
    contentDigest: string
    externalDomains: { authority: string; class: string; status: string; treatment: string }[]
  }

  async function createRef(
    contentType: 'message_body' | 'task_objective',
    synchronizationPolicy: 'agent_hq_e2ee_sync' | 'local_only' = 'local_only'
  ): Promise<string> {
    const id = randomUUID()
    await createContentRef(connection.db, workspaceId, owner.principal, {
      availability: 'offline',
      contentType,
      digestSha256: 'a'.repeat(64),
      id,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'sensitive',
      storagePolicy: 'local_authority',
      synchronizationPolicy,
    })
    return id
  }

  /** The bundle the GET handler serves to a principal, with its raw text for the leakage checks. */
  async function exportAs(principal: Session['principal']) {
    const response = await portableWorkspaceExportResponse(
      exportRequest(),
      connection.db,
      resolutionFor(principal),
      workspaceId
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    return { bundle: JSON.parse(text) as PortableWorkspaceExport, text }
  }

  async function removeSource(id: string) {
    const db = connection.db
    await db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, id))
    await db.delete(messageArtifactReferences).where(eq(messageArtifactReferences.workspaceId, id))
    await db.delete(messageMentions).where(eq(messageMentions.workspaceId, id))
    await db.delete(messages).where(eq(messages.workspaceId, id))
    await db.delete(channelParticipants).where(eq(channelParticipants.workspaceId, id))
    await db.delete(channels).where(eq(channels.workspaceId, id))
    await db.delete(taskExecutionAttempts).where(eq(taskExecutionAttempts.workspaceId, id))
    await db.delete(taskDependencies).where(eq(taskDependencies.workspaceId, id))
    await db.delete(tasks).where(eq(tasks.workspaceId, id))
    await db.delete(artifacts).where(eq(artifacts.workspaceId, id))
    await db.delete(contentReplicas).where(eq(contentReplicas.workspaceId, id))
    await db.delete(contentRefs).where(eq(contentRefs.workspaceId, id))
    await db.delete(projectMembers).where(eq(projectMembers.workspaceId, id))
    await db.delete(projects).where(eq(projects.workspaceId, id))
    await db.delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, id))
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, id))
    await db.delete(workspaces).where(eq(workspaces.id, id))
  }

  beforeAll(async () => {
    connection = createDatabase(sourceUrl!)
    owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${canary.sessionDigest}-owner`,
      displayName: 'Residency Owner',
      expiresAt: future(),
    })
    member = await createTemporaryUserSession(connection.db, {
      credentialDigest: `residency-member-${run}`,
      displayName: 'Residency Member',
      expiresAt: future(),
    })
    outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `residency-outsider-${run}`,
      displayName: 'Residency Outsider',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `residency-${run}`,
      name: 'Residency source',
      owner: owner.principal,
    })
    workspaceId = workspace.id
    await addWorkspaceMembership(connection.db, workspaceId, member.principal, 'member')
    await addWorkspaceMembership(connection.db, workspaceId, outsider.principal, 'member')

    // A participants-only group: the owner and the member. The outsider is not a participant.
    const group = await createGroupChannel(connection.db, workspaceId, owner.principal, {
      idempotencyKey: `residency-group-${run}`,
      title: 'Residency group',
    })
    groupId = group.id
    await setChannelParticipants(
      connection.db,
      workspaceId,
      groupId,
      owner.principal,
      [
        { kind: 'user', userId: owner.principal.userId },
        { kind: 'user', userId: member.principal.userId },
      ],
      (await getChannelForUser(connection.db, workspaceId, groupId, owner.principal)).version
    )
    // A message whose body lives in the local authority, with a cloud replica row for that body.
    // Replica rows are accepted only for refs under the E2E synchronization policy (#193 boundary).
    groupBodyRef = await createRef('message_body', 'agent_hq_e2ee_sync')
    await createMessage(connection.db, workspaceId, groupId, owner.principal, {
      bodyContentRefId: groupBodyRef,
      idempotencyKey: `residency-group-body-${run}`,
      sender: owner.principal,
    })
    replicaCiphertext = randomBytes(48).toString('base64url')
    replicaNonce = randomBytes(12).toString('base64url')
    await upsertContentReplica(connection.db, workspaceId, groupBodyRef, owner.principal, {
      availability: 'available',
      ciphertext: replicaCiphertext,
      digestSha256: sha256(replicaCiphertext),
      nonce: replicaNonce,
      replicaKind: 'self_hosted_authority',
      revision: 1,
      schemaVersion: 1,
    })
    // A private message that carries native execution and session references.
    ownerText = canary.privateText
    await createMessage(connection.db, workspaceId, groupId, owner.principal, {
      bodyText: ownerText,
      executionRef: canary.executionRef,
      externalSessionRef: canary.externalSession,
      idempotencyKey: `residency-group-text-${run}`,
      sender: owner.principal,
    })

    // A members-only project the member is listed on as a viewer. The outsider is not listed.
    const project = await createProject(connection.db, workspaceId, owner.principal, {
      iconKey: 'folder',
      name: `Residency project ${run}`,
    })
    projectId = project.id
    await setProjectVisibility(connection.db, workspaceId, projectId, owner.principal, 'members')
    await setProjectMember(connection.db, workspaceId, projectId, owner.principal, {
      role: 'viewer',
      userId: member.principal.userId,
    })
    const projectChannel = await createProjectChannel(
      connection.db,
      workspaceId,
      projectId,
      owner.principal,
      { idempotencyKey: `residency-project-channel-${run}`, title: 'Residency project lane' }
    )
    await createMessage(connection.db, workspaceId, projectChannel.id, owner.principal, {
      bodyText: canary.membersText,
      idempotencyKey: `residency-project-text-${run}`,
      sender: owner.principal,
    })
    taskObjectiveRef = await createRef('task_objective')
    const task = await createTask(
      connection.db,
      workspaceId,
      owner.principal,
      { objectiveContentRefId: taskObjectiveRef, projectId, title: `Residency task ${run}` },
      { idempotencyKey: `residency-task-${run}`, requestId: randomUUID() }
    )
    taskId = task.id

    // Artifacts: an object-store locator with provenance, and an external harness reference.
    await createArtifact(connection.db, workspaceId, owner.principal, {
      checksumSha256: 'c'.repeat(64),
      executionRef: canary.executionRef,
      filename: 'plan.pdf',
      location: { reference: canary.artifactLocator, type: 'object_store' },
      mediaType: 'application/pdf',
      provenance: { origin: canary.artifactProvenance },
      sizeBytes: 10,
      sourceArtifactRef: `plan-${run}`,
      sourcePrincipal: owner.principal,
      taskId,
    })
    await createArtifact(connection.db, workspaceId, owner.principal, {
      checksumSha256: 'd'.repeat(64),
      filename: 'trace.txt',
      location: {
        externalHarnessId: canary.externalHarnessId,
        reference: canary.externalHarness,
        type: 'external_harness',
      },
      mediaType: 'text/plain',
      sizeBytes: 4,
      sourceArtifactRef: `trace-${run}`,
      sourcePrincipal: owner.principal,
      taskId,
    })

    // A workspace invitation. Its token and email must never leave the source.
    inviteToken = (
      await createWorkspaceInvitation(connection.db, workspaceId, owner.principal, {
        email: canary.inviteEmail,
        role: 'member',
      })
    ).token

    // The clean destination: a scratch database on the provisioning instance, migrated from the
    // repository's migrations, with the users the owner's bundle names provisioned. The restore never
    // creates identities.
    ownerBundle = (await exportAs(owner.principal)).bundle
    scratch = scratchNameFor()
    assertDisposableScratch(scratch)
    admin = createDatabase(urlForDatabase('postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    destination = createDatabase(urlForDatabase(scratch))
    await migrate(destination.db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/drizzle`,
    })
    await destination.db.insert(users).values(
      ownerBundle.content.users.map((user) => ({
        displayName: user.displayName,
        id: user.userId,
      }))
    )
    const restored = await portableImportResponse(
      importRequest(ownerBundle),
      destination.db,
      resolutionFor(owner.principal),
      async () => true
    )
    expect(restored.status).toBe(201)
    restoredBody = await restored.json()
    destinationMessages = (
      await destination.db.execute(sql`select count(*)::int as n from app.messages`)
    )[0]!.n as number
  }, 600_000)

  afterAll(async () => {
    try {
      await destination?.close()
    } finally {
      if (admin) {
        assertDisposableScratch(scratch)
        await admin.client.unsafe(`drop database if exists "${scratch}" with (force)`)
        await admin.close()
      }
      if (workspaceId && connection) await removeSource(workspaceId)
      await connection?.close()
    }
  }, 300_000)

  test('every requester receives a valid bundle, and the owner receives the whole source view', async () => {
    const owned = await exportAs(owner.principal)
    expect(validatePortableWorkspaceExport(owned.bundle).ok).toBe(true)
    expect(owned.text).toContain(canary.privateText)
    expect(owned.text).toContain(canary.membersText)
    expect(owned.text).toContain(groupId)
    expect(owned.text).toContain(projectId)
    expect(owned.text).toContain(taskId)
  }, 120_000)

  test('source-owned audience: a participant and a listed viewer receive their records, and an outsider receives neither', async () => {
    const participant = await exportAs(member.principal)
    expect(validatePortableWorkspaceExport(participant.bundle).ok).toBe(true)
    expect(participant.text).toContain(canary.privateText)
    expect(participant.text).toContain(canary.membersText)

    const outsidePart = await exportAs(outsider.principal)
    expect(validatePortableWorkspaceExport(outsidePart.bundle).ok).toBe(true)
    assertAbsent(outsidePart.text, [
      canary.privateText,
      canary.membersText,
      groupId,
      projectId,
      taskId,
      groupBodyRef,
      taskObjectiveRef,
    ])
  }, 120_000)

  test('no credential, ciphertext, locator, provenance or native reference appears in any bundle', async () => {
    const forbidden = [
      canary.artifactLocator,
      canary.artifactProvenance,
      canary.executionRef,
      canary.externalHarness,
      canary.externalSession,
      canary.inviteEmail,
      canary.sessionDigest,
      inviteToken,
      digestInvitationToken(inviteToken),
      replicaCiphertext,
      replicaNonce,
    ]
    for (const principal of [owner.principal, member.principal, outsider.principal]) {
      assertAbsent((await exportAs(principal)).text, forbidden)
    }
  }, 120_000)

  test('the canaries are in the source, so their absence from the bundles is a real exclusion', async () => {
    const source = JSON.stringify({
      artifacts: await connection.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.workspaceId, workspaceId)),
      contentReplicas: await connection.db
        .select()
        .from(contentReplicas)
        .where(eq(contentReplicas.workspaceId, workspaceId)),
      invitations: await connection.db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.workspaceId, workspaceId)),
      messages: await connection.db
        .select()
        .from(messages)
        .where(eq(messages.workspaceId, workspaceId)),
      sessions: await connection.db.select().from(temporaryUserSessions),
    })
    for (const value of [
      canary.artifactLocator,
      canary.artifactProvenance,
      canary.executionRef,
      canary.externalSession,
      canary.externalHarness,
      canary.inviteEmail,
      canary.sessionDigest,
      digestInvitationToken(inviteToken),
      replicaCiphertext,
    ]) {
      expect(source).toContain(value)
    }
  }, 120_000)

  test('the import reports every withheld external domain as unavailable, and restores none of them', () => {
    expect(restoredBody.contentDigest).toBe(ownerBundle.contentDigest.value)
    const reported = restoredBody.externalDomains.map((domain) => domain.class).toSorted()
    expect(reported).toEqual([...PORTABLE_EXTERNAL_DOMAIN_CLASSES].toSorted())
    for (const domain of restoredBody.externalDomains) expect(domain.status).toBe('unavailable')
    const artifactDomain = restoredBody.externalDomains.find(
      (domain) => domain.class === 'artifact_bytes_and_locations'
    )
    expect(artifactDomain?.treatment).toBe('deferred')
    expect(artifactDomain?.authority).toBe('artifact_store (#86)')
  })

  test('the restored destination reads the audience the bundle carried, and nobody else', async () => {
    const ownerRead = await listMessagesForUser(
      destination.db,
      workspaceId,
      groupId,
      owner.principal
    )
    expect(ownerRead.messages.map((message) => message.bodyText)).toContain(canary.privateText)
    const projectRead = await listChannelsForUser(destination.db, workspaceId, owner.principal)
    expect(projectRead.length).toBeGreaterThan(0)
    // The member and the outsider hold no membership in the destination, so the restore grants them nothing.
    await expect(
      listMessagesForUser(destination.db, workspaceId, groupId, member.principal)
    ).rejects.toThrow()
    await expect(
      listChannelsForUser(destination.db, workspaceId, outsider.principal)
    ).rejects.toThrow()
  }, 120_000)

  test('no credential, ciphertext, locator or native reference reaches the destination database', async () => {
    const dump = JSON.stringify({
      artifacts: await destination.db.select().from(artifacts),
      contentReplicas: await destination.db.select().from(contentReplicas),
      contentRefs: await destination.db.select().from(contentRefs),
      invitations: await destination.db.select().from(workspaceInvitations),
      messages: await destination.db.select().from(messages),
      sessions: await destination.db.select().from(temporaryUserSessions),
    })
    assertAbsent(dump, [
      canary.artifactLocator,
      canary.artifactProvenance,
      canary.executionRef,
      canary.externalHarness,
      canary.externalSession,
      canary.inviteEmail,
      canary.sessionDigest,
      inviteToken,
      digestInvitationToken(inviteToken),
      replicaCiphertext,
      replicaNonce,
    ])
    expect(await destination.db.select().from(artifacts)).toEqual([])
    expect(await destination.db.select().from(contentReplicas)).toEqual([])
    expect(await destination.db.select().from(workspaceInvitations)).toEqual([])
    expect(await destination.db.select().from(temporaryUserSessions)).toEqual([])
  }, 120_000)

  test('refusals write nothing: an existing workspace, an importer without permission, an unknown ledger class, and a digest mismatch', async () => {
    const before = (
      await destination.db.execute(sql`select count(*)::int as n from app.messages`)
    )[0]!.n as number
    expect(before).toBe(destinationMessages)

    const existing = await portableImportResponse(
      importRequest(ownerBundle),
      destination.db,
      resolutionFor(owner.principal),
      async () => true
    )
    expect(existing.status).toBe(409)

    const unpermitted = await portableImportResponse(
      importRequest(ownerBundle),
      destination.db,
      resolutionFor(owner.principal),
      async () => false
    )
    // Without the creation permission the import answers the unavailable response, as elsewhere.
    expect(unpermitted.status).toBe(404)

    const unknownLedger = structuredClone(ownerBundle)
    unknownLedger.exclusions = [
      ...unknownLedger.exclusions,
      {
        authority: 'nowhere',
        class: canary.unknownClass,
        reason: 'not in version one',
        treatment: 'excluded',
      },
    ] as typeof unknownLedger.exclusions
    const unknownResponse = await portableImportResponse(
      importRequest(unknownLedger),
      destination.db,
      resolutionFor(owner.principal),
      async () => true
    )
    expect(unknownResponse.status).toBe(422)
    assertAbsent(await unknownResponse.text(), [canary.unknownClass])

    const tampered = structuredClone(ownerBundle)
    const textIndex = tampered.content.messages.findIndex((message) => message.body.kind === 'text')
    const target = tampered.content.messages[textIndex]!
    target.body = { kind: 'text', text: `TAMPERED-${run}` }
    const mismatch = await portableImportResponse(
      importRequest(tampered),
      destination.db,
      resolutionFor(owner.principal),
      async () => true
    )
    expect(mismatch.status).toBe(422)
    assertAbsent(await mismatch.text(), [`TAMPERED-${run}`])

    const after = (
      await destination.db.execute(sql`select count(*)::int as n from app.messages`)
    )[0]!.n as number
    expect(after).toBe(before)
  }, 120_000)
})
