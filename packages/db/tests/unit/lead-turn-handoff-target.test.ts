import { describe, expect, test } from 'bun:test'

import { parseHandoffTarget } from '../../src/lead-turns'

// Admission front-door validation (#1177): the structured target is
// validated structurally here; task authority is resolved server-side
// afterwards (requireVisibleTask), never from these fields.
describe('parseHandoffTarget', () => {
  test('absent target stays absent', () => {
    expect(parseHandoffTarget(undefined)).toBeUndefined()
  })

  test('accepts a complete wellformed target', () => {
    expect(
      parseHandoffTarget({
        runtimeSessionId: 'session-1',
        taskId: '00000000-0000-4000-8000-0000000000f1',
        expectedGeneration: 3,
      })
    ).toEqual({
      runtimeSessionId: 'session-1',
      taskId: '00000000-0000-4000-8000-0000000000f1',
      expectedGeneration: 3,
    })
  })

  test('trims a padded session id', () => {
    expect(
      parseHandoffTarget({
        runtimeSessionId: '  session-1  ',
        taskId: '00000000-0000-4000-8000-0000000000f1',
        expectedGeneration: 0,
      })?.runtimeSessionId
    ).toBe('session-1')
  })

  test('rejects non-objects, arrays, and unknown keys', () => {
    for (const value of [null, 42, 'session-1', ['session-1'], { runtimeSessionId: 's' }])
      expect(() => parseHandoffTarget(value)).toThrow('Invalid lead turn')
    expect(() =>
      parseHandoffTarget({
        runtimeSessionId: 'session-1',
        taskId: '00000000-0000-4000-8000-0000000000f1',
        expectedGeneration: 3,
        extra: true,
      })
    ).toThrow('Invalid lead turn')
  })

  test('rejects empty, overlong, and non-string session ids', () => {
    const taskId = '00000000-0000-4000-8000-0000000000f1'
    for (const runtimeSessionId of ['', '   ', 42, 'x'.repeat(257)])
      expect(() => parseHandoffTarget({ runtimeSessionId, taskId, expectedGeneration: 3 })).toThrow(
        'Invalid lead turn'
      )
  })

  test('task id must be a UUID; generation a safe non-negative integer', () => {
    const runtimeSessionId = 'session-1'
    for (const taskId of ['task-9', '', 42])
      expect(() => parseHandoffTarget({ runtimeSessionId, taskId, expectedGeneration: 3 })).toThrow(
        'Invalid lead turn'
      )
    for (const expectedGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', NaN])
      expect(() =>
        parseHandoffTarget({
          runtimeSessionId,
          taskId: '00000000-0000-4000-8000-0000000000f1',
          expectedGeneration,
        })
      ).toThrow('Invalid lead turn')
  })
})
