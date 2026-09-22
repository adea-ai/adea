import type { AgentSummary } from '@adea-ai/types'
import type { FirstRunFacts, FirstRunLaunchContext } from '@adea-ai/dev-view/chat'
import type { DevWorkspaceProjection } from '@adea-ai/dev-view/platform'

export type DesktopFirstRunWorktree = Readonly<{
  id: string
  projectId?: string
  repoId?: string
  lifecycle: string
  archived: boolean
}>

export type DesktopFirstRunResolution = Readonly<{
  facts: FirstRunFacts
  context?: FirstRunLaunchContext
}>

type ResolutionInput = Readonly<{
  temporary: boolean
  managedPi: FirstRunFacts['managedPi']
  projection: DevWorkspaceProjection
  worktrees: readonly DesktopFirstRunWorktree[]
  agents: readonly AgentSummary[]
}>

/**
 * Projects the desktop's independent authorities into onboarding facts. Every
 * launch field comes from a canonical runtime or workspace record; an absent
 * project, worktree, or AgentProfile stays absent.
 *
 * Model entitlement is intentionally unresolved here. The current desktop API
 * exposes identity and workspace agents, while Control Plane model access has
 * no client-facing projection yet (#552). Signed-in users therefore remain at
 * the explicit model-access gate until that authority is available.
 */
export function resolveDesktopFirstRun(input: ResolutionInput): DesktopFirstRunResolution {
  const projects = input.projection.groups.flatMap((group) => group.projects)
  const project = projects.find((candidate) => candidate.repository.length > 0)
  const worktree = project
    ? input.worktrees.find(
        (candidate) =>
          !candidate.archived &&
          candidate.lifecycle === 'ready' &&
          candidate.projectId === project.id &&
          candidate.repoId === project.repository
      )
    : undefined
  const projectReady = project !== undefined && worktree !== undefined
  const agent = input.agents.find(
    (candidate) =>
      candidate.lifecycleState === 'active' &&
      candidate.profile.state === 'available' &&
      /^[1-9]\d*$/.test(candidate.profile.version) &&
      Number.isSafeInteger(Number(candidate.profile.version))
  )
  const agentProfileReady = agent !== undefined
  const context =
    projectReady && agent
      ? {
          projectId: project.id,
          repoId: project.repository,
          worktreeId: worktree.id,
          agentProfileId: agent.profile.id,
          agentProfileVersion: Number(agent.profile.version),
        }
      : undefined

  return {
    facts: {
      identity: input.temporary ? 'guest' : 'signed_in',
      managedPi: input.managedPi,
      modelAccess: input.temporary ? 'none' : 'unknown',
      projectReady,
      agentProfileReady,
    },
    ...(context ? { context } : {}),
  }
}
