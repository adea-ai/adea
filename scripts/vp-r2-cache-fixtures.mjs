// Synthetic fixtures for the shared R2 task-cache transport.
//
// The three captured messages below are the pinned Vite+ client's own bytes. They were recorded against a throwaway
// local project whose task printed one line and wrote one file; they name the command, the tracked environment names
// and the relative input paths of that project, and carry no path, no credential and no identifier of any machine.
// They are the ground truth this transport is written against: the codec reads them, and the shape of the answer is
// the one the client accepted and replayed.
//
// Everything below the captures is synthetic and generated in this file.

// The bytes the pinned client sent in POST /fetch: a CBOR map with the entry key and
// the task fingerprint key.
export const CLIENT_FETCH_REQUEST = [
  'omNrZXlZBQ0SAAAABQAAAAAAAABtYWNvcwcAAAAAAAAAYWFyY2g2NAAAAAAAAAAAAAAAAAMAAAAAAAAAYnVuAgAAAAAAAAACAAAAAAAAAC1lZQAAAAAAAAByZXF1aXJlKCdmcycpLm1rZGlyU3luYygnb3V0Jyx7cmVjdXJzaXZlOnRydWV9KTtyZXF1aXJlKCdmcycpLndyaXRlRmlsZVN5bmMoJ291dC9hLnR4dCcsJ2hlbGxvLWFkZWEnKQAAAAAAAAAANwAAAAAAAAAHAAAAAAAAACpfVE9LRU4cAAAAAAAAAEFDVElPTlNfSURfVE9LRU5fUkVRVUVTVF9VUkwHAAAAAAAAAEFQUERBVEEKAAAAAAAAAEJVSUxES0lUXyoCAAAAAAAAAENJCQAAAAAAAABDT01QT1NFXyoKAAAAAAAAAENPUkVQQUNLXyoYAAAAAAAAAERCVVNfU0VTU0lPTl9CVVNfQUREUkVTUwcAAAAAAAAARElTUExBWQgAAAAAAAAARE9DS0VSXyoaAAAAAAAAAERZTERfRkFMTEJBQ0tfTElCUkFSWV9QQVRIFQAAAAAAAABEWUxEX0lOU0VSVF9MSUJSQVJJRVMUAAAAAAAAAEVMRUNUUk9OX1JVTl9BU19OT0RFCAAAAAAAAABHSVRIVUJfKgQAAAAAAAAASE9NRQkAAAAAAAAASE9NRURSSVZFCAAAAAAAAABIT01FUEFUSAgAAAAAAAAASkJfSURFXyoOAAAAAAAAAEpCX0lOVEVSUFJFVEVSBAAAAAAAAABMQU5HDwAAAAAAAABMRF9MSUJSQVJZX1BBVEgKAAAAAAAAAExEX1BSRUxPQUQHAAAAAAAAAExJQlBBVEgMAAAAAAAAAExPQ0FMQVBQREFUQQYAAAAAAAAATkVYVF8qDAAAAAAAAABOT0RFX09QVElPTlMLAAAAAAAAAE5PV19CVUlMREVSFAAAAAAAAABOUE1fQ09ORklHX1NUT1JFX0RJUgQAAAAAAAAAUEFUSAcAAAAAAAAAUEFUSEVYVAwAAAAAAAAAUExBWVdSSUdIVF8qCQAAAAAAAABQTlBNX0hPTUULAAAAAAAAAFBST0dSQU1EQVRBAwAAAAAAAABQV0QMAAAAAAAAAFByb2dyYW1GaWxlcxUAAAAAAAAAUHJvZ3JhbUZpbGVzWyhdeDg2WyldCAAAAAAAAABSVU5ORVJfKgUAAAAAAAAAU0hFTEwLAAAAAAAAAFNZU1RFTURSSVZFCgAAAAAAAABTWVNURU1ST09UBAAAAAAAAABURU1QAwAAAAAAAABUTVACAAAAAAAAAFRaBAAAAAAAAABVU0VSCwAAAAAAAABVU0VSUFJPRklMRR0AAAAAAAAAVVNFX09VVFBVVF9GT1JfRURHRV9GVU5DVElPTlMiAAAAAAAAAFZDX01JQ1JPRlJPTlRFTkRTX0NPTkZJR19GSUxFX05BTUUGAAAAAAAAAFZFUkNFTAgAAAAAAAAAVkVSQ0VMXyoEAAAAAAAAAFZQXyoIAAAAAAAAAFZTQ09ERV8qBgAAAAAAAABXSU5ESVIKAAAAAAAAAFhBVVRIT1JJVFkPAAAAAAAAAFhER19SVU5USU1FX0RJUiUAAAAAAAAAX0pFVEJSQUlOU19URVNUX1JVTk5FUl9SVU5fU0NPUEVfVFlQRQEAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAABtc2Vjb25kYXJ5X2tleVhQEgAAAAUAAAAAAAAAbWFjb3MHAAAAAAAAAGFhcmNoNjQAAAAABAAAAAAAAABlbWl0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
].join('')

// The bytes the pinned client sent in POST /store: a multipart body with the entry
// metadata in CBOR and the output archive beside it.
export const CLIENT_STORE_REQUEST = [
  'LS05YWY5MmEwZmJjYWQ1NzU3LTU4MzVhYzk3ZjJmNGVlODEtMGYwYmEzODI1ODhlYTEzZS03ODdhZDlmNWYyZDk4YmRkDQpDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9Im1ldGFkYXRhIg0KQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9jYm9yDQoNCqNja2V5WQUNEgAAAAUAAAAAAAAAbWFjb3MHAAAAAAAAAGFhcmNoNjQAAAAAAAAAAAAAAAADAAAAAAAAAGJ1bgIAAAAAAAAAAgAAAAAAAAAtZWUAAAAAAAAAcmVxdWlyZSgnZnMnKS5ta2RpclN5bmMoJ291dCcse3JlY3Vyc2l2ZTp0cnVlfSk7cmVxdWlyZSgnZnMnKS53cml0ZUZpbGVTeW5jKCdvdXQvYS50eHQnLCdoZWxsby1hZGVhJykAAAAAAAAAADcAAAAAAAAABwAAAAAAAAAqX1RPS0VOHAAAAAAAAABBQ1RJT05TX0lEX1RPS0VOX1JFUVVFU1RfVVJMBwAAAAAAAABBUFBEQVRBCgAAAAAAAABCVUlMREtJVF8qAgAAAAAAAABDSQkAAAAAAAAAQ09NUE9TRV8qCgAAAAAAAABDT1JFUEFDS18qGAAAAAAAAABEQlVTX1NFU1NJT05fQlVTX0FERFJFU1MHAAAAAAAAAERJU1BMQVkIAAAAAAAAAERPQ0tFUl8qGgAAAAAAAABEWUxEX0ZBTExCQUNLX0xJQlJBUllfUEFUSBUAAAAAAAAARFlMRF9JTlNFUlRfTElCUkFSSUVTFAAAAAAAAABFTEVDVFJPTl9SVU5fQVNfTk9ERQgAAAAAAAAAR0lUSFVCXyoEAAAAAAAAAEhPTUUJAAAAAAAAAEhPTUVEUklWRQgAAAAAAAAASE9NRVBBVEgIAAAAAAAAAEpCX0lERV8qDgAAAAAAAABKQl9JTlRFUlBSRVRFUgQAAAAAAAAATEFORw8AAAAAAAAATERfTElCUkFSWV9QQVRICgAAAAAAAABMRF9QUkVMT0FEBwAAAAAAAABMSUJQQVRIDAAAAAAAAABMT0NBTEFQUERBVEEGAAAAAAAAAE5FWFRfKgwAAAAAAAAATk9ERV9PUFRJT05TCwAAAAAAAABOT1dfQlVJTERFUhQAAAAAAAAATlBNX0NPTkZJR19TVE9SRV9ESVIEAAAAAAAAAFBBVEgHAAAAAAAAAFBBVEhFWFQMAAAAAAAAAFBMQVlXUklHSFRfKgkAAAAAAAAAUE5QTV9IT01FCwAAAAAAAABQUk9HUkFNREFUQQMAAAAAAAAAUFdEDAAAAAAAAABQcm9ncmFtRmlsZXMVAAAAAAAAAFByb2dyYW1GaWxlc1soXXg4NlspXQgAAAAAAAAAUlVOTkVSXyoFAAAAAAAAAFNIRUxMCwAAAAAAAABTWVNURU1EUklWRQoAAAAAAAAAU1lTVEVNUk9PVAQAAAAAAAAAVEVNUAMAAAAAAAAAVE1QAgAAAAAAAABUWgQAAAAAAAAAVVNFUgsAAAAAAAAAVVNFUlBST0ZJTEUdAAAAAAAAAFVTRV9PVVRQVVRfRk9SX0VER0VfRlVOQ1RJT05TIgAAAAAAAABWQ19NSUNST0ZST05URU5EU19DT05GSUdfRklMRV9OQU1FBgAAAAAAAABWRVJDRUwIAAAAAAAAAFZFUkNFTF8qBAAAAAAAAABWUF8qCAAAAAAAAABWU0NPREVfKgYAAAAAAAAAV0lORElSCgAAAAAAAABYQVVUSE9SSVRZDwAAAAAAAABYREdfUlVOVElNRV9ESVIlAAAAAAAAAF9KRVRCUkFJTlNfVEVTVF9SVU5ORVJfUlVOX1NDT1BFX1RZUEUBAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAbXNlY29uZGFyeV9rZXlYUBIAAAAFAAAAAAAAAG1hY29zBwAAAAAAAABhYXJjaDY0AAAAAAQAAAAAAAAAZW1pdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZXZhbHVlWQE2BAAAAAAAAAAMAAAAAAAAAG5vZGVfbW9kdWxlcwIAAAAACwAAAAAAAABidW5maWcudG9tbAAAAAAMAAAAAAAAAHBhY2thZ2UuanNvbgEAAACNASrz22seUwAAAAAAAAAAAgAAAAEFAAAAAAAAAAwAAAAAAAAAbm9kZV9tb2R1bGVzAgAAAAMAAAAAAAAAb3V0AQAAAAwAAAAAAAAAcGFja2FnZS5qc29uAAAAAAMAAAAAAAAAc3JjAQAAAA4AAAAAAAAAdml0ZS5jb25maWcudHMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/xmEBAAAAAAAAAAABLAAAAAAAAAA3MmNlZmExNi0wNGRlLTQxZTctYWQ5Yi1kYWRhMzQ5NDc1NTMudGFyLnpzdA0KLS05YWY5MmEwZmJjYWQ1NzU3LTU4MzVhYzk3ZjJmNGVlODEtMGYwYmEzODI1ODhlYTEzZS03ODdhZDlmNWYyZDk4YmRkDQpDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9ImJsb2IiDQpDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbQ0KDQootS/9AFgdAwByxA4WkLXpAMiuApIK2901/3ZbIvlS9X/JO4gOFFRKCEBIAFOwtha3b3e9M+fKqZX+f874N2Puu+UgByRyqQ4AKIEfGoACABIGEBSgMCROwJoOBg6oGQ1ioFXMHIDclaveBLoNCi0tOWFmOTJhMGZiY2FkNTc1Ny01ODM1YWM5N2YyZjRlZTgxLTBmMGJhMzgyNTg4ZWExM2UtNzg3YWQ5ZjVmMmQ5OGJkZC0tDQo=',
].join('')

// The answer the pinned client accepted: a CBOR map with the kind, the entry key, the
// task fingerprint key, the entry value and the id of the archive.
export const CLIENT_FETCH_RESPONSE = [
  'pWRraW5kZWV4YWN0Y2tleVkFDRIAAAAFAAAAAAAAAG1hY29zBwAAAAAAAABhYXJjaDY0AAAAAAAAAAAAAAAAAwAAAAAAAABidW4CAAAAAAAAAAIAAAAAAAAALWVlAAAAAAAAAHJlcXVpcmUoJ2ZzJykubWtkaXJTeW5jKCdvdXQnLHtyZWN1cnNpdmU6dHJ1ZX0pO3JlcXVpcmUoJ2ZzJykud3JpdGVGaWxlU3luYygnb3V0L2EudHh0JywnaGVsbG8tYWRlYScpAAAAAAAAAAA3AAAAAAAAAAcAAAAAAAAAKl9UT0tFThwAAAAAAAAAQUNUSU9OU19JRF9UT0tFTl9SRVFVRVNUX1VSTAcAAAAAAAAAQVBQREFUQQoAAAAAAAAAQlVJTERLSVRfKgIAAAAAAAAAQ0kJAAAAAAAAAENPTVBPU0VfKgoAAAAAAAAAQ09SRVBBQ0tfKhgAAAAAAAAAREJVU19TRVNTSU9OX0JVU19BRERSRVNTBwAAAAAAAABESVNQTEFZCAAAAAAAAABET0NLRVJfKhoAAAAAAAAARFlMRF9GQUxMQkFDS19MSUJSQVJZX1BBVEgVAAAAAAAAAERZTERfSU5TRVJUX0xJQlJBUklFUxQAAAAAAAAARUxFQ1RST05fUlVOX0FTX05PREUIAAAAAAAAAEdJVEhVQl8qBAAAAAAAAABIT01FCQAAAAAAAABIT01FRFJJVkUIAAAAAAAAAEhPTUVQQVRICAAAAAAAAABKQl9JREVfKg4AAAAAAAAASkJfSU5URVJQUkVURVIEAAAAAAAAAExBTkcPAAAAAAAAAExEX0xJQlJBUllfUEFUSAoAAAAAAAAATERfUFJFTE9BRAcAAAAAAAAATElCUEFUSAwAAAAAAAAATE9DQUxBUFBEQVRBBgAAAAAAAABORVhUXyoMAAAAAAAAAE5PREVfT1BUSU9OUwsAAAAAAAAATk9XX0JVSUxERVIUAAAAAAAAAE5QTV9DT05GSUdfU1RPUkVfRElSBAAAAAAAAABQQVRIBwAAAAAAAABQQVRIRVhUDAAAAAAAAABQTEFZV1JJR0hUXyoJAAAAAAAAAFBOUE1fSE9NRQsAAAAAAAAAUFJPR1JBTURBVEEDAAAAAAAAAFBXRAwAAAAAAAAAUHJvZ3JhbUZpbGVzFQAAAAAAAABQcm9ncmFtRmlsZXNbKF14ODZbKV0IAAAAAAAAAFJVTk5FUl8qBQAAAAAAAABTSEVMTAsAAAAAAAAAU1lTVEVNRFJJVkUKAAAAAAAAAFNZU1RFTVJPT1QEAAAAAAAAAFRFTVADAAAAAAAAAFRNUAIAAAAAAAAAVFoEAAAAAAAAAFVTRVILAAAAAAAAAFVTRVJQUk9GSUxFHQAAAAAAAABVU0VfT1VUUFVUX0ZPUl9FREdFX0ZVTkNUSU9OUyIAAAAAAAAAVkNfTUlDUk9GUk9OVEVORFNfQ09ORklHX0ZJTEVfTkFNRQYAAAAAAAAAVkVSQ0VMCAAAAAAAAABWRVJDRUxfKgQAAAAAAAAAVlBfKggAAAAAAAAAVlNDT0RFXyoGAAAAAAAAAFdJTkRJUgoAAAAAAAAAWEFVVEhPUklUWQ8AAAAAAAAAWERHX1JVTlRJTUVfRElSJQAAAAAAAABfSkVUQlJBSU5TX1RFU1RfUlVOTkVSX1JVTl9TQ09QRV9UWVBFAQAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAG1zZWNvbmRhcnlfa2V5WFASAAAABQAAAAAAAABtYWNvcwcAAAAAAAAAYWFyY2g2NAAAAAAEAAAAAAAAAGVtaXQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGV2YWx1ZVkBNgQAAAAAAAAADAAAAAAAAABub2RlX21vZHVsZXMCAAAAAAsAAAAAAAAAYnVuZmlnLnRvbWwAAAAADAAAAAAAAABwYWNrYWdlLmpzb24BAAAAjQEq89trHlMAAAAAAAAAAAIAAAABBQAAAAAAAAAMAAAAAAAAAG5vZGVfbW9kdWxlcwIAAAADAAAAAAAAAG91dAEAAAAMAAAAAAAAAHBhY2thZ2UuanNvbgAAAAADAAAAAAAAAHNyYwEAAAAOAAAAAAAAAHZpdGUuY29uZmlnLnRzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8ZhAQAAAAAAAAAAASwAAAAAAAAANzJjZWZhMTYtMDRkZS00MWU3LWFkOWItZGFkYTM0OTQ3NTUzLnRhci56c3RnYmxvYl9pZHhAZWFmMzUzOWU0MTBjZDA4ZjM1N2Y4MmE5OWNjOWUwNzEwZTZiYjI1YzI5OThkNjgxMWJkZDg2ZmQ4ODI1NzlkNg==',
].join('')

// Synthetic helpers for the shared R2 task-cache transport: an in-memory object store, trust domains, and builders for
// the client's own wire messages, including the adversarial ones.

import { createHash } from 'node:crypto'

import { encode as cborEncode } from './vp-r2-cache.cbor.mjs'
import { trustDomain } from './vp-r2-cache.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A call that never answers, so a test can prove that the transport ends an operation that waits for it. */
const never = () => new Promise(() => {})

/** The trust domain the tests use: one namespace, the pinned client version and a pinned toolchain id. */
export function testScope(
  namespace = 'adea-ai/adea',
  client = '1.3.0',
  toolchain = 'adea-test-toolchain'
) {
  return trustDomain({ namespace, client, toolchain })
}

/**
 * An object store that keeps its objects in memory. Every call is recorded, so a test can assert that a refused
 * transport made no call at all, and every method can be made to fail, so a test can assert that a failure leaves
 * nothing half written.
 *
 * The store reports the size and the digest of what it holds, which is what the transport checks a staged write
 * against. A store that cannot report a digest may leave it out; the transport then relies on the size and on reading
 * the object back.
 *
 * `options.stall` names the calls that never answer, so a test can prove that the transport ends an operation that
 * waits for a store that is stuck.
 * `options.commitBeforeAck` makes a conditional write commit and only then acknowledge it, so a
 * test can reproduce a write that is committed before the deadline and answered after it.
 */
export function createMemoryStore(options = {}) {
  const objects = new Map()
  const calls = []
  const fail = (name) =>
    typeof options[name] === 'function' ? options[name] : options[name] ? () => {} : null
  const failPut = fail('failPut')
  const failGet = fail('failGet')
  const failHead = fail('failHead')
  const failCopy = fail('failCopy')
  const failDelete = fail('failDelete')
  const stall = new Set(options.stall ?? [])
  const cooperative = options.cooperative !== false
  const slowFor = options.slowFor ?? null
  const slowMs = options.slowMs ?? 200
  // A store that commits a write and only then acknowledges it: the write is there before the answer is.
  const commitBeforeAck = options.commitBeforeAck === true
  // A cooperative store refuses to finish a write after the operation was cancelled; a noncooperative one finishes it.
  const refuseIfCancelled = (signal) => {
    if (cooperative && signal?.aborted) throw new Error('the operation was cancelled')
  }
  // A slow write: it waits, and a cooperative store gives up as soon as the operation is cancelled.
  const wait = async (key, signal) => {
    if (!slowFor || !slowFor(key)) return
    await new Promise((done) => {
      const timer = setTimeout(done, slowMs)
      timer.unref?.()
      if (cooperative && signal)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            done()
          },
          { once: true }
        )
    })
    refuseIfCancelled(signal)
  }
  return {
    objects,
    calls,
    async put(key, bytes, { signal } = {}) {
      calls.push({ op: 'put', key })
      if (stall.has('put')) return never()
      await wait(key, signal)
      refuseIfCancelled(signal)
      if (failPut) throw new Error('the store refused the write')
      const copy = Buffer.from(bytes)
      objects.set(key, copy)
      return { size: copy.length, sha256: sha256(copy) }
    },
    async putIfAbsent(key, bytes, { signal } = {}) {
      calls.push({ op: 'putIfAbsent', key })
      if (stall.has('putIfAbsent')) return never()
      if (failPut) throw new Error('the store refused the write')
      if (objects.has(key)) return { created: false, size: objects.get(key).length }
      const copy = Buffer.from(bytes)
      if (!commitBeforeAck) await wait(key, signal)
      objects.set(key, copy)
      if (commitBeforeAck) await wait(key, signal)
      refuseIfCancelled(signal)
      return { created: true, size: copy.length, sha256: sha256(copy) }
    },
    get(key, { maxBytes, signal } = {}) {
      calls.push({ op: 'get', key })
      if (stall.has('get')) return never()
      refuseIfCancelled(signal)
      if (failGet) throw new Error('the store refused the read')
      const held = objects.get(key)
      if (held === undefined) return null
      if (typeof maxBytes === 'number' && held.length > maxBytes)
        throw new Error('the store returned too many bytes')
      return held
    },
    head(key, { signal } = {}) {
      calls.push({ op: 'head', key })
      if (stall.has('head')) return never()
      refuseIfCancelled(signal)
      if (failHead) throw new Error('the store refused the read')
      const held = objects.get(key)
      if (held === undefined) return null
      return { size: held.length, sha256: sha256(held) }
    },
    delete(key, { signal } = {}) {
      calls.push({ op: 'delete', key })
      if (stall.has('delete')) return never()
      refuseIfCancelled(signal)
      if (failDelete) throw new Error('the store refused the delete')
      objects.delete(key)
    },
    async copy(from, to, { signal } = {}) {
      calls.push({ op: 'copy', key: from, to })
      if (stall.has('copy')) return never()
      await wait(to, signal)
      refuseIfCancelled(signal)
      if (failCopy) throw new Error('the store refused the copy')
      const held = objects.get(from)
      if (held === undefined) throw new Error('the store has no such object')
      objects.set(to, Buffer.from(held))
      return { size: held.length, sha256: sha256(held) }
    },
    async copyIfAbsent(from, to, { signal } = {}) {
      calls.push({ op: 'copyIfAbsent', key: from, to })
      if (stall.has('copyIfAbsent')) return never()
      if (failCopy) throw new Error('the store refused the copy')
      const held = objects.get(from)
      if (held === undefined) throw new Error('the store has no such object')
      if (objects.has(to)) return { created: false, size: objects.get(to).length }
      if (!commitBeforeAck) await wait(to, signal)
      objects.set(to, Buffer.from(held))
      if (commitBeforeAck) await wait(to, signal)
      refuseIfCancelled(signal)
      return { created: true, size: held.length, sha256: sha256(held) }
    },
  }
}

/** A synthetic cache entry: the three byte strings the client exchanges plus an output archive. */
export function syntheticEntry(seed = 'adea') {
  const key = Buffer.from(`synthetic-entry-key:${seed}`, 'utf8')
  const secondaryKey = Buffer.from(`synthetic-task-key:${seed}`, 'utf8')
  const value = Buffer.from(`synthetic-entry-value:${seed}`, 'utf8')
  const blob = Buffer.from(`synthetic-output-archive:${seed}`, 'utf8')
  return { key, secondaryKey, value, blob }
}

/** The client's `POST /fetch` body for an entry. */
export function fetchRequestBody(entry) {
  return cborEncode({ key: entry.key, secondary_key: entry.secondaryKey })
}

/** The client's `POST /store` body for an entry: the metadata in CBOR and the archive beside it. */
export function storeRequestBody(entry, boundary = 'adea-boundary') {
  const metadata = cborEncode({
    key: entry.key,
    secondary_key: entry.secondaryKey,
    value: entry.value,
  })
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/cbor\r\n\r\n`,
    metadata,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    entry.blob,
    `\r\n--${boundary}--\r\n`,
  ]
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : part))
  )
}

/** The content type of a `POST /store` body. */
export function storeRequestContentType(boundary = 'adea-boundary') {
  return `multipart/form-data; boundary=${boundary}`
}

/**
 * A `POST /store` body whose archive holds the boundary as plain bytes. The boundary appears without the CRLF that
 * makes a delimiter, so the archive must be kept whole.
 */
export function storeRequestBodyWithEmbeddedBoundary(boundary = 'adea-boundary') {
  const entry = syntheticEntry('embedded-boundary')
  const blob = Buffer.concat([
    Buffer.from('prefix', 'utf8'),
    Buffer.from(`--${boundary}--suffix`, 'utf8'),
  ])
  return storeRequestBody({ ...entry, blob }, boundary)
}

/** A CBOR map whose `__proto__` field carries a key, to try to satisfy the validation through a prototype. */
export function prototypePollutedFetchRequest() {
  // A null-prototype map, so `__proto__` is an own property of the message and not its prototype.
  const message = Object.create(null)
  message.__proto__ = { key: 'inherited', secondary_key: 'inherited' }
  return cborEncode(message)
}

/** A CBOR map that holds the same key twice, to try to make one message mean two things. */
export function duplicateKeyFetchRequest() {
  const key = Buffer.from('synthetic-entry-key:duplicate', 'utf8')
  // Two `key` entries in one map: the codec must refuse the message rather than pick one of them.
  const bytes = Buffer.concat([
    Buffer.from([0xa2]),
    cborEncode('key'),
    cborEncode(key),
    cborEncode('key'),
    cborEncode(key),
  ])
  return bytes
}
