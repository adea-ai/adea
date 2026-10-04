import '../../src/start/globals.css'
import { createSignal, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'
import { VersionDialog } from '../../src/components/version-dialog'
import { getDesktopUpdateStatus } from '../../src/lib/desktop-update'
import { Button } from '@adea-ai/ui/components/ui/button'
import { noteUpdatePhase } from '@adea-ai/workspace-ui/update-pending'
import type { UpdateChannelSetting } from '@adea-ai/workspace-ui/platform'

/**
 * A controllable stand-in for the shell's update family. The version dialog's
 * adapter is the only update-checker; answering its invocations here exercises
 * the real mirror into the shared update-pending state, so the badge tests
 * below cover the whole chain rather than a hand-set signal. The install stays
 * in flight (phase `downloading`, zero bytes — the real shell answers exactly
 * this way for its fast downloads) until the harness settles it.
 */
const updaterState = {
  phase:
    new URLSearchParams(window.location.search).get('initial') === 'available'
      ? 'available'
      : 'current',
  channel: 'stable' as UpdateChannelSetting,
  channelCheckMode: false,
  releaseInstall: undefined as (() => void) | undefined,
}
let statusReads = 0

const channelService = {
  async channel() {
    return updaterState.channel
  },
  async setChannel(channel: UpdateChannelSetting) {
    updaterState.channel = channel
    return channel
  },
}

function updateSnapshot() {
  const available = updaterState.phase === 'available'
  return {
    current_version: '1.0.0',
    available_version: available
      ? updaterState.channel === 'dev'
        ? '9.9.9-dev.17'
        : '9.9.9'
      : null,
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
    if (command === 'desktop_update_status') {
      statusReads += 1
      return updateSnapshot()
    }
    if (command === 'desktop_update_check') {
      if (updaterState.channelCheckMode) {
        updaterState.phase = updaterState.channel === 'pre-release' ? 'current' : 'available'
      }
      return updateSnapshot()
    }
    if (command === 'desktop_update_install') {
      updaterState.phase = 'downloading'
      return new Promise((resolve) => {
        updaterState.releaseInstall = () => {
          updaterState.phase = 'installed'
          resolve({
            ...updateSnapshot(),
            restart_required: true,
          })
        }
      })
    }
    return undefined
  },
  listen: async () => () => undefined,
}

// The modal update dialog blocks pointer events to the harness buttons, so
// the spec settles an in-flight install through this hook instead (the same
// route the shared dialog's own fixture uses).
;(window as unknown as { updatesHarness?: unknown }).updatesHarness = {
  statusReads() {
    return statusReads
  },
  settleInstall() {
    const release = updaterState.releaseInstall
    updaterState.releaseInstall = undefined
    release?.()
  },
}

function Harness() {
  const [open, setOpen] = createSignal(false)
  const [updatesEnabled, setUpdatesEnabled] = createSignal(true)
  const [opener, setOpener] = createSignal<HTMLButtonElement>()
  // Mirror DesktopWorkspaceEntry's one native boot probe. The dialog is now
  // mounted closed before its visual module is loaded, so this fixture keeps
  // the existing update-pending badge contract explicit.
  onMount(() => {
    void getDesktopUpdateStatus()
      .then((snapshot) => noteUpdatePhase(snapshot.phase))
      .catch(() => noteUpdatePhase(undefined))
  })
  return (
    <>
      <output id="updates-opener">{opener()?.getAttribute('aria-label') ?? 'missing'}</output>
      <Button onClick={() => setUpdatesEnabled(false)}>Disable updates handoff</Button>
      <Button onClick={() => (updaterState.phase = 'available')}>Make update available</Button>
      <Button onClick={() => (updaterState.phase = 'current')}>Make update current</Button>
      <Button onClick={() => (updaterState.channelCheckMode = true)}>
        Enable channel update fixtures
      </Button>
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
      <VersionDialog
        channelService={channelService}
        restoreFocusRef={opener}
        open={open()}
        onOpenChange={setOpen}
      />
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
