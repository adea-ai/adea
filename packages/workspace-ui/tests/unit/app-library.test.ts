import { describe, expect, test } from 'bun:test'

import {
  resolveAppActivation,
  trustedFirstPartyAppEntries,
  workspaceAppActivation,
  type TrustedFirstPartyEntry,
} from '../../src/app-library'
import { workspaceAppActivation as platformReexport } from '../../src/platform'
import type { WorkspacePlugin } from '../../src/platform'
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

const chatEntryId = 'adea.app.chat'

/** A catalog record that mirrors the compiled registry exactly. */
function verifiedFirstPartyApp(overrides: Partial<WorkspacePlugin> = {}): WorkspacePlugin {
  const entry = trustedFirstPartyAppEntries[chatEntryId] as TrustedFirstPartyEntry
  return plugin({
    id: 'plugin:adea:chat-app',
    name: 'Chat',
    surfaces: ['app'],
    installed: true,
    installationStatus: 'installed',
    sourceRevision: '9e411f31f32a1c2f30e1c54c778c6c52ccc8759c',
    canonicalContentDigest: 'sha256:aaaa',
    installationPlan: {
      planVersion: 2,
      strategy: 'component-adapter',
      compatibility: 'full',
      allowedToActivate: false,
      approvalRequired: true,
    },
    appSurface: {
      bundledEntryId: chatEntryId,
      supportedPlatforms: ['desktop', 'web'],
      capabilities: ['chat.send'],
      requestedPermissions: [],
      railContribution: 'none',
      version: '1.0.0',
      digest: entry.entryDigest,
    },
    ...overrides,
  })
}

const bundledApp = verifiedFirstPartyApp()

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

describe('the compiled trusted first-party entry registry', () => {
  test('the core views are compiled first-party entries with view bindings', () => {
    expect(Object.keys(trustedFirstPartyAppEntries)).toEqual([
      'adea.app.chat',
      'adea.app.dev',
      'adea.app.virtual',
    ])
    expect(trustedFirstPartyAppEntries['adea.app.dev']?.view).toBe('dev')
    expect(trustedFirstPartyAppEntries['adea.app.chat']?.entryDigest).toMatch(
      /^entry-v1-[0-9a-f]{16}$/
    )
  })
})

describe('app activation authority', () => {
  test('a verified first-party entry on an installed app can activate', () => {
    expect(resolveAppActivation(bundledApp)).toEqual({
      status: 'activatable',
      entryId: chatEntryId,
    })
  })

  test('a catalog-only app cannot execute interface code and says why', () => {
    expect(resolveAppActivation(catalogOnlyApp)).toEqual({
      status: 'activation-unavailable',
      reason: 'catalog-only',
    })
  })

  test('an uninstalled bundled app waits for installation', () => {
    expect(
      resolveAppActivation({ ...bundledApp, installed: false, installationStatus: 'available' })
    ).toEqual({ status: 'activation-unavailable', reason: 'not-installed' })
  })

  test('an app surface without metadata cannot activate', () => {
    expect(resolveAppActivation(plugin({ surfaces: ['app'] }))).toEqual({
      status: 'activation-unavailable',
      reason: 'catalog-only',
    })
  })

  test('a manifest-invented bundled entry id is never trusted, even when installed', () => {
    // The catalog record claims a bundled entry the compiled app does not
    // ship. Trust resolves through the compiled registry only.
    const forged = verifiedFirstPartyApp()
    forged.appSurface = { ...forged.appSurface!, bundledEntryId: 'adea.app.wallet' }
    expect(resolveAppActivation(forged)).toEqual({
      status: 'activation-unavailable',
      reason: 'untrusted-entry',
    })
    // An arbitrary non-empty id from any manifest is equally untrusted.
    const arbitrary = verifiedFirstPartyApp()
    arbitrary.appSurface = { ...arbitrary.appSurface!, bundledEntryId: 'x' }
    expect(resolveAppActivation(arbitrary).reason).toBe('untrusted-entry')
  })

  test('a missing or mismatched entry digest is an integrity failure', () => {
    const missing = verifiedFirstPartyApp()
    missing.appSurface = { ...missing.appSurface!, digest: undefined }
    expect(resolveAppActivation(missing).reason).toBe('integrity-failure')
    const mismatched = verifiedFirstPartyApp()
    mismatched.appSurface = { ...mismatched.appSurface!, digest: 'sha256-stale' }
    expect(resolveAppActivation(mismatched).reason).toBe('integrity-failure')
  })

  test('a missing or unverified install plan cannot activate', () => {
    const noPlan = verifiedFirstPartyApp({ installationPlan: undefined })
    expect(resolveAppActivation(noPlan).reason).toBe('plan-unverified')
    const activatingPlan = verifiedFirstPartyApp({
      installationPlan: {
        planVersion: 2,
        strategy: 'component-adapter',
        compatibility: 'full',
        allowedToActivate: true,
        approvalRequired: false,
      },
    })
    expect(resolveAppActivation(activatingPlan).reason).toBe('plan-unverified')
    const badStrategy = verifiedFirstPartyApp({
      installationPlan: {
        planVersion: 2,
        strategy: 'unavailable',
        compatibility: 'unsupported',
        allowedToActivate: false,
        approvalRequired: true,
      },
    })
    expect(resolveAppActivation(badStrategy).reason).toBe('plan-unverified')
  })

  test('an unversioned catalog record reads as stale', () => {
    const unversioned = verifiedFirstPartyApp({ sourceRevision: undefined })
    expect(resolveAppActivation(unversioned).reason).toBe('stale')
  })

  test('the legacy single-argument helper stays available and hard-fails forged ids', () => {
    // Re-exported through platform for existing callers.
    expect(platformReexport).toBe(workspaceAppActivation)
    expect(workspaceAppActivation(bundledApp)).toEqual({
      status: 'activatable',
      entryId: chatEntryId,
    })
    const forged = verifiedFirstPartyApp()
    forged.appSurface = { ...forged.appSurface!, bundledEntryId: 'adea.app.wallet' }
    expect(workspaceAppActivation(forged).reason).toBe('untrusted-entry')
  })
})
