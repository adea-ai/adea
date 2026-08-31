import { ExternalLink, ShieldCheck } from 'lucide-react'

import { ModalDialog } from './modal-dialog'

export function WorkspaceAboutDialog({
  appName = 'Agent HQ',
  onClose,
  open,
  platform = 'web',
  version,
}: Readonly<{
  appName?: string
  onClose: () => void
  open: boolean
  platform?: 'desktop' | 'web'
  version?: string
}>) {
  return (
    <ModalDialog
      className="conventional-about-dialog"
      open={open}
      onClose={onClose}
      title="About Agent HQ"
      description="A calm, connected home for your agents, rooms, and conversations."
    >
      <div className="conventional-about-dialog__body">
        <div className="conventional-about-dialog__brand" aria-hidden="true">
          <span>AH</span>
        </div>
        <div>
          <h3>{appName}</h3>
          <p>
            {platform === 'desktop' ? 'Desktop application' : 'Web application'}
            {version ? ` · v${version}` : ''}
          </p>
        </div>
        <div className="conventional-about-dialog__status" role="status">
          <ShieldCheck aria-hidden="true" />
          <span>Workspace state is synchronized through Agent HQ services.</span>
        </div>
        <a href="https://github.com/0xPlayerOne/agent-hq" target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" />
          View source
        </a>
      </div>
    </ModalDialog>
  )
}
