import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { simWorkspaceAllowlist } from '../../src/schema'
import {
  createSimAllowlistLookup,
  grantSimAllowlist,
  revokeSimAllowlist,
} from '../../src/sim-allowlist'
import { createSimAllowlistPolicy } from '../../../../apps/web/src/server/sim-allowlist'

const connectionUrl = process.env.DATABASE_URL

const unique = () => crypto.randomUUID()

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
  const created = new Set<string>()
  const workspace = () => {
    const id = `ws-${unique()}`
    created.add(id)
    return id
  }

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    const ids = [...created]
    if (ids.length > 0) {
      await connection.db
        .delete(simWorkspaceAllowlist)
        .where(inArray(simWorkspaceAllowlist.workspaceId, ids))
    }
    await connection.close()
  })

  test('a workspace with no row is not granted any surface', async () => {
    const lookup = createSimAllowlistLookup(connection.db)
    const id = workspace()
    for (const surface of ['hq', 'room-designer', 'character-designer']) {
      expect(await lookup({ workspaceId: id, surface })).toBe(false)
    }
  })

  test('a grant covers exactly its workspace and surface, and withdrawing it removes access', async () => {
    const lookup = createSimAllowlistLookup(connection.db)
    const id = workspace()
    const other = workspace()

    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'room-designer' })).toBe(false)
    expect(await lookup({ workspaceId: other, surface: 'hq' })).toBe(false)
    // A different spelling of the identifier is a different workspace.
    expect(await lookup({ workspaceId: id.toUpperCase(), surface: 'hq' })).toBe(false)

    expect(await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await lookup({ workspaceId: id, surface: 'hq' })).toBe(false)
    expect(await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(false)
  })

  test('granting twice stores one row and reports no second addition', async () => {
    const id = workspace()
    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(true)
    expect(await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })).toBe(false)
    const rows = await connection.db
      .select()
      .from(simWorkspaceAllowlist)
      .where(eq(simWorkspaceAllowlist.workspaceId, id))
    expect(rows).toHaveLength(1)
  })

  test('the database itself refuses an unknown surface and an empty workspace', async () => {
    await expect(insertRaw(connection.db, workspace(), 'admin')).rejects.toThrow()
    await expect(insertRaw(connection.db, '', 'hq')).rejects.toThrow()
  })

  test('the allowlist policy entitles only a granted workspace and surface', async () => {
    const policy = createSimAllowlistPolicy(createSimAllowlistLookup(connection.db))
    const id = workspace()
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('not_entitled')
    await grantSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('entitled')
    expect(await policy({ workspaceId: id, surface: 'character-designer' })).toBe('not_entitled')
    expect(await policy({ workspaceId: '', surface: 'hq' })).toBe('not_entitled')
    await revokeSimAllowlist(connection.db, { workspaceId: id, surface: 'hq' })
    expect(await policy({ workspaceId: id, surface: 'hq' })).toBe('not_entitled')
  })

  test('a failing database makes the lookup throw rather than answer false', async () => {
    const broken = createDatabase(connectionUrl!.replace(/\/[^/?]+(\?|$)/, '/no_such_database$1'), {
      maxConnections: 1,
      connectTimeoutSeconds: 2,
    })
    try {
      const lookup = createSimAllowlistLookup(broken.db)
      await expect(lookup({ workspaceId: workspace(), surface: 'hq' })).rejects.toThrow()
    } finally {
      await broken.close()
    }
  })
})
