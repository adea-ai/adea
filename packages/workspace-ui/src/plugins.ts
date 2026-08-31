import type { WorkspacePlugin, WorkspacePluginsProvider } from './platform'

const defaultPluginCatalog = Object.freeze([
  {
    description: 'Bring repository context, pull requests, and issues into Agent workflows.',
    id: 'github',
    kind: 'connector',
    name: 'GitHub',
    publisher: 'Agent HQ',
  },
  {
    description: 'Connect project issues and planning context to Rooms and Tasks.',
    id: 'linear',
    kind: 'connector',
    name: 'Linear',
    publisher: 'Agent HQ',
  },
  {
    description: 'Let Agents read schedules and coordinate workspace events.',
    id: 'google-calendar',
    kind: 'connector',
    name: 'Google Calendar',
    publisher: 'Agent HQ',
  },
  {
    description: 'Create concise Room summaries from durable conversation history.',
    id: 'room-summaries',
    kind: 'skill',
    name: 'Room Summaries',
    publisher: 'Agent HQ',
  },
] satisfies readonly Omit<WorkspacePlugin, 'installed'>[])

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
  query: string
): WorkspacePlugin[] {
  const needle = query.trim().toLocaleLowerCase()
  return plugins.filter(
    (plugin) =>
      (tab === 'marketplace' || plugin.installed) &&
      (needle.length === 0 ||
        `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.kind}`
          .toLocaleLowerCase()
          .includes(needle))
  )
}
