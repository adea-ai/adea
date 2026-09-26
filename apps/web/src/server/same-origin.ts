/**
 * Same-origin admission for browser-reachable routes.
 *
 * The rule is the same one the desktop workspace boundary already follows
 * (`trustedDesktopWorkspaceRequest`): a request's `Origin` is compared against
 * origins the SERVER already knows. It is never compared against origins
 * rebuilt from request headers.
 *
 * That distinction is the whole point. `Host` and `X-Forwarded-Host` are
 * supplied by the caller, so an allow set built from them lets a cross-origin
 * caller vouch for itself — `Origin: https://evil.example` with
 * `X-Forwarded-Host: evil.example` and `X-Forwarded-Proto: https` would be
 * accepted by any check that trusted those headers, defeating the CSRF
 * protection it was written to provide. `requestUrl.origin` is safe to use: it
 * is the origin the runtime resolved the request to, not a header the caller
 * chose, and a caller that forges `Host` still lands on the same server.
 */

/** Configured trusted origins, when the deployment names any. */
function configuredTrustedOrigins(
  environment: Record<string, string | undefined> = process.env
): string[] {
  const raw = environment.DESKTOP_AUTH_TRUSTED_ORIGINS ?? environment.AUTH_TRUSTED_ORIGINS ?? ''
  const origins: string[] = []
  for (const entry of raw.split(',')) {
    const value = entry.trim()
    if (!value) continue
    try {
      origins.push(new URL(value).origin)
    } catch {
      // A malformed configured origin is ignored rather than widening the set.
    }
  }
  return origins
}

export function isSameOriginRequest(
  request: Request,
  requestUrl: URL,
  environment: Record<string, string | undefined> = process.env
): boolean {
  const header = request.headers.get('origin')
  if (!header) return false
  let presented: string
  try {
    presented = new URL(header).origin
  } catch {
    return false
  }
  const allowed = new Set<string>([requestUrl.origin, ...configuredTrustedOrigins(environment)])
  return allowed.has(presented)
}
