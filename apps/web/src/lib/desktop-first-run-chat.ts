import type { AgentSummary } from '@adea-ai/types'
import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
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
  /** Outcome of signed-in lead provisioning; absent for guests. */
  lead?: FirstRunLeadOutcome['status']
  managedPi: FirstRunFacts['managedPi']
  projection: DevWorkspaceProjection
  worktrees: readonly DesktopFirstRunWorktree[]
  agents: readonly AgentSummary[]
}>

export type FirstRunLeadOutcome = Readonly<{
  /** `failed` and `auth_required` never carry a lead; both are reported, never inferred. */
  status: 'present' | 'provisioned' | 'failed' | 'auth_required'
  agents: readonly AgentSummary[]
}>

/**
 * Structural lead provisioning for signed-in Home setup. The server owns the
 * permission check and the one-lead invariant; this only fills the gap when the
 * workspace has no lead yet. Provisioning never makes the lead ready: its
 * profile stays unconfigured, so `resolveDesktopFirstRun` keeps agent setup
 * blocked. An expired session (401) is reported as `auth_required`; any other
 * refusal, transport failure, or empty result is `failed` and leaves the roster
 * unchanged rather than inventing a lead.
 */
export async function ensureFirstRunLead(
  client: Pick<AgentHqApiClient, 'ensureWorkspaceLead'>,
  workspaceId: string,
  agents: readonly AgentSummary[]
): Promise<FirstRunLeadOutcome> {
  if (agents.some((agent) => agent.isWorkspaceLead)) return { status: 'present', agents }
  try {
    const { lead } = await client.ensureWorkspaceLead(workspaceId)
    if (!lead?.isWorkspaceLead) return { status: 'failed', agents }
    return {
      status: 'provisioned',
      agents: [...agents.filter((agent) => agent.id !== lead.id), lead],
    }
  } catch (error) {
    return {
      status: error instanceof ApiClientError && error.status === 401 ? 'auth_required' : 'failed',
      agents,
    }
  }
}

/**
 * Projects the desktop's independent authorities into onboarding facts. Every
 * launch field comes from a canonical runtime or workspace record; an absent
 * project, worktree, or AgentProfile stays absent.
 *
 * Model access is the user's own harness under BYOK — the default path — so
 * both guests and signed-in owners project `byok` and traverse onboarding
 * identically. A CP-provisioned entitlement (#552's future client-facing
 * projection) is additive when it arrives: it may grant cloud models, but it
 * never gates the conversation, and identity never gates it either.
 */
export function resolveDesktopFirstRun(input: ResolutionInput): DesktopFirstRunResolution {
  const project = input.projection.projects.find((candidate) => candidate.repoIds.length > 0)
  const repoId = project?.repoIds[0]
  const worktree = project
    ? input.worktrees.find(
        (candidate) =>
          !candidate.archived &&
          candidate.lifecycle === 'ready' &&
          candidate.projectId === project.id &&
          candidate.repoId === repoId
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
          repoId: repoId!,
          worktreeId: worktree.id,
          agentProfileId: agent.profile.id,
          agentProfileVersion: Number(agent.profile.version),
        }
      : undefined

  return {
    facts: {
      identity: input.temporary
        ? 'guest'
        : input.lead === 'auth_required'
          ? 'auth_required'
          : 'signed_in',
      managedPi: input.managedPi,
      modelAccess: 'byok',
      projectReady,
      agentProfileReady,
      ...(input.lead === 'failed' ? { leadProvisioning: 'failed' as const } : {}),
    },
    ...(context ? { context } : {}),
  }
}
