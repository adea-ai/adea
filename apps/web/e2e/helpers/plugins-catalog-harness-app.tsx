import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { PluginsDialog } from '@adea-ai/workspace-ui/plugins-dialog'
import type { AppLibraryNavigation } from '@adea-ai/workspace-ui/plugins-dialog'
import type { WorkspacePlugin, WorkspacePluginsProvider } from '@adea-ai/workspace-ui/platform'

function plugin(overrides: Partial<WorkspacePlugin>): WorkspacePlugin {
  return {
    auth: 'workspace',
    category: 'Productivity',
    capabilities: ['Manage fixture records'],
    description: 'Synthetic catalog entry for browser verification.',
    iconKey: 'missing',
    id: 'plugin:catalog-fixture:entry',
    kind: 'connector',
    name: 'Catalog fixture',
    ownership: 'public',
    publisher: 'Synthetic fixture',
    source: 'catalog-fixture',
    surfaces: ['mcp'],
    installed: false,
    installationStatus: 'available',
    ...overrides,
  }
}

const entries = [
  ...Array.from({ length: 7 }, (_, index) =>
    plugin({
      id: `plugin:catalog-fixture:sample-${index + 1}`,
      name: `Sample ${index + 1}`,
    })
  ),
  plugin({
    id: 'plugin:catalog-fixture:catalog-only-app',
    name: 'Catalog-only app',
    category: 'Developer Tools',
    surfaces: ['app'],
    installed: true,
    installationStatus: 'installed',
    appSurface: {
      supportedPlatforms: ['web'],
      capabilities: [],
      requestedPermissions: ['notifications'],
      railContribution: 'none',
    },
  }),
]

const installCalls: string[] = []
const navigation: AppLibraryNavigation = {
  items: [{ id: 'chat', label: 'Chat', kind: 'core-view' }],
  activeItemId: 'chat',
  preferences: { version: 1, order: ['chat'], hidden: [] },
  onReorder: () => undefined,
  onSetHidden: () => undefined,
  onReset: () => undefined,
}
const provider: WorkspacePluginsProvider = {
  list: async () => entries,
  requestInstall: async (pluginId) => {
    installCalls.push(pluginId)
    throw new Error('synthetic install refusal')
  },
  getState: () => 'ready',
}

window.pluginsCatalogHarness = { installCalls: () => [...installCalls] }
render(
  () => <PluginsDialog open onClose={() => {}} provider={provider} navigation={navigation} />,
  document.querySelector('#harness-root')!
)

declare global {
  interface Window {
    pluginsCatalogHarness: { installCalls(): string[] }
  }
}
