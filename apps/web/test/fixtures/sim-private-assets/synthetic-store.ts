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
