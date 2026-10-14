import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  PORTABLE_WORKSPACE_EXPORT_MAX_BYTES,
  portableJsonUtf8ByteLength,
} from '@adea-ai/types/portable-export'

import type { AgentHqDatabase } from '../../src/connection'
import { createDatabase } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
} from '../../src/group-channels'
import {
  listChannelsForUserPage,
  listMessagesForUser,
  readMessagesForUserIds,
} from '../../src/conversations'
import { exportPortableWorkspace } from '../../src/portable-export'
import { PORTABLE_EXPORT_PROOF_TRANSACTION_CONFIG } from '../../src/portable-export-transaction'
import * as schema from '../../src/schema'
import {
  contentRefs,
  channels,
  groupAdmissions,
  groupAudienceGrants,
  groupSharingGrants,
  messages,
  projects,
  tasks,
  workspaceMemberships,
} from '../../src/schema'

const url = process.env.DATABASE_URL
describe.skipIf(!url)('portable export isolation and canonical final proof', () => {
  let client: ReturnType<typeof postgres>
  let database: AgentHqDatabase
  let control: ReturnType<typeof createDatabase>
  const queries: string[] = []
  beforeAll(() => {
    client = postgres(url!, {
      max: 1,
      prepare: false,
      debug: (_connection, query) => queries.push(query),
    })
    database = drizzle(client, { schema })
    control = createDatabase(url!)
  })
  afterAll(async () => {
    await client.end()
    await control.close()
  })

  async function fixture(count = 3) {
    const owner = (
      await createTemporaryUserSession(database, {
        credentialDigest: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
    const reader = (
      await createTemporaryUserSession(database, {
        credentialDigest: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
    const { workspace } = await createWorkspaceWithOwner(database, {
      idempotencyKey: randomUUID(),
      name: 'Isolation proof',
      owner,
    })
    await database
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: reader.userId, role: 'member' })
    const channelId = randomUUID()
    const readerGrantId = randomUUID()
    const issuedAt = new Date(Date.now() - 86_400_000).toISOString()
    const grant = (participant: typeof owner, grantId: string) => ({
      participant,
      grantId,
      groupId: channelId,
      issuedAt,
      expiresAt: null,
      revokedAt: null,
      revision: 1,
    })
    await createGroupChannelWithGrants(database, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [grant(owner, randomUUID()), grant(reader, readerGrantId)],
        enlistmentGrants: [],
      }),
      channelId,
      idempotencyKey: randomUUID(),
      title: 'Canonical group',
      now: new Date().toISOString(),
    })
    const rows = await database
      .insert(messages)
      .values(
        Array.from({ length: count }, (_, index) => ({
          workspaceId: workspace.id,
          channelId,
          senderKind: 'user' as const,
          senderUserId: owner.userId,
          bodyText: `Note ${index}`,
          createPayloadHash: 'a'.repeat(64),
          idempotencyKey: randomUUID(),
        }))
      )
      .returning()
    return {
      owner,
      reader,
      workspace,
      channelId,
      readerGrantId,
      rows: rows.toSorted((a, b) => a.sequence - b.sequence),
      issuedAt,
    }
  }

  function revoke(f: Awaited<ReturnType<typeof fixture>>) {
    return control.db
      .update(groupAudienceGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(groupAudienceGrants.workspaceId, f.workspace.id),
          eq(groupAudienceGrants.grantId, f.readerGrantId)
        )
      )
  }

  test('one connection exports through separate snapshots, final share locks, and no application writes', async () => {
    const f = await fixture()
    const [ref] = await database
      .insert(contentRefs)
      .values({
        workspaceId: f.workspace.id,
        messageId: f.rows[0]!.id,
        availability: 'offline',
        contentType: 'message_body',
        digestSha256: 'b'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
      })
      .returning()
    await database
      .update(messages)
      .set({ bodyText: null, bodyContentRefId: ref!.id })
      .where(eq(messages.id, f.rows[0]!.id))
    queries.length = 0
    const orchestrationIsolation: string[] = []
    const document = await exportPortableWorkspace(database, {
      workspaceId: f.workspace.id,
      principal: f.reader,
      hooks: {
        beforeStep: async () => {
          const [state] = await client<
            { isolation: string }[]
          >`select current_setting('transaction_isolation') as isolation`
          orchestrationIsolation.push(state!.isolation)
        },
      },
    })
    expect(document.content.messages.map((row) => row.messageId)).toEqual(
      f.rows.map((row) => row.id)
    )
    expect(document.content.contentRefs.map((row) => row.contentRefId)).toContain(ref!.id)
    expect(queries.some((query) => /for share/i.test(query))).toBe(true)
    expect(orchestrationIsolation.every((level) => level === 'read committed')).toBe(true)
    expect(
      queries.some((query) => /set transaction.*repeatable read.*read write/i.test(query))
    ).toBe(true)
    expect(
      queries.some((query) => /set transaction.*repeatable read.*read only/i.test(query))
    ).toBe(true)
    expect(
      queries.filter((query) =>
        /^\s*(insert|update|delete|truncate|alter|create|drop)\b/i.test(query)
      )
    ).toEqual([])
  }, 30_000)

  test('a completely filtered first page advances the raw sequence cursor', async () => {
    const f = await fixture(101)
    await database
      .update(groupAdmissions)
      .set({ joinedSequence: f.rows.at(-1)!.sequence })
      .where(
        and(eq(groupAdmissions.channelId, f.channelId), eq(groupAdmissions.userId, f.reader.userId))
      )
    const first = await listMessagesForUser(database, f.workspace.id, f.channelId, f.reader, {
      limit: 100,
    })
    expect(first.messages).toEqual([])
    expect(first.nextAfterSequence).toBe(f.rows[99]!.sequence)
    const document = await exportPortableWorkspace(database, {
      workspaceId: f.workspace.id,
      principal: f.reader,
    })
    expect(document.content.messages.map((row) => row.messageId)).toEqual([f.rows.at(-1)!.id])
  }, 30_000)

  test('the final ID batch preserves pre-join and foreign-channel refusal', async () => {
    const f = await fixture()
    const foreign = await fixture(1)
    await database
      .update(groupAdmissions)
      .set({ joinedSequence: f.rows[1]!.sequence })
      .where(
        and(eq(groupAdmissions.channelId, f.channelId), eq(groupAdmissions.userId, f.reader.userId))
      )
    const proof = await readMessagesForUserIds(database, f.workspace.id, f.channelId, f.reader, [
      f.rows[0]!.id,
      f.rows[1]!.id,
      foreign.rows[0]!.id,
    ])
    expect(proof.map((row) => row.id)).toEqual([f.rows[1]!.id])
  })

  test('a grant revoked between pages denies the entire export', async () => {
    const f = await fixture(101)
    let changed = false
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeMessagePage: async (page) => {
            if (page.afterSequence !== undefined && !changed) {
              changed = true
              await revoke(f)
            }
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(changed).toBe(true)
  }, 30_000)

  test('final admission revocation refuses buffered content', async () => {
    const f = await fixture()
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final') await revoke(f)
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  test('final earlier-history revocation refuses messages without losing channel standing', async () => {
    const f = await fixture()
    await database
      .update(groupAdmissions)
      .set({ joinedSequence: f.rows.at(-1)!.sequence })
      .where(
        and(eq(groupAdmissions.channelId, f.channelId), eq(groupAdmissions.userId, f.reader.userId))
      )
    const grantId = randomUUID()
    await database.insert(groupSharingGrants).values({
      workspaceId: f.workspace.id,
      channelId: f.channelId,
      userId: f.reader.userId,
      principalKind: 'user',
      grantId,
      revision: 1,
      scope: 'earlier_history',
      issuedAt: f.issuedAt,
      expiresAt: null,
      revokedAt: null,
    })
    const controlExport = await exportPortableWorkspace(database, {
      workspaceId: f.workspace.id,
      principal: f.reader,
    })
    expect(controlExport.content.messages).toHaveLength(3)
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(groupSharingGrants)
                .set({ revokedAt: new Date().toISOString() })
                .where(eq(groupSharingGrants.grantId, grantId))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    const page = await listChannelsForUserPage(database, f.workspace.id, f.reader)
    expect(page.channels.map((channel) => channel.id)).toContain(f.channelId)
  })

  test('a retained message changed before the final proof is refused', async () => {
    const f = await fixture()
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(messages)
                .set({ bodyText: 'Changed', version: 2 })
                .where(eq(messages.id, f.rows[0]!.id))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  test('an oversized body written before final proof is withheld before worker transfer', async () => {
    const f = await fixture(1)
    const proofPages: {
      bodyTextByteBudget: number
      bodyTextJsonBytes: number
      messageCount: number
      withheldBodyTextRows: number
    }[] = []
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(messages)
                .set({ bodyText: 'x'.repeat(PORTABLE_WORKSPACE_EXPORT_MAX_BYTES + 1), version: 2 })
                .where(eq(messages.id, f.rows[0]!.id))
          },
          afterMessageProofPage: (page) => proofPages.push(page),
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(proofPages).toEqual([
      {
        bodyTextByteBudget: portableJsonUtf8ByteLength('Note 0'),
        bodyTextJsonBytes: 0,
        messageCount: 1,
        withheldBodyTextRows: 1,
      },
    ])
  }, 30_000)

  test('final proof does not materialize messages hidden by a revoked earlier-history grant', async () => {
    const f = await fixture()
    await database
      .update(groupAdmissions)
      .set({ joinedSequence: f.rows.at(-1)!.sequence })
      .where(
        and(eq(groupAdmissions.channelId, f.channelId), eq(groupAdmissions.userId, f.reader.userId))
      )
    const grantId = randomUUID()
    await database.insert(groupSharingGrants).values({
      workspaceId: f.workspace.id,
      channelId: f.channelId,
      userId: f.reader.userId,
      principalKind: 'user',
      grantId,
      revision: 1,
      scope: 'earlier_history',
      issuedAt: f.issuedAt,
      expiresAt: null,
      revokedAt: null,
    })
    const proofPages: {
      bodyTextByteBudget: number
      bodyTextJsonBytes: number
      messageCount: number
      withheldBodyTextRows: number
    }[] = []
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(groupSharingGrants)
                .set({ revokedAt: new Date().toISOString() })
                .where(eq(groupSharingGrants.grantId, grantId))
          },
          afterMessageProofPage: (page) => proofPages.push(page),
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(proofPages).toEqual([
      {
        bodyTextByteBudget: 3 * portableJsonUtf8ByteLength('Note 0'),
        bodyTextJsonBytes: portableJsonUtf8ByteLength('Note 2'),
        messageCount: 1,
        withheldBodyTextRows: 0,
      },
    ])
  }, 30_000)

  test('canonical pages reuse a coherent snapshot and a later snapshot sees revocation', async () => {
    const f = await fixture()
    await database.transaction(
      async (snapshot) => {
        await snapshot.execute(
          sql`select 1 from app.workspace_memberships where workspace_id = ${f.workspace.id}::uuid`
        )
        await revoke(f)
        const page = await readMessagesForUserIds(
          snapshot,
          f.workspace.id,
          f.channelId,
          f.reader,
          f.rows.map((row) => row.id)
        )
        expect(page).toHaveLength(3)
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' }
    )
    await expect(
      readMessagesForUserIds(database, f.workspace.id, f.channelId, f.reader, [f.rows[0]!.id])
    ).rejects.toThrow('Channel unavailable')
  })

  test('canonical readers keep rejecting a caller-owned READ COMMITTED transaction', async () => {
    const f = await fixture()
    await database.transaction(async (snapshot) => {
      await expect(
        readMessagesForUserIds(snapshot, f.workspace.id, f.channelId, f.reader, [f.rows[0]!.id])
      ).rejects.toThrow('REPEATABLE READ or SERIALIZABLE')
    })
    expect(PORTABLE_EXPORT_PROOF_TRANSACTION_CONFIG).toEqual({
      accessMode: 'read write',
      isolationLevel: 'repeatable read',
    })
  })

  test('a group grant expired before the final proof refuses buffered content', async () => {
    const f = await fixture()
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(groupAudienceGrants)
                .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
                .where(eq(groupAudienceGrants.grantId, f.readerGrantId))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  test('a task reassigned to a hidden project before final proof refuses the old objective', async () => {
    const f = await fixture()
    const [publicProject, hiddenProject] = await database
      .insert(projects)
      .values([
        {
          workspaceId: f.workspace.id,
          name: 'Visible project',
          iconKey: 'planning',
          visibility: 'workspace' as const,
        },
        {
          workspaceId: f.workspace.id,
          name: 'Hidden project',
          iconKey: 'planning',
          visibility: 'members' as const,
        },
      ])
      .returning()
    const [task] = await database
      .insert(tasks)
      .values({
        workspaceId: f.workspace.id,
        creatorUserId: f.owner.userId,
        projectId: publicProject!.id,
        title: 'Moved task',
        objective: 'Must not escape after reassignment',
      })
      .returning()
    const before = await exportPortableWorkspace(database, {
      workspaceId: f.workspace.id,
      principal: f.reader,
    })
    expect(before.content.tasks.map((row) => row.taskId)).toContain(task!.id)
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(tasks)
                .set({ projectId: hiddenProject!.id, version: 2 })
                .where(eq(tasks.id, task!.id))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  test('a wholly filtered channel page advances to the next canonical group', async () => {
    const f = await fixture()
    const expiredId = '00000000-0000-4000-8000-' + randomUUID().replaceAll('-', '').slice(0, 12)
    const grantId = randomUUID()
    await createGroupChannelWithGrants(database, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [f.owner, f.reader].map((participant) => ({
          participant,
          grantId: participant.userId === f.reader.userId ? grantId : randomUUID(),
          groupId: expiredId,
          issuedAt: f.issuedAt,
          expiresAt: null,
          revokedAt: null,
          revision: 1,
        })),
        enlistmentGrants: [],
      }),
      channelId: expiredId,
      idempotencyKey: randomUUID(),
      title: 'Expired candidate',
      now: new Date().toISOString(),
    })
    await database
      .update(groupAudienceGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(groupAudienceGrants.grantId, grantId))
    const first = await listChannelsForUserPage(database, f.workspace.id, f.reader, { limit: 1 })
    expect(first.channels).toEqual([])
    expect(first.nextAfter).toEqual({ id: expiredId })
    const second = await listChannelsForUserPage(database, f.workspace.id, f.reader, {
      limit: 1,
      after: first.nextAfter,
    })
    expect(second.channels.map((channel) => channel.id)).toEqual([f.channelId])
    expect(second.nextAfter).toBeUndefined()
  })

  test('final content-reference binding changes refuse buffered metadata', async () => {
    const f = await fixture()
    const [ref] = await database
      .insert(contentRefs)
      .values({
        workspaceId: f.workspace.id,
        messageId: f.rows[0]!.id,
        availability: 'offline',
        contentType: 'message_body',
        digestSha256: 'c'.repeat(64),
        keyVersion: 1,
        revision: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
      })
      .returning()
    await database
      .update(messages)
      .set({ bodyText: null, bodyContentRefId: ref!.id })
      .where(eq(messages.id, f.rows[0]!.id))
    const before = await exportPortableWorkspace(database, {
      workspaceId: f.workspace.id,
      principal: f.reader,
    })
    expect(before.content.contentRefs.map((row) => row.contentRefId)).toContain(ref!.id)
    await expect(
      exportPortableWorkspace(database, {
        workspaceId: f.workspace.id,
        principal: f.reader,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await control.db
                .update(contentRefs)
                .set({ messageId: f.rows[1]!.id, revision: 2 })
                .where(eq(contentRefs.id, ref!.id))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
  })

  test('bounded channel pages retain the existing explicit archive option', async () => {
    const f = await fixture()
    await database
      .update(channels)
      .set({ lifecycleState: 'archived', version: 2 })
      .where(eq(channels.id, f.channelId))
    expect((await listChannelsForUserPage(database, f.workspace.id, f.reader)).channels).toEqual([])
    const archived = await listChannelsForUserPage(database, f.workspace.id, f.reader, {
      includeArchived: true,
    })
    expect(archived.channels.map((channel) => channel.id)).toEqual([f.channelId])
    expect(archived.channels[0]!.participants).toContainEqual(f.reader)
  })
})
