'use client'

import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from '@agent-hq/ui/components/version-dialog'

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

export function VersionDialog() {
  return <SharedVersionDialog adapter={desktopUpdateAdapter} fallbackVersion={packageVersion} />
}
