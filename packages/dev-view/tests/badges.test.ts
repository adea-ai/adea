import { describe, expect, test } from 'bun:test'

import { sessionBadges } from '../src/sidebar/badges'

describe('Dev session badges', () => {
  test('renders nothing without state so row height never changes', () => {
    expect(sessionBadges(undefined)).toEqual([])
    expect(sessionBadges({})).toEqual([])
  })

  test('projects each independent state as its own badge', () => {
    const badges = sessionBadges({
      harness: 'working',
      dirty: true,
      checks: 'failed',
      ports: [3000, 9229],
    })
    expect(badges.map((badge) => badge.kind)).toEqual(['harness', 'dirty', 'checks', 'ports'])
    expect(badges.map((badge) => badge.tone)).toEqual(['success', 'failure', 'failure', 'neutral'])
    expect(badges[3]?.label).toBe('Owned ports 3000, 9229')
    expect(badges[3]?.short).toBe(':3000 :9229')
  })

  test('maps awaiting and running states to progress tone', () => {
    const badges = sessionBadges({ harness: 'awaiting_approval', checks: 'running' })
    expect(badges.map((badge) => badge.tone)).toEqual(['progress', 'progress'])
    expect(badges[0]?.label).toBe('Harness awaiting approval')
    expect(badges[1]?.short).toBe('checks…')
  })

  test('passed checks succeed and dirty is independent of harness state', () => {
    const badges = sessionBadges({ dirty: true, checks: 'passed' })
    expect(badges.map((badge) => badge.tone)).toEqual(['failure', 'success'])
  })
})
