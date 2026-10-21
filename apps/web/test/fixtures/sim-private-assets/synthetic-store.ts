// A synthetic private store.
//
// It is an in-memory map and a call log: no storage provider, no bucket, no
// credential, no network and no deployment are involved. A test that uses it
// proves the request-side contract — which key was asked for, in which
// location, and how many times — and says nothing about the storage side,
// which is a deployment prerequisite and is not claimed here.

import type { SimPrivateAsset } from '../../../src/server/sim-host'

/** The objects the synthetic store holds, by key. */
export type SyntheticStoreObjects = Readonly<Record<string, SimPrivateAsset>>

/** What the synthetic store answers with, instead of the objects it holds. */
export type SyntheticStoreAnswer = (request: {
  location: string
  key: string
}) => Promise<SimPrivateAsset | null> | SimPrivateAsset | null

export type SyntheticPrivateStore = {
  /** Every request the store was asked for, in order. */
  readonly requests: ReadonlyArray<{ location: string; key: string }>
  /** How many times the store was asked for something. */
  readonly calls: number
  /** The store, to hand to the private asset reader. */
  read: (request: { location: string; key: string }) => Promise<SimPrivateAsset | null>
}

/**
 * The bodies the platform accepts, one per supported `BodyInit` variant.
 *
 * Every one of them carries the same bytes, so a test can compare what was
 * served against what the store held.
 */
export function syntheticBodies(): { name: string; body: unknown; bytes: string }[] {
  const bytes = 'private-bytes'
  const encoded = new TextEncoder().encode(bytes)
  const form = new FormData()
  form.set('engine', bytes)
  return [
    { name: 'a string', body: bytes, bytes },
    { name: 'a Uint8Array', body: encoded, bytes },
    { name: 'an ArrayBuffer', body: encoded.buffer, bytes },
    { name: 'a DataView', body: new DataView(encoded.buffer.slice(0)), bytes },
    { name: 'a Blob', body: new Blob([bytes]), bytes },
    {
      name: 'a ReadableStream',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded)
          controller.close()
        },
      }),
      bytes,
    },
    { name: 'a FormData', body: form, bytes },
    { name: 'a URLSearchParams', body: new URLSearchParams({ engine: bytes }), bytes },
  ]
}

/**
 * The bodies that are not bodies.
 *
 * The platform coerces a number, a boolean, a plain object or an array into a
 * string, so an adapter that answered with one of them would look like it had
 * served an asset.
 */
export function syntheticOutOfContractBodies(): { name: string; body: unknown }[] {
  return [
    { name: 'a plain object', body: {} },
    { name: 'an object that stringifies itself', body: { toString: () => 'private-bytes' } },
    { name: 'a number', body: 42 },
    { name: 'a boolean', body: true },
    { name: 'an array', body: ['private-bytes'] },
    { name: 'a function', body: () => 'private-bytes' },
    { name: 'a symbol', body: Symbol('private-bytes') },
    { name: 'null', body: null },
    { name: 'undefined', body: undefined },
  ]
}

/**
 * A synthetic store over the given objects.
 *
 * `answer` replaces the object lookup entirely, so a test can make the store
 * answer with a fault, with a redirect or with something that is not an object
 * at all.
 */
export function createSyntheticPrivateStore(
  options: {
    objects?: SyntheticStoreObjects
    answer?: SyntheticStoreAnswer
  } = {}
): SyntheticPrivateStore {
  const requests: { location: string; key: string }[] = []
  const objects = options.objects ?? {}
  return {
    get requests() {
      return requests
    },
    get calls() {
      return requests.length
    },
    read: async (request) => {
      requests.push({ location: request.location, key: request.key })
      if (options.answer) return await options.answer(request)
      return objects[request.key] ?? null
    },
  }
}
