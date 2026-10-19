import { canonicalBridgeOrigin } from '@adea-ai/spatial/sim-bridge'

/** The closed set of Agent Sim surfaces. Configuration can rename their entry files but cannot add or change a surface. */
export const SIM_SURFACES = ['hq', 'room-designer', 'character-designer'] as const
export type SimSurface = (typeof SIM_SURFACES)[number]

/** What an operator supplies. Every field is required except `allowLoopbackHttp`, which defaults to false. */
export type SimHostConfigurationInput = {
  /** The exact origin the frame is served from. */
  origin: string
  /** The exact origins allowed to embed the frame. Non-empty, distinct from `origin`, on other cookie hosts. */
  parentOrigins: readonly string[]
  /** Permits `http://` loopback origins. Only acceptance fixtures set it. */
  allowLoopbackHttp?: boolean
  /** The path prefix of private assets, such as `/assets/agent-sim/`. */
  assetPrefix: string
  /** The file name of each surface's private entry. Every surface appears exactly once; names are distinct. */
  entryFiles: Readonly<Record<SimSurface, string>>
}

export type SimHostConfiguration = Readonly<{
  origin: string
  parentOrigins: readonly string[]
  allowLoopbackHttp: boolean
  assetPrefix: string
  entryFiles: Readonly<Record<SimSurface, string>>
}>

const ASSET_PREFIX = /^\/(?:[a-z0-9][a-z0-9-]*\/){1,4}$/
const ENTRY_FILE = /^[a-z0-9][a-z0-9-]{0,62}\.js$/

/**
 * Validates the host configuration and returns it frozen. It throws on anything missing or malformed, so the host
 * never starts from partial or default values. The isolation rules are the ones the host has always enforced: exact
 * origins, distinct frame and parent origins, and a separate cookie host. The asset prefix and entry names are checked
 * for shape only; the surface set is fixed.
 */
export function createSimHostConfiguration(input: unknown): SimHostConfiguration {
  if (!input || typeof input !== 'object')
    throw new Error('Hosted Sim needs a configuration object')
  const value = input as Partial<Record<keyof SimHostConfigurationInput, unknown>>
  if (value.allowLoopbackHttp !== undefined && typeof value.allowLoopbackHttp !== 'boolean')
    throw new Error('Hosted Sim allowLoopbackHttp must be a boolean')
  const allowLoopbackHttp = value.allowLoopbackHttp === true
  const canonical = { allowLoopbackHttp }

  const origin = canonicalBridgeOrigin(value.origin, canonical)
  if (!Array.isArray(value.parentOrigins) || value.parentOrigins.length === 0)
    throw new Error('Hosted Sim needs at least one parent origin')
  const parents = value.parentOrigins.map((item) => canonicalBridgeOrigin(item, canonical))
  if (!origin || parents.some((item) => !item) || parents.includes(origin)) {
    throw new Error('Hosted Sim needs distinct canonical frame and parent origins')
  }
  if (new Set(parents).size !== parents.length)
    throw new Error('Hosted Sim parent origins must be distinct')
  // Keep the exact-origin allowlists above and on every request. Cookies have
  // hostname scope rather than port scope, so additionally reject a shared
  // cookie host: different ports alone cannot isolate the Sim-only cookie.
  if (parents.some((parent) => new URL(parent!).hostname === new URL(origin).hostname)) {
    throw new Error('Hosted Sim requires a separate cookie host')
  }

  if (typeof value.assetPrefix !== 'string' || !ASSET_PREFIX.test(value.assetPrefix))
    throw new Error('Hosted Sim assetPrefix must be a plain path such as /assets/agent-sim/')

  const entries = value.entryFiles
  if (!entries || typeof entries !== 'object') throw new Error('Hosted Sim needs entryFiles')
  for (const key of Object.keys(entries))
    if (!(SIM_SURFACES as readonly string[]).includes(key))
      throw new Error(`Hosted Sim entryFiles names an unknown surface: ${key}`)
  const entryFiles = {} as Record<SimSurface, string>
  for (const surface of SIM_SURFACES) {
    if (!Object.hasOwn(entries, surface))
      throw new Error(`Hosted Sim entryFiles is missing the ${surface} surface`)
    const file = (entries as Record<string, unknown>)[surface]
    if (typeof file !== 'string' || !ENTRY_FILE.test(file))
      throw new Error(`Hosted Sim entry file for ${surface} must be a plain .js file name`)
    entryFiles[surface] = file
  }
  if (new Set(Object.values(entryFiles)).size !== SIM_SURFACES.length)
    throw new Error('Hosted Sim entry files must be distinct')

  return Object.freeze({
    origin: origin!,
    parentOrigins: Object.freeze(parents as string[]),
    allowLoopbackHttp,
    assetPrefix: value.assetPrefix,
    entryFiles: Object.freeze(entryFiles),
  })
}

/** The surface a private entry file belongs to, or undefined when the path is not an entry. */
export function entrySurface(config: SimHostConfiguration, path: string): SimSurface | undefined {
  return SIM_SURFACES.find((surface) => config.entryFiles[surface] === path)
}
