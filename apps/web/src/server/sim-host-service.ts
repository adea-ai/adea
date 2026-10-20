import {
  createSimSessionExchange,
  type SimLaunchCodeStore,
  type SimSurface,
} from '@adea-ai/spatial/sim-bridge'

import { createSimAssetEntitlement, type SimEntitlementPolicy } from './sim-entitlement'
import { createSimHost, type SimAssetContext, type SimPrivateAsset } from './sim-host'
import {
  createSimHostConfiguration,
  type SimHostConfiguration,
  type SimHostConfigurationInput,
} from './sim-host-config'

/**
 * The approved composition for the separately hosted Agent Sim service.
 *
 * The service owns the session gate and nothing else. It redeems one single-use code per launch,
 * mints the sim-only cookie, looks the session up in durable storage, asks the explicit entitlement
 * policy about the workspace and surface the stored row names, and only then reads a private
 * object from the named private location.
 *
 * The workspace and surface always come from the stored session row. No request body, query
 * string or header can select them, so a read cannot be aimed at another workspace or surface.
 * There is no public alias for the private export: the assets are served by this origin only,
 * behind the session cookie.
 */

/**
 * The durable session lookup. It resolves a presented session value to its stored row. The
 * durable adapter in `@adea-ai/db` satisfies this port structurally, so the hosted service does
 * not import the database package.
 */
export type SimSessionLookup = (
  value: string
) => Promise<Readonly<{ workspaceId: string; surface: SimSurface; expiresAt: number }> | null>

/**
 * The code store the hosted service redeems against. The atomic redemption is required: the
 * session is written in the same step as the code spend, so a failed session write leaves the
 * code redeemable instead of consuming a launch.
 */
export type SimHostCodeStore = SimLaunchCodeStore &
  Required<Pick<SimLaunchCodeStore, 'redeemAndSave'>>

export type SimHostServiceOptions = Readonly<{
  /** The operator's host configuration: exact origins, the asset prefix and the entry names. */
  configuration: SimHostConfigurationInput
  /** Durable single-use code storage for the codes this origin issues and redeems. */
  store: SimHostCodeStore
  /** The durable session lookup behind the private asset gate. */
  sessions: SimSessionLookup
  /** The explicit entitlement policy for one workspace and surface. */
  policy: SimEntitlementPolicy
  /** Reads one private object from the named private location. */
  readAsset: (path: string, context: SimAssetContext) => Promise<SimPrivateAsset | null>
  /** The frame bootstrap the service serves at `/frame.js`. */
  frameScript: string
  /** Session lifetime in seconds, clamped to the contract maximum. */
  sessionSeconds?: number
  now?: () => number
}>

/**
 * The separately hosted service handler. It refuses to start from a malformed configuration, and
 * every failure after that is closed: no session, no entitlement or a storage failure serves no
 * private asset.
 */
export function createSimHostService(
  options: SimHostServiceOptions
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now
  const config: SimHostConfiguration = createSimHostConfiguration(options.configuration)
  const exchange = createSimSessionExchange({
    origin: config.origin,
    allowLoopbackHttp: config.allowLoopbackHttp,
    store: options.store,
    // The durable store writes the session inside the code redemption, so this path never runs.
    // The store without `redeemAndSave` would need it; refusing keeps a separate session write
    // from ever existing.
    sessions: {
      save() {
        throw new Error('Hosted Sim sessions are written by the launch-code redemption')
      },
    },
    sessionSeconds: options.sessionSeconds,
    now,
  })
  return createSimHost({
    ...config,
    frameScript: options.frameScript,
    exchange,
    session: async (value) => {
      const found = await options.sessions(value)
      if (!found) return null
      return {
        workspaceId: found.workspaceId,
        surface: found.surface,
        expiresAt: found.expiresAt,
      }
    },
    entitlement: createSimAssetEntitlement(options.policy),
    readAsset: options.readAsset,
    now,
  })
}
