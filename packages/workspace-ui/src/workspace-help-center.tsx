import {
  HelpCenter,
  type HelpLink,
  type HelpShortcut,
} from '@adea-ai/ui/components/composites/help-center'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { createMemo } from 'solid-js'

export type WorkspaceHelpCenterProps = {
  appName?: string
  onClose: () => void
  open: boolean
}

/** The modifier glyph the running OS renders for Meta: ⌘ on Apple, Ctrl elsewhere. */
function metaKeyLabel(): string {
  // The dialog is a client-only lazy boundary; the guard keeps SSR renders honest.
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl'
}

/** The keyboard shortcuts the workspace shell actually binds. */
function workspaceShortcuts(): readonly HelpShortcut[] {
  const mod = metaKeyLabel()
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
 * keyboard shortcuts plus the project's resources) hosted in the workspace
 * dialog shell, mirroring the About dialog's composition.
 */
export function WorkspaceHelpCenter(props: WorkspaceHelpCenterProps) {
  const appName = () => props.appName ?? 'Adea'
  const shortcuts = createMemo(workspaceShortcuts)
  return (
    <ModalDialog
      modal={false}
      class="conventional-dialog"
      open={props.open}
      onClose={props.onClose}
      title="Help Center"
      description={`Keyboard shortcuts and resources for ${appName()}.`}
    >
      <HelpCenter
        appName={appName()}
        shortcuts={shortcuts()}
        links={PROJECT_LINKS}
        showHeader={false}
      />
    </ModalDialog>
  )
}
