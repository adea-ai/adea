import { createHash, randomBytes } from 'node:crypto'

import {
  CONTROL_PLANE_SERVICE_PRINCIPAL_ID,
  controlPlaneCredential,
  type ControlPlaneCredential,
  type ControlPlaneScopeIds,
  type ControlPlaneServiceScope,
} from './control-plane-credential'

const contractVersion = { major: 2, minor: 0 } as const
// The service principal the Control Plane registered for this shell. One
// spelling; a mismatch makes the Control Plane reject marketplace calls.
const servicePrincipalId = CONTROL_PLANE_SERVICE_PRINCIPAL_ID

/**
 * How the proxy learns the active Adea workspace's Control Plane scope
 * (ADR 0013). Routes pass a resolver bound to the workspace they already
 * authorized; it is only consulted when per-request signing is configured.
 */
export type MarketplaceProxyDependencies = Readonly<{
  resolveControlPlaneScope?: () => Promise<ControlPlaneScopeIds | null>
}>

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
  inbound: InboundCorrelation = {},
  dependencies: MarketplaceProxyDependencies = {}
): Promise<Response> {
  const credential = await marketplaceCredential('marketplace:read', dependencies)
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  return proxyControlPlane(
    credential,
    '/v1/marketplace/catalog',
    {
      caller: { servicePrincipalId },
      contractVersion,
      correlation: { traceId },
      operation: 'marketplace.catalog.read',
      // Control Plane scopes every marketplace identity to the authenticated
      // service workspace: the caller's Adea workspace id never crosses
      // this boundary, and an identity outside the envelope workspace is
      // rejected before any catalog read.
      parameters: {
        workspaceIdentity: { userId: input.userId, workspaceId: credential.workspaceId },
      },
      requestId,
      requestedAt: new Date().toISOString(),
      workspaceId: credential.workspaceId,
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
  inbound: InboundCorrelation = {},
  dependencies: MarketplaceProxyDependencies = {}
): Promise<Response> {
  const credential = await marketplaceCredential('marketplace:install', dependencies)
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  const commandId = identifier('cmd')
  // Installations are tracked under the authenticated scope, so the identity
  // in the payload names the same workspace as the envelope.
  const payload = {
    ...input,
    workspaceIdentity: {
      userId: input.workspaceIdentity.userId,
      workspaceId: credential.workspaceId,
    },
  }
  // The key hashes the payload, which names the workspace's own `wsp_`
  // scope, so each workspace has its own plan namespace.
  const idempotencyKey = `marketplace-plan:${sha256(canonicalJson(payload))}`
  return proxyControlPlane(
    credential,
    '/v1/marketplace/install-plan',
    {
      caller: { servicePrincipalId },
      commandId,
      contractVersion,
      correlation: { traceId },
      idempotencyKey,
      issuedAt: new Date().toISOString(),
      operation: 'marketplace.install.plan',
      payload,
      payloadHash: sha256(canonicalJson(payload)),
      requestId,
      workspaceId: credential.workspaceId,
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
  inbound: InboundCorrelation = {},
  dependencies: MarketplaceProxyDependencies = {}
): Promise<Response> {
  const credential = await marketplaceCredential('marketplace:install', dependencies)
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  const commandId = identifier('cmd')
  // Installations are tracked under the authenticated scope, so the identity
  // in the payload names the same workspace as the envelope. The Control
  // Plane keys idempotency by (envelope workspace, key), so a scoped request
  // already replays only within its own workspace.
  const payload = {
    ...input,
    workspaceIdentity: {
      userId: input.workspaceIdentity.userId,
      workspaceId: credential.workspaceId,
    },
  }
  // The Control Plane never replays an uninstalled installation: a reinstall
  // needs a new idempotency key. The client key is deterministic, so each
  // uninstall/reinstall cycle moves to the next derived key. Every probe is
  // itself idempotent, so a retried reinstall still lands on the same
  // installation.
  for (let generation = 0; ; generation += 1) {
    try {
      return await proxyControlPlane(
        credential,
        '/v1/marketplace/install',
        {
          caller: { servicePrincipalId },
          commandId: generation === 0 ? commandId : identifier('cmd'),
          contractVersion,
          correlation: { traceId },
          idempotencyKey: reinstallIdempotencyKey(input.idempotencyKey, generation),
          issuedAt: new Date().toISOString(),
          operation: 'marketplace.install.request',
          payload,
          payloadHash: sha256(canonicalJson(payload)),
          requestId,
          workspaceId: credential.workspaceId,
        },
        requestId
      )
    } catch (error) {
      if (
        !(error instanceof MarketplaceProxyError) ||
        error.upstreamCode !== 'MARKETPLACE_INSTALLATION_UNINSTALLED' ||
        generation + 1 >= MAX_REINSTALL_GENERATIONS
      )
        throw error
    }
  }
}

/** Bounds the reinstall probe; each step is one Control Plane round trip. */
export const MAX_REINSTALL_GENERATIONS = 16

export function reinstallIdempotencyKey(key: string, generation: number): string {
  if (generation === 0) return key
  const derived = `${key}:reinstall-${generation}`
  // The Control Plane caps keys at 128 characters; a long client key is
  // hashed instead of truncated so distinct keys stay distinct.
  return derived.length <= 128 ? derived : `marketplace-reinstall:${sha256(key)}:${generation}`
}

/** The Control Plane installation handle grammar (`ins_…`). */
export const MARKETPLACE_INSTALLATION_ID_PATTERN = /^ins_[a-z0-9]{1,124}$/u

export async function proxyMarketplaceInstallationGet(
  input: Readonly<{ installationId: string; userId: string }>,
  inbound: InboundCorrelation = {},
  dependencies: MarketplaceProxyDependencies = {}
): Promise<Response> {
  if (!MARKETPLACE_INSTALLATION_ID_PATTERN.test(input.installationId))
    throw new MarketplaceProxyError(
      'MARKETPLACE_REQUEST_REJECTED',
      'Invalid marketplace installation',
      400
    )
  const credential = await marketplaceCredential('marketplace:read', dependencies)
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  return proxyControlPlane(
    credential,
    '/v1/marketplace/installations/get',
    {
      caller: { servicePrincipalId },
      contractVersion,
      correlation: { traceId },
      operation: 'marketplace.installation.get',
      // As for the catalog: the identity names the authenticated scope, so a
      // workspace can only ever read its own installations.
      parameters: {
        installationId: input.installationId,
        workspaceIdentity: { userId: input.userId, workspaceId: credential.workspaceId },
      },
      requestId,
      requestedAt: new Date().toISOString(),
      workspaceId: credential.workspaceId,
    },
    requestId
  )
}

export async function proxyMarketplaceUninstall(
  input: Readonly<{ installationId: string; userId: string }>,
  inbound: InboundCorrelation = {},
  dependencies: MarketplaceProxyDependencies = {}
): Promise<Response> {
  if (!MARKETPLACE_INSTALLATION_ID_PATTERN.test(input.installationId))
    throw new MarketplaceProxyError(
      'MARKETPLACE_REQUEST_REJECTED',
      'Invalid marketplace installation',
      400
    )
  const credential = await marketplaceCredential('marketplace:uninstall', dependencies)
  const requestId = inbound.requestId ?? identifier('req')
  const traceId = inbound.traceId ?? identifier('trc')
  const payload = {
    installationId: input.installationId,
    workspaceIdentity: { userId: input.userId, workspaceId: credential.workspaceId },
  }
  // Uninstall is terminal, so one key per (scope, installation, user) is
  // enough: a retry replays the original transition, and a second user's
  // uninstall of the same installation reports it as already uninstalled.
  // The Control Plane keys idempotency by (envelope workspace, key).
  const idempotencyKey = `marketplace-uninstall:${sha256(canonicalJson(payload))}`
  return proxyControlPlane(
    credential,
    '/v1/marketplace/installations/uninstall',
    {
      caller: { servicePrincipalId },
      commandId: identifier('cmd'),
      contractVersion,
      correlation: { traceId },
      idempotencyKey,
      issuedAt: new Date().toISOString(),
      operation: 'marketplace.installation.uninstall',
      payload,
      payloadHash: sha256(canonicalJson(payload)),
      requestId,
      workspaceId: credential.workspaceId,
    },
    requestId
  )
}

/**
 * The credential for one marketplace hop: a per-request signed JWT for the
 * active workspace's mapped scope. Without one the hop fails closed.
 */
async function marketplaceCredential(
  scope: ControlPlaneServiceScope,
  dependencies: MarketplaceProxyDependencies
): Promise<ControlPlaneCredential> {
  try {
    return await controlPlaneCredential({
      resolveScope: dependencies.resolveControlPlaneScope,
      scopes: [scope],
    })
  } catch {
    throw new MarketplaceProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  }
}

async function proxyControlPlane(
  credential: ControlPlaneCredential,
  path: string,
  body: Record<string, unknown>,
  requestId: string,
  options: Readonly<{ streamThrough?: boolean }> = {}
): Promise<Response> {
  const origin = process.env.CONTROL_PLANE_ORIGIN?.trim()
  const token = credential.token
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
        status,
        status === 503 ? undefined : await upstreamErrorCode(response)
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
    readonly status = 503,
    /**
     * The Control Plane's own error code for a rejection, when it sent a
     * well-formed one. Proxy logic branches on it; it is never forwarded.
     */
    readonly upstreamCode?: string
  ) {
    super(message)
    this.name = 'MarketplaceProxyError'
  }
}

async function upstreamErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null
    const code = body?.error?.code
    return typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code) ? code : undefined
  } catch {
    return undefined
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
