import { describe, expect, test } from 'bun:test'

import { getTableConfig } from 'drizzle-orm/pg-core'

import { simWorkspaceAllowlist } from '../../src/schema'
import {
  createSimAllowlistLookup,
  grantSimAllowlist,
  revokeSimAllowlist,
} from '../../src/sim-allowlist'

describe('hosted Sim allowlist schema', () => {
  test('is one row per workspace and surface, with the surface closed in the database', () => {
    const config = getTableConfig(simWorkspaceAllowlist)

    expect(config.schema).toBe('app')
    expect(config.name).toBe('sim_workspace_allowlist')
    expect(config.uniqueConstraints.map(({ name }) => name)).toEqual([
      'sim_workspace_allowlist_workspace_surface_unique',
    ])
    expect(config.uniqueConstraints[0]!.columns.map(({ name }) => name)).toEqual([
      'workspace_id',
      'surface',
    ])
    expect(config.checks.map(({ name }) => name)).toEqual([
      'sim_workspace_allowlist_surface_closed',
    ])
    // A grant can only name a workspace that exists, and removing the workspace removes its grants.
    expect(config.foreignKeys).toHaveLength(1)
    const { columns, foreignColumns } = config.foreignKeys[0]!.reference()
    expect(columns.map(({ name }) => name)).toEqual(['workspace_id'])
    expect(getTableConfig(foreignColumns[0]!.table).name).toBe('workspaces')
    expect(foreignColumns[0]!.name).toBe('id')
    expect(config.foreignKeys[0]!.onDelete).toBe('cascade')
  })
})

// A database that fails the test if it is touched: the early refusals must not reach storage.
const untouched = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be touched')
    },
  }
) as never

const UUID = '8f0c6a52-45f1-4e0b-a8d2-7c1d6f4a9b10'

describe('hosted Sim allowlist store, refusals before storage', () => {
  test('a lookup for an empty workspace or an unknown surface resolves false without a query', async () => {
    const lookup = createSimAllowlistLookup(untouched)
    expect(await lookup({ workspaceId: '', surface: 'hq' })).toBe(false)
    expect(await lookup({ workspaceId: 'workspace-one', surface: 'hq' })).toBe(false)
    expect(await lookup({ workspaceId: UUID, surface: 'admin' })).toBe(false)
    expect(await lookup({ workspaceId: UUID, surface: '' })).toBe(false)
    expect(await lookup({ workspaceId: undefined, surface: 'hq' } as never)).toBe(false)
  })

  test('a grant or withdrawal that names an unusable workspace or surface is refused before storage', async () => {
    await expect(grantSimAllowlist(untouched, { workspaceId: '', surface: 'hq' })).rejects.toThrow(
      RangeError
    )
    await expect(
      grantSimAllowlist(untouched, { workspaceId: 'has space', surface: 'hq' })
    ).rejects.toThrow(RangeError)
    await expect(
      grantSimAllowlist(untouched, { workspaceId: 'workspace-one', surface: 'hq' })
    ).rejects.toThrow(RangeError)
    await expect(
      grantSimAllowlist(untouched, { workspaceId: UUID, surface: 'admin' })
    ).rejects.toThrow(RangeError)
    await expect(
      revokeSimAllowlist(untouched, { workspaceId: UUID, surface: 'admin' })
    ).rejects.toThrow(RangeError)
  })
})
