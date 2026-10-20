import {
  createSimLaunchIssuer,
  parseSimLaunchRequest,
  type SimLaunchCodeStore,
  type SimLaunchIssueResult,
} from '@adea-ai/spatial/sim-bridge'

import {
  bindSimLaunchEntitlement,
  type SimEntitlementPolicy,
  type SimPrincipalResolver,
  type SimWorkspaceAuthorizer,
} from './sim-entitlement'

/**
 * The approved Adea-side launch composition.
 *
 * Three things decide a launch, in this order: the request's authenticated principal, the
 * workspace read authorization for the workspace the request names, and an explicit entitlement
 * policy. Only the policy may answer `entitled`. Membership alone never entitles, and the desktop
 * shell's claimed identity, an official origin or a client platform hint prove nothing.
 *
 * The code storage is bound to the workspace the entitlement verified, so a code can never be
 * issued against a workspace the caller supplied but the account may not use. The store is
 * supplied as a factory: one durable store per verified workspace, never one shared map.
 *
 * Nothing here chooses an entitlement source, a hosting origin or a storage engine. The caller
 * supplies each one, and an absent origin is `not_configured` rather than a default.
 */

export type SimLaunchServicePorts<TPrincipal> = Readonly<{
  /** The request's authenticated principal, or null when the request has none. */
  resolvePrincipal: SimPrincipalResolver<TPrincipal>
  /** The workspace read authorization for the request's principal. */
  authorizeWorkspace: SimWorkspaceAuthorizer<TPrincipal>
  /** The explicit entitlement answer for one workspace and surface. */
  policy: SimEntitlementPolicy
}>

export type SimLaunchServiceOptions<TPrincipal> = Readonly<{
  /** The exact origin of the separately hosted Sim service. Absent means "not configured". */
  frameOrigin: string | null | undefined
  /** Durable single-use code storage, one store per verified workspace. */
  createStore: (workspaceId: string) => SimLaunchCodeStore
  ports: SimLaunchServicePorts<TPrincipal>
  /** Permits `http://` loopback origins. Only acceptance fixtures set it. */
  allowLoopbackHttp?: boolean
  /** Code lifetime in milliseconds, clamped to the contract maximum. */
  codeTtlMs?: number
  now?: () => number
}>

/**
 * The launch service: a request and a body in, a grant or a closed refusal out. It never answers
 * `granted` on its own; the entitlement composition does, and every failure there stays closed.
 */
export function createSimLaunchService<TPrincipal>(
  options: SimLaunchServiceOptions<TPrincipal>
): (request: Request, body: unknown) => Promise<SimLaunchIssueResult> {
  const now = options.now ?? Date.now
  return async (request, body) => {
    // The workspace is taken from the parsed request and re-verified by the entitlement
    // composition below. The store is bound to that same workspace, so the stored code and the
    // entitlement decision can never describe different workspaces.
    const parsed = parseSimLaunchRequest(body)
    if (!parsed) return { status: 'invalid_request' }
    let store: SimLaunchCodeStore
    try {
      store = options.createStore(parsed.workspaceId)
    } catch {
      // A store that refuses the workspace identifier cannot prove anything, so nothing is issued.
      return { status: 'unavailable', reason: 'service_unavailable' }
    }
    const issuer = createSimLaunchIssuer({
      frameOrigin: options.frameOrigin,
      allowLoopbackHttp: options.allowLoopbackHttp === true,
      entitlement: bindSimLaunchEntitlement(request, options.ports),
      store,
      codeTtlMs: options.codeTtlMs,
      now,
    })
    return issuer(body)
  }
}
