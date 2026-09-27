import { UpdateDialog } from '@adea-ai/ui/components/composites/update-dialog'

import { createUpdateDialogAdapter } from '../internal/version-dialog-adapter'
import type { VersionDialogAdapter } from '../internal/version-dialog-adapter'

export type { SharedDesktopUpdate, VersionDialogAdapter } from '../internal/version-dialog-adapter'

export function VersionDialog(props: {
  adapter: VersionDialogAdapter
  fallbackVersion?: string
  onOpenChange?: (open: boolean) => void
  open?: boolean
}) {
  const adapter = createUpdateDialogAdapter(() => props.adapter)

  return (
    <UpdateDialog
      adapter={adapter}
      appName="Adea"
      fallbackVersion={props.fallbackVersion}
      onOpenChange={props.onOpenChange}
      open={props.open}
    />
  )
}
