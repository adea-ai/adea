import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  CATEGORY,
  CLIENT_PROTOCOL,
  ENVELOPE_KIND,
  ENVELOPE_VERSION,
  LIMITS,
  TransportRefused,
  blobObjectKey,
  canonicalEnvelopeBytes,
  createEnvelope,
  entryObjectKey,
  envelopeDigest,
  fetchResponse,
  handleRemoteCache,
  isEnabled,
  isObjectKey,
  lookupEntry,
  parseEnvelope,
  parseFetchRequest,
  parseMultipart,
  parseStoreRequest,
  publishEntry,
  readBlob,
  stagingObjectKey,
} from './vp-r2-cache.mjs'
import { decode as cborDecode } from './vp-r2-cache.cbor.mjs'
import {
  CLIENT_FETCH_REQUEST,
  CLIENT_FETCH_RESPONSE,
  CLIENT_STORE_REQUEST,
  createMemoryStore,
  fetchRequestBody,
  storeRequestBody,
  storeRequestContentType,
  syntheticEntry,
} from './vp-r2-cache-fixtures.mjs'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: string) => Buffer.from(value, 'utf8')

describe('the envelope', () => {
  test('carries the client bytes unchanged and its own digests', () => {
    const entry = syntheticEntry('envelope')
    const envelope = createEnvelope({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    expect(envelope.v).toBe(ENVELOPE_VERSION)
    expect(envelope.kind).toBe(ENVELOPE_KIND)
    expect(envelope.key_sha256).toBe(sha256(entry.key))
    expect(envelope.secondary_key_sha256).toBe(sha256(entry.secondaryKey))
    expect(envelope.value_sha256).toBe(sha256(entry.value))
    expect(envelope.blob_sha256).toBe(sha256(entry.blob))
    expect(envelope.blob_size).toBe(entry.blob.length)

    const parsed = parseEnvelope(canonicalEnvelopeBytes(envelope))
    expect(parsed.keyBytes.equals(entry.key)).toBe(true)
    expect(parsed.secondaryKeyBytes.equals(entry.secondaryKey)).toBe(true)
    expect(parsed.valueBytes.equals(entry.value)).toBe(true)
    expect(parsed.blob_id).toBe(envelope.blob_id)
  })

  test('is written the same way every time', () => {
    const entry = syntheticEntry('canonical')
    const build = () =>
      createEnvelope({
        key: entry.key,
        secondaryKey: entry.secondaryKey,
        value: entry.value,
        blob: entry.blob,
        createdAt: '2026-10-19T00:00:00.000Z',
      })
    expect(canonicalEnvelopeBytes(build()).equals(canonicalEnvelopeBytes(build()))).toBe(true)
    expect(envelopeDigest(build())).toBe(envelopeDigest(build()))
  })

  test('refuses a version it does not read', () => {
    const entry = syntheticEntry('version')
    const envelope = createEnvelope({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const future = { ...envelope, v: ENVELOPE_VERSION + 1 }
    expect(() => parseEnvelope(canonicalEnvelopeBytes(future))).toThrow(TransportRefused)
    try {
      parseEnvelope(canonicalEnvelopeBytes(future))
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.invalidEnvelope)
    }
  })

  test('refuses a value that was changed in the store', () => {
    const entry = syntheticEntry('tampered')
    const envelope = createEnvelope({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const tampered = { ...envelope, value: Buffer.from('other').toString('base64') }
    try {
      parseEnvelope(canonicalEnvelopeBytes(tampered))
      throw new Error('the tampered envelope was accepted')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.integrity)
    }
  })

  test('refuses an envelope that is larger than the bound', () => {
    const entry = syntheticEntry('oversized')
    const envelope = createEnvelope({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const limits = { ...LIMITS, maxEnvelopeBytes: 16 }
    try {
      parseEnvelope(canonicalEnvelopeBytes(envelope), { limits })
      throw new Error('the oversized envelope was accepted')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.tooLarge)
    }
  })

  test('refuses an envelope that is missing a field', () => {
    const entry = syntheticEntry('missing')
    const envelope = createEnvelope({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    }) as Record<string, unknown>
    delete envelope.blob_id
    expect(() => parseEnvelope(canonicalEnvelopeBytes(envelope as never))).toThrow(TransportRefused)
  })
})

describe('the object keys', () => {
  test('are derived from digests, so no request can steer them', () => {
    const key = bytes('../../etc/passwd')
    const secondaryKey = bytes('/absolute/path')
    const objectKey = entryObjectKey(key, secondaryKey)
    expect(objectKey).toMatch(/^entries\/[0-9a-f]{64}\/[0-9a-f]{64}\/entry\.json$/)
    expect(objectKey.includes('..')).toBe(false)
    expect(objectKey.startsWith('/')).toBe(false)
    expect(isObjectKey(objectKey)).toBe(true)
  })

  test('refuse a blob id that is not a digest', () => {
    expect(() => blobObjectKey('../../secret')).toThrow(TransportRefused)
    expect(() => blobObjectKey('nothex')).toThrow(TransportRefused)
  })

  test('refuse a staging id that was not generated here', () => {
    expect(() => stagingObjectKey('../elsewhere')).toThrow(TransportRefused)
    expect(stagingObjectKey()).toMatch(/^staging\/[0-9a-f-]{36}$/)
  })
})

describe('publishing and reading an entry', () => {
  test('writes the archive and the envelope, and reads them back', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('round-trip')
    const published = await publishEntry(store, entry, { createdAt: '2026-10-19T00:00:00.000Z' })
    expect(published.ok).toBe(true)

    const found = await lookupEntry(store, { key: entry.key, secondaryKey: entry.secondaryKey })
    expect(found.ok).toBe(true)
    expect(found.envelope?.valueBytes.equals(entry.value)).toBe(true)
    expect(found.envelope?.blob_id).toBe(sha256(entry.blob))

    const blob = await readBlob(store, found.envelope!.blob_id)
    expect(blob.ok).toBe(true)
    expect((blob as { bytes: Buffer }).bytes.equals(entry.blob)).toBe(true)

    const staged = [...store.objects.keys()].filter((name) => name.startsWith('staging/'))
    expect(staged).toEqual([])
  })

  test('reports a miss for a key that was never stored', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('absent')
    const found = await lookupEntry(store, { key: entry.key, secondaryKey: entry.secondaryKey })
    expect(found.ok).toBe(false)
    expect(found.fallback).toBe(true)
    expect(found.category).toBe(CATEGORY.notFound)
  })

  test('falls back instead of throwing when the store refuses the write', async () => {
    const store = createMemoryStore({ failPut: true })
    const entry = syntheticEntry('store-failure')
    const published = await publishEntry(store, entry)
    expect(published.ok).toBe(false)
    expect(published.fallback).toBe(true)
    expect(published.category).toBe(CATEGORY.storeWrite)
    expect(store.objects.size).toBe(0)
  })

  test('falls back instead of throwing when the store refuses the read', async () => {
    const store = createMemoryStore({ failGet: true })
    const entry = syntheticEntry('read-failure')
    const found = await lookupEntry(store, { key: entry.key, secondaryKey: entry.secondaryKey })
    expect(found.ok).toBe(false)
    expect(found.category).toBe(CATEGORY.storeRead)
  })

  test('promotes nothing when the staged object does not read back as it was written', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('corrupt-stage')
    const original = store.put.bind(store)
    store.put = (key: string, value: Buffer) => {
      const result = original(key, value)
      if (key.startsWith('staging/')) store.objects.set(key, Buffer.from('changed'))
      return result
    }
    const published = await publishEntry(store, entry)
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.integrity)
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('leaves the entry unpublished when the promotion fails', async () => {
    const store = createMemoryStore({ failCopy: true })
    const entry = syntheticEntry('failed-promotion')
    const published = await publishEntry(store, entry)
    expect(published.ok).toBe(false)
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('refuses an entry that is larger than the bound', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('too-large')
    const published = await publishEntry(store, entry, { limits: { ...LIMITS, maxBlobBytes: 4 } })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.tooLarge)
    expect(store.objects.size).toBe(0)
  })
})

describe("the client's own messages", () => {
  test('the captured fetch request reads as the client sent it', () => {
    const request = parseFetchRequest(Buffer.from(CLIENT_FETCH_REQUEST, 'base64'))
    expect(request.key.length).toBeGreaterThan(0)
    expect(request.secondaryKey.length).toBeGreaterThan(0)
    expect(request.key.equals(request.secondaryKey)).toBe(false)
  })

  test('the captured store request reads as the client sent it', () => {
    const request = parseStoreRequest(
      Buffer.from(CLIENT_STORE_REQUEST, 'base64'),
      'multipart/form-data; boundary=9af92a0fbcad5757-5835ac97f2f4ee81-0f0ba382588ea13e-787ad9f5f2d98bdd'
    )
    expect(request.key.length).toBeGreaterThan(0)
    expect(request.value.length).toBeGreaterThan(0)
    expect(request.blob.length).toBeGreaterThan(0)
  })

  test('the captured answer holds exactly the fields the client reads', () => {
    const message = cborDecode(Buffer.from(CLIENT_FETCH_RESPONSE, 'base64'))
    expect(Object.keys(message).toSorted()).toEqual([...CLIENT_PROTOCOL.responseFields].toSorted())
    expect(message.kind).toBe(CLIENT_PROTOCOL.kind)
    expect(typeof message.blob_id).toBe('string')
  })

  test('a malformed request is refused rather than guessed at', () => {
    expect(() => parseFetchRequest(bytes('not cbor'))).toThrow(TransportRefused)
    expect(() => parseMultipart(bytes('no boundary'), null)).toThrow(TransportRefused)
  })
})

describe('the transport', () => {
  test('is off unless it is turned on', () => {
    expect(isEnabled({})).toBe(false)
    expect(isEnabled({ ADEA_VP_R2_CACHE_ENABLED: '0' })).toBe(false)
    expect(isEnabled({ ADEA_VP_R2_CACHE_ENABLED: 'true' })).toBe(false)
    expect(isEnabled({ ADEA_VP_R2_CACHE_ENABLED: '1' })).toBe(true)
  })

  test('makes no store call while it is off', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('disabled')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      store,
      { authorize: () => true }
    )
    expect(answer.status).toBe(503)
    expect(store.calls).toEqual([])
  })

  test('refuses a request that arrives without an authorization decision', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('unauthorized')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      store,
      { enabled: true }
    )
    expect(answer.status).toBe(403)
    expect(store.calls).toEqual([])
  })

  test('writes and reads an entry through the client protocol', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('protocol')
    const options = { enabled: true, authorize: () => true, createdAt: '2026-10-19T00:00:00.000Z' }

    const stored = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      store,
      options
    )
    expect(stored.status).toBe(200)

    const fetched = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      store,
      options
    )
    expect(fetched.status).toBe(200)
    const message = cborDecode(fetched.body)
    expect(Object.keys(message).toSorted()).toEqual([...CLIENT_PROTOCOL.responseFields].toSorted())
    expect(message.kind).toBe(CLIENT_PROTOCOL.kind)
    expect(Buffer.from(message.key).equals(entry.key)).toBe(true)
    expect(Buffer.from(message.secondary_key).equals(entry.secondaryKey)).toBe(true)
    expect(Buffer.from(message.value).equals(entry.value)).toBe(true)

    const blob = await handleRemoteCache(
      { method: 'GET', path: `${CLIENT_PROTOCOL.blobPath}${message.blob_id}`, headers: {} },
      store,
      options
    )
    expect(blob.status).toBe(200)
    expect(Buffer.from(blob.body).equals(entry.blob)).toBe(true)
    expect(blob.headers['content-type']).toBe(CLIENT_PROTOCOL.blobContentType)
  })

  test('answers a miss with a status the client reads as a miss', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('miss')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      store,
      { enabled: true, authorize: () => true }
    )
    expect(answer.status).toBe(404)
  })

  test('refuses a request it does not understand', async () => {
    const store = createMemoryStore()
    const options = { enabled: true, authorize: () => true }
    const malformed = await handleRemoteCache(
      { method: 'POST', path: CLIENT_PROTOCOL.fetchPath, headers: {}, body: bytes('not cbor') },
      store,
      options
    )
    expect(malformed.status).toBe(400)
    const unknown = await handleRemoteCache(
      { method: 'GET', path: '/elsewhere', headers: {} },
      store,
      options
    )
    expect(unknown.status).toBe(404)
  })

  test('refuses an archive that is larger than the bound', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('large-upload')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      store,
      { enabled: true, authorize: () => true, limits: { ...LIMITS, maxBlobBytes: 4 } }
    )
    expect(answer.status).toBe(413)
    expect(store.objects.size).toBe(0)
  })

  test('leaves the caller to its local cache when the store fails', async () => {
    const store = createMemoryStore({ failGet: true })
    const entry = syntheticEntry('store-down')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      store,
      { enabled: true, authorize: () => true }
    )
    expect(answer.status).toBe(503)
    expect(answer.category).toBe(CATEGORY.storeRead)
  })
})

describe('the answer to a fetch', () => {
  test('holds the fields the client reads', () => {
    const entry = syntheticEntry('answer')
    const answer = fetchResponse({
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blobId: sha256(entry.blob),
    })
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe(CLIENT_PROTOCOL.contentType)
    const message = cborDecode(answer.body)
    expect(Object.keys(message).toSorted()).toEqual([...CLIENT_PROTOCOL.responseFields].toSorted())
    expect(message.kind).toBe(CLIENT_PROTOCOL.kind)
    expect(message.blob_id).toBe(sha256(entry.blob))
  })
})
