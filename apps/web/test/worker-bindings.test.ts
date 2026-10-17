import { afterEach, describe, expect, test } from 'bun:test'

import {
  createSecretBindingHydrator,
  hydrateSecretStoreBindings,
  SECRET_BINDING_CACHE_MS,
} from '../src/server/worker-bindings'

const environmentKeys = ['STORE_SECRET', 'PLAIN_VAR'] as const
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
)

afterEach(() => {
  for (const key of environmentKeys) {
    const value = previousEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Secrets Store binding hydration', () => {
  test('resolves Secrets Store clients onto process.env and leaves strings alone', async () => {
    process.env.PLAIN_VAR = 'already-present'
    const env = {
      STORE_SECRET: { get: async () => 'store-value' },
      PLAIN_VAR: 'binding-string',
      HYPERDRIVE: { connectionString: 'postgres://hyperdrive' },
    }
    await hydrateSecretStoreBindings(env)
    expect(process.env.STORE_SECRET).toBe('store-value')
    // String bindings are already visible to `process.env` in the Workers
    // runtime; hydration must not second-guess them.
    expect(process.env.PLAIN_VAR).toBe('already-present')
  })

  test('a failing store read leaves the variable absent instead of throwing', async () => {
    delete process.env.STORE_SECRET
    const env = {
      STORE_SECRET: {
        get: async () => {
          throw new Error('store unavailable')
        },
      },
    }
    await hydrateSecretStoreBindings(env)
    expect(process.env.STORE_SECRET).toBeUndefined()
  })

  test('non-object environments are ignored', async () => {
    await hydrateSecretStoreBindings(undefined)
    await hydrateSecretStoreBindings(null)
    await hydrateSecretStoreBindings('not-an-env')
  })
})

describe('bounded resolved secret cache', () => {
  test('warm requests reuse resolved strings until the rotation bound', async () => {
    let now = 0
    let reads = 0
    const hydrate = createSecretBindingHydrator(() => now)
    const env = { STORE_SECRET: { get: async () => `value-${++reads}` } }
    for (let request = 0; request < 100; request++) await hydrate(env)
    expect(reads).toBe(1)
    expect(process.env.STORE_SECRET).toBe('value-1')
    now = SECRET_BINDING_CACHE_MS
    await hydrate(env)
    expect(reads).toBe(2)
    expect(process.env.STORE_SECRET).toBe('value-2')
    await hydrate({ STORE_SECRET: { get: async () => 'replacement-binding' } })
    expect(process.env.STORE_SECRET).toBe('replacement-binding')
  })

  test('expired failures clear the previous value and retry rather than cache errors', async () => {
    let now = 0
    let fail = false
    let reads = 0
    const hydrate = createSecretBindingHydrator(() => now)
    const env = {
      STORE_SECRET: {
        get: async () => {
          reads++
          if (fail) throw new Error('unavailable')
          return 'current'
        },
      },
    }
    await hydrate(env)
    now = SECRET_BINDING_CACHE_MS
    fail = true
    await hydrate(env)
    expect(process.env.STORE_SECRET).toBeUndefined()
    fail = false
    await hydrate(env)
    expect(reads).toBe(3)
    expect(process.env.STORE_SECRET).toBe('current')
  })

  test('invalid binding results are not installed or retained', async () => {
    process.env.STORE_SECRET = 'previous'
    let reads = 0
    const hydrate = createSecretBindingHydrator()
    const env = {
      STORE_SECRET: {
        get: async () => {
          reads++
          return undefined
        },
      },
    }
    await hydrate(env)
    await hydrate(env)
    expect(reads).toBe(2)
    expect(process.env.STORE_SECRET).toBeUndefined()
  })
})

function deferredSecret() {
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

for (const stale of ['success', 'failure'] as const) {
  test(`a late older ${stale} cannot replace a newer secret publication`, async () => {
    const older = deferredSecret()
    const newer = deferredSecret()
    let reads = 0
    const env = { STORE_SECRET: { get: () => (++reads === 1 ? older.promise : newer.promise) } }
    const hydrate = createSecretBindingHydrator(() => 0)
    const first = hydrate(env)
    const second = hydrate(env)
    expect(reads).toBe(2) // Request-owned promises are not shared.
    newer.resolve('newer')
    await second
    if (stale === 'success') older.resolve('older')
    else older.reject(new Error('old request failed'))
    await first
    expect(process.env.STORE_SECRET).toBe('newer')
    await hydrate(env)
    expect(reads).toBe(2)
    expect(process.env.STORE_SECRET).toBe('newer')
  })
}

test('a stale success cannot resurrect a value after the newest read failed', async () => {
  const older = deferredSecret()
  const newer = deferredSecret()
  const hydrate = createSecretBindingHydrator(() => 0)
  let reads = 0
  const env = { STORE_SECRET: { get: () => (++reads === 1 ? older.promise : newer.promise) } }
  const first = hydrate(env)
  const second = hydrate(env)
  newer.reject(new Error('new request failed'))
  await second
  expect(process.env.STORE_SECRET).toBeUndefined()
  older.resolve('older')
  await first
  expect(process.env.STORE_SECRET).toBeUndefined()
})

for (const stale of ['success', 'failure'] as const) {
  test(`old binding ${stale} cannot overwrite a replacement binding's value`, async () => {
    const older = deferredSecret()
    const hydrate = createSecretBindingHydrator(() => 0)
    const first = hydrate({ STORE_SECRET: { get: () => older.promise } })
    const replacement = { STORE_SECRET: { get: async () => 'replacement' } }
    await hydrate(replacement)
    if (stale === 'success') older.resolve('old binding')
    else older.reject(new Error('old binding failed'))
    await first
    expect(process.env.STORE_SECRET).toBe('replacement')
    await hydrate(replacement)
    expect(process.env.STORE_SECRET).toBe('replacement')
  })
}
