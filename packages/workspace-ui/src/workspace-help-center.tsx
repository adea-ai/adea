import {
  HelpCenter,
  type HelpLink,
  type HelpShortcut,
} from '@adea-ai/ui/components/composites/help-center'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@adea-ai/ui/components/ui/dialog'
import { createMemo } from 'solid-js'

import { platformModifierKey } from './keyboard-shortcuts'

export type WorkspaceHelpCenterProps = {
  appName?: string
  /** Hands project links to the system browser on desktop shells. */
  openExternal?: (url: string) => Promise<void>
  onClose: () => void
  open: boolean
}

/** The keyboard shortcuts the workspace shell actually binds. */
function workspaceShortcuts(): readonly HelpShortcut[] {
  const mod = platformModifierKey()
  return [
    { label: 'Open workspace search', keys: [mod, 'K'] },
    { label: 'Search the conversation', keys: [mod, 'F'] },
    { label: 'Mark everything as read', keys: [mod, '⇧', 'A'] },
    { label: 'Mark the channel unread', keys: [mod, '⇧', 'U'] },
    { label: 'Focus the composer', keys: [mod, '⇧', 'M'] },
    { label: 'Move between channels', keys: ['Alt', '↑/↓'] },
    { label: 'Close panels and dialogs', keys: ['Esc'] },
  ]
}

const PROJECT_LINKS: readonly HelpLink[] = [
  {
    label: 'GitHub project',
    description: 'Source, releases, and issues.',
    url: 'https://github.com/adea-ai/adea',
  },
  {
    label: 'Documentation',
    description: 'Architecture decisions and product guides.',
    url: 'https://github.com/adea-ai/adea/tree/main/docs',
  },
  {
    label: 'Release notes',
    description: 'What changed in every shipped version.',
    url: 'https://github.com/adea-ai/adea/releases',
  },
]

/**
 * The account menu's Help Center destination: the shared help page (real
 * keyboard shortcuts plus the project's resources) in a compact dialog sized
 * to its cards — not the tall settings shell.
 */
export function WorkspaceHelpCenter(props: WorkspaceHelpCenterProps) {
  const appName = () => props.appName ?? 'Adea'
  const shortcuts = createMemo(workspaceShortcuts)
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose()
      }}
    >
      <DialogContent
        class="max-w-md"
        aria-label="Help Center"
        onKeyDown={(event: KeyboardEvent) => {
          // Link help tooltips cannot trap Escape in this popup.
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            props.onClose()
          }
        }}
      >
        <div class="flex flex-col gap-1">
          <DialogTitle>Help Center</DialogTitle>
          <DialogDescription>Keyboard shortcuts and resources for {appName()}.</DialogDescription>
        </div>
        <HelpCenter
          appName={appName()}
          shortcuts={shortcuts()}
          links={PROJECT_LINKS}
          showHeader={false}
          openExternal={props.openExternal}
        />
      </DialogContent>
    </Dialog>
  )
}
