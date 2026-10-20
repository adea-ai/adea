import type {
  SimEntitlementChecker,
  SimEntitlementQuery,
  SimEntitlementVerdict,
} from '@adea-ai/spatial/sim-bridge'
import { SIM_SURFACES, type SimSurface } from '../lib/sim-host-contract'
import type { SimAssetContext } from './sim-host'

/**
 * Fail-closed entitlement composition for hosted Agent Sim, written against injected ports.
 *
 * The explicit policy source is a port, and nothing here chooses it. Workspace membership is an
 * authorization fact, not an entitlement: only the policy can answer 'entitled'. Every missing,
 * thrown, malformed or unknown answer resolves to a closed verdict.
 *
 * Nothing in this module is wired into a production route. The production composition supplies the
 * principal resolver, the workspace authorizer and the policy; see
 * docs/plans/hosted-sim-production-composition.md.
 */

export type SimEntitlementScope = Readonly<{
  workspaceId: string
  surface: SimSurface
  platform?: SimEntitlementQuery['platform']
}>

/** The explicit entitlement answer for a scope. Only the four known verdicts are accepted. */
export type SimEntitlementPolicy = (scope: SimEntitlementScope) => unknown

export type SimPrincipalResolver<TPrincipal> = (
  request: Request
) => TPrincipal | null | undefined | Promise<TPrincipal | null | undefined>

/** Only a literal `true` authorizes the read. Any other value denies. */
export type SimWorkspaceAuthorizer<TPrincipal> = (
  principal: TPrincipal,
  action: 'workspace.read',
  workspaceId: string
) => unknown

export type SimLaunchEntitlementPorts<TPrincipal> = Readonly<{
  resolvePrincipal: SimPrincipalResolver<TPrincipal>
  authorizeWorkspace: SimWorkspaceAuthorizer<TPrincipal>
  policy: SimEntitlementPolicy
}>

const VERDICTS: readonly SimEntitlementVerdict[] = [
  'entitled',
  'not_entitled',
  'unauthenticated',
  'unavailable',
]

function closed(value: unknown): SimEntitlementVerdict {
  return VERDICTS.includes(value as SimEntitlementVerdict)
    ? (value as SimEntitlementVerdict)
    : 'unavailable'
}

function wellFormed(scope: { workspaceId: unknown; surface: unknown }): boolean {
  return (
    typeof scope.workspaceId === 'string' &&
    scope.workspaceId.length > 0 &&
    (SIM_SURFACES as readonly unknown[]).includes(scope.surface)
  )
}

/**
 * Binds the launch entitlement to the request's authenticated principal. The order is fixed. A
 * malformed scope is unavailable. No principal is unauthenticated. A principal without workspace
 * read is not entitled. Only after both does the explicit policy answer. A throwing port is
 * unavailable, and nothing is asked after a failure.
 */
export function bindSimLaunchEntitlement<TPrincipal>(
  request: Request,
  ports: SimLaunchEntitlementPorts<TPrincipal>
): SimEntitlementChecker {
  return async (query) => {
    if (!wellFormed(query)) return 'unavailable'
    let principal: TPrincipal | null | undefined
    try {
      principal = await ports.resolvePrincipal(request)
    } catch {
      return 'unavailable'
    }
    if (principal === null || principal === undefined) return 'unauthenticated'
    let member: unknown
    try {
      member = await ports.authorizeWorkspace(principal, 'workspace.read', query.workspaceId)
    } catch {
      return 'unavailable'
    }
    if (member !== true) return 'not_entitled'
    try {
      return closed(
        await ports.policy({
          workspaceId: query.workspaceId,
          surface: query.surface,
          platform: query.platform,
        })
      )
    } catch {
      return 'unavailable'
    }
  }
}

/**
 * Asset-time entitlement for createSimHost. It is asked about the session's stored workspace and
 * surface, never about client input. Asset requests carry no principal, so membership cannot be
 * re-checked here. The policy source therefore has to reflect membership and revocation changes.
 * Every failure is closed.
 */
export function createSimAssetEntitlement(
  policy: SimEntitlementPolicy
): (context: SimAssetContext) => Promise<SimEntitlementVerdict> {
  return async (context) => {
    if (!wellFormed(context)) return 'unavailable'
    try {
      return closed(await policy({ workspaceId: context.workspaceId, surface: context.surface }))
    } catch {
      return 'unavailable'
    }
  }
}
