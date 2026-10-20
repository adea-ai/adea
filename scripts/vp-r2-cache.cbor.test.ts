import { describe, expect, test } from 'bun:test'

import { CBOR_LIMITS, CborError, decode, encode, ownField } from './vp-r2-cache.cbor.mjs'

describe('the CBOR codec', () => {
  test('reads back every value of the subset', () => {
    const values = [
      0,
      1,
      23,
      24,
      255,
      256,
      65_536,
      4_294_967_296,
      Number.MAX_SAFE_INTEGER,
      -1,
      -24,
      -25,
      -256,
      -257,
      -65_536,
      true,
      false,
      null,
      '',
      'a name',
      'a name with a \0 in it',
      Buffer.alloc(0),
      Buffer.from([1, 2, 3]),
      [],
      [1, 'two', Buffer.from([3])],
    ]
    for (const value of values) {
      expect(decode(encode(value))).toEqual(value)
    }
    expect(decode(encode(1.5))).toBe(1.5)
  })

  test('writes a map in the canonical order of its keys', () => {
    const first = encode({ b: 1, a: 2 })
    const second = encode({ a: 2, b: 1 })
    expect(first.equals(second)).toBe(true)
    expect(Object.keys(decode(first) as Record<string, number>)).toEqual(['a', 'b'])
  })

  test('decodes a map into a null-prototype object', () => {
    const decoded = decode(encode({ kind: 'exact' })) as Record<string, unknown>
    expect(Object.getPrototypeOf(decoded)).toBe(null)
    expect(Object.hasOwn(decoded, 'kind')).toBe(true)
  })

  test('keeps a key named `__proto__` as an own property', () => {
    const message = Object.create(null)
    message.__proto__ = 'a value'
    const decoded = decode(encode(message)) as Record<string, unknown>
    expect(Object.getPrototypeOf(decoded)).toBe(null)
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
    expect(ownField(decoded, '__proto__')).toBe('a value')
    expect(({} as Record<string, unknown>).kind).toBeUndefined()
  })

  test('refuses a map that holds the same key twice', () => {
    const repeated = Buffer.concat([
      Buffer.from([0xa2]),
      encode('key'),
      encode(Buffer.from('one')),
      encode('key'),
      encode(Buffer.from('two')),
    ])
    expect(() => decode(repeated)).toThrow(CborError)
  })

  test('refuses a map whose key is not text', () => {
    const binaryKey = Buffer.concat([Buffer.from([0xa1]), encode(Buffer.from('key')), encode(1)])
    expect(() => decode(binaryKey)).toThrow(CborError)
  })

  test('refuses a message that holds trailing bytes', () => {
    expect(() => decode(Buffer.concat([encode(1), Buffer.from([0x01])]))).toThrow(CborError)
  })

  test('refuses a message that ends early', () => {
    expect(() => decode(Buffer.from([0x19, 0x01]))).toThrow(CborError)
  })

  test('refuses a tagged value and an unknown simple value', () => {
    expect(() => decode(Buffer.from([0xc0, 0x01]))).toThrow(CborError)
    expect(() => decode(Buffer.from([0xf8, 0x20]))).toThrow(CborError)
  })

  test('refuses a value it cannot encode', () => {
    expect(() => encode(undefined)).toThrow(CborError)
    expect(() => encode(-0x100000001)).toThrow(CborError)
  })

  test('holds the decoder to its depth budget', () => {
    // A nested array: each level is the head of an array of one item, followed by the level below it.
    let deep = encode(1)
    for (let index = 0; index < CBOR_LIMITS.maxDepth + 2; index += 1)
      deep = Buffer.concat([Buffer.from([0x81]), deep])
    expect(() => decode(deep)).toThrow(CborError)
    expect(() => decode(deep, { maxDepth: 2 })).toThrow(CborError)
    expect(decode(deep, { maxDepth: CBOR_LIMITS.maxDepth + 4 })).toBeInstanceOf(Array)
  })

  test('holds the decoder to its item budget', () => {
    const many = encode(Array.from({ length: 64 }, (_, index) => index))
    expect(decode(many)).toHaveLength(64)
    expect(() => decode(many, { maxItems: 4 })).toThrow(CborError)
  })

  test('reads a field only when the map owns it', () => {
    const inherited = Object.create({ key: 'inherited' })
    expect(ownField(inherited, 'key')).toBeUndefined()
    expect(ownField(null, 'key')).toBeUndefined()
    expect(ownField('not a map', 'key')).toBeUndefined()
    expect(ownField(Object.assign(Object.create(null), { key: 'own' }), 'key')).toBe('own')
  })
})
