import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { UserPrincipalRef } from '@adea-ai/types'

import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import type { WorkspaceEventView } from '../../src/event-log'
import {
  archiveChannel,
  createMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { postGroupChannelMessage } from '../../src/group-channels'
import { loadGroupAdmission } from '../../src/group-participation-store'
import { listReadStateForUser } from '../../src/read-state'
import { searchWorkspaceForUser } from '../../src/search'
import { channelParticipants, groupAdmissions, workspaceMemberships } from '../../src/schema'
import { canonicalChainFolders } from '../fixtures/canonical-chain'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../fixtures/canonical-boundary'
import {
  installLegacyAudienceQuarantine,
  legacyBackfillProfile,
  quarantineLegacyAudience,
} from '../fixtures/legacy-audience-quarantine'
import { seedLegacyAudience, type LegacyAudienceSeed } from '../fixtures/legacy-audience-seed'

// #1222 quarantine, proved at the product boundaries a stale legacy roster row can reach.
//
// The legacy `channel_participants` rows of a quarantined audience remain. Its canonical admission
// is withheld. Each product read, append and join below is run as the quarantined user, with
// workspace membership restored (the user was re-invited), so the only thing left to refuse them is
// the group's canonical admission. Clean members run the same calls as controls.
//
// One upgrade database on a disposable instance with the canonical role boundary: main through
// 0046, the stage-one #1229/#1230 chain, the legacy seed, the canonical 0049/0050 backfill, then the
// quarantine. Migrations run as the migration role. Product calls run as the runtime role.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const provisioned = !!provisioningUrl || inCi
const SCRATCH_PREFIX = 'rehearsal_1222g_'
const OBSERVED_AT = '2026-01-05T00:00:00.000Z'

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type Fixture = {
  database: string
  migration: DatabaseConnection
  runtime: DatabaseConnection
}

function open(database: string): Fixture {
  return {
    database,
    migration: createDatabase(canonicalUrl(adminUrl(database), database, MIGRATION_ROLE)),
    runtime: createDatabase(canonicalUrl(adminUrl(database), database, RUNTIME_ROLE)),
  }
}

type Settled<T> = { value: T } | { denied: string }

/** The product's own answer, including its refusal message, without throwing into the test. */
async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    return { denied: error instanceof Error ? error.message : String(error) }
  }
}

/** Every message in an error's cause chain: a driver failure names its database refusal only as the cause. */
function messageChain(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' | ')
}

async function countRows(db: AgentHqDatabase, statement: ReturnType<typeof sql>) {
  const [row] = (await db.execute<{ count: number }>(statement)) as unknown as {
    count: number
  }[]
  return Number(row?.count ?? 0)
}

/** Everything a refused write must leave untouched: messages, roster rows, admissions, version. */
async function writeFootprint(db: AgentHqDatabase, workspaceId: string, channelId: string) {
  return {
    admissions: await countRows(
      db,
      sql`select count(*)::int as count from ${groupAdmissions} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    messages: await countRows(
      db,
      sql`select count(*)::int as count from app.messages where channel_id = ${channelId}::uuid`
    ),
    rosterRows: await countRows(
      db,
      sql`select count(*)::int as count from ${channelParticipants} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    version: await countRows(
      db,
      sql`select version::int as count from app.channels where id = ${channelId}::uuid`
    ),
  }
}

/** The unread channel count the account summary reports for one workspace. */
async function unreadChannelsFor(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const summaries = await accountWorkspaceSummaries(database, principal)
  return summaries.find((row) => row.workspaceId === workspaceId)?.unreadChannels
}

/** The stale audience re-enters the workspace; its original roster row is still on record. */
function reinviteUser(db: AgentHqDatabase, seedValue: LegacyAudienceSeed) {
  return db.insert(workspaceMemberships).values({
    role: 'member',
    userId: seedValue.removedUserId,
    workspaceId: seedValue.workspaceId,
  })
}

function channelUpdatedEvent(channelId: string): WorkspaceEventView {
  return {
    actor: null,
    aggregateId: channelId,
    aggregateType: 'channel',
    correlationId: null,
    eventId: crypto.randomUUID(),
    eventType: 'channel.updated',
    occurredAt: new Date(OBSERVED_AT),
    payload: { channelId },
    schemaVersion: 1,
    workspaceSequence: 1,
  }
}

describe.skipIf(!provisioned)(
  'canonical quarantine at the stale-participant product boundary (#1222)',
  () => {
    let admin: postgres.Sql
    let upgrade: Fixture
    let seed: LegacyAudienceSeed
    let ownerMessageId: string
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14)
    const upgradeName = `${SCRATCH_PREFIX}upgrade_${suffix}`

    beforeAll(async () => {
      admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
      await createCanonicalDatabase(admin, adminUrl, upgradeName)
      upgrade = open(upgradeName)
      const chain = canonicalChainFolders()

      await migrate(upgrade.migration.db, { migrationsFolder: chain.stageOne })
      seed = await seedLegacyAudience({
        migration: upgrade.migration.db,
        runtime: upgrade.runtime.db,
      })
      await migrate(upgrade.migration.db, { migrationsFolder: chain.full })
      await installLegacyAudienceQuarantine(upgrade.migration.db)
      const legacy = await postGroupChannelMessage(
        upgrade.runtime.db,
        seed.workspaceId,
        seed.activeGroupId,
        seed.owner,
        seed.owner,
        { message: { bodyText: 'legacy hello', idempotencyKey: 'legacy-hello' }, mode: 'direct' }
      )
      ownerMessageId = legacy.id
      await postGroupChannelMessage(
        upgrade.runtime.db,
        seed.workspaceId,
        seed.activeGroupId,
        seed.member,
        seed.member,
        { message: { bodyText: 'clean member note', idempotencyKey: 'clean-note' }, mode: 'direct' }
      )
      await quarantineLegacyAudience(upgrade.migration.db, {
        observedAt: OBSERVED_AT,
        profile: legacyBackfillProfile(),
      })
      await reinviteUser(upgrade.migration.db, seed)
    }, 300_000)

    afterAll(async () => {
      await upgrade?.runtime.close()
      await upgrade?.migration.close()
      if (admin) {
        await admin.unsafe(`drop database if exists "${upgradeName}" with (force)`)
        await admin.end()
      }
    })

    const db = () => upgrade.runtime.db
    const ws = () => seed.workspaceId
    const active = () => seed.activeGroupId
    const stale = (): UserPrincipalRef => seed.removed

    test('the stale audience is a workspace member again, and holds no canonical admission', async () => {
      const membership = await countRows(
        upgrade.migration.db,
        sql`select count(*)::int as count from app.workspace_memberships where workspace_id = ${ws()}::uuid and user_id = ${stale().userId}::uuid`
      )
      expect(membership).toBe(1)
      expect(
        await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
      ).toBeNull()
      const roster = await countRows(
        upgrade.migration.db,
        sql`select count(*)::int as count from ${channelParticipants} where channel_id = ${active()}::uuid and principal_kind = 'user' and user_id = ${stale().userId}::uuid`
      )
      expect(roster).toBe(1)
    })

    describe('read', () => {
      test('getChannelForUser refuses the stale group by its admission, not its roster row', async () => {
        expect(await settle(() => getChannelForUser(db(), ws(), active(), stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        expect(
          'value' in (await settle(() => getChannelForUser(db(), ws(), active(), seed.owner)))
        ).toBe(true)
      })

      test('listChannelsForUser omits the stale group; clean members still list it', async () => {
        const staleIds = (await listChannelsForUser(db(), ws(), stale())).map(
          (channel) => channel.id
        )
        expect(staleIds).not.toContain(active())
        const ownerIds = (await listChannelsForUser(db(), ws(), seed.owner)).map((c) => c.id)
        expect(ownerIds).toContain(active())
      })

      test('listMessagesForUser and getMessageForUser refuse the stale group history', async () => {
        expect(await settle(() => listMessagesForUser(db(), ws(), active(), stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        expect(await settle(() => getMessageForUser(db(), ws(), ownerMessageId, stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        const ownerPage = await listMessagesForUser(db(), ws(), active(), seed.owner)
        expect(ownerPage.messages.map((message) => message.bodyText)).toContain('legacy hello')
      })

      test('the account inbox and the read state omit the stale group', async () => {
        const inbox = await accountConversationInbox(db(), stale())
        expect(inbox.conversations.map((entry) => entry.id)).not.toContain(active())
        const readState = await listReadStateForUser(db(), ws(), stale())
        expect(readState.map((entry) => entry.channelId)).not.toContain(active())
        const ownerInbox = await accountConversationInbox(db(), seed.owner)
        expect(ownerInbox.conversations.map((entry) => entry.id)).toContain(active())
      })

      test('the account summary counts no unread from the stale group', async () => {
        // The group has messages nobody has read. The owner counts it; the stale user must not.
        expect(await unreadChannelsFor(db(), ws(), seed.owner)).toBeGreaterThan(0)
        expect(await unreadChannelsFor(db(), ws(), stale())).toBe(0)
      })

      test('search returns neither the stale group as a channel nor its messages', async () => {
        const { title } = await getChannelForUser(db(), ws(), active(), seed.owner)
        const staleHits = await searchWorkspaceForUser(db(), ws(), stale(), title)
        expect(staleHits.results.filter((hit) => hit.kind === 'channel')).not.toContainEqual(
          expect.objectContaining({ id: active() })
        )
        const staleMessages = await searchWorkspaceForUser(db(), ws(), stale(), 'legacy hello')
        expect(staleMessages.results.filter((hit) => hit.kind === 'message')).toEqual([])
        const ownerHits = await searchWorkspaceForUser(db(), ws(), seed.owner, 'legacy hello')
        expect(ownerHits.results.some((hit) => hit.kind === 'message')).toBe(true)
      })

      test('workspace events about the stale group are not delivered to it', async () => {
        const staleDelivery = await classifyWorkspaceEventsForUser(db(), ws(), stale().userId, [
          channelUpdatedEvent(active()),
        ])
        expect(staleDelivery?.[0]?.kind).not.toBe('deliver')
        const ownerDelivery = await classifyWorkspaceEventsForUser(db(), ws(), seed.owner.userId, [
          channelUpdatedEvent(active()),
        ])
        expect(ownerDelivery?.[0]?.kind).toBe('deliver')
      })
    })

    describe('append', () => {
      test('createMessage refuses a post from the stale audience, and writes nothing', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const attempt = await settle(() =>
          createMessage(db(), ws(), active(), stale(), {
            bodyText: 'stale append through the legacy writer',
            idempotencyKey: `stale-create-${crypto.randomUUID()}`,
            sender: { kind: 'user', userId: stale().userId },
          })
        )
        expect(attempt).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('the canonical group post refuses the stale audience, and writes nothing', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const attempt = await settle(() =>
          postGroupChannelMessage(db(), ws(), active(), stale(), stale(), {
            message: {
              bodyText: 'stale canonical post',
              idempotencyKey: `stale-post-${crypto.randomUUID()}`,
            },
            mode: 'direct',
          })
        )
        expect(attempt).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('renaming or archiving the stale group is refused, and the group is unchanged', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const rename = await settle(() =>
          updateChannel(
            db(),
            ws(),
            active(),
            stale(),
            { title: 'renamed by stale audience' },
            before.version
          )
        )
        expect(rename).toEqual({ denied: 'Channel unavailable' })
        const archive = await settle(() =>
          archiveChannel(db(), ws(), active(), stale(), before.version)
        )
        expect(archive).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('a clean member still appends to the same group', async () => {
        const posted = await postGroupChannelMessage(
          db(),
          ws(),
          active(),
          seed.member,
          seed.member,
          {
            message: {
              bodyText: 'member after the quarantine',
              idempotencyKey: `member-${crypto.randomUUID()}`,
            },
            mode: 'direct',
          }
        )
        expect(posted.bodyText).toBe('member after the quarantine')
      })
    })

    describe('join', () => {
      test('the legacy roster write cannot re-admit the stale audience through its original row', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const current = await getChannelForUser(db(), ws(), active(), seed.owner)
        const refusal = await setChannelParticipants(
          db(),
          ws(),
          active(),
          seed.owner,
          [
            { kind: 'user', userId: seed.owner.userId },
            { kind: 'user', userId: seed.member.userId },
            { kind: 'user', userId: stale().userId },
          ],
          current.version
        ).then(
          () => 'written',
          (error: unknown) => messageChain(error)
        )
        // The withholding trigger refuses the implicit grant the roster write would mint for the stale
        // user. The whole write rolls back: the refusal names the canonical withholding, not a rejection.
        expect(refusal).toContain('legacy audience is quarantined')
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
        expect(
          await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
        ).toBeNull()
      })
    })
  }
)
