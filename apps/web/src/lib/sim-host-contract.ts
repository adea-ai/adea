/**
 * The public part of the hosted Sim configuration: where the private assets live and what each surface's entry file
 * is called. The server publishes it at `/configuration`; the frame bootstrap consumes it. Names are not secret; the
 * asset contents stay session-gated. Browser-safe: no imports, so both sides validate with the same rules.
 */
export const SIM_SURFACES = ['hq', 'room-designer', 'character-designer'] as const
export type SimSurface = (typeof SIM_SURFACES)[number]

export type SimHostContract = Readonly<{
  assetPrefix: string
  entryFiles: Readonly<Record<SimSurface, string>>
}>

export const SIM_ASSET_PREFIX = /^\/(?:[a-z0-9][a-z0-9-]*\/){1,4}$/
export const SIM_ENTRY_FILE = /^[a-z0-9][a-z0-9-]{0,62}\.js$/

/** Returns the contract when it is complete and well-formed, otherwise null. Never falls back to defaults. */
export function parseSimHostContract(value: unknown): SimHostContract | null {
  if (!value || typeof value !== 'object') return null
  const { assetPrefix, entryFiles } = value as { assetPrefix?: unknown; entryFiles?: unknown }
  if (typeof assetPrefix !== 'string' || !SIM_ASSET_PREFIX.test(assetPrefix)) return null
  if (!entryFiles || typeof entryFiles !== 'object') return null
  const files = {} as Record<SimSurface, string>
  for (const surface of SIM_SURFACES) {
    if (!Object.hasOwn(entryFiles, surface)) return null
    const file = (entryFiles as Record<string, unknown>)[surface]
    if (typeof file !== 'string' || !SIM_ENTRY_FILE.test(file)) return null
    files[surface] = file
  }
  if (new Set(Object.values(files)).size !== SIM_SURFACES.length) return null
  return Object.freeze({ assetPrefix, entryFiles: Object.freeze(files) })
}
