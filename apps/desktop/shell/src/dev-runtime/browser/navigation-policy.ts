// Lane navigation policy. Navigation permits http/https only; every target —
// including each redirect hop — revalidates scheme, credentials, and resolved
// addresses before connection. Loopback is denied unless the caller proves the
// target is an Adea-owned loopback service registered on this runtime node,
// so a browsed page can never reach the shell's own privileged routes or any
// private network (Dev Runtime spec, "Browser and device lanes").
export type NavigationDecisionCode = 'navigation_blocked' | 'ssrf_blocked'

export type NavigationDecision =
  | Readonly<{ allowed: true; normalizedUrl: string }>
  | Readonly<{ allowed: false; code: NavigationDecisionCode; reason: string }>

export type LaneHostAddress = Readonly<{ address: string; family: 4 | 6 }>

export type AdeaOwnedService = Readonly<{
  /** Canonical `127.0.0.1:<port>` service identity on this runtime node. */
  host: string
  port: number
  /** Adea launch/session owner record; loopback presence alone is not proof. */
  ownerId: string
  /** Runtime session used to associate the service with a task-owned preview lane. */
  runtimeSessionId?: string
}>

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])
const URL_MAX_LENGTH = 4096
const DNS_REBINDING_RECHECK = new Set(['localhost'])

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function ipv4InCidr(address: string, network: string, bits: number): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return false
  const base = ipv4ToInt(network)
  if (base === null) return false
  if (bits === 0) return true
  const mask = (~0 << (32 - bits)) >>> 0
  return (value & mask) === (base & mask)
}

function ipv4InPrivateRange(address: string): boolean {
  return (
    ipv4InCidr(address, '0.0.0.0', 8) ||
    ipv4InCidr(address, '10.0.0.0', 8) ||
    ipv4InCidr(address, '100.64.0.0', 10) ||
    ipv4InCidr(address, '127.0.0.0', 8) ||
    ipv4InCidr(address, '169.254.0.0', 16) ||
    ipv4InCidr(address, '172.16.0.0', 12) ||
    ipv4InCidr(address, '192.0.0.0', 24) ||
    ipv4InCidr(address, '192.168.0.0', 16) ||
    ipv4InCidr(address, '198.18.0.0', 15) ||
    ipv4InCidr(address, '240.0.0.0', 4)
  )
}

function isCloudMetadataAddress(address: string): boolean {
  // Link-local carries every major provider's metadata endpoint; check the
  // normalized IPv4 half too so hexadecimal mapped forms cannot bypass it.
  const normalized = mappedIpv4FromIpv6(address) ?? address
  return normalized === '169.254.169.254' || normalized === 'fd00:ec2::254'
}

function mappedIpv4FromIpv6(address: string): string | null {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (!value.startsWith('::ffff:')) return null
  const mapped = value.slice('::ffff:'.length)
  if (mapped.includes('.')) return ipv4ToInt(mapped) === null ? null : mapped
  const groups = mapped.split(':')
  if (groups.length !== 2 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null
  const high = Number.parseInt(groups[0]!, 16)
  const low = Number.parseInt(groups[1]!, 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

function isIpv6LoopbackOrPrivate(lowerAddress: string): boolean {
  const value = lowerAddress.replace(/^\[|\]$/g, '')
  // IPv4-mapped addresses can be written as dotted decimal or compressed
  // hexadecimal (for example ::ffff:7f00:1). Normalize both forms before
  // applying the IPv4 private/link-local/loopback ranges.
  const mapped = mappedIpv4FromIpv6(value)
  if (mapped !== null) return ipv4InPrivateRange(mapped)
  if (value === '::1' || value === '::') return true
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea')) return true
  if (value.startsWith('feb')) return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  return false
}

export function isPrivateOrLoopbackAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase()
  if (trimmed.includes(':')) return isIpv6LoopbackOrPrivate(trimmed)
  return ipv4InPrivateRange(trimmed)
}

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1') return true
  if (value.includes(':')) return isIpv6LoopbackOrPrivate(value)
  return ipv4InCidr(value, '127.0.0.0', 8)
}

export type NavigationPolicyInput = Readonly<{
  url: string
  /** Resolved addresses for the URL host, supplied by the host's own resolver. */
  resolvedAddresses: readonly LaneHostAddress[]
  /** Proven Adea-owned loopback services on this runtime node. */
  ownedServices: readonly AdeaOwnedService[]
}>

/**
 * Admits or refuses one navigation hop. The host MUST call this before
 * connecting and again after every redirect with the freshly resolved
 * addresses; a hostname that re-resolves from a public to a private address
 * (DNS rebinding) is refused on the second pass.
 */
export function evaluateNavigation(input: NavigationPolicyInput): NavigationDecision {
  if (input.url.length === 0) return blocked('navigation_blocked', 'URL is empty')
  if (input.url.length > URL_MAX_LENGTH)
    return blocked('navigation_blocked', 'URL exceeds the maximum length')
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return blocked('navigation_blocked', 'URL did not parse')
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol))
    return blocked('navigation_blocked', `scheme ${parsed.protocol} is not permitted`)
  if (parsed.username || parsed.password)
    return blocked('navigation_blocked', 'URL carries embedded credentials')
  if (parsed.hostname.length === 0) return blocked('navigation_blocked', 'URL has no host')

  const hostname = parsed.hostname.toLowerCase()
  const port =
    parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    return blocked('navigation_blocked', 'URL port is out of range')

  if (DNS_REBINDING_RECHECK.has(hostname)) {
    // A literal host name and its resolved addresses must agree in kind; a
    // "localhost" that resolves to a non-loopback address is rebinding.
    const allLoopback = input.resolvedAddresses.every((entry) =>
      isPrivateOrLoopbackAddress(entry.address)
    )
    if (!allLoopback) return blocked('ssrf_blocked', 'host resolved to a non-loopback address')
  }

  const hostIsPrivate = isLoopbackHostname(hostname)
  const resolvedPrivate = input.resolvedAddresses.map((entry) => ({
    ...entry,
    private: isPrivateOrLoopbackAddress(entry.address),
  }))
  const anyPublicResolved = resolvedPrivate.some((entry) => !entry.private)
  const anyMetadata = input.resolvedAddresses.some((entry) =>
    isCloudMetadataAddress(entry.address.trim().toLowerCase())
  )

  if (!hostIsPrivate) {
    if (anyMetadata) return blocked('ssrf_blocked', 'target resolves to a cloud metadata address')
    // Public host: at least one resolved address must be public and none may
    // be private, otherwise a public name is being used to reach the LAN.
    if (resolvedPrivate.some((entry) => entry.private))
      return blocked('ssrf_blocked', 'target resolves into a private range')
    if (resolvedPrivate.length === 0)
      return blocked('navigation_blocked', 'target address did not resolve')
    if (anyPublicResolved) return allowed(parsed)
    return blocked('ssrf_blocked', 'target did not resolve to a public address')
  }

  // Private/loopback host: allowed only as a proven Adea-owned loopback
  // service on this runtime node. Presence on loopback is never authority.
  if (anyMetadata) return blocked('ssrf_blocked', 'target resolves to a cloud metadata address')
  if (port === 80 || port === 443)
    return blocked('ssrf_blocked', 'loopback web ports are never Adea-owned services')
  const owned = input.ownedServices.some(
    (service) =>
      service.port === port &&
      (service.host === hostname || isLoopbackHostname(service.host)) &&
      isLoopbackHostname(service.host)
  )
  if (!owned) return blocked('ssrf_blocked', 'loopback target is not a proven Adea-owned service')
  return allowed(parsed)
}

function allowed(parsed: URL): NavigationDecision {
  return { allowed: true, normalizedUrl: parsed.href }
}

function blocked(code: NavigationDecisionCode, reason: string): NavigationDecision {
  return { allowed: false, code, reason }
}
