// Same-origin cloud proxy for the shell's loopback server. The bundled client
// calls `/api/*` on its own origin; the shell forwards those requests to the
// canonical desktop cloud origin, so the webview never issues a cross-origin
// API call and every forwarded request still presents the trusted shell origin
// the cloud's desktop lane requires. The origin literal stays owned by
// `apps/desktop/scripts/cloud-config.mjs` (scripts/check-desktop-origins.mjs).
import { DEFAULT_CLOUD_ORIGIN } from '../../scripts/cloud-config.mjs'

/**
 * The origin forwarded requests target. `ADEA_CLOUD_ORIGIN` re-points it at a
 * local stack for development, mirroring `apps/desktop/scripts/client.mjs`.
 */
export function resolveCloudOrigin(env: Record<string, string | undefined> = process.env): string {
  const value = env.ADEA_CLOUD_ORIGIN
  if (!value) return DEFAULT_CLOUD_ORIGIN
  const url = new URL(value)
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ADEA_CLOUD_ORIGIN must be a bare origin')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('ADEA_CLOUD_ORIGIN must use HTTPS (or loopback HTTP)')
  }
  return url.origin
}

/** Headers that never travel between the shell process and the cloud. */
const DROPPED_REQUEST_HEADERS = [
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'host',
  'referer',
  'te',
  'upgrade',
] as const
const DROPPED_RESPONSE_HEADERS = [
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
] as const

export function cloudProxyRequest(
  url: URL,
  incomingHeaders: Headers,
  cloudOrigin: string,
  shellOrigin: string
): { target: string; headers: Headers } {
  const headers = new Headers(incomingHeaders)
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)
  // The cloud's desktop lane only answers requests that present a trusted
  // shell origin; same-origin GETs carry no Origin header, so the proxy
  // states the one it serves.
  headers.set('origin', shellOrigin)
  return { target: `${cloudOrigin}${url.pathname}${url.search}`, headers }
}

export async function proxyCloudRequest(
  request: Request,
  cloudOrigin: string,
  shellOrigin: string
): Promise<Response> {
  const { target, headers } = cloudProxyRequest(
    new URL(request.url),
    request.headers,
    cloudOrigin,
    shellOrigin
  )
  // Propagate client aborts so a closed event stream does not leak the
  // upstream connection.
  const upstreamAbort = new AbortController()
  request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true })
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer(),
      redirect: 'follow',
      signal: upstreamAbort.signal,
    })
    const responseHeaders = new Headers(upstream.headers)
    for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name)
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch {
    return Response.json(
      { code: 'cloud_unreachable', message: 'Adea cloud is unreachable' },
      { status: 502 }
    )
  }
}
