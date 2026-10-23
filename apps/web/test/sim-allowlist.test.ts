import { describe, expect, test } from 'bun:test'

import { createSimAllowlistPolicy } from '../src/server/sim-allowlist'
import { bindSimLaunchEntitlement, createSimAssetEntitlement } from '../src/server/sim-entitlement'

// The first-cohort entitlement policy: a per-workspace allowlist with default deny. The lookup is a
// synthetic in-memory set. No database, table, migration or credential is involved.

function lookupOf(rows: string[], asked: string[] = []) {
  return (scope: { workspaceId: string; surface: string }) => {
    asked.push(`${scope.workspaceId}:${scope.surface}`)
    return rows.includes(`${scope.workspaceId}:${scope.surface}`)
  }
}

describe('the allowlist policy', () => {
  test('a granted workspace and surface is entitled', async () => {
    const policy = createSimAllowlistPolicy(lookupOf(['workspace-one:hq']))
    expect(await policy({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('entitled')
  })

  test('a workspace without a row is denied, and so is another surface of a granted one', async () => {
    const policy = createSimAllowlistPolicy(lookupOf(['workspace-one:hq']))
    expect(await policy({ workspaceId: 'workspace-two', surface: 'hq' })).toBe('not_entitled')
    expect(await policy({ workspaceId: 'workspace-one', surface: 'room-designer' })).toBe(
      'not_entitled'
    )
  })

  test('only a literal true grants', async () => {
    for (const answer of [1, 'true', 'yes', {}, [], null, undefined, 'entitled']) {
      const policy = createSimAllowlistPolicy(() => answer)
      expect(await policy({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('not_entitled')
    }
  })

  test('a malformed scope is denied without asking the lookup', async () => {
    const asked: string[] = []
    const policy = createSimAllowlistPolicy(lookupOf(['workspace-one:hq'], asked))
    for (const workspaceId of ['', undefined, null, 7]) {
      const verdict = await policy({ workspaceId: workspaceId as string, surface: 'hq' })
      expect(verdict).toBe('not_entitled')
    }
    expect(asked).toEqual([])
  })

  test('a throwing lookup is unavailable through the launch and asset bindings', async () => {
    const policy = createSimAllowlistPolicy(() => {
      throw new Error('allowlist store down')
    })
    const launch = bindSimLaunchEntitlement(new Request('https://app.example/api/sim/launch'), {
      resolvePrincipal: () => ({ id: 'user-one' }),
      authorizeWorkspace: () => true,
      policy,
    })
    expect(await launch({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('unavailable')
    const asset = createSimAssetEntitlement(policy)
    expect(await asset({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('unavailable')
  })

  test('membership alone does not entitle: a member of an unlisted workspace is denied', async () => {
    const launch = bindSimLaunchEntitlement(new Request('https://app.example/api/sim/launch'), {
      resolvePrincipal: () => ({ id: 'user-one' }),
      authorizeWorkspace: () => true,
      policy: createSimAllowlistPolicy(lookupOf([])),
    })
    expect(await launch({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('not_entitled')
  })

  test('a listed workspace is still denied to a non-member', async () => {
    const launch = bindSimLaunchEntitlement(new Request('https://app.example/api/sim/launch'), {
      resolvePrincipal: () => ({ id: 'user-one' }),
      authorizeWorkspace: () => false,
      policy: createSimAllowlistPolicy(lookupOf(['workspace-one:hq'])),
    })
    expect(await launch({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('not_entitled')
  })

  test('removing a row revokes at the next asset request', async () => {
    const rows = ['workspace-one:hq']
    const asset = createSimAssetEntitlement(createSimAllowlistPolicy(lookupOf(rows)))
    expect(await asset({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('entitled')
    rows.length = 0
    expect(await asset({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('not_entitled')
  })
})
