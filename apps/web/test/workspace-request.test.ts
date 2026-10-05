import { describe, expect, test } from 'bun:test'

import { parseWorkspaceUpdate } from '../src/server/workspace-request'

describe('workspace update requests', () => {
  test('decodes each field and trims the name', () => {
    expect(
      parseWorkspaceUpdate({
        accent: 'green',
        expectedVersion: 3,
        logo: { kind: 'emoji', value: '🚀' },
        name: '  Nifty League  ',
        scene: 'work',
      })
    ).toEqual({
      expectedVersion: 3,
      update: {
        accent: 'green',
        logo: { kind: 'emoji', value: '🚀' },
        name: 'Nifty League',
        scene: 'work',
      },
    })
    expect(parseWorkspaceUpdate({ accent: null, expectedVersion: 1 })).toEqual({
      expectedVersion: 1,
      update: { accent: null },
    })
    expect(parseWorkspaceUpdate({ expectedVersion: 1, logo: { kind: 'monogram' } })).toEqual({
      expectedVersion: 1,
      update: { logo: { kind: 'monogram' } },
    })
  })

  test('accepts a multi-codepoint emoji as one grapheme', () => {
    expect(
      parseWorkspaceUpdate({ expectedVersion: 1, logo: { kind: 'emoji', value: '👩🏽‍💻' } })
    ).not.toBeNull()
    expect(
      parseWorkspaceUpdate({ expectedVersion: 1, logo: { kind: 'emoji', value: '🇺🇸' } })
    ).not.toBeNull()
  })

  test.each([
    ['a missing version', { name: 'Adea' }],
    ['a zero version', { expectedVersion: 0, name: 'Adea' }],
    ['a fractional version', { expectedVersion: 1.5, name: 'Adea' }],
    ['an empty update', { expectedVersion: 1 }],
    ['an unknown key', { expectedVersion: 1, name: 'Adea', ownerUserId: 'x' }],
    ['a blank name', { expectedVersion: 1, name: '   ' }],
    ['a long name', { expectedVersion: 1, name: 'x'.repeat(81) }],
    ['an unknown accent', { accent: 'red', expectedVersion: 1 }],
    ['an unknown scene', { expectedVersion: 1, scene: 'office' }],
    ['text as an emoji', { expectedVersion: 1, logo: { kind: 'emoji', value: 'AB' } }],
    ['two emoji', { expectedVersion: 1, logo: { kind: 'emoji', value: '🚀🚀' } }],
    ['an image logo', { expectedVersion: 1, logo: { kind: 'image', value: 'x' } }],
    ['a monogram with a value', { expectedVersion: 1, logo: { kind: 'monogram', value: 'A' } }],
    ['an array body', []],
  ])('rejects %s', (_label, body) => {
    expect(parseWorkspaceUpdate(body)).toBeNull()
  })
})
