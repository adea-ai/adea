import { and, eq } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { simWorkspaceAllowlist } from './schema'
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

/** The workspace identifier grammar the launch store accepts, so a grant can only name a launchable workspace. */
const SIM_ALLOWLIST_WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function isSimSurface(surface: string): surface is SimSurface {
  return (SIM_SURFACES as readonly string[]).includes(surface)
}

/** Builds the lookup the allowlist policy asks. Only a row for this workspace and surface answers `true`. */
export function createSimAllowlistLookup(
  database: AgentHqDatabase
): (scope: SimAllowlistScope) => Promise<boolean> {
  return async ({ workspaceId, surface }) => {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return false
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

/** Grants one workspace one surface. Granting again changes nothing. Returns whether a row was added. */
export async function grantSimAllowlist(
  database: AgentHqDatabase,
  scope: SimAllowlistScope
): Promise<boolean> {
  assertScope(scope)
  const rows = await database
    .insert(simWorkspaceAllowlist)
    .values({ workspaceId: scope.workspaceId, surface: scope.surface })
    .onConflictDoNothing()
    .returning({ id: simWorkspaceAllowlist.id })
  return rows.length > 0
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
