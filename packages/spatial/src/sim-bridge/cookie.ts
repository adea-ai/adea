/**
 * The sim-only session cookie set by the Agent Sim origin after a successful code exchange.
 *
 * It is `__Host-` prefixed (Secure, Path=/, no Domain), HttpOnly so no script on either origin can
 * read it, and `SameSite=None; Partitioned` because the sim is embedded as a third-party frame: the
 * browser keys it to the embedding Adea site and never sends it in any other context. It
 * authorizes the sim origin's assets only; it is not an Adea account session and never appears in a
 * response body or a bridge message.
 */

export const SIM_SESSION_COOKIE_NAME = '__Host-adea-sim'
export const MAX_SIM_SESSION_SECONDS = 3600

const SESSION_VALUE = /^[A-Za-z0-9_-]{32,256}$/

export function buildSimSessionSetCookie(value: string, maxAgeSeconds: number): string {
  if (!SESSION_VALUE.test(value)) throw new Error('Invalid Agent Sim session value')
  return setCookie(value, boundedMaxAge(maxAgeSeconds))
}

/** Expires the session on the client. */
export function buildSimSessionClearCookie(): string {
  return setCookie('', 0)
}

function boundedMaxAge(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SIM_SESSION_SECONDS)
    throw new Error('Agent Sim session lifetime out of range')
  return seconds
}

function setCookie(value: string, maxAge: number): string {
  return [
    `${SIM_SESSION_COOKIE_NAME}=${value}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=None',
    'Partitioned',
  ].join('; ')
}

/** Every way a `Set-Cookie` header departs from the contract; empty means it conforms. */
export function simSessionCookieViolations(header: string): readonly string[] {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
  const violations: string[] = []
  if (!pair.startsWith(`${SIM_SESSION_COOKIE_NAME}=`)) violations.push('name')
  const names = new Map<string, string>()
  for (const attribute of attributes) {
    const index = attribute.indexOf('=')
    const key = (index === -1 ? attribute : attribute.slice(0, index)).toLowerCase()
    if (names.has(key)) violations.push(`duplicate:${key}`)
    names.set(key, index === -1 ? '' : attribute.slice(index + 1))
  }
  if (!names.has('secure')) violations.push('secure')
  if (!names.has('httponly')) violations.push('httponly')
  if (!names.has('partitioned')) violations.push('partitioned')
  if (names.get('path') !== '/') violations.push('path')
  if (names.has('domain')) violations.push('domain')
  if (names.get('samesite')?.toLowerCase() !== 'none') violations.push('samesite')
  const maxAge = names.get('max-age')
  if (maxAge === undefined || !/^\d+$/.test(maxAge) || Number(maxAge) > MAX_SIM_SESSION_SECONDS)
    violations.push('max-age')
  if (names.has('expires')) violations.push('expires')
  return violations
}

/**
 * The session value from a request's `Cookie` header, or null unless exactly one sim cookie of
 * the right shape is present (a duplicate is refused rather than guessed between).
 */
export function readSimSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  const values = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIM_SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(SIM_SESSION_COOKIE_NAME.length + 1))
  const [only] = values
  return values.length === 1 && only !== undefined && SESSION_VALUE.test(only) ? only : null
}
