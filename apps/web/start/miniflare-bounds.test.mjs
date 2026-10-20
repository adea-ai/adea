// Regression tests for the bounded Miniflare waits used by test-auth-fixture-miniflare.mjs.
// They use stand-in instances, so no Miniflare, workerd or PostgreSQL is started.
import { describe, expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BoundedError, disposeBounded, startBounded, withDeadline } from './miniflare-bounds.mjs'

const never = () => new Promise(() => {})

describe('startBounded', () => {
  test('resolves when the instance becomes ready', async () => {
    await expect(startBounded({ ready: Promise.resolve('up') }, { ms: 1000 })).resolves.toBe('up')
  })

  test('a stalled startup fails within its bound', async () => {
    const started = Date.now()
    const error = await startBounded({ ready: never() }, { ms: 60 }).catch((e) => e)
    expect(error).toBeInstanceOf(BoundedError)
    expect(error.message).toContain('Miniflare startup did not finish within 60 ms')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('an interruption during a stalled startup wins over the bound', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = startBounded({ ready: never() }, { ms: 60_000, signal: controller.signal })
    controller.abort(new Error('interrupted by SIGINT'))
    const error = await pending.catch((e) => e)
    expect(error.message).toBe('interrupted by SIGINT')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('an already aborted signal rejects without waiting', async () => {
    const controller = new AbortController()
    controller.abort(new Error('interrupted by SIGTERM'))
    const error = await startBounded(
      { ready: never() },
      {
        ms: 60_000,
        signal: controller.signal,
      }
    ).catch((e) => e)
    expect(error.message).toBe('interrupted by SIGTERM')
  })

  test('a startup failure is propagated unchanged', async () => {
    const failure = new Error('workerd refused the config')
    await expect(startBounded({ ready: Promise.reject(failure) }, { ms: 1000 })).rejects.toBe(
      failure
    )
  })
})

// A readiness rejection that lands after the harness has already moved on to cleanup
// must be observed, not reported as unhandled.
function collectUnhandled() {
  const seen = []
  const listener = (reason) => seen.push(reason)
  process.on('unhandledRejection', listener)
  return { seen, stop: () => process.off('unhandledRejection', listener) }
}

describe('lifecycle regressions', () => {
  test('a pre-aborted signal with a rejecting readiness promise is observed', async () => {
    const unhandled = collectUnhandled()
    try {
      const controller = new AbortController()
      controller.abort(new Error('interrupted by SIGINT'))
      const failure = new Error('workerd refused the config')
      const error = await startBounded(
        { ready: Promise.reject(failure) },
        {
          ms: 60_000,
          signal: controller.signal,
        }
      ).catch((e) => e)
      await delay(20)
      expect(error.message).toBe('interrupted by SIGINT')
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  test('a readiness rejection after an abort is observed, not unhandled', async () => {
    const unhandled = collectUnhandled()
    try {
      const controller = new AbortController()
      let reject
      const ready = new Promise((_, fail) => {
        reject = fail
      })
      const pending = startBounded({ ready }, { ms: 60_000, signal: controller.signal })
      controller.abort(new Error('interrupted by SIGTERM'))
      expect((await pending.catch((e) => e)).message).toBe('interrupted by SIGTERM')
      reject(new Error('late workerd failure'))
      await delay(20)
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })
})

describe('disposeBounded', () => {
  test('resolves when dispose settles', async () => {
    let disposed = false
    await disposeBounded({
      dispose: async () => {
        disposed = true
      },
    })
    expect(disposed).toBe(true)
  })

  test('a dispose that never settles is reported within its bound', async () => {
    const started = Date.now()
    const error = await disposeBounded({ dispose: never }, { ms: 60 }).catch((e) => e)
    expect(error).toBeInstanceOf(BoundedError)
    expect(error.message).toContain('Miniflare dispose did not finish within 60 ms')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a synchronous dispose failure is reported, not thrown past the bound', async () => {
    const failure = new Error('socket already closed')
    await expect(
      disposeBounded({
        dispose: () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
  })
})

describe('withDeadline', () => {
  test('releases its timer and listener after a settled promise', async () => {
    const controller = new AbortController()
    await withDeadline(Promise.resolve(1), 1000, 'quick', controller.signal)
    // A later abort must not change anything once the wait has settled.
    controller.abort(new Error('late'))
    await expect(withDeadline(Promise.resolve(2), 1000, 'again')).resolves.toBe(2)
  })
})
