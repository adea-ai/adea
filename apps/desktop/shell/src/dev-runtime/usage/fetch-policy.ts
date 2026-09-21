// Fixed-endpoint fetch policy for official-API usage adapters (#424).
//
// The spec forbids the donor's configurable usage URL (t3code's CLI-proxy
// endpoint can receive a bearer management key without scheme/host/private-
// network/redirect policy — explicitly not portable). Every endpoint here is
// fixed by the adapter author or matched against an explicit trusted-host
// allowlist; non-loopback targets require HTTPS; DNS results are revalidated
// against private, link-local, and cloud-metadata ranges; and redirects are
// refused (the transport must fetch with `redirect: 'error'`). Credentials
// are host scoped: the bearer key is attached only after the endpoint and
// every resolved address passed this guard, so it can never reach a host the
// policy did not admit.

export type TrustedEndpointPolicy = Readonly<{
  /** Fixed reviewed endpoint (exact origin match when set). */
  fixedEndpoint?: string
  /** Explicit trusted-host allowlist (exact host names). */
  allowedHosts?: readonly string[]
}>

const PRIVATE_V4 = [
  { cidr: '10.0.0.0', bits: 8 },
  { cidr: '172.16.0.0', bits: 12 },
  { cidr: '192.168.0.0', bits: 16 },
  { cidr: '127.0.0.0', bits: 8 },
  { cidr: '169.254.0.0', bits: 16 },
  { cidr: '0.0.0.0', bits: 8 },
  { cidr: '100.64.0.0', bits: 10 },
]

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number.parseInt(part ?? '', 10)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function inCidr(address: number, cidr: string, bits: number): boolean {
  const base = ipv4ToInt(cidr)
  if (base === null) return false
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
  return (address & mask) === (base & mask)
}

/** Loopback (or the node's own unspecified address) is the only private
 * range a usage endpoint may legitimately target — the desktop shell itself
 * is loopback-only — and even then only over http for an explicit test
 * fixture. Everything else private is denied. */
export function isDeniedAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  if (value === '::1' || value === '127.0.0.1') return false
  if (value.includes(':')) {
    // IPv6: deny link-local (fe80::/10), unique-local (fc00::/7), and the
    // IPv4-mapped metadata forms; everything else public passes.
    if (
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb')
    )
      return true
    if (value.startsWith('fc') || value.startsWith('fd')) return true
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice('::ffff:'.length)
      const asInt = ipv4ToInt(mapped)
      if (asInt !== null) return PRIVATE_V4.some((range) => inCidr(asInt, range.cidr, range.bits))
    }
    return false
  }
  const asInt = ipv4ToInt(value)
  if (asInt === null) return true
  return PRIVATE_V4.some((range) => inCidr(asInt, range.cidr, range.bits))
}

export type EndpointAdmission =
  | { ok: true; url: URL }
  | { ok: false; code: 'remote_host_untrusted' | 'ssrf_blocked'; message: string }

/**
 * Admit a fixed/allowlisted HTTPS (or explicit loopback) endpoint. Returns a
 * typed refusal instead of throwing so adapters can report the failure
 * without breaking Dev View.
 */
export function admitUsageEndpoint(
  rawEndpoint: string,
  policy: TrustedEndpointPolicy,
  resolved?: readonly { address: string; family: 4 | 6 }[]
): EndpointAdmission {
  let url: URL
  try {
    url = new URL(rawEndpoint)
  } catch {
    return { ok: false, code: 'remote_host_untrusted', message: 'usage endpoint is not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      code: 'remote_host_untrusted',
      message: `usage endpoint scheme ${url.protocol} is not permitted`,
    }
  }
  const host = url.hostname.toLowerCase()
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (url.protocol === 'http:' && !isLoopback) {
    return {
      ok: false,
      code: 'ssrf_blocked',
      message: 'usage endpoints off loopback require HTTPS',
    }
  }
  if (policy.fixedEndpoint !== undefined) {
    let fixed: URL
    try {
      fixed = new URL(policy.fixedEndpoint)
    } catch {
      return {
        ok: false,
        code: 'remote_host_untrusted',
        message: 'the configured fixed endpoint is not a URL',
      }
    }
    if (url.origin !== fixed.origin) {
      return {
        ok: false,
        code: 'remote_host_untrusted',
        message: 'usage endpoint does not match the reviewed fixed endpoint',
      }
    }
  } else if (policy.allowedHosts !== undefined) {
    if (!policy.allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
      return {
        ok: false,
        code: 'remote_host_untrusted',
        message: `usage host ${host} is not on the trusted allowlist`,
      }
    }
  } else {
    return {
      ok: false,
      code: 'remote_host_untrusted',
      message: 'usage adapters require a fixed endpoint or an explicit allowlist',
    }
  }
  // DNS revalidation: every resolved address must be public. Empty results
  // fail closed — an unresolvable host is never silently allowed.
  for (const entry of resolved ?? []) {
    if (isDeniedAddress(entry.address)) {
      return {
        ok: false,
        code: 'ssrf_blocked',
        message: `usage endpoint resolves to a denied address (${entry.address})`,
      }
    }
  }
  if (resolved !== undefined && resolved.length === 0 && !isLoopback) {
    return {
      ok: false,
      code: 'ssrf_blocked',
      message: 'usage endpoint did not resolve to any address',
    }
  }
  return { ok: true, url }
}
