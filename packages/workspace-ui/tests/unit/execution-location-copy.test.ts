import { describe, expect, test } from 'bun:test'

import {
  describeExecutionAttempt,
  describeExecutionHistory,
  executionLocationLabel,
  executionNodeLabel,
} from '../../src/execution-location-copy'
import type { ExecutionAttemptSummary, TaskExecutionLocation } from '@adea-ai/types'

const attempt = (over: Partial<ExecutionAttemptSummary>): ExecutionAttemptSummary => ({
  attempt: 1,
  change: 'initial',
  locationKind: 'local_device',
  recordedAt: '2026-10-06T00:00:00.000Z',
  ...over,
})

describe('execution-location copy (#671)', () => {
  test('a task that never left the device never claims a node', () => {
    const line = describeExecutionAttempt(attempt({ locationKind: 'local_device' }))
    expect(line).toBe('Attempt 1 — This device (first attempt)')
    expect(line).not.toContain('node')
    expect(line).not.toContain('Remote')
  })

  test('a cloud attempt is nodeless by policy, even if a stray id survived storage', () => {
    // The read model normalizes this; the projection refuses to invent one.
    const line = describeExecutionAttempt(
      attempt({
        locationKind: 'agent_hq_cloud',
        runtimeNodeId: '00000000-0000-4000-8000-00000000abcd',
      })
    )
    expect(line).toBe('Attempt 1 — Adea cloud (first attempt)')
  })

  test('a remote attempt names the location and the node', () => {
    const line = describeExecutionAttempt(
      attempt({
        locationKind: 'remote_host',
        runtimeNodeId: '00000000-0000-4000-8000-00000000abcd',
      })
    )
    expect(line).toBe('Attempt 1 — Remote host, node 00000000… (first attempt)')
    expect(executionNodeLabel('00000000-0000-4000-8000-00000000abcd')).toBe('node 00000000…')
  })

  test('a rerouted attempt shows both the original and the authorized location', () => {
    const execution: TaskExecutionLocation = {
      current: attempt({
        attempt: 2,
        change: 'authorized_reroute',
        locationKind: 'remote_host',
        runtimeNodeId: '00000000-0000-4000-8000-00000000beef',
      }),
      attempts: [
        attempt({ attempt: 1, change: 'initial', locationKind: 'local_device' }),
        attempt({
          attempt: 2,
          change: 'authorized_reroute',
          locationKind: 'remote_host',
          runtimeNodeId: '00000000-0000-4000-8000-00000000beef',
        }),
      ],
    }
    const lines = describeExecutionHistory(execution)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('Attempt 1 — This device (first attempt)')
    expect(lines[1]).toBe('Attempt 2 — Remote host, node 00000000… (authorized reroute)')
  })

  test('a sticky retry is labeled, and the kind labels are stable', () => {
    expect(describeExecutionAttempt(attempt({ attempt: 2, change: 'sticky_retry' }))).toBe(
      'Attempt 2 — This device (sticky retry)'
    )
    expect(executionLocationLabel('local_device')).toBe('This device')
    expect(executionLocationLabel('remote_host')).toBe('Remote host')
    expect(executionLocationLabel('agent_hq_cloud')).toBe('Adea cloud')
  })
})
