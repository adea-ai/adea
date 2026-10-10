import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { UserPrincipalRef } from '@adea-ai/types'

import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannel,
  createRuntimeResultMessage,
  setChannelParticipants,
} from '../../src/conversations'
import {
  listGroupChannelMessagesForUser,
  postGroupChannelMessage,
  revokeGroupGrant,
  shareGroupHistory,
} from '../../src/group-channels'
import { loadGroupAdmission } from '../../src/group-participation-store'
import { createTemporaryUserSession } from '../../src/identity'
import { workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
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

// #1222 quarantine-to-product-read gate, proved through the product read and write paths of the
// forward-merged #1232 join point, through the functions the web routes call for group channels:
// `listGroupChannelMessagesForUser`, `postGroupChannelMessage`, `loadGroupAdmission`,
// `shareGroupHistory`, `revokeGroupGrant`, plus `createRuntimeResultMessage` for the agent path.
// The group policy is not re-implemented here; a denial is whatever the product answers.
//
// Two owned databases on a disposable instance with the canonical role boundary:
//   - fresh:   the canonical chain from an empty database, groups created by the product;
//   - upgrade: main through 0046 and #1229/#1230, legacy groups written as the pre-#1232 product
//              wrote them, then the canonical 0049/0050 backfill, then the quarantine.
// Migrations run as the migration role. Product reads and writes run as the runtime role.
// Controls and restored-membership probes run in transactions that are always rolled back.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const provisioned = !!provisioningUrl || inCi
const SCRATCH_PREFIX = 'rehearsal_1222r_'
const OBSERVED_AT = '2026-01-05T00:00:00.000Z'
const GRANT_ISSUED_AT = '2026-01-01T00:00:00.000Z'
const GRANT_REVOKED_AT = '2026-02-01T00:00:00.000Z'

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

/** The owned fixture database, opened once as the migration role and once as the runtime role. */
function open(database: string): Fixture {
  return {
    database,
    migration: createDatabase(canonicalUrl(adminUrl(database), database, MIGRATION_ROLE)),
    runtime: createDatabase(canonicalUrl(adminUrl(database), database, RUNTIME_ROLE)),
  }
}

type Fixture = {
  database: string
  migration: DatabaseConnection
  runtime: DatabaseConnection
}

type Settled<T> = { value: T } | { denied: string }

/** The product's own answer, including its denial message, without throwing into the test. */
async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    return { denied: error instanceof Error ? error.message : String(error) }
  }
}

function visibleSequences(page: { messages: readonly { sequence: number }[] }): number[] {
  return page.messages.map((message) => message.sequence)
}

/** A direct group post through the group fence the web route uses: the admission check and the write commit together. */
function groupPost(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  text: string
) {
  return postGroupChannelMessage(database, workspaceId, channelId, principal, principal, {
    message: { bodyText: text, idempotencyKey: `post-${crypto.randomUUID()}` },
    mode: 'direct',
  })
}

class ProbeRollback extends Error {}

/** Runs `probe` in a transaction that is always rolled back, so no probe leaves a trace. */
async function rolledBack<T>(
  runtime: AgentHqDatabase,
  probe: (tx: AgentHqDatabase) => Promise<T>
): Promise<T> {
  let captured: T | undefined
  await runtime
    .transaction(async (tx) => {
      // The transaction is handed to the product functions as their database.
      captured = await probe(tx as unknown as AgentHqDatabase)
      throw new ProbeRollback()
    })
    .catch((error: unknown) => {
      if (!(error instanceof ProbeRollback)) throw error
    })
  return captured as T
}

async function rowsOf(db: AgentHqDatabase, statement: ReturnType<typeof sql>) {
  return (await db.execute<Record<string, unknown>>(statement)) as unknown as Record<
    string,
    unknown
  >[]
}

async function buildFreshGroup(fixture: Fixture) {
  const { migration, runtime } = fixture
  const principal = async (name: string) =>
    (
      await createTemporaryUserSession(runtime.db, {
        credentialDigest: `fresh-${name}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  const owner = await principal('owner')
  const member = await principal('member')
  const { workspace } = await createWorkspaceWithOwner(runtime.db, {
    idempotencyKey: `fresh-${crypto.randomUUID()}`,
    name: 'Fresh HQ',
    owner,
  })
  const workspaceId = workspace.id
  await migration.db.insert(workspaceMemberships).values({
    role: 'member',
    userId: member.userId,
    workspaceId,
  })
  const group = await createGroupChannel(runtime.db, workspaceId, owner, {
    idempotencyKey: `fresh-group-${crypto.randomUUID()}`,
    title: 'Fresh group',
  })
  const post = async (text: string) =>
    (await groupPost(runtime.db, workspaceId, group.id, owner, text)).sequence
  const early = [await post('before the join'), await post('still before the join')]
  // The newcomer joins after `early`: the join point sits just past the frontier.
  await setChannelParticipants(
    runtime.db,
    workspaceId,
    group.id,
    owner,
    [
      { kind: 'user', userId: owner.userId },
      { kind: 'user', userId: member.userId },
    ],
    group.version
  )
  const late = await post('after the join')
  return { channelId: group.id, early, late, member, owner, workspaceId }
}

type Snapshot = {
  ownerRead: Settled<number[]>
  memberRead: Settled<number[]>
  removedDirectRead: Settled<number[]>
  removedRestoredRead: Settled<number[]>
  removedRestoredPublish: Settled<unknown>
  removedAgentPublish: Settled<unknown>
  memberPublish: Settled<unknown>
  admissions: Record<'owner' | 'member' | 'removed', unknown>
  audienceGrantCounts: Record<'owner' | 'member', number>
}

async function snapshotUpgrade(upgrade: Fixture, seed: LegacyAudienceSeed): Promise<Snapshot> {
  const db = upgrade.runtime.db
  const { workspaceId: ws, activeGroupId: active } = seed
  // Restoring membership inside a rolled-back probe isolates the group gate from the workspace gate.
  const restoreMembership = (tx: AgentHqDatabase) =>
    tx.insert(workspaceMemberships).values({
      role: 'member',
      userId: seed.removed.userId,
      workspaceId: ws,
    })
  const admissionOf = (principal: UserPrincipalRef) =>
    loadGroupAdmission(db, ws, active, { kind: 'user', userId: principal.userId })
  const grantCountOf = async (principal: UserPrincipalRef) =>
    Number(
      (
        await rowsOf(
          upgrade.migration.db,
          sql`select count(*)::int as n from app.group_audience_grants where channel_id = ${active}::uuid and user_id = ${principal.userId}::uuid`
        )
      )[0]?.n ?? -1
    )

  return {
    admissions: {
      member: await admissionOf(seed.member),
      owner: await admissionOf(seed.owner),
      removed: await admissionOf(seed.removed),
    },
    audienceGrantCounts: {
      member: await grantCountOf(seed.member),
      owner: await grantCountOf(seed.owner),
    },
    memberPublish: await settle(() =>
      rolledBack(db, (tx) => groupPost(tx, ws, active, seed.member, 'clean member publication'))
    ),
    memberRead: await settle(async () =>
      visibleSequences(await listGroupChannelMessagesForUser(db, ws, active, seed.member, {}))
    ),
    ownerRead: await settle(async () =>
      visibleSequences(await listGroupChannelMessagesForUser(db, ws, active, seed.owner, {}))
    ),
    removedAgentPublish: await settle(() =>
      rolledBack(db, (tx) =>
        createRuntimeResultMessage(tx, ws, active, seed.member, {
          bodyText: 'mismatched agent publication',
          executionRef: `exec-${crypto.randomUUID()}`,
          externalSessionRef: `session-${crypto.randomUUID()}`,
          idempotencyKey: `agent-probe-${crypto.randomUUID()}`,
          sender: { kind: 'agent', agentId: seed.otherWorkspaceAgentId },
        })
      )
    ),
    removedDirectRead: await settle(async () =>
      visibleSequences(await listGroupChannelMessagesForUser(db, ws, active, seed.removed, {}))
    ),
    removedRestoredPublish: await settle(() =>
      rolledBack(db, async (tx) => {
        await restoreMembership(tx)
        return groupPost(tx, ws, active, seed.removed, 'restored-membership publication')
      })
    ),
    removedRestoredRead: await settle(() =>
      rolledBack(db, async (tx) => {
        await restoreMembership(tx)
        return visibleSequences(
          await listGroupChannelMessagesForUser(tx, ws, active, seed.removed, {})
        )
      })
    ),
  }
}

describe.skipIf(!provisioned)(
  'canonical quarantine-to-product-read gate (#1222 over #1232)',
  () => {
    let admin: postgres.Sql
    let fresh: Fixture
    let upgrade: Fixture
    let seed: LegacyAudienceSeed
    let freshGroup: Awaited<ReturnType<typeof buildFreshGroup>>
    let before: Snapshot
    let after: Snapshot
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14)
    const freshName = `${SCRATCH_PREFIX}fresh_${suffix}`
    const upgradeName = `${SCRATCH_PREFIX}upgrade_${suffix}`

    beforeAll(async () => {
      admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
      await createCanonicalDatabase(admin, adminUrl, freshName)
      await createCanonicalDatabase(admin, adminUrl, upgradeName)
      fresh = open(freshName)
      upgrade = open(upgradeName)
      const chain = canonicalChainFolders()

      await migrate(fresh.migration.db, { migrationsFolder: chain.full })
      freshGroup = await buildFreshGroup(fresh)

      await migrate(upgrade.migration.db, { migrationsFolder: chain.stageOne })
      seed = await seedLegacyAudience({
        migration: upgrade.migration.db,
        runtime: upgrade.runtime.db,
      })
      await migrate(upgrade.migration.db, { migrationsFolder: chain.full })
      await installLegacyAudienceQuarantine(upgrade.migration.db)
      // Clean members write into the active group before the quarantine, as the legacy product allowed.
      for (const [sender, text] of [
        [seed.owner, 'legacy hello'],
        [seed.owner, 'legacy follow-up'],
        [seed.member, 'clean member note'],
      ] as const) {
        await groupPost(upgrade.runtime.db, seed.workspaceId, seed.activeGroupId, sender, text)
      }
      before = await snapshotUpgrade(upgrade, seed)
      await quarantineLegacyAudience(upgrade.migration.db, {
        observedAt: OBSERVED_AT,
        profile: legacyBackfillProfile(),
      })
      after = await snapshotUpgrade(upgrade, seed)
    }, 300_000)

    afterAll(async () => {
      await fresh?.runtime.close()
      await fresh?.migration.close()
      await upgrade?.runtime.close()
      await upgrade?.migration.close()
      if (admin) {
        for (const database of [freshName, upgradeName]) {
          await admin.unsafe(`drop database if exists "${database}" with (force)`)
        }
        await admin.end()
      }
    })

    test('the fixtures are two distinct databases, each owned by the migration role', async () => {
      expect(fresh.database).not.toBe(upgrade.database)
      const owned = await admin<{ datname: string; owner: string }[]>`
      select datname, pg_get_userbyid(datdba) as owner from pg_database
      where datname in (${freshName}, ${upgradeName}) order by datname`
      expect(owned).toEqual([
        { datname: freshName, owner: MIGRATION_ROLE },
        { datname: upgradeName, owner: MIGRATION_ROLE },
      ])
    })

    test('the canonical role boundary holds on both databases, and product calls run as the runtime role', async () => {
      for (const fixture of [fresh, upgrade]) {
        const roles = await rowsOf(
          fixture.migration.db,
          sql`select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname in (${MIGRATION_ROLE}, ${RUNTIME_ROLE})`
        )
        const byRole = Object.fromEntries(roles.map((row) => [row.rolname, row]))
        for (const role of [MIGRATION_ROLE, RUNTIME_ROLE]) {
          expect(byRole[role]).toEqual({
            rolname: role,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
          })
        }
        const who = await rowsOf(fixture.runtime.db, sql`select current_user as who`)
        expect(who[0]?.who).toBe(RUNTIME_ROLE)
        expect(
          'denied' in
            (await settle(() =>
              rowsOf(fixture.runtime.db, sql`create table app.boundary_probe (id int)`)
            ))
        ).toBe(true)
      }
    })

    test('fresh group: a newcomer reads only from the join point, an earlier-history grant unlocks the rest, and revocation closes it', async () => {
      const { channelId, early, late, member, owner, workspaceId } = freshGroup
      const db = fresh.runtime.db
      const now = new Date().toISOString()

      expect(
        visibleSequences(
          await listGroupChannelMessagesForUser(db, workspaceId, channelId, owner, {}, { now })
        )
      ).toEqual([...early, late])
      expect(
        visibleSequences(
          await listGroupChannelMessagesForUser(db, workspaceId, channelId, member, {}, { now })
        )
      ).toEqual([late])

      await shareGroupHistory(db, workspaceId, channelId, owner, {
        expiresAt: null,
        grantId: 'gra_share_member_fresh',
        groupId: channelId,
        issuedAt: GRANT_ISSUED_AT,
        participant: member,
        revision: 1,
        revokedAt: null,
        scope: 'earlier_history',
      })
      expect(
        visibleSequences(
          await listGroupChannelMessagesForUser(db, workspaceId, channelId, member, {}, { now })
        )
      ).toEqual([...early, late])

      await revokeGroupGrant(db, workspaceId, channelId, owner, {
        grantId: 'gra_share_member_fresh',
        kind: 'sharing',
        revokedAt: GRANT_REVOKED_AT,
      })
      expect(
        visibleSequences(
          await listGroupChannelMessagesForUser(db, workspaceId, channelId, member, {}, { now })
        )
      ).toEqual([late])
    })

    test('upgrade, before quarantine: the legacy active group reads and publishes for its members, and the about-to-leave user is admitted', () => {
      const legacyHistory = 'value' in before.ownerRead ? before.ownerRead.value : []
      expect(legacyHistory).toHaveLength(3)
      expect(before.memberRead).toEqual({ value: legacyHistory })
      expect(before.removedRestoredRead).toEqual({ value: legacyHistory })
      expect('value' in before.removedRestoredPublish).toBe(true)
      expect('value' in before.memberPublish).toBe(true)
      expect(before.admissions.removed).not.toBeNull()
    })

    test('upgrade, after quarantine: a quarantined user is refused by the workspace gate without membership', () => {
      expect(after.removedDirectRead).toEqual({ denied: 'Channel unavailable' })
    })

    test('upgrade, after quarantine: with membership restored, the withheld admission alone denies every history entry', () => {
      expect(after.removedRestoredRead).toEqual({ value: [] })
      expect(before.removedRestoredRead).not.toEqual({ value: [] })
      expect(after.admissions.removed).toBeNull()
    })

    test('upgrade, after quarantine: with membership restored, the quarantined user is refused publication into the active group', () => {
      expect('value' in before.removedRestoredPublish).toBe(true)
      expect(after.removedRestoredPublish).toEqual({ denied: 'Channel unavailable' })
    })

    test('upgrade, after quarantine: a quarantined agent from another workspace cannot publish into the active group', () => {
      // Before the quarantine the agent's admission stands and the group agent path accepts it.
      expect('value' in before.removedAgentPublish).toBe(true)
      // After it, the #1232 group agent path refuses on the withheld admission.
      expect(after.removedAgentPublish).toEqual({ denied: 'Channel unavailable' })
    })

    test('upgrade, after quarantine: a quarantined member of the archived group is denied its history and publication', async () => {
      const read = await settle(() =>
        listGroupChannelMessagesForUser(
          upgrade.runtime.db,
          seed.workspaceId,
          seed.archivedGroupId,
          seed.member,
          {}
        )
      )
      expect('denied' in read).toBe(true)
      const write = await settle(() =>
        groupPost(
          upgrade.runtime.db,
          seed.workspaceId,
          seed.archivedGroupId,
          seed.member,
          'archived publication'
        )
      )
      expect(write).toEqual({ denied: 'Channel unavailable' })
    })

    test('upgrade, after quarantine: clean members keep their admission, join point and audience grants, and still read and publish', () => {
      expect(after.admissions.owner).toEqual(before.admissions.owner)
      expect(after.admissions.member).toEqual(before.admissions.member)
      expect(after.audienceGrantCounts).toEqual(before.audienceGrantCounts)
      expect(after.audienceGrantCounts.owner).toBeGreaterThan(0)
      expect(after.audienceGrantCounts.member).toBeGreaterThan(0)
      expect(after.ownerRead).toEqual(before.ownerRead)
      expect(after.memberRead).toEqual(before.memberRead)
      expect('value' in after.memberPublish).toBe(true)
    })
  }
)
