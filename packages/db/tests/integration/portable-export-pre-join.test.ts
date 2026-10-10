// Pre-join group history in a portable workspace export (#1226, on the #1232 join-point gate).
//
// A newcomer joins a group at the message frontier. The export must carry exactly what the
// canonical group reader serves that principal: post-join messages, never pre-join history. The
// founder's export keeps the pre-join message as a control.
//
// The database is a scratch database this file creates on the throwaway capture instance
// (MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, supplied by the package runner), migrates from the
// repository's migrations, and drops afterwards. DATABASE_URL is never read, so the shared local
// database cannot be touched.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  type PortableWorkspaceExport,
  type UserPrincipalRef,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createMessage, listMessagesForUser } from '../../src/conversations'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  listGroupChannelMessagesForUser,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import { exportPortableWorkspace } from '../../src/portable-export'
import { PortableExportError } from '../../src/portable-export-content'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const JOINED = '2026-10-08T13:00:00.000Z'
const REVOKED = '2026-10-08T14:00:00.000Z'

const scratch = `portable_prejoin_${randomBytes(8).toString('hex')}`

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function assertDisposableScratch(name: string) {
  if (!/^portable_prejoin_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

function audienceGrant(channelId: string, grantId: string, participant: UserPrincipalRef) {
  return {
    expiresAt: null,
    grantId,
    groupId: channelId,
    issuedAt: ISSUED,
    participant,
    revision: 1,
    revokedAt: null,
  }
}

function groupMessageIds(document: PortableWorkspaceExport, channelId: string): string[] {
  return document.content.messages
    .filter((message) => message.channelId === channelId)
    .map((message) => message.messageId)
}

describe.skipIf(!provisioningUrl)('portable export excludes pre-join group history', () => {
  let connection: DatabaseConnection
  let admin: DatabaseConnection

  beforeAll(async () => {
    admin = createDatabase(urlForDatabase('postgres'))
    await admin.client.unsafe(`create database "${scratch}"`)
    connection = createDatabase(urlForDatabase(scratch))
    await migrate(connection.db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
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

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `prejoin-${label}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
    ).principal
  }

  /**
   * A founder posts before a newcomer joins at the frontier, the newcomer joins, then the founder
   * posts a plain message and a reply to the pre-join root.
   */
  async function scenario() {
    const owner = await user('owner')
    const newcomer = await user('newcomer')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: randomUUID(),
      name: 'Pre-join export',
      owner,
    })
    const workspaceId = workspace.id
    await addWorkspaceMembership(connection.db, workspaceId, newcomer, 'member')

    const channelId = randomUUID()
    const created = await createGroupChannelWithGrants(connection.db, workspaceId, owner, {
      candidates: groupCreationCandidatesFromGrants(workspaceId, {
        audienceGrants: [audienceGrant(channelId, 'gra_owner', owner)],
        enlistmentGrants: [],
      }),
      channelId,
      idempotencyKey: randomUUID(),
      now: NOW,
      title: 'Pre-join group',
    })
    const preJoin = await createMessage(connection.db, workspaceId, channelId, owner, {
      bodyText: 'founder note before the join',
      idempotencyKey: randomUUID(),
      sender: owner,
    })
    const joined = await setGroupChannelParticipantsWithGrants(
      connection.db,
      workspaceId,
      channelId,
      owner,
      {
        candidates: groupCreationCandidatesFromGrants(workspaceId, {
          audienceGrants: [
            audienceGrant(channelId, 'gra_owner', owner),
            audienceGrant(channelId, 'gra_newcomer', newcomer),
          ],
          enlistmentGrants: [],
        }),
        expectedVersion: created.channel.version,
        now: JOINED,
      }
    )
    const admission = joined.roster.find(
      (entry) => entry.participant.kind === 'user' && entry.participant.userId === newcomer.userId
    )!
    expect(admission.joinPoint.joinedSequence).toBe(preJoin.sequence + 1)

    const postJoin = await createMessage(connection.db, workspaceId, channelId, owner, {
      bodyText: 'founder note after the join',
      idempotencyKey: randomUUID(),
      sender: owner,
    })
    const reply = await createMessage(connection.db, workspaceId, channelId, owner, {
      bodyText: 'reply to the pre-join root',
      idempotencyKey: randomUUID(),
      replyToMessageId: preJoin.id,
      sender: owner,
      threadRootMessageId: preJoin.id,
    })
    return { channelId, newcomer, owner, postJoin, preJoin, reply, workspaceId }
  }

  /** Every message the canonical group reader serves the principal, paged to the end. */
  async function readAllGroupMessages(
    workspaceId: string,
    channelId: string,
    principal: UserPrincipalRef
  ): Promise<string[]> {
    const ids: string[] = []
    let afterSequence: number | undefined
    for (;;) {
      const page = await listGroupChannelMessagesForUser(
        connection.db,
        workspaceId,
        channelId,
        principal,
        { afterSequence, limit: 100 }
      )
      ids.push(...page.messages.map((message) => message.id))
      if (page.nextAfterSequence === undefined) return ids
      afterSequence = page.nextAfterSequence
    }
  }

  test('a newcomer export excludes pre-join history and matches the canonical reader', async () => {
    const s = await scenario()
    const document = await exportPortableWorkspace(connection.db, {
      principal: s.newcomer,
      workspaceId: s.workspaceId,
    })

    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(document.exportedBy.role).toBe('member')
    const exported = groupMessageIds(document, s.channelId)
    expect(exported).not.toContain(s.preJoin.id)
    expect(exported).toContain(s.postJoin.id)
    expect(exported).toContain(s.reply.id)

    const readerIds = await readAllGroupMessages(s.workspaceId, s.channelId, s.newcomer)
    expect(readerIds).not.toContain(s.preJoin.id)
    expect(exported.toSorted()).toEqual(readerIds.toSorted())

    const plainReaderIds: string[] = []
    let afterSequence: number | undefined
    for (;;) {
      const page = await listMessagesForUser(
        connection.db,
        s.workspaceId,
        s.channelId,
        s.newcomer,
        { afterSequence, limit: 100 }
      )
      plainReaderIds.push(...page.messages.map((message) => message.id))
      if (page.nextAfterSequence === undefined) break
      afterSequence = page.nextAfterSequence
    }
    expect(exported.toSorted()).toEqual(plainReaderIds.toSorted())
  })

  test('the founder export keeps the pre-join message as a control', async () => {
    const s = await scenario()
    const document = await exportPortableWorkspace(connection.db, {
      principal: s.owner,
      workspaceId: s.workspaceId,
    })

    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(document.exportedBy.role).toBe('owner')
    expect(groupMessageIds(document, s.channelId)).toEqual(
      expect.arrayContaining([s.preJoin.id, s.postJoin.id, s.reply.id])
    )
    const founderReply = document.content.messages.find(
      (message) => message.messageId === s.reply.id
    )
    expect(founderReply?.threadRootMessageId).toBe(s.preJoin.id)
    expect(founderReply?.replyToMessageId).toBe(s.preJoin.id)
  })

  test('a post-join reply to a pre-join root keeps the reply, clears its thread link, and numbers the channel from 1', async () => {
    const s = await scenario()
    const document = await exportPortableWorkspace(connection.db, {
      principal: s.newcomer,
      workspaceId: s.workspaceId,
    })

    const rows = document.content.messages.filter((message) => message.channelId === s.channelId)
    const reply = rows.find((message) => message.messageId === s.reply.id)
    expect(reply).toBeDefined()
    expect(reply?.threadRootMessageId).toBeNull()
    expect(reply?.replyToMessageId).toBeNull()
    expect(rows.map((message) => message.channelOrder)).toEqual(rows.map((_, index) => index + 1))
    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
  })

  test('revoking the newcomer audience grant ends their group history in the export', async () => {
    const s = await scenario()
    await revokeGroupGrant(connection.db, s.workspaceId, s.channelId, s.owner, {
      grantId: 'gra_newcomer',
      kind: 'audience',
      revokedAt: REVOKED,
    })

    expect(await readAllGroupMessages(s.workspaceId, s.channelId, s.newcomer)).toEqual([])
    const outcome = await exportPortableWorkspace(connection.db, {
      principal: s.newcomer,
      workspaceId: s.workspaceId,
    }).then(
      (document) => ({ document, code: null }),
      (error: unknown) => {
        if (error instanceof PortableExportError) return { document: null, code: error.code }
        throw error
      }
    )
    // Observed behaviour: the reader serves nothing to the revoked newcomer, and the export still
    // succeeds with no group messages for them.
    expect(outcome.code).toBeNull()
    expect(outcome.document).not.toBeNull()
    const document = outcome.document!
    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(groupMessageIds(document, s.channelId)).toEqual([])
  })
})
