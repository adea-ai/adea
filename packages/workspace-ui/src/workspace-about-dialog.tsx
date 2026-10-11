import { AboutDialog } from '@adea-ai/ui/components/composites/about-dialog'
import type { Accessor } from 'solid-js'

export function WorkspaceAboutDialog(props: {
  appName?: string
  appIcon: string
  onClose: () => void
  openExternal?: (url: string) => Promise<void>
  open: boolean
  platform?: 'desktop' | 'web'
  restoreFocusRef?: Accessor<HTMLElement | undefined>
  version?: string
}) {
  return (
    <AboutDialog
      appName={props.appName ?? 'Adea'}
      appIcon={props.appIcon}
      copyright="Copyright © 2026 0xPlayerOne"
      sourceUrl="https://github.com/adea-ai/adea"
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      platform={props.platform ?? 'web'}
      version={props.version}
      openExternal={props.openExternal}
      restoreFocusRef={props.restoreFocusRef}
    />
  )
}
