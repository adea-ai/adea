/** Workspace-scoped, read-only SDK discovery. No runtime or content ownership. */
import type { ApiRuntimeConnection, ApiRuntimeNodeConnectionsResponse } from '@adea-ai/api-client'
import { EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS } from '@adea-ai/types'
import type {
  RuntimeConnectionDiscoveryReadModel,
  RuntimeConnectionListResponse,
} from '@adea-ai/sdk'
import {
  ControlPlaneProxyError,
  postControlPlane,
  readEnvelope,
  scopedAdminCredential,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'

export type RuntimeDiscoveryDependencies = ControlPlaneHopDependencies &
  Readonly<{
    /** Route authorization precedes this workspace-bound lookup. */
    readRegisteredNode: () => Promise<ApiRuntimeNodeConnectionsResponse['node'] | null>
  }>

function unavailable() {
  return new ControlPlaneProxyError('CONTROL_PLANE_UNAVAILABLE', 'Control Plane is unavailable')
}

export async function listNodeRuntimeConnections(
  input: Readonly<{ cursor?: string }>,
  correlation: AdminCorrelation,
  dependencies: RuntimeDiscoveryDependencies
): Promise<ApiRuntimeNodeConnectionsResponse> {
  const registered = await dependencies.readRegisteredNode()
  if (!registered)
    throw new ControlPlaneProxyError('workspace_unavailable', 'Workspace unavailable', 404)
  // Explicit projection: never forward public keys, trust metadata or future native fields.
  const node = {
    id: registered.id,
    controlPlaneRuntimeNodeRefId: registered.controlPlaneRuntimeNodeRefId,
    kind: registered.kind,
    displayName: registered.displayName,
    health: registered.health,
    pairingState: registered.pairingState,
    lastProofAt: registered.lastProofAt,
  }
  const now = dependencies.now?.() ?? Date.now()
  const observedAt = new Date(now).toISOString()
  try {
    const credential = await scopedAdminCredential(['runtime:read'], dependencies)
    const operation = 'runtime-connection.list'
    // postControlPlane validates this exact operation with the pinned public SDK.
    const data = (await postControlPlane(
      credential,
      '/v1/runtime-connections/list',
      readEnvelope(
        credential,
        correlation,
        operation,
        {
          limit: 100,
          runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        now
      ),
      dependencies,
      operation
    )) as RuntimeConnectionListResponse['data']
    const identities = new Set<string>()
    const connections = data.runtimeConnections.map((model): ApiRuntimeConnection => {
      if (
        !model.node ||
        model.node.runtimeNodeRefId !== node.controlPlaneRuntimeNodeRefId ||
        model.node.location !== node.kind ||
        model.connectionType === 'managed_cloud' ||
        model.location === 'agent_hq_cloud' ||
        identities.has(model.runtimeConnectionId)
      )
        throw unavailable()
      identities.add(model.runtimeConnectionId)
      return {
        id: model.runtimeConnectionId,
        runtimeDefinitionId: model.runtimeDefinitionId,
        family: model.family,
        connectionType: model.connectionType,
        location: node.kind,
        status: model.status,
        node: {
          runtimeNodeRefId: model.node.runtimeNodeRefId,
          location: node.kind,
          status: model.node.status,
          health: model.node.health,
          observedAt: model.node.observedAt,
        },
        connection: {
          status: model.connection.status,
          health: model.connection.health,
          availability: model.connection.availability,
        },
        freshness: effectiveFreshness(model.freshness, now, model.observedAt),
        versions: {
          adapter: model.versions.adapter,
          driver: model.versions.driver,
          harness: model.versions.harness,
          ...(model.versions.protocol ? { protocol: model.versions.protocol } : {}),
        },
        capabilities: model.capabilities,
        capabilityDetails: model.capabilityDetails.map((detail) => ({
          name: detail.name,
          support: detail.support,
          ...(detail.limitations ? { limitations: detail.limitations } : {}),
        })),
        compatibility: {
          state: model.compatibility.state,
          limitations: model.compatibility.limitations,
        },
        access: {
          localProjectGrant: {
            required: model.access.localProjectGrant.required,
            state: model.access.localProjectGrant.state,
          },
          entitlement: { state: model.access.entitlement.state },
        },
        eligibility: {
          state: model.eligibility.state,
          reasons: model.eligibility.reasons,
          degradations: model.eligibility.degradations,
          remediation: model.eligibility.remediation.map((item) => item.code),
        },
        transport: { state: 'unreported' },
        observedAt: model.observedAt,
        limitations: model.limitations,
      }
    })
    return {
      node,
      observedAt,
      discovery: { state: 'available' },
      connections,
      ...(data.page.nextCursor ? { nextCursor: data.page.nextCursor } : {}),
    }
  } catch (error) {
    if (!(error instanceof ControlPlaneProxyError)) throw error
    return {
      node,
      observedAt,
      discovery: { state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' },
      connections: [],
    }
  }
}

function effectiveFreshness(
  freshness: RuntimeConnectionDiscoveryReadModel['freshness'],
  now: number,
  modelObservedAt: string
): ApiRuntimeConnection['freshness'] {
  const observedAt = Date.parse(freshness.observedAt)
  const modelAt = Date.parse(modelObservedAt)
  const expiresAt = freshness.expiresAt ? Date.parse(freshness.expiresAt) : undefined
  let state = freshness.state
  if (observedAt > now || modelAt > now || (expiresAt !== undefined && expiresAt < observedAt))
    state = 'unknown'
  else if (expiresAt !== undefined && expiresAt <= now) state = 'expired'
  else if (
    state === 'fresh' &&
    now - Math.min(observedAt, modelAt) > EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS
  )
    state = 'stale'
  return {
    state,
    observedAt: freshness.observedAt,
    ...(freshness.expiresAt ? { expiresAt: freshness.expiresAt } : {}),
  }
}
