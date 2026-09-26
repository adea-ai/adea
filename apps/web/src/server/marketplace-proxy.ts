import { createHash, randomBytes } from 'node:crypto'

const contractVersion = { major: 2, minor: 0 } as const
// The service principal the Control Plane registered for this shell. One
// spelling; a mismatch makes the Control Plane reject marketplace calls.
const servicePrincipalId = 'svc_agent-hq'

/**
 * Inbound correlation for a Control Plane hop. A caller that already has a
 * request/trace id (the web lane's own edge, another proxy, a retry) keeps
 * it, so one incident correlates across every hop instead of starting a new
 * chain at this boundary. Anything malformed or unbounded is discarded and a
 * fresh id minted — a propagated value is never trusted, only carried.
 */
export type InboundCorrelation = Readonly<{ requestId?: string; traceId?: string }>

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u

export function inboundCorrelation(request: Request | undefined): InboundCorrelation {
  if (!request) return {}
  const requestId = request.headers.get('x-request-id')?.trim()
  const traceId = request.headers.get('x-correlation-id')?.trim()
  return {
    ...(requestId && CORRELATION_PATTERN.test(requestId) ? { requestId } : {}),
    ...(traceId && CORRELATION_PATTERN.test(traceId) ? { traceId } : {}),
  }
}

export async function proxyMarketplaceCatalog(
  input: Readonly<{ workspaceId: string; userId: string }>,
  inbound: InboundCorrelation = {}
): Promise<Response> {
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  return proxyControlPlane(
    '/v1/marketplace/catalog',
    {
      caller: { servicePrincipalId },
      contractVersion,
      correlation: { traceId },
      operation: 'marketplace.catalog.read',
      parameters: { workspaceIdentity: input },
      requestId,
      requestedAt: new Date().toISOString(),
      workspaceId: requiredControlPlaneWorkspaceId(),
    },
    requestId,
    // The catalog is tens of megabytes; buffer-free streaming keeps the
    // worker under Cloudflare's resource limits.
    { streamThrough: true }
  )
}

export async function proxyMarketplaceInstallPlan(
  input: Readonly<{
    pluginId: string
    releaseId: string
    instanceId: string
    requestedHarness: string
    workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>
  }>,
  inbound: InboundCorrelation = {}
): Promise<Response> {
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  const commandId = identifier('cmd')
  const idempotencyKey = `marketplace-plan:${sha256(canonicalJson(input))}`
  return proxyControlPlane(
    '/v1/marketplace/install-plan',
    {
      caller: { servicePrincipalId },
      commandId,
      contractVersion,
      correlation: { traceId },
      idempotencyKey,
      issuedAt: new Date().toISOString(),
      operation: 'marketplace.install.plan',
      payload: input,
      payloadHash: sha256(canonicalJson(input)),
      requestId,
      workspaceId: requiredControlPlaneWorkspaceId(),
    },
    requestId
  )
}

export async function proxyMarketplaceInstall(
  input: Readonly<{
    canonicalContentDigest: string
    idempotencyKey: string
    pluginId: string
    releaseId: string
    requestedHarness: string
    installationInstanceId?: string
    workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>
  }>,
  inbound: InboundCorrelation = {}
): Promise<Response> {
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  const commandId = identifier('cmd')
  const payload = { ...input }
  return proxyControlPlane(
    '/v1/marketplace/install',
    {
      caller: { servicePrincipalId },
      commandId,
      contractVersion,
      correlation: { traceId },
      idempotencyKey: input.idempotencyKey,
      issuedAt: new Date().toISOString(),
      operation: 'marketplace.install.request',
      payload,
      payloadHash: sha256(canonicalJson(payload)),
      requestId,
      workspaceId: requiredControlPlaneWorkspaceId(),
    },
    requestId
  )
}

function requiredControlPlaneWorkspaceId(): string {
  const value = process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID?.trim()
  if (!value || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)) {
    throw new MarketplaceProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  }
  return value
}

async function proxyControlPlane(
  path: string,
  body: Record<string, unknown>,
  requestId: string,
  options: Readonly<{ streamThrough?: boolean }> = {}
): Promise<Response> {
  const origin = process.env.CONTROL_PLANE_ORIGIN?.trim()
  const token = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim()
  if (!origin || !token)
    throw new MarketplaceProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  let url: URL
  try {
    url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`)
  } catch {
    throw new MarketplaceProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  }
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production')
    throw new MarketplaceProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      method: 'POST',
    })
    if (!response.ok) {
      const status = response.status >= 500 ? 503 : response.status
      throw new MarketplaceProxyError(
        status === 503 ? 'CONTROL_PLANE_UNAVAILABLE' : 'MARKETPLACE_REQUEST_REJECTED',
        status === 503
          ? 'Control Plane is unavailable'
          : 'Control Plane rejected the marketplace request',
        status
      )
    }
    // Large reads (the marketplace catalog is tens of megabytes) stream
    // through unparsed: buffering + re-serializing them in the worker
    // exceeds Cloudflare's resource limits. The request id rides back on the
    // response either way, so a caller can correlate its retry with the hop
    // that is already in flight.
    if (options.streamThrough) {
      return new Response(response.body, {
        headers: {
          'content-type': response.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
          'x-request-id': requestId,
        },
      })
    }
    const envelope = (await response.json()) as { data?: unknown }
    if (!envelope || !('data' in envelope))
      throw new MarketplaceProxyError(
        'CONTROL_PLANE_UNAVAILABLE',
        'Control Plane returned an invalid response'
      )
    return Response.json(envelope.data)
  } catch (error) {
    if (error instanceof MarketplaceProxyError) throw error
    throw new MarketplaceProxyError(
      'CONTROL_PLANE_UNAVAILABLE',
      'Control Plane is unavailable',
      503
    )
  }
}

export class MarketplaceProxyError extends Error {
  constructor(
    readonly code: 'CONTROL_PLANE_UNAVAILABLE' | 'MARKETPLACE_REQUEST_REJECTED',
    message: string,
    readonly status = 503
  ) {
    super(message)
    this.name = 'MarketplaceProxyError'
  }
}

function identifier(prefix: 'cmd' | 'req' | 'trc'): string {
  return `${prefix}_${randomBytes(13).toString('hex').toUpperCase()}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}
