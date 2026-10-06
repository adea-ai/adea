import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { ProjectSummary } from '@adea-ai/types'
import { createSignal, lazy, Show, Suspense } from 'solid-js'

// The dialog and the data hooks it pulls in load only when Share is chosen.
const ProjectShareDialog = lazy(() =>
  import('./project-share-dialog').then((module) => ({ default: module.ProjectShareDialog }))
)

/** Where a Share dialog reads and writes: the host's API client and workspace. */
export type ProjectShareContext = Readonly<{
  client: AgentHqApiClient
  currentUserId?: string
  workspaceId: string
}>

/**
 * Open/close state for the project Share dialog. Any surface with a project
 * row (the conventional sidebar today, the shared sidebar next) calls
 * `open(project)` and renders one `ProjectShareHost`.
 */
export function createProjectShare() {
  const [project, setProject] = createSignal<ProjectSummary | null>(null)
  return Object.freeze({
    close: () => setProject(null),
    open: (next: ProjectSummary) => setProject(next),
    project,
  })
}

export type ProjectShare = ReturnType<typeof createProjectShare>

export function ProjectShareHost(
  props: Readonly<{ context: ProjectShareContext; share: ProjectShare }>
) {
  return (
    <Suspense fallback={null}>
      <Show when={props.share.project()}>
        {(project) => (
          <ProjectShareDialog
            client={props.context.client}
            currentUserId={props.context.currentUserId}
            onClose={props.share.close}
            open
            project={project()}
            workspaceId={props.context.workspaceId}
          />
        )}
      </Show>
    </Suspense>
  )
}
