import { describe, expect, test } from 'bun:test'

import {
  decideExecutionLocation,
  resolveExecutionRetry,
  type ExecutionDataAvailability,
  type ExecutionLocationPolicyInput,
  type ExecutionLocationSelection,
  type RuntimeNodeExecutionReadModel,
} from '../src/execution-location'

const dataAvailability: ExecutionDataAvailability = {
  channelMessageMetadata: 'available',
  localOnlyContent: 'available',
  synchronizedHistory: 'available',
}

function node(
  id: string,
  kind: RuntimeNodeExecutionReadModel['kind'],
  availability: RuntimeNodeExecutionReadModel['availability'] = 'available',
  capabilities: readonly string[] = ['task.execute']
): RuntimeNodeExecutionReadModel {
  return { availability, capabilities, displayName: id, id, kind }
}

function input(
  overrides: Partial<ExecutionLocationPolicyInput> = {}
): ExecutionLocationPolicyInput {
  return {
    dataAvailability,
    localRuntimeNodeId: 'local-1',
    nodes: [node('local-1', 'local_device'), node('host-1', 'remote_host')],
    requiredCapabilities: ['task.execute'],
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
})

describe('execution location retries', () => {
  const attempt = {
    attempt: 1,
    selectedLocation: { kind: 'remote_host', runtimeNodeId: 'host-1' } as const,
  }

  test('preserves the selected location when retrying', () => {
    expect(resolveExecutionRetry({ attempt })).toEqual({
      attempt: { attempt: 2, selectedLocation: attempt.selectedLocation },
      change: 'sticky_retry',
      ok: true,
    })
  })

  test('requires explicit authorization before changing location', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const

    expect(resolveExecutionRetry({ attempt, requestedLocation })).toEqual({
      change: 'reroute_requires_authorization',
      ok: false,
      previousLocation: attempt.selectedLocation,
      requestedLocation,
    })
  })

  test('records an authorized reroute as a new attempt location', () => {
    const requestedLocation = { kind: 'local_device', runtimeNodeId: 'local-1' } as const

    expect(resolveExecutionRetry({ attempt, authorizedReroute: true, requestedLocation })).toEqual({
      attempt: { attempt: 2, selectedLocation: requestedLocation },
      change: 'authorized_reroute',
      ok: true,
    })
  })
})
