import { afterEach, describe, expect, test } from 'bun:test'

import { hydrateSecretStoreBindings } from '../src/server/worker-bindings'

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
