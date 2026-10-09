/**
 * CP current-authority/consumption client for the lead management host
 * (M14.03.1, adea-ai/adea#1215).
 *
 * Every delivery of a lead management call must reach the Control Plane's
 * durable consumption/current-authority store before any Adea effect. The
 * client posts the exact signed decision identity to the configured endpoint;
 * the endpoint re-reads current grants/revocation/plan/approval state, atomically
 * consumes the single-use approval, and answers with a bounded assert-only
 * envelope. A non-2xx answer, a malformed envelope or an unreachable endpoint
 * throws a typed refusal — a caller-provided truthy field is never accepted as
 * authorization.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import {
  ManagementAuthorityError,
  managementCurrentSchemaVersion,
  type ManagementCurrentAuthority,
  type ManagementCurrentAuthorityRequest,
} from '@adea-ai/types/management'

const MAX_RESPONSE_BYTES = 8 * 1024
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export type ManagementCurrentAuthorityEnvironment = Readonly<{
  PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN?: string
  PI_LEAD_MANAGEMENT_AUTHORITY_URL?: string
}>

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Strict, fail-closed client. Absent configuration refuses every delivery:
 * there is no local substitute for a current CP authority owner.
 */
export function createManagementCurrentAuthority(
  environment: ManagementCurrentAuthorityEnvironment,
  options: Readonly<{ timeoutMs?: number }> = {}
): ManagementCurrentAuthority {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (request: ManagementCurrentAuthorityRequest): Promise<void> => {
    const url = environment.PI_LEAD_MANAGEMENT_AUTHORITY_URL
    const token = environment.PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN
    if (
      typeof url !== 'string' ||
      !/^https?:\/\/[^\s]+$/.test(url) ||
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 4_096 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    )
      throw new ManagementAuthorityError('authority_unavailable')

    let response: Response
    try {
      response = await fetch(url, {
        body: JSON.stringify({ ...request, schemaVersion: managementCurrentSchemaVersion }),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new ManagementAuthorityError('authority_unavailable')
    }

    let payload: unknown
    try {
      const text = await response.text()
      if (text.length === 0 || text.length > MAX_RESPONSE_BYTES)
        throw new ManagementAuthorityError('authority_unavailable')
      payload = JSON.parse(text) as unknown
    } catch {
      throw new ManagementAuthorityError('authority_unavailable')
    }
    const body = record(payload)
    if (!response.ok || !body || Object.keys(body).length !== 1 || body.asserted !== true)
      throw new ManagementAuthorityError('authority_unavailable')
  }
}
