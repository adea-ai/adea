import type { AgentHqDatabase } from './connection'
import {
  bindSimLaunchStoreToWorkspace,
  createSimLaunchStore,
  findSimSessionContext,
  type SimLaunchBinding,
  type SimLaunchRedemption,
  type SimSurface,
} from './sim-launch-sessions'

/**
 * The durable storage behind the hosted Agent Sim launch.
 *
 * The launch code and the session it mints live in the same database as the rest of the app, in the
 * `sim_launch_codes` and `sim_sessions` tables. Only digests are stored, the code is spent by its
 * first presentation inside a row lock, and the session is written in the same transaction as that
 * spend, so a failed session write leaves the code redeemable.
 *
 * The issuer and the hosted service use this storage differently, and the difference matters:
 *
 * - The issuer may not take the workspace from the request, so it receives a store already bound
 *   to the workspace its entitlement verified.
 * - The hosted service may not take the workspace from the code either, but it has no request to
 *   bind to: the stored row carries the workspace, and the redemption copies it onto the session.
 *
 * The shapes below match the Sim bridge store contract structurally; this package does not import
 * the bridge.
 */

/** The binding a launch code carries. It has no workspace: the store supplies that. */
export type SimCodeBinding = Omit<SimLaunchBinding, 'workspaceId'>

/** What a caller presents when it redeems a code. */
export type SimCodePresentation = Pick<SimLaunchBinding, 'bridgeId' | 'origin'>

/** The code store the hosted service redeems against. */
export type SimRedemptionStore = Readonly<{
  issue(code: string, binding: SimCodeBinding, expiresAt: number): Promise<void>
  redeem(code: string, presented: SimCodePresentation, now: number): Promise<SimLaunchRedemption>
  redeemAndSave(
    code: string,
    presented: SimCodePresentation,
    now: number,
    session: Readonly<{ value: string; expiresAt: number }>
  ): Promise<SimLaunchRedemption>
}>

/** The code store the issuer may use, bound to one verified workspace. */
export type SimBoundCodeStore = Readonly<{
  issue(code: string, binding: SimCodeBinding, expiresAt: number): Promise<void>
  redeem(code: string, presented: SimCodePresentation, now: number): Promise<SimLaunchRedemption>
  redeemAndSave(
    code: string,
    presented: SimCodePresentation,
    now: number,
    session: Readonly<{ value: string; expiresAt: number }>
  ): Promise<SimLaunchRedemption>
}>

/** The stored session row as the private asset gate needs it. */
export type SimStoredSession = Readonly<{
  workspaceId: string
  surface: SimSurface
  expiresAt: number
}>

/** Looks a presented session value up in the durable store. */
export type SimSessionLookup = (value: string) => Promise<SimStoredSession | null>

/**
 * The durable code store the hosted service redeems against. The stored row carries the workspace,
 * so this store never needs one from the caller. It refuses to issue: only the Adea backend issues
 * codes, and a code issued here would have no verified workspace to bind to.
 */
export function createSimRedemptionStore(database: AgentHqDatabase): SimRedemptionStore {
  const store = createSimLaunchStore(database)
  return {
    issue() {
      throw new Error('The hosted Sim service redeems codes; only the Adea backend issues them')
    },
    redeem: store.redeem,
    redeemAndSave: store.redeemAndSave,
  }
}

/**
 * The durable code stores the issuer may use, one per verified workspace. A workspace identifier
 * outside the database shape is refused here rather than silently written.
 */
export function createSimIssuerStores(
  database: AgentHqDatabase
): (workspaceId: string) => SimBoundCodeStore {
  const store = createSimLaunchStore(database)
  return (workspaceId: string) => bindSimLaunchStoreToWorkspace(store, workspaceId)
}

/**
 * The durable session lookup behind the private asset gate. A session that is unknown, expired,
 * revoked or stored for another workspace never resolves, and the workspace and surface always
 * come from the stored row.
 */
export function createSimSessionLookup(
  database: AgentHqDatabase,
  now: () => number = Date.now
): SimSessionLookup {
  return async (value) => {
    const found = await findSimSessionContext(database, value, now())
    if (!found) return null
    return {
      workspaceId: found.workspaceId,
      surface: found.surface,
      expiresAt: found.expiresAt,
    }
  }
}
