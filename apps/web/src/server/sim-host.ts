import type { SimSessionExchangeResponse, SimSessionRecord } from '@adea-ai/spatial/sim-bridge'
import {
  createSimHostConfiguration,
  entrySurface,
  isRetiredEntry,
  type SimHostConfigurationInput,
} from './sim-host-config'
import { simJsonBody } from './sim-http'

export type SimPrivateAsset = { body: BodyInit; contentType: string }

/**
 * Separately hosted HTTP boundary. Asset storage never has a public bypass. The configuration is validated
 * before anything is served; a missing or malformed value throws instead of falling back to a default.
 */
export function createSimHost(
  options: SimHostConfigurationInput & {
    frameScript: string
    exchange: (body: unknown) => Promise<SimSessionExchangeResponse>
    session: (value: string) => Promise<SimSessionRecord | null>
    readAsset: (path: string) => Promise<SimPrivateAsset | null>
    now?: () => number
  }
) {
  const config = createSimHostConfiguration(options)
  if (typeof options.frameScript !== 'string') throw new Error('Hosted Sim needs a frame script')
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
        !Number.isFinite(at) ||
        !Number.isFinite(session.expiresAt) ||
        session.expiresAt <= at
      )
        return new Response(null, { status: 401, headers })
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
      const asset = await options.readAsset(path)
      return asset
        ? new Response(asset.body, { headers: { ...headers, 'content-type': asset.contentType } })
        : new Response(null, { status: 404, headers })
    } catch {
      return new Response(null, { status: 503, headers })
    }
  }
}
