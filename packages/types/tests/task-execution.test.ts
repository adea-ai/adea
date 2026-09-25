import { describe, expect, test } from 'bun:test'

import { taskExecutionFromAttempts, type ExecutionAttemptSummary } from '../src/task-execution'

function attempt(overrides: Partial<ExecutionAttemptSummary> = {}): ExecutionAttemptSummary {
  return {
    attempt: 1,
    change: 'initial',
    locationKind: 'local_device',
    recordedAt: '2026-09-25T10:00:00.000Z',
    runtimeNodeId: 'node-local',
    ...overrides,
  }
}

describe('task execution provenance (#671)', () => {
  test('a task with no recorded execution has no execution field', () => {
    expect(taskExecutionFromAttempts([])).toBeUndefined()
  })

  test('a task that never left this device claims its own node, not none', () => {
    const execution = taskExecutionFromAttempts([attempt()])
    expect(execution?.current).toMatchObject({
      attempt: 1,
      change: 'initial',
      locationKind: 'local_device',
      runtimeNodeId: 'node-local',
    })
    expect(execution?.attempts).toHaveLength(1)
  })

  test('an authorized reroute keeps both the original and the new location', () => {
    const execution = taskExecutionFromAttempts([
      attempt({
        attempt: 2,
        change: 'authorized_reroute',
        locationKind: 'remote_host',
        recordedAt: '2026-09-25T11:00:00.000Z',
        runtimeNodeId: 'node-remote',
      }),
      attempt({ attempt: 1, recordedAt: '2026-09-25T10:00:00.000Z' }),
    ])
    // `current` is the highest attempt, whatever order the rows arrived in…
    expect(execution?.current.attempt).toBe(2)
    expect(execution?.current.locationKind).toBe('remote_host')
    // …and the history keeps the attempt it moved away from.
    expect(execution?.attempts.map((entry) => entry.locationKind)).toEqual([
      'local_device',
      'remote_host',
    ])
    expect(execution?.attempts.map((entry) => entry.change)).toEqual([
      'initial',
      'authorized_reroute',
    ])
  })

  test('the reserved cloud location carries no node, even if one was stored', () => {
    const execution = taskExecutionFromAttempts([
      attempt({ change: 'sticky_retry', locationKind: 'agent_hq_cloud', runtimeNodeId: 'node-1' }),
    ])
    expect(execution?.current.runtimeNodeId).toBeUndefined()
    expect(execution?.current.locationKind).toBe('agent_hq_cloud')
  })

  test('a sticky retry on the same location is recorded as its own attempt', () => {
    const execution = taskExecutionFromAttempts([
      attempt({ attempt: 1 }),
      attempt({ attempt: 2, change: 'sticky_retry', recordedAt: '2026-09-25T10:05:00.000Z' }),
    ])
    expect(execution?.current.attempt).toBe(2)
    expect(execution?.attempts).toHaveLength(2)
    expect(execution?.attempts[1]?.change).toBe('sticky_retry')
  })
})
