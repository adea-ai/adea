'use client'

import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { ConventionalWorkspaceShell } from '@adea-ai/workspace-ui/conventional-workspace-shell'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import type { AgentHqApiClient } from '@adea-ai/api-client'

export function ConventionalWorkspaceEntry({
  client,
  manageSettings = true,
  onViewChange,
  services,
}: Readonly<{
  client: AgentHqApiClient
  manageSettings?: boolean
  onViewChange: (view: WorkspaceView) => void
  services: WorkspacePlatformServices
}>) {
  return (
    <TooltipProvider>
      <ConventionalWorkspaceShell
        manageSettings={manageSettings}
        onViewChange={onViewChange}
        view="chat"
        services={{ ...services, client }}
      />
    </TooltipProvider>
  )
}
