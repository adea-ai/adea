import {
  canonicalBridgeOrigin,
  parseSimLaunchRequest,
  type SimLaunchIssueResult,
} from '@adea-ai/spatial/sim-bridge'

export async function simJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return null
  }
}

const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' },
  })

/** HTTP composition around an authoritative issuer, never an entitlement decision itself. */
export function createSimApi(options: {
  frameOrigin?: string | null
  allowLoopbackHttp?: boolean
  trustedHostOrigins: readonly string[]
  issue?: (request: Request, body: unknown) => Promise<SimLaunchIssueResult>
}) {
  const origin = canonicalBridgeOrigin(options.frameOrigin, options)
  return {
    configuration: () =>
      response({ frameOrigin: origin, allowLoopbackHttp: options.allowLoopbackHttp === true }),
    async launch(request: Request) {
      if (!options.trustedHostOrigins.includes(request.headers.get('origin') ?? '')) {
        return response({ status: 'denied', reason: 'unauthenticated' }, 403)
      }
      const body = await simJsonBody(request)
      if (!parseSimLaunchRequest(body)) return response({ status: 'invalid_request' }, 400)
      // Missing authority must never become "all authenticated users are entitled".
      if (!origin || !options.issue)
        return response({ status: 'unavailable', reason: 'not_configured' })
      try {
        return response(await options.issue(request, body))
      } catch {
        return response({ status: 'unavailable', reason: 'service_unavailable' })
      }
    },
  }
}
