import {
  ApiClientError,
  createApiClient,
  type AgentHqApiClient,
  type ApiRuntimeConnection,
  type ApiRuntimeNode,
  type ApiRuntimeNodeConnectionsResponse,
} from '@adea-ai/api-client'

/**
 * A disposable in-page stand-in for the runtime-node routes and the pairing, rename and revoke
 * operations, for the self-hosted setup harness. Everything here is synthetic: the "credentials"
 * are fixed strings that authorize nothing, and no request leaves the page. Failures are queued by
 * tests so each recovery path is exercised without a real endpoint.
 */

export type FakeFailure = Readonly<{ status: number; code?: string }>
export type FakeCompat = 'compatible' | 'incompatible' | 'deprecated' | 'capability_missing'

export type FakeHost = {
  id: string
  ref: string
  displayName: string
  kind: 'local_device' | 'remote_host'
  platform: string
  softwareVersion: string
  pairingState: 'paired' | 'revoked'
  /** Milliseconds since epoch of the last accepted proof, or null for none. */
  lastProofAt: number | null
  compat: FakeCompat
  capabilities: string[]
  /** The entitlement the Control Plane reports. Defaults to allowed. */
  entitlement?: 'allowed' | 'unknown'
  unsupported?: { name: string; limitation: string }
}

export type FakeState = {
  /** Hosts per account and workspace. */
  hosts: Record<string, FakeHost[]>
  account: string
  workspace: string
  listFailures: FakeFailure[]
  /** Hold the next host-list read until `releaseList()` is called. */
  holdList: boolean
  discoveryFailures: Record<string, FakeFailure>
  discoveryUnavailable: string[]
  /** Host id to the Control Plane ref its discovery report claims, for identity-mismatch tests. */
  discoveryRefs: Record<string, string>
  pairingFailure?: FakeFailure
  pairingLifetimeMs: number
  renameFailure?: FakeFailure
  revokeFailure?: FakeFailure
  /** Accept the revoke request but leave the host registered. */
  revokeIgnored: boolean
  /** Hold the next revoke until `release()` is called. */
  holdRevoke: boolean
  /** Hold the next account bootstrap read until `releaseBootstrap()` is called. */
  holdBootstrap: boolean
  requests: { method: string; path: string }[]
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

export function host(partial: Partial<FakeHost> & Pick<FakeHost, 'id' | 'displayName'>): FakeHost {
  return {
    ref: `rnr_${'0'.repeat(20)}${partial.id.slice(-6).toUpperCase().padStart(6, '0')}`,
    kind: 'remote_host',
    platform: 'Linux',
    softwareVersion: '1.72.0',
    pairingState: 'paired',
    lastProofAt: Date.now() - 20 * SECOND,
    compat: 'compatible',
    capabilities: ['chat', 'tools'],
    ...partial,
  }
}

export function seedHosts(): FakeHost[] {
  return [
    host({ id: 'host-aaaaaa', displayName: 'Home server' }),
    host({
      id: 'host-bbbbbb',
      displayName: 'Home server',
      softwareVersion: '1.70.1',
      lastProofAt: Date.now() - 10 * MINUTE,
    }),
    host({
      id: 'host-cccccc',
      displayName: 'Office box',
      softwareVersion: '1.40.0',
      compat: 'incompatible',
      unsupported: { name: 'tools', limitation: 'protocol 2 is not supported' },
    }),
    host({
      id: 'host-dddddd',
      displayName: 'Retired VPS',
      pairingState: 'revoked',
      lastProofAt: Date.now() - 3 * 24 * 60 * MINUTE,
    }),
    host({ id: 'laptop-eeeeee', displayName: 'Laptop', kind: 'local_device', platform: 'macOS' }),
  ]
}

export function createFakeState(hosts: FakeHost[]): FakeState {
  return {
    hosts: { 'user-a:ws-1': hosts, 'user-a:ws-2': [], 'user-b:ws-1': [] },
    account: 'user-a',
    workspace: 'ws-1',
    listFailures: [],
    holdList: false,
    discoveryFailures: {},
    discoveryUnavailable: [],
    discoveryRefs: {},
    pairingLifetimeMs: 10 * MINUTE,
    revokeIgnored: false,
    holdRevoke: false,
    holdBootstrap: false,
    requests: [],
  }
}

export function key(state: FakeState): string {
  return `${state.account}:${state.workspace}`
}

function fail(failure: FakeFailure): never {
  throw new ApiClientError('fixture failure', failure.status, failure.code)
}

function toNode(item: FakeHost): ApiRuntimeNode {
  const age = item.lastProofAt === null ? Infinity : Date.now() - item.lastProofAt
  return {
    id: item.id,
    controlPlaneRuntimeNodeRefId: item.ref,
    kind: item.kind,
    displayName: item.displayName,
    health: item.lastProofAt === null ? 'unknown' : age > 5 * MINUTE ? 'stale' : 'healthy',
    pairingState: item.pairingState,
    lastProofAt: item.lastProofAt === null ? null : new Date(item.lastProofAt).toISOString(),
    lastSeenAt: item.lastProofAt === null ? null : new Date(item.lastProofAt).toISOString(),
    platform: item.platform,
    softwareVersion: item.softwareVersion,
  }
}

function toConnection(item: FakeHost): ApiRuntimeConnection {
  const observedAt = new Date(Date.now() - 5 * SECOND).toISOString()
  const bad = item.compat !== 'compatible'
  return {
    id: `rc_${item.id}`,
    runtimeDefinitionId: 'managed-pi',
    family: 'pi',
    connectionType: 'managed_local',
    location: 'remote_host',
    status: bad ? 'degraded' : 'available',
    node: {
      runtimeNodeRefId: item.ref,
      location: 'remote_host',
      status: 'online',
      health: 'online',
      deviceOnline: { state: 'not_applicable' },
      hostReachability: {
        state: 'unknown',
        dependency: 'control_plane.runtime_connection_discovery.host_reachability',
      },
      observedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt },
    versions: {
      adapter: item.softwareVersion,
      driver: item.softwareVersion,
      harness: '1.0.0',
      protocol: '3.0',
    },
    capabilities: item.capabilities,
    capabilityDetails: [
      ...item.capabilities.map((name) => ({ name, support: 'supported' as const })),
      ...(item.unsupported
        ? [
            {
              name: item.unsupported.name,
              support: 'unsupported' as const,
              limitations: [item.unsupported.limitation],
            },
          ]
        : []),
    ],
    compatibility: {
      state: item.compat,
      limitations: item.unsupported ? [item.unsupported.limitation] : [],
    },
    access: {
      localProjectGrant: { required: false, state: 'not_required' },
      entitlement: { state: item.entitlement ?? 'allowed' },
    },
    eligibility: {
      state: bad ? 'ineligible' : 'eligible',
      reasons: bad ? [item.compat] : [],
      degradations: [],
      remediation: bad ? ['upgrade_control_plane'] : [],
    },
    transport: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.transport',
    },
    sessionOperations: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.session_operations',
    },
    observedAt,
    limitations: [],
  }
}

/** Fetch for the typed client: the two read routes, with queued failures. */
function respond(body: unknown, status = 200) {
  return Response.json(body, { status })
}

export function createFakeFetch(state: FakeState): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href
    )
    const method = init?.method ?? 'GET'
    state.requests.push({ method, path: url.pathname })
    const hosts = state.hosts[key(state)] ?? []
    if (method === 'POST' && url.pathname === '/api/workspaces/bootstrap') {
      // The answer belongs to the account that asked, whatever the page shows when it lands.
      const asked = state.account
      if (state.holdBootstrap) {
        state.holdBootstrap = false
        await new Promise<void>((resolve) => {
          releaseBootstrapHeld = resolve
        })
      }
      return respond({
        activeWorkspace: null,
        principal: { displayName: asked, temporary: false, userId: asked },
        sessionRotated: false,
        workspaces: [],
      })
    }
    const match =
      /^\/api\/v1\/workspaces\/([^/]+)\/runtime-nodes(?:\/([^/]+)\/connections)?$/u.exec(
        url.pathname
      )
    if (!match) return respond({ message: 'not found' }, 404)
    if (match[1] !== state.workspace) return respond({ message: 'unavailable' }, 404)
    if (!match[2]) {
      if (state.holdList) {
        state.holdList = false
        await new Promise<void>((resolve) => {
          releaseListHeld = resolve
        })
      }
      const queued = state.listFailures.shift()
      if (queued)
        return respond({ code: queued.code, message: 'sensitive-error-canary' }, queued.status)
      return respond({ nodes: hosts.map(toNode) })
    }
    const item = hosts.find((candidate) => candidate.id === match[2])
    if (!item) return respond({ message: 'unavailable' }, 404)
    const failure = state.discoveryFailures[item.id]
    if (failure)
      return respond({ code: failure.code, message: 'sensitive-error-canary' }, failure.status)
    const unavailable = state.discoveryUnavailable.includes(item.id)
    const body: ApiRuntimeNodeConnectionsResponse = {
      node: {
        id: item.id,
        controlPlaneRuntimeNodeRefId: state.discoveryRefs[item.id] ?? item.ref,
        kind: item.kind,
        displayName: item.displayName,
        health: toNode(item).health,
        pairingState: item.pairingState,
        lastProofAt: toNode(item).lastProofAt,
        deviceOnline: { state: 'not_applicable' },
        hostReachability: {
          state: 'unknown',
          dependency: 'control_plane.runtime_connection_discovery.host_reachability',
        },
      },
      controlPlaneReadiness: {
        state: 'unknown',
        dependency: 'control_plane.runtime_connection_discovery.readiness',
      },
      discovery: unavailable
        ? { state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' }
        : { state: 'available' },
      connections: unavailable || item.pairingState === 'revoked' ? [] : [toConnection(item)],
      observedAt: new Date().toISOString(),
    }
    return respond(body)
  }
}

export function createFakeClient(state: FakeState): AgentHqApiClient {
  return createApiClient({ fetchImpl: createFakeFetch(state) })
}

let releaseBootstrapHeld: (() => void) | undefined
export function releaseBootstrap(): void {
  releaseBootstrapHeld?.()
  releaseBootstrapHeld = undefined
}

let releaseListHeld: (() => void) | undefined
export function releaseList(): void {
  releaseListHeld?.()
  releaseListHeld = undefined
}

let releaseHeld: (() => void) | undefined
export function release(): void {
  releaseHeld?.()
  releaseHeld = undefined
}

/** The operations the backend exposes (or will), implemented against the fake state. */
export function createFakeOperations(state: FakeState, onRegister: (item: FakeHost) => void) {
  // A request belongs to the account and workspace that sent it, whatever the page shows by the
  // time it is answered.
  const find = (id: string, scopeKey: string) =>
    (state.hosts[scopeKey] ?? []).find((item) => item.id === id)
  return {
    async openPairing() {
      state.requests.push({ method: 'POST', path: '/api/v1/workspaces/runtime-nodes' })
      if (state.pairingFailure) fail(state.pairingFailure)
      return {
        challengeId: `chal-${Math.random().toString(16).slice(2, 10)}`,
        nonce: 'synthetic-nonce-0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        exchangeCredential: 'adea_reg_SYNTHETIC-NOT-A-CREDENTIAL',
        expiresAt: new Date(Date.now() + state.pairingLifetimeMs).toISOString(),
      }
    },
    async renameHost(hostId: string, displayName: string) {
      state.requests.push({ method: 'POST', path: `/rename/${hostId}` })
      const scopeKey = key(state)
      if (state.renameFailure) fail(state.renameFailure)
      const item = find(hostId, scopeKey)
      if (!item) fail({ status: 404, code: 'not_found' })
      item.displayName = displayName
    },
    async revokeHost(hostId: string, reason: string) {
      state.requests.push({ method: 'POST', path: `/revoke/${hostId}` })
      const scopeKey = key(state)
      if (state.holdRevoke) {
        state.holdRevoke = false
        await new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
      }
      if (state.revokeFailure) fail(state.revokeFailure)
      const item = find(hostId, scopeKey)
      if (!item) fail({ status: 404, code: 'not_found' })
      if (item.pairingState === 'revoked') fail({ status: 409, code: 'revoked' })
      if (!state.revokeIgnored) item.pairingState = 'revoked'
      void reason
    },
    register(partial: Partial<FakeHost> & Pick<FakeHost, 'id' | 'displayName'>) {
      const created = host(partial)
      state.hosts[key(state)] = [...(state.hosts[key(state)] ?? []), created]
      onRegister(created)
    },
  }
}
