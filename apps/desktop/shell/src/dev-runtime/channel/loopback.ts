// Trusted-origin gate for the shell's loopback surface (threat model TM-001).
//
// Loopback presence is never authority: a DNS-rebinding page arrives with a
// foreign Host, and a cross-origin browser page arrives with a foreign Origin
// and Sec-Fetch-Site. Both are refused before any channel or command logic
// runs, so the only browser that can reach the channel is the app's own
// single-origin window.

export type LoopbackRequestContext = {
  /** The `Host` request header, e.g. `127.0.0.1:4789`. */
  host?: string | null
  /** The `Origin` request header; absent for non-browser callers. */
  origin?: string | null
  /** The `Sec-Fetch-Site` request header when the agent sends one. */
  secFetchSite?: string | null
}

export type TrustedLoopbackPolicy = {
  /** The host:port the shell binds, e.g. `127.0.0.1:4789`. */
  shellHost: string
  /** The shell origin, e.g. `http://127.0.0.1:4789`. */
  shellOrigin: string
}

/**
 * True only when the request came from the app's own origin. A missing
 * `Origin` is intentionally not trusted: loopback reachability and knowledge
 * of a bootstrap token are not enough to authenticate a local process. The
 * packaged browser window supplies `Origin` for fetch, EventSource, and
 * WebSocket requests.
 */
export function isTrustedLoopbackRequest(
  request: LoopbackRequestContext,
  policy: TrustedLoopbackPolicy
): boolean {
  if (request.host !== policy.shellHost) return false
  if (request.origin !== policy.shellOrigin) return false
  if (request.secFetchSite !== undefined && request.secFetchSite !== null) {
    if (request.secFetchSite !== 'same-origin' && request.secFetchSite !== 'none') return false
  }
  return true
}
