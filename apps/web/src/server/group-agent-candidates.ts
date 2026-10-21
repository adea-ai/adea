/*
 * Foreign-Agent candidate read model (M15 #1178).
 *
 * A tenant asks which foreign Agents it could consider for a group. This
 * module is the response-local half of that read: it validates the requested
 * scope, calls the authorized candidate read, and shapes a bounded answer.
 *
 * It is deliberately not an authority:
 *
 * - The candidate read is injected, so this module never widens the database
 *   Agent listing and never reaches the tenant's own Agents, which keep coming
 *   from the existing Agent endpoint.
 * - A listing never grants enlistment. The response says so in its own shape
 *   (`grantsEnlistment: false`), and the enlistment path keeps its own
 *   issuer recheck: the source-workspace authority is re-proven under a
 *   transaction lock before any grant is written. A candidate that is listed
 *   today is still re-proven when it is enlisted.
 * - A refused read is reported as unavailable with no candidates and no
 *   upstream detail, so a caller cannot distinguish "no authority" from "no
 *   candidates" by reading the response.
 *
 * Route integration is deliberately not part of this module: the product
 * wiring is serialized separately, and this read model is safe to use without
 * it.
 */
import type { UserPrincipalRef } from '@adea-ai/types'

/** Bounded reads: a candidate list never becomes an enumeration surface. */
export const GROUP_AGENT_CANDIDATE_LIMITS = Object.freeze({
  candidates: 200,
  sourceWorkspaces: 16,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** One foreign Agent, identified by its own source workspace and Agent id. */
export type GroupAgentCandidateSummary = Readonly<{
  agentId: string
  name: string
  workspaceId: string
}>

/** The validated scope of a candidate read. */
export type GroupAgentCandidateScope = Readonly<{
  principal: UserPrincipalRef
  /** The source workspaces whose Agents are being considered. */
  sourceWorkspaceIds: readonly string[]
  /** The tenant workspace the read is performed for. */
  workspaceId: string
}>

/** The candidate read this model depends on, injected by the caller. */
export type GroupAgentCandidateDependencies = Readonly<{
  listCandidates: (
    scope: GroupAgentCandidateScope
  ) => Promise<readonly GroupAgentCandidateSummary[]>
}>

/** The response. It carries candidates and never carries authority. */
export type GroupAgentCandidateListing = Readonly<{
  candidates: readonly GroupAgentCandidateSummary[]
  /** A listing never grants enlistment. */
  grantsEnlistment: false
  status: 'available' | 'unavailable'
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse an untrusted candidate-scope request.
 *
 * The tenant workspace must be a canonical UUID and the source workspaces a
 * bounded list of canonical UUIDs. Anything else fails closed: the caller
 * learns nothing about the workspaces it named.
 */
export function parseGroupAgentCandidateScope(
  input: unknown,
  principal: UserPrincipalRef
): GroupAgentCandidateScope | null {
  if (!isRecord(input)) return null
  const { sourceWorkspaceIds, workspaceId } = input
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) return null
  if (!Array.isArray(sourceWorkspaceIds)) return null
  const sources = [
    ...new Set(
      sourceWorkspaceIds.filter(
        (value): value is string => typeof value === 'string' && UUID.test(value)
      )
    ),
  ].slice(0, GROUP_AGENT_CANDIDATE_LIMITS.sourceWorkspaces)
  return Object.freeze({
    principal,
    sourceWorkspaceIds: Object.freeze(sources),
    workspaceId,
  })
}

/**
 * Read the foreign-Agent candidates the tenant is authorized to see.
 *
 * The response is bounded, de-duplicated by the stable workspace-qualified
 * identity, and never claims enlistment authority. A refused or failed read
 * yields no candidates and no detail.
 */
export async function listGroupAgentCandidates(
  scope: GroupAgentCandidateScope,
  dependencies: GroupAgentCandidateDependencies
): Promise<GroupAgentCandidateListing> {
  const validated = validateScope(scope)
  if (!validated) {
    return Object.freeze({
      candidates: Object.freeze([]),
      grantsEnlistment: false as const,
      status: 'unavailable' as const,
    })
  }
  try {
    const candidates = await dependencies.listCandidates(validated)
    return Object.freeze({
      candidates: Object.freeze(bounded(validated, candidates)),
      grantsEnlistment: false as const,
      status: 'available' as const,
    })
  } catch {
    // Fail closed: an infrastructure failure is not readable as an answer, so
    // it never becomes an empty candidate list that looks like a verdict.
    return Object.freeze({
      candidates: Object.freeze([]),
      grantsEnlistment: false as const,
      status: 'unavailable' as const,
    })
  }
}

/**
 * Re-validate the scope at the boundary. The parser already canonicalizes it,
 * but the candidate read is the authority boundary, so it never receives an
 * uncanonical source workspace even if a caller skipped the parser.
 */
function validateScope(scope: GroupAgentCandidateScope): GroupAgentCandidateScope | null {
  if (!scope || typeof scope !== 'object') return null
  if (typeof scope.workspaceId !== 'string' || !UUID.test(scope.workspaceId)) return null
  if (!scope.principal || scope.principal.kind !== 'user') return null
  const sources = Array.isArray(scope.sourceWorkspaceIds) ? scope.sourceWorkspaceIds : []
  return Object.freeze({
    principal: scope.principal,
    sourceWorkspaceIds: Object.freeze(
      [
        ...new Set(
          sources.filter(
            (value): value is string =>
              typeof value === 'string' && UUID.test(value) && value !== scope.workspaceId
          )
        ),
      ].slice(0, GROUP_AGENT_CANDIDATE_LIMITS.sourceWorkspaces)
    ),
    workspaceId: scope.workspaceId,
  })
}

function bounded(
  scope: GroupAgentCandidateScope,
  candidates: readonly GroupAgentCandidateSummary[]
): GroupAgentCandidateSummary[] {
  const seen = new Set<string>()
  const result: GroupAgentCandidateSummary[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.agentId !== 'string') continue
    if (typeof candidate.workspaceId !== 'string' || !UUID.test(candidate.workspaceId)) continue
    if (typeof candidate.name !== 'string') continue
    // A candidate from the tenant's own workspace is not a foreign candidate;
    // the tenant's own Agents come from the existing Agent endpoint.
    if (candidate.workspaceId === scope.workspaceId) continue
    const key = `${candidate.workspaceId}:${candidate.agentId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(
      Object.freeze({
        agentId: candidate.agentId,
        name: candidate.name,
        workspaceId: candidate.workspaceId,
      })
    )
    if (result.length >= GROUP_AGENT_CANDIDATE_LIMITS.candidates) break
  }
  return result
}
