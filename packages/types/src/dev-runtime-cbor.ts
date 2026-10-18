import { fail, objectPrototype } from './dev-runtime-validation-internal'
import { assertWellFormedUnicode } from './dev-runtime-unicode'

// ─── Canonical CBOR (RFC 8949 deterministic encoding subset) ────────────────
//
// Bulk-stream control frames are canonical CBOR with a 64 KiB maximum. This
// subset covers the frame vocabulary — unsigned/negative integers, floats,
// booleans, null, byte and text strings, arrays, and text-keyed maps — and
// refuses anything else (tags, indefinite lengths, non-shortest heads,
// duplicate or unsorted map keys) instead of guessing.

const cborEncoder = new TextEncoder()
const cborDecoder = new TextDecoder('utf-8', { fatal: true })

function cborHead(major: number, length: number | bigint): Uint8Array {
  const value = BigInt(length)
  const head: number[] = []
  let info: number
  let bytes: number[] = []
  if (value < 24n) info = Number(value)
  else if (value <= 0xffn) {
    info = 24
    bytes = [Number(value)]
  } else if (value <= 0xffffn) {
    info = 25
    for (let shift = 8; shift >= 0; shift -= 8) bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else if (value <= 0xffff_ffffn) {
    info = 26
    for (let shift = 24; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else {
    info = 27
    for (let shift = 56; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  }
  head.push((major << 5) | info, ...bytes)
  return Uint8Array.from(head)
}

function shortestFloat(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  for (const [head, write, read] of [
    [0xf9, 'setFloat16', 'getFloat16'],
    [0xfa, 'setFloat32', 'getFloat32'],
  ] as const) {
    view[write](0, value, false)
    if (view[read](0, false) === value) {
      const size = head === 0xf9 ? 2 : 4
      const out = new Uint8Array(1 + size)
      out[0] = head
      out.set(new Uint8Array(buffer, 0, size), 1)
      return out
    }
  }
  view.setFloat64(0, value, false)
  const out = new Uint8Array(9)
  out[0] = 0xfb
  out.set(new Uint8Array(buffer, 0, 8), 1)
  return out
}

export function encodeCbor(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = []
  const encode = (input: unknown): void => {
    if (input === null) {
      chunks.push(Uint8Array.from([0xf6]))
      return
    }
    if (typeof input === 'boolean') {
      chunks.push(Uint8Array.from([input ? 0xf5 : 0xf4]))
      return
    }
    if (typeof input === 'bigint') {
      if (input >= 0n) chunks.push(cborHead(0, input))
      else chunks.push(cborHead(1, -1n - input))
      return
    }
    if (typeof input === 'number') {
      if (Number.isSafeInteger(input)) {
        if (input >= 0) chunks.push(cborHead(0, input))
        else chunks.push(cborHead(1, -1 - input))
        return
      }
      if (Number.isFinite(input)) {
        chunks.push(shortestFloat(input))
        return
      }
      fail('cbor', 'numbers must be finite')
    }
    if (typeof input === 'string') {
      assertWellFormedUnicode(input, 'cbor string')
      const bytes = cborEncoder.encode(input)
      chunks.push(cborHead(3, bytes.byteLength), bytes)
      return
    }
    if (input instanceof Uint8Array) {
      chunks.push(cborHead(2, input.byteLength), input)
      return
    }
    if (Array.isArray(input)) {
      chunks.push(cborHead(4, input.length))
      for (const entry of input) encode(entry)
      return
    }
    if (typeof input === 'object') {
      if (Object.getPrototypeOf(input) !== objectPrototype && Object.getPrototypeOf(input) !== null)
        fail('cbor', 'expected a plain object')
      const entries = Object.entries(input as Record<string, unknown>)
      const encoded = entries
        .map(([key, entry]) => ({ key: encodeCbor(key), value: encodeCbor(entry) }))
        .toSorted((left, right) => {
          const shorter = Math.min(left.key.byteLength, right.key.byteLength)
          for (let index = 0; index < shorter; index += 1) {
            const delta = left.key[index]! - right.key[index]!
            if (delta !== 0) return delta
          }
          return left.key.byteLength - right.key.byteLength
        })
      chunks.push(cborHead(5, encoded.length))
      for (const entry of encoded) {
        chunks.push(entry.key, entry.value)
      }
      return
    }
    fail('cbor', `cannot encode ${typeof input}`)
  }
  encode(value)
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function decodeCbor(bytes: Uint8Array): { value: unknown; byteLength: number } {
  let offset = 0
  const read = (count: number): bigint => {
    if (offset + count > bytes.byteLength) fail('cbor', 'truncated input')
    let value = 0n
    for (let index = 0; index < count; index += 1) value = (value << 8n) | BigInt(bytes[offset++]!)
    return value
  }
  const head = (): { major: number; value: bigint } => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset++]!
    const major = first >> 5
    const info = first & 0x1f
    if (info < 24) return { major, value: BigInt(info) }
    if (info > 27) fail('cbor', `unsupported additional information ${info}`)
    const value = read(1 << (info - 24))
    if (value < [24n, 256n, 65_536n, 4_294_967_296n][info - 24]!)
      fail('cbor', 'non-shortest integer head')
    return { major, value }
  }
  const decode = (): unknown => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset]!
    // Major 7's "value" is a simple value or raw float bits, not a
    // length, so the integer shortest-form rules do not apply to it.
    if (first >> 5 === 7) {
      offset += 1
      const info = first & 0x1f
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 25 || info === 26 || info === 27) {
        const width = 2 ** (info - 24)
        if (offset + width > bytes.byteLength) fail('cbor', 'truncated input')
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, width)
        offset += width
        const parsed =
          info === 25
            ? view.getFloat16(0, false)
            : info === 26
              ? view.getFloat32(0, false)
              : view.getFloat64(0, false)
        if (!Number.isFinite(parsed)) fail('cbor', 'floats must be finite')
        return parsed
      }
      fail('cbor', `unsupported simple value ${info}`)
    }
    const { major, value } = head()
    if (major === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return value
      return Number(value)
    }
    if (major === 1) {
      const result = -1n - value
      return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(result)
        : result
    }
    if (major === 2) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated byte string')
      const out = bytes.slice(offset, offset + length)
      offset += length
      return out
    }
    if (major === 3) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated text string')
      const slice = bytes.subarray(offset, offset + length)
      offset += length
      try {
        return cborDecoder.decode(slice)
      } catch {
        return fail('cbor', 'invalid UTF-8 text string')
      }
    }
    if (major === 4) {
      const length = Number(value)
      const out: unknown[] = []
      for (let index = 0; index < length; index += 1) out.push(decode())
      return out
    }
    if (major === 5) {
      const length = Number(value)
      const out: Record<string, unknown> = {}
      let previousKey: Uint8Array | undefined
      for (let index = 0; index < length; index += 1) {
        const keyStart = offset
        const key = decode()
        const keyBytes = bytes.slice(keyStart, offset)
        if (typeof key !== 'string') fail('cbor', 'map keys must be text strings')
        if (previousKey && compareBytes(previousKey, keyBytes) >= 0)
          fail('cbor', 'map keys are not canonically ordered')
        previousKey = keyBytes
        if (Object.hasOwn(out, key)) fail('cbor', 'duplicate map key')
        // Define rather than assign so `__proto__` stays an ordinary own key.
        Object.defineProperty(out, key, {
          value: decode(),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return out
    }
    if (major === 6) fail('cbor', 'tags are not part of the frame vocabulary')
    return fail('cbor', `unsupported major type ${major}`)
  }
  const value = decode()
  return { value, byteLength: offset }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shorter = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < shorter; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.byteLength - right.byteLength
}
