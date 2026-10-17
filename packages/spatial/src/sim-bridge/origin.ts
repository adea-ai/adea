/**
 * Exact-origin allowlist for the hosted Agent Sim frame.
 *
 * An origin is allowed only by an exact string match against a canonical `scheme://host[:port]`.
 * There are no wildcards, no suffix or subdomain matching, and `null`/opaque origins never match.
 * Loopback `http:` origins are accepted only when the caller opts in explicitly for local
 * development. Being on the allowlist (loopback included) says where a frame was served from; it
 * never proves an official desktop identity or an entitlement.
 */

export type OriginAllowlist = Readonly<{
  /** Canonical origins in the order given. */
  origins: readonly string[]
  has(origin: unknown): boolean
}>

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** The canonical origin when `value` is exactly one, otherwise null. */
export function canonicalBridgeOrigin(
  value: unknown,
  options: Readonly<{ allowLoopbackHttp?: boolean }> = {}
): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // `origin` is "null" for opaque schemes; requiring equality also rejects paths, queries,
  // credentials, trailing slashes and non-canonical spellings.
  if (url.origin !== value) return null
  // The URL parser tolerates `*` and similar in a host; an allowlist entry must be a real host.
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])$/.test(url.hostname)) return null
  if (url.protocol === 'https:') return value
  if (
    url.protocol === 'http:' &&
    options.allowLoopbackHttp === true &&
    LOOPBACK_HOSTS.includes(url.hostname)
  )
    return value
  return null
}

export function createOriginAllowlist(
  origins: readonly unknown[],
  options: Readonly<{ allowLoopbackHttp?: boolean }> = {}
): OriginAllowlist {
  if (origins.length === 0) throw new Error('The Agent Sim bridge needs at least one origin')
  const canonical = origins.map((origin) => {
    const value = canonicalBridgeOrigin(origin, options)
    if (value === null) throw new Error('Agent Sim bridge origins must be exact canonical origins')
    return value
  })
  const unique = [...new Set(canonical)]
  return Object.freeze({
    origins: Object.freeze(unique),
    has: (origin: unknown) => typeof origin === 'string' && unique.includes(origin),
  })
}
