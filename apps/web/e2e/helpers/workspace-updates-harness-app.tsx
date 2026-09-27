import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'
import { VersionDialog } from '../../src/components/version-dialog'

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
        <VersionDialog restoreFocusRef={opener} open={open()} onOpenChange={setOpen} />
      </Show>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
