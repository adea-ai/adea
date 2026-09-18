import type { Scope } from '@adea-ai/types/dev-runtime'

/**
 * Pure selection resolution for the Dev shell. The UI never trusts a stored or
 * deep-linked ID: a project/session selection must resolve inside the active
 * scope's projection, and an archived, stale, or cross-project ID recovers
 * visibly instead of pairing a selection with the wrong project's resources.
 */
export type DevSelectionInput = Readonly<{
  scope?: Scope
  projects: readonly Readonly<{
    id: string
    sessions: readonly Readonly<{ id: string; archived: boolean }>[]
  }>[]
  requestedProjectId?: string | null
  requestedSessionId?: string | null
}>

export type DevSelection =
  | Readonly<{ status: 'resolved'; projectId: string; runtimeSessionId: string }>
  | Readonly<{
      status: 'recovered'
      projectId: string
      runtimeSessionId: string
      reason: 'project_missing' | 'session_missing' | 'session_archived' | 'project_empty'
    }>
  | Readonly<{ status: 'empty' }>

export function resolveDevSelection(input: DevSelectionInput): DevSelection {
  const projects = input.projects
  if (projects.length === 0) return { status: 'empty' }
  const requestedProject = input.requestedProjectId
    ? projects.find((project) => project.id === input.requestedProjectId)
    : undefined
  if (input.requestedProjectId && !requestedProject) {
    const fallback = projects[0]!
    const session = firstLiveSession(fallback)
    return {
      status: 'recovered',
      projectId: fallback.id,
      runtimeSessionId: session?.id ?? '',
      reason: 'project_missing',
    }
  }
  const project = requestedProject ?? projects[0]!
  const requestedSession = input.requestedSessionId
    ? project.sessions.find((session) => session.id === input.requestedSessionId)
    : undefined
  if (requestedSession && !requestedSession.archived)
    return {
      status: 'resolved',
      projectId: project.id,
      runtimeSessionId: requestedSession.id,
    }
  const live = firstLiveSession(project)
  if (!live)
    return {
      status: 'recovered',
      projectId: project.id,
      runtimeSessionId: '',
      reason: 'project_empty',
    }
  if (requestedSession && requestedSession.archived)
    return {
      status: 'recovered',
      projectId: project.id,
      runtimeSessionId: live.id,
      reason: 'session_archived',
    }
  return {
    status: 'recovered',
    projectId: project.id,
    runtimeSessionId: live.id,
    reason: 'session_missing',
  }
}

function firstLiveSession(
  project: DevSelectionInput['projects'][number]
): { id: string; archived: boolean } | undefined {
  return project.sessions.find((session) => !session.archived)
}
