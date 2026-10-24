import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  authorizationAuditRecords,
  simLaunchCodes,
  simSessions,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { grantSimAllowlist, revokeSimAllowlist } from '../../src/sim-allowlist'
import { createSimIssuerStores } from '../../src/sim-launch-ports'
import {
  archiveWorkspace,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
} from '../../src/workspaces'
import { createSimHostWorker } from '../../../../apps/web/src/server/sim-host-worker'
import {
  createSimWorkerComposition,
  type SimWorkerEnvironment,
} from '../../../../apps/web/src/server/sim-worker-composition'
import { openSimPostgresStores } from '../../../../apps/web/src/server/sim-worker-postgres'

// The Worker composition over the real durable stores. The database is the disposable test
// database; the bucket is a fake that records every key it is asked for. No Cloudflare binding,
// credential or network is involved.
const connectionUrl = process.env.DATABASE_URL

const SIM_ORIGIN = 'https://sim.example'
const PARENT_ORIGIN = 'https://app.example'
const BRIDGE = 'bridge_nonce_123456789'

/** The composed Worker, its environment, and the keys its fake bucket was asked for. */
function composed() {
  const asked: string[] = []
  const environment: SimWorkerEnvironment = {
    SIM_DATABASE: { connectionString: connectionUrl! },
    SIM_EXPORT: {
      async get(key) {
        asked.push(key)
        return key === 'engine.js' ? { body: new Response('engine').body, httpMetadata: {} } : null
      },
    },
    SIM_ORIGIN,
    SIM_PARENT_ORIGINS: PARENT_ORIGIN,
  }
  const worker = createSimHostWorker<SimWorkerEnvironment>(
    createSimWorkerComposition({
      contract: {
        assetPrefix: '/assets/agent-sim/',
        entryFiles: {
          hq: 'engine.js',
          'room-designer': 'room-designer.js',
          'character-designer': 'character-designer.js',
        },
      },
      frameScript: '// public bootstrap only',
      openStores: openSimPostgresStores,
    })
  )
  return { worker, environment, asked }
}

const asset = (cookie: string) =>
  new Request(`${SIM_ORIGIN}/assets/agent-sim/engine.js`, { headers: { cookie } })

describe.skipIf(!connectionUrl)('the hosted Sim Worker composition on PostgreSQL', () => {
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

  async function fixture() {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    owners.push(session.principal)
    await ensureBootstrapWorkspaces(connection.db, session.principal)
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: session.principal,
      idempotencyKey: `sim-worker-${crypto.randomUUID()}`,
      name: 'Sim Worker composition fixture',
    })
    return { owner: session.principal, workspace }
  }

  async function launch(
    worker: ReturnType<typeof composed>['worker'],
    env: SimWorkerEnvironment,
    workspaceId: string
  ) {
    const code = `code-${crypto.randomUUID()}`
    await createSimIssuerStores(connection.db)(workspaceId).issue(
      code,
      { surface: 'hq', bridgeId: BRIDGE, origin: SIM_ORIGIN },
      Date.now() + 60_000
    )
    const response = await worker.fetch(
      new Request(`${SIM_ORIGIN}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SIM_ORIGIN },
        body: JSON.stringify({ schemaVersion: 1, code, bridgeId: BRIDGE }),
      }),
      env
    )
    return response.headers.get('set-cookie')?.split(';')[0]
  }

  test('a granted workspace redeems a code and reads the engine through the composed Worker', async () => {
    const { workspace } = await fixture()
    await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const { worker, environment, asked } = composed()
    const cookie = await launch(worker, environment, workspace.id)
    expect(cookie).toBeTruthy()
    const response = await worker.fetch(asset(cookie!), environment)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('engine')
    expect(asked).toEqual(['engine.js'])
  })

  test('withdrawing the grant or archiving the workspace stops an open session, with no further bucket read', async () => {
    const withdrawn = await fixture()
    const archived = await fixture()
    const { worker, environment, asked } = composed()
    const sessions: { cookie: string }[] = []
    for (const { workspace } of [withdrawn, archived]) {
      await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
      const cookie = await launch(worker, environment, workspace.id)
      expect(cookie).toBeTruthy()
      expect((await worker.fetch(asset(cookie!), environment)).status).toBe(200)
      sessions.push({ cookie: cookie! })
    }
    expect(asked).toHaveLength(2)

    await revokeSimAllowlist(connection.db, { workspaceId: withdrawn.workspace.id, surface: 'hq' })
    await archiveWorkspace(connection.db, archived.workspace.id, archived.owner)
    for (const { cookie } of sessions) {
      expect((await worker.fetch(asset(cookie), environment)).status).toBeGreaterThanOrEqual(400)
    }
    expect(asked).toHaveLength(2)
  })

  test('a workspace that was never granted gets a session row but no asset and no bucket read', async () => {
    const { workspace } = await fixture()
    const { worker, environment, asked } = composed()
    const cookie = await launch(worker, environment, workspace.id)
    expect(cookie).toBeTruthy()
    expect((await worker.fetch(asset(cookie!), environment)).status).toBe(403)
    expect(asked).toEqual([])
  })

  test('an unreachable database answers closed, never an asset', async () => {
    const { workspace } = await fixture()
    await grantSimAllowlist(connection.db, { workspaceId: workspace.id, surface: 'hq' })
    const { worker, environment, asked } = composed()
    const cookie = await launch(worker, environment, workspace.id)
    const down: SimWorkerEnvironment = {
      ...environment,
      SIM_DATABASE: {
        connectionString: 'postgresql://sim_host:x@127.0.0.1:1/none?connect_timeout=2',
      },
    }
    const response = await worker.fetch(asset(cookie!), down)
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(asked).toEqual([])
  })
})
