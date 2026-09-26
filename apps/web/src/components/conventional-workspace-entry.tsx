import { TooltipProvider } from '@adea-ai/app-ui/components/ui/tooltip'
import {
  ConventionalWorkspaceShell,
  type WorkspaceDeepLink,
} from '@adea-ai/workspace-ui/conventional-workspace-shell'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import type { AgentHqApiClient } from '@adea-ai/api-client'

export function ConventionalWorkspaceEntry(props: {
  client: AgentHqApiClient
  deepLink?: () => WorkspaceDeepLink
  manageSettings?: boolean
  onConsumeDeepLink?: () => void
  onViewChange: (view: WorkspaceView) => void
  services: WorkspacePlatformServices
}) {
  return (
    <TooltipProvider>
      <ConventionalWorkspaceShell
        deepLink={props.deepLink}
        manageSettings={props.manageSettings ?? true}
        onConsumeDeepLink={props.onConsumeDeepLink}
        onViewChange={props.onViewChange}
        view="chat"
        services={{ ...props.services, client: props.client }}
      />
    </TooltipProvider>
  )
}
