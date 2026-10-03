import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
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
    sourceUrl:
      'https://example.com/catalog/published/workspace-tools/0123456789abcdef0123456789abcdef',
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
const [open, setOpen] = createSignal(true)
let deferInstall = false
let rejectInstall: (() => void) | undefined
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
    if (deferInstall) {
      deferInstall = false
      return new Promise<readonly WorkspacePlugin[]>((_resolve, reject) => {
        rejectInstall = () => reject(new Error('synthetic deferred install refusal'))
      })
    }
    throw new Error('synthetic install refusal')
  },
  getState: () => 'ready',
}

window.pluginsCatalogHarness = {
  installCalls: () => [...installCalls],
  reopen: () => setOpen(true),
  deferNextInstall: () => {
    deferInstall = true
  },
  rejectPendingInstall: () => {
    rejectInstall?.()
    rejectInstall = undefined
  },
}
render(
  () => (
    <PluginsDialog
      open={open()}
      onClose={() => setOpen(false)}
      provider={provider}
      navigation={navigation}
    />
  ),
  document.querySelector('#harness-root')!
)

declare global {
  interface Window {
    pluginsCatalogHarness: {
      installCalls(): string[]
      reopen(): void
      deferNextInstall(): void
      rejectPendingInstall(): void
    }
  }
}
