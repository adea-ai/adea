import { describe, expect, test } from 'bun:test'
import { createMemo, createResource, createRoot } from 'solid-js'

import { createReadResource } from '../src/source-control-app/resource'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createReadResource', () => {
  test('a failed read leaves the value undefined and exposes the error without throwing', async () => {
    const failure = new Error('rate limited')
    await createRoot(async (dispose) => {
      const [read] = createReadResource(
        () => 1,
        async () => {
          throw failure
        }
      )
      // Dependents read the value the way the panes do; a throw here would
      // surface as an uncaught error in the memo.
      const derived = createMemo(() => (read() ?? []).length)
      await settle()
      expect(read()).toBeUndefined()
      expect(read.error).toBe(failure)
      expect(read.loading).toBe(false)
      expect(derived()).toBe(0)
      dispose()
    })
  })

  test('the plain Solid resource throws on the same read, which is what this guards against', async () => {
    await createRoot(async (dispose) => {
      const [plain] = createResource(
        () => 1,
        async () => {
          throw new Error('rate limited')
        }
      )
      await settle()
      expect(() => plain()).toThrow('rate limited')
      dispose()
    })
  })

  test('a successful read returns its value', async () => {
    await createRoot(async (dispose) => {
      const [read] = createReadResource(
        () => 1,
        async () => ['a', 'b']
      )
      await settle()
      expect(read()).toEqual(['a', 'b'])
      expect(read.error).toBeUndefined()
      dispose()
    })
  })
})
