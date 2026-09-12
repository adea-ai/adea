import type { AgentHqApiClient } from '@adea-ai/api-client'

import {
  categoryLabel,
  canonicalDigest,
  installationResponseState,
  loadRegistryArtifacts,
  mapRegistryCatalog,
  MarketplaceCatalogError,
  type VerifiedRegistryCatalog,
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
  type: 'all' | 'connectors' | 'skills'
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
const PLUGIN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PLUGIN_REFRESH_INTERVAL_MS = 60_000

type PersistedPluginCache = Readonly<{
  catalogId: string
  cachedAt: number
  plugins: readonly WorkspacePlugin[]
}>

function readPersistedPlugins(
  workspaceId: string
): PersistedPluginCache | undefined {
  try {
    const raw = window.localStorage.getItem(PLUGIN_CACHE_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Record<string, PersistedPluginCache>
    const entry = parsed[workspaceId]
    if (
      !entry ||
      typeof entry.catalogId !== 'string' ||
      !Array.isArray(entry.plugins) ||
      typeof entry.cachedAt !== 'number' ||
      Date.now() - entry.cachedAt > PLUGIN_CACHE_MAX_AGE_MS
    ) {
      return undefined
    }
    return entry
  } catch {
    return undefined
  }
}

function writePersistedPlugins(workspaceId: string, entry: PersistedPluginCache): void {
  try {
    const raw = window.localStorage.getItem(PLUGIN_CACHE_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, PersistedPluginCache>) : {}
    parsed[workspaceId] = entry
    window.localStorage.setItem(PLUGIN_CACHE_STORAGE_KEY, JSON.stringify(parsed))
  } catch {
    // Persistence is best-effort: private modes and full quotas simply skip it.
  }
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
    const fresh = await loadRegistryArtifacts(apiClient(), workspaceId)
    cache = fresh
    cacheWorkspaceId = workspaceId
    lastFetchAt = Date.now()
    state = fresh.state === 'stale' ? 'stale' : 'ready'
    writePersistedPlugins(workspaceId, {
      catalogId: fresh.catalog.catalogId,
      cachedAt: lastFetchAt,
      plugins: mapRegistryCatalog(fresh.catalog, fresh.installations),
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
      return mapRegistryCatalog(fresh.catalog, fresh.installations)
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

export function groupWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  const preferred = new Map<string, number>(
    workspacePluginCategoryOrder.map((category, index) => [category, index])
  )
  const names = [...new Set(plugins.map((plugin) => plugin.category))].sort(
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
