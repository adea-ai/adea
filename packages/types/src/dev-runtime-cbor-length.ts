import { fail, record } from './dev-runtime-validation-internal'

const encoder = new TextEncoder()
const scratch = new DataView(new ArrayBuffer(8))

/** Canonical (shortest) CBOR head size for a length or non-negative integer. */
const head = (value: number): number =>
  value < 24 ? 1 : value < 256 ? 2 : value < 65_536 ? 3 : value < 4_294_967_296 ? 5 : 9

function floatLength(value: number): number {
  scratch.setFloat16(0, value)
  if (scratch.getFloat16(0) === value) return 3
  scratch.setFloat32(0, value)
  return scratch.getFloat32(0) === value ? 5 : 9
}

/**
 * Exact byte length `encodeCbor` produces for a JSON-shaped value, without
 * building the bytes. Browser decoders enforce the 64 KiB frame bound through
 * this so the full encoder stays out of their bundle; `encodeCbor` remains the
 * wire encoder and the two are checked against each other in tests. Callers have
 * already rejected ill-formed strings, which `encodeCbor` would refuse.
 */
export function cborByteLength(input: unknown): number {
  if (input === null || typeof input === 'boolean') return 1
  if (typeof input === 'number') {
    if (Number.isSafeInteger(input)) return head(input < 0 ? -1 - input : input)
    if (!Number.isFinite(input)) fail('cbor', 'numbers must be finite')
    return floatLength(input)
  }
  if (typeof input === 'string') {
    const length = encoder.encode(input).byteLength
    return head(length) + length
  }
  if (Array.isArray(input)) {
    let total = head(input.length)
    for (const entry of input) total += cborByteLength(entry)
    return total
  }
  if (typeof input !== 'object') fail('cbor', `cannot encode ${typeof input}`)
  const entries = Object.entries(record(input, 'cbor'))
  let total = head(entries.length)
  for (const [key, entry] of entries) total += cborByteLength(key) + cborByteLength(entry)
  return total
}
