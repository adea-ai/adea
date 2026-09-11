import 'server-only'

import type { CookieOptions, RequestContext } from '@neondatabase/auth/server'

export type { RequestContext } from '@neondatabase/auth/server'

/**
 * The subset of TanStack Start's per-request helpers this adapter needs. The
 * host app injects them so the package does not depend on a server framework.
 */
export type StartRequestHelpers = Readonly<{
  getRequest(): Request
  setCookie(name: string, value: string, options: CookieOptions): void
}>

/**
 * Adapts TanStack Start's request storage to the Neon Auth toolkit's
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

type SerializeOptions = Readonly<{
  domain?: string
  expires?: Date
  httpOnly?: boolean
  maxAge?: number
  path?: string
  sameSite?: CookieOptions['sameSite']
  secure?: boolean
}>

function toSerializeOptions(options: CookieOptions): SerializeOptions {
  return {
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(options.expires ? { expires: options.expires } : {}),
    ...(options.httpOnly !== undefined ? { httpOnly: options.httpOnly } : {}),
    ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.sameSite !== undefined ? { sameSite: options.sameSite } : {}),
    ...(options.secure !== undefined ? { secure: options.secure } : {}),
  }
}
