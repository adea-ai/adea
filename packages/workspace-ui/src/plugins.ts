import { codexPluginCatalog } from './codex-plugin-marketplace.generated'
import type {
  WorkspacePlugin,
  WorkspacePluginCategory,
  WorkspacePluginDefinition,
  WorkspacePluginsProvider,
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

// Codex's remote discovery catalog currently leads with these providers. Keep the
// list explicit so a catalog refresh cannot silently reshuffle Agent HQ's UI.
export const popularWorkspacePluginIds = Object.freeze([
  'gmail',
  'github',
  'google-drive',
  'google-calendar',
  'notion',
  'slack',
] as const)

export type WorkspacePluginFilter = Readonly<{
  ownership: 'all' | WorkspacePlugin['ownership']
  type: 'all' | 'connectors' | 'skills'
}>

export const defaultPluginFilter: WorkspacePluginFilter = Object.freeze({
  ownership: 'all',
  type: 'all',
})

const agentHqPluginCatalog = Object.freeze([
  {
    auth: 'workspace',
    authenticationPolicy: 'on-use',
    capabilities: ['Summarize Rooms', 'Capture decisions', 'List follow-ups'],
    category: 'Productivity',
    description: 'Create concise Room summaries from durable conversation history.',
    iconKey: 'room-summaries',
    id: 'room-summaries',
    installationPolicy: 'available',
    kind: 'skill',
    name: 'Room Summaries',
    ownership: 'public',
    publisher: 'Agent HQ',
    source: 'agent-hq',
    surfaces: ['skill'],
  },
] satisfies readonly WorkspacePluginDefinition[])

const defaultPluginCatalog = Object.freeze([...codexPluginCatalog, ...agentHqPluginCatalog])
const STORAGE_KEY = 'agent-hq:workspace-plugins:v1'

function installedIds(storage: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    )
  } catch {
    return new Set()
  }
}

export function createBrowserPluginsProvider(
  storage?: Pick<Storage, 'getItem' | 'setItem'>
): WorkspacePluginsProvider {
  const resolveStorage = () => storage ?? window.localStorage
  const list = () => {
    const installed = installedIds(resolveStorage())
    return defaultPluginCatalog.map((plugin) => ({
      ...plugin,
      installed: installed.has(plugin.id),
    }))
  }

  return {
    list: async () => list(),
    setInstalled: async (pluginId, nextInstalled) => {
      if (!defaultPluginCatalog.some(({ id }) => id === pluginId)) throw new Error('Unknown plugin')
      const installed = installedIds(resolveStorage())
      if (nextInstalled) installed.add(pluginId)
      else installed.delete(pluginId)
      resolveStorage().setItem(STORAGE_KEY, JSON.stringify([...installed].sort()))
      return list()
    },
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
        `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.kind} ${plugin.category} ${plugin.capabilities.join(' ')} ${plugin.surfaces.join(' ')}`
          .toLocaleLowerCase()
          .includes(needle))
  )
}

export function groupWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  return workspacePluginCategoryOrder.flatMap((category) => {
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
