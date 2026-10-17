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
