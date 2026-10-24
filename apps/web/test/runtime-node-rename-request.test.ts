import { describe, expect, test } from 'bun:test'

import { parseRuntimeNodeRename } from '../src/server/runtime-node-request'

describe('runtime node rename request boundary', () => {
  test('accepts a bounded name and trims it', () => {
    expect(parseRuntimeNodeRename({ displayName: '  workshop box  ' })).toEqual({
      displayName: 'workshop box',
    })
    expect(parseRuntimeNodeRename({ displayName: 'a'.repeat(120) })).toEqual({
      displayName: 'a'.repeat(120),
    })
  })

  test('rejects a missing, empty or non-string name', () => {
    expect(parseRuntimeNodeRename({})).toBeNull()
    expect(parseRuntimeNodeRename({ displayName: '' })).toBeNull()
    expect(parseRuntimeNodeRename({ displayName: '   ' })).toBeNull()
    expect(parseRuntimeNodeRename({ displayName: 42 })).toBeNull()
  })

  test('rejects a name longer than the bound', () => {
    expect(parseRuntimeNodeRename({ displayName: 'a'.repeat(121) })).toBeNull()
  })

  test('rejects a name with control characters', () => {
    expect(parseRuntimeNodeRename({ displayName: 'work\u0000shop' })).toBeNull()
    expect(parseRuntimeNodeRename({ displayName: 'work\nshop' })).toBeNull()
    expect(parseRuntimeNodeRename({ displayName: 'work\u007fshop' })).toBeNull()
  })

  test('rejects a body that is not an object', () => {
    expect(parseRuntimeNodeRename(undefined)).toBeNull()
    expect(parseRuntimeNodeRename(null)).toBeNull()
    expect(parseRuntimeNodeRename('workshop')).toBeNull()
    expect(parseRuntimeNodeRename(['workshop'])).toBeNull()
  })
})
