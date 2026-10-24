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
    expect(config.checks.map(({ name }) => name).toSorted()).toEqual([
      'sim_workspace_allowlist_surface_closed',
      'sim_workspace_allowlist_workspace_nonempty',
    ])
    // No foreign key: a row for a workspace that does not exist grants nothing.
    expect(config.foreignKeys).toHaveLength(0)
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

describe('hosted Sim allowlist store, refusals before storage', () => {
  test('a lookup for an empty workspace or an unknown surface resolves false without a query', async () => {
    const lookup = createSimAllowlistLookup(untouched)
    expect(await lookup({ workspaceId: '', surface: 'hq' })).toBe(false)
    expect(await lookup({ workspaceId: 'workspace-one', surface: 'admin' })).toBe(false)
    expect(await lookup({ workspaceId: 'workspace-one', surface: '' })).toBe(false)
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
      grantSimAllowlist(untouched, { workspaceId: 'workspace-one', surface: 'admin' })
    ).rejects.toThrow(RangeError)
    await expect(
      revokeSimAllowlist(untouched, { workspaceId: 'workspace-one', surface: 'admin' })
    ).rejects.toThrow(RangeError)
  })
})
