import { HelpCenter } from '@adea-ai/ui/components/composites/help-center'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import type { Accessor } from 'solid-js'
import { openAdeaExternalUrl } from '../lib/external-links'
import { workspaceHelpShortcuts } from '@adea-ai/workspace-ui/keyboard-shortcuts'

function linksFor(feedbackUrl: string) {
  return [
    {
      label: 'Documentation',
      description: 'Read Adea setup and product guides.',
      url: 'https://github.com/adea-ai/adea/tree/main/docs',
    },
    {
      label: 'Report a bug',
      description: 'Send a reproducible problem to the Adea team.',
      url: 'https://github.com/adea-ai/adea/issues/new?template=bug_report.yml',
    },
    {
      label: 'Request a feature',
      description: 'Suggest an improvement to Adea.',
      url: 'https://github.com/adea-ai/adea/issues/new?template=feature_request.yml',
    },
    {
      label: 'Send feedback',
      description: 'Share feedback about your experience with Adea.',
      url: feedbackUrl,
    },
  ]
}

export function HelpCenterDialog(props: {
  open: boolean
  onClose: () => void
  restoreFocusRef?: Accessor<HTMLElement | undefined>
  feedbackUrl: string
}) {
  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="Help resources"
      description="Keyboard shortcuts and project resources for Adea."
      restoreFocusRef={props.restoreFocusRef}
    >
      <HelpCenter
        appName="Adea"
        shortcuts={workspaceHelpShortcuts()}
        links={linksFor(props.feedbackUrl)}
        openExternal={openAdeaExternalUrl}
      />
    </ModalDialog>
  )
}
