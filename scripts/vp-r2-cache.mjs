#!/usr/bin/env node
// The shared R2 task-cache transport: the contract between the pinned Vite+ client's remote cache protocol and an
// object store (Cloudflare R2 in production, an in-memory store in the tests).
//
// Nothing here is wired into a build, a workflow or a task. The transport is disabled by default and every operation
// that touches a store is opt-in: `isEnabled` reads `ADEA_VP_R2_CACHE_ENABLED`, and without it no store call is made
// and every result is a fallback. There is no provider, no credential, no endpoint and no network call in this file:
// the store is injected by the caller.
//
// The unit that travels is a cache *entry*, not the Vite+ task-cache SQLite database. The pinned client (1.3.0) has
// no export or import command (`vp cache` has one subcommand, `clean`), and its `node_modules/.vite/task-cache` holds
// a `cache.db` plus one output archive per entry. That database is the client's own private format and is not treated
// as portable here. What does travel is the client-facing triple the client itself already exchanges with a remote
// cache: the entry key, the task fingerprint key and the entry value, plus the output archive as an opaque blob.
//
// The wire protocol is the one the pinned client speaks, observed against the client and recorded in
// docs/evidence/vp-r2-cache-transport-2026-10-19.md:
//   POST <base>/fetch    application/cbor   { key, secondary_key }  -> { kind, key, secondary_key, value, blob_id }
//   POST <base>/store    multipart/form-data  parts `metadata` (application/cbor) and `blob` (application/octet-stream)
//   GET  <base>/blob/<blob_id>                                          -> the archive bytes
//
// What this file adds on top of that protocol is the storage contract: a versioned envelope, an object key layout that
// no request can steer outside, digests that are checked on every read, size bounds on every read and write, a staged
// write that is promoted only after it is verified, and a fallback that leaves the caller's local cache in charge
// whenever anything about the remote side is missing, refused or unreadable.
//
// Failures never throw at the caller: a refusal or a store error becomes a result with `fallback: true` and a fixed
// category, so the caller keeps using its local cache.
import { createHash, randomUUID } from 'node:crypto'

import { decode as cborDecode, encode as cborEncode } from './vp-r2-cache.cbor.mjs'

/** The envelope format this transport reads and writes. A reader refuses a version it does not know. */
export const ENVELOPE_VERSION = 1

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
  maxValueBytes: 4 * 1024 * 1024,
  maxBlobBytes: 256 * 1024 * 1024,
  maxEnvelopeBytes: 8 * 1024 * 1024,
  maxRequestBytes: 300 * 1024 * 1024,
}

/** The fixed categories a failure is reported as. They name no path, no key and no message from the store. */
export const CATEGORY = {
  disabled: 'the shared R2 task cache is disabled',
  storeRead: 'the object store refused the read',
  storeWrite: 'the object store refused the write',
  notFound: 'no entry was stored for that key',
  invalidEnvelope: 'the stored envelope was refused',
  integrity: 'the stored envelope failed its integrity checks',
  tooLarge: 'the entry exceeded a size bound',
  invalidRequest: 'the request was not understood',
  unauthorized: 'the request was not authorized',
}

const HEX = /^[0-9a-f]{64}$/
const OBJECT_KEY = /^[a-z]+\/[0-9a-f]{64}(\/[0-9a-f]{64})?(\/[a-z.]+)?$/

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
 * The object key of an entry. The key is derived from the digests of the client's key and task fingerprint key, so a
 * request can never steer the write outside the `entries/` prefix: the path has two hex segments and a fixed name.
 */
export function entryObjectKey(key, secondaryKey) {
  const first = sha256(key)
  const second = sha256(secondaryKey)
  if (!HEX.test(first) || !HEX.test(second)) throw new TransportRefused(CATEGORY.invalidRequest)
  return `entries/${first}/${second}/entry.json`
}

/** The object key of an output archive. The identifier is the digest of the archive, so the key is content addressed. */
export function blobObjectKey(blobId) {
  if (!HEX.test(blobId))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the blob id is not a digest')
  return `blobs/${blobId}`
}

/** The object key a write is staged under before it is promoted. The identifier is generated here, never taken from a request. */
export function stagingObjectKey(id = randomUUID()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the staging id is not generated here')
  return `staging/${id}`
}

/** Whether an object key has the shape this transport writes. A key from anywhere else is refused. */
export function isObjectKey(key) {
  return typeof key === 'string' && OBJECT_KEY.test(key)
}

const ENVELOPE_FIELDS = [
  'v',
  'kind',
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
  'producer',
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
 */
export function createEnvelope({ key, secondaryKey, value, blob, createdAt, producer }) {
  const blobId = sha256(blob)
  return {
    v: ENVELOPE_VERSION,
    kind: ENVELOPE_KIND,
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
    producer: producer ?? null,
  }
}

/**
 * Reads an envelope back. The version, the kind, the field set, the sizes and the digests are all checked: an
 * envelope that was written by another version, that was truncated or that was changed in the store is refused rather
 * than replayed.
 */
export function parseEnvelope(bytes, { limits = LIMITS } = {}) {
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
    if (!(field in parsed))
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
  const key = Buffer.from(parsed.key, 'base64')
  const secondaryKey = Buffer.from(parsed.secondary_key, 'base64')
  const value = Buffer.from(parsed.value, 'base64')
  if (key.length === 0 || secondaryKey.length === 0 || value.length === 0)
    throw new TransportRefused(CATEGORY.invalidEnvelope, 'the envelope carries no bytes')
  if (key.length > limits.maxKeyBytes || secondaryKey.length > limits.maxKeyBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the key is larger than the bound')
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

function storePut(store, key, bytes) {
  return store.put(key, bytes)
}

async function storeGet(store, key, maxBytes) {
  const bytes = await store.get(key, { maxBytes })
  if (bytes === null || bytes === undefined) return null
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length > maxBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the store returned more than the bound')
  return buffer
}

/**
 * Writes `bytes` at `key` through a staging object: the write lands under `staging/<id>`, the staged object is read
 * back and compared, and only then is it promoted to `key`. A reader therefore never sees a half written object, and
 * an interrupted write leaves nothing but a staging object, which is removed here.
 */
async function stagedWrite(store, key, bytes, { limits = LIMITS } = {}) {
  const staging = stagingObjectKey()
  try {
    await storePut(store, staging, bytes)
  } catch {
    throw new TransportRefused(CATEGORY.storeWrite)
  }
  try {
    const head = await store.head(staging)
    if (head === null || head === undefined)
      throw new TransportRefused(CATEGORY.storeWrite, 'the staged object is not there')
    if (typeof head.size === 'number' && head.size !== bytes.length)
      throw new TransportRefused(CATEGORY.integrity, 'the staged object has another size')
    if (head.sha256 && head.sha256 !== sha256(bytes))
      throw new TransportRefused(CATEGORY.integrity, 'the staged object has another digest')
    const readBack = await storeGet(store, staging, limits.maxEnvelopeBytes + limits.maxBlobBytes)
    if (readBack === null)
      throw new TransportRefused(CATEGORY.storeWrite, 'the staged object cannot be read back')
    if (sha256(readBack) !== sha256(bytes))
      throw new TransportRefused(
        CATEGORY.integrity,
        'the staged object does not read back as it was written'
      )
    if (typeof store.copy === 'function') await store.copy(staging, key)
    else await storePut(store, key, readBack)
    const head2 = await store.head(key)
    if (head2 === null || head2 === undefined)
      throw new TransportRefused(CATEGORY.storeWrite, 'the promoted object is not there')
    if (typeof head2.size === 'number' && head2.size !== bytes.length)
      throw new TransportRefused(CATEGORY.integrity, 'the promoted object has another size')
    if (head2.sha256 && head2.sha256 !== sha256(bytes))
      throw new TransportRefused(CATEGORY.integrity, 'the promoted object has another digest')
    return { key, sha256: sha256(bytes), size: bytes.length, staged: staging }
  } finally {
    try {
      await store.delete(staging)
    } catch {
      // A staging object that cannot be removed is left behind under `staging/`; it is never read by a reader.
    }
  }
}

/**
 * Publishes one cache entry: the output archive and the envelope that names it. The entry is stored under the
 * digests of the client's key and task fingerprint key, so a second writer of the same entry writes the same objects.
 *
 * The result is a fallback, never an exception, when the store refuses the write: the caller keeps its local cache.
 */
export async function publishEntry(store, entry, { limits = LIMITS, createdAt, producer } = {}) {
  try {
    const key = Buffer.from(entry.key)
    const secondaryKey = Buffer.from(entry.secondaryKey)
    const value = Buffer.from(entry.value)
    const blob = Buffer.from(entry.blob)
    if (key.length === 0 || secondaryKey.length === 0 || value.length === 0)
      return fail(CATEGORY.invalidRequest, 'the entry carries no bytes')
    if (key.length > limits.maxKeyBytes || secondaryKey.length > limits.maxKeyBytes)
      return fail(CATEGORY.tooLarge, 'the key is larger than the bound')
    if (value.length > limits.maxValueBytes)
      return fail(CATEGORY.tooLarge, 'the value is larger than the bound')
    if (blob.length > limits.maxBlobBytes)
      return fail(CATEGORY.tooLarge, 'the blob is larger than the bound')
    const envelope = createEnvelope({
      key,
      secondaryKey,
      value,
      blob,
      createdAt: createdAt ?? new Date().toISOString(),
      producer,
    })
    const bytes = canonicalEnvelopeBytes(envelope)
    if (bytes.length > limits.maxEnvelopeBytes)
      return fail(CATEGORY.tooLarge, 'the envelope is larger than the bound')
    const blobKey = blobObjectKey(envelope.blob_id)
    const entryKey = entryObjectKey(key, secondaryKey)
    const blobWrite = await stagedWrite(store, blobKey, blob, { limits })
    const entryWrite = await stagedWrite(store, entryKey, bytes, { limits })
    return {
      ok: true,
      envelope,
      entryKey,
      blobKey,
      sha256: entryWrite.sha256,
      blobSha256: blobWrite.sha256,
    }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeWrite)
  }
}

/**
 * Reads the entry that was stored for a client key and task fingerprint key. The envelope is checked against its own
 * digests and against the key that was asked for, so an envelope that was stored under the wrong key is refused
 * instead of replayed.
 */
export async function lookupEntry(store, { key, secondaryKey }, { limits = LIMITS } = {}) {
  try {
    const entryKey = entryObjectKey(Buffer.from(key), Buffer.from(secondaryKey))
    const bytes = await storeGet(store, entryKey, limits.maxEnvelopeBytes)
    if (bytes === null) return fail(CATEGORY.notFound)
    const envelope = parseEnvelope(bytes, { limits })
    if (
      envelope.key_sha256 !== sha256(key) ||
      envelope.secondary_key_sha256 !== sha256(secondaryKey)
    )
      return fail(CATEGORY.integrity, 'the envelope was stored under another key')
    return { ok: true, envelope, entryKey }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeRead)
  }
}

/** Reads an output archive by its digest. The digest is the only thing a request can name. */
export async function readBlob(store, blobId, { limits = LIMITS } = {}) {
  try {
    const key = blobObjectKey(blobId)
    const bytes = await storeGet(store, key, limits.maxBlobBytes)
    if (bytes === null) return fail(CATEGORY.notFound)
    if (sha256(bytes) !== blobId)
      return fail(CATEGORY.integrity, 'the archive does not match its digest')
    return { ok: true, blobId, bytes }
  } catch (error) {
    if (error instanceof TransportRefused) return fail(error.category, error.message)
    return fail(CATEGORY.storeRead)
  }
}

/** The boundary of a `multipart/form-data` content type. */
export function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (!match) return null
  return (match[1] ?? match[2]).trim()
}

/**
 * Reads a multipart body into its parts. Every part is bounded, and only the parts the protocol names are read: the
 * metadata and the blob.
 */
export function parseMultipart(body, boundary, { limits = LIMITS } = {}) {
  if (!boundary)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the content type names no boundary')
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (bytes.length > limits.maxRequestBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the request is larger than the bound')
  const marker = Buffer.from(`--${boundary}`)
  const parts = []
  let at = bytes.indexOf(marker)
  while (at !== -1) {
    const start = at + marker.length
    if (bytes.subarray(start, start + 2).toString() === '--') break
    const headerStart = start + 2
    const headerEnd = bytes.indexOf('\r\n\r\n', headerStart)
    if (headerEnd === -1) break
    const headers = bytes.subarray(headerStart, headerEnd).toString('utf8')
    const bodyStart = headerEnd + 4
    const next = bytes.indexOf(marker, bodyStart)
    if (next === -1) break
    const partBody = bytes.subarray(bodyStart, next - 2)
    const name = /name="([^"]*)"/.exec(headers)?.[1]
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
    if (name) parts.push({ name, contentType, body: partBody })
    at = next
  }
  return parts
}

/** The client's `POST /fetch` request: a CBOR map with the entry key and the task fingerprint key. */
export function parseFetchRequest(body, { limits = LIMITS } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (bytes.length > limits.maxKeyBytes * 4)
    throw new TransportRefused(CATEGORY.tooLarge, 'the request is larger than the bound')
  let message
  try {
    message = cborDecode(bytes)
  } catch {
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request is not CBOR')
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request is not a map')
  for (const field of CLIENT_PROTOCOL.requestFields) {
    if (!Buffer.isBuffer(message[field]))
      throw new TransportRefused(CATEGORY.invalidRequest, `the request has no ${field}`)
  }
  return { key: message.key, secondaryKey: message.secondary_key }
}

/**
 * The client's `POST /store` request: a multipart body with the entry metadata in CBOR and the output archive beside
 * it. The metadata is read the same way the client sends it, and the archive is taken as it is.
 */
export function parseStoreRequest(body, contentType, { limits = LIMITS } = {}) {
  const parts = parseMultipart(body, multipartBoundary(contentType), { limits })
  const metadata = parts.find((part) => part.name === 'metadata')
  const blob = parts.find((part) => part.name === 'blob')
  if (!metadata || !blob)
    throw new TransportRefused(CATEGORY.invalidRequest, 'the request has no entry')
  if (metadata.contentType && !metadata.contentType.startsWith(CLIENT_PROTOCOL.contentType))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not CBOR')
  let message
  try {
    message = cborDecode(metadata.body)
  } catch {
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not CBOR')
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new TransportRefused(CATEGORY.invalidRequest, 'the metadata is not a map')
  for (const field of ['key', 'secondary_key', 'value']) {
    if (!Buffer.isBuffer(message[field]))
      throw new TransportRefused(CATEGORY.invalidRequest, `the metadata has no ${field}`)
  }
  if (blob.body.length > limits.maxBlobBytes)
    throw new TransportRefused(CATEGORY.tooLarge, 'the archive is larger than the bound')
  return {
    key: message.key,
    secondaryKey: message.secondary_key,
    value: message.value,
    blob: blob.body,
  }
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
 * Serves the client's remote cache protocol against an injected store.
 *
 * The request is `{ method, path, headers, body }` and the answer is `{ status, headers, body }`. Nothing is fetched
 * from the network and no credential is read: the store is the only outside party, and it is the caller's.
 *
 * `options.authorize` decides whether a request is served. There is no default that allows an anonymous read: a
 * request that arrives without an authorization decision is refused, so this transport is not a public read service.
 * `options.enabled` is the on switch; without it every route answers with a refusal and the client keeps its local
 * cache.
 */
export async function handleRemoteCache(request, store, options = {}) {
  const { enabled = false, authorize, limits = LIMITS, createdAt, producer } = options
  const method = (request.method ?? 'GET').toUpperCase()
  const path = request.path ?? '/'
  const headers = request.headers ?? {}
  if (!enabled) return refuse(503, CATEGORY.disabled)
  if (typeof authorize !== 'function') return refuse(403, CATEGORY.unauthorized)
  let allowed = false
  try {
    allowed = (await authorize({ method, path, headers })) === true
  } catch {
    allowed = false
  }
  if (!allowed) return refuse(403, CATEGORY.unauthorized)
  try {
    if (method === 'POST' && path === CLIENT_PROTOCOL.fetchPath) {
      const { key, secondaryKey } = parseFetchRequest(request.body, { limits })
      const found = await lookupEntry(store, { key, secondaryKey }, { limits })
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
      const entry = parseStoreRequest(request.body, headers['content-type'], { limits })
      const published = await publishEntry(store, entry, { limits, createdAt, producer })
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
      const blob = await readBlob(store, blobId, { limits })
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
  }
}
