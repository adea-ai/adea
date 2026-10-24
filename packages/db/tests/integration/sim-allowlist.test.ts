import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
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
  function hosted(now: () => number) {
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
      store: createSimRedemptionStore(connection.db),
      sessions: createSimSessionLookup(connection.db, now),
      policy: createSimAllowlistPolicy(createSimAllowlistLookup(connection.db)),
      readAsset: (path) => reader(path),
      frameScript: '// public bootstrap only',
      now,
    })
    return { host, reads }
  }

  /** Issues a code through the durable issuer store and redeems it, returning the session cookie. */
  async function openSession(workspaceId: string, now: () => number) {
    const code = `code-${crypto.randomUUID()}`
    await createSimIssuerStores(connection.db)(workspaceId).issue(
      code,
      { surface: 'hq', bridgeId: BRIDGE, origin: SIM_ORIGIN },
      now() + 60_000
    )
    const { host, reads } = hosted(now)
    const response = await host(
      new Request(`${SIM_ORIGIN}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SIM_ORIGIN },
        body: JSON.stringify({ schemaVersion: 1, code, bridgeId: BRIDGE }),
      })
    )
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const asset = async () =>
      (
        await host(
          new Request(`${SIM_ORIGIN}/assets/agent-sim/engine.js`, {
            headers: { cookie: cookie! },
          })
        )
      ).status
    return { asset, reads }
  }

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
      sessions: 0,
    })
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
