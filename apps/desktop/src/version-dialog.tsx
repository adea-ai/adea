import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from '@adea-ai/ui/components/version-dialog'

import { checkDesktopUpdate, getDesktopUpdateStatus, installDesktopUpdate } from './desktop-update'
import packageJson from '../package.json'

const packageVersion = packageJson.version

const desktopUpdateAdapter: VersionDialogAdapter = {
  check: checkDesktopUpdate,
  getStatus: getDesktopUpdateStatus,
  install: installDesktopUpdate,
  isDesktopRuntime: () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
}

export function VersionDialog({
  onOpenChange,
  open,
}: Readonly<{ onOpenChange?: (open: boolean) => void; open?: boolean }> = {}) {
  return (
    <SharedVersionDialog
      adapter={desktopUpdateAdapter}
      fallbackVersion={packageVersion}
      onOpenChange={onOpenChange}
      open={open}
    />
  )
}
