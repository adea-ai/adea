import type {
  SimEntitlementVerdict,
  SimSessionExchangeResponse,
  SimSessionRecord,
  SimSurface,
} from '@adea-ai/spatial/sim-bridge'
import {
  createSimHostConfiguration,
  entrySurface,
  isRetiredEntry,
  type SimHostConfigurationInput,
} from './sim-host-config'
import { simJsonBody } from './sim-http'

export type SimPrivateAsset = { body: BodyInit; contentType: string }

/**
 * The trusted context of a live session row. The store resolves it from the stored row after the digest,
 * expiry and revocation checks. Nothing in the request can supply or change it.
 */
export type SimTrustedSession = SimSessionRecord & Readonly<{ workspaceId: string }>

/** The context every private asset read carries, so a read cannot target another workspace or surface. */
export type SimAssetContext = Readonly<{ workspaceId: string; surface: SimSurface }>

/**
 * Separately hosted HTTP boundary. Asset storage never has a public bypass. The configuration is validated
 * before anything is served; a missing or malformed value throws instead of falling back to a default.
 */
export function createSimHost(
  options: SimHostConfigurationInput & {
    frameScript: string
    exchange: (body: unknown) => Promise<SimSessionExchangeResponse>
    session: (value: string) => Promise<SimTrustedSession | null>
    /** Explicit entitlement for the workspace and surface. Anything but 'entitled' serves no private asset. */
    entitlement: (
      context: SimAssetContext
    ) => Promise<SimEntitlementVerdict> | SimEntitlementVerdict
    readAsset: (path: string, context: SimAssetContext) => Promise<SimPrivateAsset | null>
    now?: () => number
  }
) {
  const config = createSimHostConfiguration(options)
  if (typeof options.frameScript !== 'string') throw new Error('Hosted Sim needs a frame script')
  if (typeof options.entitlement !== 'function')
    throw new Error('Hosted Sim needs an entitlement boundary')
  const origin = config.origin
  const parents = config.parentOrigins
  const headers = {
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors ${parents.join(' ')}`,
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.origin !== origin) return new Response(null, { status: 403, headers })
    if (request.method === 'POST' && url.pathname === '/session') {
      if (request.headers.get('origin') !== origin)
        return new Response(null, { status: 403, headers })
      const body = await simJsonBody(request)
      try {
        const exchanged = await options.exchange(body)
        const response = json(exchanged.body)
        if (exchanged.setCookie) response.headers.set('set-cookie', exchanged.setCookie)
        return response
      } catch {
        return json({ status: 'unavailable' }, 503)
      }
    }
    if (request.method !== 'GET') return new Response(null, { status: 405, headers })
    if (url.pathname === '/frame')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Sim</title><link rel="stylesheet" href="/frame.css"></head><body><div id="sim"></div><script type="module" src="/frame.js"></script></body></html>',
        { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } }
      )
    if (url.pathname === '/frame.css')
      return new Response('html,body,#sim{width:100%;height:100%;margin:0;overflow:hidden}', {
        headers: { ...headers, 'content-type': 'text/css' },
      })
    if (url.pathname === '/frame.js')
      return new Response(options.frameScript, {
        headers: { ...headers, 'content-type': 'text/javascript' },
      })
    if (url.pathname === '/configuration')
      return json({
        parentOrigins: parents,
        allowLoopbackHttp: config.allowLoopbackHttp,
        assetPrefix: config.assetPrefix,
        entryFiles: config.entryFiles,
      })
    if (!url.pathname.startsWith(config.assetPrefix))
      return new Response(null, { status: 404, headers })
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((value) => value.trim())
    const values = cookies
      .filter((value) => value.startsWith('__Host-adea-sim='))
      .map((value) => value.slice('__Host-adea-sim='.length))
    if (values.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(values[0]!))
      return new Response(null, { status: 401, headers })
    try {
      const session = await options.session(values[0]!)
      const at = (options.now ?? Date.now)()
      if (
        !session ||
        typeof session.workspaceId !== 'string' ||
        session.workspaceId.length === 0 ||
        !Number.isFinite(at) ||
        !Number.isFinite(session.expiresAt) ||
        session.expiresAt <= at
      )
        return new Response(null, { status: 401, headers })
      // Only the stored row decides the workspace and surface. Query strings and headers are never consulted.
      const context: SimAssetContext = {
        workspaceId: session.workspaceId,
        surface: session.surface,
      }
      const path = decodeURIComponent(url.pathname.slice(config.assetPrefix.length))
      if (
        !path ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((part) => part === '.' || part === '..' || part === '')
      )
        return new Response(null, { status: 404, headers })
      const surface = entrySurface(config, path)
      if (surface && surface !== session.surface)
        return new Response(null, { status: 403, headers })
      // A renamed surface's old entry must not stay reachable as an ordinary shared asset.
      if (isRetiredEntry(config, path)) return new Response(null, { status: 404, headers })
      // No private read happens unless the injected entitlement says the workspace and surface may launch.
      const verdict = await options.entitlement(context)
      if (verdict !== 'entitled')
        return new Response(null, {
          status: verdict === 'not_entitled' ? 403 : verdict === 'unauthenticated' ? 401 : 503,
          headers,
        })
      // The entitlement check can outlast the session, so the clock is read again before any private read.
      const confirmed = (options.now ?? Date.now)()
      if (!Number.isFinite(confirmed) || session.expiresAt <= confirmed)
        return new Response(null, { status: 401, headers })
      const asset = await options.readAsset(path, context)
      return asset
        ? new Response(asset.body, { headers: { ...headers, 'content-type': asset.contentType } })
        : new Response(null, { status: 404, headers })
    } catch {
      return new Response(null, { status: 503, headers })
    }
  }
}
