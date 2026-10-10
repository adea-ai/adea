// API → clean destination database flow for the portable workspace export and import
// (M18.02.2, #1226).
//
// The export is produced by the GET handler against the lane database. The restore is
// performed by the POST handler against a brand-new database that this file creates on
// the lane's throwaway provisioning instance (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL),
// migrates from the repository's migrations, and drops again. Nothing here uses a
// production role or a new credential. The destination holds only the users the bundle
// names, provisioned here the way a destination's identity system provisions them.
//
// The file is skipped when the provisioning instance is not configured; the lane
// configures it whenever Docker is available.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  addWorkspaceMembership,
  artifacts,
  channelParticipants,
  channels,
  contentRefs,
  contentReplicas,
  createDatabase,
  createGroupChannel,
  createMessage,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  type DatabaseConnection,
  getChannelForUser,
  messages,
  readCompletePortableContent,
  setChannelParticipants,
  temporaryUserSessions,
  users,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
  portableContentDigest,
} from '@adea-ai/db'
import { type PortableWorkspaceExport, validatePortableWorkspaceExport } from '@adea-ai/types'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  portableImportResponse,
  portableWorkspaceExportResponse,
} from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

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
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url))
const allowAll = async () => true

function resolutionFor(
  principal: WorkspacePrincipalResolution['principal']
): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
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

describe.skipIf(!sourceUrl || !provisioningUrl)(
  'portable workspace API restores into a clean database',
  () => {
    let source: DatabaseConnection
    let admin: DatabaseConnection
    let destination: DatabaseConnection | undefined
    let scratch: string | undefined
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
      await db.delete(channelParticipants).where(eq(channelParticipants.workspaceId, workspaceId))
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
      admin = createDatabase(urlForDatabase('postgres'))
      owner = await createTemporaryUserSession(source.db, {
        credentialDigest: canary.sessionDigest,
        displayName: 'API Owner',
        expiresAt: future(),
      })
      const member = await createTemporaryUserSession(source.db, {
        credentialDigest: `api-member-${run}`,
        displayName: 'API Member',
        expiresAt: future(),
      })
      const { workspace } = await createWorkspaceWithOwner(source.db, {
        idempotencyKey: `api-restore-${run}`,
        name: 'API restore source',
        owner: owner.principal,
      })
      sourceWorkspaceId = workspace.id
      await addWorkspaceMembership(source.db, sourceWorkspaceId, member.principal, 'member')
      const channel = await createGroupChannel(source.db, sourceWorkspaceId, owner.principal, {
        idempotencyKey: `api-restore-channel-${run}`,
        title: 'API restore lane',
      })
      await setChannelParticipants(
        source.db,
        sourceWorkspaceId,
        channel.id,
        owner.principal,
        [
          { kind: 'user', userId: owner.principal.userId },
          { kind: 'user', userId: member.principal.userId },
        ],
        (await getChannelForUser(source.db, sourceWorkspaceId, channel.id, owner.principal)).version
      )
      const [contentRef] = await source.db
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
        bodyContentRefId: contentRef!.id,
        idempotencyKey: `api-body-${run}`,
        sender: owner.principal,
      })
      await createMessage(source.db, sourceWorkspaceId, channel.id, owner.principal, {
        bodyText: `Restored through the API ${run}`,
        idempotencyKey: `api-text-${run}`,
        sender: owner.principal,
      })
      await createMessage(source.db, sourceWorkspaceId, channel.id, owner.principal, {
        bodyText: canary.deletedText,
        idempotencyKey: `api-deleted-${run}`,
        sender: owner.principal,
      })
      await source.db
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(eq(messages.idempotencyKey, `api-deleted-${run}`))
      await source.db.insert(contentReplicas).values({
        availability: 'available',
        ciphertext: `${canary.ciphertext}AA`,
        contentRefId: contentRef!.id,
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
        sourceArtifactRef: `api-source-${run}`,
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

      // The export is the GET handler's response, exactly as a client receives it.
      const exported = await portableWorkspaceExportResponse(
        new Request(`http://localhost/api/v1/workspaces/${sourceWorkspaceId}/portable-export`),
        source.db,
        resolutionFor(owner.principal),
        sourceWorkspaceId
      )
      expect(exported.status).toBe(200)
      bundle = (await exported.json()) as PortableWorkspaceExport
      expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)

      // The destination is a new database on the provisioning instance, migrated from the
      // repository's migrations, the same path a fresh environment takes.
      scratch = scratchNameFor()
      assertDisposableScratch(scratch)
      await admin.client.unsafe(`create database "${scratch}"`)
      destination = createDatabase(urlForDatabase(scratch))
      await migrate(destination.db, { migrationsFolder })
      await destination.db
        .insert(users)
        .values(
          bundle.content.users.map((user) => ({ displayName: user.displayName, id: user.userId }))
        )
    }, 300_000)

    afterAll(async () => {
      try {
        await destination?.close()
      } finally {
        if (scratch) {
          assertDisposableScratch(scratch)
          await admin.client.unsafe(`drop database if exists "${scratch}" with (force)`)
        }
        await admin?.close()
        if (sourceWorkspaceId && source) await removeSource(sourceWorkspaceId)
        await source?.close()
      }
    }, 300_000)

    test('the POST handler restores the exported bundle into the clean database and reproduces its digest', async () => {
      const restored = await portableImportResponse(
        new Request('http://localhost/api/v1/portable-imports', {
          body: JSON.stringify(bundle),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        destination!.db,
        resolutionFor(owner.principal),
        allowAll
      )
      expect(restored.status).toBe(201)
      const body = (await restored.json()) as { contentDigest: string; workspaceId: string }
      expect(body.workspaceId).toBe(sourceWorkspaceId)
      expect(body.contentDigest).toBe(bundle.contentDigest.value)

      const reproduced = await destination!.db.transaction((transaction) =>
        readCompletePortableContent(transaction, sourceWorkspaceId)
      )
      expect(portableContentDigest(reproduced!)).toBe(bundle.contentDigest.value)
    }, 120_000)

    test('the clean destination gains no credential, replica, artifact or invitation, and keeps residency', async () => {
      const db = destination!.db
      const memberships = await db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, sourceWorkspaceId))
      expect(memberships.map((row) => [row.userId, row.role])).toEqual([
        [owner.principal.userId, 'owner'],
      ])

      const refs = await db
        .select()
        .from(contentRefs)
        .where(eq(contentRefs.workspaceId, sourceWorkspaceId))
      expect(refs.map((ref) => ref.synchronizationPolicy)).toEqual(['local_only'])
      expect(refs.map((ref) => ref.availability)).toEqual(['missing'])

      expect(
        await db
          .select()
          .from(contentReplicas)
          .where(eq(contentReplicas.workspaceId, sourceWorkspaceId))
      ).toEqual([])
      expect(
        await db.select().from(artifacts).where(eq(artifacts.workspaceId, sourceWorkspaceId))
      ).toEqual([])
      expect(
        await db
          .select()
          .from(workspaceInvitations)
          .where(eq(workspaceInvitations.workspaceId, sourceWorkspaceId))
      ).toEqual([])
      expect(await db.select().from(temporaryUserSessions)).toEqual([])

      const stored = await db
        .select()
        .from(messages)
        .where(eq(messages.workspaceId, sourceWorkspaceId))
      expect(JSON.stringify(stored)).not.toContain(canary.deletedText)
      expect(stored.map((row) => row.bodyText).filter(Boolean)).toContain(
        `Restored through the API ${run}`
      )

      const serializedBundle = JSON.stringify(bundle)
      for (const secret of [
        canary.ciphertext,
        canary.locator,
        canary.sessionDigest,
        canary.tokenDigest,
        canary.inviteEmail,
      ]) {
        expect(serializedBundle).not.toContain(secret)
      }
    }, 120_000)

    test('a second POST of the same bundle into the destination is refused as an existing workspace', async () => {
      const again = await portableImportResponse(
        new Request('http://localhost/api/v1/portable-imports', {
          body: JSON.stringify(bundle),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        destination!.db,
        resolutionFor(owner.principal),
        allowAll
      )
      expect(again.status).toBe(409)
    }, 120_000)
  }
)
