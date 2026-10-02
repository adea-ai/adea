import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'
import { VersionDialog } from '../../src/components/version-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'

/**
 * A controllable stand-in for the shell's update family. The version dialog's
 * adapter is the only update-checker; answering its invocations here exercises
 * the real mirror into the shared update-pending state, so the badge tests
 * below cover the whole chain rather than a hand-set signal.
 */
const updaterState = { phase: 'current' as string }

function updateSnapshot() {
  const available = updaterState.phase === 'available'
  return {
    current_version: '1.0.0',
    available_version: available ? '9.9.9' : null,
    release_date: null,
    release_notes: null,
    changelog: '',
    github_url: 'https://github.com/adea-ai/adea/releases',
    phase: updaterState.phase,
    downloaded_bytes: 0,
    total_bytes: null,
    error: null,
    restart_required: false,
  }
}

;(window as unknown as { __adeaDesktop?: unknown }).__adeaDesktop = {
  invoke: async (command: string) => {
    if (command === 'adea_app_version') return '1.0.0'
    if (command === 'desktop_update_status' || command === 'desktop_update_check') {
      return updateSnapshot()
    }
    return undefined
  },
  listen: async () => () => undefined,
}

function Harness() {
  const [open, setOpen] = createSignal(false)
  const [updatesEnabled, setUpdatesEnabled] = createSignal(true)
  const [opener, setOpener] = createSignal<HTMLButtonElement>()
  return (
    <>
      <output id="updates-opener">{opener()?.getAttribute('aria-label') ?? 'missing'}</output>
      <Button onClick={() => setUpdatesEnabled(false)}>Disable updates handoff</Button>
      <Button onClick={() => (updaterState.phase = 'available')}>Make update available</Button>
      <Button onClick={() => (updaterState.phase = 'current')}>Make update current</Button>
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
          onOpenHelp={() => undefined}
          onOpenSettings={() => undefined}
          onOpenUpdates={
            updatesEnabled()
              ? (trigger) => {
                  setOpener(trigger)
                  setOpen(true)
                }
              : undefined
          }
          onOpenFeedback={() => undefined}
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
