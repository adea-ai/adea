// Permissions page model + a11y contract (issue #471): status mapping, action
// affordances, degradation copy, grouping, and screen-reader announcements are
// pure functions, so the accessibility evidence — labels, announcement text,
// keyboard-reachable affordance ordering, honest unavailable states — is
// assertable without a DOM (the Dev View a11y bar).
import { describe, expect, test } from 'bun:test'

import {
  PERMISSION_GROUPS,
  PERMISSION_ROWS,
  PROBE_SUPPORTED_PERMISSIONS,
  actionsFor,
  groupPermissions,
  presentPermission,
  rowMeta,
  snapshotCoversAllRows,
  snapshotSummary,
  stateChangeAnnouncement,
} from '../src/permissions/model'
import { createUnavailableMacPermissionsService } from '../src/permissions/service'
import {
  macPermissionIds,
  type MacPermissionId,
  type MacPermissionReport,
} from '@adea-ai/types/desktop-permissions'

function report(
  id: MacPermissionId,
  state: MacPermissionReport['state'],
  unavailableReason?: 'capability_unavailable' | 'unsupported_platform'
): MacPermissionReport {
  return {
    id,
    state,
    ...(unavailableReason ? { unavailableReason } : {}),
    probedAt: '2026-01-01T00:00:00.000Z',
  }
}

const snapshotWith = (
  reports: MacPermissionReport[],
  hostPlatform: 'macos' | 'other' | 'unknown' = 'macos'
) => ({
  hostPlatform,
  permissions: reports,
  probedAt: '2026-01-01T00:00:00.000Z',
})

const fullSnapshot = () =>
  snapshotWith([
    report('accessibility', 'denied'),
    report('screen_recording', 'unavailable', 'capability_unavailable'),
    report('notifications', 'granted'),
    report('automation_apple_events', 'not_determined'),
    report('microphone', 'unavailable', 'capability_unavailable'),
  ])

describe('permissions page model', () => {
  test('every shipped-feature permission has one row with a recorded reason and consequence', () => {
    expect(PERMISSION_ROWS.map((row) => row.id)).toEqual([...macPermissionIds])
    for (const row of PERMISSION_ROWS) {
      expect(row.purpose.length).toBeGreaterThan(10)
      expect(row.consequence.length).toBeGreaterThan(10)
      expect(rowMeta(row.id).title).toBe(row.title)
    }
  })

  test('maps each probed state to its tone, label, and plain-language hint', () => {
    expect(presentPermission(report('accessibility', 'granted'))).toEqual({
      tone: 'ready',
      label: 'Granted',
      hint: '',
    })
    const denied = presentPermission(report('accessibility', 'denied'))
    expect(denied.tone).toBe('blocked')
    expect(denied.label).toBe('Denied')
    expect(denied.hint).toContain(rowMeta('accessibility').consequence)

    const notDetermined = presentPermission(report('automation_apple_events', 'not_determined'))
    expect(notDetermined.tone).toBe('attention')
    expect(notDetermined.label).toBe('Not requested')

    const unprobed = presentPermission(
      report('screen_recording', 'unavailable', 'capability_unavailable')
    )
    expect(unprobed.tone).toBe('unknown')
    expect(unprobed.label).toBe('Cannot check')
    expect(unprobed.hint).toContain('no probe')

    expect(
      presentPermission(report('microphone', 'unavailable', 'unsupported_platform')).hint
    ).toContain('not macOS')
  })

  test('the probe-support matrix matches the shell lane exactly', () => {
    // The page may only offer Request where the shell's fixed-argv registry
    // really probes; both sides pin this set (see shell-permissions.test.ts).
    expect(PROBE_SUPPORTED_PERMISSIONS).toEqual(['accessibility', 'automation_apple_events'])
  })

  test('offers Request only for unanswered probe-supported permissions; denial repairs via Settings', () => {
    expect(actionsFor(report('accessibility', 'granted'))).toEqual([])
    expect(actionsFor(report('accessibility', 'not_determined'))).toEqual([
      { kind: 'request', label: 'Request' },
      { kind: 'open-settings', label: 'Open System Settings' },
    ])
    // Screen recording has no probe in this lane: Request would be a lie.
    expect(actionsFor(report('screen_recording', 'not_determined'))).toEqual([
      { kind: 'open-settings', label: 'Open System Settings' },
    ])
    // macOS ignores re-prompts once denied: the repair path is the pane.
    expect(actionsFor(report('accessibility', 'denied'))).toEqual([
      { kind: 'open-settings', label: 'Open System Settings' },
    ])
    expect(actionsFor(report('microphone', 'unavailable', 'capability_unavailable'))).toEqual([
      { kind: 'open-settings', label: 'Open System Settings' },
    ])
  })

  test('groups all five rows into the two UX-contract sections, in order', () => {
    const groups = groupPermissions(fullSnapshot())
    expect(groups.map((group) => group.id)).toEqual(PERMISSION_GROUPS.map((group) => group.id))
    expect(groups[0]?.heading).toBe('System control')
    expect(groups[1]?.heading).toBe('System interactions')
    expect(groups.flatMap((group) => group.rows.map((row) => row.meta.id))).toEqual([
      'accessibility',
      'screen_recording',
      'automation_apple_events',
      'notifications',
      'microphone',
    ])
  })

  test('announces exactly the state changes, in screen-reader wording', () => {
    const before = report('accessibility', 'denied')
    const granted = report('accessibility', 'granted')
    // First paint stays quiet: the initial chips are read as static content,
    // and only a change after a re-check earns a live-region utterance.
    expect(stateChangeAnnouncement(undefined, granted)).toBeUndefined()
    expect(stateChangeAnnouncement(before, granted)).toBe('Accessibility permission is now granted')
    expect(stateChangeAnnouncement(before, before)).toBeUndefined()
    expect(
      stateChangeAnnouncement(
        report('screen_recording', 'unavailable', 'capability_unavailable'),
        report('screen_recording', 'unavailable', 'capability_unavailable')
      )
    ).toBeUndefined()
    expect(stateChangeAnnouncement(before, report('accessibility', 'not_determined'))).toBe(
      'Accessibility permission is now not requested'
    )
  })

  test('summarizes the snapshot honestly, including what cannot be checked', () => {
    const allGrantedButOne = snapshotWith([
      report('accessibility', 'granted'),
      report('screen_recording', 'unavailable', 'capability_unavailable'),
      report('notifications', 'granted'),
      report('automation_apple_events', 'granted'),
      report('microphone', 'granted'),
    ])
    expect(snapshotSummary(allGrantedButOne)).toBe(
      'Nothing needs attention. Some permissions cannot be checked from this lane.'
    )
    expect(snapshotSummary(fullSnapshot())).toBe('2 permissions need your attention.')
    expect(snapshotSummary(snapshotWith([report('accessibility', 'denied')]))).toBe(
      '1 permission needs your attention.'
    )
    expect(snapshotSummary(snapshotWith([], 'other'))).toContain('not macOS')
    expect(snapshotSummary(snapshotWith([], 'unknown'))).toContain('desktop shell is not connected')
  })

  test('well-formed snapshots carry every row exactly once', () => {
    expect(snapshotCoversAllRows(fullSnapshot())).toBe(true)
    expect(snapshotCoversAllRows(snapshotWith([report('accessibility', 'granted')]))).toBe(false)
    expect(
      snapshotCoversAllRows(
        snapshotWith([
          report('accessibility', 'granted'),
          report('accessibility', 'granted'),
          report('screen_recording', 'unavailable', 'capability_unavailable'),
          report('notifications', 'granted'),
          report('automation_apple_events', 'granted'),
          report('microphone', 'unavailable', 'capability_unavailable'),
        ])
      )
    ).toBe(false)
  })
})

describe('unavailable permissions service', () => {
  test('reports typed capability_unavailable for every row and never opens Settings', async () => {
    const service = createUnavailableMacPermissionsService()
    const snapshot = await service.snapshot()
    expect(snapshot.hostPlatform).toBe('unknown')
    expect(snapshotCoversAllRows(snapshot)).toBe(true)
    expect(
      snapshot.permissions.every(
        (entry) =>
          entry.state === 'unavailable' && entry.unavailableReason === 'capability_unavailable'
      )
    ).toBe(true)
    await service.openSettings('accessibility').then(
      () => expect.unreachable(),
      (error: unknown) => expect(String(error)).toContain('cannot be opened from this lane')
    )
  })
})
