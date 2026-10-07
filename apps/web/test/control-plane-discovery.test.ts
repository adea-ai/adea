import { describe, expect, test } from 'bun:test'
import { listNodeRuntimeConnections } from '../src/server/control-plane-discovery'

const suffix = '01JABCDEF0123456789ABCDEFG'
const node = {
  id: '17ac9ee8-46fb-4f46-9087-61ec51f8e0c2',
  controlPlaneRuntimeNodeRefId: `rnr_${suffix}`,
  kind: 'remote_host' as const,
  displayName: 'Home server',
  health: 'healthy' as const,
  pairingState: 'paired' as const,
  lastProofAt: '2026-10-07T06:00:00.000Z',
}
const now = Date.parse('2026-10-07T06:01:00.000Z')
const correlation = { requestId: `req_${suffix}`, traceId: `trc_${suffix}` }
const model = () => ({
  runtimeConnectionId: `rtc_${suffix}`,
  runtimeDefinitionId: `rtd_${suffix}`,
  family: 'pi',
  connectionType: 'managed_local',
  location: 'local_device',
  status: 'available',
  node: {
    runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
    location: 'remote_host',
    status: 'online',
    health: 'online',
    observedAt: node.lastProofAt,
  },
  connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
  freshness: { state: 'fresh', observedAt: node.lastProofAt },
  versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
  capabilities: ['session.resume'],
  capabilityDetails: [{ name: 'session.resume', support: 'supported' }],
  compatibility: { state: 'compatible', limitations: [] },
  access: {
    localProjectGrant: { required: true, state: 'granted' },
    entitlement: { state: 'allowed' },
  },
  eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
  observedAt: node.lastProofAt,
  limitations: [],
})
async function dependencies(items: unknown[] = [model()]) {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const key = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const requests: Record<string, unknown>[] = []
  return {
    requests,
    now: () => now,
    readRegisteredNode: async () => node,
    resolveControlPlaneScope: async () => ({ workspaceId: `wsp_${suffix}` }),
    environment: {
      NODE_ENV: 'production',
      CONTROL_PLANE_ORIGIN: 'https://cp.example',
      CONTROL_PLANE_SIGNING_KEY: JSON.stringify(key),
      CONTROL_PLANE_SIGNING_KEY_ID: 'inert-test-key',
      CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.example',
    },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return Response.json({
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        data: { runtimeConnections: items, page: { nextCursor: 'cur_abcd' } },
      })
    }) as typeof fetch,
  }
}

describe('published runtime discovery boundary', () => {
  test('joins the exact registered node and preserves independent health and location', async () => {
    const deps = await dependencies()
    const result = await listNodeRuntimeConnections({}, correlation, deps)
    expect(result.discovery).toEqual({ state: 'available' })
    expect(result.node).toEqual(node)
    expect(result.connections[0]).toMatchObject({
      id: `rtc_${suffix}`,
      location: 'remote_host',
      node: { status: 'online' },
      connection: { health: 'healthy' },
      transport: { state: 'unreported' },
    })
    expect(result.nextCursor).toBe('cur_abcd')
    expect(deps.requests[0]).toMatchObject({
      operation: 'runtime-connection.list',
      parameters: { runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId },
      workspaceId: `wsp_${suffix}`,
    })
  })
  test('refuses unknown registrations before contacting the Control Plane', async () => {
    const deps = await dependencies()
    await expect(
      listNodeRuntimeConnections({}, correlation, { ...deps, readRegisteredNode: async () => null })
    ).rejects.toMatchObject({ status: 404 })
    expect(deps.requests).toEqual([])
  })
  test('does not join a foreign node, changed location, or duplicate connection identity', async () => {
    for (const items of [
      [
        {
          ...model(),
          node: { ...model().node, runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFH' },
        },
      ],
      [{ ...model(), node: { ...model().node, location: 'local_device' } }],
      [model(), model()],
      [{ ...model(), connectionType: 'managed_cloud', location: 'agent_hq_cloud' }],
    ]) {
      const result = await listNodeRuntimeConnections({}, correlation, await dependencies(items))
      expect(result.discovery).toEqual({ state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' })
      expect(result.connections).toEqual([])
    }
  })
  test('keeps registration revocation, stale proof, and connection eligibility separate', async () => {
    const connection = {
      ...model(),
      connection: { status: 'degraded', health: 'degraded', availability: 'reconnecting' },
      access: {
        localProjectGrant: { required: true, state: 'missing' },
        entitlement: { state: 'denied' },
      },
      eligibility: {
        state: 'ineligible',
        reasons: ['LOCAL_PROJECT_GRANT_REQUIRED'],
        degradations: [],
        remediation: [{ code: 'LOCAL_PROJECT_GRANT_REQUIRED', label: 'private-path-canary' }],
      },
    }
    const deps = await dependencies([connection])
    const result = await listNodeRuntimeConnections({}, correlation, {
      ...deps,
      readRegisteredNode: async () => ({ ...node, health: 'stale', pairingState: 'revoked' }),
    })
    expect(result.node).toMatchObject({ health: 'stale', pairingState: 'revoked' })
    expect(result.connections[0]).toMatchObject({
      connection: { availability: 'reconnecting' },
      access: { localProjectGrant: { state: 'missing' } },
      eligibility: { state: 'ineligible' },
    })
    expect(JSON.stringify(result)).not.toContain('private-path-canary')
  })
  test('reclassifies expired, old and future inventory observations on every read', async () => {
    for (const [freshness, state] of [
      [{ ...model().freshness, expiresAt: '2026-10-07T06:00:30.000Z' }, 'expired'],
      [{ ...model().freshness, observedAt: '2026-10-07T05:00:00.000Z' }, 'stale'],
      [{ ...model().freshness, observedAt: '2026-10-07T06:02:00.000Z' }, 'unknown'],
    ] as const) {
      const result = await listNodeRuntimeConnections(
        {},
        correlation,
        await dependencies([{ ...model(), freshness }])
      )
      expect(result.connections[0]?.freshness.state).toBe(state)
    }
  })
  test('retains node metadata on unconfigured or unavailable discovery without echoing secrets', async () => {
    const deps = await dependencies([
      {
        ...model(),
        secret: 'inert-secret-canary',
        executableIdentity: '/private/native/path',
        node: { ...model().node, endpoint: 'https://private-node.example' },
        connection: { ...model().connection, processHandle: 'private-process-canary' },
      },
    ])
    let result = await listNodeRuntimeConnections({}, correlation, deps)
    expect(JSON.stringify(result)).not.toContain('inert-secret-canary')
    expect(JSON.stringify(result)).not.toContain('/private/native/path')
    expect(JSON.stringify(result)).not.toContain('private-node.example')
    expect(JSON.stringify(result)).not.toContain('private-process-canary')
    result = await listNodeRuntimeConnections({}, correlation, { ...deps, environment: {} })
    expect(result.node.id).toBe(node.id)
    expect(result.discovery).toEqual({ state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' })
    expect(result.connections).toEqual([])
  })

  test('classifies stale or future model timestamps even when the freshness field claims fresh', async () => {
    for (const [observedAt, state] of [
      ['2026-10-07T05:00:00.000Z', 'stale'],
      ['2026-10-07T06:02:00.000Z', 'unknown'],
    ] as const) {
      const result = await listNodeRuntimeConnections(
        {},
        correlation,
        await dependencies([{ ...model(), observedAt }])
      )
      expect(result.connections[0]?.freshness.state).toBe(state)
    }
  })
})
