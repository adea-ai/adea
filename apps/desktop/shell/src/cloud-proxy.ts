// Same-origin cloud proxy for the shell's loopback server. The bundled client
// calls `/api/*` on its own origin; the shell forwards those requests to the
// canonical desktop cloud origin, so the webview never issues a cross-origin
// API call and every forwarded request still presents the trusted shell origin
// the cloud's desktop lane requires. The origin literal stays owned by
// `apps/desktop/scripts/cloud-config.mjs` (scripts/check-desktop-origins.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DESKTOP_TARGET_FILE,
  parseDesktopTarget,
  resolveShellCloudOrigin,
} from '../../scripts/cloud-config.mjs'

/**
 * The origin forwarded requests target. It is the origin the client was built
 * for, read from the target record `apps/desktop/scripts/client.mjs` persists
 * next to the client, so one build-time decision drives the client and the
 * shell alike, however the shell is launched. The shell
 * never infers a target from how it was launched:
 *
 * - no record, or a malformed one, stops the shell (fail closed);
 * - `ADEA_CLOUD_ORIGIN` may only restate the recorded origin;
 * - a build for a hosted origin outside a release build also needs
 *   `ADEA_ALLOW_HOSTED_CLOUD=true` at run time.
 */
export function resolveCloudOrigin(
  clientRoot: string,
  env: Record<string, string | undefined> = process.env
): string {
  let text: string
  try {
    text = readFileSync(join(clientRoot, DESKTOP_TARGET_FILE), 'utf8')
  } catch {
    throw new Error(
      `The desktop client has no build target (${DESKTOP_TARGET_FILE}); build it with the desktop client build`
    )
  }
  return resolveShellCloudOrigin(parseDesktopTarget(text), {
    explicit: env.ADEA_CLOUD_ORIGIN || undefined,
    allowHosted: env.ADEA_ALLOW_HOSTED_CLOUD,
  })
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
