// Conversation order and thread links survive export and restore into a clean database
// (M18.02.2, #1226). Message identifiers are generated, so the replies here are added until one
// of them sorts before the root's identifier, while the sequence still places the root first. A
// restore that orders messages by identifier would read the conversation inverted.
//
// The source lives in the lane database. The destination is a disposable database created on the
// lane's throwaway provisioning instance (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL), migrated from
// the repository's migrations, and dropped afterwards. The test is skipped when that variable is
// absent.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import { validatePortableWorkspaceExport, type PortableWorkspaceExport } from '@adea-ai/types'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, createMessage, listMessagesForUser } from '../../src/conversations'
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
const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function scratchNameFor() {
  return `portable_order_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_order_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

describe.skipIf(!sourceUrl || !provisioningUrl)(
  'restore keeps conversation order and thread links',
  () => {
    let source: DatabaseConnection
    let admin: DatabaseConnection
    let destination: DatabaseConnection
    let scratch: string
    let workspaceId: string
    let channelId: string
    let owner: Awaited<ReturnType<typeof createTemporaryUserSession>>
    let root: Awaited<ReturnType<typeof createMessage>>
    let replies: Awaited<ReturnType<typeof createMessage>>[] = []
    let bundle: PortableWorkspaceExport

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
      root = await createMessage(source.db, workspaceId, channelId, owner.principal, {
        bodyText: 'Root message',
        idempotencyKey: `order-root-${run}`,
        sender: owner.principal,
      })
      // Each reply is a threaded reply to the root, sent after it. Stop at the first reply whose
      // identifier sorts before the root's; the bound makes an unlucky run fail instead of looping.
      for (
        let attempt = 0;
        attempt < 32 && !replies.some((reply) => reply.id < root.id);
        attempt += 1
      )
        replies.push(
          await createMessage(source.db, workspaceId, channelId, owner.principal, {
            bodyText: `Reply ${attempt} message`,
            idempotencyKey: `order-reply-${run}-${attempt}`,
            replyToMessageId: root.id,
            sender: owner.principal,
            threadRootMessageId: root.id,
          })
        )
      expect(replies.some((reply) => reply.id < root.id)).toBe(true)

      bundle = await exportPortableWorkspace(source.db, { principal: owner.principal, workspaceId })
      expect(validatePortableWorkspaceExport(bundle).ok).toBe(true)

      scratch = scratchNameFor()
      assertDisposableScratch(scratch)
      admin = createDatabase(urlForDatabase('postgres'))
      await admin.client.unsafe(`create database "${scratch}"`)
      destination = createDatabase(urlForDatabase(scratch))
      await migrate(destination.db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
      await destination.db
        .insert(users)
        .values(
          bundle.content.users.map((user) => ({ displayName: user.displayName, id: user.userId }))
        )
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

    test('the restored database reads the conversation in the source order, not in identifier order', async () => {
      const sourceOrder = (
        await listMessagesForUser(source.db, workspaceId, channelId, owner.principal)
      ).messages
      const restoredOrder = (
        await listMessagesForUser(destination.db, workspaceId, channelId, owner.principal)
      ).messages

      expect(sourceOrder.map((message) => message.id)).toEqual([
        root.id,
        ...replies.map((reply) => reply.id),
      ])
      expect(restoredOrder.map((message) => message.id)).toEqual(
        sourceOrder.map((message) => message.id)
      )
      expect(restoredOrder.map((message) => message.bodyText)).toEqual([
        'Root message',
        ...replies.map((_, index) => `Reply ${index} message`),
      ])
      // The identifiers do not sort in conversation order, so an order by identifier would fail above.
      expect(restoredOrder.map((message) => message.id).toSorted()).not.toEqual(
        restoredOrder.map((message) => message.id)
      )
    }, 120_000)

    test('the restored replies keep their reply and thread links to the root', async () => {
      const restored = (
        await listMessagesForUser(destination.db, workspaceId, channelId, owner.principal)
      ).messages
      const byId = new Map(restored.map((message) => [message.id, message]))

      expect(byId.get(root.id)?.threadRootMessageId).toBeUndefined()
      for (const reply of replies) {
        expect(byId.get(reply.id)?.replyToMessageId).toBe(root.id)
        expect(byId.get(reply.id)?.threadRootMessageId).toBe(root.id)
      }
    }, 120_000)

    test('the restored workspace reproduces the bundle digest', async () => {
      const reproduced = await destination.db.transaction((transaction) =>
        readCompletePortableContent(transaction, workspaceId)
      )
      expect(portableContentDigest(reproduced!)).toBe(bundle.contentDigest.value)
    }, 120_000)
  }
)
