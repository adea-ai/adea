'use client'

import {
  ConventionalWorkspaceShell,
  createBrowserSettingsProvider,
  type WorkspaceView,
} from '@agent-hq/workspace-ui'
import { useState } from 'react'

export function ConventionalWorkspaceEntry({
  onViewChange,
}: Readonly<{ onViewChange: (view: WorkspaceView) => void }>) {
  const [settings] = useState(() => createBrowserSettingsProvider())
  return (
    <ConventionalWorkspaceShell
      onViewChange={onViewChange}
      view="chat"
      services={{
        account: {
          onSignIn: () => window.location.assign('/auth/sign-in?returnTo=%2F'),
          onSignOut: async () => {
            const { createNeonClientAdapter } = await import('@agent-hq/auth/client')
            await createNeonClientAdapter().signOut()
            window.location.assign('/')
          },
        },
        app: { name: 'Agent HQ Web', platform: 'web' },
        settings,
      }}
    />
  )
}
