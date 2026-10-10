// Conversation order and thread links survive export and restore into a clean disposable database
// (M18.02.2, #1226). The fixture is deterministic, and its identifiers oppose its chronology. The
// root is inserted first, so it has the lower sequence, but its identifier is the greater one. The
// reply is inserted second, as a threaded reply to the root, and its identifier is the smaller one.
// Any read or restore that orders by identifier shows the reply first.
//
// Messages are inserted directly with explicit identifiers, as the export tests already do. The
// product's createMessage keeps generating its own identifiers. Sequences are assigned in insertion
// order, which is the chronology this fixture relies on.
//
// The source is the lane database. The destination is a disposable database created on the lane's
// provisioning instance (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL), migrated from the repository's
// migrations, and dropped afterwards. Both variables are required. This file fails rather than
// skipping when either is missing, so the regression cannot pass without running.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { validatePortableWorkspaceExport, type PortableWorkspaceExport } from '@adea-ai/types'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { exportPortableWorkspace, readCompletePortableContent } from '../../src/portable-export'
import { portableContentDigest } from '../../src/portable-export-content'
import { importPortableWorkspace } from '../../src/portable-import'
import {
  channelParticipants,
  channels,
  messages,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const sourceUrl = process.env.DATABASE_URL
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!sourceUrl || !provisioningUrl)
  throw new Error(
    'DATABASE_URL and MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL are required: this regression restores into a disposable database and must not skip'
  )

const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)

// The greater identifier with the earlier sequence: an order by identifier reads the reply first.
const rootId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
// The smaller identifier with the later sequence: a reply to the root.
const replyId = '00000000-0000-4000-8000-000000000001'

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function scratchNameFor() {
  return `portable_order_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_order_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(url: string, database: string): string {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

describe('restore keeps conversation order and thread links', () => {
  let source: DatabaseConnection
  let admin: DatabaseConnection
  let destination: DatabaseConnection
  let scratch: string
  let workspaceId: string
  let channelId: string
  let owner: Awaited<ReturnType<typeof createTemporaryUserSession>>
  let bundle: PortableWorkspaceExport
  let destinationMessagesBeforeImport = -1
  let destinationWorkspacesBeforeImport = -1

  async function removeSource(id: string) {
    const db = source.db
    await db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, id))
    await db.delete(messages).where(eq(messages.workspaceId, id))
    await db.delete(channelParticipants).where(eq(channelParticipants.workspaceId, id))
    await db.delete(channels).where(eq(channels.workspaceId, id))
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, id))
    await db.delete(workspaces).where(eq(workspaces.id, id))
  }

  beforeAll(async () => {
    source = createDatabase(sourceUrl!)
    owner = await createTemporaryUserSession(source.db, {
      credentialDigest: `order-owner-${run}`,
      displayName: 'Order Owner',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(source.db, {
      idempotencyKey: `order-${run}`,
      name: 'Order source',
      owner: owner.principal,
    })
    workspaceId = workspace.id
    const channel = await createGroupChannel(source.db, workspaceId, owner.principal, {
      idempotencyKey: `order-channel-${run}`,
      title: 'Order lane',
    })
    channelId = channel.id

    // Chronology: the root is inserted in its own statement, then the reply. The identity sequence
    // gives the root the lower value. The reply's foreign keys point at the root, which exists.
    const insertMessage = (
      values: Partial<typeof messages.$inferInsert> & {
        bodyText: string
        id: string
        idempotencyKey: string
      }
    ) =>
      source.db.insert(messages).values({
        channelId,
        createPayloadHash: createHash('sha256').update(String(values.bodyText)).digest('hex'),
        senderKind: 'user',
        senderUserId: owner.principal.userId,
        workspaceId,
        ...values,
      })
    await insertMessage({
      bodyText: 'Root message',
      id: rootId,
      idempotencyKey: `order-root-${run}`,
    })
    await insertMessage({
      bodyText: 'Reply message',
      id: replyId,
      idempotencyKey: `order-reply-${run}`,
      replyToMessageId: rootId,
      threadRootMessageId: rootId,
    })

    bundle = await exportPortableWorkspace(source.db, { principal: owner.principal, workspaceId })
    expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)

    scratch = scratchNameFor()
    assertDisposableScratch(scratch)
    admin = createDatabase(urlForDatabase(provisioningUrl!, 'postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    destination = createDatabase(urlForDatabase(provisioningUrl!, scratch))
    await migrate(destination.db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
    await destination.db
      .insert(users)
      .values(
        bundle.content.users.map((user) => ({ displayName: user.displayName, id: user.userId }))
      )
    // The destination must start empty, so that what it reads back was restored from the bundle.
    destinationWorkspacesBeforeImport = (
      await destination.db.execute(sql`select count(*)::int as n from app.workspaces`)
    )[0]!.n as number
    destinationMessagesBeforeImport = (
      await destination.db.execute(sql`select count(*)::int as n from app.messages`)
    )[0]!.n as number
    const restored = await importPortableWorkspace(destination.db, {
      bundle,
      importer: owner.principal,
    })
    expect(restored.workspaceId).toBe(workspaceId)
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
      if (workspaceId && source) await removeSource(workspaceId)
      await source?.close()
    }
  }, 300_000)

  test('the bundle lists the conversation in source order, with an explicit channelOrder', () => {
    const inChannel = bundle.content.messages
      .filter((message) => message.channelId === channelId)
      .map((message) => [message.messageId, message.channelOrder])
    expect(inChannel).toEqual([
      [rootId, 1],
      [replyId, 2],
    ])
  })

  test('the source and the restored destination read the conversation in source order', async () => {
    const sourceRead = await listMessagesForUser(source.db, workspaceId, channelId, owner.principal)
    const restoredRead = await listMessagesForUser(
      destination.db,
      workspaceId,
      channelId,
      owner.principal
    )
    expect(sourceRead.messages.map((message) => message.id)).toEqual([rootId, replyId])
    expect(restoredRead.messages.map((message) => message.id)).toEqual([rootId, replyId])
    expect(restoredRead.messages.map((message) => message.bodyText)).toEqual([
      'Root message',
      'Reply message',
    ])
    // The identifiers sort the other way, so an identifier order would read the reply first.
    expect(restoredRead.messages.map((message) => message.id).toSorted()).toEqual([replyId, rootId])
  }, 120_000)

  test('the restored reply keeps its reply and thread links to the root', async () => {
    const restored = await listMessagesForUser(
      destination.db,
      workspaceId,
      channelId,
      owner.principal
    )
    const byId = new Map(restored.messages.map((message) => [message.id, message]))
    expect(byId.get(rootId)?.threadRootMessageId).toBeUndefined()
    expect(byId.get(replyId)?.replyToMessageId).toBe(rootId)
    expect(byId.get(replyId)?.threadRootMessageId).toBe(rootId)
  }, 120_000)

  test('the restore ran into a clean disposable database, distinct from the source', async () => {
    const sourceName = new URL(sourceUrl!).pathname.slice(1)
    expect(scratch).not.toBe(sourceName)
    const [{ n }] = (await admin.client.unsafe(
      `select count(*)::int as n from pg_database where datname = '${scratch}'`
    )) as { n: number }[]
    expect(n).toBe(1)
    expect(destinationWorkspacesBeforeImport).toBe(0)
    expect(destinationMessagesBeforeImport).toBe(0)
  }, 120_000)

  test('the restored workspace reproduces the bundle digest', async () => {
    const reproduced = await destination.db.transaction((transaction) =>
      readCompletePortableContent(transaction, workspaceId)
    )
    expect(portableContentDigest(reproduced!)).toBe(bundle.contentDigest.value)
  }, 120_000)
})
