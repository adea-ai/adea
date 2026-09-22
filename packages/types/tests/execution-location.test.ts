import { describe, expect, test } from 'bun:test'

import {
  decideExecutionLocation,
  resolveExecutionRetry,
  type ExecutionDataAvailability,
  type ExecutionLocationPolicyInput,
  type ExecutionLocationRerouteAuthorization,
  type ExecutionLocationSelection,
  type RuntimeNodeExecutionReadModel,
  normalizeExecutionRuntimeNodeAvailability,
} from '../src/execution-location'

const now = '2026-09-22T12:00:00.000Z'
const observedAt = '2026-09-22T11:59:00.000Z'
const dataAvailability: ExecutionDataAvailability = {
  channelMessageMetadata: 'available',
  localOnlyContent: 'available',
  synchronizedHistory: 'available',
}

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

describe('execution location policy', () => {
  test('defaults to the local device and does not consider self-hosted nodes', () => {
    const decision = decideExecutionLocation(input())

    expect(decision).toMatchObject({
      action: 'execute',
      selectedLocation: { kind: 'local_device', runtimeNodeId: 'local-1' },
    })
  })

  test('honors an explicit self-hosted selection', () => {
    const requestedLocation: ExecutionLocationSelection = {
      kind: 'remote_host',
      runtimeNodeId: 'host-1',
    }
    const decision = decideExecutionLocation(input({ requestedLocation }))

    expect(decision).toMatchObject({ action: 'execute', selectedLocation: requestedLocation })
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

describe('execution location retries', () => {
  const scope = {
    accountId: 'account-1',
    actorId: 'actor-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
  } as const
  const attempt = {
    attempt: 1,
    scope,
    selectedLocation: { kind: 'remote_host', runtimeNodeId: 'host-1' } as const,
  }
  const policy = input()

  test('preserves the selected location when retrying', () => {
    expect(resolveExecutionRetry({ attempt, policy })).toMatchObject({
      admission: expect.objectContaining({ action: 'execute' }),
      attempt: { attempt: 2, scope, selectedLocation: attempt.selectedLocation },
      change: 'sticky_retry',
      ok: true,
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
      admission: { action: 'execute' },
      attempt: { attempt: 2, scope, selectedLocation: requestedLocation },
      change: 'authorized_reroute',
      ok: true,
    })
  })
})
