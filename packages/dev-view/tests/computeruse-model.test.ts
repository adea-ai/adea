// #472 computer-use pane model. Pins the honest capability presentation,
// the lane action affordances per lifecycle state, and the announcement
// rules (quiet unless state actually moved). DOM-free, so it runs in any
// condition like the rest of the Dev View a11y models.
import { describe, expect, test } from 'bun:test'

import type { ComputerUseCapabilityReport, ComputerUseLane } from '@adea-ai/types/dev-runtime'

import {
  capabilityRows,
  laneActions,
  laneChangeAnnouncement,
  laneSummary,
} from '../src/computeruse/computeruse-model'

const lane = (overrides: Partial<ComputerUseLane> = {}): ComputerUseLane => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  scope: {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  },
  runtimeSessionId: '00000000-0000-4000-8000-0000000000b1',
  state: 'idle',
  automationOwner: 'agent',
  generation: 1,
  ...overrides,
})

const report = (input: {
  input?: ComputerUseCapabilityReport['capabilities'][number]['state']
  hostPlatform?: 'macos' | 'other' | 'unknown'
}): ComputerUseCapabilityReport => ({
  hostPlatform: input.hostPlatform ?? 'macos',
  capabilities: [
    { id: 'input', state: input.input ?? 'available', probedAt: '2026-09-19T00:00:00.000Z' },
    {
      id: 'capture',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'the native capture helper is deferred',
      probedAt: '2026-09-19T00:00:00.000Z',
    },
    {
      id: 'ax_tree',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'no authorized AX bridge in this lane',
      probedAt: '2026-09-19T00:00:00.000Z',
    },
  ],
  probedAt: '2026-09-19T00:00:00.000Z',
})

describe('computer-use capability rows', () => {
  test('available input renders ready; capture and AX-tree render the exact missing piece', () => {
    const rows = capabilityRows(report({ input: 'available' }))
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('input')?.tone).toBe('ready')
    expect(byId.get('input')?.stateLabel).toBe('Available')
    expect(byId.get('capture')?.stateLabel).toBe('Cannot check')
    expect(byId.get('capture')?.hint).toContain('capture helper')
    expect(byId.get('ax_tree')?.hint).toContain('AX bridge')
  })

  test('denied input renders blocked with the Settings repair path, never Request', () => {
    const rows = capabilityRows(report({ input: 'denied' }))
    const input = rows.find((row) => row.id === 'input')
    expect(input?.tone).toBe('blocked')
    expect(input?.hint).toContain('System Settings')
  })

  test('a missing report renders cannot-check rows, never a fixture state', () => {
    const rows = capabilityRows(undefined)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.stateLabel).toBe('Cannot check')
      expect(row.tone).toBe('unknown')
    }
  })

  test('a non-macOS host report renders honest unavailability', () => {
    const rows = capabilityRows({
      hostPlatform: 'other',
      capabilities: [
        {
          id: 'input',
          state: 'unavailable',
          unavailableReason: 'unsupported_platform',
          probedAt: '2026-09-19T00:00:00.000Z',
        },
      ],
      probedAt: '2026-09-19T00:00:00.000Z',
    })
    expect(rows[0]?.tone).toBe('unknown')
  })
})

describe('computer-use lane actions', () => {
  test('an idle agent lane offers consent, takeover, and the kill switch', () => {
    const actions = laneActions(lane())
    expect(actions.map((action) => action.kind)).toEqual(['consent', 'takeover', 'close'])
    for (const action of actions) expect(action.enabled).toBe(true)
  })

  test('a granted lane offers takeover and the kill switch, never a second consent', () => {
    const actions = laneActions(lane({ state: 'granted', generation: 2 }))
    expect(actions.map((action) => action.kind)).toEqual(['takeover', 'close'])
  })

  test('a suspended lane under takeover offers release (Escape) and the kill switch', () => {
    const actions = laneActions(
      lane({ state: 'suspended', automationOwner: 'human_takeover', generation: 3 })
    )
    expect(actions.map((action) => action.kind)).toEqual(['release', 'close'])
  })

  test('closed and crashed lanes offer nothing', () => {
    expect(laneActions(lane({ state: 'closed', automationOwner: 'none' }))).toEqual([])
    expect(laneActions(lane({ state: 'crashed', automationOwner: 'none' }))).toEqual([])
    expect(laneActions(undefined)).toEqual([])
  })

  test('the summary names the authority holder honestly', () => {
    expect(laneSummary(lane())).toContain('the agent holds control')
    expect(laneSummary(lane({ state: 'suspended', automationOwner: 'human_takeover' }))).toContain(
      'you hold control'
    )
    expect(laneSummary(lane({ state: 'closed', automationOwner: 'none' }))).toContain(
      'no one holds control'
    )
  })
})

describe('computer-use announcements', () => {
  test('stay quiet when nothing changed', () => {
    const before = lane()
    expect(laneChangeAnnouncement(before, lane())).toBeUndefined()
  })

  test('announce takeover, release, and closure', () => {
    const agent = lane({ state: 'granted', generation: 2 })
    const takeover = lane({
      state: 'suspended',
      automationOwner: 'human_takeover',
      generation: 3,
    })
    expect(laneChangeAnnouncement(agent, takeover)).toContain('taken over')
    expect(laneChangeAnnouncement(takeover, lane({ state: 'idle', generation: 4 }))).toContain(
      'released to the agent'
    )
    expect(
      laneChangeAnnouncement(
        agent,
        lane({ state: 'closed', automationOwner: 'none', generation: 3 })
      )
    ).toContain('input authority revoked')
  })

  test('a first sight announces only authority-relevant lanes', () => {
    expect(laneChangeAnnouncement(undefined, lane())).toBeUndefined()
    expect(
      laneChangeAnnouncement(
        undefined,
        lane({ state: 'suspended', automationOwner: 'human_takeover' })
      )
    ).toContain('suspended')
  })
})
