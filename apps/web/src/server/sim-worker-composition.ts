import { parseSimHostContract, type SimHostContract } from '../lib/sim-host-contract'
import { createSimAllowlistPolicy } from './sim-allowlist'
import { createSimHostConfiguration } from './sim-host-config'
import type { SimHostServiceOptions } from './sim-host-service'
import type { SimHostWorkerComposition } from './sim-host-worker'
import { createSimPrivateAssetReader, SIM_PRIVATE_ASSET_LOCATION } from './sim-private-assets'
import { createSimR2AssetStore, type SimR2Bucket } from './sim-r2-store'

/**
 * The composition for the separately hosted Agent Sim Worker: it turns the Worker environment into
 * the service ports. It is source only. No wrangler configuration, route, binding, credential or
 * deployment points at it, and nothing in this module reaches a network or a bucket on its own.
 *
 * What it wires, and from where:
 * - the durable stores (code redemption, session lookup, allowlist lookup) come from `openStores`,
 *   called once per request with the database connection string the environment carries;
 * - the private reader is the existing `createSimPrivateAssetReader` over the R2 adapter, so the
 *   key rules, the withheld third-party prefixes and the bytes-only answer are the merged ones;
 * - entitlement is the deny-by-default allowlist policy over the allowlist lookup;
 * - the asset prefix and entry names come from the validated contract the deployment supplies, and
 *   the frame script is the public bootstrap bundle the deployment builds.
 *
 * Everything is refused closed. A missing or malformed environment value makes the composition
 * return nothing, which the Worker answers as `503 not_configured` with no private read, and a
 * contract that does not validate stops the factory itself. Loopback HTTP origins are never allowed
 * here: that switch is for acceptance fixtures only.
 */

/** The Worker bindings and variables this composition reads. The names are its own, not the app's. */
export type SimWorkerEnvironment = Readonly<{
  /** A Hyperdrive binding (or any object with a connection string) for the Sim host database role. */
  SIM_DATABASE?: Readonly<{ connectionString?: unknown }> | null
  /** The R2 bucket binding that holds the private export. */
  SIM_EXPORT?: SimR2Bucket | null
  /** The exact origin the frame is served from. */
  SIM_ORIGIN?: unknown
  /** The exact origins allowed to embed the frame, comma separated. */
  SIM_PARENT_ORIGINS?: unknown
  /** The private location name; defaults to `agent-sim-export`. */
  SIM_EXPORT_LOCATION?: unknown
}>

/** The durable stores one request uses, and how to let go of them. */
export type SimWorkerStores = Readonly<{
  store: SimHostServiceOptions['store']
  sessions: SimHostServiceOptions['sessions']
  /** Answers `true` only for a granted workspace and surface; a failure throws. */
  allowlist: (scope: { workspaceId: string; surface: string }) => Promise<boolean>
  /** Releases the connection. Called once the request has been answered. */
  close: () => Promise<void> | void
}>

export type SimWorkerCompositionOptions = Readonly<{
  /** The asset prefix and entry names the export is laid out with. Validated now; never defaulted. */
  contract: SimHostContract
  /** The public bootstrap bundle served at the frame route. Built by the deployment. */
  frameScript: string
  /** Opens the durable stores for one request. */
  openStores: (connectionString: string) => SimWorkerStores
  /** The clock; defaults to the system clock. */
  now?: () => number
}>

const DEFAULT_LOCATION = 'agent-sim-export'

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parentOrigins(value: unknown): string[] | null {
  if (!nonEmptyString(value)) return null
  const origins = value.split(',').map((item) => item.trim())
  return origins.every((item) => item.length > 0) ? origins : null
}

/**
 * Builds the composition. Throws now, not per request, when the contract or the frame script is
 * unusable, so a bad deployment bundle fails at startup instead of serving.
 */
export function createSimWorkerComposition(
  options: SimWorkerCompositionOptions
): SimHostWorkerComposition<SimWorkerEnvironment> {
  const contract = parseSimHostContract(options.contract)
  if (!contract) throw new Error('Hosted Sim needs a complete asset prefix and entry file contract')
  if (typeof options.frameScript !== 'string' || options.frameScript.length === 0)
    throw new Error('Hosted Sim needs a frame script')
  if (typeof options.openStores !== 'function')
    throw new Error('Hosted Sim needs a way to open its stores')

  return (environment) => {
    if (!environment || typeof environment !== 'object') return null
    const connectionString = environment.SIM_DATABASE?.connectionString
    const bucket = environment.SIM_EXPORT
    const origins = parentOrigins(environment.SIM_PARENT_ORIGINS)
    const location =
      environment.SIM_EXPORT_LOCATION === undefined
        ? DEFAULT_LOCATION
        : environment.SIM_EXPORT_LOCATION
    if (!nonEmptyString(connectionString)) return null
    if (!bucket || typeof bucket.get !== 'function') return null
    if (!nonEmptyString(environment.SIM_ORIGIN) || !origins) return null
    if (typeof location !== 'string' || !SIM_PRIVATE_ASSET_LOCATION.test(location)) return null

    // Validated before any store is opened, so a refused configuration never holds a connection.
    // It throws on a malformed origin, which the Worker answers as not configured.
    const configuration = createSimHostConfiguration({
      origin: environment.SIM_ORIGIN,
      parentOrigins: origins,
      assetPrefix: contract.assetPrefix,
      entryFiles: contract.entryFiles,
    })
    const reader = createSimPrivateAssetReader({
      location,
      read: createSimR2AssetStore({ location, bucket }),
    })

    const stores = options.openStores(connectionString)
    return {
      configuration,
      store: stores.store,
      sessions: stores.sessions,
      policy: createSimAllowlistPolicy(stores.allowlist),
      readAsset: (path) => reader(path),
      frameScript: options.frameScript,
      ...(options.now ? { now: options.now } : {}),
      dispose: stores.close,
    }
  }
}
