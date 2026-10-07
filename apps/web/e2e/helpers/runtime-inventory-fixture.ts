import type { ApiRuntimeConnection, ApiRuntimeNode } from '@adea-ai/api-client'

export const runtimeFixtureNodeIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const

/** Deterministic read-only responses through the real workspace API client. */
export async function runtimeInventoryFixtureResponse(
  url: URL,
  signal?: AbortSignal
): Promise<Response | undefined> {
  if (!/^\/api\/v1\/workspaces\/[^/]+\/runtime-nodes(?:\/|$)/u.test(url.pathname)) return undefined
  const root = document.querySelector('#harness-root')
  const mode = root?.getAttribute('data-runtime-inventory') ?? 'empty'
  if (mode === 'forbidden')
    return Response.json({ message: 'sensitive-error-canary' }, { status: 403 })
  if (mode === 'failure')
    return Response.json({ message: 'sensitive-error-canary' }, { status: 500 })
  const now = new Date().toISOString()
  const nodes: ApiRuntimeNode[] = runtimeFixtureNodeIds.map((id, index) => ({
    id,
    controlPlaneRuntimeNodeRefId: `rnr_${String(index + 1).padStart(26, '0')}`,
    displayName: ['Laptop', 'Home server', 'Retired host'][index]!,
    kind: index === 0 ? 'local_device' : 'remote_host',
    health: index === 2 ? 'unknown' : 'healthy',
    pairingState: index === 2 ? 'revoked' : 'paired',
    lastProofAt: now,
    lastSeenAt: now,
    platform: index === 0 ? 'macOS' : 'Linux',
    softwareVersion: '1.60.0',
  }))
  if (url.pathname.endsWith('/runtime-nodes'))
    return Response.json({
      nodes:
        mode === 'empty'
          ? []
          : nodes.map((node) =>
              mode === 'future-proof-list'
                ? { ...node, lastProofAt: new Date(Date.now() + 60_000).toISOString() }
                : node
            ),
    })
  const nodeId = url.pathname.split('/').at(-2)
  const node = nodes.find((item) => item.id === nodeId)!
  if (mode === 'delayed')
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        cleanup()
        resolve()
      }
      const aborted = () => {
        cleanup()
        root?.setAttribute('data-runtime-aborted', 'true')
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      const cleanup = () => {
        window.removeEventListener('runtime-fixture-release', release)
        signal?.removeEventListener('abort', aborted)
      }
      window.addEventListener('runtime-fixture-release', release, { once: true })
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  const remote = node.kind === 'remote_host'
  const connection: ApiRuntimeConnection = {
    id: url.searchParams.has('cursor') ? 'rconn_external' : 'rconn_managed',
    runtimeDefinitionId: url.searchParams.has('cursor') ? 'External harness' : 'Managed Pi',
    family: 'pi',
    connectionType: 'managed_local',
    location: node.kind,
    status: remote ? 'unavailable' : 'available',
    node: {
      runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
      location: node.kind,
      status: remote ? 'offline' : 'online',
      health: remote ? 'offline' : 'online',
      observedAt: now,
    },
    connection: {
      status: remote ? 'disconnected' : 'connected',
      health: remote ? 'unavailable' : 'healthy',
      availability: remote ? 'offline' : 'healthy',
    },
    freshness: { state: 'fresh', observedAt: now },
    versions: { adapter: '1.0.0', driver: '2.0.0', harness: '3.0.0' },
    capabilities: ['execute'],
    capabilityDetails:
      mode === 'capability-details-unreported'
        ? []
        : [{ name: 'execute', support: remote ? 'unsupported' : 'supported' }],
    compatibility: {
      state: remote ? 'capability_missing' : 'compatible',
      limitations: remote ? ['required_capability_missing'] : [],
    },
    access: {
      localProjectGrant: { required: remote, state: remote ? 'missing' : 'not_required' },
      entitlement: { state: 'allowed' },
    },
    eligibility: {
      state: remote ? 'ineligible' : 'eligible',
      reasons: remote ? ['local_project_grant_missing'] : [],
      degradations: [],
      remediation: remote ? ['grant_local_project'] : [],
    },
    transport: { state: 'unreported' },
    observedAt: now,
    limitations: [],
  }
  return Response.json({
    node:
      mode === 'identity-mismatch'
        ? { ...node, id: runtimeFixtureNodeIds[2] }
        : mode === 'revoked-on-read'
          ? { ...node, pairingState: 'revoked' }
          : node,
    discovery:
      mode === 'unavailable'
        ? { state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' }
        : { state: 'available' },
    connections: mode === 'unavailable' || mode === 'empty-runtime' ? [] : [connection],
    ...(!remote && !url.searchParams.has('cursor') && mode !== 'unavailable'
      ? { nextCursor: 'cursor+second' }
      : {}),
    observedAt: now,
  })
}
