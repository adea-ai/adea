// A strict CBOR codec for the subset the Vite+ remote cache protocol uses.
//
// The pinned Vite+ client speaks CBOR on its remote cache endpoints: `POST /fetch` sends a map whose values are byte
// strings (`key`, `secondary_key`) and the answer is a map that also carries byte strings (`value`) plus the `blob_id`
// the client then downloads from `GET /blob/<blob_id>`. Only that subset is implemented here: unsigned integers,
// negative integers, byte strings, text strings, arrays, maps, booleans, null and 64-bit floats.
//
// The decoder is strict, because the values it reads decide what is replayed:
//
//   - a map is decoded into a **null-prototype** object, so a key named `__proto__` is an ordinary own property and
//     never reaches an object's prototype;
//   - a map with a **repeated key** is refused, so a message cannot mean two things at once;
//   - a map key that is not text is refused;
//   - the nesting depth and the number of decoded items are **budgeted**, so a small message cannot make the decoder
//     allocate without bound.
//
// Maps are encoded with their keys in canonical order (the encoded key bytes, shorter first), so the same value always
// produces the same bytes and a stored message can be compared byte for byte.
//
// Byte strings decode to `Buffer`, text strings to `string`: the two are distinct types, so a client key can never be
// mistaken for a name.

/** A CBOR value that is not in the subset this codec implements, or that breaks one of its rules. */
export class CborError extends Error {}

/** The decoder budgets. They bound how much a message can make the decoder allocate. */
export const CBOR_LIMITS = {
  maxDepth: 32,
  maxItems: 4096,
}

const text = (value) => Buffer.from(value, 'utf8')

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) {
    const out = Buffer.alloc(3)
    out[0] = (major << 5) | 25
    out.writeUInt16BE(value, 1)
    return out
  }
  if (value < 0x100000000) {
    const out = Buffer.alloc(5)
    out[0] = (major << 5) | 26
    out.writeUInt32BE(value, 1)
    return out
  }
  const out = Buffer.alloc(9)
  out[0] = (major << 5) | 27
  out.writeBigUInt64BE(BigInt(value), 1)
  return out
}

/** The canonical key order of a CBOR map: the encoded key bytes, shorter first, then bytewise. */
function compareKeys(a, b) {
  if (a.length !== b.length) return a.length - b.length
  return Buffer.compare(a, b)
}

/** Encodes one value. `Buffer` and `Uint8Array` become byte strings; everything else follows the CBOR data model. */
export function encode(value) {
  if (value === null) return Buffer.from([0xf6])
  if (value === true) return Buffer.from([0xf5])
  if (value === false) return Buffer.from([0xf4])
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      const out = Buffer.alloc(9)
      out[0] = 0xfb
      out.writeDoubleBE(value, 1)
      return out
    }
    if (value >= 0) return head(0, value)
    if (value >= -0x100000000) return head(1, -1 - value)
    throw new CborError(`the integer ${value} is outside the subset`)
  }
  if (typeof value === 'string') {
    const bytes = text(value)
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value)
    return Buffer.concat([head(2, bytes.length), bytes])
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(encode)])
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => [encode(key), encode(item)])
      .toSorted((a, b) => compareKeys(a[0], b[0]))
    return Buffer.concat([head(5, entries.length), ...entries.flat()])
  }
  throw new CborError(`a value of type ${typeof value} is outside the subset`)
}

class Reader {
  constructor(bytes, limits) {
    this.bytes = bytes
    this.limits = limits
    this.at = 0
    this.items = 0
  }

  take(length) {
    if (this.at + length > this.bytes.length) throw new CborError('the message ends early')
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }

  argument(additional) {
    if (additional < 24) return additional
    if (additional === 24) return this.take(1).readUInt8(0)
    if (additional === 25) return this.take(2).readUInt16BE(0)
    if (additional === 26) return this.take(4).readUInt32BE(0)
    if (additional === 27) {
      const value = this.take(8).readBigUInt64BE(0)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('the integer is too large')
      return Number(value)
    }
    throw new CborError(`the additional information ${additional} is outside the subset`)
  }

  value(depth) {
    if (depth > this.limits.maxDepth)
      throw new CborError('the message nests deeper than the budget allows')
    this.items += 1
    if (this.items > this.limits.maxItems)
      throw new CborError('the message holds more items than the budget allows')
    const initial = this.take(1).readUInt8(0)
    const major = initial >> 5
    const additional = initial & 0x1f
    if (major === 0) return this.argument(additional)
    if (major === 1) return -1 - this.argument(additional)
    if (major === 2) return Buffer.from(this.take(this.argument(additional)))
    if (major === 3) return this.take(this.argument(additional)).toString('utf8')
    if (major === 4) {
      const length = this.argument(additional)
      const out = []
      for (let index = 0; index < length; index += 1) out.push(this.value(depth + 1))
      return out
    }
    if (major === 5) {
      const length = this.argument(additional)
      // A null-prototype map: a key named `__proto__` becomes an own property and never reaches a prototype.
      const out = Object.create(null)
      const seen = new Set()
      for (let index = 0; index < length; index += 1) {
        const key = this.value(depth + 1)
        if (typeof key !== 'string') throw new CborError('a map key is not text')
        if (seen.has(key)) throw new CborError('the map holds a repeated key')
        seen.add(key)
        out[key] = this.value(depth + 1)
      }
      return out
    }
    if (major === 6) throw new CborError('a tagged value is outside the subset')
    if (additional === 20) return false
    if (additional === 21) return true
    if (additional === 22) return null
    if (additional === 23) return null
    if (additional === 26) return this.take(4).readFloatBE(0)
    if (additional === 27) return this.take(8).readDoubleBE(0)
    throw new CborError(`the simple value ${additional} is outside the subset`)
  }
}

/**
 * Decodes one value. The message must hold exactly one value; trailing bytes are refused. The nesting depth and the
 * number of items are held to `limits`.
 */
export function decode(
  bytes,
  { maxDepth = CBOR_LIMITS.maxDepth, maxItems = CBOR_LIMITS.maxItems } = {}
) {
  const reader = new Reader(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
    maxDepth,
    maxItems,
  })
  const value = reader.value(1)
  if (reader.at !== reader.bytes.length) throw new CborError('the message holds trailing bytes')
  return value
}

/**
 * Reads one own property of a decoded map. A property that the map inherited is not there: the transport validates the
 * fields it needs as own properties, so a prototype that carries `key` or `secondary_key` cannot satisfy them.
 */
export function ownField(map, field) {
  if (map === null || typeof map !== 'object') return undefined
  if (!Object.hasOwn(map, field)) return undefined
  return map[field]
}
