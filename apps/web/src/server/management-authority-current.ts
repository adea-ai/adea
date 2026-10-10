/**
 * Real authenticated Control API client for the canonical management current
 * authority route (adea-ai/control-plane
 * `feat/issue-932-management-current-authority`, PR #1038 canonical helper):
 *
 *     POST {CONTROL_PLANE_ORIGIN}/v1/pi-durable/management-current/assert
 *     body: versioned read envelope, operation
 *           `pi-durable.management-current.assert`,
 *           parameters `{ request: <canonical tool-call request>, boundary }`
 *     response: `{ asserted: true }` (the reviewed CP1043 route's exact
 *           success document; no envelope echo is invented here)
 *
 * The route is repeatable and never consumes an approval; it returns void or
 * throws. The single-owner durable effect claim remains the Adea
 * `management_authority_consumptions` row, and an ambiguous claimed effect is
 * never auto-retried under a fresh decision.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import {
  ManagementAuthorityError,
  managementAuthorityBoundaries,
  type ManagementAuthorityBoundary,
  type ManagementCurrentAuthority,
  type ManagementCurrentAuthorityRequest,
} from '@adea-ai/types/management'

import { adminCorrelation, readEnvelope } from './control-plane-client'
import type { ControlPlaneCredential } from './control-plane-credential'

export const PI_DURABLE_MANAGEMENT_CURRENT_OPERATION = 'pi-durable.management-current.assert'
export const PI_DURABLE_MANAGEMENT_CURRENT_PATH = '/v1/pi-durable/management-current/assert'

const MAX_RESPONSE_BYTES = 16 * 1024
const boundaries = new Set<ManagementAuthorityBoundary>(managementAuthorityBoundaries)

export type ManagementCurrentAuthorityClientDependencies = Readonly<{
  /** Signed current CP service credential for the exact request workspace. */
  credential(request: ManagementCurrentAuthorityRequest): Promise<ControlPlaneCredential>
  environment?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  now?: () => number
}>

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function refuse(): never {
  throw new ManagementAuthorityError('authority_unavailable')
}

export function createControlPlaneManagementCurrentAuthority(
  dependencies: ManagementCurrentAuthorityClientDependencies
): ManagementCurrentAuthority {
  return async (request, boundary) => {
    if (!boundaries.has(boundary)) refuse()
    if (!record(request.canonicalRequest)) refuse()
    const now = dependencies.now?.() ?? Date.now()
    let credential: ControlPlaneCredential
    try {
      credential = await dependencies.credential(request)
    } catch {
      refuse()
    }
    const origin = (dependencies.environment ?? process.env).CONTROL_PLANE_ORIGIN?.trim()
    if (!origin) refuse()
    let url: URL
    try {
      url = new URL(PI_DURABLE_MANAGEMENT_CURRENT_PATH, origin)
      if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') refuse()
    } catch {
      refuse()
    }
    const correlation = adminCorrelation(undefined, now)
    const body = readEnvelope(
      credential,
      correlation,
      PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
      { boundary, request: request.canonicalRequest },
      now
    )
    let response: Response
    try {
      response = await (dependencies.fetch ?? fetch)(url, {
        body: JSON.stringify(body),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
      })
    } catch {
      refuse()
    }
    try {
      const text = await response.text()
      if (!response.ok || text.length === 0 || text.length > MAX_RESPONSE_BYTES) refuse()
      const envelope = JSON.parse(text) as unknown
      // The reviewed Control Plane route answers a successful assertion with
      // exactly `{ asserted: true }`. Any other document — nested data,
      // extra keys or a non-boolean value — is refused as unavailable.
      if (!record(envelope) || Object.keys(envelope).length !== 1 || envelope.asserted !== true)
        refuse()
    } catch {
      refuse()
    }
  }
}
