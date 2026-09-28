import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { PluginsDialog } from '@adea-ai/workspace-ui/plugins-dialog'
import type { WorkspacePlugin, WorkspacePluginsProvider } from '@adea-ai/workspace-ui/platform'

let complete!: (items: readonly WorkspacePlugin[]) => void
const pending = new Promise<readonly WorkspacePlugin[]>((resolve) => {
  complete = resolve
})
const provider: WorkspacePluginsProvider = {
  list: () => pending,
  requestInstall: async () => [],
}
window.pluginsLoadingHarness = { complete: () => complete([]) }
render(
  () => <PluginsDialog open onClose={() => {}} provider={provider} />,
  document.querySelector('#harness-root')!
)

declare global {
  interface Window {
    pluginsLoadingHarness: { complete(): void }
  }
}
