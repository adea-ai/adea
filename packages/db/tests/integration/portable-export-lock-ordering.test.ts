// Ordering between a portable export and a revocation of the grant behind a job publication (#1226,
// stacked on the #1237 reader gate at bbd97a028).
//
// The export transaction is READ WRITE and writes nothing. The authority readers take FOR SHARE on the
// artifact and grant rows a publication depends on, and keep those locks until the export commits. A
// revocation takes its grant row FOR UPDATE, so it waits for an export that holds the share lock. This
// file proves that on a disposable database: a revocation queued behind a held export lock waits for
// the export, the export keeps the record it read, a later export withholds it, and no export writes a
// row or an event.
//
// The export is held open at its final step by a seam that waits for this file to release it. The seam
// never awaits the revocation, so the test cannot deadlock. A held seam is released in `finally`, so a
// failing assertion cannot leave the export open.
//
// The fixture is a disposable database on the package runner's capture instance
// (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL). It never writes the shared database named by DATABASE_URL.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import { validatePortableWorkspaceExport } from '@adea-ai/types'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannel,
  createMessage,
  listMessagesForUser,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { completeTaskAndPublishOutboundResult } from '../../src/job-outbound-result-store'
import { exportPortableWorkspace } from '../../src/portable-export'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { artifactReferenceGrants, workspaceMemberships } from '../../src/schema'
import { enqueueTaskSubmission } from '../../src/task-submissions'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!provisioningUrl)
  throw new Error(
    'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is required: this regression exports from a disposable database and must not skip'
  )

const run = randomBytes(6).toString('hex')
const CHECKSUM = 'c'.repeat(64)
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const future = () => new Date(Date.now() + 60 * 60 * 1000)

const texts = {
  before: `LOCK-BEFORE-${run}`,
  publication: `LOCK-PUBLICATION-CANARY-${run}`,
  reply: `LOCK-REPLY-CANARY-${run}`,
}

// Every table in the scratch database. The database holds only this fixture, so a whole-table digest is
// exact: any row an export inserted, updated or deleted, and any event it appended, changes it.
const fingerprintedTables = [
  'agents',
  'artifact_reference_grants',
  'artifacts',
  'channel_participants',
  'channels',
  'content_refs',
  'message_artifact_references',
  'messages',
  'projects',
  'task_execution_attempts',
  'task_submissions',
  'tasks',
  'workspace_event_sequences',
  'workspace_events',
  'workspace_memberships',
  'workspaces',
]

function urlForDatabase(url: string, database: string): string {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function assertDisposableScratch(name: string) {
  if (!/^lock_export_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

/** A deferred value, resolved by the test and awaited by the seam or the test. */
async function waitUntil(condition: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('portable export and a revocation of a publication grant order on the share lock', () => {
  let admin: DatabaseConnection | undefined
  let connection: DatabaseConnection
  let scratch: string
  let workspaceId: string
  let channelId: string
  let grantId: string
  let owner: Awaited<ReturnType<typeof createTemporaryUserSession>>
  let reader: Awaited<ReturnType<typeof createTemporaryUserSession>>
  let publicationId: string
  let replyId: string
  let beforeId: string
  let revoke: (grant: string) => ReturnType<typeof revokeArtifactReferenceGrant>

  /** A digest of every fingerprinted table, read with plain statements that take no row locks. */
  async function fingerprint(): Promise<string> {
    const digests: string[] = []
    for (const table of fingerprintedTables) {
      const [row] = await connection.client.unsafe(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from app.${table} t`
      )
      digests.push(`${table}:${row!.digest}`)
    }
    return digests.join(',')
  }

  /** Every message id the canonical reader returns for the requester in the channel, page by page. */
  async function readerMessageIds(): Promise<string[]> {
    const found: string[] = []
    let afterSequence: number | undefined
    for (;;) {
      const page = await listMessagesForUser(
        connection.db,
        workspaceId,
        channelId,
        reader.principal,
        { afterSequence, limit: 100 }
      )
      found.push(...page.messages.map((message) => message.id))
      if (page.nextAfterSequence === undefined) return found
      afterSequence = page.nextAfterSequence
    }
  }

  /** The grant's committed revocation time, read without a row lock. */
  async function revokedAt(): Promise<Date | null> {
    const [row] = await connection.db
      .select({ revokedAt: artifactReferenceGrants.revokedAt })
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.grantId, grantId))
      .limit(1)
    return row?.revokedAt ?? null
  }

  /** Lock waits in the scratch database, excluding this connection. */
  async function lockWaiters(): Promise<number> {
    const [row] = await connection.client.unsafe(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
    )
    return row!.waiting as number
  }

  beforeAll(async () => {
    scratch = `lock_export_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    assertDisposableScratch(scratch)
    admin = createDatabase(urlForDatabase(provisioningUrl!, 'postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    connection = createDatabase(urlForDatabase(provisioningUrl!, scratch))
    const db = connection.db
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })

    owner = await createTemporaryUserSession(db, {
      credentialDigest: `lock-owner-${run}`,
      displayName: 'Lock Owner',
      expiresAt: future(),
    })
    reader = await createTemporaryUserSession(db, {
      credentialDigest: `lock-reader-${run}`,
      displayName: 'Lock Reader',
      expiresAt: future(),
    })
    const { workspace: sourceWorkspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `lock-source-${run}`,
      name: 'Lock source',
      owner: owner.principal,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `lock-destination-${run}`,
      name: 'Lock destination',
      owner: owner.principal,
    })
    workspaceId = destination.id
    await db.insert(workspaceMemberships).values({
      role: 'member',
      userId: reader.principal.userId,
      workspaceId: destination.id,
    })
    const channel = await createGroupChannel(db, destination.id, owner.principal, {
      idempotencyKey: `lock-channel-${run}`,
      title: 'Lock lane',
    })
    channelId = channel.id
    await setChannelParticipants(
      db,
      destination.id,
      channel.id,
      owner.principal,
      [owner.principal, { kind: 'user', userId: reader.principal.userId }],
      channel.version
    )

    const project = await createProject(db, sourceWorkspace.id, owner.principal, {
      name: 'Lock project',
      iconKey: 'planning',
    })
    const agent = await createAgent(db, sourceWorkspace.id, owner.principal, {
      name: 'Lock agent',
      profileId: profile.id,
      profileVersion: profile.version,
    })
    const encryption = await generateRemoteCommandKeyPair()
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey('raw', encryption.publicKey)
    ).toString('base64url')
    const challenge = await createRuntimeNodeChallenge(db, {
      createdByUserId: owner.principal.userId,
      kind: 'remote_host',
      nonce: randomUUID(),
      purpose: 'pair',
      workspaceId: sourceWorkspace.id,
    })
    const node = await registerRuntimeNode(db, {
      challengeId: challenge.challengeId,
      displayName: 'Lock host',
      keys: [
        {
          algorithm: 'ed25519' as const,
          publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
          role: 'signing' as const,
        },
        { algorithm: 'x25519' as const, publicKey, role: 'command_encryption' as const },
      ],
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: sourceWorkspace.id,
    })
    const commandKeyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId

    /** A submitted, not yet completed job in the source workspace. */
    async function submittedJob() {
      const task = await createTask(
        db,
        sourceWorkspace.id,
        owner.principal,
        {
          agentId: agent.id,
          projectId: project.id,
          title: 'Lock job',
          objective: 'PROMPT',
        },
        { idempotencyKey: randomUUID(), requestId: randomUUID() }
      )
      const requestId = randomUUID()
      const envelope = await sealRemoteContent({
        keyId: commandKeyId,
        recipientPublicKey: encryption.publicKey,
        aad: {
          workspaceId: sourceWorkspace.id,
          runtimeNodeId: node.id,
          requestId,
          payloadType: 'command.input',
          schemaVersion: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        plaintext: new TextEncoder().encode('CONTEXT'),
      })
      await enqueueTaskSubmission(
        db,
        sourceWorkspace.id,
        task.id,
        owner.principal,
        { runtimeNodeId: node.id, queueWhenOffline: false, profile, envelope },
        { idempotencyKey: randomUUID(), requestId, expectedVersion: task.version }
      )
      return task
    }

    const artifact = await createArtifact(db, sourceWorkspace.id, owner.principal, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'lock.txt',
      location: { reference: `outputs/${randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    grantId = `grant-lock-${run}-${randomUUID()}`
    await registerArtifactReferenceGrant(db, sourceWorkspace.id, owner.principal, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: artifact.version,
    })

    beforeId = await createMessage(db, destination.id, channel.id, owner.principal, {
      bodyText: texts.before,
      idempotencyKey: `lock-before-${run}`,
      sender: { kind: 'user', userId: owner.principal.userId },
    }).then((message) => message.id)
    const task = await submittedJob()
    const outcome = await completeTaskAndPublishOutboundResult(
      db,
      sourceWorkspace.id,
      task.id,
      owner.principal,
      { expectedVersion: task.version, idempotencyKey: randomUUID(), requestId: randomUUID() },
      {
        artifact: { artifactId: artifact.id, grantId },
        artifactPolicy: 'require',
        channelId: channel.id,
        summary: texts.publication,
      }
    )
    if (outcome.publication.decision.action !== 'publish' || !outcome.publication.messageId)
      throw new Error(`publication held: ${JSON.stringify(outcome.publication.decision)}`)
    publicationId = outcome.publication.messageId
    replyId = await createMessage(db, destination.id, channel.id, owner.principal, {
      bodyText: texts.reply,
      idempotencyKey: `lock-reply-${run}`,
      replyToMessageId: publicationId,
      sender: { kind: 'user', userId: owner.principal.userId },
      threadRootMessageId: publicationId,
    }).then((message) => message.id)

    revoke = (grant) => revokeArtifactReferenceGrant(db, sourceWorkspace.id, owner.principal, grant)
  }, 300_000)

  afterAll(async () => {
    try {
      await connection?.close()
    } finally {
      if (admin) {
        assertDisposableScratch(scratch)
        await admin.client.unsafe(`drop database if exists "${scratch}" with (force)`)
        await admin.close()
      }
    }
  }, 300_000)

  test('before any revocation the reader and a plain export both carry the publication and its reply', async () => {
    expect(await readerMessageIds()).toEqual([beforeId, publicationId, replyId])
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: reader.principal,
      workspaceId,
    })
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)
    const exported = bundle.content.messages.map((message) => message.messageId)
    expect(exported).toEqual([beforeId, publicationId, replyId])
  })

  test('an export issues no writes: the digest of every table is unchanged across it', async () => {
    const before = await fingerprint()
    await exportPortableWorkspace(connection.db, { principal: reader.principal, workspaceId })
    expect(await fingerprint()).toBe(before)
  })

  test('a revocation queued behind an export holding its share lock waits for the export, which keeps the record it read', async () => {
    const db = connection.db
    const held = deferred()
    const release = deferred()
    const baseline = await fingerprint()
    let revocationFinished = false
    let revocation: Promise<unknown> | undefined

    const exporting = exportPortableWorkspace(db, {
      principal: reader.principal,
      workspaceId,
      hooks: {
        beforeStep: async ({ name }) => {
          if (name !== 'final') return
          // The reads are done and the share locks on the publication's artifact and grant are held.
          // The seam waits only for this test's release; it never waits for the revocation.
          held.resolve()
          await release.promise
        },
      },
    })

    try {
      await held.promise
      // Read through a fresh connection: MVCC reads take no row lock, so the grant still shows as live.
      expect(await revokedAt()).toBeNull()
      expect(await fingerprint()).toBe(baseline)

      revocation = revoke(grantId).then((state) => {
        revocationFinished = true
        return state
      })
      await waitUntil(
        async () => (await lockWaiters()) >= 1,
        'the revocation to queue on the grant'
      )
      expect(revocationFinished).toBe(false)
      expect(await revokedAt()).toBeNull()
    } finally {
      release.resolve()
    }

    const bundle = await exporting
    // Ordered before the revocation: the export read the grant live, so it carries the record.
    expect(bundle.content.messages.map((message) => message.messageId)).toEqual([
      beforeId,
      publicationId,
      replyId,
    ])
    expect(JSON.stringify(bundle)).toContain(texts.publication)
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)

    await revocation
    expect(revocationFinished).toBe(true)
    expect(await revokedAt()).not.toBeNull()
  }, 60_000)

  test('a later export withholds the publication and its reply, and matches the canonical reader', async () => {
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: reader.principal,
      workspaceId,
    })
    const ids = bundle.content.messages.map((message) => message.messageId)
    expect(ids).toEqual([beforeId])
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(texts.publication)
    expect(serialized).not.toContain(texts.reply)
    expect(await readerMessageIds()).toEqual(ids)
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)
  })
})
