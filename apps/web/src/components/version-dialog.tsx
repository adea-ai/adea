'use client'

import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from '@adea-ai/ui/components/version-dialog'

import {
  checkDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate,
  isDesktopRuntime,
} from '../lib/desktop-update'
import packageJson from '../../package.json'

const packageVersion = packageJson.version

const desktopUpdateAdapter: VersionDialogAdapter = {
  check: checkDesktopUpdate,
  getStatus: getDesktopUpdateStatus,
  install: installDesktopUpdate,
  isDesktopRuntime,
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
