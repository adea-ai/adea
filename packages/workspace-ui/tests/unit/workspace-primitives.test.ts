import { describe, expect, test } from 'bun:test'

import { canMoveTask } from '../../src/task-board'

describe('workspace shared UI behavior', () => {
  test('keeps Task board lifecycle moves constrained by the transition map', () => {
    expect(canMoveTask({ lifecycleState: 'created' }, 'queued')).toBe(true)
    expect(canMoveTask({ lifecycleState: 'created' }, 'completed')).toBe(true)
    expect(canMoveTask({ lifecycleState: 'completed' }, 'queued')).toBe(false)
    expect(canMoveTask({ lifecycleState: 'archived' }, 'queued')).toBe(false)
  })
})
