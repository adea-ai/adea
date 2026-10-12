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
  /** Deadline for the owned request and body stream; defaults to 5s. */
  timeoutMs?: number
}>

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function refuse(): never {
  throw new ManagementAuthorityError('authority_unavailable')
}

/**
 * Reads the assertion body with a hard byte bound and releases the owned
 * stream on every path. The 16 KB limit is charged while reading, so an
 * unbounded or hostile body is refused and cancelled instead of buffered
 * whole; an abort (deadline) also cancels the stream.
 *
 * Cancelling a reader makes a pending `read()` resolve `done: true`, so a
 * complete prefix already buffered would otherwise look like a finished body.
 * The signal is therefore checked before reading starts, after every read and
 * before the parsed document is accepted: an aborted body is never accepted.
 */
async function readBoundedAssertion(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body
  if (!body) refuse()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (signal.aborted) refuse()
      const chunk = await reader.read()
      if (signal.aborted) refuse()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) refuse()
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      await reader.cancel()
    } catch {
      // The stream may already be closed or aborted; refusal is decided above.
    } finally {
      reader.releaseLock()
    }
  }
  if (signal.aborted) refuse()
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
  if (text.length === 0) refuse()
  return JSON.parse(text) as unknown
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
    const timeoutMs = dependencies.timeoutMs ?? 5_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) refuse()
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    try {
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
          signal: controller.signal,
        })
      } catch {
        refuse()
      }
      try {
        if (!response.ok) refuse()
        const envelope = await readBoundedAssertion(response, controller.signal)
        // The reviewed Control Plane route answers a successful assertion with
        // exactly `{ asserted: true }`. Any other document — nested data,
        // extra keys or a non-boolean value — is refused as unavailable.
        if (!record(envelope) || Object.keys(envelope).length !== 1 || envelope.asserted !== true)
          refuse()
      } catch {
        refuse()
      }
    } finally {
      clearTimeout(deadline)
    }
  }
}
