import type { Accessor } from 'solid-js'
import { createEffect, createSignal, Show } from 'solid-js'
import { UpdateChannelControl } from '@adea-ai/ui/components/composites/update-dialog'
import type {
  VersionDialogAdapter,
  VersionDialogChannelActions,
} from '@adea-ai/app-ui/components/version-dialog'
import { noteUpdatePhase } from '@adea-ai/workspace-ui/update-pending'
import type { UpdatesService } from '@adea-ai/workspace-ui/platform'
import lazyComponent from './lazy-component'

import {
  checkDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate,
  isDesktopRuntime,
  type DesktopUpdate,
} from '../lib/desktop-update'
import { withSyntheticDownloadProgress } from '../lib/desktop-update-progress'
import packageJson from '../../package.json'

const packageVersion = packageJson.version

const SharedVersionDialog = lazyComponent(() =>
  import('@adea-ai/app-ui/components/version-dialog').then((module) => module.VersionDialog)
)

/**
 * Mirror every updater answer into the shared update-pending state the rail
 * and the account menu read for their dot badge. The version dialog owns the
 * only update-checker; mirroring here keeps exactly one source of truth and
 * never issues a second check on its own.
 */
function noteUpdatePending(update: DesktopUpdate): void {
  noteUpdatePhase(update.phase)
}

function mirrorUpdatePending(adapter: VersionDialogAdapter): VersionDialogAdapter {
  return {
    ...adapter,
    check: async () => {
      const update = await adapter.check()
      noteUpdatePending(update)
      return update
    },
    getStatus: async () => {
      const update = await adapter.getStatus()
      noteUpdatePending(update)
      return update
    },
    install: async (expectedVersion) => {
      const update = await adapter.install(expectedVersion)
      noteUpdatePending(update)
      return update
    },
  }
}

const desktopUpdateAdapter: VersionDialogAdapter = mirrorUpdatePending({
  ...withSyntheticDownloadProgress({
    check: checkDesktopUpdate,
    getStatus: getDesktopUpdateStatus,
    install: installDesktopUpdate,
  }),
  isDesktopRuntime,
  // The dialog polls status during a native install; without a poll interval
  // it never learns about progress between install start and end.
  pollIntervalMs: 400,
})

export function VersionDialog(props: {
  channelService?: UpdatesService
  onOpenChange?: (open: boolean) => void
  open?: boolean
  restoreFocusRef?: Accessor<HTMLElement | undefined>
}) {
  // Keep the native status/badge probe owned by DesktopWorkspaceEntry. Load
  // the visual updater only once the user opens it, then keep that same
  // mounted component across closes so reopen state and focus behavior match
  // the eagerly-mounted dialog.
  const [hasOpened, setHasOpened] = createSignal(props.open ?? false)
  createEffect(() => {
    if (props.open) setHasOpened(true)
  })

  const channelService = props.channelService
  // The dialog stays mounted after its first open, so reloadOn re-reads the
  // stored channel whenever it reopens — the channel can move outside the
  // dialog (a CLI writing the same setting) while it sits closed.
  const channelControl = channelService
    ? (actions: VersionDialogChannelActions) => (
        <UpdateChannelControl
          controls={actions}
          read={() => channelService.channel()}
          persist={(value) => channelService.setChannel(value)}
          reloadOn={() => props.open}
        />
      )
    : undefined

  return (
    <Show when={hasOpened()}>
      <SharedVersionDialog
        adapter={desktopUpdateAdapter}
        appIcon="/icon.svg"
        channelControl={channelControl}
        fallbackVersion={packageVersion}
        onOpenChange={props.onOpenChange}
        open={props.open}
        restoreFocusRef={props.restoreFocusRef}
      />
    </Show>
  )
}
