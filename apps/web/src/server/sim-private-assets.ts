import type { SimPrivateAsset } from './sim-host'

/**
 * The named private location that holds the Agent Sim engine export.
 *
 * The location name is a plain identifier: not a URL, not a path and not an alias, so nothing here
 * can name a public bucket or a public prefix. The reader hands the location and the key to the
 * storage adapter and returns bytes only. It never returns a location, a URL or a redirect, so
 * this service itself offers no second route to an object.
 *
 * What this module does not decide: whether the storage location is actually private. The reader
 * proves that a request path cannot select a key outside the named location, and that the reader
 * hands back bytes rather than an address. It does not prove anything about the storage access
 * control list, about a public alias the storage provider may expose for the same objects, or
 * about any other principal that may be able to read them. Those are deployment prerequisites of
 * the approved service, listed in the approved service composition.
 *
 * The location is supplied by the operator that owns the private export. Nothing here chooses one.
 */

/** A plain private location name. Anything else is refused and no object is read. */
export const SIM_PRIVATE_ASSET_LOCATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * A percent escape that turns a key into a path.
 *
 * A storage adapter builds a URL or a file path out of the key, and both decode
 * it. An encoded separator, dot or NUL in the key is therefore a path in
 * disguise, and it is refused here rather than left to the adapter.
 */
const PERCENT_ESCAPE_PATH = /%(?:2e|2f|5c|00)/iu

/**
 * Key prefixes the hosted service never reads, whatever the entitlement says.
 *
 * These are the third-party packs that the asset provenance record marks "Redistribution allowed?
 * No" (five seats, purchased direct from the vendor). Hosted delivery would reach beyond the seat
 * holders, so they are withheld until counsel confirms otherwise. Adea-owned content
 * (`scenes/sim/assets/`) is not listed. A key matches when it starts with a prefix or carries one
 * after a path separator, in any letter case.
 *
 * This is a request-side backstop, not a licence audit. It cannot know how an export lays out its
 * files, so the export has to be checked against the provenance record before any upload.
 */
export const SIM_LICENCE_WITHHELD_PREFIXES: readonly string[] = [
  'packages/characters/assets/',
  'packages/interior/assets/',
  'packages/architecture/assets/',
  'packages/rooms/assets/',
  'packages/landscape/assets/',
  'packages/pets/assets/',
]

const MAX_DECODE_PASSES = 8

/**
 * Every spelling of a key an adapter could read, from the key as given to the fully decoded one.
 *
 * A storage adapter that decodes keys reads the decoded spelling, so a prefix check on the raw text
 * alone is bypassed by an encoded ordinary letter (`%70ackages`). Only ASCII escapes are decoded:
 * the withheld prefixes are ASCII, the decode is lenient so a stray malformed escape elsewhere in
 * the key cannot stop it, and it repeats so a double encoding cannot hide a prefix.
 *
 * Returns null when a spelling is not a safe key (an escape that decodes into a separator, dot or
 * NUL on a later pass), or when the key is still changing after the pass limit. The caller refuses
 * the key in both cases.
 */
export function simAssetKeyForms(key: string): string[] | null {
  const forms = [key]
  let current = key
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = current.replace(/%([0-7][0-9a-f])/giu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    if (next === current) return forms
    if (simPrivateAssetKey(next) === null) return null
    forms.push(next)
    current = next
  }
  return null
}

/**
 * True when the key, in any spelling an adapter could read, falls under a withheld prefix. A key
 * with no safe spelling is withheld too.
 */
export function simAssetKeyWithheld(key: string, withheld: readonly string[]): boolean {
  const forms = simAssetKeyForms(key)
  if (forms === null) return true
  return forms.some((form) => {
    const lower = form.toLowerCase()
    return withheld.some((prefix) => {
      const needle = prefix.toLowerCase()
      return lower.startsWith(needle) || lower.includes(`/${needle}`)
    })
  })
}

export type SimPrivateAssetRequest = Readonly<{ location: string; key: string }>

/** Reads one object from the named private location, or null when it is absent. */
export type SimPrivateAssetStore = (
  request: SimPrivateAssetRequest
) => Promise<SimPrivateAsset | null> | SimPrivateAsset | null

export type SimPrivateAssetReader = (path: string) => Promise<SimPrivateAsset | null>

/**
 * The storage key for a request path, or null when the path could leave the location. An absolute
 * path, a backslash, a NUL, an empty segment and a `.` or `..` segment are all refused, and so is a
 * key that carries a percent escape a storage adapter would decode into a path. The host applies
 * the same rules before it reaches the reader; this is the second, independent check.
 */
export function simPrivateAssetKey(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return null
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  if (PERCENT_ESCAPE_PATH.test(path)) return null
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

/**
 * True when the value is a body the platform accepts.
 *
 * The declared contract is `BodyInit`: a string, a buffer source, a blob, a
 * form, a URL search params or a stream. A number, a boolean, a plain object
 * or an array is not a body: the platform coerces one of them into a string
 * and serves it, so a broken adapter would look like a served asset.
 */
function isBodyInit(body: unknown): body is BodyInit {
  if (typeof body === 'string') return true
  if (body instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(body)) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true
  return false
}

/**
 * The object the reader hands back: the bytes and their type, and nothing else.
 *
 * A storage adapter may answer with more than the contract declares — a signed
 * URL, a location, a redirect. The reader hands back only the bytes and their
 * type, so this service cannot offer a second route to a private object.
 *
 * An answer that is not an object with a body and a content type is a fault of
 * the storage adapter, not an absent object, so it is reported as one: the
 * caller serves no asset at all rather than an empty one that looks like a
 * success. The body has to be one the platform accepts as a body, so an
 * adapter that answers with a number, a boolean or a plain object is a fault
 * too rather than something the platform would quietly coerce into bytes.
 */
function privateAsset(asset: SimPrivateAsset): SimPrivateAsset {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error('the private asset store answered with something that is not an object')
  }
  if (typeof asset.contentType !== 'string' || asset.contentType.length === 0) {
    throw new Error('the private asset store answered without a content type')
  }
  const body: unknown = asset.body
  if (body === undefined || body === null) {
    throw new Error('the private asset store answered without a body')
  }
  if (!isBodyInit(body)) {
    throw new Error('the private asset store answered with a value that is not a body')
  }
  return { body, contentType: asset.contentType }
}

/**
 * The private reader for one named location. A malformed location name disables every read rather
 * than falling back to a default, so a misconfigured deployment serves no private asset at all.
 *
 * The reader is the request-side half of the gate: it keeps the key inside the named location and
 * returns bytes. The storage-side half — the access control list that makes the location private,
 * and the absence of a public alias for it — belongs to the deployment.
 *
 * The reader answers with the object, with null when the object is absent, and with a failure when
 * the storage adapter breaks its own contract. It never answers with a location, a URL or a
 * redirect, so the service offers no second route to a private object.
 */
export function createSimPrivateAssetReader(options: {
  /** The named private location that holds the engine export. */
  location: string
  /** Reads one object from that location. */
  read: SimPrivateAssetStore
  /**
   * Key prefixes that are never read. Defaults to the third-party packs that are not cleared for
   * hosted delivery. A withheld key answers as absent and the store is not asked.
   */
  withheld?: readonly string[]
}): SimPrivateAssetReader {
  const withheld = options.withheld ?? SIM_LICENCE_WITHHELD_PREFIXES
  const location = options.location
  const usable = typeof location === 'string' && SIM_PRIVATE_ASSET_LOCATION.test(location)
  return async (path) => {
    if (!usable) return null
    const key = simPrivateAssetKey(path)
    if (!key) return null
    if (simAssetKeyWithheld(key, withheld)) return null
    const asset = await options.read({ location, key })
    if (asset === null || asset === undefined) return null
    return privateAsset(asset)
  }
}
