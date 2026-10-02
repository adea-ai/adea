import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'
import { VersionDialog } from '../../src/components/version-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'

function Harness() {
  const [open, setOpen] = createSignal(false)
  const [updatesEnabled, setUpdatesEnabled] = createSignal(true)
  const [opener, setOpener] = createSignal<HTMLButtonElement>()
  return (
    <>
      <output id="updates-opener">{opener()?.getAttribute('aria-label') ?? 'missing'}</output>
      <Button onClick={() => setUpdatesEnabled(false)}>Disable updates handoff</Button>
      {/* The rail footer is what the real shell gives this trigger: a narrow
          column with the row pushed down. Right-end placement needs that
          context — against a full-viewport-width anchor the menu flips
          off-screen instead of opening beside the icon. */}
      <div class="w-14">
        <div class="h-96" />
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
      </div>
      <Show when={open()}>
        <VersionDialog restoreFocusRef={opener} open={open()} onOpenChange={setOpen} />
      </Show>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
