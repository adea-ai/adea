/*
 * Tenant-authorized foreign-Agent candidate listing (M15 #1178).
 *
 * A tenant — the host workspace that wants to enlist a foreign Agent into one
 * of its groups — may list the Agents of another workspace only where the
 * requester holds authority in that source workspace. Authority is proven per
 * source workspace with the same predicate the enlistment issuer uses
 * (`workspace.update` in the Agent's own source workspace, see
 * `requireAgentEnlistmentSource`), so a listed candidate is exactly an Agent
 * the issuer path would still have to re-prove at issuance time.
 *
 * What this listing deliberately never does:
 *
 * - It never infers authority from a same-name Agent, from the host
 *   workspace's own membership, or from any Agent the tenant already enlisted.
 *   The requester's standing in the *source* workspace is the only proof, and
 *   the source workspace is named explicitly by the caller rather than
 *   discovered by matching names.
 * - It never grants enlistment. This module only reads: it creates no grant,
 *   no admission and no roster row. Enlistment stays with the group creation
 *   and live enlistment paths, which recheck source authority under a
 *   transaction lock before any grant write. A candidate is a suggestion, not
 *   an authorization.
 * - It never widens the existing Agent listing. The tenant's own Agents keep
 *   coming from `agents.ts`; this module answers only for foreign source
 *   workspaces the requester is authorized in.
 *
 * Identity is stable and workspace-qualified: a candidate is identified by the
 * pair `{ workspaceId, agentId }`, where the workspace id is the Agent's own
 * source workspace. A display name is carried for presentation only and never
 * enters the identity, so two same-named Agents in different workspaces stay
 * distinguishable.
 */
import type { UserPrincipalRef } from '@adea-ai/types'
import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { agents, workspaceMemberships, workspaces } from './schema'

/** Bounded reads: a candidate list never becomes an enumeration surface. */
export const GROUP_AGENT_CANDIDATE_LIMITS = Object.freeze({
  candidates: 200,
  sourceWorkspaces: 16,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * One foreign Agent the tenant may consider, identified by its own source
 * workspace and Agent id.
 */
export type GroupAgentCandidate = Readonly<{
  /** The Agent's source workspace: the stable half of the identity. */
  workspaceId: string
  agentId: string
  /** Display only. Never part of the identity. */
  name: string
}>

/**
 * The explicit scope of a candidate read. The source workspaces are named by
 * the caller from an authority scope the caller already holds; this module
 * proves the requester's standing in each one and never widens the scope.
 */
export type GroupAgentCandidateScope = Readonly<{
  /** The tenant workspace the read is performed for. */
  workspaceId: string
  /** The source workspaces whose Agents are being considered. */
  sourceWorkspaceIds: readonly string[]
  principal: UserPrincipalRef
}>

/**
 * The stable identity of a candidate. Two Agents that share a display name
 * never share this key.
 */
export function groupAgentCandidateKey(candidate: GroupAgentCandidate): string {
  return `${candidate.workspaceId}:${candidate.agentId}`
}

/**
 * List the foreign-Agent candidates the tenant is authorized to see.
 *
 * Read-only by construction: no grant, admission or roster row is written, so
 * a listing can never enlist an Agent. The tenant scope is checked first (the
 * caller must act for a workspace it belongs to); each named source workspace
 * is then checked independently, and a source the requester is not authorized
 * in — or whose workspace is deleted or pending deletion — contributes
 * nothing at all.
 */
export async function listGroupAgentCandidates(
  database: AgentHqDatabase,
  scope: GroupAgentCandidateScope
): Promise<GroupAgentCandidate[]> {
  if (!UUID.test(scope.workspaceId)) throw new Error('Agent unavailable')
  await requireTenantMembership(database, scope.workspaceId, scope.principal)

  // The tenant's own Agents are listed by the existing Agent read, not here.
  const sourceWorkspaceIds = [
    ...new Set(
      scope.sourceWorkspaceIds.filter(
        (workspaceId) =>
          typeof workspaceId === 'string' &&
          UUID.test(workspaceId) &&
          workspaceId !== scope.workspaceId
      )
    ),
  ].slice(0, GROUP_AGENT_CANDIDATE_LIMITS.sourceWorkspaces)
  if (sourceWorkspaceIds.length === 0) return []

  // One membership read proves both the source-workspace authority and the
  // active-workspace check: a deleted workspace or a deletion-pending one
  // never yields a membership row, so it can never become a candidate source.
  const memberships = await database
    .select({
      deletionPending: workspaces.deletionRequestedAt,
      role: workspaceMemberships.role,
      workspaceId: workspaceMemberships.workspaceId,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        inArray(workspaceMemberships.workspaceId, sourceWorkspaceIds),
        eq(workspaceMemberships.userId, scope.principal.userId),
        isNull(workspaces.deletedAt)
      )
    )

  const authorized: string[] = []
  for (const membership of memberships) {
    const authorization = await authorizeWorkspaceAction(
      {
        permission: 'workspace.update',
        principal: scope.principal,
        workspaceId: membership.workspaceId,
      },
      {
        findMembership: async () => ({
          role: membership.role,
          deletionPending: membership.deletionPending !== null,
        }),
      }
    )
    if (authorization.allowed) authorized.push(membership.workspaceId)
  }
  if (authorized.length === 0) return []

  const rows = await database
    .select({ agentId: agents.id, name: agents.name, workspaceId: agents.workspaceId })
    .from(agents)
    .where(and(inArray(agents.workspaceId, authorized), eq(agents.lifecycleState, 'active')))
    .orderBy(asc(agents.workspaceId), asc(agents.name), asc(agents.id))

  return rows.slice(0, GROUP_AGENT_CANDIDATE_LIMITS.candidates).map((row) =>
    Object.freeze({
      agentId: row.agentId,
      name: row.name,
      workspaceId: row.workspaceId,
    })
  )
}

async function requireTenantMembership(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Agent unavailable')
}
