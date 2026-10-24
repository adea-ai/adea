import { and, eq, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { simSessions, simWorkspaceAllowlist, workspaces } from './schema'
import { SIM_SURFACES, type SimSurface } from './sim-launch-sessions'

/**
 * The durable store behind the hosted Agent Sim entitlement allowlist.
 *
 * The lookup answers the hosted service's allowlist port: it resolves `true` only when a row grants
 * exactly this workspace this surface. A missing row, an empty workspace identifier and a surface
 * outside the closed set all resolve `false`. A database failure is not caught, so the caller
 * resolves it to `unavailable` and nothing is served.
 *
 * The hosted service's database role needs `SELECT` on `app.sim_workspace_allowlist` and nothing
 * else on it. Rows are added and withdrawn by an operator through the two functions below, never by
 * the hosted service and never by a request.
 */
export type SimAllowlistScope = Readonly<{ workspaceId: string; surface: string }>

/** Workspace identifiers in `app.workspaces` are UUIDs, so anything else can never hold a grant. */
const SIM_ALLOWLIST_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Raised when a grant names a workspace that is missing, archived or pending deletion. */
export class SimAllowlistWorkspaceUnavailableError extends Error {
  constructor() {
    super('Sim allowlist workspace is not available')
    this.name = 'SimAllowlistWorkspaceUnavailableError'
  }
}

function isSimSurface(surface: string): surface is SimSurface {
  return (SIM_SURFACES as readonly string[]).includes(surface)
}

/** Builds the lookup the allowlist policy asks. Only a row for this workspace and surface answers `true`. */
export function createSimAllowlistLookup(
  database: AgentHqDatabase
): (scope: SimAllowlistScope) => Promise<boolean> {
  return async ({ workspaceId, surface }) => {
    if (typeof workspaceId !== 'string' || !SIM_ALLOWLIST_WORKSPACE_ID.test(workspaceId))
      return false
    if (typeof surface !== 'string' || !isSimSurface(surface)) return false
    const [row] = await database
      .select({ id: simWorkspaceAllowlist.id })
      .from(simWorkspaceAllowlist)
      .where(
        and(
          eq(simWorkspaceAllowlist.workspaceId, workspaceId),
          eq(simWorkspaceAllowlist.surface, surface)
        )
      )
      .limit(1)
    return row !== undefined
  }
}

function assertScope(scope: SimAllowlistScope): asserts scope is SimAllowlistScope & {
  surface: SimSurface
} {
  if (typeof scope.workspaceId !== 'string' || !SIM_ALLOWLIST_WORKSPACE_ID.test(scope.workspaceId))
    throw new RangeError('Sim allowlist workspace id is not a valid identifier')
  if (typeof scope.surface !== 'string' || !isSimSurface(scope.surface))
    throw new RangeError('Sim allowlist surface is not a known surface')
}

/**
 * Grants one existing, active workspace one surface. Granting again changes nothing. Returns whether
 * a row was added. A workspace that does not exist, is archived or has its deletion requested is
 * refused with `SimAllowlistWorkspaceUnavailableError`. The workspace row is locked for the check,
 * so an archive that commits first refuses the grant, and one that commits after it withdraws it.
 */
export async function grantSimAllowlist(
  database: AgentHqDatabase,
  scope: SimAllowlistScope
): Promise<boolean> {
  assertScope(scope)
  return database.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, scope.workspaceId),
          isNull(workspaces.deletedAt),
          isNull(workspaces.deletionRequestedAt)
        )
      )
      .for('share')
      .limit(1)
    if (!workspace) throw new SimAllowlistWorkspaceUnavailableError()
    const rows = await transaction
      .insert(simWorkspaceAllowlist)
      .values({ workspaceId: scope.workspaceId, surface: scope.surface })
      .onConflictDoNothing()
      .returning({ id: simWorkspaceAllowlist.id })
    return rows.length > 0
  })
}

/** Withdraws one workspace's grant for one surface. Returns whether a row was removed. */
export async function revokeSimAllowlist(
  database: AgentHqDatabase,
  scope: SimAllowlistScope
): Promise<boolean> {
  assertScope(scope)
  const rows = await database
    .delete(simWorkspaceAllowlist)
    .where(
      and(
        eq(simWorkspaceAllowlist.workspaceId, scope.workspaceId),
        eq(simWorkspaceAllowlist.surface, scope.surface)
      )
    )
    .returning({ id: simWorkspaceAllowlist.id })
  return rows.length > 0
}

/**
 * Withdraws every hosted Sim grant for a workspace and revokes its live Sim sessions. The workspace
 * lifecycle calls this inside the transaction that archives the workspace or requests its deletion,
 * so a session that already exists stops reading private assets at its next request even though
 * the hosted service never reads `app.workspaces`. Returns how many grants and sessions it ended.
 */
export async function withdrawSimAccess(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string
): Promise<Readonly<{ grants: number; sessions: number }>> {
  const grants = await database
    .delete(simWorkspaceAllowlist)
    .where(eq(simWorkspaceAllowlist.workspaceId, workspaceId))
    .returning({ id: simWorkspaceAllowlist.id })
  const sessions = await database
    .update(simSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        sql`lower(${simSessions.workspaceId}) = ${workspaceId.toLowerCase()}`,
        isNull(simSessions.revokedAt)
      )
    )
    .returning({ id: simSessions.id })
  return { grants: grants.length, sessions: sessions.length }
}
