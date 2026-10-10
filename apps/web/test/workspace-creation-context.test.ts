import { describe, expect, test } from 'bun:test'

import { describeWorkspaceCreationContext } from '../src/lib/workspace-creation-context'

describe('workspace creation context copy', () => {
  test('names a known owner and placement', () => {
    expect(
      describeWorkspaceCreationContext({ ownerLabel: 'Acme', placementLabel: 'Home scene' })
    ).toBe('Owned by Acme · Only you · Located in Home scene')
  })

  test('falls back to the owner sentence without inventing identity', () => {
    expect(describeWorkspaceCreationContext({})).toBe(
      "You'll be the owner · Only you · Location unknown"
    )
  })

  test('labels unknown placement honestly and never claims shared access', () => {
    for (const input of [{}, { ownerLabel: 'Acme' }, { placementLabel: '  ' }] as const) {
      const line = describeWorkspaceCreationContext(input)
      expect(line).toContain('Only you')
      if (input.placementLabel === undefined || input.placementLabel.trim() === '')
        expect(line).toContain('Location unknown')
    }
  })
})
