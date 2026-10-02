import { afterEach, describe, expect, test } from 'bun:test'

import { UPDATE_PENDING_PHASES, noteUpdatePhase, updatePending } from '../../src/update-pending'

describe('the shared update-pending state', () => {
  afterEach(() => {
    noteUpdatePhase(undefined)
  })

  test('is pending exactly while an update occupies the app', () => {
    for (const phase of UPDATE_PENDING_PHASES) {
      noteUpdatePhase(phase)
      expect(updatePending()).toBe(true)
    }
    for (const phase of ['idle', 'checking', 'current', 'failed', '', null, undefined]) {
      noteUpdatePhase(phase)
      expect(updatePending()).toBe(false)
    }
  })

  test('reverts when the updater reports the app is current again', () => {
    noteUpdatePhase('available')
    expect(updatePending()).toBe(true)
    noteUpdatePhase('current')
    expect(updatePending()).toBe(false)
  })
})
