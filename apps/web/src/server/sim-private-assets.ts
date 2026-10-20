import type { SimPrivateAsset } from './sim-host'

/**
 * The named private location that holds the Agent Sim engine export.
 *
 * The location name is a plain identifier: not a URL, not a path and not an alias, so nothing here
 * can name a public bucket or a public prefix. The reader hands the location and the key to the
 * storage adapter and returns bytes only. It never returns a location, a URL or a redirect, so a
 * private object has no public alias and the session gate stays the only way in.
 *
 * The location is supplied by the operator that owns the private export. Nothing here chooses one.
 */

/** A plain private location name. Anything else is refused and no object is read. */
export const SIM_PRIVATE_ASSET_LOCATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type SimPrivateAssetRequest = Readonly<{ location: string; key: string }>

/** Reads one object from the named private location, or null when it is absent. */
export type SimPrivateAssetStore = (
  request: SimPrivateAssetRequest
) => Promise<SimPrivateAsset | null> | SimPrivateAsset | null

export type SimPrivateAssetReader = (path: string) => Promise<SimPrivateAsset | null>

/**
 * The storage key for a request path, or null when the path could leave the location. An absolute
 * path, a backslash, a NUL, an empty segment and a `.` or `..` segment are all refused. The host
 * applies the same rules before it reaches the reader; this is the second, independent check.
 */
export function simPrivateAssetKey(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return null
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

/**
 * The private reader for one named location. A malformed location name disables every read rather
 * than falling back to a default, so a misconfigured deployment serves no private asset at all.
 */
export function createSimPrivateAssetReader(options: {
  /** The named private location that holds the engine export. */
  location: string
  /** Reads one object from that location. */
  read: SimPrivateAssetStore
}): SimPrivateAssetReader {
  const location = options.location
  const usable = typeof location === 'string' && SIM_PRIVATE_ASSET_LOCATION.test(location)
  return async (path) => {
    if (!usable) return null
    const key = simPrivateAssetKey(path)
    if (!key) return null
    return options.read({ location, key })
  }
}
