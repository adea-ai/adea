import { describe, expect, test } from 'bun:test'

import { archiveAudienceLine, archiveConsequences } from '../../src/workspace-archive-consequences'

describe('archiveAudienceLine', () => {
  test('counts the members other than the archiving owner', () => {
    expect(archiveAudienceLine({ state: 'known', total: 4 })).toBe(
      '3 other members lose access until you reopen it.'
    )
    expect(archiveAudienceLine({ state: 'known', total: 2 })).toBe(
      '1 other member loses access until you reopen it.'
    )
  })

  test('says no one else is affected for an owner-only workspace', () => {
    expect(archiveAudienceLine({ state: 'known', total: 1 })).toBe(
      'Only you have access to it, so no one else is affected.'
    )
    expect(archiveAudienceLine({ state: 'known', total: 0 })).toBe(
      'Only you have access to it, so no one else is affected.'
    )
  })

  test('never guesses a number while the member list is unread or unreadable', () => {
    for (const state of ['loading', 'unavailable'] as const) {
      expect(archiveAudienceLine({ state })).toBe('Every member loses access until you reopen it.')
    }
  })
})

describe('archiveConsequences', () => {
  test('keeps archive distinct from erasure and from permanent deletion', () => {
    const lines = archiveConsequences({ state: 'known', total: 3 })
    expect(lines).toHaveLength(4)
    expect(lines.join(' ')).toContain('Nothing is erased')
    expect(lines.join(' ')).toContain('history, links, jobs and artifacts are kept')
    expect(lines.join(' ')).toContain(
      'Permanent deletion stays unavailable until cleanup is verified'
    )
    expect(lines.join(' ')).toContain('not cancelled')
  })
})
