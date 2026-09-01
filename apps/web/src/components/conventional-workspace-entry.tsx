'use client'

import { ConventionalWorkspaceShell } from '@agent-hq/workspace-ui/conventional-workspace-shell'
import type { WorkspacePlatformServices } from '@agent-hq/workspace-ui/platform'
import type { WorkspaceView } from '@agent-hq/workspace-ui/workspace-view-toggle'
import type { AgentHqApiClient } from '@agent-hq/api-client'

export function ConventionalWorkspaceEntry({
  client,
  onViewChange,
  services,
}: Readonly<{
  client: AgentHqApiClient
  onViewChange: (view: WorkspaceView) => void
  services: WorkspacePlatformServices
}>) {
  return (
    <ConventionalWorkspaceShell
      onViewChange={onViewChange}
      view="chat"
      services={{ ...services, client }}
    />
  )
}
