// Clean-destination restore of a portable workspace export (M18.02.2, #1226).
//
// The source workspace lives in the lane database. The destination is a brand new
// database that this test creates on the lane's throwaway provisioning instance
// (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, the same disposable superuser instance the
// capture proofs use), migrates from the repository's migrations, and drops again
// afterwards. Nothing here touches a production role or credential.
//
// The destination is clean: no workspace, no membership, no session, no invitation,
// no replica and no artifact. Its only identities are the users the bundle names,
// provisioned here the way a destination's identity system would provision them,
// since a bundle never creates identities.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import { validatePortableWorkspaceExport, type PortableWorkspaceExport } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  exportPortableWorkspace,
  portableContentDigest,
  readCompletePortableContent,
} from '../../src/portable-export'
import { importPortableWorkspace, PortableImportError } from '../../src/portable-import'
import {
  artifacts,
  channels,
  contentRefs,
  contentReplicas,
  messages,
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

const sourceUrl = process.env.DATABASE_URL
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)
const canary = {
  ciphertext: `CIPHERTEXT-CANARY-${run}`,
  deletedText: `DELETED-CANARY-${run}`,
  inviteEmail: `invitee-${run}@example.test`,
  locator: `ARTIFACT-LOCATOR-${run}`,
  sessionDigest: `SESSION-CANARY-${run}`,
  tokenDigest: randomBytes(32).toString('hex'),
}

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function scratchNameFor() {
  return `portable_restore_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_restore_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

describe.skipIf(!sourceUrl || !provisioningUrl)('clean destination restore', () => {
  let source: DatabaseConnection
  let admin: DatabaseConnection
  let destination: DatabaseConnection
  let scratch: string
  let sourceWorkspaceId: string
  let owner: Awaited<ReturnType<typeof createTemporaryUserSession>>
  let bundle: PortableWorkspaceExport

  async function removeSource(workspaceId: string) {
    const db = source.db
    await db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, workspaceId))
    await db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await db.delete(contentReplicas).where(eq(contentReplicas.workspaceId, workspaceId))
    await db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
    await db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspaceId))
    await db.delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId))
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, workspaceId))
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  }

  beforeAll(async () => {
    source = createDatabase(sourceUrl!)
    owner = await createTemporaryUserSession(source.db, {
      credentialDigest: canary.sessionDigest,
      displayName: 'Restore Owner',
      expiresAt: future(),
    })
    const member = await createTemporaryUserSession(source.db, {
      credentialDigest: `restore-member-${run}`,
      displayName: 'Restore Member',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(source.db, {
      idempotencyKey: `restore-${run}`,
      name: 'Restore source',
      owner: owner.principal,
    })
    sourceWorkspaceId = workspace.id
    await addWorkspaceMembership(source.db, sourceWorkspaceId, member.principal, 'member')
    const channel = await createGroupChannel(source.db, sourceWorkspaceId, owner.principal, {
      idempotencyKey: `restore-channel-${run}`,
      title: 'Restore lane',
    })
    const [crMessage] = await source.db
      .insert(contentRefs)
      .values({
        availability: 'offline',
        contentType: 'message_body',
        digestSha256: 'a'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        workspaceId: sourceWorkspaceId,
      })
      .returning()
    await createMessage(source.db, sourceWorkspaceId, channel.id, owner.principal, {
      bodyContentRefId: crMessage!.id,
      idempotencyKey: `restore-body-${run}`,
      sender: owner.principal,
    })
    await createMessage(source.db, sourceWorkspaceId, channel.id, owner.principal, {
      bodyText: 'Restored plaintext',
      idempotencyKey: `restore-text-${run}`,
      sender: owner.principal,
    })
    await source.db.insert(contentReplicas).values({
      availability: 'available',
      ciphertext: `${canary.ciphertext}AA`,
      contentRefId: crMessage!.id,
      digestSha256: 'b'.repeat(64),
      nonce: 'NONCECANARY000AA',
      replicaKind: 'self_hosted_authority',
      revision: 1,
      schemaVersion: 1,
      workspaceId: sourceWorkspaceId,
    })
    await source.db.insert(artifacts).values({
      checksumSha256: 'c'.repeat(64),
      createPayloadHash: '0'.repeat(64),
      filename: 'plan.pdf',
      locationRef: canary.locator,
      locationType: 'object_store',
      mediaType: 'application/pdf',
      ownerPrincipalId: owner.principal.userId,
      ownerPrincipalKind: 'user',
      provenance: { origin: canary.locator },
      sizeBytes: 10,
      sourceArtifactRef: `source-${run}`,
      sourcePrincipalId: owner.principal.userId,
      sourcePrincipalKind: 'user',
      workspaceId: sourceWorkspaceId,
    })
    await source.db.insert(workspaceInvitations).values({
      email: canary.inviteEmail,
      expiresAt: future(),
      invitedByUserId: owner.principal.userId,
      role: 'member',
      tokenDigest: canary.tokenDigest,
      workspaceId: sourceWorkspaceId,
    })
    await removeWorkspaceMembership(source.db, sourceWorkspaceId, member.principal)

    bundle = await exportPortableWorkspace(source.db, {
      principal: owner.principal,
      workspaceId: sourceWorkspaceId,
    })
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)

    // The throwaway instance creates the scratch database; the repository's migrations
    // build it, which is the same path a fresh environment takes.
    scratch = scratchNameFor()
    assertDisposableScratch(scratch)
    admin = createDatabase(urlForDatabase('postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    destination = createDatabase(urlForDatabase(scratch))
    await migrate(destination.db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })

    // Identities are provisioned the way a destination's identity system would: the
    // bundle names them, and a restore never creates them.
    await destination.db.insert(users).values(
      bundle.content.users.map((user) => ({
        displayName: user.displayName,
        id: user.userId,
      }))
    )
  }, 300_000)

  afterAll(async () => {
    try {
      await destination?.close()
    } finally {
      if (admin) {
        assertDisposableScratch(scratch)
        await admin.client.unsafe(`drop database if exists "${scratch}" with (force)`)
        await admin.close()
      }
      if (sourceWorkspaceId && source) await removeSource(sourceWorkspaceId)
      await source?.close()
    }
  }, 300_000)

  test('a bundle restores into an empty database and reproduces its digest exactly', async () => {
    const restored = await importPortableWorkspace(destination.db, {
      bundle,
      importer: owner.principal,
    })
    expect(restored.workspaceId).toBe(sourceWorkspaceId)
    expect(restored.counts.messages).toBe(bundle.content.messages.length)
    expect(restored.contentDigest).toBe(bundle.contentDigest.value)

    const reproduced = await destination.db.transaction((transaction) =>
      readCompletePortableContent(transaction, sourceWorkspaceId)
    )
    expect(portableContentDigest(reproduced!)).toBe(bundle.contentDigest.value)
  }, 120_000)

  test('the clean destination gains no credential, replica, artifact or invitation, and keeps residency', async () => {
    const memberships = await destination.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, sourceWorkspaceId))
    expect(memberships.map((row) => [row.userId, row.role])).toEqual([
      [owner.principal.userId, 'owner'],
    ])

    const refs = await destination.db
      .select()
      .from(contentRefs)
      .where(eq(contentRefs.workspaceId, sourceWorkspaceId))
    expect(refs.map((ref) => ref.synchronizationPolicy)).toEqual(['local_only'])
    expect(refs.map((ref) => ref.availability)).toEqual(['missing'])

    expect(
      await destination.db
        .select()
        .from(contentReplicas)
        .where(eq(contentReplicas.workspaceId, sourceWorkspaceId))
    ).toEqual([])
    expect(
      await destination.db
        .select()
        .from(artifacts)
        .where(eq(artifacts.workspaceId, sourceWorkspaceId))
    ).toEqual([])
    expect(
      await destination.db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.workspaceId, sourceWorkspaceId))
    ).toEqual([])
    expect(await destination.db.select().from(temporaryUserSessions)).toEqual([])

    const stored = await destination.db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(and(eq(messages.workspaceId, sourceWorkspaceId)))
    expect(stored.map((row) => row.bodyText).filter(Boolean)).toEqual(['Restored plaintext'])
    expect(JSON.stringify(stored)).not.toContain(canary.deletedText)
    expect(JSON.stringify(bundle)).not.toContain(canary.ciphertext)
    expect(JSON.stringify(bundle)).not.toContain(canary.locator)
    expect(JSON.stringify(bundle)).not.toContain(canary.sessionDigest)
    expect(JSON.stringify(bundle)).not.toContain(canary.tokenDigest)
    expect(JSON.stringify(bundle)).not.toContain(canary.inviteEmail)
  }, 120_000)

  test('a second restore of the same bundle into the destination is refused', async () => {
    const error = await importPortableWorkspace(destination.db, {
      bundle,
      importer: owner.principal,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PortableImportError)
    expect((error as PortableImportError).code).toBe('target_exists')
  }, 120_000)
})
