'use client'

import { Button } from '@adea-ai/ui/components/ui/button'
import { WorkspaceLogo } from '@adea-ai/ui/components/workspace-logo'
import { ExternalLink } from 'lucide-solid'
import { createEffect, createSignal, onCleanup } from 'solid-js'

import { ModalDialog } from './modal-dialog'

export function WorkspaceAboutDialog(props: {
  appName?: string
  onClose: () => void
  open: boolean
  platform?: 'desktop' | 'web'
  version?: string
}) {
  const appName = () => props.appName ?? 'Adea'
  const platform = () => props.platform ?? 'web'
  const [copied, setCopied] = createSignal(false)

  createEffect(() => {
    if (!copied()) return
    const timeout = window.setTimeout(() => setCopied(false), 1400)
    onCleanup(() => window.clearTimeout(timeout))
  })

  const copyVersionInfo = async () => {
    const info = [
      appName(),
      props.version ? `Version ${props.version}` : 'Version unavailable',
      `Platform: ${platform()}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(info)
      setCopied(true)
    } catch {
      // Clipboard access is optional; leave the dialog usable when unavailable.
    }
  }

  return (
    <ModalDialog
      class="conventional-about-dialog"
      open={props.open}
      onClose={props.onClose}
      title="About Adea"
      description="A calm, connected home for your agents, rooms, and conversations."
    >
      <div class="conventional-about-dialog__body">
        <div class="conventional-about-dialog__identity">
          <div class="conventional-about-dialog__brand" aria-label="Adea" role="img">
            <WorkspaceLogo aria-hidden="true" role="presentation" />
          </div>
          <h3>{appName()}</h3>
          <p>{props.version ? `Version ${props.version}` : 'Version unavailable'}</p>
          <small>Copyright © 2026 0xPlayerOne</small>
        </div>
        <footer class="conventional-about-dialog__footer">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyVersionInfo()}>
            {copied() ? 'Copied' : 'Copy version info'}
          </Button>
          <a href="https://github.com/adea-ai/adea" target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            View source
          </a>
        </footer>
      </div>
    </ModalDialog>
  )
}
