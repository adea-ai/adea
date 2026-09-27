import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'
import { VersionDialog } from '../../../../packages/ui/src/components/version-dialog'
import type { SharedDesktopUpdate } from '../../../../packages/ui/src/internal/version-dialog-adapter'

const state: SharedDesktopUpdate = {
  available_version: null,
  changelog: '',
  current_version: '0.62.1',
  downloaded_bytes: 0,
  error: null,
  github_url: '',
  phase: 'current',
  release_date: null,
  release_notes: null,
  restart_required: false,
  total_bytes: null,
}
const adapter = {
  getStatus: async () => state,
  check: async () => state,
  install: async () => state,
  isDesktopRuntime: () => true,
}
function Harness() {
  const [open, setOpen] = createSignal(false)
  const [updatesEnabled, setUpdatesEnabled] = createSignal(true)
  const [opener, setOpener] = createSignal<HTMLButtonElement>()
  return (
    <>
      <output id="updates-opener">{opener()?.getAttribute('aria-label') ?? 'missing'}</output>
      <button onClick={() => setUpdatesEnabled(false)}>Disable updates handoff</button>
      <AccountMenu
        authenticated
        platform="desktop"
        onOpenAbout={() => undefined}
        onOpenSettings={() => undefined}
        onOpenUpdates={
          updatesEnabled()
            ? (trigger) => {
                setOpener(trigger)
                setOpen(true)
              }
            : undefined
        }
        onSignIn={() => undefined}
        onSignOut={() => undefined}
      />
      <Show when={open()}>
        <VersionDialog
          adapter={adapter}
          restoreFocusRef={opener}
          open={open()}
          onOpenChange={setOpen}
        />
      </Show>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
