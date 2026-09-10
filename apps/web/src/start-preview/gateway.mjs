/** @typedef {(request: Request) => Promise<Response> | Response} FetchHandler */

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}
const TRANSPORT_HEADERS = [
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/** @param {string} path */
export function isLegacyPath(path) {
  return (
    path === '/icon.svg' ||
    ['/api', '/auth', '/_next'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
}

/** @param {Response} response */
function privateResponse(response) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value)
  // Response bodies (including event streams) are passed through, not buffered.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** @param {number} status @param {string} message */
function failure(status, message) {
  return new Response(message, {
    status,
    headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Service bindings preserve the public request URL. Do not change Cookie,
 * Authorization, Origin, Referer, or the OAuth query string. In particular,
 * never replace a missing/hostile Origin with a trusted one.
 * @param {Request} request
 * @param {string} [gatePath]
 */
function backendRequest(request, gatePath) {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  const connectionTokens = (headers.get('connection') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    connectionTokens.some((key) =>
      ['cookie', 'authorization', 'origin', 'referer', 'host'].includes(key.toLowerCase())
    )
  ) {
    throw new Error('Invalid connection header')
  }
  for (const key of [...TRANSPORT_HEADERS, ...connectionTokens]) headers.delete(key)
  headers.set('host', url.host)
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1))
  if (gatePath) {
    url.pathname = gatePath
    url.search = ''
    headers.set('accept', 'application/json')
    headers.delete('content-length')
    headers.delete('content-type')
    return new Request(url, { method: 'GET', headers, redirect: 'manual', signal: request.signal })
  }
  return new Request(request, { headers, redirect: 'manual' })
}

/**
 * Bounded, fail-closed gate parser. The response contains only an access enum;
 * do not serialize a session, email address, or workspace bootstrap into HTML.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<'allowed' | 'sign-in' | 'denied'>}
 */
async function readGate(response, signal) {
  signal.throwIfAborted()
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  if (type !== 'application/json' || !response.body) throw new Error('Invalid entry gate')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > 1024) throw new Error('Entry gate exceeded limit')
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const data = JSON.parse(new TextDecoder().decode(bytes))
  const access = data?.access
  const expected =
    access === 'allowed' ? 200 : access === 'sign-in' ? 401 : access === 'denied' ? 403 : 0
  if (response.status !== expected) throw new Error('Entry gate denied or invalid')
  return access
}

/**
 * Stage-one gateway: Start renders the workspace; Next retains authenticated
 * APIs and auth documents. The binding must target an ISOLATED preview backend.
 * No client-controlled upstream URL, credential translation, or cache exists.
 * @param {{ backend?: FetchHandler, assets?: FetchHandler, application: FetchHandler, gateTimeoutMs?: number }} handlers
 * @returns {FetchHandler}
 */
export function createPreviewGateway({ backend, assets, application, gateTimeoutMs = 5000 }) {
  return async function fetchPreview(request) {
    const path = new URL(request.url).pathname
    if (request.headers.get('upgrade')) return failure(426, 'WebSocket preview is not supported')
    if (isLegacyPath(path)) {
      if (!backend) return failure(503, 'Preview backend is not configured')
      try {
        const upstream = await backend(backendRequest(request))
        // Next auth assets are immutable; do not cache auth or API responses.
        return path.startsWith('/_next/static/') ? upstream : privateResponse(upstream)
      } catch {
        return failure(503, 'Preview backend is unavailable')
      }
    }
    if (path !== '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return failure(405, 'Method not allowed')
      // Stage one has only the root UI route. No implicit server-function or
      // prerendered-SPA fallback is allowed to bypass the entry check.
      if (!assets) return failure(404, 'Not found')
      try {
        const response = await assets(request)
        if (response.status === 404) return failure(404, 'Not found')
        const headers = new Headers(response.headers)
        headers.set('X-Robots-Tag', PRIVATE_HEADERS['X-Robots-Tag'])
        if (path.startsWith('/start-assets/'))
          headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        return new Response(response.body, { status: response.status, headers })
      } catch {
        return failure(503, 'Preview assets are unavailable')
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const response = failure(405, 'Method not allowed')
      response.headers.set('Allow', 'GET, HEAD')
      return response
    }
    if (!backend) return failure(503, 'Preview backend is not configured')
    try {
      const gateRequest = backendRequest(request, '/api/web-entry')
      const controller = new AbortController()
      const signal = AbortSignal.any([request.signal, controller.signal])
      let timer
      const timeout = new Promise((/** @type {(value: never) => void} */ _, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Entry gate timed out'))
        }, gateTimeoutMs)
      })
      let result
      try {
        result = await Promise.race([
          Promise.resolve(backend(new Request(gateRequest, { signal }))).then(async (gate) => ({
            cookies: gate.headers.getSetCookie(),
            access: await readGate(gate, signal),
          })),
          timeout,
        ])
      } finally {
        clearTimeout(timer)
      }
      const { cookies, access } = result
      let response
      if (access === 'sign-in') {
        response = new Response(null, { status: 307, headers: { Location: '/auth/sign-in' } })
      } else if (access === 'denied') {
        // Preserve the existing early-access document rather than inventing a
        // second authorization UX. A changed session is rechecked by Next.
        response = await backend(backendRequest(request))
      } else {
        response = await application(request)
      }
      response = privateResponse(response)
      for (const cookie of cookies) response.headers.append('Set-Cookie', cookie)
      if (request.method === 'HEAD') {
        await response.body?.cancel().catch(() => {})
        return new Response(null, { status: response.status, headers: response.headers })
      }
      return response
    } catch {
      return failure(503, 'Workspace entry is temporarily unavailable')
    }
  }
}
