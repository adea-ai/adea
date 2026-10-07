/**
 * The shared hop for workspace-scoped Control Plane administration APIs
 * (ADR 0013): the workspace catalog (`/v1/catalog/*`) and the credential
 * vault (`/v1/credentials/*`). Both speak contract major 3 and both name
 * exactly one envelope workspace, so a request may only ever run under a
 * per-request signed credential minted for the caller's own mapped `wsp_`.
 *
 * Nothing here logs a request or response body. Failures log one structured
 * line of operation, status and a sanitized code.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly,
 * and the compiled client-boundary guard keeps `src/server` out of browsers.
 */
import { createHash } from 'node:crypto'

import {
  CONTROL_PLANE_SERVICE_PRINCIPAL_ID,
  controlPlaneCredential,
  type ControlPlaneCredential,
  type ControlPlaneScopeIds,
  type ControlPlaneServiceScope,
} from './control-plane-credential'

/** Catalog and credential administration are additive in contract major 3. */
export const CONTROL_PLANE_ADMIN_CONTRACT_VERSION = Object.freeze({ major: 3, minor: 0 })

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const OPAQUE_ID_PATTERN = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/u
const CONTROL_PLANE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u

export type ControlPlaneProxyErrorCode =
  | 'CONTROL_PLANE_UNAVAILABLE'
  | 'CONTROL_PLANE_REQUEST_REJECTED'
  | (string & {})

/** A failure the route renders as `{ code, message }` with `status`. */
export class ControlPlaneProxyError extends Error {
  constructor(
    readonly code: ControlPlaneProxyErrorCode,
    message: string,
    readonly status = 503
  ) {
    super(message)
    this.name = 'ControlPlaneProxyError'
  }
}

export type ControlPlaneHopDependencies = Readonly<{
  /** Resolves the authorized Adea workspace's mapped Control Plane scope. */
  resolveControlPlaneScope: () => Promise<ControlPlaneScopeIds | null>
  environment?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  now?: () => number
}>

/**
 * Mints `<prefix>_<ULID>` in the Control Plane identifier grammar: ten
 * characters of millisecond time, then 80 random bits.
 */
export function mintOpaqueIdentifier(prefix: string, now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now))
  let timePart = ''
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD_ALPHABET[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let randomPart = ''
  for (const byte of bytes) randomPart += CROCKFORD_ALPHABET[byte & 31]
  return `${prefix}_${timePart}${randomPart}`
}

export type AdminCorrelation = Readonly<{ requestId: string; traceId: string }>

/**
 * Carries an inbound request/trace id only when it already satisfies the
 * Control Plane grammar (`req_…`, `trc_…`); anything else is replaced, never
 * forwarded, so a malformed header cannot fail the envelope.
 */
export function adminCorrelation(request: Request | undefined, now = Date.now()): AdminCorrelation {
  const requestId = request?.headers.get('x-request-id')?.trim()
  const traceId = request?.headers.get('x-correlation-id')?.trim()
  return {
    requestId:
      requestId && requestId.startsWith('req_') && OPAQUE_ID_PATTERN.test(requestId)
        ? requestId
        : mintOpaqueIdentifier('req', now),
    traceId:
      traceId && traceId.startsWith('trc_') && OPAQUE_ID_PATTERN.test(traceId)
        ? traceId
        : mintOpaqueIdentifier('trc', now),
  }
}

/** The signed credential for one administration hop, or a refusal. */
export async function scopedAdminCredential(
  scopes: readonly ControlPlaneServiceScope[],
  dependencies: ControlPlaneHopDependencies
): Promise<ControlPlaneCredential> {
  try {
    return await controlPlaneCredential(
      { resolveScope: dependencies.resolveControlPlaneScope, scopes },
      dependencies.environment ?? process.env,
      dependencies.now?.() ?? Date.now()
    )
  } catch {
    throw new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  }
}

/** The read envelope context every list/get request carries. */
export function readEnvelope(
  credential: ControlPlaneCredential,
  correlation: AdminCorrelation,
  operation: string,
  parameters: Record<string, unknown>,
  now: number
) {
  return {
    caller: { servicePrincipalId: CONTROL_PLANE_SERVICE_PRINCIPAL_ID },
    contractVersion: CONTROL_PLANE_ADMIN_CONTRACT_VERSION,
    correlation: { traceId: correlation.traceId },
    operation,
    parameters,
    requestId: correlation.requestId,
    requestedAt: new Date(now).toISOString(),
    workspaceId: credential.workspaceId,
  }
}

/**
 * The command envelope context. `hashedPayload` is what `payloadHash`
 * digests; callers pass the payload without any write-only secret, matching
 * the Control Plane, which recomputes its own hash and never trusts ours.
 */
export function commandEnvelope(
  credential: ControlPlaneCredential,
  correlation: AdminCorrelation,
  input: Readonly<{
    operation: string
    idempotencyKey: string
    payload: Record<string, unknown>
    hashedPayload?: Record<string, unknown>
    now: number
  }>
) {
  return {
    caller: { servicePrincipalId: CONTROL_PLANE_SERVICE_PRINCIPAL_ID },
    commandId: mintOpaqueIdentifier('cmd', input.now),
    contractVersion: CONTROL_PLANE_ADMIN_CONTRACT_VERSION,
    correlation: { traceId: correlation.traceId },
    idempotencyKey: input.idempotencyKey,
    issuedAt: new Date(input.now).toISOString(),
    operation: input.operation,
    payload: input.payload,
    payloadHash: sha256Hex(canonicalJson(input.hashedPayload ?? input.payload)),
    requestId: correlation.requestId,
    workspaceId: credential.workspaceId,
  }
}

/**
 * POSTs one envelope and returns the response envelope's `data`. Rejections
 * carry the Control Plane's error code when it is a plain identifier, never
 * its message or any echoed input.
 */
export async function postControlPlane(
  credential: ControlPlaneCredential,
  path: string,
  body: Record<string, unknown>,
  dependencies: ControlPlaneHopDependencies,
  operation: string
): Promise<unknown> {
  const environment = dependencies.environment ?? process.env
  const origin = environment.CONTROL_PLANE_ORIGIN?.trim()
  if (!origin)
    throw new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  let url: URL
  try {
    url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`)
  } catch {
    throw new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  }
  if (url.protocol !== 'https:' && environment.NODE_ENV === 'production')
    throw new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is not configured')
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      method: 'POST',
    })
  } catch {
    reportFailure(operation, 0, 'CONTROL_PLANE_UNAVAILABLE', requestId)
    throw new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is unavailable')
  }
  if (!response.ok) {
    const code = await rejectionCode(response)
    const error = rejection(response.status, code)
    reportFailure(operation, response.status, error.code, requestId)
    throw error
  }
  let envelope: unknown
  try {
    envelope = await response.json()
  } catch {
    envelope = undefined
  }
  if (!isRecord(envelope) || !('data' in envelope)) {
    reportFailure(operation, response.status, 'CONTROL_PLANE_INVALID_RESPONSE', requestId)
    throw new ControlPlaneProxyError(
      'CONTROL_PLANE_UNAVAILABLE',
      'Control Plane returned an invalid response'
    )
  }
  return envelope.data
}

async function rejectionCode(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json()
    const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : undefined
    return typeof code === 'string' && CONTROL_PLANE_CODE_PATTERN.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function rejection(status: number, code: string | undefined): ControlPlaneProxyError {
  // Authentication failures and outages are this deployment's problem, not
  // the caller's: report them as unavailable rather than leak the detail.
  if (status === 401 || status === 429 || status >= 500)
    return new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is unavailable')
  const mapped = [400, 403, 404, 409, 422].includes(status) ? status : 400
  return new ControlPlaneProxyError(
    code ?? 'CONTROL_PLANE_REQUEST_REJECTED',
    mapped === 404
      ? 'The Control Plane has no such item in this workspace'
      : mapped === 409
        ? 'The request conflicts with the current Control Plane state'
        : mapped === 403
          ? 'The Control Plane does not allow this change'
          : 'The Control Plane rejected the request',
    mapped
  )
}

function reportFailure(operation: string, status: number, code: string, requestId: string) {
  console.warn(
    JSON.stringify({
      event: 'control_plane.admin.failed',
      operation,
      status,
      code,
      requestId,
    })
  )
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
