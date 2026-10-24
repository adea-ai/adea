import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  authorizationAuditRecords,
  simLaunchCodes,
  simSessions,
  simWorkspaceAllowlist,
  users,
  temporaryUserSessions,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import {
  createSimAllowlistLookup,
  grantSimAllowlist,
  revokeSimAllowlist,
  SimAllowlistWorkspaceUnavailableError,
  withdrawSimAccess,
} from '../../src/sim-allowlist'
import {
  createSimIssuerStores,
  createSimRedemptionStore,
  createSimSessionLookup,
} from '../../src/sim-launch-ports'
import {
  archiveWorkspace,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  reopenWorkspace,
} from '../../src/workspaces'
import { createSimAllowlistPolicy } from '../../../../apps/web/src/server/sim-allowlist'
import { createSimHostService } from '../../../../apps/web/src/server/sim-host-service'
import { createSimPrivateAssetReader } from '../../../../apps/web/src/server/sim-private-assets'

const connectionUrl = process.env.DATABASE_URL

const SIM_ORIGIN = 'https://sim.example'
const PARENT_ORIGIN = 'https://app.example'
const BRIDGE = 'bridge_nonce_123456789'

/** A raw insert, to prove the database refuses what the store would never write. */
const insertRaw = async (
  database: DatabaseConnection['db'],
  workspaceId: string,
  surface: string
) => {
  await database.execute(
    sql`insert into app.sim_workspace_allowlist (workspace_id, surface) values (${workspaceId}, ${surface})`
  )
}

/** A one-shot signal. */
const noop = () => undefined
const latch = () => {
  let open = noop
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

/** Resolves once another backend in this database is waiting on a lock. */
const waitForLockWaiter = async (database: DatabaseConnection['db']) => {
  for (let poll = 0; poll < 500; poll += 1) {
    const rows = await database.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
    )
    if (rows[0]?.waiting) return
    await Bun.sleep(10)
  }
  throw new Error('nothing ever waited on a lock')
}

/**
 * Wraps a database or transaction so a statement can be made to fail deterministically. `update`
 * throws when it targets the given table; every transaction opened through the wrapper, including a
 * savepoint, is wrapped the same way.
 */
const failingUpdate = (target: unknown, table: unknown): any =>
  new Proxy(target as object, {
    get(real, property) {
      if (property === 'update') {
        return (updated: unknown) => {
          if (updated === table) throw new Error('injected failure')
          return (real as any).update(updated)
        }
      }
      if (property === 'transaction') {
        return (callback: (inner: unknown) => unknown, ...rest: unknown[]) =>
          (real as any).transaction(
            (inner: unknown) => callback(failingUpdate(inner, table)),
            ...rest
          )
      }
      const value = Reflect.get(real, property, real)
      return typeof value === 'function' ? value.bind(real) : value
    },
  })

/**
 * A database whose transactions pause after their last statement, holding every lock, until
 * `release` opens. It stands in for a redemption caught in flight.
 */
const pausedBeforeCommit = (database: DatabaseConnection['db']) => {
  const paused = latch()
  const release = latch()
  const wrapped = new Proxy(database as object, {
    get(real, property) {
      if (property === 'transaction') {
        return (callback: (inner: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (real as any).transaction(
            async (inner: unknown) => {
              const result = await callback(inner)
              paused.open()
              await release.promise
              return result
            },
            ...rest
          )
      }
      const value = Reflect.get(real, property, real)
      return typeof value === 'function' ? value.bind(real) : value
    },
  }) as AgentHqDatabase
  return { database: wrapped, paused: paused.promise, release: release.open }
}

describe.skipIf(!connectionUrl)('the hosted Sim allowlist on PostgreSQL', () => {
  let connection: DatabaseConnection
  const owners: UserPrincipalRef[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    for (const owner of owners) {
      const rows = await connection.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.ownerUserId, owner.userId))
      const ids = rows.map((row) => row.id)
      if (ids.length > 0) {
        await connection.db.delete(simSessions).where(inArray(simSessions.workspaceId, ids))
        await connection.db.delete(simLaunchCodes).where(inArray(simLaunchCodes.workspaceId, ids))
        await connection.db
          .delete(workspaceMemberships)
          .where(inArray(workspaceMemberships.workspaceId, ids))
        await connection.db
          .delete(authorizationAuditRecords)
          .where(inArray(authorizationAuditRecords.workspaceId, ids))
        await connection.db.delete(workspaces).where(inArray(workspaces.id, ids))
      }
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, owner.userId))
      await connection.db.delete(users).where(eq(users.id, owner.userId))
    }
    await connection.close()
  })

  /** A fresh owner with one real, non-personal workspace. */
  async function fixture() {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    owners.push(session.principal)
    await ensureBootstrapWorkspaces(connection.db, session.principal)
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: session.principal,
      idempotencyKey: `sim-allowlist-${crypto.randomUUID()}`,
      name: 'Sim allowlist fixture',
    })
    return { owner: session.principal, workspace }
  }

  /** The hosted side over the real stores, with a synthetic private object behind it. */
  function hosted(now: () => number, database: AgentHqDatabase = connection.db) {
    const reads: string[] = []
    const reader = createSimPrivateAssetReader({
      location: 'agent-sim-export',
      read: async ({ key }) => {
        reads.push(key)
        return { body: `private:${key}`, contentType: 'text/javascript' }
      },
    })
    const host = createSimHostService({
      configuration: {
        origin: SIM_ORIGIN,
        parentOrigins: [PARENT_ORIGIN],
        assetPrefix: '/assets/agent-sim/',
        entryFiles: {
          hq: 'engine.js',
          'room-designer': 'room-designer.js',
          'character-designer': 'character-designer.js',
        },
      },
      store: createSimRedemptionStore(database),
      sessions: createSimSessionLookup(connection.db, now),
      policy: createSimAllowlistPolicy(createSimAllowlistLookup(connection.db)),
      readAsset: (path) => reader(path),
      frameScript: '// public bootstrap only',
      now,
    })
    return { host, reads }
  }

  /** Issues a launch code through the durable issuer store. */
  async function issueCode(workspaceId: string, surface = 'hq', now: () => number = Date.now) {
    const code = `code-${crypto.randomUUID()}`
    await createSimIssuerStores(connection.db)(workspaceId).issue(
      code,
      { surface: surface as 'hq', bridgeId: BRIDGE, origin: SIM_ORIGIN },
      now() + 60_000
    )
    return code
  }

  /** Presents a code to a hosted service and reads the answer. */
  async function present(host: ReturnType<typeof hosted>['host'], code: string) {
    const response = await host(
      new Request(`${SIM_ORIGIN}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SIM_ORIGIN },
        body: JSON.stringify({ schemaVersion: 1, code, bridgeId: BRIDGE }),
      })
    )
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    return {
      response,
      cookie,
      body: (await response.clone().json()) as { status: string; reason?: string },
    }
  }

  const assetStatus = async (host: ReturnType<typeof hosted>['host'], cookie: string) =>
    (await host(new Request(`${SIM_ORIGIN}/assets/agent-sim/engine.js`, { headers: { cookie } })))
      .status

  /** Issues a code and redeems it, returning an asset probe for the session cookie. */
  async function openSession(workspaceId: string, now: () => number, surface = 'hq') {
    const code = await issueCode(workspaceId, surface, now)
    const { host, reads } = hosted(now)
    const { cookie } = await present(host, code)
    expect(cookie).toBeTruthy()
    return { asset: () => assetStatus(host, cookie!), reads, cookie: cookie! }
  }

  const sessionRows = (workspaceId: string) =>
    connection.db.select().from(simSessions).where(eq(simSessions.workspaceId, workspaceId))
  const codeRows = (workspaceId: string) =>
    connection.db.select().from(simLaunchCodes).where(eq(simLaunchCodes.workspaceId, workspaceId))

  test('a workspace with no row is not granted any surface', async () => {
    const lookup = createSimAllowlistLookup(connection.db)
    const { workspace } = await fixture()
    for (const surface of ['hq', 'room-designer', 'character-designer']) {
      expect(await lookup({ workspaceId: workspace.id, surface })).toBe(false)
    }
  })

  test('a grant covers exactly its workspace and surface, and withdrawing it removes access', async () => {
    const lookup = createSimAllowlistLookup(connection.db)
    const { workspace } = await fixture()
    const other = await fixture()
    const id = workspace.id

    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id.toUpperCase(), surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'room-designer' })).toBe(false)
    expect(await lookup({ workspaceId: other.workspace.id, surface: 'hq' })).toBe(false)

    expect(await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'hq' })).toBe(false)
    expect(await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(false)
  })

  test('granting twice stores one row and reports no second addition', async () => {
    const { workspace } = await fixture()
    const scope = { workspaceId: workspace.id, surface: 'hq' }
    expect(await grantSimAllowlist(connection.db, scope)).toBe(true)
    expect(await grantSimAllowlist(connection.db, scope)).toBe(false)
    const rows = await connection.db
      .select()
      .from(simWorkspaceAllowlist)
      .where(eq(simWorkspaceAllowlist.workspaceId, workspace.id))
    expect(rows).toHaveLength(1)
  })

  test('a workspace that does not exist cannot be granted, in the store or in the database', async () => {
    const missing = crypto.randomUUID()
    await expect(
      grantSimAllowlist(connection.db, { workspaceId: missing, surface: 'hq' })
    ).rejects.toThrow(SimAllowlistWorkspaceUnavailableError)
    // The foreign key is the backstop when the store is bypassed.
    await expect(insertRaw(connection.db, missing, 'hq')).rejects.toThrow()
    expect(
      await createSimAllowlistLookup(connection.db)({ workspaceId: missing, surface: 'hq' })
    ).toBe(false)
  })

  test('the database itself refuses an unknown surface', async () => {
    const { workspace } = await fixture()
    await expect(insertRaw(connection.db, workspace.id, 'admin')).rejects.toThrow()
  })

  test('an archived or deletion-pending workspace cannot be granted', async () => {
    const archived = await fixture()
    await archiveWorkspace(connection.db, archived.workspace.id, archived.owner)
    await expect(
      grantSimAllowlist(connection.db, { workspaceId: archived.workspace.id, surface: 'hq' })
    ).rejects.toThrow(SimAllowlistWorkspaceUnavailableError)

    const pending = await fixture()
    await connection.db
      .update(workspaces)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(workspaces.id, pending.workspace.id))
    await expect(
      grantSimAllowlist(connection.db, { workspaceId: pending.workspace.id, surface: 'hq' })
    ).rejects.toThrow(SimAllowlistWorkspaceUnavailableError)
  })

  test('the allowlist policy entitles only a granted workspace and surface', async () => {
    const policy = createSimAllowlistPolicy(createSimAllowlistLookup(connection.db))
    const { workspace } = await fixture()
    const id = workspace.id
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('not_entitled')
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('entitled')
    expect(await policy({ workspaceId: id, surface: 'character-designer' })).toBe('not_entitled')
    expect(await policy({ workspaceId: '', surface: 'hq' })).toBe('not_entitled')
    await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('not_entitled')
  })

  test('a live session keeps reading while the grant stands and stops when the grant is withdrawn', async () => {
    const { workspace } = await fixture()
    await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const session = await openSession(workspace.id, Date.now)
    expect(await session.asset()).toBe(200)
    await revokeSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const reads = session.reads.length
    expect(await session.asset()).toBe(403)
    expect(session.reads).toHaveLength(reads)
  })

  test('archiving the workspace ends an existing session and its grant, and reopening does not restore them', async () => {
    const { owner, workspace } = await fixture()
    await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const session = await openSession(workspace.id, Date.now)
    expect(await session.asset()).toBe(200)
    const reads = session.reads.length

    await archiveWorkspace(connection.db, workspace.id, owner)
    expect(await session.asset()).toBeGreaterThanOrEqual(400)
    expect(session.reads).toHaveLength(reads)
    const [row] = await connection.db
      .select({ revokedAt: simSessions.revokedAt })
      .from(simSessions)
      .where(eq(simSessions.workspaceId, workspace.id))
    expect(row?.revokedAt).toBeInstanceOf(Date)
    expect(
      await createSimAllowlistLookup(connection.db)({ workspaceId: workspace.id, surface: 'hq' })
    ).toBe(false)

    // Reopening makes the workspace usable again but never brings the Sim grant or session back.
    await reopenWorkspace(connection.db, workspace.id, owner)
    expect(await session.asset()).toBeGreaterThanOrEqual(400)
    expect(
      await createSimAllowlistLookup(connection.db)({ workspaceId: workspace.id, surface: 'hq' })
    ).toBe(false)
  })

  test('permanent disappearance of the workspace removes its grants and denies an existing session', async () => {
    const { workspace } = await fixture()
    await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const session = await openSession(workspace.id, Date.now)
    expect(await session.asset()).toBe(200)
    const reads = session.reads.length

    // The same raw removal the workspace-deletion fixtures use; it exercises the foreign key cascade.
    await connection.db.transaction(async (transaction) => {
      await transaction
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id))
      await transaction
        .delete(authorizationAuditRecords)
        .where(eq(authorizationAuditRecords.workspaceId, workspace.id))
      await transaction.delete(workspaces).where(eq(workspaces.id, workspace.id))
    })
    const rows = await connection.db
      .select()
      .from(simWorkspaceAllowlist)
      .where(eq(simWorkspaceAllowlist.workspaceId, workspace.id))
    expect(rows).toHaveLength(0)
    expect(await session.asset()).toBe(403)
    expect(session.reads).toHaveLength(reads)
  })

  test('withdrawing access ends every grant and live session of that workspace and no other', async () => {
    const one = await fixture()
    const two = await fixture()
    for (const { workspace } of [one, two])
      await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const first = await openSession(one.workspace.id, Date.now)
    const second = await openSession(two.workspace.id, Date.now)

    expect(await withdrawSimAccess(connection.db, one.workspace.id)).toEqual({
      grants: 1,
      codes: 0,
      sessions: 1,
    })
    expect(await first.asset()).toBeGreaterThanOrEqual(400)
    expect(await second.asset()).toBe(200)
    const [untouched] = await connection.db
      .select({ revokedAt: simSessions.revokedAt })
      .from(simSessions)
      .where(eq(simSessions.workspaceId, two.workspace.id))
    expect(untouched?.revokedAt).toBeNull()
    // Withdrawing again has nothing left to end.
    expect(await withdrawSimAccess(connection.db, one.workspace.id)).toEqual({
      grants: 0,
      codes: 0,
      sessions: 0,
    })
  })

  test('a launch code issued before an archive cannot revive authority after reopen and regrant', async () => {
    const { owner, workspace } = await fixture()
    const id = workspace.id
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    const code = await issueCode(id)

    await archiveWorkspace(connection.db, id, owner)
    // The pending code was spent by the withdrawal, so presenting it now opens nothing.
    const stale = await present(hosted(Date.now).host, code)
    expect(stale.cookie).toBeUndefined()
    expect(stale.body).toEqual({ status: 'rejected', reason: 'code_used' })
    expect(await sessionRows(id)).toHaveLength(0)

    await reopenWorkspace(connection.db, id, owner)
    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    // Nothing from before the archive is alive: no session exists and the old code stays spent.
    expect(await sessionRows(id)).toHaveLength(0)
    expect((await present(hosted(Date.now).host, code)).cookie).toBeUndefined()
    expect(await sessionRows(id)).toHaveLength(0)
    // Authority comes back only through a fresh launch.
    expect(await (await openSession(id, Date.now)).asset()).toBe(200)
  })

  test('withdrawal spends only the unspent launch codes of that workspace', async () => {
    const one = await fixture()
    const two = await fixture()
    const spent = await issueCode(one.workspace.id)
    await grantSimAllowlist(connection.db, { workspaceId: one.workspace.id, surface: 'hq' })
    await present(hosted(Date.now).host, spent)
    const [spentBefore] = await codeRows(one.workspace.id)
    const pending = await issueCode(one.workspace.id)
    const untouched = await issueCode(two.workspace.id)

    const ended = await withdrawSimAccess(connection.db, one.workspace.id)
    expect(ended.codes).toBe(1)

    const oneRows = await codeRows(one.workspace.id)
    expect(oneRows).toHaveLength(2)
    expect(oneRows.every((row) => row.consumedAt !== null)).toBe(true)
    // The code that was already spent keeps the instant it was spent.
    expect(oneRows.find((row) => row.id === spentBefore!.id)?.consumedAt).toEqual(
      spentBefore!.consumedAt
    )
    const [other] = await codeRows(two.workspace.id)
    expect(other?.consumedAt).toBeNull()
    expect((await present(hosted(Date.now).host, pending)).body.reason).toBe('code_used')
    expect((await present(hosted(Date.now).host, untouched)).cookie).toBeTruthy()
  })

  test('a redemption in flight when access is withdrawn is waited for and its session is revoked', async () => {
    const { workspace } = await fixture()
    const id = workspace.id
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    const code = await issueCode(id)

    // The redemption has locked the code, spent it and written its session, but has not committed.
    const flight = pausedBeforeCommit(connection.db)
    const inFlight = hosted(Date.now, flight.database)
    const redemption = present(inFlight.host, code)
    await flight.paused

    let settled = false
    const withdrawal = withdrawSimAccess(connection.db, id).finally(() => {
      settled = true
    })
    await waitForLockWaiter(connection.db)
    // The withdrawal cannot finish while the redemption holds the code row.
    expect(settled).toBe(false)

    flight.release()
    const [redeemed, ended] = await Promise.all([redemption, withdrawal])
    // The redemption won the lock and minted a session; the withdrawal then saw and revoked it.
    expect(redeemed.cookie).toBeTruthy()
    expect(ended).toEqual({ grants: 1, codes: 0, sessions: 1 })
    const [row] = await sessionRows(id)
    expect(row?.revokedAt).toBeInstanceOf(Date)
    const after = hosted(Date.now)
    expect(await assetStatus(after.host, redeemed.cookie!)).toBeGreaterThanOrEqual(400)
    expect(after.reads).toHaveLength(0)
  })

  test('a regrant ends the earlier sessions and unspent codes of that surface only', async () => {
    const { workspace } = await fixture()
    const id = workspace.id
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'room-designer' })
    const hq = await openSession(id, Date.now, 'hq')
    const room = await openSession(id, Date.now, 'room-designer')
    const pendingHq = await issueCode(id, 'hq')
    const pendingRoom = await issueCode(id, 'room-designer')
    expect(await hq.asset()).toBe(200)

    await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    // Withdrawing one row ends nothing by itself; the next grant starts the clean slate.
    expect((await sessionRows(id)).every((row) => row.revokedAt === null)).toBe(true)
    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)

    expect(await hq.asset()).toBeGreaterThanOrEqual(400)
    expect((await present(hosted(Date.now).host, pendingHq)).body.reason).toBe('code_used')
    // The other surface's session and pending code are untouched.
    const live = await connection.db
      .select()
      .from(simSessions)
      .where(and(eq(simSessions.workspaceId, id), isNull(simSessions.revokedAt)))
    expect(live.map((row) => row.surface)).toEqual(['room-designer'])
    expect((await present(hosted(Date.now).host, pendingRoom)).cookie).toBeTruthy()
    expect(room.cookie).toBeTruthy()

    // A grant that was already present ends nothing.
    const fresh = await openSession(id, Date.now, 'hq')
    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(false)
    expect(await fresh.asset()).toBe(200)
  })

  test('withdrawal on a full database is atomic: a failure part-way ends nothing', async () => {
    const { workspace } = await fixture()
    const id = workspace.id
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    const session = await openSession(id, Date.now)
    const pending = await issueCode(id)

    await expect(withdrawSimAccess(failingUpdate(connection.db, simSessions), id)).rejects.toThrow(
      'injected failure'
    )

    // The grant deletion and the code spend ran before the failure and were rolled back with it.
    const grants = await connection.db
      .select()
      .from(simWorkspaceAllowlist)
      .where(eq(simWorkspaceAllowlist.workspaceId, id))
    expect(grants).toHaveLength(1)
    const unspent = await connection.db
      .select()
      .from(simLaunchCodes)
      .where(and(eq(simLaunchCodes.workspaceId, id), isNull(simLaunchCodes.consumedAt)))
    expect(unspent).toHaveLength(1)
    expect((await sessionRows(id))[0]?.revokedAt).toBeNull()
    expect(await session.asset()).toBe(200)
    expect((await present(hosted(Date.now).host, pending)).cookie).toBeTruthy()
  })

  test('withdrawal inside a transaction is a savepoint of it: a failure rolls back its own statements, and the outer rollback undoes it all', async () => {
    const { workspace } = await fixture()
    const id = workspace.id
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    const session = await openSession(id, Date.now)
    const pending = await issueCode(id)

    await connection.db.transaction(async (outer) => {
      await expect(withdrawSimAccess(failingUpdate(outer, simSessions), id)).rejects.toThrow(
        'injected failure'
      )
      // The failed call left the outer transaction's view as it was.
      const grants = await outer
        .select()
        .from(simWorkspaceAllowlist)
        .where(eq(simWorkspaceAllowlist.workspaceId, id))
      expect(grants).toHaveLength(1)
      const unspent = await outer
        .select()
        .from(simLaunchCodes)
        .where(and(eq(simLaunchCodes.workspaceId, id), isNull(simLaunchCodes.consumedAt)))
      expect(unspent).toHaveLength(1)
    })

    // A successful call is undone by a rollback of the transaction that contains it.
    await expect(
      connection.db.transaction(async (outer) => {
        expect((await withdrawSimAccess(outer, id)).grants).toBe(1)
        throw new Error('roll the whole unit back')
      })
    ).rejects.toThrow('roll the whole unit back')
    expect(await createSimAllowlistLookup(connection.db)({ workspaceId: id, surface: 'hq' })).toBe(
      true
    )
    expect(await session.asset()).toBe(200)
    expect((await present(hosted(Date.now).host, pending)).cookie).toBeTruthy()
  })

  test('a failing database makes the lookup throw rather than answer false', async () => {
    const broken = createDatabase(connectionUrl!.replace(/\/[^/?]+(\?|$)/, '/no_such_database$1'), {
      maxConnections: 1,
      connectTimeoutSeconds: 2,
    })
    try {
      const lookup = createSimAllowlistLookup(broken.db)
      await expect(lookup({ workspaceId: crypto.randomUUID(), surface: 'hq' })).rejects.toThrow()
    } finally {
      await broken.close()
    }
  })
})
