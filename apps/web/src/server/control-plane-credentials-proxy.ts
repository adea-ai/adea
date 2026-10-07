/**
 * Cloud connections proxy (ADR 0013): connector credentials stored in the
 * Control Plane credential vault under the workspace's own signed scope.
 * Reads ask for `credential:read`; create, rotate and revoke for
 * `credential:write`.
 *
 * The secret is write-only. It is accepted on create and rotate, placed in
 * the one outbound request body and nowhere else: it is excluded from the
 * payload hash (the Control Plane excludes it too), never logged, never
 * stored in Adea, and never part of a response — responses are rebuilt from
 * an allow-list of metadata fields, so even an upstream echo cannot reach the
 * browser.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type { ApiCloudConnection, ApiCloudConnectionStatus } from '@adea-ai/api-client'

import {
  ControlPlaneProxyError,
  commandEnvelope,
  isRecord,
  postControlPlane,
  readEnvelope,
  scopedAdminCredential,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'

/** Request fields that carry write-only secret material; never log or echo. */
export const CLOUD_CONNECTION_SECRET_FIELDS = Object.freeze(['secret'] as const)

const STATUSES = new Set<ApiCloudConnectionStatus>([
  'active',
  'expired',
  'revoked',
  'secret_required',
])
const CREDENTIAL_PAGE_LIMIT = 100

export async function listCloudConnections(
  input: Readonly<{ cursor?: string }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<Readonly<{ connections: ApiCloudConnection[]; nextCursor?: string }>> {
  const credential = await scopedAdminCredential(['credential:read'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const data = await postControlPlane(
    credential,
    '/v1/credentials/list',
    readEnvelope(
      credential,
      correlation,
      'credential.list',
      { limit: CREDENTIAL_PAGE_LIMIT, ...(input.cursor ? { cursor: input.cursor } : {}) },
      now
    ),
    dependencies,
    'credential.list'
  )
  if (!isRecord(data) || !Array.isArray(data.credentials)) throw invalidResponse()
  const connections = data.credentials.map((value) =>
    cloudConnection(value, credential.workspaceId)
  )
  return {
    connections,
    ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}),
  }
}

export async function createCloudConnection(
  input: Readonly<{
    idempotencyKey: string
    provider: string
    connectorRef: string
    secret: string
    expiresAt?: string
  }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<ApiCloudConnection> {
  const credential = await scopedAdminCredential(['credential:write'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const metadata = {
    connectorRef: input.connectorRef,
    provider: input.provider,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }
  const data = await postControlPlane(
    credential,
    '/v1/credentials/create',
    commandEnvelope(credential, correlation, {
      hashedPayload: metadata,
      idempotencyKey: `cloud-connection-create:${input.idempotencyKey}`,
      now,
      operation: 'credential.create',
      payload: { ...metadata, secret: input.secret },
    }),
    dependencies,
    'credential.create'
  )
  return credentialFrom(data, credential.workspaceId)
}

export async function rotateCloudConnection(
  input: Readonly<{
    credentialId: string
    expectedRevision: number
    idempotencyKey: string
    secret: string
  }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<ApiCloudConnection> {
  const credential = await scopedAdminCredential(['credential:write'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const target = { credentialId: input.credentialId, expectedRevision: input.expectedRevision }
  const data = await postControlPlane(
    credential,
    '/v1/credentials/rotate',
    commandEnvelope(credential, correlation, {
      hashedPayload: target,
      idempotencyKey: `cloud-connection-rotate:${input.idempotencyKey}`,
      now,
      operation: 'credential.rotate',
      payload: { ...target, secret: input.secret },
    }),
    dependencies,
    'credential.rotate'
  )
  return credentialFrom(data, credential.workspaceId)
}

export async function revokeCloudConnection(
  input: Readonly<{ credentialId: string; idempotencyKey: string }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<ApiCloudConnection> {
  const credential = await scopedAdminCredential(['credential:write'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const data = await postControlPlane(
    credential,
    '/v1/credentials/revoke',
    commandEnvelope(credential, correlation, {
      idempotencyKey: `cloud-connection-revoke:${input.idempotencyKey}`,
      now,
      operation: 'credential.revoke',
      payload: { credentialId: input.credentialId },
    }),
    dependencies,
    'credential.revoke'
  )
  return credentialFrom(data, credential.workspaceId)
}

function credentialFrom(data: unknown, workspaceId: string): ApiCloudConnection {
  if (!isRecord(data)) throw invalidResponse()
  return cloudConnection(data.credential, workspaceId)
}

/** Allow-listed metadata only; anything else the upstream sends is dropped. */
function cloudConnection(value: unknown, workspaceId: string): ApiCloudConnection {
  if (!isRecord(value)) throw invalidResponse()
  const { connectorRef, createdAt, credentialId, provider, revision, status } = value
  if (
    value.workspaceId !== workspaceId ||
    typeof credentialId !== 'string' ||
    typeof provider !== 'string' ||
    typeof connectorRef !== 'string' ||
    typeof revision !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof status !== 'string' ||
    !STATUSES.has(status as ApiCloudConnectionStatus)
  )
    throw invalidResponse()
  const optional = (key: 'expiresAt' | 'revokedAt' | 'rotatedAt') =>
    typeof value[key] === 'string' ? { [key]: value[key] } : {}
  return {
    connectorRef,
    createdAt,
    credentialId,
    provider,
    revision,
    status: status as ApiCloudConnectionStatus,
    ...optional('rotatedAt'),
    ...optional('expiresAt'),
    ...optional('revokedAt'),
  }
}

function invalidResponse() {
  return new ControlPlaneProxyError(
    'CONTROL_PLANE_UNAVAILABLE',
    'Control Plane returned an invalid response'
  )
}
