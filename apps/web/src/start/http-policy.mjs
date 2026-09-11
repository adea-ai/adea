/**
 * Framework-free HTTP policy for dynamic worker responses. Static assets are
 * served by the Cloudflare asset layer and never reach the worker, so every
 * response produced here stays private/no-store and unindexed, mirroring the
 * migration-era gateway contract.
 */
export const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

/** Internal request header carrying the entry decision into the document render. */
export const ENTRY_ACCESS_HEADER = 'x-adea-entry-access'

export const ENTRY_ACCESS_VALUES = ['allowed', 'denied']

/** @param {number} status @param {string} message @param {string} [allow] */
export function failure(status, message, allow) {
  const headers = { ...PRIVATE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }
  if (allow) headers.Allow = allow
  return new Response(message, { status, headers })
}

/**
 * The root document keeps its migration-era HTTP contract: GET/HEAD only.
 * @param {Request} request
 * @returns {Response | null} a failure response, or null when the request may proceed
 */
export function rootDocumentPolicy(request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/' && request.method !== 'GET' && request.method !== 'HEAD') {
    return failure(405, 'Method not allowed', 'GET, HEAD')
  }
  return null
}

/**
 * The entry decision must never be supplied by the caller. Strip any inbound
 * copy before the handler sees the request.
 * @param {Request} request
 * @returns {Request}
 */
export function stripEntryAccessHeader(request) {
  if (!request.headers.has(ENTRY_ACCESS_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(ENTRY_ACCESS_HEADER)
  return new Request(request, { headers })
}

/** @param {Request} request @param {'allowed' | 'denied'} access */
export function withEntryAccess(request, access) {
  const headers = new Headers(request.headers)
  headers.set(ENTRY_ACCESS_HEADER, access)
  return new Request(request, { headers })
}

/** @param {Response} response @param {Request} request */
export async function finalizeDynamicResponse(response, request) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value)
  if (request.method === 'HEAD') {
    await response.body?.cancel().catch(() => undefined)
    return new Response(null, { status: response.status, headers })
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
