// The macOS permission DTOs: the id guard that the shell validates bridge
// input against, and the frozen state universes the page renders.
import { describe, expect, test } from 'bun:test'

import {
  isMacPermissionId,
  macPermissionIds,
  macPermissionStates,
  macPermissionUnavailableReasons,
} from '../src/desktop-permissions'

describe('macOS permission types', () => {
  test('accepts exactly the registered permission ids', () => {
    expect(macPermissionIds).toEqual([
      'accessibility',
      'screen_recording',
      'notifications',
      'automation_apple_events',
      'microphone',
    ])
    for (const id of macPermissionIds) expect(isMacPermissionId(id)).toBe(true)
    expect(isMacPermissionId('terminal_computer_use')).toBe(false)
    expect(isMacPermissionId('')).toBe(false)
    expect(isMacPermissionId(42)).toBe(false)
    expect(isMacPermissionId(undefined)).toBe(false)
  })

  test('keeps the state and unavailability universes closed', () => {
    expect(macPermissionStates).toEqual(['granted', 'denied', 'not_determined', 'unavailable'])
    expect(macPermissionUnavailableReasons).toEqual([
      'capability_unavailable',
      'unsupported_platform',
    ])
  })
})
