import type { SimEntitlementPolicy } from './sim-entitlement'

/**
 * The entitlement policy for the first hosted Agent Sim cohort: a per-workspace allowlist with
 * default deny.
 *
 * The allowlist itself is a port. This module chooses no storage, and it adds no table. A row
 * grants one workspace one surface, and only a literal `true` from the port entitles. A missing
 * row, an unknown answer or a malformed scope all deny. A port that throws is not caught here, so
 * the callers in sim-entitlement.ts resolve it to `unavailable` and nothing is served.
 *
 * Workspace membership never entitles on its own: the launch binding still demands workspace read
 * before this policy is asked. A temporary (guest) user has no row unless an operator adds one for
 * that exact workspace, so guests are denied by default.
 */

export type SimAllowlistScope = Readonly<{ workspaceId: string; surface: string }>

/** Answers whether one workspace is granted one surface. Only a literal `true` grants. */
export type SimAllowlistLookup = (scope: SimAllowlistScope) => unknown

/** Builds the allowlist policy over the given lookup. */
export function createSimAllowlistPolicy(lookup: SimAllowlistLookup): SimEntitlementPolicy {
  return async (scope) => {
    if (typeof scope?.workspaceId !== 'string' || scope.workspaceId.length === 0) {
      return 'not_entitled'
    }
    const granted = await lookup({ workspaceId: scope.workspaceId, surface: scope.surface })
    return granted === true ? 'entitled' : 'not_entitled'
  }
}
