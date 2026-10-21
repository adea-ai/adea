import { describe, expect, test } from 'bun:test'

import type {
  HarnessAuthState,
  HarnessHealth,
  RuntimeConnectionTransport,
} from '../src/dev-runtime'
import {
  decideExecutionLocation,
  decideExecutionProfileAdmission,
  executionLocationBlockers,
  projectRuntimeConnectionExecutionReadModel,
  resolveExecutionRetry,
  type AgentProfileExecutionReadModel,
  type ExecutionLocationHealth,
  type ExecutionLocationPolicyInput,
  type ExecutionLocationRerouteAuthorization,
  type ExecutionLocationSelection,
  type ExecutionProfilePin,
  type ExecutionProfileState,
  type ExecutionTransport,
  type RuntimeConnectionExecutionReadModel,
  type RuntimeConnectionExecutionSource,
  type RuntimeNodeExecutionReadModel,
  normalizeExecutionRuntimeNodeAvailability,
} from '../src/execution-location'
import type { AgentProfileState } from '../src/index'
import type { TaskSubmissionSummary } from '../src/task-submission'

const now = '2026-09-22T12:00:00.000Z'
const observedAt = '2026-09-22T11:59:00.000Z'
const dataAvailability = {
  channelMessageMetadata: 'available',
  localOnlyContent: 'available',
  synchronizedHistory: 'available',
} as const

function node(
  id: string,
  kind: RuntimeNodeExecutionReadModel['kind'],
  availability: RuntimeNodeExecutionReadModel['availability'] = 'available',
  capabilities: readonly string[] = ['task.execute'],
  observedAtValue = observedAt,
  proofAt: string | null = observedAt
): RuntimeNodeExecutionReadModel {
  return {
    availability,
    capabilities,
    displayName: id,
    id,
    kind,
    observedAt: observedAtValue,
    proofAt,
  }
}

function input(
  overrides: Partial<ExecutionLocationPolicyInput> = {}
): ExecutionLocationPolicyInput {
  return {
    dataAvailability,
    localRuntimeNodeId: 'local-1',
    nodes: [node('local-1', 'local_device'), node('host-1', 'remote_host')],
    requiredCapabilities: ['task.execute'],
    now,
    ...overrides,
  }
}

const profile: ExecutionProfilePin = { id: 'prf_01', revision: 3, version: 'pfv_01' }

function profileModel(
  state: ExecutionProfileState,
  pin: ExecutionProfilePin = profile
): AgentProfileExecutionReadModel {
  return {
    identity: { controlPlaneAgentId: 'agt_01', id: 'agent-1' },
    pin,
    state,
  }
}

const healthyHealth: ExecutionLocationHealth = {
  host: 'online',
  node: 'healthy',
  provider: 'ready',
  runtime: 'healthy',
  transport: 'available',
}

function connectionSource(
  overrides: Partial<RuntimeConnectionExecutionSource> = {}
): RuntimeConnectionExecutionSource {
  return {
    access: { entitlement: 'allowed', grant: 'not_required' },
    capabilities: ['task.execute'],
    health: healthyHealth,
    identity: {
      id: 'connection-1',
      runtimeDefinitionId: 'runtime-definition-1',
      runtimeNodeId: 'host-1',
    },
    observedAt,
    transport: 'remote_gateway',
    ...overrides,
  }
}

function connection(
  overrides: Partial<RuntimeConnectionExecutionSource> = {}
): RuntimeConnectionExecutionReadModel {
  return projectRuntimeConnectionExecutionReadModel(connectionSource(overrides))
}

function connectionWithHealth(
  health: Partial<ExecutionLocationHealth>
): RuntimeConnectionExecutionReadModel {
  return projectRuntimeConnectionExecutionReadModel(
    connectionSource({ health: { ...healthyHealth, ...health } })
  )
}

describe('execution location policy', () => {
  test('defaults to the local device and does not consider self-hosted nodes', () => {
    const decision = decideExecutionLocation(input())

    expect(decision).toMatchObject({
      action: 'execute',
      provenance: 'default_local',
      selectedLocation: { kind: 'local_device', runtimeNodeId: 'local-1' },
    })
  })

  test('honors an explicit self-hosted selection', () => {
    const requestedLocation: ExecutionLocationSelection = {
      kind: 'remote_host',
      runtimeNodeId: 'host-1',
    }
    const decision = decideExecutionLocation(input({ requestedLocation }))

    expect(decision).toMatchObject({
      action: 'execute',
      provenance: 'explicit_selection',
      selectedLocation: requestedLocation,
    })
  })

  test('selects among several self-hosted nodes by identity and never substitutes another host', () => {
    const nodes = [
      node('local-1', 'local_device'),
      node('host-east', 'remote_host'),
      node('host-west', 'remote_host', 'offline'),
    ]

    const requestedLocation: ExecutionLocationSelection = {
      kind: 'remote_host',
      runtimeNodeId: 'host-east',
    }
    expect(decideExecutionLocation(input({ nodes, requestedLocation }))).toMatchObject({
      action: 'execute',
      selectedLocation: requestedLocation,
    })

    // The unavailable host queues: the healthy host beside it is never
    // substituted for the one the caller chose.
    expect(
      decideExecutionLocation(
        input({
          nodes,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'host-west' },
        })
      )
    ).toMatchObject({
      action: 'queue',
      blocker: 'location_offline',
      selectedLocation: { kind: 'remote_host', runtimeNodeId: 'host-west' },
    })

    // Identity is the (kind, id) pair, so a local node's id cannot be selected
    // as a self-hosted host even when no other node carries it.
    expect(
      decideExecutionLocation(
        input({
          nodes,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'local-1' },
        })
      )
    ).toMatchObject({ action: 'block', blocker: 'location_missing' })
  })

  test.each([
    ['offline', 'queue', 'location_offline', 'reconnect_location'],
    ['stale', 'queue', 'location_stale', 'refresh_location'],
    ['revoked', 'block', 'location_revoked', 'repair_or_select_location'],
    ['incompatible', 'block', 'location_incompatible', 'upgrade_or_select_compatible_location'],
  ] as const)(
    '%s selected locations return an explicit policy result',
    (availability, action, blocker, remediation) => {
      const decision = decideExecutionLocation(
        input({
          nodes: [node('local-1', 'local_device'), node('host-1', 'remote_host', availability)],
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'host-1' },
        })
      )

      expect(decision).toMatchObject({ action, blocker, remediation: { action: remediation } })
    }
  )

  test('does not silently relocate an unavailable local default to self-hosted', () => {
    const decision = decideExecutionLocation(
      input({
        nodes: [node('local-1', 'local_device', 'offline'), node('host-1', 'remote_host')],
      })
    )

    expect(decision).toMatchObject({
      action: 'queue',
      blocker: 'location_offline',
      selectedLocation: { kind: 'local_device', runtimeNodeId: 'local-1' },
    })
  })

  test('blocks a missing capability and reports deterministic remediation data', () => {
    const decision = decideExecutionLocation(
      input({
        requiredCapabilities: ['zeta', 'alpha', 'alpha'],
        nodes: [node('local-1', 'local_device')],
      })
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'capability_mismatch',
      missingCapabilities: ['alpha', 'zeta'],
      remediation: {
        action: 'enable_required_capabilities_or_select_location',
        missingCapabilities: ['alpha', 'zeta'],
      },
    })
  })

  test('keeps history and content dimensions independent from execution availability', () => {
    const decision = decideExecutionLocation(
      input({
        dataAvailability: {
          channelMessageMetadata: 'available',
          localOnlyContent: 'unavailable',
          synchronizedHistory: 'available',
        },
        nodes: [node('local-1', 'local_device', 'offline'), node('host-1', 'remote_host')],
      })
    )

    expect(decision).toMatchObject({
      action: 'queue',
      dataAvailability: {
        channelMessageMetadata: 'available',
        localOnlyContent: 'unavailable',
        synchronizedHistory: 'available',
      },
    })
  })

  test('queues an offline remote host while synchronized conversation history stays available', () => {
    const offlineDataAvailability = {
      channelMessageMetadata: 'available',
      localOnlyContent: 'unavailable',
      synchronizedHistory: 'available',
    } as const
    const requestedLocation: ExecutionLocationSelection = {
      kind: 'remote_host',
      runtimeNodeId: 'host-1',
    }

    const decision = decideExecutionLocation(
      input({
        dataAvailability: offlineDataAvailability,
        nodes: [node('local-1', 'local_device'), node('host-1', 'remote_host', 'offline')],
        requestedLocation,
      })
    )

    expect(decision).toMatchObject({
      action: 'queue',
      blocker: 'location_offline',
      selectedLocation: requestedLocation,
      dataAvailability: offlineDataAvailability,
    })
    expect(decision.dataAvailability.synchronizedHistory).toBe('available')
    expect(decision.dataAvailability.localOnlyContent).toBe('unavailable')
  })

  test('gates the future cloud location explicitly without falling back to it', () => {
    const decision = decideExecutionLocation(
      input({
        cloud: { enabled: false },
        requestedLocation: { kind: 'agent_hq_cloud' },
      })
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'cloud_feature_disabled',
      remediation: { action: 'enable_cloud_feature' },
      selectedLocation: { kind: 'agent_hq_cloud' },
    })
  })

  test('allows the reserved cloud contract only when its explicit gate is enabled', () => {
    const decision = decideExecutionLocation(
      input({
        cloud: { capabilities: ['task.execute'], enabled: true },
        requestedLocation: { kind: 'agent_hq_cloud' },
      })
    )

    expect(decision).toMatchObject({
      action: 'execute',
      selectedLocation: { kind: 'agent_hq_cloud' },
    })
  })

  test('normalizes unknown availability explicitly and blocks it', () => {
    expect(normalizeExecutionRuntimeNodeAvailability('future_state')).toBe('unknown')
    const decision = decideExecutionLocation(
      input({ nodes: [node('local-1', 'local_device', 'unknown')] })
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'location_unknown',
      remediation: { action: 'refresh_location' },
    })
  })

  test('blocks an available node without a proof timestamp', () => {
    const decision = decideExecutionLocation(
      input({
        nodes: [node('local-1', 'local_device', 'available', ['task.execute'], observedAt, null)],
      })
    )

    expect(decision).toMatchObject({ action: 'block', blocker: 'location_unknown' })
  })

  test('queues an available node whose observation is older than the bound', () => {
    const decision = decideExecutionLocation(
      input({
        nodes: [
          node(
            'local-1',
            'local_device',
            'available',
            ['task.execute'],
            '2026-09-22T11:00:00.000Z',
            '2026-09-22T11:59:00.000Z'
          ),
        ],
      })
    )

    expect(decision).toMatchObject({
      action: 'queue',
      blocker: 'location_stale',
      remediation: { action: 'refresh_location' },
    })
  })

  test('queues an available node whose proof is older than the bound', () => {
    const decision = decideExecutionLocation(
      input({
        nodes: [
          node(
            'local-1',
            'local_device',
            'available',
            ['task.execute'],
            observedAt,
            '2026-09-22T11:00:00.000Z'
          ),
        ],
      })
    )

    expect(decision).toMatchObject({
      action: 'queue',
      blocker: 'location_stale',
      remediation: { action: 'refresh_location' },
    })
  })

  test('blocks malformed or future admission timestamps as unknown', () => {
    const malformed = decideExecutionLocation(
      input({ nodes: [node('local-1', 'local_device', 'available', ['task.execute'], 'invalid')] })
    )
    const futureProof = decideExecutionLocation(
      input({
        nodes: [
          node(
            'local-1',
            'local_device',
            'available',
            ['task.execute'],
            observedAt,
            '2026-09-22T12:01:00.000Z'
          ),
        ],
      })
    )

    expect(malformed).toMatchObject({ action: 'block', blocker: 'location_unknown' })
    expect(futureProof).toMatchObject({ action: 'block', blocker: 'location_unknown' })
  })
})

describe('runtime connection read model', () => {
  test('reports the five health dimensions separately', () => {
    const model = connectionWithHealth({
      host: 'not_applicable',
      node: 'stale',
      provider: 'expired',
      runtime: 'degraded',
      transport: 'unavailable',
    })

    expect(model.health).toEqual({
      host: 'not_applicable',
      node: 'stale',
      provider: 'expired',
      runtime: 'degraded',
      transport: 'unavailable',
    })
  })

  test('changing one health dimension leaves the other four untouched', () => {
    const healthy = connectionWithHealth({})
    const degraded = connectionWithHealth({ runtime: 'degraded' })

    expect(degraded.health.runtime).toBe('degraded')
    expect(degraded.health.host).toBe(healthy.health.host)
    expect(degraded.health.node).toBe(healthy.health.node)
    expect(degraded.health.provider).toBe(healthy.health.provider)
    expect(degraded.health.transport).toBe(healthy.health.transport)
  })

  test('keeps the node read model and the connection health separate', () => {
    const model = connectionWithHealth({ node: 'healthy', runtime: 'unhealthy' })

    // The registered node's own availability is a different observation and is
    // never merged into the connection's runtime health.
    expect(model.health.node).toBe('healthy')
    expect(model.health.runtime).toBe('unhealthy')
    expect(node('host-1', 'remote_host').availability).toBe('available')
  })

  test('keeps the connection identity stable when the transport variant changes', () => {
    const direct = connection({ transport: 'direct_local' })
    const gateway = connection({ transport: 'remote_gateway' })

    expect(direct.identity).toEqual(gateway.identity)
    expect(direct.transport).toBe('direct_local')
    expect(gateway.transport).toBe('remote_gateway')
  })

  test('names the connection by its public reference, never by a display name', () => {
    const model = connection()

    expect(model.identity).toEqual({
      id: 'connection-1',
      runtimeDefinitionId: 'runtime-definition-1',
      runtimeNodeId: 'host-1',
    })
    expect(Object.keys(model.identity).toSorted()).toEqual([
      'id',
      'runtimeDefinitionId',
      'runtimeNodeId',
    ])
  })

  test('a healthy connection reports no blocked state', () => {
    expect(connection().blockers).toEqual([])
  })

  test.each([
    [{ runtime: 'unhealthy' as const }, 'connection_unavailable'],
    [{ provider: 'required' as const }, 'provider_auth_required'],
    [{ provider: 'expired' as const }, 'provider_auth_expired'],
    [{ transport: 'unavailable' as const }, 'transport_unavailable'],
  ] as const)('%o reports an explicit blocked state', (health, blocker) => {
    expect(connectionWithHealth(health).blockers).toEqual([blocker])
  })

  test.each([
    [{ grant: 'missing' as const }, 'grant_missing'],
    [{ grant: 'revoked' as const }, 'grant_revoked'],
    [{ entitlement: 'denied' as const }, 'entitlement_denied'],
  ] as const)('a %o access fact reports an explicit blocked state', (access, blocker) => {
    expect(
      connection({ access: { entitlement: 'allowed', grant: 'not_required', ...access } }).blockers
    ).toEqual([blocker])
  })

  test('a not-required or granted project grant blocks nothing', () => {
    expect(
      connection({ access: { entitlement: 'allowed', grant: 'not_required' } }).blockers
    ).toEqual([])
    expect(connection({ access: { entitlement: 'allowed', grant: 'granted' } }).blockers).toEqual(
      []
    )
  })

  test('the node and host dimensions never produce a connection blocked state', () => {
    // The registered node's read model stays the authority for node and host
    // admission, so a connection must not report a second answer for them.
    const model = connectionWithHealth({ host: 'offline', node: 'stale' })

    expect(model.blockers).toEqual([])
    expect(model.health.host).toBe('offline')
    expect(model.health.node).toBe('stale')
  })

  test('an unknown observation is reported as unknown and never as healthy', () => {
    const model = connectionWithHealth({
      host: 'unknown',
      node: 'unknown',
      provider: 'unknown',
      runtime: 'unknown',
      transport: 'unknown',
    })

    expect(model.health).toEqual({
      host: 'unknown',
      node: 'unknown',
      provider: 'unknown',
      runtime: 'unknown',
      transport: 'unknown',
    })
    expect(model.blockers).toEqual([])
  })

  test('the projection carries no secret, path, endpoint or native private state', () => {
    const source = {
      ...connectionSource(),
      clientSecret: 'sk-native-secret',
      credentials: { token: 'native-token' },
      endpoint: 'https://host.internal:8443',
      executableIdentity: '/Users/owner/native/runtime/bin/adea-host',
      nativeSessionState: { pid: 4321, cwd: '/Users/owner/private' },
      privateKey: '-----BEGIN PRIVATE KEY-----',
    } as unknown as RuntimeConnectionExecutionSource

    const model = projectRuntimeConnectionExecutionReadModel(source)
    const serialized = JSON.stringify(model)

    expect(Object.keys(model).toSorted()).toEqual([
      'access',
      'blockers',
      'capabilities',
      'health',
      'identity',
      'observedAt',
      'transport',
    ])
    for (const secret of [
      'sk-native-secret',
      'native-token',
      'host.internal',
      '/Users/owner',
      'BEGIN PRIVATE KEY',
      'nativeSessionState',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  test('a nested extra never reaches the projection, only the named fields do', () => {
    // The nested objects are replaced wholesale by a source that carries an
    // unexpected key inside each of them. A spread would copy that key.
    const source = {
      ...connectionSource(),
      access: {
        clientSecret: 'nested-access-secret',
        entitlement: 'allowed',
        grant: 'granted',
      },
      health: {
        endpoint: 'https://host.internal:8443',
        host: 'online',
        node: 'healthy',
        provider: 'ready',
        runtime: 'healthy',
        transport: 'available',
      },
      identity: {
        id: 'connection-1',
        nativeSessionState: { pid: 4321, cwd: '/Users/owner/private' },
        runtimeDefinitionId: 'runtime-definition-1',
        runtimeNodeId: 'host-1',
      },
    } as unknown as RuntimeConnectionExecutionSource

    const model = projectRuntimeConnectionExecutionReadModel(source)

    expect(Object.keys(model.access).toSorted()).toEqual(['entitlement', 'grant'])
    expect(Object.keys(model.health).toSorted()).toEqual([
      'host',
      'node',
      'provider',
      'runtime',
      'transport',
    ])
    expect(Object.keys(model.identity).toSorted()).toEqual([
      'id',
      'runtimeDefinitionId',
      'runtimeNodeId',
    ])
    expect(model.access).not.toHaveProperty('clientSecret')
    expect(model.health).not.toHaveProperty('endpoint')
    expect(model.identity).not.toHaveProperty('nativeSessionState')
  })

  test('a nested extra never reaches the serialized projection', () => {
    const source = {
      ...connectionSource(),
      access: {
        clientSecret: 'nested-access-secret',
        entitlement: 'allowed',
        grant: 'granted',
      },
      health: {
        endpoint: 'https://host.internal:8443',
        host: 'online',
        node: 'healthy',
        provider: 'ready',
        runtime: 'healthy',
        transport: 'available',
      },
      identity: {
        id: 'connection-1',
        nativeSessionState: { pid: 4321, cwd: '/Users/owner/private' },
        runtimeDefinitionId: 'runtime-definition-1',
        runtimeNodeId: 'host-1',
      },
    } as unknown as RuntimeConnectionExecutionSource

    const serialized = JSON.stringify(projectRuntimeConnectionExecutionReadModel(source))

    for (const extra of [
      'nested-access-secret',
      'host.internal',
      'nativeSessionState',
      '/Users/owner',
      'pid',
    ]) {
      expect(serialized).not.toContain(extra)
    }
  })

  test('the projection keeps every allowed field of the source', () => {
    const model = projectRuntimeConnectionExecutionReadModel(connectionSource())

    expect(model.access).toEqual({ entitlement: 'allowed', grant: 'not_required' })
    expect(model.health).toEqual(healthyHealth)
    expect(model.identity).toEqual({
      id: 'connection-1',
      runtimeDefinitionId: 'runtime-definition-1',
      runtimeNodeId: 'host-1',
    })
    expect(model.capabilities).toEqual(['task.execute'])
    expect(model.observedAt).toBe(observedAt)
    expect(model.transport).toBe('remote_gateway')
    expect(model.blockers).toEqual([])
  })

  test('the projection reads the caller’s input without changing it', () => {
    const source = connectionSource()
    const before = structuredClone(source)

    const model = projectRuntimeConnectionExecutionReadModel(source)

    expect(source).toEqual(before)
    // The projection shares no nested object with the caller, so a later
    // change to one cannot rewrite the other.
    expect(model.access).not.toBe(source.access)
    expect(model.health).not.toBe(source.health)
    expect(model.identity).not.toBe(source.identity)
    expect(model.capabilities).not.toBe(source.capabilities)
  })
})

describe('execution location with a runtime connection inventory', () => {
  const requestedLocation: ExecutionLocationSelection = {
    kind: 'remote_host',
    runtimeNodeId: 'host-1',
  }

  function policyWith(
    connections: readonly RuntimeConnectionExecutionReadModel[]
  ): ExecutionLocationPolicyInput {
    return input({ connections, requestedLocation })
  }

  test('a connection without the required grant blocks the location', () => {
    const decision = decideExecutionLocation(
      policyWith([
        connection({
          access: { entitlement: 'allowed', grant: 'missing' },
          identity: {
            id: 'connection-1',
            runtimeDefinitionId: 'definition-1',
            runtimeNodeId: 'host-1',
          },
        }),
      ])
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'grant_missing',
      remediation: { action: 'repair_or_select_location' },
      selectedLocation: requestedLocation,
    })
  })

  test('a revoked grant blocks the location with a repairable remediation', () => {
    const decision = decideExecutionLocation(
      policyWith([
        connection({
          access: { entitlement: 'allowed', grant: 'revoked' },
        }),
      ])
    )

    expect(decision).toMatchObject({ action: 'block', blocker: 'grant_revoked' })
  })

  test('a denied entitlement blocks the location', () => {
    const decision = decideExecutionLocation(
      policyWith([connection({ access: { entitlement: 'denied', grant: 'not_required' } })])
    )

    expect(decision).toMatchObject({ action: 'block', blocker: 'entitlement_denied' })
  })

  test('stale connection inventory queues for a refresh instead of failing', () => {
    const decision = decideExecutionLocation(
      policyWith([connection({ observedAt: '2026-09-22T11:00:00.000Z' })])
    )

    expect(decision).toMatchObject({
      action: 'queue',
      blocker: 'connection_stale',
      remediation: { action: 'refresh_location' },
    })
  })

  test('a connection whose observation timestamp is unusable blocks', () => {
    const decision = decideExecutionLocation(policyWith([connection({ observedAt: 'invalid' })]))

    expect(decision).toMatchObject({ action: 'block', blocker: 'location_unknown' })
  })

  test('a connection missing a required capability blocks the location', () => {
    const decision = decideExecutionLocation(
      policyWith([connection({ capabilities: ['task.read'] })])
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'capability_mismatch',
      missingCapabilities: ['task.execute'],
    })
  })

  test('one usable connection keeps the location executable', () => {
    const decision = decideExecutionLocation(
      policyWith([
        connection({
          access: { entitlement: 'allowed', grant: 'missing' },
          identity: {
            id: 'connection-1',
            runtimeDefinitionId: 'definition-1',
            runtimeNodeId: 'host-1',
          },
        }),
        connection({
          identity: {
            id: 'connection-2',
            runtimeDefinitionId: 'definition-2',
            runtimeNodeId: 'host-1',
          },
        }),
      ])
    )

    expect(decision).toMatchObject({ action: 'execute', selectedLocation: requestedLocation })
  })

  test('a connection registered for another node does not affect the selected location', () => {
    const decision = decideExecutionLocation(
      policyWith([
        connection({
          access: { entitlement: 'denied', grant: 'missing' },
          identity: {
            id: 'connection-9',
            runtimeDefinitionId: 'definition-9',
            runtimeNodeId: 'host-9',
          },
        }),
      ])
    )

    expect(decision).toMatchObject({ action: 'execute', selectedLocation: requestedLocation })
  })

  test('a node with no discovered connection is not blocked for that alone', () => {
    const decision = decideExecutionLocation(policyWith([]))

    expect(decision).toMatchObject({ action: 'execute' })
  })

  test('the node read model still decides node and host admission', () => {
    const decision = decideExecutionLocation(
      input({
        connections: [connection()],
        nodes: [node('local-1', 'local_device'), node('host-1', 'remote_host', 'offline')],
        requestedLocation,
      })
    )

    expect(decision).toMatchObject({ action: 'queue', blocker: 'location_offline' })
  })

  test('every reported blocked state has a remediation action', () => {
    for (const blocker of executionLocationBlockers) {
      expect(blocker.length).toBeGreaterThan(0)
    }
    expect(executionLocationBlockers).toContain('grant_missing')
    expect(executionLocationBlockers).toContain('connection_stale')
  })
})

describe('agent profile read model', () => {
  test('the Agent identity survives a profile version change', () => {
    const upgraded = profileModel('available', { id: 'prf_01', revision: 4, version: 'pfv_02' })
    const rolledBack = profileModel('available', { id: 'prf_01', revision: 5, version: 'pfv_01' })

    expect(upgraded.identity).toEqual(rolledBack.identity)
    expect(upgraded.pin).not.toEqual(rolledBack.pin)
  })

  test('an available pin is admissible', () => {
    expect(decideExecutionProfileAdmission(profileModel('available'))).toEqual({
      action: 'execute',
      pin: profile,
      reason: 'profile_available',
    })
  })

  test.each([
    ['missing', 'profile_missing', 'select_available_profile_version'],
    ['deprecated', 'profile_deprecated', 'upgrade_profile_version'],
    ['revoked', 'profile_revoked', 'select_available_profile_version'],
    ['incompatible', 'profile_incompatible', 'upgrade_profile_version'],
    ['unapproved', 'profile_unapproved', 'approve_profile_version'],
    ['unavailable', 'profile_unavailable', 'retry_profile_check'],
  ] as const)(
    'a %s pin has an explicit blocked state and remediation',
    (state, blocker, action) => {
      expect(decideExecutionProfileAdmission(profileModel(state))).toEqual({
        action: 'block',
        blocker,
        pin: profile,
        remediation: { action },
      })
    }
  )

  test('an unusable pin blocks instead of resolving to a newer version', () => {
    const decision = decideExecutionProfileAdmission(
      profileModel('available', { id: '', revision: 0, version: '' })
    )

    expect(decision).toMatchObject({
      action: 'block',
      blocker: 'profile_pin_invalid',
      remediation: { action: 'select_available_profile_version' },
    })
  })

  test('a negative pin revision blocks', () => {
    const decision = decideExecutionProfileAdmission(
      profileModel('available', { id: 'prf_01', revision: -1, version: 'pfv_01' })
    )

    expect(decision).toMatchObject({ action: 'block', blocker: 'profile_pin_invalid' })
  })

  test('the decision never reports a different pin than the one it was given', () => {
    const decision = decideExecutionProfileAdmission(profileModel('missing'))

    expect(decision.pin).toEqual(profile)
  })
})

describe('execution location retries', () => {
  const scope = {
    accountId: 'account-1',
    actorId: 'actor-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
  } as const
  const attempt = {
    attempt: 1,
    profile,
    scope,
    selectedLocation: { kind: 'remote_host', runtimeNodeId: 'host-1' } as const,
  }
  const policy = input()

  test('rejects an invalid attempt before evaluating location admission', () => {
    expect(
      resolveExecutionRetry({
        attempt: { ...attempt, attempt: 0 },
        policy,
      })
    ).toEqual({
      change: 'attempt_invalid',
      ok: false,
      previousLocation: attempt.selectedLocation,
    })
  })

  test('rejects an attempt whose profile pin is unusable', () => {
    expect(
      resolveExecutionRetry({
        attempt: { ...attempt, profile: { id: 'prf_01', revision: -1, version: 'pfv_01' } },
        policy,
      })
    ).toEqual({
      change: 'attempt_invalid',
      ok: false,
      previousLocation: attempt.selectedLocation,
    })
  })

  test('preserves the selected location when retrying', () => {
    expect(resolveExecutionRetry({ attempt, policy })).toMatchObject({
      admission: expect.objectContaining({ action: 'execute', provenance: 'sticky_retry' }),
      attempt: { attempt: 2, profile, scope, selectedLocation: attempt.selectedLocation },
      change: 'sticky_retry',
      ok: true,
    })
  })

  test('a retry keeps the attempt’s immutable profile pin', () => {
    const resolution = resolveExecutionRetry({
      attempt,
      policy,
      requestedProfile: profile,
    })

    expect(resolution).toMatchObject({ change: 'sticky_retry', ok: true })
    expect(resolution.ok && resolution.attempt.profile).toEqual(profile)
  })

  test('a retry may not move the attempt to another profile version', () => {
    const requestedProfile = { id: 'prf_01', revision: 9, version: 'pfv_02' }

    expect(resolveExecutionRetry({ attempt, policy, requestedProfile })).toEqual({
      change: 'profile_pin_changed',
      ok: false,
      previousLocation: attempt.selectedLocation,
      previousProfile: profile,
      requestedProfile,
    })
  })

  test('requires explicit authorization before changing location', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const

    expect(resolveExecutionRetry({ attempt, policy, requestedLocation })).toEqual({
      change: 'reroute_requires_authorization',
      ok: false,
      previousLocation: attempt.selectedLocation,
      requestedLocation,
    })
  })

  test('rejects a raw authorization boolean and does not treat it as proof', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const

    expect(
      resolveExecutionRetry({
        attempt,
        policy,
        requestedLocation,
        authorizedReroute: true,
      } as never)
    ).toEqual({
      change: 'reroute_requires_authorization',
      ok: false,
      previousLocation: attempt.selectedLocation,
      requestedLocation,
    })
  })

  test('rejects a proof bound to another attempt, scope, or target', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const
    const authorization: ExecutionLocationRerouteAuthorization = {
      attempt: 2,
      authorizationProof: 'auth-1',
      scope: { ...scope, actorId: 'other-actor' },
      targetLocation: { kind: 'remote_host', runtimeNodeId: 'host-1' },
    }

    expect(
      resolveExecutionRetry({
        attempt,
        policy,
        requestedLocation,
        rerouteAuthorization: authorization,
      })
    ).toEqual({
      change: 'reroute_authorization_invalid',
      ok: false,
      previousLocation: attempt.selectedLocation,
      requestedLocation,
    })
  })

  test('rejects an empty scoped authorization proof', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const
    const authorization: ExecutionLocationRerouteAuthorization = {
      attempt: attempt.attempt,
      authorizationProof: '   ',
      scope,
      targetLocation: requestedLocation,
    }

    expect(
      resolveExecutionRetry({
        attempt,
        policy,
        requestedLocation,
        rerouteAuthorization: authorization,
      })
    ).toMatchObject({
      change: 'reroute_authorization_invalid',
      ok: false,
    })
  })

  test('valid proof still requires current target admission', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const
    const authorization: ExecutionLocationRerouteAuthorization = {
      attempt: attempt.attempt,
      authorizationProof: 'auth-1',
      scope,
      targetLocation: requestedLocation,
    }
    const unavailablePolicy = input({
      nodes: [node('local-1', 'local_device', 'offline'), node('host-1', 'remote_host')],
    })

    expect(
      resolveExecutionRetry({
        attempt,
        policy: unavailablePolicy,
        requestedLocation,
        rerouteAuthorization: authorization,
      })
    ).toMatchObject({
      change: 'location_not_admissible',
      decision: { action: 'queue', blocker: 'location_offline' },
      ok: false,
    })
  })

  test('a valid proof cannot bypass missing, capability, or cloud admission', () => {
    const cases = [
      {
        blocker: 'location_missing',
        policy,
        requestedLocation: { kind: 'remote_host', runtimeNodeId: 'host-missing' } as const,
      },
      {
        blocker: 'capability_mismatch',
        policy: input({ requiredCapabilities: ['task.execute', 'task.missing'] }),
        requestedLocation: { kind: 'local_device', runtimeNodeId: 'local-1' } as const,
      },
      {
        blocker: 'cloud_feature_disabled',
        policy: input({ cloud: { enabled: false } }),
        requestedLocation: { kind: 'agent_hq_cloud' } as const,
      },
    ] as const

    for (const { blocker, policy: casePolicy, requestedLocation } of cases) {
      const authorization: ExecutionLocationRerouteAuthorization = {
        attempt: attempt.attempt,
        authorizationProof: `auth-${blocker}`,
        scope,
        targetLocation: requestedLocation,
      }
      expect(
        resolveExecutionRetry({
          attempt,
          policy: casePolicy,
          requestedLocation,
          rerouteAuthorization: authorization,
        })
      ).toMatchObject({
        change: 'location_not_admissible',
        decision: { action: 'block', blocker },
        ok: false,
      })
    }
  })

  test('records an authorized reroute as a new attempt location', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const
    const authorization: ExecutionLocationRerouteAuthorization = {
      attempt: attempt.attempt,
      authorizationProof: 'auth-1',
      scope,
      targetLocation: requestedLocation,
    }

    expect(
      resolveExecutionRetry({
        attempt,
        policy,
        requestedLocation,
        rerouteAuthorization: authorization,
      })
    ).toMatchObject({
      admission: { action: 'execute', provenance: 'authorized_reroute' },
      attempt: { attempt: 2, profile, scope, selectedLocation: requestedLocation },
      change: 'authorized_reroute',
      ok: true,
    })
  })
})

describe('contract conformance with the existing runtime contracts', () => {
  test('the transport vocabulary is the native contract’s own vocabulary', () => {
    const executionTransports: readonly ExecutionTransport[] = ['direct_local', 'remote_gateway']
    const nativeTransports: readonly RuntimeConnectionTransport[] = executionTransports
    const backToExecution: readonly ExecutionTransport[] = nativeTransports

    expect(backToExecution).toEqual(['direct_local', 'remote_gateway'])
  })

  test('the runtime health vocabulary is the native harness health vocabulary', () => {
    const executionHealth: readonly HarnessHealth[] = [
      'healthy',
      'degraded',
      'unhealthy',
      'unknown',
    ]
    const nativeHealth: readonly HarnessHealth[] = executionHealth
    const backToExecution: readonly HarnessHealth[] = nativeHealth

    expect(backToExecution).toEqual(['healthy', 'degraded', 'unhealthy', 'unknown'])
  })

  test('the provider health vocabulary is the native auth state vocabulary', () => {
    const executionProvider: readonly HarnessAuthState[] = [
      'ready',
      'required',
      'expired',
      'unknown',
    ]
    const nativeAuth: readonly HarnessAuthState[] = executionProvider
    const backToExecution: readonly HarnessAuthState[] = nativeAuth

    expect(backToExecution).toEqual(['ready', 'required', 'expired', 'unknown'])
  })

  test('the profile state vocabulary is the agent profile state vocabulary', () => {
    const executionStates: readonly ExecutionProfileState[] = [
      'available',
      'deprecated',
      'missing',
      'revoked',
      'incompatible',
      'unapproved',
      'unavailable',
    ]
    const agentStates: readonly AgentProfileState[] = executionStates
    const backToExecution: readonly ExecutionProfileState[] = agentStates

    expect(backToExecution).toHaveLength(7)
  })

  test('the profile pin is the submission’s own profile reference', () => {
    const submissionProfile: TaskSubmissionSummary['profile'] = {
      id: 'prf_01',
      revision: 3,
      version: 'pfv_01',
    }
    const pin: ExecutionProfilePin = submissionProfile
    const backToSubmission: TaskSubmissionSummary['profile'] = pin

    expect(backToSubmission).toEqual(submissionProfile)
  })
})
