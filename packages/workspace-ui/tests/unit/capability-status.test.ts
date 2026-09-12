import { describe, expect, test } from 'bun:test'

import type { CapabilitySnapshot, CapabilityStatus } from '../../src/platform'
import {
  capabilitiesNeedingAttention,
  capabilitySnapshotAge,
  presentCapability,
  presentCapabilityState,
} from '../../src/capability-status'

function status(id: string, state: CapabilityStatus['state']): CapabilityStatus {
  return { id, title: `Title ${id}`, state }
}

describe('capability presentation', () => {
  test('maps every state of the taxonomy to an actionable presentation', () => {
    expect(presentCapabilityState({ state: 'ready' })).toEqual({ tone: 'ready', label: 'Ready' })
    expect(presentCapabilityState({ state: 'missing', hint: 'Install the pack.' })).toEqual({
      tone: 'attention',
      label: 'Not available yet',
      hint: 'Install the pack.',
    })
    expect(
      presentCapabilityState({ state: 'permissionDenied', hint: 'Allow the microphone.' })
    ).toEqual({ tone: 'blocked', label: 'Permission denied', hint: 'Allow the microphone.' })
    expect(presentCapabilityState({ state: 'timedOut', hint: 'Try again.' })).toEqual({
      tone: 'attention',
      label: 'Check timed out',
      hint: 'Try again.',
    })
  })

  test('only ready is presented as ready', () => {
    const states: CapabilityStatus['state'][] = [
      { state: 'missing', hint: 'a' },
      { state: 'permissionDenied', hint: 'b' },
      { state: 'timedOut', hint: 'c' },
    ]
    for (const state of states) {
      expect(presentCapabilityState(state).tone).not.toBe('ready')
      expect(presentCapabilityState(state).hint).toBeTruthy()
    }
  })

  test('carries the capability identity into the presentation', () => {
    expect(presentCapability(status('systemDictation', { state: 'ready' }))).toEqual({
      id: 'systemDictation',
      title: 'Title systemDictation',
      tone: 'ready',
      label: 'Ready',
    })
  })

  test('lists the capabilities that need the user, and nothing else', () => {
    const snapshot: CapabilitySnapshot = {
      capabilities: [
        status('localContent', { state: 'ready' }),
        status('systemDictation', { state: 'permissionDenied', hint: 'Allow it.' }),
        status('agentSimEngine', { state: 'missing', hint: 'Not packed.' }),
      ],
      servedFromCache: false,
      ageMs: 0,
      reProbeFloorMs: 5_000,
    }

    expect(capabilitiesNeedingAttention(snapshot).map((capability) => capability.id)).toEqual([
      'systemDictation',
      'agentSimEngine',
    ])
    // Nothing is reported before the first snapshot arrives.
    expect(capabilitiesNeedingAttention(undefined)).toEqual([])
  })

  test('reports the age of a cached snapshot', () => {
    const base: CapabilitySnapshot = {
      capabilities: [],
      servedFromCache: true,
      ageMs: 0,
      reProbeFloorMs: 5_000,
    }

    expect(capabilitySnapshotAge(base)).toBe('Checked now')
    expect(capabilitySnapshotAge({ ...base, ageMs: 4_000 })).toBe('Checked 4s ago')
    expect(capabilitySnapshotAge({ ...base, ageMs: 90_000 })).toBe('Checked 2m ago')
  })
})
