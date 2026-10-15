import { expect, test } from 'bun:test'
import { createLazyModule } from '../../src/lazy-module'

test('concurrent callers share one import and the loaded module is remembered', async () => {
  let calls = 0
  const module = createLazyModule(async () => {
    calls += 1
    return { name: 'board' }
  })
  expect(module.current()).toBeUndefined()
  const [first, second] = await Promise.all([module.load(), module.load()])
  expect(first).toBe(second)
  expect(calls).toBe(1)
  expect(module.current()).toBe(first)
  expect(await module.load()).toBe(first)
  expect(calls).toBe(1)
})

test('a failed import is not remembered, so the next call retries it', async () => {
  let calls = 0
  const module = createLazyModule(async () => {
    calls += 1
    if (calls === 1) throw new Error('chunk failed to load')
    return 'panel'
  })
  await expect(module.load()).rejects.toThrow('chunk failed to load')
  expect(module.current()).toBeUndefined()
  expect(await module.load()).toBe('panel')
  expect(module.current()).toBe('panel')
  expect(calls).toBe(2)
})

test('callers that overlap a failure all see it, then a later call starts fresh', async () => {
  let attempt = 0
  const module = createLazyModule(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('offline')
    return attempt
  })
  const results = await Promise.allSettled([module.load(), module.load()])
  expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
  expect(attempt).toBe(1)
  expect(await module.load()).toBe(2)
})
