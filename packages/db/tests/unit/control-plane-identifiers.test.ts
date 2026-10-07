import { describe, expect, test } from 'bun:test'

import {
  CONTROL_PLANE_IDENTIFIER_PATTERN,
  isControlPlaneIdentifier,
  mintControlPlaneIdentifier,
} from '../../src/control-plane-identifiers'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function decodeTime(identifier: string): number {
  let value = 0
  for (const character of identifier.slice(4, 14)) value = value * 32 + CROCKFORD.indexOf(character)
  return value
}

describe('Control Plane identifier minting', () => {
  test('matches the Control Plane grammar for every prefix', () => {
    for (const prefix of ['wsp', 'prj', 'rnr', 'tsk', 'agt'] as const) {
      for (let index = 0; index < 200; index += 1) {
        const identifier = mintControlPlaneIdentifier(prefix)
        expect(identifier).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'))
        expect(CONTROL_PLANE_IDENTIFIER_PATTERN.test(identifier)).toBeTrue()
        expect(isControlPlaneIdentifier(prefix, identifier)).toBeTrue()
      }
    }
  })

  test('encodes the millisecond timestamp as a ULID prefix', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0, 123)
    expect(decodeTime(mintControlPlaneIdentifier('wsp', now))).toBe(now)
    expect(mintControlPlaneIdentifier('wsp', 0).slice(4, 14)).toBe('0000000000')
  })

  test('is unique across many mints in the same millisecond', () => {
    const now = Date.now()
    const values = new Set(
      Array.from({ length: 10_000 }, () => mintControlPlaneIdentifier('prj', now))
    )
    expect(values.size).toBe(10_000)
  })

  test('rejects a mismatched prefix and non-Crockford characters', () => {
    const workspace = mintControlPlaneIdentifier('wsp')
    expect(isControlPlaneIdentifier('prj', workspace)).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', `${workspace.slice(0, -1)}U`)).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', workspace.toLowerCase())).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', undefined)).toBeFalse()
  })
})
