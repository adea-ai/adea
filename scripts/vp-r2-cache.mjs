#!/usr/bin/env node
// The shared R2 task-cache transport: the contract between the pinned Vite+ client's remote cache protocol and an
// object store (Cloudflare R2 in production, an in-memory store in the tests).
//
// Nothing here is wired into a build, a workflow or a task. The transport is disabled by default and every operation
// that touches a store is opt-in: `isEnabled` reads `ADEA_VP_R2_CACHE_ENABLED`, and without it no store call is made
// and every result is a fallback. There is no provider, no credential, no endpoint and no network call in this file:
// the store is injected by the caller.
//
// ## What travels
//
// The unit is a cache *entry*, not the Vite+ task-cache SQLite database. The pinned client (1.3.0) has no export or
// import command (`vp cache` has one subcommand, `clean`), and its `node_modules/.vite/task-cache` holds a `cache.db`
// plus one output archive per entry. That database is the client's own private format and is not treated as portable
// here. What does travel is the client-facing triple the client itself already exchanges with a remote cache: the
// entry key, the task fingerprint key and the entry value, plus the output archive as an opaque blob.
//
// The wire protocol is the one the pinned client speaks, observed against the client and recorded in
// docs/evidence/vp-r2-cache-transport-2026-10-19.md:
//   POST <base>/fetch    application/cbor   { key, secondary_key }  -> { kind, key, secondary_key, value, blob_id }
//   POST <base>/store    multipart/form-data  parts `metadata` (application/cbor) and `blob` (application/octet-stream)
//   GET  <base>/blob/<blob_id>                                          -> the archive bytes
//
// ## The trust domain
//
// Every entry belongs to a **trust domain**: a namespace (which repository or tenant the entries belong to) and a
// compatibility context (the pinned client version and the pinned toolchain identity). The domain is bound once, by
// the constructor of a transport, and it is mixed into every object key and recorded in every envelope:
//
//   entries/<domain>/<sha256(key)>/<sha256(secondary_key)>/entry.json
//   blobs/<domain>/<sha256(archive)>
//   staging/<domain>/<generated uuid>
//
// A store shared by two domains is therefore safe: the second domain cannot name the first domain's objects, and an
// envelope written for another domain is refused when it is read back. The compatibility context is checked as well:
// an entry written by another client version or another toolchain is refused, so the envelope version is not the only
// thing that decides whether an entry may be replayed.
//
// The authorization decision is bound to the domain in the same way. `authorize` is called with the domain and must
// answer `{ allow: true, scope: <domain id> }`; a bare boolean is refused, because a boolean cannot be bound to a
// domain and two repositories that share one store would then read each other's entries.
//
// ## The two layers
//
// The exported store operations (`publishEntry`, `lookupEntry`, `readBlob`) are the **lower level**: they take an
// explicit trust domain and a store and they do no authorization and no enable check. They are for a caller that has
// already decided that this domain may use this store.
//
// `handleRemoteCache` is the **enabled and authenticated handler**: it is the only entry point that serves a request
// from outside, it refuses to answer at all while the transport is off, and it refuses every request that carries no
// authorization decision bound to the domain.
//
// ## Bounds, deadlines and the adapter boundary
//
// Every read and write is bounded by `LIMITS`, and every external call is bounded by a deadline: the authorization
// call, the store calls and the cleanup alike. A call that does not answer in time ends the operation with a
// fallback, and an operation whose deadline passed cannot publish: the staged object is removed and a final object
// that was promoted too late is removed again.
//
// The handler is given a request body that the adapter has already buffered. The adapter is the party that reads the
// socket, so the adapter is the party that bounds the buffering: it must not hand over more than
// `LIMITS.maxRequestBytes`, and the transport refuses a larger body before it parses anything.
//
// Failures never throw at the caller: a refusal or a store error becomes a result with `fallback: true` and a fixed
// category, so the caller keeps using its local cache.
import { createHash, randomUUID } from 'node:crypto'

import {
  CBOR_LIMITS,
  decode as cborDecode,
  encode as cborEncode,
  ownField,
} from './vp-r2-cache.cbor.mjs'

/** The envelope format this transport reads and writes. A reader refuses a version it does not know. */
export const ENVELOPE_VERSION = 2

/** The discriminator of an envelope. A stored object without it is not an envelope. */
export const ENVELOPE_KIND = 'adea.vp-r2-cache/entry'

/** The environment variable that turns the transport on. It is off unless it is exactly `1`. */
export const ENABLE_ENV = 'ADEA_VP_R2_CACHE_ENABLED'

/**
 * The parts of the pinned client's remote cache protocol this transport implements. The paths and the field names are
 * the client's own; they are recorded here so the contract can be checked against the client in one place.
 */
export const CLIENT_PROTOCOL = {
  fetchPath: '/fetch',
  storePath: '/store',
  blobPath: '/blob/',
  contentType: 'application/cbor',
  blobContentType: 'application/octet-stream',
  requestFields: ['key', 'secondary_key'],
  responseFields: ['kind', 'key', 'secondary_key', 'value', 'blob_id'],
  kind: 'exact',
}

/** The bounds every read and write is held to. A store call never transfers more than these. */
export const LIMITS = {
  maxKeyBytes: 64 * 1024,
  maxSecondaryKeyBytes: 64 * 1024,
  maxValueBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 8 * 1024 * 1024,
  maxBlobBytes: 256 * 1024 * 1024,
  maxEnvelopeBytes: 8 * 1024 * 1024,
  maxRequestBytes: 300 * 1024 * 1024,
  maxCborDepth: CBOR_LIMITS.maxDepth,
  maxCborItems: CBOR_LIMITS.maxItems,
  cleanupTimeoutMs: 5_000,
}

/** The deadline of one operation, unless the caller names another. */
export const DEFAULT_DEADLINE_MS = 30_000

/** The fixed categories a failure is reported as. They name no path, no key and no message from the store. */
export const CATEGORY = {
  disabled: 'the shared R2 task cache is disabled',
  unauthorized: 'the request was not authorized',
  trustDomain: 'the entry belongs to another trust domain',
  compatibility: 'the entry was written by another client or toolchain',
  storeRead: 'the object store refused the read',
  storeWrite: 'the object store refused the write',
  notFound: 'no entry was stored for that key',
  invalidEnvelope: 'the stored envelope was refused',
  integrity: 'the stored envelope failed its integrity checks',
  tooLarge: 'the entry exceeded a size bound',
  invalidRequest: 'the request was not understood',
  timeout: 'the operation did not finish in time',
}

const HEX = /^[0-9a-f]{64}$/
const OBJECT_KEY = /^[a-z]+\/[0-9a-f]{64}(\/[0-9a-f]{64}){0,2}(\/[a-z.]+)?$/
const NAMESPACE = /^[A-Za-z0-9._@/-]{1,128}$/
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/
const TOOLCHAIN = /^[0-9A-Za-z._:-]{1,128}$/

/** A refusal of the transport. Its message names a category, never a path or a stored key. */
export class TransportRefused extends Error {
  constructor(category, message) {
    super(message ?? category)
    this.category = category
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (category, message) => ({
  ok: false,
  fallback: true,
  category,
  reason: message ?? category,
})

/** Whether the transport is on. It is off unless `ADEA_VP_R2_CACHE_ENABLED` is exactly `1`. */
export function isEnabled(env = process.env) {
  return env[ENABLE_ENV] === '1'
}

/**
 * The trust domain of a transport: a namespace and a compatibility context. The domain is identified by the digest of
 * its three parts, and that digest names every object the transport may write or read.
 */
export function trustDomain({ namespace, client, toolchain }) {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the namespace is not a plain name')
  if (typeof client !== 'string' || !VERSION.test(client))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the client version is not a plain version')
  if (typeof toolchain !== 'string' || !TOOLCHAIN.test(toolchain))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the toolchain id is not a plain id')
  const id = sha256(Buffer.from(JSON.stringify({ namespace, client, toolchain }), 'utf8'))
  return Object.freeze({ namespace, client, toolchain, id })
}

/**
 * The object key of an entry. The key is derived from the trust domain and from the digests of the client's key and
 * task fingerprint key, so a request can never steer the write outside the domain's own prefix.
 */
export function entryObjectKey(scope, key, secondaryKey) {
  const first = sha256(key)
  const second = sha256(secondaryKey)
  if (!HEX.test(first) || !HEX.test(second)) throw new TransportRefused(CATEGORY.invalidRequest)
  return `entries/${scope.id}/${first}/${second}/entry.json`
}

/** The object key of an output archive. The identifier is the digest of the archive, so the key is content addressed. */
export function blobObjectKey(scope, blobId) {
  if (!HEX.test(blobId))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the blob id is not a digest')
  return `blobs/${scope.id}/${blobId}`
}

/** The object key a write is staged under before it is promoted. The identifier is generated here, never taken from a request. */
export function stagingObjectKey(scope, id = randomUUID()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the staging id is not generated here')
  return `staging/${scope.id}/${id}`
}

/** Whether an object key has the shape this transport writes. A key from anywhere else is refused. */
export function isObjectKey(key) {
  return typeof key === 'string' && OBJECT_KEY.test(key)
}

const ENVELOPE_FIELDS = [
  'v',
  'kind',
  'scope',
  'namespace',
  'client',
  'toolchain',
  'key',
  'secondary_key',
  'value',
  'key_sha256',
  'secondary_key_sha256',
  'value_sha256',
  'blob_id',
  'blob_sha256',
  'blob_size',
  'created_at',
]

/**
 * The bytes of an envelope. The fields are written in a fixed order with no whitespace, so the same envelope always
 * produces the same bytes and two stores can be compared without a canonicalisation step.
 */
export function canonicalEnvelopeBytes(envelope) {
  const ordered = {}
  for (const field of ENVELOPE_FIELDS) ordered[field] = envelope[field]
  return Buffer.from(JSON.stringify(ordered), 'utf8')
}

/**
 * Builds the envelope for one cache entry. The client's bytes are carried unchanged: the transport never rewrites a
 * cached value, so a command that names a checkout path (the `ORCH_CHECKOUT` fingerprint) keeps its own identity and
 * simply misses on another checkout instead of replaying another checkout's path.
 *
 * The envelope records the trust domain and the compatibility context it was written for. There is no free-form
 * producer field: the domain says who wrote it and with which client and toolchain, and both are checked on read.
 */
export function createEnvelope({ scope, key, secondaryKey, value, blob, createdAt }) {
  const blobId = sha256(blob)
  return {
    v: ENVELOPE_VERSION,
    kind: ENVELOPE_KIND,
    scope: scope.id,
    namespace: scope.namespace,
    client: scope.client,
    toolchain: scope.toolchain,
    key: Buffer.from(key).toString('base64'),
    secondary_key: Buffer.from(secondaryKey).toString('base64'),
    value: Buffer.from(value).toString('base64'),
    key_sha256: sha256(key),
    secondary_key_sha256: sha256(secondaryKey),
    value_sha256: sha256(value),
    blob_id: blobId,
    blob_sha256: blobId,
    blob_size: blob.length,
    created_at: createdAt,
  }
}

/**
 * Reads an envelope back. The version, the kind, the field set, the sizes and the digests are all checked, and so are
 * the trust domain and the compatibility context: an envelope that was written by another domain, by another client
 * version or by another toolchain is refused rather than replayed.
 */
export function parseEnvelope(bytes, { scope, limits = LIMITS } = {}) {
  if (!scope) throw new TransportRefused(CATEGORY.invalidRequest, 'a trust domain is required')
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length === 0)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope is empty')
  if (bytes.length > limits.maxEnvelopeBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the envelope is larger than the bound')
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope is not an object')
  if (parsed.v !== ENVELOPE_VERSION)
    throw new TransportRefused(
      CATEGORY.invalidEnvelope,
      `the envelope version ${parsed.v} is not read`
    )
  if (parsed.kind !== ENVELOPE_KIND)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope is not a cache entry')
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.hasOwn(parsed, field))
      throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope is missing a field')
  }
  if (typeof parsed.created_at !== 'string' || parsed.created_at.length > 64)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope has no usable creation time')
  if (
    !HEX.test(parsed.key_sha256) ||
    !HEX.test(parsed.secondary_key_sha256) ||
    !HEX.test(parsed.value_sha256)
  )
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope has no usable digests')
  if (!HEX.test(parsed.blob_id) || parsed.blob_id !== parsed.blob_sha256)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope has no usable blob id')
  // The trust domain first: an entry of another namespace is not an entry of this one, whatever it says inside.
  if (parsed.namespace !== scope.namespace)
    throw new TransportRefused(CATEGORY.trustDomain, 'the envelope belongs to another trust domain')
  // Then the compatibility context: another client version or another toolchain may not replay this entry.
  if (
    parsed.scope !== scope.id ||
    parsed.client !== scope.client ||
    parsed.toolchain !== scope.toolchain
  )
    throw new TransportRefused(
      CATEGORY.compatibility,
      'the envelope was written by another client or toolchain'
    )
  const key = Buffer.from(parsed.key, 'base64')
  const secondaryKey = Buffer.from(parsed.secondary_key, 'base64')
  const value = Buffer.from(parsed.value, 'base64')
  if (key.length === 0 || secondaryKey.length === 0 || value.length === 0)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope carries no bytes')
  if (key.length > limits.maxKeyBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the key is larger than the bound')
  if (secondaryKey.length > limits.maxSecondaryKeyBytes)
    throw new TransportRefused(
      CATEGORY.tooLarge,
      'the task fingerprint key is larger than the bound'
    )
  if (value.length > limits.maxValueBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the value is larger than the bound')
  if (
    !Number.isInteger(parsed.blob_size) ||
    parsed.blob_size < 0 ||
    parsed.blob_size > limits.maxBlobBytes
  )
    throw new TransportRefused(CATEGORY.tooLarge, 'the blob size is outside the bound')
  if (sha256(key) !== parsed.key_sha256 || sha256(secondaryKey) !== parsed.secondary_key_sha256)
    throw new TransportRefused(CATEGORY.integrity, 'the envelope does not match its own digests')
  if (sha256(value) !== parsed.value_sha256)
    throw new TransportRefused(CATEGORY.integrity, 'the value does not match its digest')
  return { ...parsed, keyBytes: key, secondaryKeyBytes: secondaryKey, valueBytes: value }
}

/** The digest of an envelope, over its canonical bytes. It names the envelope wherever it is stored. */
export function envelopeDigest(envelope) {
  return sha256(canonicalEnvelopeBytes(envelope))
}

/**
 * One operation, with its deadline and its ownership. Every external call of the operation is bounded by the deadline,
 * and the operation knows whether it may still publish: a write whose deadline passed while it was promoted is removed
 * again rather than left behind.
 */
function createOperation({ deadlineMs, clock = Date.now }) {
  const controller = new AbortController()
  const started = clock()
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  timer.unref?.()
  const ownership = {
    id: randomUUID(),
    live: () => !controller.signal.aborted && clock() - started < deadlineMs,
  }
  return {
    signal: controller.signal,
    ownership,
    expired: () => !ownership.live(),
    assertLive() {
      if (!ownership.live())
        throw new TransportRefused(CATEGORY.timeout, 'the operation deadline passed')
    },
    release() {
      clearTimeout(timer)
    },
  }
}

/**
 * Awaits `promise` until the operation's deadline. A promise that does not answer in time ends the operation; the
 * promise itself is left to settle on its own, and the caller is told that the deadline passed.
 */
function bounded(promise, operation) {
  if (operation.expired())
    throw new TransportRefused(CATEGORY.timeout, 'the operation deadline passed')
  const guard = new Promise((_, reject) => {
    const abort = () =>
      reject(new TransportRefused(CATEGORY.timeout, 'the operation deadline passed'))
    if (operation.signal.aborted) abort()
    else operation.signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([Promise.resolve(promise), guard])
}

/** Awaits `promise` for at most `timeoutMs`. Used for the cleanup, which must never hold the caller. */
function boundedBy(promise, timeoutMs) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TransportRefused(CATEGORY.timeout)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer))
}

/**
 * Whether two envelopes name the same entry: everything but the recorded creation time. The creation time says when an
 * entry was published, not what it is, so two publications of one entry are the same entry.
 */
function sameEntry(left, right) {
  const fields = [
    'scope',
    'namespace',
    'client',
    'toolchain',
    'key',
    'secondary_key',
    'value',
    'key_sha256',
    'secondary_key_sha256',
    'value_sha256',
    'blob_id',
    'blob_sha256',
    'blob_size',
  ]
  return fields.every((field) => left?.[field] === right?.[field])
}

/**
 * Removes an object that a write may still create: when the write settles after the cleanup has run, the object is
 * removed then. The key belongs to this operation alone, so the removal is ownership-safe, and it is bounded.
 */
function cleanupWhenSettled(write, store, key, limits) {
  Promise.resolve(write)
    .catch(() => {})
    .then(() => cleanupDelete(store, key, limits.cleanupTimeoutMs))
    .catch(() => {})
}

/** A store call whose failure is not interesting: the call is run and its failure is dropped. */
function ignoreFailure(call) {
  try {
    return Promise.resolve(call()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

/**
 * A cleanup that is independent of the operation: it has its own budget and it carries **no signal**. A staging object
 * belongs to one operation alone, so it is removed even when the operation's signal is already aborted - a store that
 * honours cancellation must still be able to delete what this operation staged.
 */
function cleanupDelete(store, key, timeoutMs) {
  return boundedBy(
    ignoreFailure(() => store.delete(key)),
    timeoutMs
  )
}

/**
 * The deadline a request runs under: the tightest of the deadlines that apply. The transport's own deadline wins over a
 * caller's, and the authorization's own deadline wins over both: a caller may tighten the deadline, never loosen it.
 */
export function effectiveDeadline(...bounds) {
  const finite = bounds.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return finite.length ? Math.min(...finite) : DEFAULT_DEADLINE_MS
}

/**
 * The limits a request is held to. The transport's own limits win: a caller may tighten them, never loosen them.
 */
export function effectiveLimits(base = LIMITS, override) {
  const merged = { ...base }
  if (!override) return merged
  for (const [name, value] of Object.entries(override)) {
    if (typeof value === 'number' && typeof merged[name] === 'number')
      merged[name] = Math.min(merged[name], value)
    else merged[name] = value
  }
  return merged
}

async function storeGet(store, key, maxBytes, operation) {
  const bytes = await bounded(store.get(key, { maxBytes, signal: operation.signal }), operation)
  if (bytes === null || bytes === undefined) return null
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length > maxBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the store returned more than the bound')
  return buffer
}

/**
 * Writes `bytes` at `key` through a staging object: the write lands under `staging/<domain>/<id>`, the staged object
 * is read back and compared, and only then is it promoted to `key`.
 *
 * The final object is written by one atomic step: either a single `put` of the complete bytes or a server-side `copy`
 * of the complete staged object. Nothing is ever written to the final key in pieces, so a reader sees either nothing
 * or the whole object.
 *
 * The publication is **fenced**, and the fence is not a deletion. A store that can create-if-absent (`putIfAbsent` or
 * `copyIfAbsent`) is asked to, and its answer says whether this operation created the final object. A `created: true`
 * is **historical**: it says what happened when the write was committed, not what may be deleted later. The write may
 * have committed before the deadline and only acknowledge afterwards, and a successor may have reused the object in
 * the meantime - the shared archive is content addressed and the shared envelope is named by the entry. So a final key
 * is **never** removed on the strength of a late acknowledgement: removing it could remove an object a successor
 * references. A late acknowledgement is reported as what it is: the deadline passed, and the object may or may not be
 * there.
 *
 * When the object was already there, it is not overwritten: it is read back and compared with the entry that is being
 * published. The same entry under the same key is an **idempotent duplicate** and is a success; another entry under
 * that key is an integrity failure.
 *
 * The staging object belongs to this operation alone, so it is removed with an independent bounded cleanup that carries
 * no signal: a store that honours cancellation must still be able to delete what this operation staged. A staged write
 * that settles *after* that cleanup - a store that ignores the cancellation - is removed when it settles.
 */
async function stagedWrite(
  store,
  scope,
  key,
  bytes,
  { limits = LIMITS, operation, equivalent, verify, maxBytes }
) {
  // The read bound is the bound of **this** object: the envelope is bounded by the envelope bound and the archive by
  // the archive bound. Reading an archive with the envelope bound would refuse a large archive that is perfectly
  // valid, and a duplicate publication of it would fail.
  const bound = maxBytes ?? limits.maxEnvelopeBytes
  const staging = stagingObjectKey(scope)
  const staged = store.put(staging, bytes, { signal: operation.signal })
  try {
    try {
      await bounded(staged, operation)
    } catch (error) {
      // The staged write may land after the deadline. When it does, the object is removed then: the staging object
      // belongs to this operation alone, so the removal is ownership-safe.
      cleanupWhenSettled(staged, store, staging, limits)
      if (error instanceof TransportRefused) throw error
      throw new TransportRefused(CATEGORY.storeWrite)
    }
    operation.assertLive()
    const head = await bounded(store.head(staging, { signal: operation.signal }), operation)
    if (head === null || head === undefined)
      throw new TransportRefused(CATEGORY.storeWrite, 'the staged object is not there')
    if (typeof head.size === 'number' && head.size !== bytes.length)
      throw new TransportRefused(CATEGORY.integrity, 'the staged object has another size')
    if (head.sha256 && head.sha256 !== sha256(bytes))
      throw new TransportRefused(CATEGORY.integrity, 'the staged object has another digest')
    const readBack = await storeGet(store, staging, bound, operation)
    if (readBack === null)
      throw new TransportRefused(CATEGORY.storeWrite, 'the staged object cannot be read back')
    if (sha256(readBack) !== sha256(bytes))
      throw new TransportRefused(
        CATEGORY.integrity,
        'the staged object does not read back as it was written'
      )
    operation.assertLive()
    // The final object is published by one atomic step, fenced when the store can fence it.
    const promotion =
      typeof store.copyIfAbsent === 'function'
        ? store.copyIfAbsent(staging, key, { signal: operation.signal })
        : typeof store.putIfAbsent === 'function'
          ? store.putIfAbsent(key, readBack, { signal: operation.signal })
          : typeof store.copy === 'function'
            ? store.copy(staging, key, { signal: operation.signal })
            : store.put(key, readBack, { signal: operation.signal })
    // The promotion may have committed before the deadline and only acknowledge afterwards. The final key is
    // **shared** - a successor may already reference it - so it is not removed here, and it is not removed later
    // either: a late acknowledgement is history, not ownership.
    const outcome = await bounded(promotion, operation)
    const created = outcome?.created ?? null
    if (created === false) {
      // The object was already there: it is not overwritten, and it is **validated** before the publication is a
      // success. What is there is read back - with the bound of this object - and checked: the content-addressed
      // archive against its own digest and size, and the envelope by parsing it and comparing the entry it names. An
      // object that is corrupt, or that is another entry, is an integrity failure rather than a duplicate.
      const stored = await storeGet(store, key, bound, operation)
      if (stored === null)
        throw new TransportRefused(CATEGORY.storeWrite, 'the published object is not there')
      if (typeof verify === 'function' && !verify(stored))
        throw new TransportRefused(
          CATEGORY.integrity,
          'the published object is not the object that was expected'
        )
      if (typeof equivalent === 'function' && !stored.equals(bytes) && !equivalent(stored))
        throw new TransportRefused(CATEGORY.integrity, 'another entry is published under that key')
      return { key, sha256: sha256(bytes), size: bytes.length, staged: staging, created }
    }

    if (operation.expired()) {
      // The promotion finished after the deadline. The object is **not** removed: the final key is shared, a successor
      // may reference it, and a `created: true` says what happened when the write was committed - not what may be
      // deleted later. The deadline is reported; the object stays.
      throw new TransportRefused(
        CATEGORY.timeout,
        'the deadline passed while the object was promoted'
      )
    }
    const head2 = await bounded(store.head(key, { signal: operation.signal }), operation)
    if (head2 === null || head2 === undefined)
      throw new TransportRefused(CATEGORY.storeWrite, 'the promoted object is not there')
    if (typeof head2.size === 'number' && head2.size !== bytes.length)
      throw new TransportRefused(CATEGORY.integrity, 'the promoted object has another size')
    if (head2.sha256 && head2.sha256 !== sha256(bytes))
      throw new TransportRefused(CATEGORY.integrity, 'the promoted object has another digest')
    return { key, sha256: sha256(bytes), size: bytes.length, staged: staging, created }
  } finally {
    // The staging object belongs to this operation alone, so it is removed with an independent bounded cleanup that
    // carries no signal: a store that honours cancellation must still be able to delete what this operation staged.
    await cleanupDelete(store, staging, limits.cleanupTimeoutMs)
  }
}

/**
 * Publishes one cache entry: the output archive and the envelope that names it. The entry is stored under the trust
 * domain and the digests of the client's key and task fingerprint key, so a second writer of the same entry writes
 * the same objects.
 *
 * This is a lower-level operation: it takes the trust domain and the store and it does no authorization and no enable
 * check. The caller has already decided that this domain may use this store; `handleRemoteCache` is the entry point
 * that serves a request from outside.
 *
 * The result is a fallback, never an exception, when the store refuses the write or the deadline passes: the caller
 * keeps its local cache.
 */
export async function publishEntry(
  store,
  entry,
  { scope, limits = LIMITS, deadlineMs = DEFAULT_DEADLINE_MS, createdAt, operation: given } = {}
) {
  if (!scope) throw new TransportRefused(CATEGORY.invalidRequest, 'a trust domain is required')
  // A caller that already runs an operation passes it in, so the whole request shares one deadline.
  const owns = given === undefined
  const operation = given ?? createOperation({ deadlineMs })
  try {
    const key = Buffer.from(entry.key)
    const secondaryKey = Buffer.from(entry.secondaryKey)
    const value = Buffer.from(entry.value)
    const blob = Buffer.from(entry.blob)
    if (key.length === 0 || secondaryKey.length === 0 || value.length === 0)
      return fail(CATEGORY.invalidRequest, 'the entry carries no bytes')
    if (key.length > limits.maxKeyBytes)
      return fail(CATEGORY.tooLarge, 'the key is larger than the bound')
    if (secondaryKey.length > limits.maxSecondaryKeyBytes)
      return fail(CATEGORY.tooLarge, 'the task fingerprint key is larger than the bound')
    if (value.length > limits.maxValueBytes)
      return fail(CATEGORY.tooLarge, 'the value is larger than the bound')
    if (blob.length > limits.maxBlobBytes)
      return fail(CATEGORY.tooLarge, 'the blob is larger than the bound')
    const envelope = createEnvelope({
      scope,
      key,
      secondaryKey,
      value,
      blob,
      createdAt: createdAt ?? new Date().toISOString(),
    })
    const bytes = canonicalEnvelopeBytes(envelope)
    if (bytes.length > limits.maxEnvelopeBytes)
      return fail(CATEGORY.tooLarge, 'the envelope is larger than the bound')
    const blobKey = blobObjectKey(scope, envelope.blob_id)
    const entryKey = entryObjectKey(scope, key, secondaryKey)
    const blobWrite = await stagedWrite(store, scope, blobKey, blob, {
      limits,
      operation,
      // The archive is bounded by the archive bound, not by the envelope bound.
      maxBytes: limits.maxBlobBytes,
      // The archive is content addressed: the one that is already there must be exactly this archive.
      verify: (stored) => stored.length === blob.length && sha256(stored) === envelope.blob_id,
    })
    const entryWrite = await stagedWrite(store, scope, entryKey, bytes, {
      limits,
      operation,
      maxBytes: limits.maxEnvelopeBytes,
      // The same entry published again is an idempotent duplicate: the object that is already there names the same
      // entry, whatever creation time it recorded. It is **parsed and validated** first - an envelope of another
      // version, of another kind or of another domain is not an entry of this kind, whatever its bytes say.
      equivalent: (stored) => {
        try {
          const parsed = parseEnvelope(stored, { scope, limits })
          return sameEntry(parsed, envelope)
        } catch {
          return false
        }
      },
    })
    return {
      ok: true,
      envelope,
      entryKey,
      blobKey,
      sha256: entryWrite.sha256,
      blobSha256: blobWrite.sha256,
      // Whether this publication created the final envelope, and whether it was already there.
      created: entryWrite.created,
      duplicate: entryWrite.created === false,
    }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeWrite)
  } finally {
    if (owns) operation.release()
  }
}

/**
 * Reads the entry that was stored for a client key and task fingerprint key. The envelope is checked against its own
 * digests, against the key that was asked for and against the trust domain and the compatibility context, so an entry
 * of another domain or another client is refused instead of replayed.
 */
export async function lookupEntry(
  store,
  { key, secondaryKey },
  { scope, limits = LIMITS, deadlineMs = DEFAULT_DEADLINE_MS, operation: given } = {}
) {
  if (!scope) throw new TransportRefused(CATEGORY.invalidRequest, 'a trust domain is required')
  const owns = given === undefined
  const operation = given ?? createOperation({ deadlineMs })
  try {
    const entryKey = entryObjectKey(scope, Buffer.from(key), Buffer.from(secondaryKey))
    const bytes = await storeGet(store, entryKey, limits.maxEnvelopeBytes, operation)
    if (bytes === null) return fail(CATEGORY.notFound)
    const envelope = parseEnvelope(bytes, { scope, limits })
    if (
      envelope.key_sha256 !== sha256(key) ||
      envelope.secondary_key_sha256 !== sha256(secondaryKey)
    )
      return fail(CATEGORY.integrity, 'the envelope was stored under another key')
    return { ok: true, envelope, entryKey }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeRead)
  } finally {
    if (owns) operation.release()
  }
}

/** Reads an output archive by its digest. The digest is the only thing a request can name. */
export async function readBlob(
  store,
  blobId,
  { scope, limits = LIMITS, deadlineMs = DEFAULT_DEADLINE_MS, operation: given } = {}
) {
  if (!scope) throw new TransportRefused(CATEGORY.invalidRequest, 'a trust domain is required')
  const owns = given === undefined
  const operation = given ?? createOperation({ deadlineMs })
  try {
    const key = blobObjectKey(scope, blobId)
    const bytes = await storeGet(store, key, limits.maxBlobBytes, operation)
    if (bytes === null) return fail(CATEGORY.notFound)
    if (sha256(bytes) !== blobId)
      return fail(CATEGORY.integrity, 'the archive does not match its digest')
    return { ok: true, blobId, bytes }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeRead)
  } finally {
    if (owns) operation.release()
  }
}

/**
 * A transport: one trust domain bound to one store. The constructor is the contract: a transport serves one domain and
 * reads and writes only that domain's objects. The authorization decision is not part of it: the lower-level
 * operations of a transport are for a caller that has already decided that this domain may use this store, and the
 * enabled and authenticated handler is `handleRemoteCache`, which takes the decision separately.
 */
export function createTransport({
  scope,
  store,
  limits = LIMITS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  enabled = false,
} = {}) {
  if (!scope) throw new TransportRefused(CATEGORY.invalidRequest, 'a trust domain is required')
  if (!store) throw new TransportRefused(CATEGORY.invalidRequest, 'a store is required')
  return {
    scope,
    store,
    limits,
    deadlineMs,
    enabled,
    publish: (entry, options = {}) =>
      publishEntry(store, entry, { scope, limits, deadlineMs, ...options }),
    lookup: (request, options = {}) =>
      lookupEntry(store, request, { scope, limits, deadlineMs, ...options }),
    readBlob: (blobId, options = {}) =>
      readBlob(store, blobId, { scope, limits, deadlineMs, ...options }),
  }
}

/** The boundary of a `multipart/form-data` content type. */
export function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (!match) return null
  return (match[1] ?? match[2]).trim()
}

/**
 * Reads a multipart body into its parts, by the complete delimiter grammar.
 *
 * A delimiter is a **complete line**: the CRLF that precedes `--<boundary>`, then `--<boundary>`, then either CRLF (a
 * part follows) or `--` and the end of that line (the body is closed). A candidate that is not a complete line is not a
 * delimiter and is skipped: a `--<boundary>` that appears inside a part without a CRLF in front of it is part of the
 * part's bytes and is kept as it is, a `--<boundary>X` is a prefix of another name and not a delimiter, and a
 * `--<boundary>--suffix` is not a closing line because the closing line has to end there.
 *
 * The closing delimiter must be there and must be a complete line: a body that stops in the middle is refused rather
 * than read as a short part. A repeated part name is refused, and so is a part without a name or without a header
 * separator.
 */
export function parseMultipart(body, boundary, { limits = LIMITS } = {}) {
  if (!boundary)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the content type names no boundary')
  if (!/^[0-9A-Za-z'()+_,-./:=?]{1,70}$/.test(boundary))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the boundary is not a plain boundary')
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (bytes.length > limits.maxRequestBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the request is larger than the bound')
  const delimiter = Buffer.from(`--${boundary}`)
  const crlfDelimiter = Buffer.from(`\r\n--${boundary}`)
  const parts = []
  const seen = new Set()
  if (!bytes.subarray(0, delimiter.length).equals(delimiter))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the body does not start with the boundary')
  // The next complete delimiter line at or after `from`, or null. A candidate that is not a complete line is skipped.
  const nextDelimiter = (from) => {
    for (let at = from; at < bytes.length;) {
      const index = bytes.indexOf(crlfDelimiter, at)
      if (index === -1) return null
      const after = index + crlfDelimiter.length
      const tail = bytes.subarray(after, after + 2).toString('latin1')
      if (tail === '\r\n') return { index, closes: false }
      if (tail === '--') {
        const end = bytes.subarray(after + 2, after + 4).toString('latin1')
        // The closing line has to end there: `--` followed by a line break or by the end of the body.
        if (end === '\r\n' || after + 2 === bytes.length) return { index, closes: true }
      }
      // Not a complete delimiter line: keep looking.
      at = index + 1
    }
    return null
  }
  // `at` always points at the `--` of a delimiter line.
  let at = 0
  for (;;) {
    const after = bytes
      .subarray(at + delimiter.length, at + delimiter.length + 2)
      .toString('latin1')
    if (after === '--') {
      const end = bytes
        .subarray(at + delimiter.length + 2, at + delimiter.length + 4)
        .toString('latin1')
      if (!(end === '\r\n' || at + delimiter.length + 2 === bytes.length))
        throw new TransportRefused(
          CATEGORY.invalidRequest,
          'the closing boundary is not a complete line'
        )
      return parts
    }
    if (after !== '\r\n')
      throw new TransportRefused(
        CATEGORY.invalidRequest,
        'the boundary is not followed by a line break'
      )
    at += delimiter.length + 2
    const headerEnd = bytes.indexOf('\r\n\r\n', at)
    if (headerEnd === -1)
      throw new TransportRefused(CATEGORY.invalidRequest, 'a part has no header separator')
    const headers = bytes.subarray(at, headerEnd).toString('utf8')
    const bodyStart = headerEnd + 4
    const next = nextDelimiter(bodyStart)
    if (next === null)
      throw new TransportRefused(CATEGORY.invalidRequest, 'the body has no closing boundary')
    const name = /name="([^"]*)"/.exec(headers)?.[1]
    if (!name) throw new TransportRefused(CATEGORY.invalidRequest, 'a part has no name')
    if (seen.has(name))
      throw new TransportRefused(CATEGORY.invalidRequest, 'the body holds a repeated part')
    seen.add(name)
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
    parts.push({ name, contentType, body: bytes.subarray(bodyStart, next.index) })
    at = next.index + 2
  }
}

/** The client's `POST /fetch` request: a CBOR map with the entry key and the task fingerprint key. */
export function parseFetchRequest(body, { limits = LIMITS } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (bytes.length > limits.maxRequestBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the request is larger than the bound')
  let message
  try {
    message = cborDecode(bytes, { maxDepth: limits.maxCborDepth, maxItems: limits.maxCborItems })
  } catch {
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request is not CBOR')
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request is not a map')
  const key = ownField(message, 'key')
  const secondaryKey = ownField(message, 'secondary_key')
  if (!Buffer.isBuffer(key))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request has no key')
  if (!Buffer.isBuffer(secondaryKey))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request has no secondary_key')
  if (key.length === 0 || secondaryKey.length === 0)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request has an empty key')
  if (key.length > limits.maxKeyBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the key is larger than the bound')
  if (secondaryKey.length > limits.maxSecondaryKeyBytes)
    throw new TransportRefused(
      CATEGORY.tooLarge,
      'the task fingerprint key is larger than the bound'
    )
  return { key, secondaryKey }
}

/**
 * The client's `POST /store` request: a multipart body with the entry metadata in CBOR and the output archive beside
 * it. The metadata is measured before it is decoded, and the archive is taken as it is.
 */
export function parseStoreRequest(body, contentType, { limits = LIMITS } = {}) {
  const parts = parseMultipart(body, multipartBoundary(contentType), { limits })
  const metadata = parts.find((part) => part.name === 'metadata')
  const blob = parts.find((part) => part.name === 'blob')
  if (!metadata || !blob)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request has no entry')
  if (metadata.contentType && !metadata.contentType.startsWith(CLIENT_PROTOCOL.contentType))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not CBOR')
  if (metadata.body.length > limits.maxMetadataBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the metadata is larger than the bound')
  if (blob.body.length > limits.maxBlobBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the archive is larger than the bound')
  let message
  try {
    message = cborDecode(metadata.body, {
      maxDepth: limits.maxCborDepth,
      maxItems: limits.maxCborItems,
    })
  } catch {
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not CBOR')
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not a map')
  const key = ownField(message, 'key')
  const secondaryKey = ownField(message, 'secondary_key')
  const value = ownField(message, 'value')
  if (!Buffer.isBuffer(key))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata has no key')
  if (!Buffer.isBuffer(secondaryKey))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata has no secondary_key')
  if (!Buffer.isBuffer(value))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata has no value')
  if (key.length === 0 || secondaryKey.length === 0 || value.length === 0)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata carries no bytes')
  if (key.length > limits.maxKeyBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the key is larger than the bound')
  if (secondaryKey.length > limits.maxSecondaryKeyBytes)
    throw new TransportRefused(
      CATEGORY.tooLarge,
      'the task fingerprint key is larger than the bound'
    )
  if (value.length > limits.maxValueBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the value is larger than the bound')
  return { key, secondaryKey, value, blob: blob.body }
}

const cborResponse = (message) => ({
  status: 200,
  headers: { 'content-type': CLIENT_PROTOCOL.contentType },
  body: cborEncode(message),
})

/** A refusal to the client: a status, no body and the category it was refused for. */
const refuse = (status, category) => ({ status, headers: {}, body: Buffer.alloc(0), category })

/**
 * The answer to the client's `POST /fetch`. The fields are the ones the client reads: the kind of the answer, the
 * entry key, the task fingerprint key, the entry value and the id of the archive the client then downloads.
 */
export function fetchResponse({ key, secondaryKey, value, blobId }) {
  return cborResponse({
    kind: CLIENT_PROTOCOL.kind,
    key: Buffer.from(key),
    secondary_key: Buffer.from(secondaryKey),
    value: Buffer.from(value),
    blob_id: blobId,
  })
}

/**
 * Serves the client's remote cache protocol against a transport.
 *
 * The request is `{ method, path, headers, body }` and the answer is `{ status, headers, body }`. Nothing is fetched
 * from the network and no credential is read: the store is the only outside party, and it is the caller's.
 *
 * The body must already be bounded by the adapter: the transport refuses a body that is larger than
 * `LIMITS.maxRequestBytes` before it parses anything.
 *
 * `options.authorize` decides whether a request is served, and its answer must be bound to the transport's trust
 * domain: `{ allow: true, scope: <the domain id> }`. A bare boolean is refused, because a boolean cannot be bound to a
 * domain. There is no default that allows an anonymous read: this transport is not a public read service.
 *
 * `options.enabled` is the on switch; without it every route answers with a refusal and the client keeps its local
 * cache.
 *
 * The transport's own policy is the policy: its limits and its deadline are the ones this handler enforces. A caller
 * may tighten them, never loosen them. The whole request runs under **one** deadline: the authorization call, the
 * lookup, the publication and the archive read share a single operation, so a request cannot spend a full deadline on
 * each of them.
 */
export async function handleRemoteCache(request, transport, options = {}) {
  const { enabled = false, authorize } = options
  const method = (request.method ?? 'GET').toUpperCase()
  const path = request.path ?? '/'
  const headers = request.headers ?? {}
  if (!enabled) return refuse(503, CATEGORY.disabled)
  if (!transport || !transport.scope) return refuse(503, CATEGORY.invalidRequest)
  const scope = transport.scope
  const limits = effectiveLimits(transport.limits ?? LIMITS, options.limits)
  if (typeof authorize !== 'function') return refuse(403, CATEGORY.unauthorized)
  // The tightest deadline applies: the transport's own, the caller's and the authorization's.
  const deadlineMs = effectiveDeadline(
    transport.deadlineMs,
    options.deadlineMs,
    options.authorizeDeadlineMs ?? authorize.deadlineMs
  )
  const operation = createOperation({ deadlineMs })
  try {
    let decision
    try {
      decision = await bounded(
        authorize({ method, path, headers, scope: scope.id, namespace: scope.namespace }),
        operation
      )
    } catch (error) {
      if (error instanceof TransportRefused) return refuse(503, error.category)
      return refuse(403, CATEGORY.unauthorized)
    }
    if (
      decision === null ||
      typeof decision !== 'object' ||
      decision.allow !== true ||
      decision.scope !== scope.id
    )
      return refuse(403, CATEGORY.unauthorized)
    const body = request.body
    if (body !== undefined && body !== null) {
      const size = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)
      if (size > limits.maxRequestBytes) return refuse(413, CATEGORY.tooLarge)
    }
    if (method === 'POST' && path === CLIENT_PROTOCOL.fetchPath) {
      const { key, secondaryKey } = parseFetchRequest(body, { limits })
      const found = await lookupEntry(
        transport.store,
        { key, secondaryKey },
        { scope, limits, deadlineMs, operation }
      )
      if (!found.ok) {
        if (found.category === CATEGORY.notFound) return refuse(404, found.category)
        return refuse(503, found.category)
      }
      const { envelope } = found
      return fetchResponse({
        key: envelope.keyBytes,
        secondaryKey: envelope.secondaryKeyBytes,
        value: envelope.valueBytes,
        blobId: envelope.blob_id,
      })
    }
    if (method === 'POST' && path === CLIENT_PROTOCOL.storePath) {
      const entry = parseStoreRequest(body, headers['content-type'], { limits })
      const published = await publishEntry(transport.store, entry, {
        scope,
        limits,
        deadlineMs,
        operation,
      })
      if (!published.ok) {
        if (published.category === CATEGORY.tooLarge) return refuse(413, published.category)
        if (published.category === CATEGORY.invalidRequest) return refuse(400, published.category)
        return refuse(503, published.category)
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"stored":true}'),
      }
    }
    if (method === 'GET' && path.startsWith(CLIENT_PROTOCOL.blobPath)) {
      const blobId = path.slice(CLIENT_PROTOCOL.blobPath.length)
      const blob = await readBlob(transport.store, blobId, { scope, limits, deadlineMs, operation })
      if (!blob.ok) {
        if (blob.category === CATEGORY.notFound) return refuse(404, blob.category)
        return refuse(503, blob.category)
      }
      return {
        status: 200,
        headers: { 'content-type': CLIENT_PROTOCOL.blobContentType },
        body: blob.bytes,
      }
    }
    return refuse(404, CATEGORY.invalidRequest)
  } catch (error) {
    if (error instanceof TransportRefused) {
      const status = error.category === CATEGORY.tooLarge ? 413 : 400
      return refuse(status, error.category)
    }
    return refuse(503, CATEGORY.storeRead)
  } finally {
    operation.release()
  }
}
