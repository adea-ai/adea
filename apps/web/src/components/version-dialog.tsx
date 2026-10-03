import type { Accessor } from 'solid-js'
import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from '@adea-ai/app-ui/components/version-dialog'
import { noteUpdatePhase } from '@adea-ai/workspace-ui/update-pending'

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
  onOpenChange?: (open: boolean) => void
  open?: boolean
  restoreFocusRef?: Accessor<HTMLElement | undefined>
}) {
  return (
    <SharedVersionDialog
      adapter={desktopUpdateAdapter}
      appIcon="/icon.svg"
      fallbackVersion={packageVersion}
      onOpenChange={props.onOpenChange}
      open={props.open}
      restoreFocusRef={props.restoreFocusRef}
    />
  )
}
