/** Offline checks for the Railway migration acceptance inventory (issue #1564). */
import { describe, expect, test } from 'bun:test'

import {
  CHILD_SCOPES,
  FORBIDDEN_MIGRATION_MARKERS,
  GATED_ACCEPTANCE,
  RELATED_PULL_REQUESTS,
  FRESHNESS_QUALIFICATION,
  inventoryNeonProviderDependencies,
  railwayMigrationAcceptanceInventory,
  scanForbiddenMigrationMarkers,
} from './railway-migration-acceptance-inventory.ts'

describe('the Railway migration acceptance inventory', () => {
  test('the remaining Neon and provider-auth dependencies are inventoried', () => {
    const dependencies = inventoryNeonProviderDependencies()
    expect(Array.isArray(dependencies)).toBe(true)
    expect(dependencies.length).toBeGreaterThan(0)
    for (const path of dependencies) expect(path.startsWith('apps/')).toBe(true)
  })

  test('no legacy import, dual write or old-data reconciliation is present', () => {
    expect(scanForbiddenMigrationMarkers()).toEqual([])
    expect(FORBIDDEN_MIGRATION_MARKERS.length).toBeGreaterThan(0)
  })

  test('the freshness qualification this parent depends on is recorded, not re-verified', () => {
    // The stale-cache proof belongs to the #1562 scope's own suite. This
    // inventory records that dependency instead of re-implementing it, so it
    // asserts the declaration and never the child's acceptance.
    expect(FRESHNESS_QUALIFICATION.scope).toBe('#1562')
    expect(FRESHNESS_QUALIFICATION.branch).toBe(
      'recovery/issue-1562-cloudflare-cpu-hyperdrive-qualification'
    )
    expect(FRESHNESS_QUALIFICATION.path).toBe('scripts/cloudflare-cpu-hyperdrive-qualification.ts')
    expect(FRESHNESS_QUALIFICATION.rule).toBe('authority-reads-not-cache-disabled')
  })

  test('the child scopes and the related pull requests are recorded', () => {
    expect(CHILD_SCOPES.map((scope) => scope.issue)).toEqual(['#1560', '#1561', '#1562'])
    expect(RELATED_PULL_REQUESTS.map((pull) => pull.number)).toEqual([1515, 1525])
    for (const pull of RELATED_PULL_REQUESTS) expect(pull.head.length).toBeGreaterThan(7)
  })

  test('every live acceptance stays gated', () => {
    for (const gate of GATED_ACCEPTANCE) {
      expect(['gated', 'not authorized']).toContain(gate.state)
    }
    expect(GATED_ACCEPTANCE.length).toBeGreaterThanOrEqual(4)
  })

  test('the inventory record is complete', () => {
    const record = railwayMigrationAcceptanceInventory()
    // The inventory reports what is left; it does not assert a count, because
    // the count moves with the other lanes' source work.
    expect(Array.isArray(record.neonProviderDependencies)).toBe(true)
    expect(record.forbiddenMigrationMarkers).toEqual([])
    expect(record.freshnessQualification).toEqual(FRESHNESS_QUALIFICATION)
    expect(record.childScopes.length).toBe(3)
    expect(record.relatedPullRequests.length).toBe(2)
    expect(record.gatedAcceptance.length).toBeGreaterThanOrEqual(4)
  })
})
