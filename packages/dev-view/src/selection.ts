import type { Scope } from '@adea-ai/types/dev-runtime'

/**
 * Pure selection resolution for the Dev shell. The UI never trusts a stored or
 * deep-linked ID: a project/session selection must resolve inside the active
 * scope's projection, and an archived, revoked, stale-generation, cross-scope,
 * or cross-project ID recovers visibly instead of pairing a selection with the
 * wrong project's resources.
 */
export type DevSelectionInput = Readonly<{
  scope?: Scope
  projects: readonly Readonly<{
    id: string
    sessions: readonly Readonly<{ id: string; archived: boolean; generation?: number }>[]
  }>[]
  requestedProjectId?: string | null
  requestedSessionId?: string | null
  /** The scope a stored/deep-linked selection was created in, when known. */
  requestedScope?: Scope | null
  /** The session generation the selection was bound to, when known. */
  requestedGeneration?: number | null
  /** Sessions the runtime has explicitly revoked. */
  revokedRuntimeSessionIds?: readonly string[]
  /** Projection freshness: an observation older than this is rendered stale. */
  observedAt?: string | null
  staleAfterMs?: number
  now?: string
}>

export type DevSelectionReason =
  | 'project_missing'
  | 'session_missing'
  | 'session_archived'
  | 'session_revoked'
  | 'stale_generation'
  | 'cross_scope'
  | 'project_empty'

export type DevSelection =
  | Readonly<{ status: 'resolved'; projectId: string; runtimeSessionId: string; stale?: boolean }>
  | Readonly<{
      status: 'recovered'
      projectId: string
      runtimeSessionId: string
      reason: DevSelectionReason
      stale?: boolean
    }>
  | Readonly<{ status: 'empty' }>

export function resolveDevSelection(input: DevSelectionInput): DevSelection {
  const projects = input.projects
  if (projects.length === 0) return { status: 'empty' }
  // Freshness is reported only when the provider supplied an observation and a
  // window; otherwise results carry no `stale` field at all.
  const freshnessEvaluated = input.observedAt != null && input.staleAfterMs !== undefined
  const stale = freshnessEvaluated ? isStale(input) : false
  const decorate = (result: DevSelection & { status: 'resolved' | 'recovered' }): DevSelection =>
    freshnessEvaluated ? { ...result, stale } : result
  // A selection minted in another account/workspace/node is never honored: it
  // recovers to the active scope's first live session.
  if (input.requestedScope && input.scope && !sameScope(input.requestedScope, input.scope)) {
    const fallback = projects[0]!
    const session = firstLiveSession(fallback, input.revokedRuntimeSessionIds)
    return decorate({
      status: 'recovered',
      projectId: fallback.id,
      runtimeSessionId: session?.id ?? '',
      reason: 'cross_scope',
    })
  }
  const requestedProject = input.requestedProjectId
    ? projects.find((project) => project.id === input.requestedProjectId)
    : undefined
  if (input.requestedProjectId && !requestedProject) {
    const fallback = projects[0]!
    const session = firstLiveSession(fallback, input.revokedRuntimeSessionIds)
    return decorate({
      status: 'recovered',
      projectId: fallback.id,
      runtimeSessionId: session?.id ?? '',
      reason: 'project_missing',
    })
  }
  const project = requestedProject ?? projects[0]!
  const revoked = input.revokedRuntimeSessionIds ?? []
  const requestedSession = input.requestedSessionId
    ? project.sessions.find((session) => session.id === input.requestedSessionId)
    : undefined
  if (requestedSession && !requestedSession.archived && !revoked.includes(requestedSession.id)) {
    if (
      input.requestedGeneration !== undefined &&
      input.requestedGeneration !== null &&
      requestedSession.generation !== undefined &&
      requestedSession.generation !== input.requestedGeneration
    ) {
      // The stored authority is one ownership epoch behind; do not pair it.
      return decorate({
        status: 'recovered',
        projectId: project.id,
        runtimeSessionId: requestedSession.id,
        reason: 'stale_generation',
      })
    }
    return decorate({
      status: 'resolved',
      projectId: project.id,
      runtimeSessionId: requestedSession.id,
    })
  }
  const live = firstLiveSession(project, input.revokedRuntimeSessionIds)
  if (!live)
    return decorate({
      status: 'recovered',
      projectId: project.id,
      runtimeSessionId: '',
      reason: 'project_empty',
    })
  if (requestedSession && revoked.includes(requestedSession.id))
    return decorate({
      status: 'recovered',
      projectId: project.id,
      runtimeSessionId: live.id,
      reason: 'session_revoked',
    })
  if (requestedSession && requestedSession.archived)
    return decorate({
      status: 'recovered',
      projectId: project.id,
      runtimeSessionId: live.id,
      reason: 'session_archived',
    })
  return decorate({
    status: 'recovered',
    projectId: project.id,
    runtimeSessionId: live.id,
    reason: 'session_missing',
  })
}

function firstLiveSession(
  project: DevSelectionInput['projects'][number],
  revoked: readonly string[] = []
): { id: string; archived: boolean } | undefined {
  return project.sessions.find((session) => !session.archived && !revoked.includes(session.id))
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function isStale(input: DevSelectionInput): boolean {
  if (!input.observedAt || input.staleAfterMs === undefined) return false
  const observed = Date.parse(input.observedAt)
  const now = input.now ? Date.parse(input.now) : Date.now()
  if (Number.isNaN(observed) || Number.isNaN(now)) return false
  return now - observed > input.staleAfterMs
}
