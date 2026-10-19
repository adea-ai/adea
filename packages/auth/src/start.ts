/**
 * A provider-neutral per-request context: cookies come from the incoming
 * request and writes go to the outgoing response. It is structural so the
 * package does not depend on a server framework, and it matches the shape the
 * self-hosted Better Auth adapter consumes.
 */
export type RequestContext = Readonly<{
  getCookies(): string
  setCookie(name: string, value: string, options: CookieOptions): void
  getHeader(name: string): string | null | undefined
  getOrigin(): string
  getFramework(): string
}>

/** The lowercase `SameSite` spellings every cookie writer accepts. */
export type SameSite = 'lax' | 'none' | 'strict'

/**
 * The framework-neutral cookie contract. It accepts both the lowercase and the
 * capitalized `SameSite` spelling so a caller can forward the cookie attributes
 * a provider emitted verbatim; each adapter normalizes to its writer below.
 */
export type CookieOptions = Readonly<{
  domain?: string
  expires?: Date
  httpOnly?: boolean
  maxAge?: number
  partitioned?: boolean
  path?: string
  sameSite?: SameSite | 'Lax' | 'None' | 'Strict'
  secure?: boolean
}>

/**
 * The options TanStack Start's request writer accepts: the framework-neutral
 * fields with `sameSite` restricted to the lowercase spelling it understands.
 * `createStartRequestContext` normalizes into this shape before the writer, so
 * an uppercase `Lax`/`None`/`Strict` from a provider still serializes.
 */
export type StartCookieOptions = Readonly<{
  domain?: string
  expires?: Date
  httpOnly?: boolean
  maxAge?: number
  path?: string
  sameSite?: SameSite
  secure?: boolean
}>

export type RequestContextFramework = string

/**
 * The subset of TanStack Start's per-request helpers this adapter needs. The
 * host app injects them so the package does not depend on a server framework.
 */
export type StartRequestHelpers = Readonly<{
  getRequest(): Request
  setCookie(name: string, value: string, options: StartCookieOptions): void
}>

/**
 * Adapts TanStack Start's request storage to the auth package's
 * framework-neutral RequestContext. Mirrors the bundled Next.js adapter:
 * cookies are read from the incoming request, writes go to the outgoing
 * response, and the origin is never invented when the request omits one.
 */
export function createStartRequestContext(helpers: StartRequestHelpers): RequestContext {
  const request = helpers.getRequest()
  return {
    getCookies: () => request.headers.get('cookie') ?? '',
    setCookie: (name, value, options) => {
      helpers.setCookie(name, value, toSerializeOptions(options))
    },
    getHeader: (name) => request.headers.get(name),
    getOrigin: () =>
      request.headers.get('origin') ||
      request.headers.get('referer')?.split('/').slice(0, 3).join('/') ||
      '',
    getFramework: () => 'tanstack-start',
  }
}

/**
 * Normalizes a `SameSite` value to the lowercase spelling a cookie writer
 * accepts. The framework-neutral contract permits the capitalized form, so this
 * is the single place uppercase becomes lowercase.
 */
function normalizeSameSite(sameSite: CookieOptions['sameSite']): SameSite | undefined {
  switch (sameSite) {
    case 'lax':
    case 'Lax':
      return 'lax'
    case 'none':
    case 'None':
      return 'none'
    case 'strict':
    case 'Strict':
      return 'strict'
    default:
      return undefined
  }
}

function toSerializeOptions(options: CookieOptions): StartCookieOptions {
  const sameSite = normalizeSameSite(options.sameSite)
  return {
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(options.expires ? { expires: options.expires } : {}),
    ...(options.httpOnly !== undefined ? { httpOnly: options.httpOnly } : {}),
    ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(sameSite !== undefined ? { sameSite } : {}),
    ...(options.secure !== undefined ? { secure: options.secure } : {}),
  }
}

/**
 * Serializes a cookie the toolkit asked us to persist when the host framework
 * has no framework-native cookie jar to write into (for example a Worker entry
 * that resolves a session before the framework's request storage exists). The
 * result can be appended to a `Set-Cookie` header verbatim.
 */
export function serializeSessionCookie(
  name: string,
  value: string,
  options: CookieOptions
): string {
  const parts = [`${name}=${value}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  const sameSite = normalizeSameSite(options.sameSite)
  if (sameSite) {
    parts.push(`SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`)
  }
  if (options.partitioned) parts.push('Partitioned')
  return parts.join('; ')
}
