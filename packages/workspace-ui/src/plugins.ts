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
  navigationCatalogIndexUrl,
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
  /**
   * The browsing index the release advertised, when it advertised one. Kept so
   * the next refresh can ask the smallest published artifact whether anything
   * was published at all instead of re-reading tens of megabytes to find out.
   */
  catalogIndexUrl?: string
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

/**
 * The catalog identity the published index reports, when it answers at all.
 *
 * A catalog release is immutable and a new one only ever appears under a new
 * `catalogId`, so the index — a megabyte or so, served CORS-clean from the
 * repository — is enough to answer "was anything published since this snapshot
 * was taken?". Nothing here is trusted beyond that comparison: a wrong or
 * hostile answer can only cause a refresh to be skipped, never bad data to be
 * rendered, because the snapshot it keeps was verified when it was written.
 */
async function probePublishedCatalogId(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const parsed: unknown = JSON.parse(await response.text())
    if (parsed === null || typeof parsed !== 'object') return undefined
    const catalogId = (parsed as { catalogId?: unknown }).catalogId
    return typeof catalogId === 'string' ? catalogId : undefined
  } catch {
    return undefined
  }
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
    // A verified catalog is already in hand: ask the published index whether
    // anything was published since, and skip the tens-of-megabytes read when the
    // answer is no. The read itself cannot return anything new — releases are
    // immutable per catalogId — so this only removes work, never freshness.
    if (cache) {
      const known = readPersistedGlobalCatalog()
      const indexUrl = known?.catalogIndexUrl
      if (
        known !== undefined &&
        indexUrl !== undefined &&
        known.catalogId === cache.catalog.catalogId &&
        (await probePublishedCatalogId(indexUrl)) === cache.catalog.catalogId
      ) {
        lastFetchAt = Date.now()
        return cache
      }
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
    const catalogIndexUrl = navigationCatalogIndexUrl(fresh.artifacts['categories.v1.json'])
    writePersistedPlugins(workspaceId, {
      catalogId: fresh.catalog.catalogId,
      cachedAt: lastFetchAt,
      plugins: mapRegistryCatalog(
        fresh.browsingCatalog ?? fresh.catalog,
        fresh.installations,
        fresh.brandMarks
      ),
      ...(catalogIndexUrl === undefined ? {} : { catalogIndexUrl }),
    })
    writePersistedGlobalCatalog({
      catalogId: fresh.catalog.catalogId,
      cachedAt: lastFetchAt,
      plugins: mapRegistryCatalog(
        fresh.browsingCatalog ?? fresh.catalog,
        fresh.installations,
        fresh.brandMarks
      ),
      ...(catalogIndexUrl === undefined ? {} : { catalogIndexUrl }),
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
      // The cached catalog renders immediately and the refresh it schedules is
      // the only read this call may cause: falling through to the awaited
      // refresh below would read the catalog twice on every stale call.
      void refresh().catch(() => undefined)
      state = cache.state === 'stale' ? 'stale' : 'ready'
      return mapRegistryCatalog(
        cache.browsingCatalog ?? cache.catalog,
        cache.installations,
        cache.brandMarks
      )
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
        // Carry the persisted brand marks, as `refresh()` does. Omitting them
        // here meant a plugin that had its mirrored vendor icon on a fresh read
        // lost it as soon as the cache served a read, silently falling back to
        // a third-party favicon service.
        return mapRegistryCatalog(cache.catalog, cache.installations, cache.brandMarks)
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
    // Same omission as the stale-cache read: a post-install refresh dropped the
    // brand marks it had just been displaying.
    const mapped = mapRegistryCatalog(cache.catalog, cache.installations, cache.brandMarks)
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

/**
 * The lowercase text a plugin is matched against, computed once per plugin
 * object.
 *
 * `filterWorkspacePlugins` runs on every keystroke of the App Library search, and
 * the previous shape built a nine-field template string and lowercased it for
 * every plugin on every call. The catalog is hundreds to thousands of plugins,
 * so that was the dominant cost of typing a query. Keyed by identity, so a
 * plugin whose text never changes is stringified once for the session.
 */
const searchHaystacks = new WeakMap<WorkspacePlugin, string>()

function searchHaystack(plugin: WorkspacePlugin): string {
  const cached = searchHaystacks.get(plugin)
  if (cached !== undefined) return cached
  const haystack = `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.kind} ${
    plugin.category
  } ${plugin.capabilities.join(' ')} ${plugin.surfaces.join(' ')} ${
    plugin.keywords?.join(' ') ?? ''
  }`.toLocaleLowerCase()
  searchHaystacks.set(plugin, haystack)
  return haystack
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
        (filter.type === 'apps' && isAppSurface(plugin)) ||
        (filter.type === 'connectors' && plugin.kind === 'connector') ||
        (filter.type === 'skills' && plugin.kind === 'skill')) &&
      (filter.ownership === 'all' || plugin.ownership === filter.ownership) &&
      (needle.length === 0 || searchHaystack(plugin).includes(needle))
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
  // One pass into buckets, rather than a `filter` per category: the previous
  // shape was O(categories x plugins) and this runs for the App Library rail's
  // counts on every catalog change.
  const buckets = new Map<string, WorkspacePlugin[]>()
  for (const plugin of plugins) {
    const bucket = buckets.get(plugin.category)
    if (bucket) bucket.push(plugin)
    else buckets.set(plugin.category, [plugin])
  }
  return [...buckets.keys()]
    .toSorted(
      (left, right) =>
        (preferred.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (preferred.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
    )
    .map((category) => ({ category, plugins: buckets.get(category)! }))
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
