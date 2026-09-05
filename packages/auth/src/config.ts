export type AuthEnvironment = Record<string, string | undefined>

export type AuthConfig = Readonly<{
  baseUrl: string
  cookieSecret: string
  sessionDataTtl: number
  trustedOrigins: readonly string[]
}>

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function normalizeTrustedTarget(value: string): string {
  if (value.includes('*')) {
    throw new Error('Auth trusted origins must not contain a wildcard')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid auth trusted origin: ${value}`)
  }

  if (url.username || url.password) {
    throw new Error('Auth trusted origins must not contain credentials')
  }
  if (url.hash || url.search) {
    throw new Error('Auth trusted origins must not contain query strings or fragments')
  }

  if (url.protocol === 'https:') {
    return url.origin
  }
  if (url.protocol === 'http:' && isLoopback(url.hostname)) {
    return url.origin
  }
  if (url.protocol === 'agent-hq:') {
    return `${url.protocol}//${url.host}${url.pathname}`
  }

  throw new Error('Auth trusted origins require HTTPS, loopback HTTP, or agent-hq callbacks')
}

export function readAuthConfig(environment: AuthEnvironment = process.env): AuthConfig {
  const rawBaseUrl = environment.NEON_AUTH_BASE_URL
  if (!rawBaseUrl) throw new Error('NEON_AUTH_BASE_URL is required')

  let baseUrl: URL
  try {
    baseUrl = new URL(rawBaseUrl)
  } catch {
    throw new Error('NEON_AUTH_BASE_URL must be a valid URL')
  }
  if (
    baseUrl.protocol !== 'https:' &&
    !(baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname))
  ) {
    throw new Error('NEON_AUTH_BASE_URL must use HTTPS outside loopback development')
  }

  const cookieSecret = environment.NEON_AUTH_COOKIE_SECRET
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('NEON_AUTH_COOKIE_SECRET must contain at least 32 characters')
  }

  const rawOrigins = environment.AUTH_TRUSTED_ORIGINS
  if (!rawOrigins) throw new Error('AUTH_TRUSTED_ORIGINS is required')
  const deploymentOrigins = [environment.VERCEL_URL, environment.VERCEL_BRANCH_URL]
    .filter((value): value is string => Boolean(value))
    .map((value) => (value.includes('://') ? value : `https://${value}`))
  const trustedOrigins = [
    ...new Set(
      [...rawOrigins.split(','), ...deploymentOrigins].map((value) =>
        normalizeTrustedTarget(value.trim())
      )
    ),
  ]
  if (trustedOrigins.length === 0) throw new Error('AUTH_TRUSTED_ORIGINS must not be empty')

  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    cookieSecret,
    // The SDK requires a positive value. One second is its effective no-cache setting;
    // refresh and revocation-sensitive lookups additionally bypass the cache explicitly.
    sessionDataTtl: 1,
    trustedOrigins: Object.freeze(trustedOrigins),
  })
}
