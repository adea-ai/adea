import { describe, expect, test } from 'bun:test'

import { parseReadStateInput } from '../src/server/read-state-input'

describe('read-state request boundary', () => {
  test('accepts exact bounded channel actions', () => {
    expect(parseReadStateInput({ action: 'read', lastReadSequence: 42 })).toEqual({
      action: 'read',
      lastReadSequence: 42,
    })
    expect(parseReadStateInput({ action: 'unread' })).toEqual({ action: 'unread' })
  })

  test('rejects ambiguous markers, extra data, and malformed thread scope', () => {
    expect(parseReadStateInput({ action: 'read', lastReadSequence: -1 })).toBeNull()
    expect(parseReadStateInput({ action: 'read', plaintext: 'private canary' })).toBeNull()
    expect(
      parseReadStateInput(
        { action: 'read', channelId: '10000000-0000-4000-8000-000000000001' },
        { requireChannelId: true }
      )
    ).toEqual({
      action: 'read',
      channelId: '10000000-0000-4000-8000-000000000001',
    })
    expect(
      parseReadStateInput(
        { action: 'read', channelId: '00000000-0000-0000-0000-000000000000' },
        { requireChannelId: true }
      )
    ).toBeNull()
  })
})
