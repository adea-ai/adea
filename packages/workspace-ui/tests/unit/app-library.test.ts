import { describe, expect, test } from 'bun:test'

import { workspaceAppActivation, type WorkspacePlugin } from '../../src/platform'
import { appCategoryCounts, defaultPluginFilter, filterWorkspacePlugins } from '../../src/plugins'

function plugin(overrides: Partial<WorkspacePlugin>): WorkspacePlugin {
  return {
    auth: 'workspace',
    category: 'Productivity',
    capabilities: [],
    description: 'A catalog entry',
    iconKey: 'missing',
    id: 'plugin:test:entry',
    kind: 'connector',
    name: 'Entry',
    ownership: 'public',
    publisher: 'Adea',
    source: 'catalog',
    surfaces: ['mcp'],
    installed: false,
    installationStatus: 'available',
    ...overrides,
  }
}

const bundledApp = plugin({
  id: 'plugin:adea:roadmap',
  name: 'Roadmap',
  surfaces: ['app'],
  installed: true,
  installationStatus: 'installed',
  appSurface: {
    bundledEntryId: 'adea.app.roadmap',
    supportedPlatforms: ['desktop', 'web'],
    capabilities: ['board.view'],
    requestedPermissions: [],
    railContribution: 'optional',
    version: '1.0.0',
    digest: 'sha256-abc',
  },
})

const catalogOnlyApp = plugin({
  id: 'plugin:third-party:board',
  name: 'Third-party board',
  surfaces: ['app'],
  installed: true,
  installationStatus: 'installed',
  appSurface: {
    supportedPlatforms: ['desktop'],
    capabilities: [],
    requestedPermissions: ['notifications'],
    railContribution: 'none',
  },
})

describe('app library filters', () => {
  test('the apps filter selects app-surfaced entries only', () => {
    const catalog = [
      bundledApp,
      catalogOnlyApp,
      plugin({ id: 'plugin:test:skill', kind: 'skill', surfaces: ['skill'] }),
    ]
    const apps = filterWorkspacePlugins(catalog, 'marketplace', '', {
      ...defaultPluginFilter,
      type: 'apps',
    })
    expect(apps.map((entry) => entry.id)).toEqual([bundledApp.id, catalogOnlyApp.id])
    expect(
      filterWorkspacePlugins(catalog, 'marketplace', '', {
        ...defaultPluginFilter,
        type: 'connectors',
      }).map((entry) => entry.id)
    ).toEqual([bundledApp.id, catalogOnlyApp.id])
    expect(
      filterWorkspacePlugins(catalog, 'marketplace', '', {
        ...defaultPluginFilter,
        type: 'skills',
      }).map((entry) => entry.id)
    ).toEqual(['plugin:test:skill'])
  })

  test('category counts follow the canonical order and omit empty categories', () => {
    const counts = appCategoryCounts([
      plugin({ id: 'a', category: 'Developer Tools' }),
      plugin({ id: 'b', category: 'Developer Tools' }),
      plugin({ id: 'c', category: 'Finance' }),
    ])
    expect(counts).toEqual([
      { category: 'Developer Tools', count: 2 },
      { category: 'Finance', count: 1 },
    ])
  })
})

describe('app activation authority', () => {
  test('a bundled first-party entry on an installed app can activate', () => {
    expect(workspaceAppActivation(bundledApp)).toEqual({
      status: 'activatable',
      entryId: 'adea.app.roadmap',
    })
  })

  test('a catalog-only app cannot execute interface code and says why', () => {
    expect(workspaceAppActivation(catalogOnlyApp)).toEqual({
      status: 'activation-unavailable',
      reason: 'catalog-only',
    })
  })

  test('an uninstalled bundled app waits for installation', () => {
    expect(
      workspaceAppActivation({ ...bundledApp, installed: false, installationStatus: 'available' })
    ).toEqual({ status: 'activation-unavailable', reason: 'not-installed' })
  })

  test('an app surface without metadata cannot activate', () => {
    expect(workspaceAppActivation(plugin({ surfaces: ['app'] }))).toEqual({
      status: 'activation-unavailable',
      reason: 'catalog-only',
    })
  })
})
