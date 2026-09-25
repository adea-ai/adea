import type { AgentHqApiClient } from '@adea-ai/api-client'
import { browserStorage, readPersisted, writePersisted } from '@adea-ai/state'

import {
  categoryLabel,
  canonicalDigest,
  installationResponseState,
  loadRegistryArtifacts,
  mapRegistryCatalog,
  MarketplaceCatalogError,
  type VerifiedRegistryCatalog,
  loadBrowsingCatalog,
} from './marketplace-catalog'
import type {
  WorkspacePlugin,
  WorkspacePluginCategory,
  WorkspacePluginDefinition,
  WorkspacePluginsProvider,
  WorkspacePluginsProviderState,
} from './platform'

export const workspacePluginCategoryOrder = Object.freeze([
  'Productivity',
  'Communication',
  'Developer Tools',
  'Data & Analytics',
  'Business & Operations',
  'Finance',
  'Creativity',
  'Education & Research',
  'Scientific Research',
  'Security',
] satisfies readonly WorkspacePluginCategory[])

const popularNames = [
  'gmail',
  'github',
  'google-drive',
  'google-calendar',
  'notion',
  'slack',
] as const
export const popularWorkspacePluginIds = Object.freeze(
  popularNames.map((name) => `plugin:openai-official:${name}`)
)

export type WorkspacePluginFilter = Readonly<{
  ownership: 'all' | WorkspacePlugin['ownership']
  type: 'all' | 'apps' | 'connectors' | 'skills'
}>

export const defaultPluginFilter: WorkspacePluginFilter = Object.freeze({
  ownership: 'all',
  type: 'all',
})

export type RegistryPluginsProviderOptions = Readonly<{
  client: AgentHqApiClient | (() => AgentHqApiClient)
  getWorkspaceId: () => string | undefined
  getUserId: () => string | undefined
  requestedHarness?: string
}>

const PLUGIN_CACHE_STORAGE_KEY = 'adea:plugin-catalog-cache:v1'
// The verified catalog itself is global (identical for every workspace), so
// the primary snapshot persists under a workspace-independent key: guest
// workspaces are ephemeral (a new id on every bootstrap) and would otherwise
// never hit any workspace-keyed cache.
const GLOBAL_CATALOG_CACHE_KEY = 'adea:plugin-catalog-global:v1'
const PLUGIN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PLUGIN_REFRESH_INTERVAL_MS = 15 * 60 * 1000

type PersistedPluginCache = Readonly<{
  catalogId: string
  cachedAt: number
  plugins: readonly WorkspacePlugin[]
}>

type PersistedGlobalCatalog = Readonly<{
  catalogId: string
  cachedAt: number
  plugins: readonly WorkspacePlugin[]
}>

function isCatalogSnapshot(entry: unknown): entry is PersistedGlobalCatalog {
  if (entry === null || typeof entry !== 'object') return false
  const candidate = entry as PersistedGlobalCatalog
  return (
    typeof candidate.catalogId === 'string' &&
    Array.isArray(candidate.plugins) &&
    typeof candidate.cachedAt === 'number' &&
    Date.now() - candidate.cachedAt <= PLUGIN_CACHE_MAX_AGE_MS
  )
}

function readPersistedGlobalCatalog(): PersistedGlobalCatalog | undefined {
  // Through the persistence boundary (#302): an expired or malformed entry is
  // stale (dropped, no quarantine), while unparseable text is corruption and
  // is preserved for diagnostics.
  return readPersisted(browserStorage(), GLOBAL_CATALOG_CACHE_KEY, (parsed) =>
    isCatalogSnapshot(parsed) ? parsed : undefined
  ).value
}

function writePersistedGlobalCatalog(entry: PersistedGlobalCatalog): void {
  writePersisted(browserStorage(), GLOBAL_CATALOG_CACHE_KEY, entry)
}

function readPersistedPlugins(workspaceId: string): PersistedPluginCache | undefined {
  // Same boundary, same rules: this workspace's entry must still be fresh.
  return readPersisted(browserStorage(), PLUGIN_CACHE_STORAGE_KEY, (parsed) => {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const entry = (parsed as Record<string, unknown>)[workspaceId]
    return isCatalogSnapshot(entry) ? entry : undefined
  }).value
}

function writePersistedPlugins(workspaceId: string, entry: PersistedPluginCache): void {
  // Read-modify-write over the per-workspace map: other workspaces' entries
  // survive, and the read goes through the same boundary so unparseable text
  // is quarantined rather than overwritten.
  const current = readPersisted(browserStorage(), PLUGIN_CACHE_STORAGE_KEY, (parsed) =>
    parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      ? undefined
      : (parsed as Record<string, PersistedPluginCache>)
  ).value
  writePersisted(browserStorage(), PLUGIN_CACHE_STORAGE_KEY, {
    ...current,
    [workspaceId]: entry,
  })
}

export function createRegistryPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let cache: VerifiedRegistryCatalog | undefined
  let cacheWorkspaceId: string | undefined
  let state: WorkspacePluginsProviderState = 'idle'
  const apiClient = () => (typeof options.client === 'function' ? options.client() : options.client)

  let lastFetchAt = 0

  const refresh = async (): Promise<VerifiedRegistryCatalog> => {
    const workspaceId = options.getWorkspaceId()
    if (!workspaceId) {
      state = 'unavailable'
      throw new MarketplaceCatalogError('unavailable', 'A workspace is required to load plugins')
    }
    const verified = await loadRegistryArtifacts(apiClient(), workspaceId)
    // Browsing reads the published index when the release provides one, which is
    // a few hundred kilobytes against tens of megabytes. Every failure path falls
    // back to the catalog, so this cannot break rendering.
    const fresh: VerifiedRegistryCatalog = {
      ...verified,
      browsingCatalog: await loadBrowsingCatalog(verified),
    }
    cache = fresh
    cacheWorkspaceId = workspaceId
    lastFetchAt = Date.now()
    state = fresh.state === 'stale' ? 'stale' : 'ready'
    writePersistedPlugins(workspaceId, {
      catalogId: fresh.catalog.catalogId,
      cachedAt: lastFetchAt,
      plugins: mapRegistryCatalog(
        fresh.browsingCatalog ?? fresh.catalog,
        fresh.installations,
        fresh.brandMarks
      ),
    })
    writePersistedGlobalCatalog({
      catalogId: fresh.catalog.catalogId,
      cachedAt: lastFetchAt,
      plugins: mapRegistryCatalog(
        fresh.browsingCatalog ?? fresh.catalog,
        fresh.installations,
        fresh.brandMarks
      ),
    })
    return fresh
  }

  const list = async (): Promise<readonly WorkspacePlugin[]> => {
    const workspaceId = options.getWorkspaceId()
    if (!workspaceId) {
      state = 'unavailable'
      throw new MarketplaceCatalogError('unavailable', 'A workspace is required to load plugins')
    }
    if (cacheWorkspaceId !== workspaceId) {
      cache = undefined
      cacheWorkspaceId = workspaceId
    }
    // The global snapshot renders the browser almost immediately — before the
    // workspace-scoped cache is even consulted — because guest workspaces are
    // ephemeral and change id on every bootstrap. A single background refresh
    // keeps it current for subsequent loads.
    if (!cache) {
      const global = readPersistedGlobalCatalog()
      if (global) {
        state = 'ready'
        void refresh().catch(() => undefined)
        return global.plugins
      }
    }
    // A persisted snapshot renders the browser almost immediately; a single
    // background refresh keeps it current for subsequent loads.
    if (!cache) {
      const persisted = readPersistedPlugins(workspaceId)
      if (persisted) {
        state = 'ready'
        void refresh().catch(() => undefined)
        return persisted.plugins
      }
    } else if (Date.now() - lastFetchAt > PLUGIN_REFRESH_INTERVAL_MS) {
      void refresh().catch(() => undefined)
    }
    state = 'loading'
    try {
      const fresh = await refresh()
      return mapRegistryCatalog(
        fresh.browsingCatalog ?? fresh.catalog,
        fresh.installations,
        fresh.brandMarks
      )
    } catch (error) {
      if (error instanceof MarketplaceCatalogError && error.state === 'verification-failure') {
        state = 'verification-failure'
        throw error
      }
      if (cache) {
        state = 'stale'
        return mapRegistryCatalog(cache.catalog, cache.installations)
      }
      state = error instanceof MarketplaceCatalogError ? error.state : 'unavailable'
      throw error
    }
  }

  const requestInstall = async (pluginId: string): Promise<readonly WorkspacePlugin[]> => {
    const workspaceId = options.getWorkspaceId()
    const userId = options.getUserId()
    if (!workspaceId || !userId) {
      state = 'unavailable'
      throw new MarketplaceCatalogError(
        'unavailable',
        'A workspace and user identity are required to enable a plugin'
      )
    }
    // Installs need the verified artifacts, not just the mapped plugin list.
    if (!cache) await refresh()
    if (!cache)
      throw new MarketplaceCatalogError('unavailable', 'The plugin catalog is unavailable')
    if (cache.state !== 'ready') {
      state = 'stale'
      throw new MarketplaceCatalogError(
        'stale',
        'The marketplace snapshot is stale; refresh before enabling a plugin'
      )
    }
    const plugin = cache.catalog.plugins.find((candidate) => candidate.pluginId === pluginId)
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`)
    const release = plugin.availableReleases.find(
      (candidate) => candidate.releaseId === plugin.currentReleaseId
    )
    if (!release)
      throw new MarketplaceCatalogError(
        'verification-failure',
        `Current release is missing: ${pluginId}`
      )
    const requestedHarness = options.requestedHarness ?? 'codex'
    if (
      release.contentResolution === 'metadata-only' ||
      release.agentPlugins?.status === 'unavailable'
    ) {
      state = 'unavailable'
      throw new MarketplaceCatalogError(
        'unavailable',
        release.contentResolution === 'metadata-only'
          ? 'This plugin is source metadata only and cannot be enabled'
          : 'This plugin has no portable Agent Plugins components for this catalog release'
      )
    }
    const installationInstanceDigest = await canonicalDigest({
      pluginId,
      userId,
      workspaceId,
    })
    const installationInstanceId = `marketplace:${installationInstanceDigest.slice('sha256:'.length)}`
    let installationPlan: WorkspacePluginDefinition['installationPlan']
    if (release.agentPlugins) {
      const plan = await apiClient().requestMarketplaceInstallPlan(workspaceId, {
        instanceId: installationInstanceId,
        pluginId,
        releaseId: release.releaseId,
        requestedHarness,
        workspaceIdentity: { userId, workspaceId },
      })
      if (
        plan.planVersion !== 2 ||
        plan.pluginId !== pluginId ||
        plan.releaseId !== release.releaseId ||
        plan.instanceId !== installationInstanceId ||
        plan.allowedToActivate !== false ||
        plan.approvalRequired !== true
      ) {
        state = 'verification-failure'
        throw new MarketplaceCatalogError(
          'verification-failure',
          'Control Plane returned an invalid or mismatched installation plan'
        )
      }
      installationPlan = {
        allowedToActivate: false,
        approvalRequired: true,
        compatibility: plan.compatibility,
        planVersion: 2,
        strategy: plan.strategy,
      }
    }
    const idempotencyDigest = await canonicalDigest({
      canonicalContentDigest: release.canonicalContentDigest,
      installationInstanceId,
      pluginId,
      releaseId: release.releaseId,
      requestedHarness,
      userId,
      workspaceId,
    })
    const response = await apiClient().requestMarketplaceInstall(workspaceId, {
      pluginId,
      releaseId: release.releaseId,
      canonicalContentDigest: release.canonicalContentDigest,
      requestedHarness,
      installationInstanceId,
      workspaceIdentity: { userId, workspaceId },
      idempotencyKey: `marketplace:${idempotencyDigest.slice('sha256:'.length)}`,
    })
    const installations = cache.installations.filter((candidate) => candidate.pluginId !== pluginId)
    cache = {
      ...cache,
      installations: [
        ...installations,
        {
          pluginId,
          releaseId: response.releaseId,
          canonicalContentDigest: response.canonicalContentDigest,
          ...(response.installationInstanceId
            ? { installationInstanceId: response.installationInstanceId }
            : {}),
          ...(response.packageDigest ? { packageDigest: response.packageDigest } : {}),
          state: installationResponseState(response),
        },
      ],
    }
    const mapped = mapRegistryCatalog(cache.catalog, cache.installations)
    return mapped.map((candidate) =>
      candidate.id === pluginId && installationPlan ? { ...candidate, installationPlan } : candidate
    )
  }

  return {
    getState: () => state,
    list,
    requestInstall,
  }
}

const isAppSurface = (plugin: WorkspacePlugin): boolean => plugin.surfaces.includes('app')

export function filterWorkspacePlugins(
  plugins: readonly WorkspacePlugin[],
  tab: 'marketplace' | 'yours',
  query: string,
  filter: WorkspacePluginFilter = defaultPluginFilter
): WorkspacePlugin[] {
  const needle = query.trim().toLocaleLowerCase()
  return plugins.filter(
    (plugin) =>
      (tab === 'marketplace' || plugin.installed) &&
      (filter.type === 'all' ||
        (filter.type === 'apps' && isAppSurface(plugin)) ||
        (filter.type === 'connectors' && plugin.kind === 'connector') ||
        (filter.type === 'skills' && plugin.kind === 'skill')) &&
      (filter.ownership === 'all' || plugin.ownership === filter.ownership) &&
      (needle.length === 0 ||
        `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.kind} ${plugin.category} ${plugin.capabilities.join(
          ' '
        )} ${plugin.surfaces.join(' ')} ${plugin.keywords?.join(' ') ?? ''}`
          .toLocaleLowerCase()
          .includes(needle))
  )
}

/**
 * Counts per category in canonical order, omitting empty categories — the
 * App Library rail's data (KiroCrew `categoryCounts` composition over the
 * verified Adea catalog).
 */
export function appCategoryCounts(
  plugins: readonly WorkspacePlugin[]
): readonly { category: WorkspacePluginCategory; count: number }[] {
  return groupWorkspacePlugins(plugins).map((group) => ({
    category: group.category,
    count: group.plugins.length,
  }))
}

export function groupWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  const preferred = new Map<string, number>(
    workspacePluginCategoryOrder.map((category, index) => [category, index])
  )
  const names = [...new Set(plugins.map((plugin) => plugin.category))].toSorted(
    (left, right) =>
      (preferred.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (preferred.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
  )
  return names.flatMap((category) => {
    const items = plugins.filter((plugin) => plugin.category === category)
    return items.length > 0 ? [{ category, plugins: items }] : []
  })
}

export function getPopularWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  return popularWorkspacePluginIds.flatMap((id) => {
    const plugin = byId.get(id)
    return plugin ? [plugin] : []
  })
}

export { categoryLabel }
export type { WorkspacePluginDefinition }
