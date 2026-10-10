// The portable export excludes job publications the requester cannot read (#1226, stacked on the
// #1217 reader gate).
//
// The fixture is a disposable database created on the package runner's capture instance
// (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL), migrated from the repository's migrations and dropped
// afterwards. This file never writes the shared lane database named by DATABASE_URL.
//
// One channel holds ordinary messages, a visible job publication and a withheld job publication. The
// visible publication carries an artifact under a live grant. The withheld publication carries an
// artifact whose grant the owner revokes after the publication and after the owner replies in its
// thread, so the canonical reader's artifact gate hides it and its thread. Every statement about what
// the requester sees is checked against `listMessagesForUser`, the reader the export pages through.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import { type PortableWorkspaceExport, validatePortableWorkspaceExport } from '@adea-ai/types'
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
import { workspaceMemberships } from '../../src/schema'
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

// Canary texts are unique per run. The withheld texts must never appear in the document.
const texts = {
  ordinaryAfter: `ORDINARY-AFTER-${run}`,
  ordinaryBefore: `ORDINARY-BEFORE-${run}`,
  ordinaryMiddle: `ORDINARY-MIDDLE-${run}`,
  replyToVisible: `REPLY-TO-VISIBLE-${run}`,
  replyToWithheld: `REPLY-TO-WITHHELD-CANARY-${run}`,
  visible: `VISIBLE-PUBLICATION-${run}`,
  withheld: `WITHHELD-PUBLICATION-CANARY-${run}`,
}

type MessageName =
  | 'ordinaryAfter'
  | 'ordinaryBefore'
  | 'ordinaryMiddle'
  | 'replyToVisible'
  | 'replyToWithheld'
  | 'visible'
  | 'withheld'

function urlForDatabase(url: string, database: string): string {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function assertDisposableScratch(name: string) {
  if (!/^withheld_export_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

describe('portable export withholds job publications the requester cannot read', () => {
  let admin: DatabaseConnection | undefined
  let connection: DatabaseConnection
  let scratch: string
  let workspaceId: string
  let channelId: string
  let reader: Awaited<ReturnType<typeof createTemporaryUserSession>>
  let bundle: PortableWorkspaceExport
  const messageIds = {} as Record<MessageName, string>
  let readerBeforeRevocation: string[] = []

  /** Every message id the canonical reader returns for the requester in one channel, page by page. */
  async function readerMessageIds(channel: string): Promise<string[]> {
    const found: string[] = []
    let afterSequence: number | undefined
    for (;;) {
      const page = await listMessagesForUser(
        connection.db,
        workspaceId,
        channel,
        reader.principal,
        {
          afterSequence,
          limit: 100,
        }
      )
      found.push(...page.messages.map((message) => message.id))
      if (page.nextAfterSequence === undefined) return found
      afterSequence = page.nextAfterSequence
    }
  }

  function exportedIn(channel: string) {
    return bundle.content.messages.filter((message) => message.channelId === channel)
  }

  beforeAll(async () => {
    scratch = `withheld_export_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    assertDisposableScratch(scratch)
    admin = createDatabase(urlForDatabase(provisioningUrl!, 'postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    connection = createDatabase(urlForDatabase(provisioningUrl!, scratch))
    const db = connection.db
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })

    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `withheld-owner-${run}`,
      displayName: 'Withheld Owner',
      expiresAt: future(),
    })
    reader = await createTemporaryUserSession(db, {
      credentialDigest: `withheld-reader-${run}`,
      displayName: 'Withheld Reader',
      expiresAt: future(),
    })
    const { workspace: source } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `withheld-source-${run}`,
      name: 'Withheld source',
      owner: owner.principal,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `withheld-destination-${run}`,
      name: 'Withheld destination',
      owner: owner.principal,
    })
    workspaceId = destination.id
    await db.insert(workspaceMemberships).values({
      role: 'member',
      userId: reader.principal.userId,
      workspaceId: destination.id,
    })
    const channel = await createGroupChannel(db, destination.id, owner.principal, {
      idempotencyKey: `withheld-channel-${run}`,
      title: 'Withheld lane',
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

    const project = await createProject(db, source.id, owner.principal, {
      name: 'Withheld project',
      iconKey: 'planning',
    })
    const agent = await createAgent(db, source.id, owner.principal, {
      name: 'Withheld agent',
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
      workspaceId: source.id,
    })
    const node = await registerRuntimeNode(db, {
      challengeId: challenge.challengeId,
      displayName: 'Withheld host',
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
      workspaceId: source.id,
    })
    const commandKeyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId

    /** A submitted, not yet completed job in the source workspace. Its title names no canary text. */
    async function submittedJob(label: string) {
      const task = await createTask(
        db,
        source.id,
        owner.principal,
        {
          agentId: agent.id,
          projectId: project.id,
          title: `Withheld job ${label}`,
          objective: 'PROMPT',
        },
        { idempotencyKey: randomUUID(), requestId: randomUUID() }
      )
      const requestId = randomUUID()
      const envelope = await sealRemoteContent({
        keyId: commandKeyId,
        recipientPublicKey: encryption.publicKey,
        aad: {
          workspaceId: source.id,
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
        source.id,
        task.id,
        owner.principal,
        { runtimeNodeId: node.id, queueWhenOffline: false, profile, envelope },
        { idempotencyKey: randomUUID(), requestId, expectedVersion: task.version }
      )
      return task
    }

    /** A real artifact in the source workspace, registered to the destination by a real grant. */
    async function grantedArtifact(label: string) {
      const artifact = await createArtifact(db, source.id, owner.principal, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: `${label}.txt`,
        location: { reference: `outputs/${randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      const grantId = `grant-${label}-${run}-${randomUUID()}`
      await registerArtifactReferenceGrant(db, source.id, owner.principal, {
        artifactId: artifact.id,
        audienceWorkspaceId: destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId,
        version: artifact.version,
      })
      return { artifactId: artifact.id, grantId }
    }

    /** Completes a job through the production path and publishes its result into the channel. */
    async function publish(
      label: string,
      summary: string,
      artifact: { artifactId: string; grantId: string } | null
    ) {
      const task = await submittedJob(label)
      const outcome = await completeTaskAndPublishOutboundResult(
        db,
        source.id,
        task.id,
        owner.principal,
        { expectedVersion: task.version, idempotencyKey: randomUUID(), requestId: randomUUID() },
        { artifact, artifactPolicy: 'require', channelId: channel.id, summary }
      )
      if (outcome.publication.decision.action !== 'publish' || !outcome.publication.messageId)
        throw new Error(`publication held: ${JSON.stringify(outcome.publication.decision)}`)
      return outcome.publication.messageId
    }

    const say = async (name: MessageName) =>
      (
        await createMessage(db, destination.id, channel.id, owner.principal, {
          bodyText: texts[name],
          idempotencyKey: `withheld-${name}-${run}`,
          sender: { kind: 'user', userId: owner.principal.userId },
        })
      ).id
    const reply = async (name: MessageName, root: string) =>
      (
        await createMessage(db, destination.id, channel.id, owner.principal, {
          bodyText: texts[name],
          idempotencyKey: `withheld-${name}-${run}`,
          replyToMessageId: root,
          sender: { kind: 'user', userId: owner.principal.userId },
          threadRootMessageId: root,
        })
      ).id

    messageIds.ordinaryBefore = await say('ordinaryBefore')
    messageIds.visible = await publish('visible', texts.visible, await grantedArtifact('visible'))
    messageIds.ordinaryMiddle = await say('ordinaryMiddle')
    const withheldGrant = await grantedArtifact('withheld')
    messageIds.withheld = await publish('withheld', texts.withheld, withheldGrant)
    messageIds.replyToWithheld = await reply('replyToWithheld', messageIds.withheld)
    readerBeforeRevocation = await readerMessageIds(channel.id)
    await revokeArtifactReferenceGrant(db, source.id, owner.principal, withheldGrant.grantId)
    messageIds.replyToVisible = await reply('replyToVisible', messageIds.visible)
    messageIds.ordinaryAfter = await say('ordinaryAfter')

    bundle = await exportPortableWorkspace(db, {
      principal: reader.principal,
      workspaceId: destination.id,
    })
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

  test('before the grant is revoked the reader sees the visible and withheld publications and the reply', () => {
    expect(readerBeforeRevocation).toEqual([
      messageIds.ordinaryBefore,
      messageIds.visible,
      messageIds.ordinaryMiddle,
      messageIds.withheld,
      messageIds.replyToWithheld,
    ])
  })

  test('the export keeps the visible publication and the ordinary messages and drops the withheld publication', async () => {
    const exported = exportedIn(channelId)
    expect(exported.map((message) => message.messageId)).toEqual([
      messageIds.ordinaryBefore,
      messageIds.visible,
      messageIds.ordinaryMiddle,
      messageIds.replyToVisible,
      messageIds.ordinaryAfter,
    ])
    const visibleMessage = exported.find((message) => message.messageId === messageIds.visible)
    expect(visibleMessage?.body).toEqual({ kind: 'text', text: texts.visible })
    expect(exported.map((message) => message.messageId)).not.toContain(messageIds.withheld)
    const document = JSON.stringify(bundle)
    expect(document).not.toContain(texts.withheld)
    expect(document).not.toContain(texts.replyToWithheld)
  })

  test('a human reply in the withheld thread is hidden from the reader and from the export', async () => {
    const read = await readerMessageIds(channelId)
    expect(read).not.toContain(messageIds.replyToWithheld)
    expect(read).not.toContain(messageIds.withheld)
    expect(exportedIn(channelId).map((message) => message.messageId)).not.toContain(
      messageIds.replyToWithheld
    )
  })

  test('the exported message ids equal the canonical reader ids for the same requester, in every channel', async () => {
    let exportedTotal = 0
    for (const channel of bundle.content.channels) {
      const read = await readerMessageIds(channel.channelId)
      const exported = exportedIn(channel.channelId).map((message) => message.messageId)
      expect(exported).toEqual(read)
      exportedTotal += exported.length
    }
    expect(exportedTotal).toBe(bundle.content.messages.length)
    expect(bundle.content.channels.map((channel) => channel.channelId)).toContain(channelId)
  })

  test('job publications export under the system sender label, and the binding never appears', () => {
    const systemMessages = bundle.content.messages.filter(
      (message) => message.sender.kind === 'system'
    )
    expect(systemMessages.map((message) => message.messageId)).toEqual([messageIds.visible])
    for (const message of systemMessages)
      expect(message.sender).toEqual({ kind: 'system', systemId: 'system' })
    const document = JSON.stringify(bundle)
    expect(document).not.toContain('job-outbound:v1:')
    expect(document).not.toContain('job-outbound')
  })

  test('channelOrder runs from 1 without gaps in each channel, and the document validates', () => {
    for (const channel of bundle.content.channels) {
      const orders = exportedIn(channel.channelId).map((message) => message.channelOrder)
      expect(orders).toEqual(orders.map((_, index) => index + 1))
    }
    expect(exportedIn(channelId).map((message) => message.channelOrder)).toEqual([1, 2, 3, 4, 5])
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)
  })
})
