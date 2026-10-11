import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import {
  ConventionalWorkspaceShell,
  type WorkspaceDeepLink,
} from '@adea-ai/workspace-ui/conventional-workspace-shell'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { JSX } from 'solid-js'

export function ConventionalWorkspaceEntry(props: {
  client: AgentHqApiClient
  archiveAction?: JSX.Element
  restoreFocusRef?: () => HTMLElement | undefined
  deepLink?: () => WorkspaceDeepLink
  taskBoardOnly?: boolean
  manageSettings?: boolean
  onConsumeDeepLink?: () => void
  onOpenTaskBoard?: () => void
  onViewChange: (view: WorkspaceView) => void
  services: WorkspacePlatformServices
}) {
  return (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <ConventionalWorkspaceShell
        taskBoardOnly={props.taskBoardOnly}
        archiveAction={props.archiveAction}
        restoreFocusRef={props.restoreFocusRef}
        deepLink={props.deepLink}
        manageSettings={props.manageSettings ?? true}
        onConsumeDeepLink={props.onConsumeDeepLink}
        onOpenTaskBoard={props.onOpenTaskBoard}
        onViewChange={props.onViewChange}
        view="chat"
        services={{ ...props.services, client: props.client }}
      />
    </TooltipProvider>
  )
}
