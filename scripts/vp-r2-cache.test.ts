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
  createTransport,
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
  trustDomain,
} from './vp-r2-cache.mjs'
import { decode as cborDecode, encode as cborEncode, ownField } from './vp-r2-cache.cbor.mjs'
import {
  CLIENT_FETCH_REQUEST,
  CLIENT_FETCH_RESPONSE,
  CLIENT_STORE_REQUEST,
  createMemoryStore,
  duplicateKeyFetchRequest,
  fetchRequestBody,
  prototypePollutedFetchRequest,
  storeRequestBody,
  storeRequestBodyWithEmbeddedBoundary,
  storeRequestContentType,
  syntheticEntry,
  testScope,
} from './vp-r2-cache-fixtures.mjs'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: string) => Buffer.from(value, 'utf8')
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const scope = testScope()

/** The authorization decision the transport accepts: bound to the trust domain. */
const allowScope = (domain: { id: string }) => ({ allow: true, scope: domain.id })

describe('the trust domain', () => {
  test('names a namespace and a compatibility context', () => {
    const domain = trustDomain({
      namespace: 'adea-ai/adea',
      client: '1.3.0',
      toolchain: 'orch-v1.48.1',
    })
    expect(domain.namespace).toBe('adea-ai/adea')
    expect(domain.client).toBe('1.3.0')
    expect(domain.toolchain).toBe('orch-v1.48.1')
    expect(domain.id).toMatch(/^[0-9a-f]{64}$/)
    expect(
      trustDomain({ namespace: 'adea-ai/adea', client: '1.3.0', toolchain: 'orch-v1.48.1' }).id
    ).toBe(domain.id)
  })

  test('refuses a namespace, a version or a toolchain that are not plain names', () => {
    expect(() => trustDomain({ namespace: '', client: '1.3.0', toolchain: 't' })).toThrow(
      TransportRefused
    )
    expect(() => trustDomain({ namespace: 'a b', client: '1.3.0', toolchain: 't' })).toThrow(
      TransportRefused
    )
    expect(() => trustDomain({ namespace: 'a', client: '', toolchain: 't' })).toThrow(
      TransportRefused
    )
    expect(() => trustDomain({ namespace: 'a', client: '1.3.0', toolchain: '' })).toThrow(
      TransportRefused
    )
  })

  test('binds the object keys to the domain', () => {
    const entry = syntheticEntry('scope-keys')
    const key = entryObjectKey(scope, entry.key, entry.secondaryKey)
    expect(key).toMatch(/^entries\/[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{64}\/entry\.json$/)
    expect(key).toContain(scope.id)
    expect(isObjectKey(key)).toBe(true)
    expect(blobObjectKey(scope, sha256(entry.blob))).toMatch(/^blobs\/[0-9a-f]{64}\/[0-9a-f]{64}$/)
    expect(stagingObjectKey(scope)).toMatch(/^staging\/[0-9a-f]{64}\/[0-9a-f-]{36}$/)
  })

  test('keeps two domains apart in one store', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('cross-scope')
    const mine = testScope('repo-a')
    const theirs = testScope('repo-b')
    const published = await publishEntry(store, entry, { scope: mine })
    expect(published.ok).toBe(true)

    // The other domain cannot even name the object.
    const seen = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope: theirs }
    )
    expect(seen.ok).toBe(false)
    expect(seen.category).toBe(CATEGORY.notFound)
    expect([...store.objects.keys()].some((name) => name.includes(theirs.id))).toBe(false)

    // And the envelope itself is refused when it is read under another domain.
    const raw = store.objects.get(published.entryKey)
    expect(() => parseEnvelope(raw, { scope: theirs })).toThrow(TransportRefused)
    try {
      parseEnvelope(raw, { scope: theirs })
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.trustDomain)
    }
  })

  test('refuses an entry written by another client version or another toolchain', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('compatibility')
    const published = await publishEntry(store, entry, { scope })
    const raw = store.objects.get(published.entryKey)
    const otherClient = testScope('adea-ai/adea', '1.4.0')
    const otherToolchain = testScope('adea-ai/adea', '1.3.0', 'other-toolchain')
    for (const other of [otherClient, otherToolchain]) {
      try {
        parseEnvelope(raw, { scope: other })
        throw new Error('the envelope was accepted under another compatibility context')
      } catch (error) {
        expect((error as TransportRefused).category).toBe(CATEGORY.compatibility)
      }
    }
  })

  test('records the domain and the compatibility context in the envelope', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('envelope-scope')
    const published = await publishEntry(store, entry, { scope })
    const envelope = published.envelope
    expect(envelope.v).toBe(ENVELOPE_VERSION)
    expect(envelope.kind).toBe(ENVELOPE_KIND)
    expect(envelope.scope).toBe(scope.id)
    expect(envelope.namespace).toBe(scope.namespace)
    expect(envelope.client).toBe(scope.client)
    expect(envelope.toolchain).toBe(scope.toolchain)
    expect(Object.hasOwn(envelope, 'producer')).toBe(false)
  })
})

describe('the envelope', () => {
  test('carries the client bytes unchanged and its own digests', () => {
    const entry = syntheticEntry('envelope')
    const envelope = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    expect(envelope.key_sha256).toBe(sha256(entry.key))
    expect(envelope.secondary_key_sha256).toBe(sha256(entry.secondaryKey))
    expect(envelope.value_sha256).toBe(sha256(entry.value))
    expect(envelope.blob_sha256).toBe(sha256(entry.blob))
    expect(envelope.blob_size).toBe(entry.blob.length)

    const parsed = parseEnvelope(canonicalEnvelopeBytes(envelope), { scope })
    expect(parsed.keyBytes.equals(entry.key)).toBe(true)
    expect(parsed.secondaryKeyBytes.equals(entry.secondaryKey)).toBe(true)
    expect(parsed.valueBytes.equals(entry.value)).toBe(true)
  })

  test('is written the same way every time', () => {
    const entry = syntheticEntry('canonical')
    const build = () =>
      createEnvelope({
        scope,
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
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const future = { ...envelope, v: ENVELOPE_VERSION + 1 }
    try {
      parseEnvelope(canonicalEnvelopeBytes(future), { scope })
      throw new Error('the envelope of an unknown version was accepted')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.invalidEnvelope)
    }
  })

  test('refuses a value that was changed in the store', () => {
    const entry = syntheticEntry('tampered')
    const envelope = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    const tampered = { ...envelope, value: Buffer.from('other').toString('base64') }
    try {
      parseEnvelope(canonicalEnvelopeBytes(tampered), { scope })
      throw new Error('the tampered envelope was accepted')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.integrity)
    }
  })

  test('refuses an envelope that is larger than the bound', () => {
    const entry = syntheticEntry('oversized')
    const envelope = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    })
    try {
      parseEnvelope(canonicalEnvelopeBytes(envelope), {
        scope,
        limits: { ...LIMITS, maxEnvelopeBytes: 16 },
      })
      throw new Error('the oversized envelope was accepted')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.tooLarge)
    }
  })

  test('refuses an envelope that is missing a field', () => {
    const entry = syntheticEntry('missing')
    const envelope = createEnvelope({
      scope,
      key: entry.key,
      secondaryKey: entry.secondaryKey,
      value: entry.value,
      blob: entry.blob,
      createdAt: '2026-10-19T00:00:00.000Z',
    }) as Record<string, unknown>
    delete envelope.blob_id
    expect(() => parseEnvelope(canonicalEnvelopeBytes(envelope as never), { scope })).toThrow(
      TransportRefused
    )
  })

  test('is refused without a trust domain', () => {
    expect(() => parseEnvelope(Buffer.from('{}'), {})).toThrow(TransportRefused)
  })
})

describe('the object keys', () => {
  test('are derived from digests, so no request can steer them', () => {
    const key = bytes('../../etc/passwd')
    const secondaryKey = bytes('/absolute/path')
    const objectKey = entryObjectKey(scope, key, secondaryKey)
    expect(objectKey.includes('..')).toBe(false)
    expect(objectKey.startsWith('/')).toBe(false)
    expect(isObjectKey(objectKey)).toBe(true)
  })

  test('refuse a blob id that is not a digest', () => {
    expect(() => blobObjectKey(scope, '../../secret')).toThrow(TransportRefused)
    expect(() => blobObjectKey(scope, 'nothex')).toThrow(TransportRefused)
  })

  test('refuse a staging id that was not generated here', () => {
    expect(() => stagingObjectKey(scope, '../elsewhere')).toThrow(TransportRefused)
  })
})

describe('the multipart body', () => {
  test('keeps an archive that holds the boundary as plain bytes', () => {
    const body = storeRequestBodyWithEmbeddedBoundary()
    const parts = parseMultipart(body, 'adea-boundary')
    const blob = parts.find((part) => part.name === 'blob')
    expect(blob?.body.toString('utf8')).toBe('prefix--adea-boundary--suffix')
  })

  test('keeps arbitrary bytes', () => {
    const every = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    const entry = { ...syntheticEntry('binary'), blob: every }
    const parts = parseMultipart(storeRequestBody(entry, 'adea-boundary'), 'adea-boundary')
    const blob = parts.find((part) => part.name === 'blob')
    expect(blob?.body.equals(every)).toBe(true)
  })

  test('refuses a body that has no closing boundary', () => {
    const body = storeRequestBody(syntheticEntry('unclosed'))
    const cut = body.subarray(0, body.length - 12)
    expect(() => parseMultipart(cut, 'adea-boundary')).toThrow(TransportRefused)
  })

  test('refuses a body that does not start with the boundary', () => {
    const body = storeRequestBody(syntheticEntry('offset'))
    expect(() => parseMultipart(Buffer.concat([bytes('junk'), body]), 'adea-boundary')).toThrow(
      TransportRefused
    )
  })

  test('refuses a repeated part name', () => {
    const metadata = Buffer.from([0xa0])
    const body = Buffer.concat([
      bytes('--b\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'),
      metadata,
      bytes('\r\n--b\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'),
      metadata,
      bytes('\r\n--b--\r\n'),
    ])
    expect(() => parseMultipart(body, 'b')).toThrow(TransportRefused)
  })

  test('refuses a part without a name', () => {
    const body = Buffer.concat([
      bytes('--b\r\nContent-Type: application/cbor\r\n\r\n'),
      Buffer.from([0xa0]),
      bytes('\r\n--b--\r\n'),
    ])
    expect(() => parseMultipart(body, 'b')).toThrow(TransportRefused)
  })

  test('keeps an archive that holds a boundary line as plain bytes', () => {
    const boundary = 'adea-boundary'
    const blob = Buffer.concat([
      Buffer.from('before', 'utf8'),
      Buffer.from(`\r\n--${boundary}--suffix`, 'utf8'),
      Buffer.from('between', 'utf8'),
      Buffer.from(`\r\n--${boundary}X`, 'utf8'),
      Buffer.from('after', 'utf8'),
    ])
    const parts = parseMultipart(
      storeRequestBody({ ...syntheticEntry('crlf-boundary'), blob }, boundary),
      boundary
    )
    const found = parts.find((part) => part.name === 'blob')
    expect(found?.body.equals(blob)).toBe(true)
  })

  test('refuses a closing boundary that is not a complete line', () => {
    const boundary = 'adea-boundary'
    const body = storeRequestBody(syntheticEntry('truncated-close'), boundary)
    const head = body.subarray(0, body.length - `--${boundary}--\r\n`.length)
    expect(() =>
      parseMultipart(Buffer.concat([head, Buffer.from(`\r\n--${boundary}-`)]), boundary)
    ).toThrow(TransportRefused)
    expect(() =>
      parseMultipart(Buffer.concat([head, Buffer.from(`\r\n--${boundary}--\r`)]), boundary)
    ).toThrow(TransportRefused)
  })

  test('refuses a boundary that is not a plain boundary', () => {
    expect(() => parseMultipart(Buffer.from('x'), 'bad boundary')).toThrow(TransportRefused)
  })
})

describe('the bounds', () => {
  test('refuse an empty key, task fingerprint key or value', () => {
    const entry = syntheticEntry('empty')
    expect(() => parseFetchRequest(fetchRequestBody({ ...entry, key: Buffer.alloc(0) }))).toThrow(
      TransportRefused
    )
    expect(() =>
      parseFetchRequest(fetchRequestBody({ ...entry, secondaryKey: Buffer.alloc(0) }))
    ).toThrow(TransportRefused)
  })

  test('hold each field to its own bound', () => {
    const entry = syntheticEntry('per-field')
    expect(() =>
      parseFetchRequest(fetchRequestBody(entry), { limits: { ...LIMITS, maxKeyBytes: 8 } })
    ).toThrow(TransportRefused)
    expect(() =>
      parseFetchRequest(fetchRequestBody(entry), { limits: { ...LIMITS, maxSecondaryKeyBytes: 8 } })
    ).toThrow(TransportRefused)
    expect(() =>
      parseStoreRequest(storeRequestBody(entry), storeRequestContentType(), {
        limits: { ...LIMITS, maxValueBytes: 8 },
      })
    ).toThrow(TransportRefused)
    expect(() =>
      parseStoreRequest(storeRequestBody(entry), storeRequestContentType(), {
        limits: { ...LIMITS, maxSecondaryKeyBytes: 8 },
      })
    ).toThrow(TransportRefused)
    const parsed = parseStoreRequest(storeRequestBody(entry), storeRequestContentType())
    expect(parsed.value.length).toBeGreaterThan(0)
  })

  test('measure the metadata before it is decoded', () => {
    const entry = syntheticEntry('metadata-bound')
    try {
      parseStoreRequest(storeRequestBody(entry), storeRequestContentType(), {
        limits: { ...LIMITS, maxMetadataBytes: 4 },
      })
      throw new Error('the oversized metadata was decoded')
    } catch (error) {
      expect((error as TransportRefused).category).toBe(CATEGORY.tooLarge)
    }
  })

  test('hold the decoder to a nesting budget', () => {
    let deep = Buffer.from([0x82, 0x82, 0x82, 0x82, 0x01])
    for (let index = 0; index < 40; index += 1) deep = Buffer.concat([Buffer.from([0x82]), deep])
    expect(() => cborDecode(deep, { maxDepth: 8, maxItems: 4096 })).toThrow()
    expect(() => parseFetchRequest(deep)).toThrow(TransportRefused)
  })

  test('hold the decoder to an item budget', () => {
    const many = Buffer.concat([
      Buffer.from([0xb9, 0x01, 0x00]),
      ...Array.from({ length: 300 }, () => Buffer.from([0x01])),
    ])
    expect(() => cborDecode(many, { maxDepth: 32, maxItems: 16 })).toThrow()
    expect(() => parseFetchRequest(many)).toThrow(TransportRefused)
  })

  test('refuse a request body that the adapter should have bounded', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: Buffer.alloc(LIMITS.maxRequestBytes + 1),
      },
      transport,
      { enabled: true, authorize: () => allowScope(scope) }
    )
    expect(answer.status).toBe(413)
  })
})

describe('the CBOR maps', () => {
  test('are decoded into null-prototype objects', () => {
    const decoded = cborDecode(cborEncode({ kind: 'exact' }))
    expect(Object.getPrototypeOf(decoded)).toBe(null)
  })

  test('do not let a prototype carry the fields the transport reads', () => {
    const decoded = cborDecode(prototypePollutedFetchRequest())
    expect(ownField(decoded, 'key')).toBeUndefined()
    expect(ownField(decoded, 'secondary_key')).toBeUndefined()
    expect(() => parseFetchRequest(prototypePollutedFetchRequest())).toThrow(TransportRefused)
  })

  test('refuse a map that holds the same key twice', () => {
    expect(() => cborDecode(duplicateKeyFetchRequest())).toThrow()
    expect(() => parseFetchRequest(duplicateKeyFetchRequest())).toThrow(TransportRefused)
  })

  test('read a field only when the map owns it', () => {
    const inherited = Object.create({ key: 'inherited', secondary_key: 'inherited' })
    expect(ownField(inherited, 'key')).toBeUndefined()
    expect(ownField(inherited, 'secondary_key')).toBeUndefined()
    expect(ownField(Object.assign(Object.create(null), { key: 'own' }), 'key')).toBe('own')
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
})

describe('publishing and reading an entry', () => {
  test('writes the archive and the envelope, and reads them back', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('round-trip')
    const published = await publishEntry(store, entry, { scope })
    expect(published.ok).toBe(true)

    const found = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope }
    )
    expect(found.ok).toBe(true)
    expect(found.envelope?.valueBytes.equals(entry.value)).toBe(true)

    const blob = await readBlob(store, found.envelope!.blob_id, { scope })
    expect(blob.ok).toBe(true)
    expect((blob as { bytes: Buffer }).bytes.equals(entry.blob)).toBe(true)

    const staged = [...store.objects.keys()].filter((name) => name.startsWith('staging/'))
    expect(staged).toEqual([])
  })

  test('refuses to work without a trust domain', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('no-scope')
    await expect(publishEntry(store, entry, {})).rejects.toThrow(TransportRefused)
    await expect(
      lookupEntry(store, { key: entry.key, secondaryKey: entry.secondaryKey }, {})
    ).rejects.toThrow(TransportRefused)
  })

  test('reports a miss for a key that was never stored', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('absent')
    const found = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope }
    )
    expect(found.ok).toBe(false)
    expect(found.fallback).toBe(true)
    expect(found.category).toBe(CATEGORY.notFound)
  })

  test('falls back instead of throwing when the store refuses the write', async () => {
    const store = createMemoryStore({ failPut: true })
    const entry = syntheticEntry('store-failure')
    const published = await publishEntry(store, entry, { scope })
    expect(published.ok).toBe(false)
    expect(published.fallback).toBe(true)
    expect(published.category).toBe(CATEGORY.storeWrite)
    expect(store.objects.size).toBe(0)
  })

  test('falls back instead of throwing when the store refuses the read', async () => {
    const store = createMemoryStore({ failGet: true })
    const entry = syntheticEntry('read-failure')
    const found = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope }
    )
    expect(found.ok).toBe(false)
    expect(found.category).toBe(CATEGORY.storeRead)
  })

  test('promotes nothing when the staged object does not read back as it was written', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('corrupt-stage')
    const original = store.put.bind(store)
    store.put = async (key: string, value: Buffer) => {
      const result = await original(key, value)
      if (key.startsWith('staging/')) store.objects.set(key, Buffer.from('changed'))
      return result
    }
    const published = await publishEntry(store, entry, { scope })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.integrity)
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('leaves the entry unpublished when the promotion fails', async () => {
    const store = createMemoryStore({ failCopy: true })
    const entry = syntheticEntry('failed-promotion')
    const published = await publishEntry(store, entry, { scope })
    expect(published.ok).toBe(false)
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('refuses an entry that is larger than the bound', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('too-large')
    const published = await publishEntry(store, entry, {
      scope,
      limits: { ...LIMITS, maxBlobBytes: 4 },
    })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.tooLarge)
    expect(store.objects.size).toBe(0)
  })

  test('publishes the final object in one atomic step', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('atomic')
    const published = await publishEntry(store, entry, { scope })
    const writes = store.calls.filter(
      (call) =>
        call.op === 'put' ||
        call.op === 'copy' ||
        call.op === 'putIfAbsent' ||
        call.op === 'copyIfAbsent'
    )
    const finalWrites = writes.filter(
      (call) => call.key === published.entryKey || call.to === published.entryKey
    )
    expect(finalWrites.length).toBe(1)
    // The one step that publishes the final object is the fenced one.
    expect(finalWrites[0].op).toBe('copyIfAbsent')
    const stored = store.objects.get(published.entryKey)
    expect(stored?.equals(canonicalEnvelopeBytes(published.envelope))).toBe(true)
  })

  test('publishes the same entry twice without leaving anything half written', async () => {
    const store = createMemoryStore()
    const entry = syntheticEntry('concurrent')
    const [first, second] = await Promise.all([
      publishEntry(store, entry, { scope }),
      publishEntry(store, entry, { scope }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.entryKey).toBe(second.entryKey)
    const stored = store.objects.get(first.entryKey)
    expect(stored?.equals(canonicalEnvelopeBytes(first.envelope))).toBe(true)
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })
})

describe('the deadlines', () => {
  test('end an operation whose store never answers', async () => {
    const store = createMemoryStore({ stall: ['put'] })
    const entry = syntheticEntry('stalled-put')
    const started = Date.now()
    const published = await publishEntry(store, entry, { scope, deadlineMs: 60 })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.timeout)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('end an operation whose authorization never answers', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('stalled-authorize')
    const started = Date.now()
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      transport,
      { enabled: true, authorize: () => new Promise(() => {}), deadlineMs: 60 }
    )
    expect(answer.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(store.calls).toEqual([])
  })

  test('an expiry during the archive promotion publishes nothing', async () => {
    // A cooperative store gives up when the operation is cancelled, so the archive is never published.
    const store = createMemoryStore({
      cooperative: true,
      slowFor: (key: string) => key.startsWith('blobs/'),
      slowMs: 200,
    })
    const entry = syntheticEntry('expired-blob')
    const published = await publishEntry(store, entry, { scope, deadlineMs: 60 })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.timeout)
    expect([...store.objects.keys()].filter((name) => name.startsWith('blobs/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    // The staging object belongs to this operation, so it is removed even though the signal is already aborted.
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('an expiry during the envelope promotion leaves the entry unreadable', async () => {
    const store = createMemoryStore({
      cooperative: true,
      slowFor: (key: string) => key.startsWith('entries/'),
      slowMs: 200,
    })
    const entry = syntheticEntry('expired-envelope')
    const published = await publishEntry(store, entry, { scope, deadlineMs: 60 })
    expect(published.ok).toBe(false)
    expect(published.category).toBe(CATEGORY.timeout)
    expect([...store.objects.keys()].filter((name) => name.startsWith('entries/'))).toEqual([])
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
    const found = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope }
    )
    expect(found.ok).toBe(false)
  })

  test('a late promotion never removes the entry a successor published', async () => {
    let slow = false
    // A store that does not honour cancellation: the late write lands, and the transport may not roll it back by
    // deleting a shared final key.
    const store = createMemoryStore({
      cooperative: false,
      slowFor: (key: string) => slow && !key.startsWith('staging/'),
      slowMs: 200,
    })
    const entry = syntheticEntry('successor')
    const successor = await publishEntry(store, entry, { scope, deadlineMs: 2000 })
    expect(successor.ok).toBe(true)

    slow = true
    const expired = await publishEntry(store, entry, { scope, deadlineMs: 60 })
    expect(expired.ok).toBe(false)
    expect(expired.category).toBe(CATEGORY.timeout)

    // The promotion that was in flight has landed by now, and it did not remove what the successor published.
    await sleep(300)
    const found = await lookupEntry(
      store,
      { key: entry.key, secondaryKey: entry.secondaryKey },
      { scope }
    )
    expect(found.ok).toBe(true)
    const blob = await readBlob(store, found.envelope!.blob_id, { scope })
    expect(blob.ok).toBe(true)
    expect([...store.objects.keys()].filter((name) => name.startsWith('staging/'))).toEqual([])
  })

  test('do not wait for a cleanup that never answers', async () => {
    const store = createMemoryStore({ failCopy: true, stall: ['delete'] })
    const entry = syntheticEntry('stalled-cleanup')
    const started = Date.now()
    const published = await publishEntry(store, entry, {
      scope,
      deadlineMs: 60,
      limits: { ...LIMITS, cleanupTimeoutMs: 100 },
    })
    expect(published.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
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
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('disabled')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      transport,
      { authorize: () => allowScope(scope) }
    )
    expect(answer.status).toBe(503)
    expect(store.calls).toEqual([])
  })

  test('refuses a request that arrives without an authorization decision', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('unauthorized')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      transport,
      { enabled: true }
    )
    expect(answer.status).toBe(403)
    expect(store.calls).toEqual([])
  })

  test('refuses an authorization decision that is not bound to the trust domain', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('unscoped-decision')
    for (const decision of [true, { allow: true }, { allow: true, scope: testScope('other').id }]) {
      const answer = await handleRemoteCache(
        {
          method: 'POST',
          path: CLIENT_PROTOCOL.fetchPath,
          headers: {},
          body: fetchRequestBody(entry),
        },
        transport,
        { enabled: true, authorize: () => decision }
      )
      expect(answer.status).toBe(403)
    }
    expect(store.calls).toEqual([])
  })

  test('writes and reads an entry through the client protocol', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('protocol')
    const options = { enabled: true, authorize: () => allowScope(scope) }

    const stored = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      transport,
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
      transport,
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
      transport,
      options
    )
    expect(blob.status).toBe(200)
    expect(Buffer.from(blob.body).equals(entry.blob)).toBe(true)
    expect(blob.headers['content-type']).toBe(CLIENT_PROTOCOL.blobContentType)
  })

  test('keeps two domains apart over one store', async () => {
    const store = createMemoryStore()
    const mine = testScope('repo-a')
    const theirs = testScope('repo-b')
    const entry = syntheticEntry('handler-cross-scope')
    const mineTransport = createTransport({ scope: mine, store })
    const theirTransport = createTransport({ scope: theirs, store })
    const stored = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      mineTransport,
      { enabled: true, authorize: () => allowScope(mine) }
    )
    expect(stored.status).toBe(200)
    const seen = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      theirTransport,
      { enabled: true, authorize: () => allowScope(theirs) }
    )
    expect(seen.status).toBe(404)
  })

  test('the transport constructor policy is enforced through the handler', async () => {
    const store = createMemoryStore()
    // The transport is configured with a small archive bound, and the handler does not repeat it.
    const transport = createTransport({ scope, store, limits: { ...LIMITS, maxBlobBytes: 4 } })
    const entry = syntheticEntry('constructor-limits')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      transport,
      { enabled: true, authorize: () => allowScope(scope) }
    )
    expect(answer.status).toBe(413)
    expect(store.objects.size).toBe(0)
  })

  test('the whole request runs under one deadline', async () => {
    // The publication's promotion is slow, the staged write is not.
    const store = createMemoryStore({
      slowFor: (key: string) => !key.startsWith('staging/'),
      slowMs: 30,
    })
    const transport = createTransport({ scope, store, deadlineMs: 50 })
    const entry = syntheticEntry('one-deadline')
    const started = Date.now()
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      transport,
      {
        enabled: true,
        authorize: async () => {
          await sleep(35)
          return allowScope(scope)
        },
      }
    )
    // The authorization spent 35ms of the 50ms the request had, so the publication cannot finish in the rest.
    expect(answer.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(200)
  })

  test('answers a miss with a status the client reads as a miss', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('miss')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      transport,
      { enabled: true, authorize: () => allowScope(scope) }
    )
    expect(answer.status).toBe(404)
  })

  test('refuses a request it does not understand', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const options = { enabled: true, authorize: () => allowScope(scope) }
    const malformed = await handleRemoteCache(
      { method: 'POST', path: CLIENT_PROTOCOL.fetchPath, headers: {}, body: bytes('not cbor') },
      transport,
      options
    )
    expect(malformed.status).toBe(400)
    const unknown = await handleRemoteCache(
      { method: 'GET', path: '/elsewhere', headers: {} },
      transport,
      options
    )
    expect(unknown.status).toBe(404)
  })

  test('refuses an archive that is larger than the bound', async () => {
    const store = createMemoryStore()
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('large-upload')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.storePath,
        headers: { 'content-type': storeRequestContentType() },
        body: storeRequestBody(entry),
      },
      transport,
      { enabled: true, authorize: () => allowScope(scope), limits: { ...LIMITS, maxBlobBytes: 4 } }
    )
    expect(answer.status).toBe(413)
    expect(store.objects.size).toBe(0)
  })

  test('leaves the caller to its local cache when the store fails', async () => {
    const store = createMemoryStore({ failGet: true })
    const transport = createTransport({ scope, store })
    const entry = syntheticEntry('store-down')
    const answer = await handleRemoteCache(
      {
        method: 'POST',
        path: CLIENT_PROTOCOL.fetchPath,
        headers: {},
        body: fetchRequestBody(entry),
      },
      transport,
      { enabled: true, authorize: () => allowScope(scope) }
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
